// Permission-layer harness smoke test: the real pi-durable Harness, a real
// tool, and the real permissions extension, against a fake OpenAI-completions
// server on localhost. Run from phase1/gateway:
//   node scripts/permissions-smoke.mjs
//
// Proves what the contract test cannot: that beforeTool actually intercepts
// tool calls inside the harness, that a blocked call's message reaches the
// model as a tool result, and that the ask flow drives a real run to
// completion from a reaction event.

import assert from "node:assert/strict";
import http from "node:http";
import { Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createRegistry, defineTool, defineExtension } from "@earendil-works/pi-durable";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { contentText } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { ZulipDoc } from "../lib/docs.js";
import { buildPermissionsExtension, PermissionRules } from "../lib/permissions.js";

process.env.FAKE_KEY = "test-key";

// --- fake OpenAI-completions server ----------------------------------------

const requests = []; // every request body, for assertions

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    requests.push(parsed);
    const messages = parsed.messages ?? [];
    const sawBlock = messages.some(
      (m) => typeof m.content === "string" && m.content.includes("Blocked by a permission rule")
    );
    const sawRun = messages.some(
      (m) => typeof m.content === "string" && m.content.includes("RAN-OK")
    );
    const chunks = [];
    const base = { id: "1", object: "chat.completion.chunk", created: 0, model: "fake-model" };
    if (sawBlock) {
      chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "BLOCKED-SEEN" }, finish_reason: null }] });
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    } else if (sawRun) {
      chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "RAN-SEEN" }, finish_reason: null }] });
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    } else {
      // first turn: call the tool
      chunks.push({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "risky", arguments: "" } },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      chunks.push({
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: null }],
      });
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// --- models, tool, permissions ---------------------------------------------

const models = createModels();
models.setProvider(
  createProvider({
    id: "fake",
    name: "Fake",
    baseUrl: `http://127.0.0.1:${port}`,
    auth: { apiKey: envApiKeyAuth("Fake", ["FAKE_KEY"]) },
    api: openAICompletionsApi(),
    models: [
      {
        id: "fake-model",
        provider: "fake",
        baseUrl: `http://127.0.0.1:${port}`,
        name: "Fake Model",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        contextWindow: 100000,
        maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  })
);

const riskyTool = defineTool({
  name: "risky",
  description: "A test tool the permission layer gates.",
  parameters: { type: "object", properties: {} },
  replay: "safe",
  async execute() {
    return { content: [{ type: "text", text: "RAN-OK" }] };
  },
});

const rulesByChannel = new Map(
  [
    ["deny-ch", new PermissionRules({ tools: { risky: "deny" } })],
    ["allow-ch", new PermissionRules({})],
    ["ask-ch", new PermissionRules({ tools: { risky: "ask" } })],
  ].map(([c, r]) => [c, new PermissionRules({ tools: r.tools })])
);
// (PermissionRules instances are cheap; rebuild to keep the shape obvious)
rulesByChannel.set("deny-ch", new PermissionRules({ tools: { risky: "deny" } }));
rulesByChannel.set("allow-ch", new PermissionRules({}));
rulesByChannel.set("ask-ch", new PermissionRules({ tools: { risky: "ask" } }));

const auditEvents = [];
const posted = [];
let nextAskId = 500;
const permissions = buildPermissionsExtension({
  rulesFor: (channel) => rulesByChannel.get(channel) ?? null,
  audit: { record: (kind, fields) => auditEvents.push({ kind, ...fields }) },
  isOwner: async (id) => (id === 1 ? "max@example.com" : null),
  post: async (_conversationId, content) => {
    const id = nextAskId++;
    posted.push({ id, content });
    return id;
  },
  noteDecision: async () => {},
  describe: async () => "",
  askTimeoutMs: 5000,
});

const registry = createRegistry();
registry.install(defineExtension({ name: "test-tools", tools: [riskyTool] }));
registry.install(permissions.extension);

const context = BACKGROUND_CONTEXT;
const harness = await Harness.open(new MemoryStorage(), {
  models,
  registry,
  conversationCreated: async (tx, conversation) => {
    await tx.doc(ZulipDoc, conversation.id);
  },
  onReport: (e) => console.error("harness report:", JSON.stringify(e).slice(0, 300)),
}, context);

async function runScenario(stream) {
  const created = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: {
        model: { provider: "fake", modelId: "fake-model" },
        thinkingLevel: "low",
        instructions: "test",
        tools: [riskyTool],
      },
      init: async (tx, id) => {
        const doc = await tx.doc(ZulipDoc, id);
        doc.stream = stream;
        doc.topic = "smoke";
      },
    },
    context
  );
  const submission = await created.submit(
    { type: "input", content: "go", requestId: `smoke:${stream}` },
    context
  );
  const settled = await submission.wait(context);
  assert.equal(settled.status, "done", `scenario ${stream} settled: ${JSON.stringify(settled)}`);
  const page = await created.entries(
    { minEntryId: settled.answer, maxEntryId: settled.answer },
    1,
    undefined,
    context
  );
  const message = page.items[0]?.model?.[0];
  return contentText(message?.content ?? []).trim();
}

// --- scenarios ---------------------------------------------------------------

assert.equal(await runScenario("deny-ch"), "BLOCKED-SEEN");
console.log("  ok - deny: the harness blocked the call and the model saw the refusal");

assert.equal(await runScenario("allow-ch"), "RAN-SEEN");
console.log("  ok - allow: the tool ran and the model saw its result");

{
  const answerPromise = runScenario("ask-ch");
  // The run now waits on the posted approval message; resolve it.
  for (let i = 0; i < 100 && permissions.pendingCount() === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(permissions.pendingCount(), 1, "the ask registered a pending waiter");
  assert.match(posted.at(-1).content, /needs approval/);
  await permissions.handleReactionEvent({
    op: "add",
    message_id: posted.at(-1).id,
    user_id: 1,
    emoji_name: "check_mark",
  });
  assert.equal(await answerPromise, "RAN-SEEN");
  const decisions = auditEvents.filter((e) => e.decision).map((e) => e.decision);
  assert.equal(decisions.includes("ask"), true);
  assert.equal(decisions.includes("approved"), true);
  console.log("  ok - ask: the run waited for the approval reaction, then completed");
}

await harness.close(context);
server.close();
console.log("\npermissions smoke: 3 scenarios passed");