// Conversation manager: one (stream, topic) -> one pi session container.
// Containers are disposable; session files on the sessions volume carry
// the conversation across container recycles and gateway restarts.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { PiRpc } from "./pi-rpc.js";

const IDLE_SWEEP_MS = 60_000;

export class SessionManager extends EventTarget {
  constructor({ env, index, log }) {
    super();
    this.env = env; // {SESSION_IMAGE, WORKSPACE_DIR, SESSIONS_DIR, IDLE_MINUTES, ...}
    this.index = index;
    this.log = log;
    this.sessions = new Map(); // key -> session object

    this.sweepTimer = setInterval(() => this._sweepIdle(), IDLE_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  key(stream, topic) {
    return `${stream}::${topic}`;
  }

  _hash(key) {
    return createHash("sha1").update(key).digest("hex").slice(0, 12);
  }

  _label(stream, topic) {
    return `${stream}/${topic}`.slice(0, 100);
  }

  async _spawn(stream, topic) {
    const key = this.key(stream, topic);
    const hash = this._hash(key);
    const containerName = `fa-${hash}`;
    const label = this._label(stream, topic);
    const stored = this.index.get(key);

    const dockerArgs = [
      "--name", containerName,
      "--label", "family-agent-session=1",
      "-v", `${this.env.WORKSPACE_DIR}:/workspace`,
      "-v", `${this.env.SESSIONS_DIR}:/sessions`,
      "-w", "/workspace",
      "-e", `OPENROUTER_API_KEY=${this.env.OPENROUTER_API_KEY}`,
      "-e", `SEARCH_PROVIDER=${this.env.SEARCH_PROVIDER}`,
      "-e", `KAGI_API_KEY=${this.env.KAGI_API_KEY || ""}`,
      "-e", `BRAVE_API_KEY=${this.env.BRAVE_API_KEY || ""}`,
      "-e", `TZ=${this.env.TZ || "UTC"}`,
      this.env.SESSION_IMAGE,
      "pi", "--mode", "rpc",
      "--session-dir", "/sessions",
      ...(stored?.sessionFile
        ? ["--session", stored.sessionFile]
        : ["--session-id", `fa-${hash}`]),
      "-n", label,
    ];

    const rpc = new PiRpc(dockerArgs);
    rpc.containerName = containerName;

    // A gateway crash can orphan a session container with this name.
    // Session files persist, so removing it is always safe.
    await new Promise((resolve) => {
      const p = spawn("docker", ["rm", "-f", containerName], { stdio: "ignore" });
      p.on("exit", resolve);
      p.on("error", resolve);
    });

    const session = {
      key,
      stream,
      topic,
      containerName,
      rpc,
      busy: false,
      pendingReplies: 0,
      postSettleQueue: [],
      lastActivity: Date.now(),
      starting: true,
      startError: null,
    };

    rpc.on("event", (record) => this._onEvent(session, record));
    rpc.on("stderr", (text) => this.log.debug(`[pi:${label}] ${text}`));
    rpc.on("exit", (code) => {
      // Only react to our own live entry; stale exits after recycle are ignored.
      if (this.sessions.get(key)?.rpc !== rpc) return;
      this.log.info(`container ${containerName} exited (code ${code})`);
      this.sessions.delete(key);
      session.startError = new Error(`session container exited (code ${code})`);
    });

    rpc.start();
    this.sessions.set(key, session);

    // Readiness: pi answers get_state once it is up.
    try {
      const state = await rpc.send({ type: "get_state" }, 90_000);
      this.log.info(
        `session up: ${label} (${containerName}) file=${state.sessionFile}`
      );
      await this.index.setSessionFile(key, state.sessionFile);
    } catch (err) {
      await this._kill(session);
      throw new Error(`session failed to start: ${err.message}`);
    }

    // Default model: the `auto` virtual model at level low.
    try {
      await rpc.send(
        { type: "set_model", provider: "router", modelId: "auto" },
        60_000
      );
      await rpc.send({ type: "set_thinking_level", level: "low" }, 60_000);
    } catch (err) {
      this.log.warn(`router/auto unavailable (${err.message}); using openrouter/z-ai/glm-5.3-flash`);
      await rpc.send(
        { type: "set_model", provider: "openrouter", modelId: "z-ai/glm-5.3-flash" },
        60_000
      );
    }

    session.starting = false;
    return session;
  }

  async ensure(stream, topic) {
    const key = this.key(stream, topic);
    let session = this.sessions.get(key);
    if (session && session.rpc.alive) return session;
    session = await this._spawn(stream, topic);
    return session;
  }

  /**
   * Send a user message. Prepends the memory preamble. If a run is active,
   * queues as a follow-up so nothing is lost.
   */
  async prompt(stream, topic, text) {
    const session = await this.ensure(stream, topic);
    const { buildMemoryPreamble } = await import("./memory.js");
    const preamble = await buildMemoryPreamble(
      this.env.WORKSPACE_DIR,
      stream
    );
    const message = preamble ? `${preamble}\n\n${text}` : text;

    const cmd = {
      type: "prompt",
      message,
      ...(session.busy ? { streamingBehavior: "followUp" } : {}),
    };
    const resp = await session.rpc.send(cmd, 120_000);
    session.lastActivity = Date.now();
    if (resp.disposition !== "handled") session.pendingReplies += 1;
    session.busy = true;
    return resp;
  }

  async stop(stream, topic) {
    const session = this.sessions.get(this.key(stream, topic));
    if (!session) return false;
    await session.rpc.send({ type: "abort" }, 120_000);
    session.pendingReplies = 0;
    session.busy = false;
    session.postSettleQueue = [];
    session.lastActivity = Date.now();
    return true;
  }

  async compact(stream, topic) {
    const session = await this.ensure(stream, topic);
    if (session.busy) throw new Error("session is busy; /stop first or wait");
    return session.rpc.send({ type: "compact" }, 600_000);
  }

  async setModel(stream, topic, provider, modelId, level) {
    const session = await this.ensure(stream, topic);
    if (session.busy) throw new Error("session is busy; /stop first or wait");
    const model = await session.rpc.send(
      { type: "set_model", provider, modelId },
      60_000
    );
    let levelSet = null;
    if (level) {
      await session.rpc.send({ type: "set_thinking_level", level }, 60_000);
      levelSet = level;
    }
    session.lastActivity = Date.now();
    return { model, level: levelSet };
  }

  async stats(stream, topic) {
    const session = this.sessions.get(this.key(stream, topic));
    if (!session) return null;
    return session.rpc.send({ type: "get_session_stats" }, 60_000);
  }

  /**
   * /new: ask for a handoff note, wait for the reply to post, then rotate
   * to a fresh session file and record it.
   */
  async newConversation(stream, topic) {
    const session = await this.ensure(stream, topic);
    if (session.busy) throw new Error("session is busy; /stop first, then /new");
    const date = new Date().toISOString().slice(0, 10);
    const handoffPrompt =
      `The user is ending this conversation with /new. Write a handoff note ` +
      `to notes/handoff-${date}-${this._hash(this.key(stream, topic))}.md now: ` +
      `what was in progress, what the next conversation must know, which ` +
      `files matter. Commit it. Keep the note short. Then reply with one ` +
      `line saying the handoff note is saved.`;
    await session.rpc.send({ type: "prompt", message: handoffPrompt }, 120_000);
    session.pendingReplies += 1;
    session.busy = true;
    session.postSettleQueue.push(async () => {
      await session.rpc.send({ type: "new_session" }, 120_000);
      const state = await session.rpc.send({ type: "get_state" }, 60_000);
      await this.index.setSessionFile(session.key, state.sessionFile);
      this.log.info(`new session for ${session.key}: ${state.sessionFile}`);
      session.lastActivity = Date.now();
    });
  }

  _onEvent(session, record) {
    switch (record.type) {
      case "agent_start":
        session.busy = true;
        break;
      case "agent_settled": {
        session.busy = false;
        session.lastActivity = Date.now();
        this._drainSettled(session).catch((err) =>
          this.log.error(`post-settle error (${session.key}): ${err.message}`)
        );
        break;
      }
      case "extension_error":
        this.log.warn(`extension error: ${JSON.stringify(record).slice(0, 300)}`);
        break;
      default:
        break;
    }
  }

  async _drainSettled(session) {
    // A queued follow-up may still be delivered; only post when the
    // pending-reply ledger says this settle answers a user message.
    if (session.pendingReplies > 0) {
      session.pendingReplies -= 1;
      let text = null;
      try {
        const out = await session.rpc.send(
          { type: "get_last_assistant_text" },
          60_000
        );
        text = out.text;
      } catch (err) {
        this.log.warn(`get_last_assistant_text failed: ${err.message}`);
      }
      this.dispatchEvent(
        new CustomEvent("reply", { detail: { session, text } })
      );
    }
    // Post-settle actions (e.g. /new session rotation) run after replies.
    const next = session.postSettleQueue.shift();
    if (next) await next();
  }

  async _kill(session) {
    try {
      await session.rpc.close();
    } catch (err) {
      this.log.warn(`kill ${session.containerName}: ${err.message}`);
    }
  }

  async _sweepIdle() {
    const cutoff = Date.now() - (this.env.IDLE_MINUTES || 30) * 60_000;
    for (const session of [...this.sessions.values()]) {
      if (session.busy || session.starting) continue;
      if (session.lastActivity >= cutoff) continue;
      this.log.info(`idle: recycling ${session.containerName} (${session.key})`);
      this.sessions.delete(session.key);
      await this._kill(session);
    }
  }

  async closeAll() {
    clearInterval(this.sweepTimer);
    for (const session of [...this.sessions.values()]) {
      this.sessions.delete(session.key);
      await this._kill(session);
    }
  }
}
