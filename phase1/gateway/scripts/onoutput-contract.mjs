// Contract check: pi-durable's bash tool calls onOutput(text, context, info)
// and reads info.skipped (ShellOutputInfo). Run this against any new gateway
// image before upgrading @earendil-works/pi-durable:
//   docker build -t fa-test phase1/gateway
//   docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
//     -v phase1/gateway/scripts/onoutput-contract.mjs:/app/check.mjs:ro \
//     -w /app fa-test node check.mjs
// Prints "LOOP RESULT: ok" and exits 0 when the environment satisfies the
// installed version's contract; a violation prints the stack and exits 1.
import { DockerExecutionEnv } from "/app/lib/docker-env.js";
import { execSync } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const name = "fa-repro-" + Date.now().toString(36);
execSync(
  "docker run -d --rm --name " + name + " -w /workspace family-agent-exec:latest sleep 300"
);
try {
  const env = new DockerExecutionEnv({ container: name, cwd: "/workspace" });
  const result = await env.exec(
    "echo contract-check",
    {
      cwd: "/workspace",
      onOutput: (text, _context, info) => { void info.skipped; },
    },
    BACKGROUND_CONTEXT
  );
  console.log("LOOP RESULT:", result.ok ? "ok, exit " + result.value.exitCode : "exec error");
  process.exit(0);
} finally {
  execSync("docker rm -f " + name);
}
