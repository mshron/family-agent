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
import { mkdir } from "node:fs/promises";
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
import { conventionsSection, memorySection, workspaceDir } from "./lib/sections.js";
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
  SCRATCH_STREAM: process.env.SCRATCH_STREAM || "scratch",
  EXEC_IMAGE: process.env.EXEC_IMAGE || "family-agent-exec:latest",
  WORKSPACES_DIR: process.env.WORKSPACES_DIR || "/opt/family-agent/workspaces",
  DURABLE_DIR: process.env.DURABLE_DIR || "/opt/family-agent/durable",
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
  const run = await sh([
    "run", "-d", "--rm",
    "--name", name,
    "--label", "family-agent-exec=1",
    "-v", `${workspaceDir(env, stream)}:/workspace`,
    "-w", "/workspace",
    env.EXEC_IMAGE,
    "sleep", "infinity",
  ]);
  if (run.code !== 0) throw new Error(`docker run ${name} failed: ${run.stderr.trim()}`);
  return name;
}

// ---------------------------------------------------------------------------
// Harness wiring

const FamilySections = defineExtension({
  name: "family",
  sections: [conventionsSection(env), memorySection(env)],
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
});

const registry = createRegistry();
registry.install(CodingTools);
registry.install(ZulipTools);
registry.install(FamilySections);

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
// Conversation bookkeeping

/** conversationId -> { stream, topic } */
const byId = new Map();
/** `${stream}::${topic}` -> conversationId */
const byTopic = new Map();
/** conversationId -> { events, toolCalls, lastActivity } */
const watchers = new Map();

function registerConversation(conversationId, mapping) {
  const existing = byId.get(conversationId);
  byId.set(conversationId, mapping);
  if (existing?.topic !== mapping.topic) {
    byTopic.set(`${mapping.stream}::${mapping.topic}`, conversationId);
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
        registerConversation(record.id, { stream: doc.stream, topic: doc.topic });
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

async function ensureTopicConversation(stream, topic) {
  const key = `${stream}::${topic}`;
  const existing = byTopic.get(key);
  if (existing) {
    const conv = await harness.conversation(existing, context);
    if (conv) return conv;
    byTopic.delete(key);
    byId.delete(existing);
  }
  const created = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: {
        model: MODEL_ALIASES.flash,
        thinkingLevel: "low",
        instructions: INSTRUCTIONS,
      },
      init: async (tx, id) => {
        const doc = await tx.doc(ZulipDoc, id);
        doc.stream = stream;
        doc.topic = topic;
        doc.model = "auto";
      },
    },
    context
  );
  registerConversation(created.id, { stream, topic });
  log.info(`conversation created for ${key}: ${created.id}`);
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
    await zulip.sendStreamMessage(mapping.stream, mapping.topic, content);
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

async function promptTopic(stream, topic, message) {
  const conversation = await ensureTopicConversation(stream, topic);
  await ensureWatcher(conversation.id);
  const doc = await harness.snapshot(ZulipDoc, conversation.id, context);
  await applyAutoModel(conversation, doc, message.content);
  const submission = await conversation.submit(
    {
      type: "input",
      content: message.content,
      requestId: `zulip:${message.id}`,
      whenBusy: "followUp",
    },
    context
  );
  const settled = await submission.wait(context);
  log.info(
    `settled: ${JSON.stringify(settled).slice(0, 400)}`
  );
  const answer = await extractAnswer(conversation, settled);
  const content =
    answer.length > REPLY_CHAR_LIMIT
      ? `${answer.slice(0, REPLY_CHAR_LIMIT)}\n\n*(truncated — the full text is in the workspace)*`
      : answer;
  await zulip.sendStreamMessage(stream, topic, content);
  log.info(`reply posted (${content.length} chars) -> ${stream}::${topic}`);
}

// ---------------------------------------------------------------------------
// Commands

async function handleCommand(stream, topic, content) {
  const trimmed = content.trim();
  const [rawCmd, ...rest] = trimmed.slice(1).split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const argStr = trimmed.slice(1 + rawCmd.length).trim();

  const say = (text) =>
    zulip.sendStreamMessage(stream, topic, text).catch((err) =>
      log.error(`failed to post to ${stream}/${topic}: ${err.message}`)
    );

  switch (cmd) {
    case "new": {
      const conversation = await ensureTopicConversation(stream, topic);
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
      const conversation = await ensureTopicConversation(stream, topic);
      await conversation.compact(null, context);
      await say("Compaction scheduled; it places the summary at the next turn boundary.");
      return true;
    }
    case "stop": {
      const conversation = await ensureTopicConversation(stream, topic);
      await conversation.abort(context);
      await say("Stopped.");
      return true;
    }
    case "stats": {
      const id = byTopic.get(`${stream}::${topic}`);
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
      const conversation = await ensureTopicConversation(stream, topic);
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

async function onMessage(message) {
  const stream = message.display_recipient;
  let topic = message.subject;
  const content = (message.content || "").trim();
  if (!content) return;

  try {
    if (topic === GENERAL_CHAT) {
      const routed = await routeGeneralChat(message);
      topic = routed.topic;
      if (topic === GENERAL_CHAT) {
        log.warn(`general chat message ${message.id} left unnamed; not routing`);
        return;
      }
    }
    log.info(`message from ${message.sender_full_name} in ${stream}/${topic}: ${stripHtml(content).slice(0, 100)}`);
    if (content.startsWith("/")) {
      const handled = await handleCommand(stream, topic, content);
      if (handled) return;
    }
    await promptTopic(stream, topic, message);
  } catch (err) {
    log.error(`handling message in ${stream}/${topic} failed: ${err.message}`);
    zulip.sendStreamMessage(stream, topic, `Gateway error: ${err.message}`).catch(() => {});
  }
}

async function ensureStreamAccess() {
  try {
    await zulip.subscribeSelf(
      env.SCRATCH_STREAM,
      "Phase 1 feel test: gateway + pi-durable sessions"
    );
    log.info(`subscribed bot to stream "${env.SCRATCH_STREAM}"`);
  } catch (err) {
    log.warn(`could not subscribe to "${env.SCRATCH_STREAM}": ${err.message}`);
  }
  if (env.ZULIP_OWNER_EMAILS.length > 0) {
    const out = await zulip.subscribeOthers(env.SCRATCH_STREAM, env.ZULIP_OWNER_EMAILS);
    if (out.added.length > 0) log.info(`added to stream: ${out.added.join(", ")}`);
    else if (out.msg) log.warn(`could not add owners to stream: ${out.msg}`);
  }
}

async function pollLoop() {
  let queueId = null;
  let lastEventId = -1;
  for (;;) {
    if (!queueId) {
      const reg = await zulip.register(env.SCRATCH_STREAM);
      queueId = reg.queue_id;
      lastEventId = reg.last_event_id;
      log.info(`event queue registered: ${queueId}`);
    }
    try {
      const { events, lastEventId: newest } = await zulip.getEvents(queueId, lastEventId);
      lastEventId = newest;
      for (const event of events) {
        if (event.type !== "message") continue;
        const message = event.message;
        if (botUserId !== null && message.sender_id === botUserId) continue;
        await onMessage(message);
      }
    } catch (err) {
      log.warn(`events poll failed: ${err.message}; re-registering`);
      queueId = null;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ---------------------------------------------------------------------------
// Idle sweep: stop watchers, remove exec containers

setInterval(async () => {
  const cutoff = Date.now() - env.IDLE_MINUTES * 60_000;
  for (const [conversationId, state] of [...watchers.entries()]) {
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
}, 60_000).unref();

// ---------------------------------------------------------------------------

async function main() {
  const me = await zulip.getMe();
  botUserId = me.user_id;
  log.info(`gateway bot: ${me.full_name} <${me.email}> (user_id ${botUserId})`);
  await mkdir(path.join(env.WORKSPACES_DIR, env.SCRATCH_STREAM), { recursive: true });
  await ensureStreamAccess();

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
