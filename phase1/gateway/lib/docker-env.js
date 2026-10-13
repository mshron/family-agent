// DockerExecutionEnv: pi-durable's ExecutionEnv implemented over
// `docker exec` against one container per conversation. Tool calls
// (bash/read/write/edit) run inside the conversation's container; the
// gateway process holds no workspace files and no credentials beyond its own.
//
// argv-style docker exec throughout: the command string is one argv element,
// so there is no quoting ambiguity. File ops map to coreutils in the container.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";

const ok = (value) => ({ ok: true, value });
const err = (error) => ({ ok: false, error });

function fileErr(code, message, p) {
  return new FileError(code, message, p);
}

// The read tool needs BinaryReader.scanLines, whose semantics (streaming
// WHATWG decode, byte-order-mark handling, slice-like negative ends) are
// subtle. pi-durable ships the reference LineScanner in its own dist — the
// gateway copies it into the container and drives it, so the semantics track
// whatever version is installed instead of a reimplementation drifting.
const SCAN_DIR = "/tmp/.fa-line-scan";
let scanSources;

function lineScanSources() {
  if (!scanSources) {
    const require = createRequire(import.meta.url);
    const lineScanPath = require.resolve(
      "@earendil-works/pi-durable/dist/env/line-scan.js"
    );
    const dir = path.dirname(lineScanPath);
    scanSources = {
      lineScan: readFileSync(lineScanPath, "utf8").replace(
        /from "\.\/decode\.js"/g,
        `from "${SCAN_DIR}/decode.js"`
      ),
      decode: readFileSync(path.join(dir, "decode.js"), "utf8"),
      driver: `import { LineScanner } from "${SCAN_DIR}/line-scan.js";
import { closeSync, openSync, readSync } from "node:fs";
const [, , file, start, end] = process.argv;
const scanner = new LineScanner(Number(start), end === "" ? undefined : Number(end));
const fd = openSync(file, "r");
try {
  const chunk = new Uint8Array(64 * 1024);
  for (;;) {
    const n = readSync(fd, chunk, 0, chunk.length, null);
    if (n === 0) break;
    scanner.push(chunk.subarray(0, n));
  }
} finally {
  closeSync(fd);
}
process.stdout.write(JSON.stringify(scanner.finish()));
`,
    };
  }
  return scanSources;
}

class DockerBinaryReader {
  /** The env, for _execArgv and fileInfo; the path this reader is bound to. */
  env;
  file;

  constructor(env, file) {
    this.env = env;
    this.file = file;
  }

  async info(context) {
    return this.env.fileInfo(this.file, context);
  }

  async read(offset, length, context) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      return err(fileErr("invalid", `invalid read range: ${offset}+${length}`, this.file));
    }
    const script =
      'const fs = require("node:fs");' +
      "const fd = fs.openSync(process.argv[1], \"r\");" +
      "try {" +
      'const buf = Buffer.alloc(Number(process.argv[3]));' +
      "const n = fs.readSync(fd, buf, 0, buf.length, Number(process.argv[2]));" +
      "process.stdout.write(buf.subarray(0, n).toString(\"base64\"));" +
      "} finally { fs.closeSync(fd); }";
    const r = await this.env._execArgv([
      "node", "-e", script, this.file, String(offset), String(length),
    ]);
    if (r.exitCode !== 0) return err(this.env._readError(this.file, r));
    return ok(new Uint8Array(Buffer.from(r.stdout, "base64")));
  }

  async scanLines(options, context) {
    const r = await this.env._execArgv([
      "node", `${SCAN_DIR}/driver.mjs`, this.file,
      String(options.startLine),
      options.endLine === undefined ? "" : String(options.endLine),
    ]);
    if (r.exitCode !== 0) {
      return err(fileErr("invalid", r.stderr || `scan failed: ${this.file}`, this.file));
    }
    try {
      return ok(JSON.parse(r.stdout));
    } catch {
      return err(fileErr("unknown", `unparsable scan output: ${this.file}`, this.file));
    }
  }

  async close(_context) {
    // No file descriptor is held between calls; each read opens and closes.
    return Promise.resolve();
  }
}

class DockerTextLineReader {
  constructor(lines) {
    this.lines = lines;
    this.i = 0;
  }
  async readLine(_context) {
    if (this.i >= this.lines.length) return ok(undefined);
    const line = this.lines[this.i++];
    return ok({ text: line.text, terminated: line.terminated });
  }
  async close(_context) {
    this.lines = [];
    return Promise.resolve();
  }
}

/** Implements pi-durable's ExecutionEnv (dist/env/index.d.ts) over docker exec. */
export class DockerExecutionEnv {
  /** Container name; equal ids see the same files, as the interface requires. */
  id;
  cwd;

  constructor({ container, cwd = "/workspace", dockerBin = "docker" }) {
    this.id = container;
    this.cwd = cwd;
    this._scanReady = false;
    this.dockerBin = dockerBin;
  }

  /** Run docker with argv (no shell). Resolves {exitCode, stdout, stderr}. */
  _docker(args, { input, onOutput, timeoutMs } = {}) {
    return new Promise((resolve) => {
      const child = spawn(this.dockerBin, args, { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let errText = "";
      let done = false;
      // Each stream decodes separately, so a character split across chunks
      // survives. onOutput gets the stream it came from; a throwing callback
      // is logged, never propagated: the socket handler cannot crash the
      // gateway.
      const decoders = {
        stdout: new StringDecoder("utf8"),
        stderr: new StringDecoder("utf8"),
      };
      const emit = (buffer, stream) => {
        const text = decoders[stream].write(buffer);
        if (!text) return;
        if (stream === "stdout") out += text;
        else errText += text;
        if (!onOutput) return;
        try {
          onOutput(text, stream);
        } catch (cbErr) {
          console.error(
            "[docker-env] onOutput callback failed:",
            cbErr && cbErr.message ? cbErr.message : String(cbErr)
          );
        }
      };
      const finish = (exitCode) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ exitCode, stdout: out, stderr: errText });
      };
      const timer = timeoutMs
        ? setTimeout(() => {
            child.kill("SIGKILL");
            finish(-1);
          }, timeoutMs)
        : null;
      child.stdout.on("data", (buffer) => emit(buffer, "stdout"));
      child.stderr.on("data", (buffer) => emit(buffer, "stderr"));
      child.on("exit", (code) => finish(code ?? -1));
      child.on("error", (e) => {
        errText += String(e);
        finish(-1);
      });
      if (input !== undefined) {
        child.stdin.on("error", () => {});
        child.stdin.end(input);
      } else {
        child.stdin.end();
      }
    });
  }

  /** exec-ish helper: docker exec [flags] <container> <argv...> */
  async _execArgv(argv, { input, timeoutMs } = {}) {
    return this._docker(
      ["exec", ...(input !== undefined ? ["-i"] : []), this.id, ...argv],
      { input, timeoutMs }
    );
  }

  async _sh(script, args, { input, timeoutMs } = {}) {
    // sh -c 'script "$@"' sh arg1 arg2 — script sees args as $1..$n.
    return this._execArgv(["sh", "-c", script, "sh", ...args], { input, timeoutMs });
  }

  absolutePath(p, _context) {
    return Promise.resolve(ok(path.resolve(this.cwd, p)));
  }

  joinPath(parts, _context) {
    return Promise.resolve(ok(path.posix.join(...parts)));
  }

  async exec(command, options, context) {
    const opts = options ?? {};
    const argv = ["exec"];
    if (opts.cwd) argv.push("-w", opts.cwd);
    for (const [k, v] of Object.entries(opts.env ?? {})) argv.push("-e", `${k}=${v}`);
    argv.push(this.id);
    // In-container timeout keeps runaway commands from outliving the tool call.
    const secs = opts.timeout ? Math.max(1, Math.ceil(opts.timeout / 1000)) : 3600;
    argv.push("timeout", "-k", "1", String(secs), "bash", "-c", command);
    const result = await this._docker(argv, {
      // pi-durable's Shell contract: onOutput(text, context, info) with
      // info = { stream }. `skipped` is only sent when a window omits output;
      // we transfer everything, so it stays undefined.
      onOutput: (text, stream) => opts.onOutput?.(text, context, { stream }),
    });
    if (result.exitCode === -1) {
      return err(
        new ExecutionError("timeout", `command timed out after ${secs}s: ${command.slice(0, 120)}`)
      );
    }
    if (result.exitCode === 127) {
      return err(new ExecutionError("shell_unavailable", result.stderr || "command not found"));
    }
    return ok({ exitCode: result.exitCode });
  }

  async readTextFile(p, _context) {
    const r = await this._execArgv(["cat", "--", p]);
    if (r.exitCode !== 0) return err(this._readError(p, r));
    return ok(r.stdout);
  }

  _readError(p, r) {
    if (/No such file/i.test(r.stderr)) {
      return fileErr("not_found", `file not found: ${p}`, p);
    }
    if (/Is a directory/i.test(r.stderr)) {
      return fileErr("is_directory", `is a directory: ${p}`, p);
    }
    if (/Permission denied/i.test(r.stderr)) {
      return fileErr("permission_denied", `permission denied: ${p}`, p);
    }
    return fileErr("unknown", r.stderr || `read failed: ${p}`, p);
  }

  async readTextLines(p, options, _context) {
    const r = await this.readTextFile(p, _context);
    if (!r.ok) return r;
    let lines = r.value.split("\n").map((text, i, arr) => ({
      text,
      terminated: i < arr.length - 1 || r.value.endsWith("\n"),
    }));
    if (lines.length > 0 && lines[lines.length - 1].text === "" && lines[lines.length - 1].terminated === false) {
      lines = lines.slice(0, -1);
    }
    const max = options?.maxLines;
    if (max !== undefined && lines.length > max) lines = lines.slice(0, max);
    return ok(lines.map((l) => l.text));
  }

  async openTextLineReader(p, context) {
    const r = await this.readTextFile(p, context);
    if (!r.ok) return r;
    const lines = r.value.split("\n").map((text, i, arr) => ({
      text,
      terminated: i < arr.length - 1 || r.value.endsWith("\n"),
    }));
    if (lines.length > 1 && lines[lines.length - 1].text === "" && !lines[lines.length - 1].terminated) {
      lines.pop();
    }
    return ok(new DockerTextLineReader(lines));
  }

  async readBinaryFile(p, _context) {
    const r = await this._execArgv(["base64", "-w", "0", "--", p]);
    if (r.exitCode !== 0) return err(this._readError(p, r));
    return ok(new Uint8Array(Buffer.from(r.stdout, "base64")));
  }

  /** Write the LineScanner driver into the container, once per container. */
  async _ensureScanScripts() {
    if (this._scanReady) return;
    const src = lineScanSources();
    for (const [name, content] of [
      ["decode.js", src.decode],
      ["line-scan.js", src.lineScan],
      ["driver.mjs", src.driver],
    ]) {
      const r = await this._execArgv(
        ["sh", "-c", `mkdir -p '${SCAN_DIR}' && cat > '${SCAN_DIR}/${name}'`, "sh"],
        { input: content }
      );
      if (r.exitCode !== 0) {
        throw new Error(`writing scan scripts to ${this.id} failed: ${r.stderr}`);
      }
    }
    this._scanReady = true;
  }

  async openBinaryReader(p, options, context) {
    const info = await this.fileInfo(p, context);
    if (!info.ok) return info;
    if (info.value.kind === "directory") {
      return err(fileErr("is_directory", `is a directory: ${p}`, p));
    }
    if (info.value.kind !== "file") {
      return err(fileErr("invalid", `not a regular file: ${p}`, p));
    }
    if (options?.noFollow === true) {
      const link = await this._execArgv(["test", "-L", p]);
      if (link.exitCode === 0) {
        return err(fileErr("invalid", `not a regular file: ${p}`, p));
      }
    }
    await this._ensureScanScripts();
    return ok(new DockerBinaryReader(this, p));
  }

  async writeFile(p, content, _context) {
    const r = await this._sh('mkdir -p "$(dirname "$1")" && cat > "$1"', [p], {
      input: Buffer.from(content),
    });
    if (r.exitCode !== 0) return err(fileErr("unknown", `write failed: ${p}`, p));
    return ok(undefined);
  }

  async appendFile(p, content, _context) {
    const r = await this._sh('cat >> "$1"', [p], { input: Buffer.from(content) });
    if (r.exitCode !== 0) return err(fileErr("unknown", `append failed: ${p}`, p));
    return ok(undefined);
  }

  async truncateFile(p, size, _context) {
    const r = await this._sh('mkdir -p "$(dirname "$1")" && truncate -s "$2" "$1"', [p, String(size)]);
    if (r.exitCode !== 0) return err(fileErr("unknown", `truncate failed: ${p}`, p));
    return ok(undefined);
  }

  async flushFile(_p, _context) {
    return ok(undefined); // Bind-mounted volume; container page cache is fine here.
  }

  async renameFile(from, to, _context) {
    const r = await this._sh('mkdir -p "$(dirname "$2")" && mv "$1" "$2"', [from, to]);
    if (r.exitCode !== 0) return err(fileErr("unknown", `rename failed: ${from} -> ${to}`, from));
    return ok(undefined);
  }

  async fileInfo(p, _context) {
    const r = await this._execArgv(["stat", "-c", "%F|%s|%Y|%n", "--", p]);
    if (r.exitCode !== 0) return err(this._readError(p, r));
    const [kind, size, mtime, ...rest] = r.stdout.trim().split("|");
    const name = rest.join("|") || p;
    return ok({
      name: path.posix.basename(name),
      path: name,
      kind: this._fileKind(kind),
      size: Number(size),
      mtimeMs: Number(mtime) * 1000,
    });
  }

  _fileKind(statKind) {
    if (statKind === "directory") return "directory";
    if (statKind === "symbolic link") return "symlink";
    return "file";
  }

  async listDir(p, _context) {
    const r = await this._sh(
      'for f in "$1"/* "$1"/.*; do [ -e "$f" ] || continue; case "$(basename "$f")" in .|..) continue;; esac; stat -c "%F|%s|%Y|%n" "$f"; done',
      [p]
    );
    if (r.exitCode !== 0) return err(this._readError(p, r));
    const items = r.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [kind, size, mtime, ...rest] = line.split("|");
        const full = rest.join("|");
        return {
          name: path.posix.basename(full),
          path: full,
          kind: this._fileKind(kind),
          size: Number(size),
          mtimeMs: Number(mtime) * 1000,
        };
      });
    return ok(items);
  }

  async canonicalPath(p, _context) {
    const r = await this._execArgv(["realpath", "-m", "--", p]);
    if (r.exitCode !== 0) return err(fileErr("unknown", `realpath failed: ${p}`, p));
    return ok(r.stdout.trim());
  }

  async exists(p, _context) {
    const r = await this._execArgv(["test", "-e", "--", p]);
    return ok(r.exitCode === 0);
  }

  async createDir(p, options, _context) {
    const recursive = options?.recursive !== false;
    const r = await this._sh(recursive ? 'mkdir -p "$1"' : 'mkdir "$1"', [p]);
    if (r.exitCode !== 0) return err(fileErr("unknown", `mkdir failed: ${p}`, p));
    return ok(undefined);
  }

  async remove(p, options, _context) {
    const flags = options?.recursive ? "-rf" : "-f";
    const r = await this._sh(`rm ${flags} "$1"`, [p]);
    if (r.exitCode !== 0) return err(fileErr("unknown", `remove failed: ${p}`, p));
    return ok(undefined);
  }

  async createTempDir(prefix, _context) {
    const r = await this._sh('mktemp -d "${1:-/tmp/tmp}.XXXXXX"', [prefix]);
    if (r.exitCode !== 0) return err(fileErr("unknown", "mktemp -d failed"));
    return ok(r.stdout.trim());
  }

  async createTempFile(options, _context) {
    const suffix = options?.suffix ?? "";
    const prefix = options?.prefix ?? "tmp";
    const r = await this._sh(`mktemp "\${1:-/tmp}/${prefix}.XXXXXX${suffix.replace(/"/g, "")}"`, []);
    if (r.exitCode !== 0) return err(fileErr("unknown", "mktemp failed"));
    return ok(r.stdout.trim());
  }

  async cleanup(_context) {
    return Promise.resolve();
  }
}
