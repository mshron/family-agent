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
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { contentText } from "@earendil-works/pi-ai";

import { Zulip } from "./lib/zulip.js";
import { buildModels, MODEL_ALIASES, smallLlm } from "./lib/models.js";
import { pickThinkingEmoji } from "./lib/emoji.js";
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

// Person model (dm-first memo): a one-on-one DM is a person's front
// conversation; the person's work stream holds its task conversations, and
// both share the person's DM workspace. workStream -> workspace channel.
const workStreamToWorkspace = new Map();
const workspaceChannelOf = (channel) => workStreamToWorkspace.get(channel) ?? channel;

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
  // Read-only skill layers on top of the writable workspace. A work
  // stream's workspace is its person's DM workspace (shared files).
  const mounts = ["-v", `${workspaceDir(env, workspaceChannelOf(stream))}:/workspace`];
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

// ---------------------------------------------------------------------------
// File hand-off: upload a workspace file to Zulip's user_uploads so the
// user can download it from chat. The gateway reads the file from its
// workspace mount; agents only ever pass a workspace-relative path.

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

async function uploadWorkspaceFile(stream, relativePath) {
  const ws = workspaceDir(env, workspaceChannelOf(stream));
  const abs = path.resolve(ws, String(relativePath));
  if (abs !== ws && !abs.startsWith(ws + path.sep)) {
    throw new Error("path must stay inside the channel's workspace");
  }
  const info = await stat(abs).catch(() => {
    throw new Error(`not found in the workspace: ${relativePath}`);
  });
  if (!info.isFile()) throw new Error(`not a regular file: ${relativePath}`);
  if (info.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `file is ${(info.size / 1024 / 1024).toFixed(1)} MB; the upload cap is ` +
        `${MAX_UPLOAD_BYTES / 1024 / 1024} MB (the org's own limit may be lower)`
    );
  }
  const bytes = await readFile(abs);
  const url = await zulip.uploadFile(bytes, path.basename(abs));
  audit.record("upload", { stream, path: String(relativePath).slice(0, 200), size: info.size });
  return { url, name: path.basename(abs), size: info.size };
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
  sections: [
    conventionsSection(env, workspaceChannelOf),
    memorySection(env, workspaceChannelOf),
    skillsSection(env),
  ],
});

const ZulipTools = buildZulipTools({
  onThreadCreated: (conversationId, mapping) => {
    // A crash rerun (run_task memo, spawn_thread memo, ownership index)
    // re-registers the same child: keep it mapped, but do not re-post its
    // header or audit it twice.
    const rerun = byId.get(conversationId)?.topic === mapping.topic;
    registerConversation(conversationId, mapping);
    if (!rerun) {
      audit.record(mapping.kind ?? "thread", {
        stream: mapping.stream,
        topic: mapping.topic,
        task: mapping.task ? String(mapping.task).slice(0, 200) : undefined,
        notify: mapping.notify?.dmChannel,
      });
    }
    if (mapping.header && !rerun) {
      zulip
        .sendStreamMessage(mapping.stream, mapping.topic, mapping.header)
        .catch((err) => log.error(`header post failed: ${err.message}`));
    }
    ensureWatcher(conversationId).catch((err) =>
      log.error(`watcher for ${conversationId} failed: ${err.message}`)
    );
    // A sync task started from a DM: acknowledge at once — the front
    // conversation is blocked on the answer and would otherwise stay silent
    // for the whole run (the 12 Nov review: "Great, I'm on it" first).
    if (mapping.kind === "task" && mapping.fromDm && !mapping.task) {
      const route = dmRouteForChannel(mapping.fromDm);
      if (route && allowProactive(mapping.fromDm)) {
        zulip
          .sendPrivateMessage(
            route.replyRecipients,
            `▶️ On it — task "${mapping.topic}" is running in #${mapping.stream}. I'll reply here with the result.`
          )
          .then((posted) => recordTailPost(byTopic.get(route.conversationKey), posted))
          .catch((err) => log.warn(`task ack post failed: ${err.message}`));
      }
    }
    if (mapping.task) void runSpawnedThread(conversationId, mapping);
  },
  onPushChanges: pushWorkspaceToOrigin,
  onUpload: uploadWorkspaceFile,
  resolveWorkStream: resolveWorkStreamForDoc,
  onTaskAgent: taskAgentFor,
  onSaveSkill,
  onTaskLedger: appendTaskLedger,
  uniqueTopicFor: uniqueTopic,
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
  // Per-person permission profile (dm-first memo, step 5): the person
  // whose conversation produced an ask may resolve it themselves.
  mayResolve: personMayResolve,
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
  // A one-on-one DM is a person's front conversation: record who the
  // person is, so run_task can resolve their work stream and workspace.
  const person =
    others.length === 1
      ? { id: others[0].id, email: others[0].email, name: others[0].full_name || null }
      : null;
  return {
    kind: "dm",
    stream: groupKey, // workspace and channel key: one per DM group
    topic: groupKey,
    conversationKey: `dm::${groupKey}`,
    channel: groupKey,
    person,
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
  "When you finish a job and learn a better way to do this kind of work, call save_skill with the method;",
  "the person approves it in chat, and future task conversations load it.",
].join(" ");

const INSTRUCTIONS_DM = [
  "You are the family assistant. You share one continuous direct-message thread with one person — the front conversation.",
  "Your final reply text is posted to that thread as-is, so answer directly and completely.",
  "How you work:",
  "- Small requests: handle them yourself with your tools.",
  "- When a real job arrives, do not investigate it first — call run_task right away with a complete task description. The task conversation does its own investigation, and tool output does not appear in this thread, so this thread shows only your words: keep replies short, human, and about the job.",
  "- Real jobs (document processing, file transformations, multi-step deliverables): call run_task. It starts a task conversation in the person's work stream (visible there as a topic), waits, and returns the result here. Files the person sends land in uploads/ — pass those paths along. Say that you delegated, and where the work is visible.",
  "- run_task with wait=false runs the job in the background; its result arrives here when it finishes.",
  "- Every delegated job is recorded in the task ledger (tasks.md in the workspace); the /tasks command and the nightly consolidation read it.",
  "- When the same kind of job repeats, or the person gives durable feedback on how work should be done, call save_skill to keep the method as a skill (it asks for approval first). Future task conversations load saved skills.",
  "- Memory lives in memory/ files and loads fresh on every message. When the user says \"remember X\" or \"forget Y\", edit the matching memory file and say what changed. Never put anything in memory the user would not want kept.",
  "- Some turns are scheduled passes (marked as such): propose memory edits in your reply, and apply them only after the user agrees.",
  "history_search finds past conversations in direct messages; there are no topics here, so spawn_thread and fork_thread do not apply.",
  "Workspace conventions: notes in notes/, writeups in docs/, uploads in uploads/. Commit your changes; say in your reply when you change memory.",
].join("\n");

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
      ? {
          stream: route.channel,
          topic: route.topic,
          recipients: route.replyRecipients,
          ...(route.person ? { person: route.person } : {}),
        }
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

/** The person whose conversation this is: a DM front conversation carries
 *  the person directly; a task conversation carries origin.taskFrom, the
 *  DM channel key of the person who delegated. */
async function personForConversation(conversationId) {
  const doc = await harness.snapshot(ZulipDoc, conversationId, context).catch(() => null);
  if (!doc) return null;
  if (doc.person) return doc.person;
  if (doc.origin?.taskFrom) {
    const dmId = byTopic.get(`dm::${doc.origin.taskFrom}`);
    if (dmId) {
      const dmDoc = await harness.snapshot(ZulipDoc, dmId, context).catch(() => null);
      return dmDoc?.person ?? null;
    }
  }
  return null;
}

/** May this user resolve an ask born in this conversation? The person
 *  whose front conversation (or delegated task) it is may always resolve;
 *  owners resolve everything (checked before this runs). */
async function personMayResolve(userId, conversationId) {
  const person = await personForConversation(conversationId);
  if (person && Number(userId) === person.id) return person.name || person.email;
  return null;
}

// ---------------------------------------------------------------------------
// Work streams (dm-first memo): task conversations for a person's DM.

function personSlug(person) {
  const raw = person.name || person.email?.split("@")[0] || "person";
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The person's work stream: the channels.json "people" entry wins; an
 *  owner without one gets an auto-derived "<first-name>-work" stream.
 *  Fails closed for anyone else (no config, no task delegation). */
async function workStreamForPerson(person) {
  const conf = channelConfig.people[person.email];
  if (conf?.workStream) return conf.workStream;
  const owner = await isOwner(person.id);
  if (!owner) return null;
  return `${personSlug(person)}-work`;
}

/** run_task's target: resolve the stream, and on first use join it, invite
 *  the person (they may mute it), provision the shared workspace, and start
 *  its poller. */
async function resolveWorkStreamForDoc(doc) {
  if (!doc?.recipients) return { error: "run_task is for direct messages." };
  if (!doc.person) {
    return {
      error:
        "No person is attached to this DM (group messages cannot delegate tasks). " +
        'Add a "people" entry in channels.json for one-on-one use.',
    };
  }
  const stream = await workStreamForPerson(doc.person);
  if (!stream) {
    return {
      error: `No work stream is configured for ${doc.person.email}. Add a "people" entry in channels.json.`,
    };
  }
  workStreamToWorkspace.set(stream, doc.stream);
  if (!streamQueues.has(stream)) {
    try {
      await zulip.subscribeSelf(
        stream,
        `Task conversations (family-agent work stream for ${doc.person.email})`
      );
    } catch (err) {
      return { error: `Could not join the work stream "${stream}" (${err.message}).` };
    }
    const invited = await zulip
      .subscribeOthers(stream, [doc.person.email])
      .catch(() => null);
    await provisionStream(env, stream, log, workspaceChannelOf(stream)).catch(() => {});
    startStreamQueue(stream);
    audit.record("workstream", {
      stream,
      person: doc.person.email,
      invited: invited?.added ?? [],
    });
    log.info(`work stream "${stream}" joined for ${doc.person.email}`);
  }
  return { stream };
}

/** The agent a task conversation starts with: the work stream's tool list,
 *  the strong model only when the front conversation pinned it. */
function taskAgentFor(stream, mode, person) {
  const strong = mode === "strong";
  // Per-person wording (dm-first memo, step 5): task instructions name
  // the person the task serves, falling back to the stream default.
  const instructions = person
    ? INSTRUCTIONS.replace(
        "You are Max's personal assistant.",
        `You are the personal assistant for ${person.name ?? person.email}.`
      )
    : INSTRUCTIONS;
  return {
    model: MODEL_ALIASES[strong ? "strong" : "flash"],
    thinkingLevel: strong ? "high" : "low",
    instructions,
    tools: channelConfig
      .toolsFor(stream)
      .map((name) => toolByName.get(name))
      .filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Skills loop (dm-first memo, step 5). Skills are prompt content, so the
// exec containers mount them read-only: writing is gateway-only, and every
// write lands as a git commit in the skills tree — the same tamper-evidence
// shape as the memory gate. A DM front conversation saves into the person's
// work stream (where task conversations load skills); a task or stream
// conversation saves into its own stream.

function skillSlug(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "skill";
}

function gitRun(args) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: env.SKILLS_DIR, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (out += c.toString()));
    child.on("exit", (code) => resolve({ code, out }));
    child.on("error", (e) => resolve({ code: -1, out: String(e) }));
  });
}

async function saveSkillToStream(stream, { name, description, instructions, mode }) {
  await mkdir(path.join(env.SKILLS_DIR, stream), { recursive: true });
  // The skills tree is one git repo: init once, commit every change.
  if (!existsSync(path.join(env.SKILLS_DIR, ".git"))) {
    let r = await gitRun(["init", "-q"]);
    if (r.code !== 0) throw new Error(`git init failed in skills dir: ${r.out.slice(0, 200)}`);
    r = await gitRun(["-c", "user.name=family-agent gateway", "-c", "user.email=gateway@family-agent.local", "commit", "--allow-empty", "-qm", "skills repo init"]);
    // An empty-commit failure is non-fatal; the next real save commits.
  }
  const slug = skillSlug(name);
  const dir = path.join(env.SKILLS_DIR, stream, slug);
  const file = path.join(dir, "SKILL.md");
  if (mode === "save" && existsSync(file)) {
    throw new Error(`a skill named "${slug}" already exists in ${stream}; use update_skill to change it`);
  }
  if (mode === "update" && !existsSync(file)) {
    throw new Error(`no skill named "${slug}" exists in ${stream}; use save_skill to create it`);
  }
  await mkdir(dir, { recursive: true });
  // An update without a new description keeps the old one (the description
  // is what future agents see when deciding to load the skill).
  let descriptionText = String(description || "").trim();
  if (!descriptionText && mode === "update") {
    const old = await readFile(file, "utf8").catch(() => "");
    descriptionText = /^description: ?(.*)$/m.exec(old)?.[1] ?? "";
  }
  if (!descriptionText) descriptionText = `${slug} skill.`;
  const body =
    `---\nname: ${slug}\ndescription: ${descriptionText.replace(/\n/g, " ").slice(0, 500)}\n---\n\n` +
    String(instructions).trim() +
    "\n";
  await writeFile(file, body);
  let r = await gitRun(["add", "-A"]);
  if (r.code !== 0) throw new Error(`git add failed: ${r.out.slice(0, 200)}`);
  r = await gitRun([
    "-c", "user.name=family-agent gateway",
    "-c", "user.email=gateway@family-agent.local",
    "commit", "-qm", `${mode === "save" ? "new" : "update"} skill ${stream}/${slug}`,
  ]);
  if (r.code !== 0) throw new Error(`git commit failed: ${r.out.slice(0, 200)}`);
  audit.record("skill", { stream, skill: slug, mode });
  log.info(`skill ${mode}d: ${stream}/${slug}`);
  return { slug, dir: `${stream}/${slug}` };
}

/** Where a conversation's skills live: the person's work stream from a DM
 *  front conversation (task conversations load skills there), else the
 *  conversation's own stream. */
async function skillsChannelForDoc(doc) {
  if (doc?.recipients && doc.person) {
    const stream = await workStreamForPerson(doc.person);
    if (stream) return stream;
    return {
      error:
        `No work stream is configured for ${doc.person.email}, so skills saved from the direct-message ` +
        `thread would have nowhere to load. Add a "people" entry in channels.json, or send the skill ` +
        `request from a task topic.`,
    };
  }
  return doc?.stream ?? null;
}

async function onSaveSkill(conversationId, args) {
  const doc = await harness.snapshot(ZulipDoc, conversationId, context).catch(() => null);
  if (!doc?.stream) throw new Error("no channel mapping for this conversation");
  const target = await skillsChannelForDoc(doc);
  if (!target || typeof target === "object") throw new Error(target?.error || "no skills directory for this conversation");
  return saveSkillToStream(target, args);
}

// ---------------------------------------------------------------------------
// Task ledger (dm-first memo, step 5): one grep-able file per person,
// tasks.md in their shared workspace. run_task appends; /tasks and the
// consolidation pass read.

async function appendTaskLedger(stream, text) {
  const ws = workspaceChannelOf(stream);
  if (!ws) return;
  const dir = workspaceDir(env, ws);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "tasks.md");
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  await appendFile(file, `- ${stamp} ${text}\n`);
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
    case "run_task":
      return String(a.topic ?? "");
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
  // DM front conversations stay human-readable (dm-first review): tool
  // output belongs in the task topic, not in the person's thread.
  if (mapping.recipients) return;
  if (watchers.get(conversationId)?.quiet) return; // gateway-initiated passes
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
  const reaction = await pickReaction(content, route, messageId);
  await zulip
    .addReaction(messageId, reaction.emoji)
    .catch(() => zulip.addReaction(messageId, "eyes").catch(() => {}));
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
    if (looksLikeProviderError(answer)) {
      log.error(`provider error as edited reply (${route.conversationKey}): ${answer.slice(0, 300)}`);
      audit.record("provider-error", { channel: route.channel, text: answer.slice(0, 300) });
      await recordTailPost(conversation.id, await route.reply(MODEL_FAILED_NOTICE));
      return;
    }
    const reply =
      answer.length > REPLY_CHAR_LIMIT
        ? `${answer.slice(0, REPLY_CHAR_LIMIT)}\n\n*(truncated — the full text is in the workspace)*`
        : answer;
    await recordTailPost(conversation.id, await route.reply(reply));
  } finally {
    await zulip
      .removeReaction(messageId, reaction.emoji)
      .catch(() => zulip.removeReaction(messageId, "eyes").catch(() => {}));
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
    await provisionStream(env, route.channel, log, workspaceChannelOf(route.channel));
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

// ---------------------------------------------------------------------------
// Gateway-initiated turns (scheduled passes, task-done reports)

/** A DM route rebuilt from a stored dm channel key, for proactive turns. */
function dmRouteForChannel(dmChannel) {
  const conversationId = byTopic.get(`dm::${dmChannel}`);
  const mapping = conversationId ? byId.get(conversationId) : null;
  if (!mapping?.recipients) return null;
  return {
    kind: "dm",
    stream: dmChannel,
    topic: dmChannel,
    conversationKey: `dm::${dmChannel}`,
    channel: dmChannel,
    replyRecipients: mapping.recipients,
    reply: (content) => zulip.sendPrivateMessage(mapping.recipients, content),
  };
}

/** Submit a gateway-initiated prompt and return its answer text. The
 *  requestId makes a restart rerun idempotent (same id, same submission).
 *  Spoilers stay quiet while it runs: these turns are internal bookkeeping,
 *  not the person's requests. */
async function runGatewayPrompt(route, content, requestId) {
  const conversation = await ensureConversation(route);
  await ensureWatcher(conversation.id);
  const state = watchers.get(conversation.id);
  if (state) state.quiet = true;
  try {
    const submission = await conversation.submit(
      { type: "input", content, requestId, whenBusy: "followUp" },
      context
    );
    const settled = await submission.wait(context);
    return extractAnswer(conversation, settled);
  } finally {
    if (state) state.quiet = false;
  }
}

// Proactivity budget: agent-initiated posts to a person's DM are capped per
// rolling hour, so a bug (or an injected instruction) cannot text-storm.
const PROACTIVE_LIMIT = Number(process.env.PROACTIVE_LIMIT_PER_HOUR) || 8;
const proactiveStamps = new Map(); // dm channel -> [ms]
function allowProactive(dmChannel) {
  const now = Date.now();
  const recent = (proactiveStamps.get(dmChannel) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= PROACTIVE_LIMIT) {
    audit.record("proactive-limited", { channel: dmChannel });
    return false;
  }
  recent.push(now);
  proactiveStamps.set(dmChannel, recent);
  return true;
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
    // A provider error that came through as the task's output: post the
    // notice, and let the DM report say the task failed (the person who
    // started it should know).
    let reportText = answer;
    const failed = looksLikeProviderError(answer);
    if (failed) {
      log.error(`provider error as thread reply (${mapping.stream}::${mapping.topic}): ${answer.slice(0, 300)}`);
      audit.record("provider-error", { channel: mapping.stream, text: answer.slice(0, 300) });
      reportText = MODEL_FAILED_NOTICE;
    }
    await recordTailPost(
      conversationId,
      await zulip.sendStreamMessage(mapping.stream, mapping.topic, reportText)
    );
    log.info(`thread reply posted (${reportText.length} chars) -> ${mapping.stream}::${mapping.topic}`);
    // The ledger records the outcome (dm-first memo, step 5) — even when
    // the proactive DM report is rate-limited away. Only for delegated
    // tasks (kind "task"); ordinary spawned threads keep out of the ledger.
    if (mapping.kind === "task")
    await appendTaskLedger(
      mapping.stream,
      `${failed ? "failed" : "finished"} "${mapping.topic}"` +
        ` — ${failed ? "model service error" : reportText.slice(0, 120).replace(/\n/g, " ")}`
    ).catch(() => {});
    // A background task delegated from a DM reports back there (dm-first
    // memo: fire-and-forget results arrive as proactive messages).
    if (mapping.notify?.dmChannel && allowProactive(mapping.notify.dmChannel)) {
      const route = dmRouteForChannel(mapping.notify.dmChannel);
      if (route) {
        try {
          const note =
            `(system note, not from the user) A background task just finished: ` +
            `topic "${mapping.topic}" in ${mapping.stream}. Its answer:\n\n` +
            `${reportText.slice(0, 1500)}\n\n` +
            `Tell the user the result now, briefly, in your own words. ` +
            `Include the topic name and any file links it produced. If the answer ` +
            `is a failure notice, say the task failed and offer to run it again.`;
          const reply = await runGatewayPrompt(route, note, `taskdone:${conversationId}`);
          if (reply && !reply.startsWith("*(no answer")) {
            await recordTailPost(
              byTopic.get(route.conversationKey),
              await zulip.sendPrivateMessage(route.replyRecipients, reply)
            );
            log.info(`task-done report posted -> ${route.conversationKey}`);
          }
        } catch (err) {
          log.error(`task-done report failed: ${err.message}`);
        }
      }
    }
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

// Provider failures can arrive as the model's own output: an upstream
// gateway (litellm behind OpenRouter) sometimes wraps a 502 in a completed
// message, so the harness sees a normal answer and its retry policy never
// engages. Raw error text must not reach a family chat; a transient blip
// should not put the work on the person either (one automatic retry).
const PROVIDER_ERROR_RE =
  /^(Error calling LLM|litellm\.|OpenAIException|Error code: [45]\d\d|API error|Rate limit)/i;

function looksLikeProviderError(text) {
  return PROVIDER_ERROR_RE.test((text || "").trim().slice(0, 200));
}

const MODEL_FAILED_NOTICE =
  "*(the model service failed just now — that message didn't go through; " +
  "sending it again should work)*";

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
  let answer = await extractAnswer(conversation, settled);
  // A provider error that came through as the model's output: the harness
  // never classified it, so retry once automatically before telling the
  // person anything.
  if (looksLikeProviderError(answer)) {
    log.error(`provider error as reply (${route.conversationKey}): ${answer.slice(0, 300)}`);
    audit.record("provider-error", { channel: route.channel, text: answer.slice(0, 300) });
    const retryId = `${requestId}:r1`;
    const already = await harness.commit(
      (tx) => tx.submissionByRequest(conversation.id, retryId),
      context
    );
    if (!already && !(await isSuperseded(conversation.id, requestId))) {
      try {
        const retry = await conversation.submit(
          {
            type: "input",
            content:
              `(system note, not from the user) The previous reply came back as a provider error ` +
              `("${answer.slice(0, 120)}") and was not delivered. ` +
              `Answer the user's last message again, as a normal reply.`,
            requestId: retryId,
            whenBusy: "followUp",
          },
          context
        );
        const settledRetry = await retry.wait(context);
        answer = await extractAnswer(conversation, settledRetry);
      } catch (err) {
        log.error(`provider-error retry failed: ${err.message}`);
      }
    } else {
      answer = ""; // already retried once (a crash rerun): fall through
    }
  }
  if (!answer) return; // aborted: silent
  if (looksLikeProviderError(answer) || answer.startsWith("*(no answer: model_error")) {
    await recordTailPost(conversation.id, await route.reply(MODEL_FAILED_NOTICE));
    log.warn(`model failure posted as notice -> ${route.conversationKey}`);
    return;
  }
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
  let thinkingEmoji = "eyes";
  let placed = null;
  try {
    placed = await inOrder(route.conversationKey, async () => {
      if (content.startsWith("/")) {
        const handled = await handleCommand(route, content);
        if (handled) return null;
      }
      // Thinking indicator: a Jev-picked emoji while the run is live,
      // removed when the reply posts (streams and DMs both).
      const reaction = await pickReaction(content, route, message.id);
      await zulip
        .addReaction(message.id, reaction.emoji)
        .catch(() => zulip.addReaction(message.id, "eyes").catch(() => {}));
      thinkingEmoji = reaction.emoji;
      return placePrompt(route, message);
    });
  } catch (err) {
    log.error(`handling ${route.conversationKey} failed: ${err.message}`);
    await zulip.removeReaction(message.id, thinkingEmoji).catch(() => zulip.removeReaction(message.id, "eyes").catch(() => {}));
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
    await zulip
      .removeReaction(message.id, thinkingEmoji)
      .catch(() => zulip.removeReaction(message.id, "eyes").catch(() => {}));
  }
}

/** The Jev-picked thinking reaction for one incoming message. Asks the
 *  Decisions API for a Choice over candidate emoji, fails closed to eyes,
 *  and audits every decision (including fallbacks) so thresholds can be
 *  tuned on what actually happened. */
async function pickReaction(content, route, messageId) {
  const reaction = await pickThinkingEmoji({
    apiKey: env.OPENROUTER_API_KEY,
    content,
    surface: route.kind === "dm" ? "direct message" : route.conversationKey,
  });
  audit.record("jev_emoji", {
    stream: route.stream ?? route.kind ?? "unknown",
    messageId,
    emoji: reaction.emoji,
    choice: reaction.choice,
    confidence: reaction.confidence,
    probabilities: reaction.probabilities,
    cost: reaction.cost,
    error: reaction.error,
  });
  return reaction;
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
    case "tasks": {
      // The task ledger (dm-first memo, step 5): tasks.md in the person's
      // shared workspace, appended by run_task. Show its tail; the older
      // topic scan covers workspaces without a ledger yet.
      const ledgerPath = path.join(
        workspaceDir(env, workspaceChannelOf(route.channel)),
        "tasks.md"
      );
      const ledger = await readFile(ledgerPath, "utf8").catch(() => null);
      if (ledger && ledger.trim()) {
        const lines = ledger.trim().split("\n");
        await say(`**Task ledger** (tasks.md, newest last):
\`\`\`\n${lines.slice(-25).join("\n")}\n\`\``);
        return true;
      }
      // Which stream's topics to list: the person's work stream in a DM,
      // this stream's own topics otherwise.
      let stream = route.kind === "dm" ? null : route.stream;
      if (route.kind === "dm") {
        const conversationId = byTopic.get(route.conversationKey);
        const doc = conversationId
          ? await harness.snapshot(ZulipDoc, conversationId, context)
          : null;
        stream = doc?.person ? await workStreamForPerson(doc.person) : null;
      }
      if (!stream) {
        await say("No tasks recorded yet — delegate a job first.");
        return true;
      }
      const prefix = `${stream}::`;
      const runningTopics = new Set(
        [...threadRuns]
          .map((id) => byId.get(id))
          .filter((m) => m && m.stream === stream)
          .map((m) => m.topic)
      );
      const topics = [...byTopic.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .slice(-15)
        .map((t) => `- ${t}${runningTopics.has(t) ? " *(running)*" : ""}`);
      await say(
        topics.length
          ? `Task topics in #${stream}:\n${topics.join("\n")}`
          : `No task topics in #${stream} yet.`
      );
      return true;
    }
    case "memory": {
      // Memory transparency (dm-first memo): the person can read what is
      // remembered. These are their own conversation's memory files.
      const dir = workspaceDir(env, workspaceChannelOf(route.channel));
      const files = [
        ["user", path.join(dir, "memory", "user.md")],
        ["channel", path.join(dir, "memory", "channels", `${route.channel}.md`)],
      ];
      const parts = [];
      for (const [label, file] of files) {
        const text = await readFile(file, "utf8").catch(() => null);
        if (text && text.trim()) parts.push(`**${label} memory**\n\n${text.trim()}`);
      }
      await say(parts.length ? parts.join("\n\n---\n\n") : "No memory yet for this conversation.");
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
let botEmail = null;

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
    await provisionStream(env, stream, log, workspaceChannelOf(stream));
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
      await provisionStream(env, stream, log, workspaceChannelOf(stream));
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
// Scheduled proactivity (dm-first memo): one nightly memory-consolidation
// pass per person's front conversation. The pass proposes edits in its
// reply (it does not write memory itself, so no ask fires overnight); a
// "nothing" answer is not posted. The requestId dedups a restart mid-pass.

const CONSOLIDATE_HOUR = Number(process.env.CONSOLIDATE_HOUR ?? 5);
const CONSOLIDATION_PROMPT = [
  "(scheduled nightly pass, not from the user) This is the memory-consolidation pass.",
  "Look over this conversation's recent turns and the workspace for durable facts about the user that are not yet in memory/.",
  "If there are some, reply with a short list of proposed memory edits (quote the exact lines you would add or change) and ask the user to confirm them.",
  "Do not edit memory yourself on this pass.",
  "If there is nothing worth persisting, reply with exactly: (nothing to consolidate)",
].join(" ");
const consolidatedOn = new Map(); // dm channel -> date string

setInterval(async () => {
  const now = new Date();
  if (now.getHours() !== CONSOLIDATE_HOUR) return;
  const date = now.toISOString().slice(0, 10);
  for (const key of [...byTopic.keys()]) {
    if (!key.startsWith("dm::")) continue;
    const dmChannel = key.slice(5);
    if (consolidatedOn.get(dmChannel) === date) continue;
    consolidatedOn.set(dmChannel, date);
    const conversationId = byTopic.get(key);
    const doc = conversationId
      ? await harness.snapshot(ZulipDoc, conversationId, context).catch(() => null)
      : null;
    if (!doc?.person) continue; // person front conversations only
    try {
      const route = dmRouteForChannel(dmChannel);
      if (!route) continue;
      const answer = await runGatewayPrompt(
        route,
        CONSOLIDATION_PROMPT,
        `consolidate:${dmChannel}:${date}`
      );
      const trimmed = (answer || "").trim();
      if (!trimmed || trimmed.startsWith("(nothing") || trimmed.startsWith("*(no answer")) continue;
      if (allowProactive(dmChannel)) {
        await recordTailPost(conversationId, await route.reply(trimmed));
        log.info(`consolidation posted for ${dmChannel}`);
      }
    } catch (err) {
      log.warn(`consolidation failed for ${dmChannel}: ${err.message}`);
    }
  }
}, 5 * 60_000).unref();

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

/** Fetch a user's full name; null when the lookup fails (the org may hide
 *  emails, but full_name is always visible — the live 12 Nov case where the
 *  person email was user1031086@… and the stream came out "user1031086-work"). */
async function personFullName(userId) {
  try {
    const body = await zulip.getUser(userId);
    const name = body?.user?.full_name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/** DM conversations created before this deploy: backfill the person field
 *  (with the real full name), and bring tool list and instructions up to
 *  the current front-conversation configuration (they are fixed at
 *  creation). */
async function migrateDmDocs() {
  for (const [key, conversationId] of [...byTopic.entries()]) {
    if (!key.startsWith("dm::")) continue;
    const doc = await harness.snapshot(ZulipDoc, conversationId, context);
    if (!doc?.recipients) continue;
    if (!doc.person) {
      const idMatch = /^dm-(\d+)$/.exec(doc.stream);
      const others = (doc.recipients || []).filter((e) => e !== botEmail);
      if (!idMatch || others.length !== 1) continue;
      const person = {
        id: Number(idMatch[1]),
        email: others[0],
        name: await personFullName(Number(idMatch[1])),
      };
      await harness.commit(async (tx) => {
        (await tx.doc(ZulipDoc, conversationId)).person = person;
      }, context);
      log.info(
        `person backfilled for ${doc.stream}: ${person.email} (${person.name ?? "name unknown"})`
      );
    } else if (!doc.person.name) {
      // Backfilled before the name fix (obfuscated email, null name): a
      // null-name person slug is what named a work stream "user…-work".
      const name = await personFullName(doc.person.id);
      if (name) {
        await harness.commit(async (tx) => {
          const d = await tx.doc(ZulipDoc, conversationId);
          d.person = { ...d.person, name };
        }, context);
        log.info(`person name backfilled for ${doc.stream}: ${name}`);
      }
    }
    const conversation = await harness.conversation(conversationId, context);
    if (!conversation) continue;
    const tools = channelConfig
      .toolsFor(doc.stream)
      .map((name) => toolByName.get(name))
      .filter(Boolean);
    await conversation.configure({ instructions: INSTRUCTIONS_DM, tools }, context);
  }
}

/** Rename a person's work stream from an old auto-derived name to the
 *  current one, moving every task conversation's mapping with it. No-op
 *  when the Zulip stream is gone or the rename is refused (a collision). */
async function renameWorkStream(oldName, newName, dmChannel) {
  try {
    const stream = await zulip.getStreamByName(oldName);
    if (stream) {
      // The bot is usually not a stream administrator, so this is refused;
      // the person can rename it in Zulip and the next boot adopts it below.
      await zulip.renameStream(stream.stream_id, newName);
    } else {
      // Old name gone: someone renamed it manually. Adopt it if the new
      // name exists; otherwise there is nothing to move onto.
      const target = await zulip.getStreamByName(newName);
      if (!target) return false;
    }
  } catch (err) {
    log.warn(`work stream rename ${oldName} -> ${newName} refused: ${err.message}`);
    return false;
  }
  for (const [tid, m] of [...byId.entries()]) {
    if (m.stream !== oldName) continue;
    await harness.commit(async (tx) => {
      (await tx.doc(ZulipDoc, tid)).stream = newName;
    }, context);
    for (const [k] of [...byTopic.entries()]) {
      if (k.startsWith(`${oldName}::`)) byTopic.delete(k);
    }
    registerConversation(tid, { stream: newName, topic: m.topic });
  }
  workStreamToWorkspace.set(
    newName,
    workStreamToWorkspace.get(oldName) ?? dmChannel
  );
  workStreamToWorkspace.delete(oldName);
  stopStreamQueue(oldName);
  startStreamQueue(newName);
  audit.record("workstream-rename", { from: oldName, to: newName, person: dmChannel });
  log.info(`work stream renamed: ${oldName} -> ${newName}`);
  return true;
}

/** One-time boot pass: when the person's name was unknown at first
 *  derivation (the obfuscated-email case), the work stream came out as
 *  "user<id>-work". Rename it to "<name>-work" now that the name is known. */
async function migrateWorkStreamNames() {
  for (const [key, conversationId] of [...byTopic.entries()]) {
    if (!key.startsWith("dm::")) continue;
    const dmChannel = key.slice(5);
    const doc = await harness.snapshot(ZulipDoc, conversationId, context);
    if (!doc?.person) continue;
    const desired = await workStreamForPerson(doc.person);
    if (!desired) continue;
    for (const [tid, m] of [...byId.entries()]) {
      if (m.recipients || !m.stream?.endsWith("-work") || m.stream === desired) continue;
      const tdoc = await harness.snapshot(ZulipDoc, tid, context);
      if (tdoc?.origin?.taskFrom !== doc.stream) continue; // not this person's
      const renamed = await renameWorkStream(m.stream, desired, dmChannel);
      if (!renamed) break;
    }
  }
}

/** Boot pass: register every person's work stream -> its DM workspace, so
 *  task conversations share the person's files across restarts. */
async function resolvePersonStreams() {
  for (const [key, conversationId] of [...byTopic.entries()]) {
    if (!key.startsWith("dm::")) continue;
    const doc = await harness.snapshot(ZulipDoc, conversationId, context);
    if (!doc?.person) continue;
    const stream = await workStreamForPerson(doc.person);
    if (stream) workStreamToWorkspace.set(stream, doc.stream);
    // Task conversations created under an older stream name keep sharing
    // the person's workspace even before (or without) a rename.
    for (const [tid, m] of [...byId.entries()]) {
      if (m.recipients || !m.stream?.endsWith("-work")) continue;
      const tdoc = await harness.snapshot(ZulipDoc, tid, context);
      if (tdoc?.origin?.taskFrom === doc.stream) {
        workStreamToWorkspace.set(m.stream, doc.stream);
      }
    }
  }
  if (workStreamToWorkspace.size > 0) {
    log.info(`work streams: ${[...workStreamToWorkspace.entries()].map(([s, w]) => `${s} -> ${w}`).join(", ")}`);
  }
}

async function main() {
  const me = await zulip.getMe();
  botUserId = me.user_id;
  botEmail = me.email;
  log.info(`gateway bot: ${me.full_name} <${me.email}> (user_id ${botUserId})`);
  audit.record("boot", { bot: me.email, pid: process.pid });
  await cacheOwnerIds();
  await migrateDmDocs();
  await resolvePersonStreams();
  await migrateWorkStreamNames();
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
