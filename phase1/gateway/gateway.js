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
import { AuditLog } from "./lib/audit.js";
import { buildPermissionsExtension, PermissionRules } from "./lib/permissions.js";

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
  AUDIT_DIR: process.env.AUDIT_DIR || "/opt/family-agent/audit",
  ASK_TIMEOUT_MS: (Number(process.env.ASK_TIMEOUT_MINUTES) || 20) * 60_000,
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
const audit = new AuditLog(env.AUDIT_DIR);

// Approval integrity: only the configured owners may resolve an ask. Ids
// are cached at boot (email -> id lookups can be hidden by the org's email
// visibility policy); unknown reactors fail closed but the ask stays live.
const ownerIds = new Map(); // user id -> email
async function isOwner(userId) {
  const cached = ownerIds.get(userId);
  if (cached) return cached;
  try {
    const body = await zulip.getUser(userId);
    const email = body?.user?.email;
    if (email && env.ZULIP_OWNER_EMAILS.includes(email)) {
      ownerIds.set(userId, email);
      return email;
    }
  } catch {
    /* not an owner we can verify: fail closed */
  }
  return null;
}
async function cacheOwnerIds() {
  for (const email of env.ZULIP_OWNER_EMAILS) {
    try {
      const body = await zulip.getUserByEmail(email);
      if (body?.user?.user_id) ownerIds.set(body.user.user_id, body.user.email ?? email);
    } catch (err) {
      log.warn(`owner lookup failed for ${email}: ${err.message}`);
    }
  }
}

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
  // mark (markdown preview) wiring, when the sidecar is configured. The
  // token reaches the container on purpose: it lets an agent register its
  // own docs for preview. It can only write .comments.md files beside
  // registered docs — no other capability.
  const markEnv =
    process.env.MARK_HOST && process.env.MARK_TOKEN
      ? [
          "-e", `MARK_HOST=${process.env.MARK_HOST}`,
          "-e", `MARK_TOKEN=${process.env.MARK_TOKEN}`,
          "-e", `MARK_CHANNEL=${stream}`,
        ]
      : [];
  const run = await sh([
    "run", "-d", "--rm",
    "--name", name,
    "--label", "family-agent-exec=1",
    ...mounts,
    ...markEnv,
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
  const ok = run.code === 0;
  audit.record("push", { stream, ok, output: text.slice(0, 300) });
  return ok
    ? `Pushed to origin main.\n${text}`
    : `Push failed:\n${text}`;
}

/** What the owner is approving: commits and diffstat ahead of origin/main. */
async function summarizePendingPush(stream) {
  if (!channelConfig.channels[stream]?.push) return "";
  const ws = workspaceDir(env, stream);
  const run = await sh([
    "run", "--rm",
    "-v", `${ws}:/workspace`,
    "-w", "/workspace",
    env.EXEC_IMAGE,
    "sh", "-c",
    "git log --oneline --no-decorate origin/main..HEAD 2>/dev/null | head -15; " +
      "echo '---'; git diff --stat origin/main..HEAD 2>/dev/null | tail -1",
  ]);
  const text = (run.stdout || "").trim();
  if (!text || text === "---") return "";
  return `Commits ahead of origin/main:\n\n\`\`\`\n${text.slice(0, 1200)}\n\`\`\``;
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
    audit.record("thread", {
      stream: mapping.stream,
      topic: mapping.topic,
      task: mapping.task ? String(mapping.task).slice(0, 200) : undefined,
    });
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

// The permission layer (Phase 2): deterministic rules per channel over every
// tool call, with the "ask" flow resolved by an owner's reaction on the
// approval message. Sessions never see reaction events, so approvals cannot
// be forged from inside a conversation.
const rulesCache = new Map();
const rulesFor = (channel) => {
  if (!channel) return null;
  if (!rulesCache.has(channel)) {
    rulesCache.set(channel, new PermissionRules(channelConfig.permissionConfigFor(channel)));
  }
  return rulesCache.get(channel);
};
const permissions = buildPermissionsExtension({
  rulesFor,
  audit,
  askTimeoutMs: env.ASK_TIMEOUT_MS,
  isOwner,
  post: async (conversationId, content) => {
    const mapping = byId.get(conversationId);
    if (!mapping) throw new Error(`no topic mapping for conversation ${conversationId}`);
    const posted = mapping.recipients
      ? await zulip.sendPrivateMessage(mapping.recipients, content)
      : await zulip.sendStreamMessage(mapping.stream, mapping.topic, content);
    const messageId = posted?.id ?? posted?.message?.id;
    if (!messageId) throw new Error("Zulip returned no message id");
    return messageId;
  },
  noteDecision: async (conversationId, text) => {
    const mapping = byId.get(conversationId);
    if (!mapping) return;
    if (mapping.recipients) await zulip.sendPrivateMessage(mapping.recipients, text);
    else await zulip.sendStreamMessage(mapping.stream, mapping.topic, text);
  },
  describe: async (channel, call) => {
    if (call?.name === "push_changes") {
      try {
        return await summarizePendingPush(channel);
      } catch {
        return "";
      }
    }
    return "";
  },
});
registry.install(permissions.extension);

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
    stream: groupKey, // workspace and channel key: one per DM group
    topic: groupKey,
    conversationKey: `dm::${groupKey}`,
    channel: groupKey,
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
      mapping.recipients
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
      let doc = await harness.snapshot(ZulipDoc, record.id, context);
      if (doc?.stream && doc?.topic) {
        if (doc.stream === "dm" && String(doc.topic).startsWith("dm-")) {
          // Migration: DM workspaces used to be one shared "dm" directory;
          // they are per group now, and the group key was the old topic.
          const group = doc.topic;
          await harness.commit(async (tx) => {
            const d = await tx.doc(ZulipDoc, record.id);
            d.stream = group;
          }, context);
          doc = { ...doc, stream: group };
          log.info(`migrated DM conversation ${record.id} to workspace ${group}`);
        }
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
      ? { stream: route.channel, topic: route.topic, recipients: route.replyRecipients }
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
    const posted = mapping.recipients
      ? await zulip.sendPrivateMessage(mapping.recipients, content)
      : await zulip.sendStreamMessage(mapping.stream, mapping.topic, content);
    await recordTailPost(conversationId, posted);
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
// Message edits and deletes (see docs/memos/message-editing.md)

/**
 * Routing index for edit/delete events: Zulip message id -> the conversation
 * and the requestId of the message's current turn. Ring-buffered to the last
 * ~1000 ingested messages. Written at ingestion time, before the run starts;
 * an edit of the message rewrites its requestId to the corrected turn's.
 */
async function setIndex(messageId, conversationId, requestId) {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(GatewayDoc);
    doc.messages ??= {};
    doc.messages[String(messageId)] = { conversationId, requestId };
    const keys = Object.keys(doc.messages);
    if (keys.length > 1000) {
      for (const key of keys.slice(0, keys.length - 1000)) delete doc.messages[key];
    }
  }, context);
}

/**
 * Resolve an edit/delete event to its conversation and current turn. The
 * index is primary; a message older than the ring falls back to fetching it
 * from Zulip (a deleted message cannot be fetched, so those drop out here).
 */
async function resolveMessageTarget(messageId) {
  const gw = await harness.snapshot(GatewayDoc, context);
  const hit = gw?.messages?.[String(messageId)];
  if (hit) return hit;
  const fresh = await zulip.getMessage(messageId).catch(() => null);
  const m = fresh?.message;
  if (!m || (botUserId !== null && m.sender_id === botUserId)) return null;
  if (m.type === "private") {
    const others = (m.display_recipient || []).filter((r) => r.id !== botUserId);
    const key = byTopic.get(`dm::dm-${others.map((r) => r.id).sort().join("-")}`);
    return key ? { conversationId: key, requestId: `zulip:${messageId}` } : null;
  }
  const key = byTopic.get(`${m.display_recipient}::${m.subject}`);
  return key ? { conversationId: key, requestId: `zulip:${messageId}` } : null;
}

/** Turn start: only the current turn's posts may be deleted on an edit. */
async function beginTailPosts(conversationId) {
  await harness.commit(async (tx) => {
    (await tx.doc(ZulipDoc, conversationId)).tailPosts = [];
  }, context);
}

async function recordTailPost(conversationId, posted) {
  const messageId = posted?.id ?? posted?.message?.id;
  if (!messageId) return;
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ZulipDoc, conversationId);
    doc.tailPosts ??= [];
    doc.tailPosts.push(messageId);
    if (doc.tailPosts.length > 100) doc.tailPosts = doc.tailPosts.slice(-100);
  }, context);
}

/** Delete the bot's posts of the current turn (best-effort, policy-bound). */
async function deleteTailPosts(conversationId) {
  const doc = await harness.snapshot(ZulipDoc, conversationId, context);
  const ids = doc?.tailPosts ?? [];
  const failed = [];
  for (const id of ids) {
    try {
      await zulip.deleteMessage(id);
    } catch (err) {
      failed.push(id);
      log.warn(`tail post delete failed (${id}): ${err.message}`);
    }
  }
  await harness.commit(async (tx) => {
    (await tx.doc(ZulipDoc, conversationId)).tailPosts = failed;
  }, context);
  return ids.length - failed.length;
}

/**
 * True when a `zulip.edit` entry now overrides the entries of the turn this
 * requestId submitted: the settled run is stale and its reply must not post.
 */
async function isSuperseded(conversationId, requestId) {
  const record = await harness.commit(
    (tx) => tx.submissionByRequest(conversationId, requestId),
    context
  );
  if (!record?.entry) return false;
  return harness.commit(async (tx) => {
    const page = await tx.scanEntries({ conversationId }, 50);
    return page.items.some(
      (e) => e.kind === "zulip.edit" && (e.edits ?? []).some((t) => t.target === record.entry)
    );
  }, context);
}

/**
 * Active-range entry ids at or above `fromId` (the input of the turn being
 * edited): the stale input plus everything its run produced. Mirrors
 * deriveContext's range: the newest head marker plus everything after it.
 */
async function collectTargets(tx, conversationId, fromId) {
  const targets = new Set();
  const marker = await tx.latestHeadMarker(conversationId);
  if (marker && marker.id >= fromId) targets.add(marker.id);
  let cursor;
  for (;;) {
    const page = await tx.scanEntries({ conversationId }, 100, cursor);
    for (const e of page.items) if (e.id >= fromId) targets.add(e.id);
    const oldest = page.items[page.items.length - 1]?.id;
    cursor = page.next;
    if (!cursor || (oldest !== undefined && oldest < fromId)) break;
  }
  return [...targets].sort((a, b) => a - b);
}

/** Newest pi.user entry id of a conversation, or undefined. */
async function newestUserEntry(conversationId) {
  return harness.commit(async (tx) => {
    let cursor;
    for (;;) {
      const page = await tx.scanEntries({ conversationId }, 50, cursor);
      const user = page.items.find((e) => e.kind === "pi.user");
      if (user) return user.id;
      cursor = page.next;
      if (!cursor) return undefined;
    }
  }, context);
}

/** A route rebuilt from a conversation's mapping (for re-runs and forks). */
function routeForMapping(mapping) {
  if (mapping.recipients) {
    return {
      kind: "dm",
      conversationKey: `dm::${mapping.topic}`,
      reply: (content) => zulip.sendPrivateMessage(mapping.recipients, content),
    };
  }
  return {
    kind: "stream",
    conversationKey: `${mapping.stream}::${mapping.topic}`,
    reply: (content) => zulip.sendStreamMessage(mapping.stream, mapping.topic, content),
  };
}

/**
 * The re-run of an edited turn: submit the corrected text, post the answer
 * where the original turn answered, and make the new turn current.
 */
async function runEditedTurn(conversation, route, { messageId, editTimestamp, content }) {
  const requestId = `zulip:${messageId}:e${editTimestamp}`;
  // Restart-safe: a re-delivered edit event finds this submission and skips.
  const existing = await harness.commit(
    (tx) => tx.submissionByRequest(conversation.id, requestId),
    context
  );
  if (existing) return;
  await zulip.addReaction(messageId, "eyes").catch(() => {});
  try {
    // Same ordering rule as fresh prompts: the placement must land in the
    // conversation's order gate so a concurrent /stop cannot overtake it.
    const submission = await inOrder(route.conversationKey, async () => {
      const doc = await harness.snapshot(ZulipDoc, conversation.id, context);
      await applyAutoModel(conversation, doc, content);
      await beginTailPosts(conversation.id);
      const sub = await conversation.submit(
        { type: "input", content, requestId, whenBusy: "followUp" },
        context
      );
      await setIndex(messageId, conversation.id, requestId);
      return sub;
    });
    const settled = await submission.wait(context);
    if (await isSuperseded(conversation.id, requestId)) {
      log.info(`edited turn ${requestId} superseded; reply skipped`);
      return;
    }
    const answer = await extractAnswer(conversation, settled);
    if (!answer) return; // aborted: silent
    const reply =
      answer.length > REPLY_CHAR_LIMIT
        ? `${answer.slice(0, REPLY_CHAR_LIMIT)}\n\n*(truncated — the full text is in the workspace)*`
        : answer;
    await recordTailPost(conversation.id, await route.reply(reply));
  } finally {
    await zulip.removeReaction(messageId, "eyes").catch(() => {});
  }
}

/**
 * Case B: the edited/deleted message is further back, so the conversation
 * forks at that point into a new topic and the corrected branch continues
 * there. Streams only.
 */
async function forkForEdit({ conversation, mapping, entryId, messageId, action, editTimestamp, content }) {
  const base = await forkTopicName(mapping, content).catch(() => `${mapping.topic} — edited`);
  const topic = uniqueTopic(mapping.stream, base);
  const { forkId, fresh } = await harness.commit(async (tx) => {
    const prev = (
      await tx.scanEntries({ conversationId: conversation.id, maxEntryId: entryId - 1 }, 1)
    ).items[0]?.id;
    if (prev) {
      const record = await tx.forkConversation(conversation.id, prev, {
        ownership: { kind: "ownerless" },
      });
      return { forkId: record.id, fresh: false };
    }
    // The edited message was the first entry ever: start a fresh conversation.
    const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
    return { forkId: record.id, fresh: true };
  }, context);
  if (fresh) {
    const forkInit = await harness.conversation(forkId, context);
    const tools = channelConfig
      .toolsFor(mapping.stream)
      .map((name) => toolByName.get(name))
      .filter(Boolean);
    await forkInit.configure(
      {
        model: MODEL_ALIASES.flash,
        thinkingLevel: "low",
        instructions: INSTRUCTIONS,
        tools,
      },
      context
    );
  }
  registerConversation(forkId, { stream: mapping.stream, topic });
  await zulip
    .sendStreamMessage(
      mapping.stream,
      topic,
      `*(forked from "${mapping.topic}" — an earlier message was ${action === "edit" ? "edited" : "deleted"}; the corrected history continues here)*`
    )
    .catch((err) => log.warn(`fork header post failed: ${err.message}`));
  await ensureWatcher(forkId).catch((err) =>
    log.error(`watcher for fork ${forkId} failed: ${err.message}`)
  );
  return { forkId, topic, requestId: `zulip:${messageId}:e${editTimestamp}` };
}

/** Topic name for an edited fork: the namer, fed the old topic + corrected text. */
async function forkTopicName(mapping, content) {
  return nameTopic({
    apiKey: env.OPENROUTER_API_KEY,
    messages: [
      { sender: `continuing topic "${mapping.topic}"`, content: "(the branch point)" },
      { sender: "user", content: content ? stripHtml(content).slice(0, 500) : "(deleted)" },
    ],
  });
}

function uniqueTopic(stream, base) {
  const taken = new Set(
    [...byTopic.keys()]
      .filter((k) => k.startsWith(`${stream}::`))
      .map((k) => k.slice(stream.length + 2))
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** One edit/delete event's shared prologue: resolve, classify, or bail. */
async function classifyEditEvent(event, messageId, hasContent) {
  const content = hasContent ? String(event.content || "").trim() : "";
  if (hasContent && (!content || content.startsWith("/") || String(event.orig_content || "").trim().startsWith("/"))) {
    return null; // rendering-only, move, or a slash command: never in the transcript
  }
  const target = await resolveMessageTarget(messageId);
  if (!target) {
    if (!hasContent) return null;
    // Never ingested (the gateway was down): the corrected text is fresh input.
    const fresh = await zulip.getMessage(messageId).catch(() => null);
    const m = fresh?.message;
    if (!m || (botUserId !== null && m.sender_id === botUserId)) return null;
    const route =
      m.type === "private" ? dmRoute(m) : streamRoute(m.display_recipient, m.subject);
    await provisionStream(env, route.channel, log);
    // raw_content is the markdown source; fall back to what the event or
    // GET returned (rendered) when the policy does not expose it.
    const freshMessage = {
      ...m,
      content: typeof m.raw_content === "string" ? m.raw_content : content,
    };
    await dispatchConversation(route, freshMessage.content, freshMessage);
    return null;
  }
  const conversation = await harness.conversation(target.conversationId, context);
  const mapping = byId.get(target.conversationId);
  if (!conversation || !mapping) return null;
  const sub = await harness.commit(
    (tx) => tx.submissionByRequest(target.conversationId, target.requestId),
    context
  );
  const queued = sub?.status === "queued";
  const entryId = sub?.entry;
  if (!queued && entryId === undefined) {
    if (!hasContent) return null; // never placed: ignore deletions
    // Known message but no placed turn: the corrected text is fresh input.
    const freshInput = { id: messageId, content, sender_id: event.user_id };
    await dispatchConversation(routeForMapping(mapping), freshInput.content, freshInput);
    return null;
  }
  const isLatest = queued || (await newestUserEntry(target.conversationId)) === entryId;
  return { conversation, mapping, queued, entryId, isLatest, content };
}

/** Append the durable edit marker that omits a turn from model context. */
async function appendEditEntry(conversation, { messageId, event, action, queued, entryId }) {
  await conversation.abort(context, { background: true });
  await harness.commit(async (tx) => {
    const targets = queued ? [] : await collectTargets(tx, conversation.id, entryId);
    await tx.appendEntry(conversation.id, {
      kind: "zulip.edit",
      data: {
        messageId,
        editor: event.user_id ?? event.editor_id ?? null,
        timestamp: event.edit_timestamp,
        action,
        targets,
      },
      edits: targets.map((target) => ({ target, action: "omit" })),
    });
  }, context);
}

/**
 * The `narrow` parameter only filters `message` events, so edit and delete
 * events arrive on every queue — one handler per poller would re-run an
 * edited turn once per queue. Dedupe by the event's globally-unique id.
 */
const seenEditEvents = new Map(); // event key -> expiry
function editEventSeen(event, messageId) {
  const key = `${event.type}:${event.id ?? `${messageId}:${event.edit_timestamp ?? 0}`}`;
  const now = Date.now();
  for (const [k, expiry] of seenEditEvents) if (expiry < now) seenEditEvents.delete(k);
  if (seenEditEvents.has(key)) return true;
  seenEditEvents.set(key, now + 10 * 60_000);
  return false;
}

/**
 * `update_message` handler: content edits only (moves and re-renders are
 * ignored). Latest-message edits re-run in place; older edits fork the
 * conversation into a new topic; DMs only support the latest.
 */
async function handleUpdateMessage(event) {
  const messageId = event.message_id;
  event = { ...event, edit_timestamp: event.edit_timestamp ?? Date.now() };
  if (editEventSeen(event, messageId)) return;
  const state = await classifyEditEvent(event, messageId, event.content !== undefined);
  if (!state) return;
  const { conversation, mapping, queued, entryId, isLatest, content } = state;
  const route = routeForMapping(mapping);
  if (isLatest) {
    // Case A: stop the stale run, strike the turn from context and Zulip,
    // re-run on the corrected text in place.
    await appendEditEntry(conversation, { messageId, event, action: "edit", queued, entryId });
    await deleteTailPosts(conversation.id);
    await runEditedTurn(conversation, route, {
      messageId,
      editTimestamp: event.edit_timestamp,
      content,
    });
    return;
  }
  if (mapping.recipients) {
    await route
      .reply(
        "*(an edit of an older DM message can't be replayed — only edits of the latest message are followed here)*"
      )
      .catch(() => {});
    return;
  }
  const { forkId, topic, requestId } = await forkForEdit({
    conversation,
    mapping,
    entryId,
    messageId,
    action: "edit",
    editTimestamp: event.edit_timestamp,
    content,
  });
  await setIndex(messageId, forkId, requestId);
  void runEditedTurn(await harness.conversation(forkId, context), streamRoute(mapping.stream, topic), {
    messageId,
    editTimestamp: event.edit_timestamp,
    content,
  }).catch((err) => log.error(`forked edit run failed: ${err.message}`));
}

/** `delete_message` handler: same shape as edits, but nothing re-runs. */
async function handleDeleteMessage(event) {
  const ids = event.message_ids ?? (event.message_id ? [event.message_id] : []);
  event = { ...event, edit_timestamp: event.edit_timestamp ?? Date.now() };
  if (editEventSeen(event, ids[0])) return;
  for (const messageId of ids) {
    const state = await classifyEditEvent(event, messageId, false);
    if (!state) continue;
    const { conversation, mapping, queued, entryId, isLatest } = state;
    if (isLatest) {
      // Silent: the turn vanishes from context, the bot's reply is deleted,
      // nothing re-runs, nothing posted.
      await appendEditEntry(conversation, { messageId, event, action: "delete", queued, entryId });
      await deleteTailPosts(conversation.id);
      continue;
    }
    if (mapping.recipients) continue; // DM deletes of older messages: ignore
    const { forkId, topic, requestId } = await forkForEdit({
      conversation,
      mapping,
      entryId,
      messageId,
      action: "delete",
      editTimestamp: event.edit_timestamp,
      content: "",
    });
    await setIndex(messageId, forkId, requestId);
    log.info(`delete forked ${mapping.stream}/${mapping.topic} -> ${topic} (${forkId})`);
  }
}

// ---------------------------------------------------------------------------
// Message flow

async function extractAnswer(conversation, settled) {
  if (settled.status !== "done") {
    // Aborted runs (an edit arrived, or /stop) stay silent; the aborting
    // flow posts its own notice.
    if (settled.reason === "aborted") return "";
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
    await beginTailPosts(conversationId);
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
    if (!answer) return; // aborted: silent
    await recordTailPost(
      conversationId,
      await zulip.sendStreamMessage(mapping.stream, mapping.topic, answer)
    );
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
// Place a prompt's durable effect: route it into the harness. This is
// the part that must not be overtaken by a later /stop (model routing
// takes seconds, and an abort that lands before the submission is placed
// marks nothing).
async function placePrompt(route, message) {
  const conversation = await ensureConversation(route);
  await ensureWatcher(conversation.id);
  // Edit/delete events resolve through this index; write it before the run
  // starts so even a queued message is routable.
  await setIndex(message.id, conversation.id, `zulip:${message.id}`);
  // Only the current turn's posts are deleted on a later edit.
  await beginTailPosts(conversation.id);
  const content = await ingestUploads(route, message);
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
  return { conversation, content, submission, requestId: `zulip:${message.id}` };
}

// Wait for a placed prompt's run and post its reply. Runs settle outside
// the conversation's order gate: a long run never blocks the next message.
async function settlePrompt(route, placed, message) {
  const { conversation, submission, requestId } = placed;
  const settled = await submission.wait(context);
  log.info(`settled: ${JSON.stringify(settled).slice(0, 400)}`);
  // A late edit: this run's turn was overridden while we were between
  // settling and posting — the re-run owns the reply now.
  if (await isSuperseded(conversation.id, requestId)) {
    log.info(`turn for message ${message.id} superseded by an edit; reply skipped`);
    return;
  }
  const answer = await extractAnswer(conversation, settled);
  if (!answer) return; // aborted: silent
  const reply =
    answer.length > REPLY_CHAR_LIMIT
      ? `${answer.slice(0, REPLY_CHAR_LIMIT)}\n\n*(truncated — the full text is in the workspace)*`
      : answer;
  await recordTailPost(conversation.id, await route.reply(reply));
  log.info(`reply posted (${reply.length} chars) -> ${route.conversationKey}`);
}

// One durable effect at a time per conversation, in delivery order: a
// /stop must land after the message it is meant to stop. Handlers for
// different conversations still run concurrently (the poll-loop fix).
const orderGates = new Map();
function inOrder(conversationKey, effect) {
  const prev = orderGates.get(conversationKey) ?? Promise.resolve();
  const gate = prev.then(effect);
  const link = gate.catch(() => {}); // a failed effect never blocks the chain
  orderGates.set(conversationKey, link);
  link.then(() => {
    if (orderGates.get(conversationKey) === link) orderGates.delete(conversationKey);
  });
  return gate;
}

// Dispatch one message inside its conversation's order gate. The gate
// covers the durable effect (a command, or placing a prompt); waiting for
// the run and posting its reply happen after, so the gate stays short.
async function dispatchConversation(route, content, message) {
  let placed = null;
  try {
    placed = await inOrder(route.conversationKey, async () => {
      if (content.startsWith("/")) {
        const handled = await handleCommand(route, content);
        if (handled) return null;
      }
      // Thinking indicator: an eyes reaction while the run is live,
      // removed when the reply posts (streams and DMs both).
      await zulip.addReaction(message.id, "eyes").catch(() => {});
      return placePrompt(route, message);
    });
  } catch (err) {
    log.error(`handling ${route.conversationKey} failed: ${err.message}`);
    await zulip.removeReaction(message.id, "eyes").catch(() => {});
    route.reply(`Gateway error: ${err.message}`).catch(() => {});
    return;
  }
  if (!placed) return;
  try {
    await settlePrompt(route, placed, message);
  } catch (err) {
    log.error(`settling ${route.conversationKey} failed: ${err.message}`);
    route.reply(`Gateway error: ${err.message}`).catch(() => {});
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
  audit.record("command", { channel: route.channel, command: cmd, arg: argStr.slice(0, 80) });

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
    await dispatchConversation(route, content, message);
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
    // One workspace per DM group, provisioned on first contact.
    await provisionStream(env, route.channel, log);
    await dispatchConversation(route, content, message);
  } catch (err) {
    log.error(`handling direct message ${route.conversationKey} failed: ${err.message}`);
    route.reply(`Gateway error: ${err.message}`).catch(() => {});
  }
}

async function onMessage(message) {
  if (message.type === "private") return onDmMessage(message);
  return onStreamMessage(message);
}

// Invitations are open: any member of the Zulip organization can add the
// bot to a channel, and the bot joins, provisions a workspace, and starts
// watching. (Until 2026-10-12 an owner gate checked that the configured
// owner was a subscriber; removed so other people can use the system.)

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
        if (event.type === "update_message") {
          void handleUpdateMessage(event).catch((err) =>
            log.error(`update_message handling failed: ${err.message}`)
          );
          continue;
        }
        if (event.type === "delete_message") {
          void handleDeleteMessage(event).catch((err) =>
            log.error(`delete_message handling failed: ${err.message}`)
          );
          continue;
        }
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

/**
 * Reaction queue: resolves pending permission asks. Zulip delivers
 * reaction events for a message to its author, so the queue sees reactions
 * on the bot's own approval messages; every other reaction is a miss on
 * the pending map and drops out. The bot's own reactions are skipped so a
 * decision note can never approve itself.
 */
async function pollReactionQueue() {
  const q = { queueId: null, lastEventId: -1 };
  for (;;) {
    try {
      if (!q.queueId) {
        const reg = await zulip.registerReactionQueue();
        q.queueId = reg.queue_id;
        q.lastEventId = reg.last_event_id;
        log.info(`reaction queue registered: ${q.queueId.slice(0, 8)}`);
      }
      const { events, lastEventId: newest } = await zulip.getEvents(q.queueId, q.lastEventId);
      q.lastEventId = newest;
      for (const event of events) {
        if (event.type !== "reaction") continue;
        if (botUserId !== null && event.user_id === botUserId) continue;
        await permissions
          .handleReactionEvent(event)
          .catch((err) => log.error(`reaction handling failed: ${err.message}`));
      }
    } catch (err) {
      log.warn(`reaction poll failed: ${err.message}; re-registering`);
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
  audit.record("boot", { bot: me.email, pid: process.pid });
  await cacheOwnerIds();
  if (env.ZULIP_OWNER_EMAILS.length > 0 && ownerIds.size === 0) {
    log.warn(
      "no owner ids resolved: permission asks will post but can never be approved " +
        "(check ZULIP_OWNER_EMAILS and the org's email visibility policy)"
    );
  }
  for (const dir of channelConfig.streams) {
    await mkdir(path.join(env.WORKSPACES_DIR, dir), { recursive: true });
  }
  await ensureStreamAccess();
  await discoverStreams();
  void pollControlQueue();
  void pollReactionQueue();

  const shutdown = async (sig) => {
    log.info(`${sig} received; shutting down`);
    audit.record("shutdown", { signal: sig });
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
