// JSONL RPC client speaking to a pi process inside a Docker container.
// Protocol: docs/rpc.md — one JSON object per line, LF framing only.
// Node's readline splits on U+2028/2029 which are legal inside JSON
// strings, so we split the byte stream ourselves on 0x0A.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export class PiRpc extends EventEmitter {
  /**
   * @param {string[]} dockerArgs full argv for `docker run -i ...`
   *   ending with the pi command, e.g. ["--name", "fa-x", "...", "pi",
   *   "--mode", "rpc", ...]
   */
  constructor(dockerArgs) {
    super();
    this.dockerArgs = dockerArgs;
    this.proc = null;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.buffer = Buffer.alloc(0);
    this.exited = false;
  }

  start() {
    this.proc = spawn("docker", ["run", "-i", "--rm", ...this.dockerArgs], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.emit("stderr", text);
    });
    this.proc.on("exit", (code) => {
      this.exited = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`pi process exited (code ${code})`));
      }
      this.pending.clear();
      this.emit("exit", code);
    });
    this.proc.on("error", (err) => this.emit("exit", -1, err));

    this.proc.stdin.on("error", (err) => {
      // EPIPE races with container exit; the exit event carries the news.
      if (!this.exited) this.emit("stderr", `stdin error: ${err.message}`);
    });
  }

  _onStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let idx;
    while ((idx = this.buffer.indexOf(0x0a)) !== -1) {
      let line = this.buffer.subarray(0, idx);
      this.buffer = this.buffer.subarray(idx + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      const text = line.toString("utf8").trim();
      if (!text) continue;
      let record;
      try {
        record = JSON.parse(text);
      } catch {
        this.emit("stderr", `unparseable RPC line: ${text.slice(0, 200)}`);
        continue;
      }
      this._onRecord(record);
    }
  }

  _onRecord(record) {
    if (record.type === "response" && record.id && this.pending.has(record.id)) {
      const entry = this.pending.get(record.id);
      this.pending.delete(record.id);
      clearTimeout(entry.timer);
      if (record.success) entry.resolve(record.data);
      else entry.reject(new Error(record.error || `command ${record.command} failed`));
      return;
    }
    // Session event (agent_start, message_update, agent_settled, ...) or a
    // response without a matching pending id (e.g. parse errors).
    this.emit(record.type === "response" ? "response" : "event", record);
  }

  /** Send a command object; resolve with response data on success. */
  send(command, timeoutMs = 120000) {
    if (this.exited) return Promise.reject(new Error("pi process exited"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${command.type} response`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify({ ...command, id }) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** True while the pi process is alive. */
  get alive() {
    return !this.exited;
  }

  /** Kill the container. Resolves when the docker command returns. */
  async close() {
    if (this.exited) return;
    this.exited = true;
    this.proc.stdin.end();
    this.proc.stdout.destroy();
    this.proc.stderr.destroy();
    await new Promise((resolve) => {
      const p = spawn("docker", ["kill", this.containerName], { stdio: "ignore" });
      p.on("exit", resolve);
      p.on("error", resolve);
    });
    this.proc = null;
  }
}
