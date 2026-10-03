// family-agent gateway (Phase 1 — feel test).
//
// Zulip <-> pi bridge: every (stream, topic) is one conversation backed by
// one pi session container running `pi --mode rpc`. The gateway injects
// memory files into each message, posts replies back to the topic, and
// wires the /new /compact /stop /model /stats commands.
//
// See docs/memos/hetzner-consolidation.md for the design this implements.

import { Zulip } from "./lib/zulip.js";
import { SessionManager } from "./lib/sessions.js";
import { ConversationIndex } from "./lib/state.js";

const REPLY_CHAR_LIMIT = 9000;

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
  SESSION_IMAGE: process.env.SESSION_IMAGE || "family-agent-session:latest",
  WORKSPACE_DIR: process.env.WORKSPACE_DIR || "/opt/family-agent/workspace",
  SESSIONS_DIR: process.env.SESSIONS_DIR || "/opt/family-agent/sessions",
  OPENROUTER_API_KEY: requireEnv("OPENROUTER_API_KEY"),
  SEARCH_PROVIDER: process.env.SEARCH_PROVIDER || "brave",
  KAGI_API_KEY: process.env.KAGI_API_KEY || "",
  BRAVE_API_KEY: process.env.BRAVE_API_KEY || "",
  IDLE_MINUTES: Number(process.env.IDLE_MINUTES) || 30,
  TZ: process.env.TZ || "UTC",
  ZULIP_OWNER_EMAILS: (process.env.ZULIP_OWNER_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

const zulip = new Zulip({
  site: env.ZULIP_SITE,
  email: env.ZULIP_EMAIL,
  apiKey: env.ZULIP_API_KEY,
});

const index = new ConversationIndex(env.SESSIONS_DIR);
await index.load();

const sessions = new SessionManager({ env, index, log });

sessions.addEventListener("reply", (event) => {
  const { session, text } = event.detail;
  postReply(session, text);
});

function postReply(session, text) {
  const content =
    text && text.trim()
      ? text.length > REPLY_CHAR_LIMIT
        ? `${text.slice(0, REPLY_CHAR_LIMIT)}\n\n*(truncated — the full text is in the workspace)*`
        : text
      : "*(the session produced no text — check the gateway logs)*";
  zulip
    .sendStreamMessage(session.stream, session.topic, content)
    .then(() => log.info(`reply posted (${content.length} chars) -> ${session.key}`))
    .catch((err) => log.error(`failed to post reply to ${session.key}: ${err.message}`));
}

// ---------------------------------------------------------------------------
// Commands and message routing

const MODEL_ALIASES = {
  auto: { provider: "router", modelId: "auto" },
  flash: { provider: "openrouter", modelId: "z-ai/glm-5.3-flash" },
  strong: { provider: "openrouter", modelId: "z-ai/glm-5.3" },
};

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
      await sessions.newConversation(stream, topic);
      await say("Starting a fresh conversation. The handoff note is saved; memory and workspace carry over.");
      return true;
    }
    case "compact": {
      try {
        const out = await sessions.compact(stream, topic);
        await say(
          `Compacted: ~${out.estimatedTokensAfter ?? "?"} tokens remain ` +
            `(was ${out.tokensBefore ?? "?"}).`
        );
      } catch (err) {
        await say(`Compaction failed: ${err.message}`);
      }
      return true;
    }
    case "stop": {
      const stopped = await sessions.stop(stream, topic);
      await say(stopped ? "Stopped." : "Nothing to stop.");
      return true;
    }
    case "stats": {
      const stats = await sessions.stats(stream, topic);
      if (!stats) {
        await say("No active session for this topic; send a message first.");
        return true;
      }
      await say(
        `Session stats: ${stats.userMessages} user / ${stats.assistantMessages} assistant messages, ` +
          `${stats.toolCalls} tool calls, ${stats.tokens?.totalTokens ?? "?"} tokens total, ` +
          `cost $${(stats.cost ?? 0).toFixed(4)}, context ${stats.contextUsage?.percent ?? "?"}%.`
      );
      return true;
    }
    case "model": {
      const parts = argStr.split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        await say(
          "Usage: `/model auto [low|high]` | `/model flash` | `/model strong`. " +
            "Default is `auto low` (GLM-5.3-flash; `auto high` escalates to GLM-5.3)."
        );
        return true;
      }
      const alias = MODEL_ALIASES[parts[0].toLowerCase()];
      if (!alias) {
        await say(`Unknown model "${parts[0]}". Use auto, flash, or strong.`);
        return true;
      }
      const level = parts[1] ? parts[1].toLowerCase() : undefined;
      try {
        const out = await sessions.setModel(
          stream, topic,
          alias.provider, alias.modelId, level
        );
        await say(
          `Model set: ${out.model.name ?? out.model.id}` +
            (out.level ? ` (thinking: ${out.level})` : "")
        );
      } catch (err) {
        await say(`Setting model failed: ${err.message}`);
      }
      return true;
    }
    default:
      return false; // Not a gateway command: treat as a prompt.
  }
}

async function onMessage(message) {
  const stream = message.display_recipient;
  const topic = message.subject;
  const content = (message.content || "").trim();
  if (!content) return;

  log.info(`message from ${message.sender_full_name} in ${stream}/${topic}: ${content.slice(0, 120)}`);

  try {
    if (content.startsWith("/")) {
      const handled = await handleCommand(stream, topic, content);
      if (handled) return;
      // Unknown slash commands still go to the session (pi may know them).
    }
    await sessions.prompt(stream, topic, content);
  } catch (err) {
    log.error(`handling message in ${stream}/${topic} failed: ${err.message}`);
    zulip
      .sendStreamMessage(stream, topic, `Gateway error: ${err.message}`)
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Zulip wiring and long-poll loop

let botUserId = null;

async function ensureStreamAccess() {
  try {
    await zulip.subscribeSelf(
      env.SCRATCH_STREAM,
      "Phase 1 feel test: gateway + pi sessions"
    );
    log.info(`subscribed bot to stream "${env.SCRATCH_STREAM}"`);
  } catch (err) {
    log.warn(
      `could not subscribe to stream "${env.SCRATCH_STREAM}" (${err.message}). ` +
        `Messages will not arrive until the bot is a member.`
    );
  }
  if (env.ZULIP_OWNER_EMAILS.length > 0) {
    const out = await zulip.subscribeOthers(env.SCRATCH_STREAM, env.ZULIP_OWNER_EMAILS);
    if (out.added.length > 0) {
      log.info(`added to stream: ${out.added.join(", ")}`);
    } else if (out.msg) {
      log.warn(`could not add owners to stream: ${out.msg}`);
    }
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
      log.warn(`get_events failed: ${err.message}; re-registering`);
      queueId = null;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function main() {
  const me = await zulip.getMe();
  botUserId = me.user_id;
  log.info(`gateway bot: ${me.full_name} <${me.email}> (user_id ${botUserId})`);

  await ensureStreamAccess();

  const shutdown = async (sig) => {
    log.info(`${sig} received; shutting down`);
    await sessions.closeAll();
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
