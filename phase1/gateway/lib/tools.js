// Model-facing tools beyond the built-ins: web search, channel-scoped
// history search, and thread creation (fork or fresh subagent thread).

import { Type } from "@earendil-works/pi-ai";
import {
  configure,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { contentText } from "@earendil-works/pi-ai";
import { ZulipDoc } from "./docs.js";

// ---------------------------------------------------------------------------
// Web search (Kagi or Brave), ported from the old MCP server.

const CONFIG = (() => {
  if (process.env.SEARCH_CONFIG) {
    try {
      return JSON.parse(process.env.SEARCH_CONFIG);
    } catch {
      /* fall through */
    }
  }
  return {
    provider: process.env.SEARCH_PROVIDER || "brave",
    kagi_key: process.env.KAGI_API_KEY || "",
    brave_key: process.env.BRAVE_API_KEY || "",
  };
})();

async function kagiSearch(query, limit) {
  const url = new URL("https://kagi.com/api/v2/search");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.min(limit, 25)));
  const res = await fetch(url, {
    headers: { Authorization: `Bot ${CONFIG.kagi_key}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Kagi API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return (body?.data || [])
    .filter((r) => r.title && r.url)
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ""}`);
}

async function kagiSummarize(targetUrl) {
  const url = new URL("https://kagi.com/api/v2/summarize");
  url.searchParams.set("url", targetUrl);
  url.searchParams.set("summary_engine", "cecil");
  const res = await fetch(url, {
    headers: { Authorization: `Bot ${CONFIG.kagi_key}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Kagi API ${res.status}`);
  const body = await res.json();
  return body?.data?.output || "(no summary produced)";
}

async function braveSearch(query, limit) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(limit, 20)));
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": CONFIG.brave_key },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Brave API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return (body?.web?.results || [])
    .filter((r) => r.title && r.url)
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.description || "").replace(/<[^>]+>/g, "")}`);
}

const searchTool = defineTool({
  name: "search",
  description:
    "Search the web and return ranked results with titles, URLs, and snippets. Use for facts, current events, and anything you do not know.",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    limit: Type.Optional(Type.Number({ description: "Number of results (default 5)" })),
  }),
  replay: "safe",
  async execute(args) {
    const limit = Number(args.limit) || 5;
    const lines =
      CONFIG.provider === "kagi" && CONFIG.kagi_key
        ? await kagiSearch(args.query, limit)
        : await braveSearch(args.query, limit);
    return {
      content: [
        {
          type: "text",
          text: lines.length
            ? `Web search results for "${args.query}":\n\n${lines.join("\n\n")}`
            : `No results for "${args.query}".`,
        },
      ],
    };
  },
});

const summarizeTool = defineTool({
  name: "summarize_url",
  description: "Fetch and summarize the content of a web page (Kagi only).",
  parameters: Type.Object({ url: Type.String({ description: "Page URL" }) }),
  replay: "safe",
  async execute(args) {
    if (!(CONFIG.provider === "kagi" && CONFIG.kagi_key)) {
      return { content: [{ type: "text", text: "summarize_url is available only when the Kagi provider is configured." }] };
    }
    const text = await kagiSummarize(args.url);
    return { content: [{ type: "text", text }] };
  },
});

// ---------------------------------------------------------------------------
// Channel-scoped history search over past conversations in this channel.

function scoreText(terms, text) {
  let score = 0;
  const lower = text.toLowerCase();
  for (const term of terms) {
    let idx = 0;
    let hits = 0;
    while ((idx = lower.indexOf(term, idx)) !== -1) {
      hits += 1;
      idx += term.length;
    }
    score += hits;
  }
  return score;
}

function entryText(entry) {
  if (!entry.model) return "";
  return entry.model
    .map((m) => (m.role === "user" || m.role === "assistant" ? contentText(m.content) : ""))
    .filter(Boolean)
    .join("\n");
}

const historySearchTool = defineTool({
  name: "history_search",
  description:
    "Search past conversation transcripts in this channel (all topics, including ended ones). Returns matching snippets with their topic names. Use this to recall what was discussed or decided earlier.",
  parameters: Type.Object({
    query: Type.String({ description: "Search terms" }),
  }),
  replay: "safe",
  async execute(args, api, context) {
    const mine = await api.snapshot(ZulipDoc, api.conversationId, context);
    if (!mine?.stream) {
      return { content: [{ type: "text", text: "No channel mapping for this conversation." }] };
    }
    const terms = args.query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);

    const matches = [];
    let cursor = undefined;
    for (;;) {
      const page = await api.commit(
        (tx) => tx.scanConversations({}, 50, cursor),
        context
      );
      for (const record of page.items) {
        if (record.id === api.conversationId) continue;
        const doc = await api.snapshot(ZulipDoc, record.id, context);
        if (doc?.stream !== mine.stream || !doc?.topic) continue;
        let entryCursor = undefined;
        let scanned = 0;
        let best = null;
        for (;;) {
          const entries = await api.commit(
            (tx) => tx.scanEntries({ conversationId: record.id }, 200, entryCursor),
            context
          );
          for (const entry of entries.items) {
            const text = entryText(entry);
            if (!text) continue;
            const score = scoreText(terms, text);
            if (score > 0 && (!best || score > best.score)) {
              best = { score, text: text.slice(0, 400) };
            }
          }
          scanned += entries.items.length;
          entryCursor = entries.next;
          if (!entryCursor || scanned >= 600) break;
        }
        if (best) {
          matches.push({ topic: doc.topic, score: best.score, snippet: best.text });
        }
      }
      cursor = page.next;
      if (!cursor || matches.length >= 30) break;
    }

    matches.sort((a, b) => b.score - a.score);
    const top = matches.slice(0, 6);
    if (top.length === 0) {
      return {
        content: [{ type: "text", text: `No past conversations in this channel match "${args.query}".` }],
      };
    }
    const lines = top.map(
      (m, i) => `${i + 1}. Topic "${m.topic}" (relevance ${m.score}):\n   ${m.snippet.replace(/\n/g, "\n   ").slice(0, 350)}`
    );
    return {
      content: [
        {
          type: "text",
          text: `Matches in this channel's history for "${args.query}":\n\n${lines.join("\n\n")}\n\nOpen that topic's conversation directly by asking the user, or use fork_thread with its topic name to work from it.`,
        },
      ],
    };
  },
});

// Upstream provider failures can arrive as the model's own output (a
// completed message whose text is the error), bypassing the harness's retry
// classification. Same shape test the gateway uses before posting replies.
const PROVIDER_ERROR_RE =
  /^(Error calling LLM|litellm\.|OpenAIException|Error code: [45]\d\d|API error|Rate limit)/i;

// ---------------------------------------------------------------------------
// Threads: fork this conversation, or spawn a fresh subagent thread.

export function buildZulipTools({
  onThreadCreated,
  onPushChanges,
  onUpload,
  resolveWorkStream,
  onTaskAgent,
  onSaveSkill,
  onTaskLedger,
  uniqueTopicFor,
}) {
  const err = (text) => ({ content: [{ type: "text", text }] });

  // The DM front conversation's delegation tool (the dm-first memo). It
  // starts a task conversation as a topic of the person's work stream:
  // the task's steps and spoilers are visible there, while the DM gets the
  // answer. Sync runs use the pi-durable subagent pattern — the child is
  // owned by this tool call's task, so a crash rerun reuses it and /stop
  // aborts it; wait=false runs ownerless in the background, and the
  // gateway posts the result back into the DM when it finishes.
  const runTaskTool = defineTool({
    name: "run_task",
    description:
      "Start a task conversation for a self-contained job and get its answer back. The task runs in the person's work stream as its own topic (its steps are visible there) while this conversation waits. Use it for multi-step jobs: document processing, file transformations, deliverables. Pass file paths (uploads land in uploads/). Set wait=false to run in the background instead; the result will be posted into this thread when the task finishes.",
    parameters: Type.Object({
      topic: Type.String({ description: "Short topic name for the task, 2-4 words" }),
      task: Type.String({ description: "The complete, self-contained task for the task conversation, including the file paths it should use" }),
      wait: Type.Optional(Type.Boolean({ description: "Wait for the result and return it (default true). false = run in the background." })),
    }),
    replay: "safe",
    async execute(args, api, context) {
      const mine = await api.snapshot(ZulipDoc, api.conversationId, context);
      if (!mine) return err("No channel mapping for this conversation.");
      if (!mine.recipients) {
        return err("run_task is for direct messages — in a channel, use spawn_thread instead.");
      }
      if (!resolveWorkStream || !onTaskAgent || !uniqueTopicFor) {
        return err("run_task is not available in this channel.");
      }
      const target = await resolveWorkStream(mine);
      if (!target?.stream) return err(target?.error || "No work stream is configured for this conversation.");
      const stream = target.stream;
      const topic = uniqueTopicFor(stream, args.topic);
      const header =
        `*(task for ${mine.person?.name ?? mine.person?.email ?? "the user"}, ` +
        `delegated from the direct-message thread — task: ${String(args.task).slice(0, 150)})*`;
      const mapping = { kind: "task", stream, topic, header, fromDm: mine.stream };
      // tx.createConversation only takes ownership; the agent (model,
      // instructions, tools) is set with configure() and the doc in the same
      // commit — the pattern spawn_thread already uses. Runs on the caller's
      // tx; never nests commits.
      const createChild = async (tx, ownership) => {
        const record = await tx.createConversation({ ownership });
        await configure(tx, record.id, onTaskAgent(stream, mine.model, mine.person));
        const doc = await tx.doc(ZulipDoc, record.id);
        doc.stream = stream;
        doc.topic = topic;
        doc.origin = { taskFrom: mine.topic };
        doc.model = "auto";
        return record.id;
      };

      const ledger = async (text) => {
        try {
          await onTaskLedger?.(stream, text);
        } catch {
          /* the ledger is a side record; never fail the task for it */
        }
      };
      await ledger(`started "${topic}" (${args.wait === false ? "background" : "sync"}) → #${stream}`);

      if (args.wait !== false) {
        // Sync: the child belongs to this tool call's task. The ownership
        // index makes a crash rerun reuse the same child; the same
        // requestId makes it reuse the same submission.
        let childId = await api.commit(async (tx) => {
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (existing !== undefined) return existing.id;
          return createChild(tx, { kind: "task", taskId: api.taskId });
        }, context);
        await api.details({ conversationId: childId }, context);
        await onThreadCreated?.(childId, mapping);
        const child = await api.conversation(childId, context);
        if (!child) return err(`The task conversation is gone (${topic}).`);
        const submission = await child.submit(
          { type: "input", content: args.task, requestId: `task:${childId}`, whenBusy: "followUp" },
          context
        );
        const settled = await submission.wait(context);
        if (settled.status !== "done") {
          await ledger(`aborted "${topic}" — ${settled.status}`);
          return err(
            `The task "${topic}" did not finish (${settled.status}` +
              `${settled.reason ? ": " + settled.reason : ""}). Tell the user what happened.`
          );
        }
        const answer = await api.commit(async (tx) => {
          const page = await tx.scanEntries(
            { conversationId: childId, minEntryId: settled.answer, maxEntryId: settled.answer },
            1
          );
          const message = page.items[0]?.model?.[0];
          return message && message.role === "assistant"
            ? contentText(message.content).trim()
            : "";
        }, context);
        // A provider failure can arrive as the task's own output (upstream
        // 5xx wrapped in a completed message); the raw text must not be
        // relayed into the person's thread.
        if (PROVIDER_ERROR_RE.test(answer.slice(0, 200))) {
          await ledger(`failed "${topic}" — model service error`);
          return err(
            `Task "${topic}" hit a model-service error and did not complete. ` +
            `Tell the user it failed, and offer to run it again.`
          );
        }
        await ledger(
          `finished "${topic}" — ${answer.slice(0, 120).replace(/\n/g, " ") || "done"}`
        );
        return {
          content: [
            {
              type: "text",
              text:
                `Task "${topic}" finished (visible in ${stream}). Answer:\n\n` +
                (answer.slice(0, 4000) || "*(no text — check the task topic)*"),
            },
          ],
        };
      }

      // Fire-and-forget: an ownerless child the gateway submits itself
      // (runSpawnedThread), posting the answer in the task topic and a
      // follow-up here when it finishes. The memo keeps the child out of
      // this call's ownership so the call can return at once.
      let childId = await api.memo(`taskspawn:${stream}:${topic}`, context);
      if (childId === undefined) {
        childId = await api.commit((tx) => createChild(tx, { kind: "ownerless" }), context);
        await api.memo(`taskspawn:${stream}:${topic}`, childId, context);
      }
      await onThreadCreated?.(childId, {
        ...mapping,
        task: args.task,
        notify: { dmChannel: mine.stream },
      });
      return {
        content: [
          {
            type: "text",
            text: `Background task "${topic}" started in ${stream}. Its result will be posted here when it finishes. Tell the user it is running and where it is visible.`,
          },
        ],
      };
    },
  });

  const spawnThreadTool = defineTool({
    name: "spawn_thread",
    description:
      "Start a new conversation in a new topic of this channel and give it a task. It runs independently and answers in that topic; this conversation continues without waiting. Returns the topic name.",
    parameters: Type.Object({
      topic: Type.String({ description: "Short topic name for the new thread, 2-4 words" }),
      task: Type.String({ description: "The complete task for the new conversation" }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      const mine = await api.snapshot(ZulipDoc, api.conversationId, context);
      if (!mine?.stream) {
        return { content: [{ type: "text", text: "No channel mapping for this conversation." }] };
      }
      if (mine.recipients) {
        return { content: [{ type: "text", text: "spawn_thread is not available in direct messages (there are no topics to spawn)." }] };
      }
      let childId = await api.memo(`spawn:${args.topic}`, context);
      if (childId === undefined) {
        childId = await api.commit(async (tx) => {
          const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
          const doc = await tx.doc(ZulipDoc, record.id);
          doc.stream = mine.stream;
          doc.topic = args.topic;
          doc.origin = { spawnedFrom: mine.topic };
          return record.id;
        }, context);
        await api.memo(`spawn:${args.topic}`, childId, context);
      }
      // The gateway learns the mapping and runs the task itself: the tool's
      // invocation ends when the tool returns, and a submission handle bound to
      // it dies with it.
      onThreadCreated?.(childId, {
        stream: mine.stream,
        topic: args.topic,
        header: `*(new thread, spawned from "${mine.topic}" — task: ${args.task})*`,
        task: args.task,
      });
      return {
        content: [{ type: "text", text: `Thread started in topic "${args.topic}". It will reply there.` }],
      };
    },
  });

  const forkThreadTool = defineTool({
    name: "fork_thread",
    description:
      "Fork this conversation into a new topic: the new thread starts with this conversation's full history and continues independently. Use it to take one branch of the discussion aside. Returns the new topic name.",
    parameters: Type.Object({
      topic: Type.String({ description: "Short topic name for the forked thread, 2-4 words" }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      const mine = await api.snapshot(ZulipDoc, api.conversationId, context);
      if (!mine?.stream) {
        return { content: [{ type: "text", text: "No channel mapping for this conversation." }] };
      }
      if (mine.recipients) {
        return { content: [{ type: "text", text: "fork_thread is not available in direct messages (there are no topics to fork into)." }] };
      }
      let forkId = await api.memo(`fork:${args.topic}`, context);
      if (forkId === undefined) {
        // Fork at the newest entry, inside a commit so the doc is set atomically.
        forkId = await api.commit(async (tx) => {
          const latest =
            (await tx.latestHeadMarker(api.conversationId))?.head ??
            (await tx.scanEntries({ conversationId: api.conversationId }, 1)).items[0]?.id;
          if (!latest) {
            throw new Error("conversation has no entries to fork from");
          }
          const record = await tx.forkConversation(api.conversationId, latest, {
            ownership: { kind: "ownerless" },
          });
          const doc = await tx.doc(ZulipDoc, record.id);
          doc.stream = mine.stream;
          doc.topic = args.topic;
          doc.origin = { forkOf: mine.topic };
          return record.id;
        }, context);
        await api.memo(`fork:${args.topic}`, forkId, context);
      }
      onThreadCreated?.(forkId, {
        stream: mine.stream,
        topic: args.topic,
        header: `*(fork of "${mine.topic}" — full history carried over; continue here)*`,
      });
      return {
        content: [{ type: "text", text: `Forked into topic "${args.topic}" with this conversation's history. Continue the fork there.` }],
      };
    },
  });

  // Hand a file to the user: the gateway reads the path from the
  // channel's workspace mount (a path outside it is refused), uploads it
  // to Zulip with the bot's credentials, and returns a shareable link.
  // Sessions hold no Zulip credentials, so only the gateway side can
  // actually move bytes out of the workspace.
  const uploadFileTool = defineTool({
    name: "upload_file",
    description:
      "Upload a file from the workspace to Zulip and return a download link, so you can hand a file to the user (a PDF, image, data export, anything too big to paste). Use it whenever the user should receive a file that lives in the workspace, then include the returned markdown link in your reply.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative path of the file, e.g. notes/report.pdf" }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      const mine = await api.snapshot(ZulipDoc, api.conversationId, context);
      if (!mine?.stream) {
        return { content: [{ type: "text", text: "No channel mapping for this conversation." }] };
      }
      if (!onUpload) {
        return { content: [{ type: "text", text: "upload_file is not available in this channel." }] };
      }
      let result;
      try {
        result = await onUpload(mine.stream, args.path);
      } catch (err) {
        return { content: [{ type: "text", text: `Upload failed: ${err.message}` }] };
      }
      const sizeText =
        result.size < 1024 * 1024
          ? `${Math.max(1, Math.round(result.size / 1024))} KB`
          : `${(result.size / 1024 / 1024).toFixed(1)} MB`;
      return {
        content: [
          {
            type: "text",
            text:
              `Uploaded ${result.name} (${sizeText}). Share it in your reply with this markdown link ` +
              `(Zulip renders it as a file link the user can open or download):\n\n` +
              `[${result.name}](${result.url})`,
          },
        ],
      };
    },
  });

  // The meta channel's push: the gateway runs git push with a deploy key
  // that lives only on the gateway side, so agents can trigger a push but
  // never read the key.
  const pushChangesTool = defineTool({
    name: "push_changes",
    description:
      "Push the workspace repository's commits to the origin remote on GitHub (branch main). The gateway first posts an approval message in the topic listing the commits; the push runs only after the owner reacts with a check mark (auto-denied after 20 minutes). Use it after committing work that should deploy; CI/CD picks it up from there.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api, context) {
      const mine = await api.snapshot(ZulipDoc, api.conversationId, context);
      if (!mine?.stream) {
        return { content: [{ type: "text", text: "No channel mapping for this conversation." }] };
      }
      const out = await onPushChanges?.(api.conversationId, mine.stream);
      return {
        content: [{ type: "text", text: out ?? "push_changes is not available in this channel." }],
      };
    },
  });

  // Skills loop (dm-first memo, step 5). Skills are prompt content: the
  // exec containers mount the skills tree read-only, so writing happens
  // gateway-side (git-committed, ask-gated by the permission layer). A
  // front conversation saves into the person's work stream, where task
  // conversations load skills; a task or stream conversation saves into
  // its own stream.
  const skillResult = (mode, r) =>
    `Skill ${mode === "save" ? "saved" : "updated"}: ${r.dir}. Future task conversations in that stream load it automatically when the description matches. Tell the user what you kept and why.`;
  const saveSkillTool = defineTool({
    name: "save_skill",
    description:
      "Save a skill: a reusable, step-by-step method for a kind of job, stored as a skill that future task conversations load automatically. Use it when a job reveals a repeatable method (a workflow, a file format, a recurring deliverable) or when the person gives durable feedback on how work should be done. Requires the person's approval in chat. Name it after the kind of job (e.g. 'apa-citation-fixes'); instructions are the complete method, written for an agent that knows nothing else.",
    parameters: Type.Object({
      name: Type.String({ description: "Short skill name, kebab-case (e.g. 'docx-citation-fixes')" }),
      description: Type.String({ description: "One sentence: what the skill does and when to use it — this is what future agents see when deciding to load it" }),
      instructions: Type.String({ description: "The complete method as markdown: steps, commands, file paths, conventions. Written for an agent in a fresh task conversation." }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      if (!onSaveSkill) return err("save_skill is not available in this channel.");
      try {
        const r = await onSaveSkill(api.conversationId, { ...args, mode: "save" });
        return { content: [{ type: "text", text: skillResult("save", r) }] };
      } catch (e) {
        return err(`save_skill failed: ${e.message}`);
      }
    },
  });
  const updateSkillTool = defineTool({
    name: "update_skill",
    description:
      "Update the instructions of an existing skill (from feedback or a changed method). Requires the person's approval in chat. Keep the description accurate; instructions replace the old ones entirely.",
    parameters: Type.Object({
      name: Type.String({ description: "The existing skill's name" }),
      instructions: Type.String({ description: "The complete updated method as markdown (replaces the old instructions)" }),
      description: Type.Optional(Type.String({ description: "New one-sentence description (unchanged if omitted)" })),
    }),
    replay: "safe",
    async execute(args, api, context) {
      if (!onSaveSkill) return err("update_skill is not available in this channel.");
      try {
        const r = await onSaveSkill(api.conversationId, { ...args, mode: "update" });
        return { content: [{ type: "text", text: skillResult("update", r) }] };
      } catch (e) {
        return err(`update_skill failed: ${e.message}`);
      }
    },
  });

  return defineExtension({
    name: "zulip",
    tools: [
      searchTool,
      summarizeTool,
      historySearchTool,
      runTaskTool,
      spawnThreadTool,
      forkThreadTool,
      pushChangesTool,
      uploadFileTool,
      saveSkillTool,
      updateSkillTool,
    ],
  });
}
