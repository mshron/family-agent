// family-agent gateway, Phase 1 v2 — built on @earendil-works/pi-durable.
//
// One Harness owns every conversation in JSONL storage. Each Zulip topic is
// one conversation tagged with a zulip doc (stream, topic). Tool calls run
// through DockerExecutionEnv: one exec container per conversation. Replies
// post back to the topic; tool calls post as collapsible spoilers. The
// gateway never re-ingests its own messages, so sessions never see the
// spoilers in their chat context (their tool results arrive through the
// transcript, not through Zulip).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { contentText } from "@earendil-works/pi-ai";

import { Zulip } from "./lib/zulip.js";
import { buildModels, MODEL_ALIASES, smallLlm } from "./lib/models.js";
import { DockerExecutionEnv } from "./lib/docker-env.js";
import { ZulipDoc, GatewayDoc } from "./lib/docs.js";
import {
  conventionsSection,
  memorySection,
  skillsSection,
  workspaceDir,
} from "./lib/sections.js";
import { loadChannelConfig } from "./lib/channels.js";
import { provisionStream } from "./lib/provision.js";
import { buildZulipTools } from "./lib/tools.js";
import { GENERAL_CHAT, nameTopic } from "./lib/naming.js";

const REPLY_CHAR_LIMIT = 9000;
const SPOILER_RESULT_LIMIT = 700;
const IDLE_MINUTES = 30;
const ESC_SYSTEM = [
  "You route messages for a personal assistant. Decide whether the message needs the strong reasoning model or the fast model.",
  "STRONG: multi-step analysis, planning, complex coding, long synthesis, deep debugging, hard math.",
  "FAST: chat, lookups, simple edits, short factual answers, formatting.",
  "Reply with exactly one word: STRONG or FAST.",
].join(" ");

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), "WARN", ...a),
  error: (...a) => console.error(new Date().toISOString(), "ERROR", ...a),
  debug: (...a) => {
    if (process.env.LOG_LEVEL === "debug") console.log(new Date().toISOString(), "dbg", ...a);
  },
};

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    log.error(`missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

const env = {
  ZULIP_SITE: requireEnv("ZULIP_SITE"),
  ZULIP_EMAIL: requireEnv("ZULIP_EMAIL"),
  ZULIP_API_KEY: requireEnv("ZULIP_API_KEY"),
  EXEC_IMAGE: process.env.EXEC_IMAGE || "family-agent-exec:latest",
  WORKSPACES_DIR: process.env.WORKSPACES_DIR || "/opt/family-agent/workspaces",
  DURABLE_DIR: process.env.DURABLE_DIR || "/opt/family-agent/durable",
  SKILLS_DIR: process.env.SKILLS_DIR || "/opt/family-agent/skills",
  SECRETS_DIR: process.env.SECRETS_DIR || "/opt/family-agent/secrets",
  CHANNELS_FILE: process.env.CHANNELS_FILE || "/app/channels.json",
  WORKSPACE_SKELETON_DIR: process.env.WORKSPACE_SKELETON_DIR || "/app/workspace-skeleton",
  OPENROUTER_API_KEY: requireEnv("OPENROUTER_API_KEY"),
  IDLE_MINUTES: Number(process.env.IDLE_MINUTES) || IDLE_MINUTES,
  ZULIP_OWNER_EMAILS: (process.env.ZULIP_OWNER_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

const context = BACKGROUND_CONTEXT;
const zulip = new Zulip({
  site: env.ZULIP_SITE,
  email: env.ZULIP_EMAIL,
  apiKey: env.ZULIP_API_KEY,
});
const channelConfig = await loadChannelConfig(env.CHANNELS_FILE);

// ---------------------------------------------------------------------------
// Docker helpers (run in the gateway container, over the mounted socket)

function sh(args, { input } = {}) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (e) => resolve({ code: -1, stdout: "", stderr: String(e) }));
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

const containerHash = (id) =>
  createHash("sha1").update(String(id)).digest("hex").slice(0, 12);

async function ensureExecContainer(conversationId, stream) {
  const name = `fa-exec-${containerHash(conversationId)}`;
  const state = await sh(["inspect", "-f", "{{.State.Running}}", name]);
  if (state.code === 0 && state.stdout.trim() === "true") return name;
  if (state.code === 0) await sh(["rm", "-f", name]);
  // Read-only skill layers on top of the writable workspace.
  const mounts = ["-v", `${workspaceDir(env, stream)}:/workspace`];
  const globalSkills = path.join(env.SKILLS_DIR, "global");
  const channelSkills = path.join(env.SKILLS_DIR, stream);
  if (existsSync(globalSkills)) mounts.push("-v", `${globalSkills}:/skills:ro`);
  if (existsSync(channelSkills)) mounts.push("-v", `${channelSkills}:/channel-skills:ro`);
  const run = await sh([
    "run", "-d", "--rm",
    "--name", name,
    "--label", "family-agent-exec=1",
    ...mounts,
    "-w", "/workspace",
    env.EXEC_IMAGE,
    "sleep", "infinity",
  ]);
  if (run.code !== 0) throw new Error(`docker run ${name} failed: ${run.stderr.trim()}`);
  return name;
}

/**
 * The meta channel's git push. The deploy key lives in SECRETS_DIR, which is
 * mounted only into the gateway and these one-off push containers — never
 * into exec containers, so agents can trigger a push but cannot read the key.
 */
async function pushWorkspaceToOrigin(conversationId, stream) {
  if (!channelConfig.channels[stream]?.push) return undefined;
  const ws = workspaceDir(env, stream);
  const keyDir = path.join(env.SECRETS_DIR, "push");
  if (!existsSync(path.join(keyDir, "id_ed25519"))) {
    return "push is not configured: no deploy key at secrets/push/id_ed25519 (see deploy docs).";
  }
  const run = await sh([
    "run", "--rm",
    "-v", `${ws}:/workspace`,
    "-v", `${keyDir}:/root/.ssh:ro`,
    "-e", "GIT_SSH_COMMAND=ssh -i /root/.ssh/id_ed25519 -o UserKnownHostsFile=/root/.ssh/known_hosts -o StrictHostKeyChecking=yes",
    "-w", "/workspace",
    env.EXEC_IMAGE,
    "git", "push", "origin", "HEAD:main",
  ]);
  const text = `${run.stdout || ""}${run.stderr || ""}`.trim().slice(0, 600);
  return run.code === 0
    ? `Pushed to origin main.\n${text}`
    : `Push failed:\n${text}`;
}

// ---------------------------------------------------------------------------
// Harness wiring

const FamilySections = defineExtension({
  name: "family",
  sections: [conventionsSection(env), memorySection(env), skillsSection(env)],
});

const ZulipTools = buildZulipTools({
  onThreadCreated: (conversationId, mapping) => {
    registerConversation(conversationId, mapping);
    if (mapping.header) {
      zulip
        .sendStreamMessage(mapping.stream, mapping.topic, mapping.header)
        .catch((err) => log.error(`header post failed: ${err.message}`));
    }
    ensureWatcher(conversationId).catch((err) =>
      log.error(`watcher for ${conversationId} failed: ${err.message}`)
    );
    if (mapping.task) void runSpawnedThread(conversationId, mapping);
  },
  onPushChanges: pushWorkspaceToOrigin,
});

const registry = createRegistry();
registry.install(CodingTools);
registry.install(ZulipTools);
registry.install(FamilySections);

/** Name -> ToolRegistration, for per-channel tool selection. */
const toolByName = new Map(
  [...CodingTools.tools, ...ZulipTools.tools].map((t) => [t.name, t])
);

const storage = await openNodeJsonlStorage(env.DURABLE_DIR, context, { fsync: true });
const harness = await Harness.open(
  storage,
  {
    models: buildModels(),
    registry,
    settings: {
      compaction: {
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
        backgroundTokens: 32768,
      },
    },
    env: async ({ conversationId, read }) => {
      const doc = await read.snapshot(ZulipDoc, conversationId, context);
      if (!doc?.stream) return undefined;
      const container = await ensureExecContainer(conversationId, doc.stream);
      return new DockerExecutionEnv({ container, cwd: "/workspace" });
    },
    conversationCreated: async (tx, conversation) => {
      await tx.doc(ZulipDoc, conversation.id);
    },
    onReport: (e) => log.warn("harness report:", JSON.stringify(e).slice(0, 400)),
  },
  context
);
harness.resume();

// ---------------------------------------------------------------------------
// Routes: every inbound message becomes a route (stream topic or DM group)
// that carries its conversation key, its channel, and how to reply.

function streamRoute(stream, topic) {
  return {
    kind: "stream",
    stream,
    topic,
    conversationKey: `${stream}::${topic}`,
    channel: stream, // workspace + channel-config key
    reply: (content) => zulip.sendStreamMessage(stream, topic, content),
  };
}

function dmRoute(message) {
  const recipients = message.display_recipient || [];
  const others = recipients.filter((r) => r.id !== botUserId);
  const groupKey = "dm-" + others.map((r) => r.id).sort().join("-");
  const emails = recipients.map((r) => r.email);
  return {
    kind: "dm",
    stream: "dm",
    topic: groupKey,
    conversationKey: `dm::${groupKey}`,
    channel: "dm",
    replyRecipients: emails,
    reply: (content) => zulip.sendPrivateMessage(emails, content),
  };
}

/** conversationId -> { stream, topic, recipients? } */
const byId = new Map();
/** conversationKey -> conversationId */
const byTopic = new Map();
/** conversationId -> { events, toolCalls, lastActivity } */
const watchers = new Map();

function registerConversation(conversationId, mapping) {
  const existing = byId.get(conversationId);
  byId.set(conversationId, mapping);
  if (existing?.topic !== mapping.topic) {
    byTopic.set(
      mapping.stream === "dm"
        ? `dm::${mapping.topic}`
        : `${mapping.stream}::${mapping.topic}`,
      conversationId
    );
  }
}

async function bootScan() {
  let cursor;
  for (;;) {
    const page = await harness.commit(
      (tx) => tx.scanConversations({}, 500, cursor),
      context
    );
    for (const record of page.items) {
      const doc = await harness.snapshot(ZulipDoc, record.id, context);
      if (doc?.stream && doc?.topic) {
        registerConversation(record.id, {
          stream: doc.stream,
          topic: doc.topic,
          ...(doc.recipients ? { recipients: doc.recipients } : {}),
        });
      }
    }
    cursor = page.next;
    if (!cursor) break;
  }
  log.info(`boot scan: ${byId.size} mapped conversations`);
}
await bootScan();

const INSTRUCTIONS = [
  "You are Max's personal assistant. You run inside one Zulip topic.",
  "Your final reply text is posted to that topic as-is, so answer directly and completely.",
  "Follow the workspace conventions in the conventions section: notes in notes/, writeups in docs/,",
  "durable facts in memory/ (say in your reply when you change memory).",
  "history_search finds past conversations in this channel; spawn_thread and fork_thread create new topics.",
].join(" ");

const INSTRUCTIONS_DM = [
  "You are Max's personal assistant. You run inside one direct-message thread.",
  "Your final reply text is posted to that thread as-is, so answer directly and completely.",
  "Follow the workspace conventions in the conventions section: notes in notes/, writeups in docs/,",
  "durable facts in memory/ (say in your reply when you change memory).",
  "history_search finds past conversations in direct messages; there are no topics here, so spawn_thread and fork_thread do not apply.",
].join(" ");

async function ensureConversation(route) {
  const existing = byTopic.get(route.conversationKey);
  if (existing) {
    const conv = await harness.conversation(existing, context);
    if (conv) return conv;
    byTopic.delete(route.conversationKey);
    byId.delete(existing);
  }
  const docInit =
    route.kind === "dm"
      ? { stream: "dm", topic: route.topic, recipients: route.replyRecipients }
      : { stream: route.stream, topic: route.topic };
  const tools = channelConfig
    .toolsFor(route.channel)
    .map((name) => toolByName.get(name))
    .filter(Boolean);
  const created = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: {
        model: MODEL_ALIASES.flash,
        thinkingLevel: "low",
        instructions: route.kind === "dm" ? INSTRUCTIONS_DM : INSTRUCTIONS,
        tools,
      },
      init: async (tx, id) => {
        const doc = await tx.doc(ZulipDoc, id);
        Object.assign(doc, docInit);
        doc.model = "auto";
      },
    },
    context
  );
  registerConversation(created.id, {
    stream: docInit.stream,
    topic: docInit.topic,
    ...(docInit.recipients ? { recipients: docInit.recipients } : {}),
  });
  log.info(`conversation created for ${route.conversationKey}: ${created.id}`);
  return created;
}

// ---------------------------------------------------------------------------
// Escalation (the `auto` policy: a fast classifier call per user message)

async function applyAutoModel(conversation, doc, messageText) {
  if (doc?.model === "flash" || doc?.model === "strong") return;
  let choice = "flash";
  try {
    const raw = await smallLlm({
      apiKey: env.OPENROUTER_API_KEY,
      system: ESC_SYSTEM,
      user: messageText.slice(0, 2000),
      maxTokens: 200,
    });
    if (/strong/i.test(raw)) choice = "strong";
  } catch (err) {
    log.warn(`escalation classifier failed: ${err.message}`);
  }
  const alias = MODEL_ALIASES[choice];
  const agent = await conversation.agent(context);
  if (agent.model?.modelId !== alias.modelId) {
    await conversation.configure(
      { model: alias, thinkingLevel: choice === "strong" ? "high" : "low" },
      context
    );
  }
}

// ---------------------------------------------------------------------------
// Tool-call spoilers (watchEvents per active conversation)

function argSummary(toolName, args) {
  const a = args ?? {};
  switch (toolName) {
    case "bash":
      return String(a.command ?? "").slice(0, 90);
    case "read":
    case "write":
      return String(a.path ?? "");
    case "edit":
      return String(a.path ?? "");
    case "search":
      return String(a.query ?? "").slice(0, 90);
    case "history_search":
      return String(a.query ?? "").slice(0, 90);
    case "summarize_url":
      return String(a.url ?? "").slice(0, 90);
    case "spawn_thread":
    case "fork_thread":
      return String(a.topic ?? "");
    default:
      return JSON.stringify(a).slice(0, 70);
  }
}

async function postSpoiler(conversationId, toolName, args, resultText) {
  const mapping = byId.get(conversationId);
  if (!mapping) return;
  const header = `${toolName} — ${argSummary(toolName, args)}`.slice(0, 80);
  const body = (resultText || "(no output)").slice(0, SPOILER_RESULT_LIMIT);
  const content = "```spoiler " + header + "\n" + body + "\n```";
  try {
    if (mapping.recipients) {
      await zulip.sendPrivateMessage(mapping.recipients, content);
    } else {
      await zulip.sendStreamMessage(mapping.stream, mapping.topic, content);
    }
  } catch (err) {
    log.warn(`spoiler post failed (${mapping.topic}): ${err.message}`);
  }
}

async function ensureWatcher(conversationId) {
  if (watchers.has(conversationId)) {
    watchers.get(conversationId).lastActivity = Date.now();
    return;
  }
  const { watchEvents } = await import("@earendil-works/pi-durable");
  const stream = await watchEvents(harness, conversationId, context);
  const state = { events: stream, toolCalls: new Map(), lastActivity: Date.now() };
  watchers.set(conversationId, state);
  stream.start(async (events) => {
    state.lastActivity = Date.now();
    for (const event of events) {
      if (event.type === "tool_execution_start") {
        state.toolCalls.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      } else if (event.type === "tool_execution_end") {
        const call = state.toolCalls.get(event.toolCallId) ?? {
          toolName: event.toolName,
          args: {},
        };
        state.toolCalls.delete(event.toolCallId);
        let resultText = "";
        const entry = event.entry;
        if (entry?.model) {
          resultText = entry.model
            .map((m) => (m.role === "toolResult" ? contentText(m.content) : ""))
            .join("")
            .trim();
        }
        await postSpoiler(conversationId, call.toolName, call.args, resultText);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Message flow

async function extractAnswer(conversation, settled) {
  if (settled.status !== "done") {
    return `*(no answer: ${settled.reason ?? "unknown"})*`;
  }
  const page = await conversation.entries(
    { minEntryId: settled.answer, maxEntryId: settled.answer },
    1,
    undefined,
    context
  );
  const entry = page.items[0];
  const message = entry?.model?.[0];
  const text = message ? contentText(message.content).trim() : "";
  return text || "*(the run finished without text — check the gateway logs)*";
}

/** Spawned threads run outside any tool invocation: the gateway submits and posts. */
const threadRuns = new Set();

async function runSpawnedThread(conversationId, mapping) {
  if (threadRuns.has(conversationId)) return;
  threadRuns.add(conversationId);
  try {
    const conversation = await harness.conversation(conversationId, context);
    if (!conversation) throw new Error(`conversation ${conversationId} is gone`);
    await conversation.configure(
      { model: MODEL_ALIASES.flash, thinkingLevel: "low", instructions: INSTRUCTIONS },
      context
    );
    const doc = await harness.snapshot(ZulipDoc, conversationId, context);
    await applyAutoModel(conversation, doc, mapping.task);
    const submission = await conversation.submit(
      {
        type: "input",
        content: mapping.task,
        requestId: `spawn:${conversationId}`,
        whenBusy: "followUp",
      },
      context
    );
    const settled = await submission.wait(context);
    const answer = await extractAnswer(conversation, settled);
    await zulip.sendStreamMessage(mapping.stream, mapping.topic, answer);
    log.info(`thread reply posted (${answer.length} chars) -> ${mapping.stream}::${mapping.topic}`);
  } catch (err) {
    log.error(`thread reply failed: ${err.message}`);
    zulip
      .sendStreamMessage(mapping.stream, mapping.topic, `*(thread error: ${err.message})*`)
      .catch(() => {});
  } finally {
    threadRuns.delete(conversationId);
  }
}

/** Download /user_uploads attachments into the channel workspace. */
async function ingestUploads(route, message) {
  const content = message.content || "";
  const urls = [
    ...new Set(
      [...content.matchAll(/\]\((\/user_uploads\/[^)\s]+)\)/g)].map((m) => m[1])
    ),
  ];
  if (urls.length === 0) return content;
  const dir = path.join(workspaceDir(env, route.channel), "uploads");
  await mkdir(dir, { recursive: true });
  const saved = [];
  let out = content;
  for (const url of urls) {
    try {
      const { bytes, name } = await zulip.downloadFile(url);
      const fname = `${message.id}-${name.replace(/[\/\\]/g, "_")}`;
      await writeFile(path.join(dir, fname), bytes);
      out = out.split(url).join(`uploads/${fname}`);
      saved.push(`uploads/${fname}`);
    } catch (err) {
      log.warn(`upload download failed (${url.slice(0, 60)}): ${err.message}`);
    }
  }
  if (saved.length > 0) {
    out += `\n\n(attachments saved into the workspace: ${saved.join(", ")})`;
  }
  return out;
}

/** One user message -> one conversation turn, with a thinking indicator. */
async function promptRoute(route, message) {
  const conversation = await ensureConversation(route);
  await ensureWatcher(conversation.id);
  const content = await ingestUploads(route, message);
  // Thinking indicator: an eyes reaction while the run is live, removed
  // when the reply posts (streams and DMs both).
  await zulip.addReaction(message.id, "eyes").catch(() => {});
  try {
    const doc = await harness.snapshot(ZulipDoc, conversation.id, context);
    await applyAutoModel(conversation, doc, content);
    const submission = await conversation.submit(
      {
        type: "input",
        content,
        requestId: `zulip:${message.id}`,
        whenBusy: "followUp",
      },
      context
    );
    const settled = await submission.wait(context);
    log.info(`settled: ${JSON.stringify(settled).slice(0, 400)}`);
    const answer = await extractAnswer(conversation, settled);
    const reply =
      answer.length > REPLY_CHAR_LIMIT
        ? `${answer.slice(0, REPLY_CHAR_LIMIT)}\n\n*(truncated — the full text is in the workspace)*`
        : answer;
    await route.reply(reply);
    log.info(`reply posted (${reply.length} chars) -> ${route.conversationKey}`);
  } finally {
    await zulip.removeReaction(message.id, "eyes").catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Commands

async function handleCommand(route, content) {
  const trimmed = content.trim();
  const [rawCmd, ...rest] = trimmed.slice(1).split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const argStr = trimmed.slice(1 + rawCmd.length).trim();

  const say = (text) =>
    route.reply(text).catch((err) =>
      log.error(`failed to post to ${route.conversationKey}: ${err.message}`)
    );

  switch (cmd) {
    case "new": {
      const conversation = await ensureConversation(route);
      const date = new Date().toISOString().slice(0, 10);
      const note = `notes/handoff-${date}-${containerHash(conversation.id)}.md`;
      const handoffPrompt =
        `The user is ending this conversation with /new. Write a handoff note to ${note} now: ` +
        `what was in progress, what the next conversation must know, which files matter. ` +
        `Commit it. Keep it short. Then reply with one line: saved.`;
      try {
        const sub = await conversation.submit(
          { type: "input", content: handoffPrompt, requestId: `new:${Date.now()}` },
          context
        );
        await sub.wait(context);
      } catch (err) {
        log.warn(`handoff write failed: ${err.message}`);
      }
      await conversation.reset(
        `New conversation (started by /new). The previous one saved its handoff note at ${note}; read it first if the user refers to earlier work.`,
        context
      );
      await say("Fresh conversation started. Handoff note saved; memory and workspace carry over.");
      return true;
    }
    case "compact": {
      const conversation = await ensureConversation(route);
      await conversation.compact(null, context);
      await say("Compaction scheduled; it places the summary at the next turn boundary.");
      return true;
    }
    case "stop": {
      const conversation = await ensureConversation(route);
      await conversation.abort(context);
      await say("Stopped.");
      return true;
    }
    case "stats": {
      const id = byTopic.get(route.conversationKey);
      const conversation = id ? await harness.conversation(id, context) : undefined;
      if (!conversation) {
        await say("No conversation for this topic yet; send a message first.");
        return true;
      }
      const view = await conversation.viewState(context);
      const usage = view.value.docs["pi.usage"] ?? {};
      const models = Object.entries(usage.models ?? {})
        .map(([k, v]) => `${k}: $${Number(v.cost?.total ?? 0).toFixed(4)}`)
        .join(", ");
      const entries = view.value.entries.length;
      view.dispose();
      await say(
        `Session: ${entries} active entries. Spend by model: ${models || "none yet"}.`
      );
      return true;
    }
    case "model": {
      const parts = argStr.split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        await say(
          "Usage: `/model auto` (classifier picks per message; default) | `/model flash` | `/model strong`."
        );
        return true;
      }
      const choice = parts[0].toLowerCase();
      if (!["auto", "flash", "strong"].includes(choice)) {
        await say(`Unknown model "${parts[0]}". Use auto, flash, or strong.`);
        return true;
      }
      const conversation = await ensureConversation(route);
      const id = conversation.id;
      if (choice !== "auto") {
        await conversation.configure(
          {
            model: MODEL_ALIASES[choice],
            thinkingLevel: choice === "strong" ? "high" : "low",
          },
          context
        );
      }
      await harness.commit(async (tx) => {
        const doc = await tx.doc(ZulipDoc, id);
        doc.model = choice;
      }, context);
      await say(
        choice === "auto"
          ? "Model: auto (the classifier picks flash or strong for each message)."
          : `Model pinned: ${choice}.`
      );
      return true;
    }
    default:
      return false; // Unknown slash command: goes to the conversation as a prompt.
  }
}

// ---------------------------------------------------------------------------
// General chat auto-naming

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function getBoundary(stream) {
  const doc = await harness.snapshot(GatewayDoc, context);
  return doc?.boundaries?.[stream] ?? 0;
}

async function setBoundary(stream, messageId) {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(GatewayDoc);
    doc.boundaries ??= {};
    doc.boundaries[stream] = messageId;
  }, context);
}

async function routeGeneralChat(message) {
  const stream = message.display_recipient;
  // The message may already have been moved by a rename that an earlier
  // trigger started; trust the live subject, not the event payload.
  const fresh = await zulip.getMessage(message.id).catch(() => null);
  const currentSubject = fresh?.message?.subject ?? message.subject;
  if (currentSubject !== GENERAL_CHAT) {
    return { stream, topic: currentSubject, renamed: true };
  }
  const boundary = await getBoundary(stream);
  const history = await zulip.getTopicMessages(stream, GENERAL_CHAT, 100);
  const unprocessed = history.filter((m) => m.id > boundary);
  if (unprocessed.length === 0) {
    return { stream, topic: GENERAL_CHAT };
  }
  let name;
  try {
    name = await nameTopic({
      apiKey: env.OPENROUTER_API_KEY,
      messages: unprocessed.map((m) => ({
        sender: m.sender_full_name,
        content: stripHtml(m.content),
      })),
    });
  } catch (err) {
    log.warn(`topic naming failed: ${err.message}`);
    return { stream, topic: GENERAL_CHAT };
  }
  try {
    await zulip.renameTopic(unprocessed[0].id, name);
  } catch (err) {
    log.warn(`topic rename failed (permissions?): ${err.message}`);
    return { stream, topic: GENERAL_CHAT };
  }
  await setBoundary(stream, Math.max(...unprocessed.map((m) => m.id)));
  log.info(`general chat renamed to "${name}" in ${stream} (${unprocessed.length} messages moved)`);
  // Announce the new thread so the topic reads naturally.
  await zulip
    .sendStreamMessage(
      stream,
      name,
      `*(auto-named this thread from general chat — ${unprocessed.length} message(s) moved)*`
    )
    .catch(() => {});
  return { stream, topic: name, renamed: true };
}

// ---------------------------------------------------------------------------
// Zulip wiring

let botUserId = null;

async function onStreamMessage(message) {
  const stream = message.display_recipient;
  let topic = message.subject;
  const content = (message.content || "").trim();
  if (!content) return;
  let route;

  try {
    if (topic === GENERAL_CHAT) {
      const routed = await routeGeneralChat(message);
      topic = routed.topic;
      if (topic === GENERAL_CHAT) {
        log.warn(`general chat message ${message.id} left unnamed; not routing`);
        return;
      }
    }
    route = streamRoute(stream, topic);
    log.info(
      `message from ${message.sender_full_name} in ${stream}/${topic}: ${content.slice(0, 100)}`
    );
    if (content.startsWith("/")) {
      const handled = await handleCommand(route, content);
      if (handled) return;
    }
    await promptRoute(route, message);
  } catch (err) {
    log.error(`handling message in ${stream}/${topic} failed: ${err.message}`);
    route
      ? route.reply(`Gateway error: ${err.message}`).catch(() => {})
      : zulip.sendStreamMessage(stream, topic, `Gateway error: ${err.message}`).catch(() => {});
  }
}

async function onDmMessage(message) {
  const content = (message.content || "").trim();
  if (!content) return;
  const route = dmRoute(message);
  try {
    log.info(
      `direct message from ${message.sender_full_name} (${route.conversationKey}): ${content.slice(0, 100)}`
    );
    if (content.startsWith("/")) {
      const handled = await handleCommand(route, content);
      if (handled) return;
    }
    await promptRoute(route, message);
  } catch (err) {
    log.error(`handling direct message ${route.conversationKey} failed: ${err.message}`);
    route.reply(`Gateway error: ${err.message}`).catch(() => {});
  }
}

async function onMessage(message) {
  if (message.type === "private") return onDmMessage(message);
  return onStreamMessage(message);
}

// Owner user ids, resolved once at boot; empty when none could be resolved.
const ownerUserIds = new Set();

async function resolveOwners() {
  for (const email of env.ZULIP_OWNER_EMAILS) {
    try {
      const user = await zulip.getUserByEmail(email);
      ownerUserIds.add(user.user_id);
    } catch (err) {
      log.warn(`could not resolve owner ${email}: ${err.message}`);
    }
  }
  if (ownerUserIds.size > 0) {
    log.info(`owner gate active: ${[...ownerUserIds].join(", ")}`);
  } else if (env.ZULIP_OWNER_EMAILS.length > 0) {
    log.warn("no owner ids resolved; the invite gate cannot verify anyone");
  }
}

/**
 * The invite gate: a stream is auto-joined only if an owner is subscribed
 * to it. If no owners are configured the gate is open (private realms);
 * if owners are configured but none could be resolved it is shut.
 */
async function ownersPresent(streamId) {
  if (env.ZULIP_OWNER_EMAILS.length === 0) return true;
  if (ownerUserIds.size === 0) return false;
  try {
    const body = await zulip.getStreamMembers(streamId);
    const ids = body.subscribers ?? [];
    for (const id of ownerUserIds) {
      if (ids.includes(id)) return true;
    }
    return false;
  } catch (err) {
    log.warn(`subscriber check failed for stream ${streamId}: ${err.message}`);
    return false;
  }
}

async function ensureStreamAccess() {
  // Seed streams from channels.json: the bot self-subscribes and adds the
  // owners. Every other channel is joined by invitation only.
  for (const stream of channelConfig.streams) {
    try {
      await zulip.subscribeSelf(
        stream,
        "family-agent channel (personal assistant)"
      );
      log.info(`subscribed bot to stream "${stream}"`);
    } catch (err) {
      log.warn(
        `could not subscribe to "${stream}" (${err.message}). Create the stream first, then restart the gateway.`
      );
    }
    if (env.ZULIP_OWNER_EMAILS.length > 0) {
      const out = await zulip.subscribeOthers(stream, env.ZULIP_OWNER_EMAILS);
      if (out.added.length > 0) log.info(`added to stream ${stream}: ${out.added.join(", ")}`);
      else if (out.msg) log.warn(`could not add owners to ${stream}: ${out.msg}`);
    }
  }
}

/** Boot-time membership discovery: watch every stream the bot is in. */
async function discoverStreams() {
  let body;
  try {
    body = await zulip.getOwnSubscriptions();
  } catch (err) {
    log.warn(`subscription discovery failed: ${err.message}`);
    return;
  }
  for (const sub of body.subscriptions ?? []) {
    const stream = sub.name;
    if (streamQueues.has(stream)) continue;
    if (channelConfig.streams.includes(stream)) {
      startStreamQueue(stream);
      continue;
    }
    if (!(await ownersPresent(sub.stream_id))) {
      log.warn(`"${stream}": subscribed but no owner is present; leaving`);
      await zulip.unsubscribe(stream).catch(() => {});
      continue;
    }
    await provisionStream(env, stream, log);
    startStreamQueue(stream);
    log.info(`watching discovered channel "${stream}"`);
  }
}

/** A subscription event: an invite (op add) or a removal (op remove). */
async function handleSubscriptionEvent(event) {
  if (event.op === "add") {
    for (const sub of event.subscriptions ?? []) {
      const stream = sub.name;
      if (streamQueues.has(stream) || channelConfig.streams.includes(stream)) continue;
      if (!(await ownersPresent(sub.stream_id))) {
        log.warn(`invite to "${stream}" declined: no owner is a subscriber`);
        await zulip.unsubscribe(stream).catch(() => {});
        continue;
      }
      await provisionStream(env, stream, log);
      startStreamQueue(stream);
      zulip
        .sendStreamMessage(
          stream,
          "family-agent",
          "👋 Joined this channel by invitation. A fresh workspace was provisioned for it — say hi and I'll get to work."
        )
        .catch((err) => log.warn(`join announce failed for ${stream}: ${err.message}`));
      log.info(`joined new channel "${stream}" by invitation`);
    }
  } else if (event.op === "remove") {
    for (const sub of event.subscriptions ?? []) {
      if (channelConfig.streams.includes(sub.name)) continue;
      stopStreamQueue(sub.name);
      log.info(`left channel "${sub.name}"; poller stopped`);
    }
  }
}

/**
 * One independent poller per stream queue plus one for direct messages and
 * one control queue (subscription events). Each queue polls in its own
 * loop, and message handling is fire-and-forget: a long conversation run
 * never delays event pickup for any queue.
 */
async function pollQueueForever(q) {
  for (;;) {
    if (q.stopped) return;
    try {
      if (!q.queueId) {
        const reg =
          q.kind === "private"
            ? await zulip.registerPrivateQueue()
            : await zulip.registerStreamQueue(q.stream);
        q.queueId = reg.queue_id;
        q.lastEventId = reg.last_event_id;
        log.info(`event queue registered (${q.kind}${q.stream ? ":" + q.stream : ""}): ${q.queueId.slice(0, 8)}`);
      }
      const { events, lastEventId: newest } = await zulip.getEvents(q.queueId, q.lastEventId);
      q.lastEventId = newest;
      for (const event of events) {
        if (event.type !== "message") continue;
        const message = event.message;
        if (botUserId !== null && message.sender_id === botUserId) continue;
        void onMessage(message).catch((err) =>
          log.error(`onMessage failed (${q.kind}${q.stream ? ":" + q.stream : ""}): ${err.message}`)
        );
      }
    } catch (err) {
      log.warn(`events poll failed (${q.kind}${q.stream ? ":" + q.stream : ""}): ${err.message}; re-registering`);
      q.queueId = null;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/** stream name -> poller state; membership drives this map. */
const streamQueues = new Map();

function startStreamQueue(stream) {
  if (streamQueues.has(stream)) return;
  const q = { kind: "stream", stream, queueId: null, lastEventId: -1 };
  streamQueues.set(stream, q);
  void pollQueueForever(q);
}

function stopStreamQueue(stream) {
  const q = streamQueues.get(stream);
  if (!q) return;
  q.stopped = true;
  streamQueues.delete(stream);
}

/** Control queue: invites and removals, no messages. */
async function pollControlQueue() {
  const q = { queueId: null, lastEventId: -1 };
  for (;;) {
    try {
      if (!q.queueId) {
        const reg = await zulip.registerControlQueue();
        q.queueId = reg.queue_id;
        q.lastEventId = reg.last_event_id;
        log.info(`control queue registered: ${q.queueId.slice(0, 8)}`);
      }
      const { events, lastEventId: newest } = await zulip.getEvents(q.queueId, q.lastEventId);
      q.lastEventId = newest;
      for (const event of events) {
        if (event.type !== "subscription") continue;
        await handleSubscriptionEvent(event).catch((err) =>
          log.error(`subscription event handling failed: ${err.message}`)
        );
      }
    } catch (err) {
      log.warn(`control poll failed: ${err.message}; re-registering`);
      q.queueId = null;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function pollLoop() {
  const q = { kind: "private", queueId: null, lastEventId: -1 };
  void pollQueueForever(q);
  return new Promise(() => {}); // runs forever
}

// ---------------------------------------------------------------------------
// Idle sweep: stop watchers, remove exec containers

setInterval(async () => {
  const cutoff = Date.now() - env.IDLE_MINUTES * 60_000;
  const live = new Set();
  for (const [conversationId, state] of [...watchers.entries()]) {
    live.add(`fa-exec-${containerHash(conversationId)}`);
    if (state.lastActivity >= cutoff) continue;
    watchers.delete(conversationId);
    try {
      await state.events.stop();
    } catch {
      /* already stopped */
    }
    await sh(["rm", "-f", `fa-exec-${containerHash(conversationId)}`]);
    const mapping = byId.get(conversationId);
    if (mapping) log.info(`idle: watcher stopped for ${mapping.stream}::${mapping.topic}`);
  }
  // Exec containers whose watcher is gone (a gateway restart orphans every
  // one, and CI/CD deploys restart the gateway): remove them. They respawn
  // on demand.
  const listed = await sh([
    "ps", "--filter", "label=family-agent-exec", "--format", "{{.Names}}",
  ]);
  for (const name of listed.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (!live.has(name)) {
      await sh(["rm", "-f", name]);
      log.info(`idle: removed orphaned exec container ${name}`);
    }
  }
}, 60_000).unref();

// ---------------------------------------------------------------------------

async function main() {
  const me = await zulip.getMe();
  botUserId = me.user_id;
  log.info(`gateway bot: ${me.full_name} <${me.email}> (user_id ${botUserId})`);
  for (const dir of [...channelConfig.streams, "dm"]) {
    await mkdir(path.join(env.WORKSPACES_DIR, dir), { recursive: true });
  }
  await ensureStreamAccess();
  await resolveOwners();
  await discoverStreams();
  void pollControlQueue();

  const shutdown = async (sig) => {
    log.info(`${sig} received; shutting down`);
    for (const [, state] of watchers) {
      try {
        await state.events.stop();
      } catch {
        /* ignore */
      }
    }
    await harness.close(context);
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await pollLoop();
}

main().catch((err) => {
  log.error(`fatal: ${err.message}`);
  process.exit(1);
});
