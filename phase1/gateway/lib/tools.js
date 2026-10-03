// Model-facing tools beyond the built-ins: web search, channel-scoped
// history search, and thread creation (fork or fresh subagent thread).

import { Type } from "@earendil-works/pi-ai";
import {
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

// ---------------------------------------------------------------------------
// Threads: fork this conversation, or spawn a fresh subagent thread.

export function buildZulipTools({ onThreadCreated }) {
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

  return defineExtension({
    name: "zulip",
    tools: [searchTool, summarizeTool, historySearchTool, spawnThreadTool, forkThreadTool],
  });
}
