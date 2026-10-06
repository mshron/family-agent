// Runtime channel provisioning. When the bot is invited to a stream (or
// discovers one at boot), give it a workspace copied from the skeleton and
// an empty channel skills directory. The workspaces and skills mounts must
// be writable by the gateway container (see docker-compose.yml).

import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("exit", (code) => resolve({ code, stderr }));
    child.on("error", (e) => resolve({ code: -1, stderr: String(e) }));
  });
}

/**
 * Idempotent: existing workspaces are left untouched, so a boot-time sweep
 * and an invite event can both call this safely.
 */
export async function provisionStream(env, stream, log) {
  const ws = path.join(env.WORKSPACES_DIR, stream);
  if (!existsSync(ws)) {
    const skeleton = env.WORKSPACE_SKELETON_DIR;
    if (skeleton && existsSync(skeleton)) {
      await cp(skeleton, ws, { recursive: true });
      await run("git", ["init", "-q"], ws);
      await run("git", ["add", "-A"], ws);
      await run(
        "git",
        [
          "-c", "user.name=family-agent gateway",
          "-c", "user.email=gateway@family-agent.local",
          "commit", "-qm", `Initial workspace from skeleton (${stream})`,
        ],
        ws
      );
      log.info(`workspace provisioned from skeleton: ${ws}`);
    } else {
      await mkdir(ws, { recursive: true });
      log.warn(`workspace created empty (no skeleton at ${skeleton}): ${ws}`);
    }
  }
  await mkdir(path.join(env.SKILLS_DIR, stream), { recursive: true });
}