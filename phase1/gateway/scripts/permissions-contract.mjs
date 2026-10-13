// Permission-layer contract check. Run from phase1/gateway:
//   node scripts/permissions-contract.mjs
// No network, no docker, no Zulip: everything is injected fakes. This is the
// pre-deploy gate for Phase 2's permission machinery, in the spirit of
// onoutput-contract.mjs (the 11 Oct lesson: never deploy self-modification
// without a runnable check).

import assert from "node:assert/strict";
import {
  PermissionRules,
  buildPermissionsExtension,
  mergePermissionConfig,
  patternToRegExp,
} from "../lib/permissions.js";

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok - ${name}`);
}

// --- pattern matching -------------------------------------------------------

{
  // Standard glob semantics: `*` matches any run of characters, including
  // glued text ("git push*" matches "git pushx"). Rules must be written
  // with that in mind; the shipped deny patterns are exact.
  const re = patternToRegExp("git push*");
  assert.ok(re.test("git push"));
  assert.ok(re.test("git push origin main"));
  assert.ok(re.test("git pushx"));
  assert.ok(!re.test("echo git push"));
  assert.ok(!re.test("gitpush"));
  ok("wildcard patterns anchor both ends, * matches anything");
}
{
  const re = patternToRegExp("rm -rf /*");
  assert.ok(re.test("rm -rf /"));
  assert.ok(re.test("rm -rf /workspace/junk"));
  assert.ok(!re.test("rm -rf build"));
  assert.ok(!re.test("rm -rf  /workspace")); // two spaces: no match (exact prefix)
  ok("rm -rf /* matches absolute paths only");
}

// --- rules ------------------------------------------------------------------

const rules = new PermissionRules({
  tools: { push_changes: "ask" },
  bash: {
    "rm -rf /*": "deny",
    "git push*": "ask",
    "git push --force*": "deny", // last matching rule wins
  },
});

{
  assert.deepEqual(rules.classifyTool("push_changes"), { decision: "ask", rule: "push_changes" });
  assert.deepEqual(rules.classifyTool("bash"), { decision: "allow", rule: null });
  assert.deepEqual(rules.classifyTool("read"), { decision: "allow", rule: null });
  ok("tool rules: exact match, unmatched default allow");
}
{
  assert.deepEqual(rules.classifyBash("git push"), { decision: "ask", rule: "git push*" });
  assert.deepEqual(rules.classifyBash("git push --force origin main"), {
    decision: "deny",
    rule: "git push --force*",
  });
  assert.deepEqual(rules.classifyBash("ls -la"), { decision: "allow", rule: null });
  assert.deepEqual(rules.classifyBash("rm -rf /"), { decision: "deny", rule: "rm -rf /*" });
  assert.deepEqual(rules.classifyBash("rm -rf node_modules"), { decision: "allow", rule: null });
  ok("bash rules: last match wins, unmatched default allow");
}
{
  assert.deepEqual(rules.classifyCall({ name: "bash", arguments: { command: "rm -rf /tmp" } }), {
    decision: "deny",
    rule: "rm -rf /*",
  });
  assert.deepEqual(rules.classifyCall({ name: "write", arguments: { path: "x" } }), {
    decision: "allow",
    rule: null,
  });
  ok("classifyCall routes bash by command, others by name");
}

// --- config merge -----------------------------------------------------------

{
  const merged = mergePermissionConfig(
    { tools: { a: "deny" }, bash: { "x *": "deny" } },
    { tools: { a: "ask" }, bash: { "y *": "ask" } }
  );
  assert.equal(merged.tools.a, "ask"); // channel overrides
  assert.equal(merged.tools.b, undefined);
  assert.equal(merged.bash["x *"], "deny"); // global kept
  assert.equal(merged.bash["y *"], "ask");
  ok("merge: channel overrides global per key, other keys keep both");
}

// --- the ask flow ------------------------------------------------------------

const OWNER_ID = 99;
const auditEvents = [];
const audit = { record: (kind, fields) => auditEvents.push({ kind, ...fields }) };
const posted = [];
const notes = [];

function build(overrides = {}) {
  let nextId = 1;
  const memos = new Map();
  return buildPermissionsExtension({
    rulesFor: () => rules,
    audit,
    isOwner: async (id) => (id === OWNER_ID ? "max@example.com" : null),
    post: async (_conversationId, content) => {
      const id = nextId++;
      posted.push({ id, content });
      return id;
    },
    noteDecision: async (_conversationId, text) => {
      notes.push(text);
    },
    askTimeoutMs: 80,
    ...overrides,
  });
}

function fakeApi({ stream = "meta", memos } = {}) {
  const store = memos ?? new Map();
  return {
    conversationId: 42,
    snapshot: async () => ({ stream }),
    memo: async (key, candidateOrContext, maybeContext) => {
      if (maybeContext === undefined) return store.get(key);
      if (!store.has(key)) store.set(key, candidateOrContext);
      return store.get(key);
    },
  };
}

{
  // deny rule: blocked immediately, no approval surface touched
  const p = build();
  const result = await p.extension.hooks[0].handlers.beforeTool(
    { id: "c1", name: "bash", arguments: { command: "rm -rf /" } },
    fakeApi(),
    {}
  );
  assert.equal(result.block.includes("Blocked by a permission rule"), true);
  assert.equal(posted.length, 0);
  assert.equal(p.pendingCount(), 0);
  ok("deny blocks without posting an ask");
}

{
  // allow rule: straight through
  const p = build();
  const result = await p.extension.hooks[0].handlers.beforeTool(
    { id: "c2", name: "read", arguments: { path: "notes/x.md" } },
    fakeApi(),
    {}
  );
  assert.equal(result, undefined);
  ok("allow passes through");
}

{
  // ask rule: posts once, owner approves by reaction
  const p = build();
  const api = fakeApi();
  const decision = p.extension.hooks[0].handlers.beforeTool(
    { id: "c3", name: "push_changes", arguments: {} },
    api,
    {}
  );
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(posted.length, 1);
  assert.equal(p.pendingCount(), 1);
  assert.match(posted[0].content, /needs approval/);
  assert.match(posted[0].content, /Auto-denied/);
  // non-owner approve reaction: ignored, ask stays live
  const ignored = await p.handleReactionEvent({ op: "add", message_id: posted[0].id, user_id: 5, emoji_name: "check_mark" });
  assert.equal(ignored, false);
  assert.equal(p.pendingCount(), 1);
  // wrong emoji: ignored
  const ignored2 = await p.handleReactionEvent({ op: "add", message_id: posted[0].id, user_id: OWNER_ID, emoji_name: "eyes" });
  assert.equal(ignored2, false);
  // reaction removal: ignored
  const ignored3 = await p.handleReactionEvent({ op: "remove", message_id: posted[0].id, user_id: OWNER_ID, emoji_name: "check_mark" });
  assert.equal(ignored3, false);
  // owner approves
  const resolved = await p.handleReactionEvent({ op: "add", message_id: posted[0].id, user_id: OWNER_ID, emoji_name: "check_mark" });
  assert.equal(resolved, true);
  assert.equal(p.pendingCount(), 0);
  assert.equal(await decision, undefined); // allowed
  assert.equal(notes[0].includes("approved by max@example.com"), true);
  // audit: ask + approved recorded
  const kinds = auditEvents.filter((e) => e.decision).map((e) => e.decision);
  assert.equal(kinds.includes("ask"), true);
  assert.equal(kinds.includes("approved"), true);
  assert.equal(kinds.includes("ignored-reaction"), true);
  ok("ask: approve path with owner check, wrong-emoji and non-owner ignored");
}

{
  // ask rule: owner denies
  const p = build();
  const decision = p.extension.hooks[0].handlers.beforeTool(
    { id: "c4", name: "push_changes", arguments: {} },
    fakeApi(),
    {}
  );
  await new Promise((r) => setTimeout(r, 5));
  await p.handleReactionEvent({ op: "add", message_id: posted.at(-1).id, user_id: OWNER_ID, emoji_name: "cross_mark" });
  const result = await decision;
  assert.match(result.block, /denied/);
  ok("ask: deny path blocks the call");
}

{
  // ask rule: timeout auto-denies
  const p = build();
  const decision = p.extension.hooks[0].handlers.beforeTool(
    { id: "c5", name: "push_changes", arguments: {} },
    fakeApi(),
    {}
  );
  const result = await decision; // 80 ms timeout
  assert.match(result.block, /No approval arrived/);
  assert.equal(p.pendingCount(), 0);
  ok("ask: timeout blocks the call and clears the pending entry");
}

{
  // ask rule: /stop's abort signal cancels the wait
  const p = build();
  const controller = new AbortController();
  const decision = p.extension.hooks[0].handlers.beforeTool(
    { id: "c6", name: "push_changes", arguments: {} },
    fakeApi(),
    { abortSignal: controller.signal }
  );
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  const result = await decision;
  assert.match(result.block, /stopped before approval/);
  ok("ask: abort cancels the wait");
}

{
  // ask rule: a failure to post the approval request blocks (no surface, no consent)
  const p = build({ post: async () => { throw new Error("Zulip down"); } });
  const result = await p.extension.hooks[0].handlers.beforeTool(
    { id: "c7", name: "push_changes", arguments: {} },
    fakeApi(),
    {}
  );
  assert.match(result.block, /could not be posted/);
  ok("ask: posting failure blocks the call");
}

{
  // classifier failure fails open (availability: a bug must not brick sessions)
  const p = build();
  const result = await p.extension.hooks[0].handlers.beforeTool(
    { id: "c8", name: "bash", arguments: { command: "ls" } },
    { snapshot: async () => { throw new Error("doc read failed"); }, memo: async () => {} },
    {}
  );
  assert.equal(result, undefined);
  assert.equal(auditEvents.some((e) => e.kind === "permission-error"), true);
  ok("classifier failure fails open and is audited");
}

{
  // restart-rerun tolerance: the durable memo makes the second run reuse the
  // first approval message instead of posting a duplicate
  const p = build();
  const memos = new Map();
  const api1 = fakeApi({ memos });
  const d1 = p.extension.hooks[0].handlers.beforeTool({ id: "c9", name: "push_changes", arguments: {} }, api1, {});
  await new Promise((r) => setTimeout(r, 5));
  const countAfterFirst = posted.length;
  // same call id, fresh api but the same memo store: no new message
  const api2 = fakeApi({ memos });
  const d2 = p.extension.hooks[0].handlers.beforeTool({ id: "c9", name: "push_changes", arguments: {} }, api2, {});
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(posted.length, countAfterFirst);
  // the original ask still resolves both waits
  await p.handleReactionEvent({ op: "add", message_id: posted.at(-1).id, user_id: OWNER_ID, emoji_name: "check_mark" });
  assert.equal(await d1, undefined);
  assert.equal(await d2, undefined);
  ok("ask: a rerun reuses the memoed approval message and one reaction resolves it");
}

{
  // afterTool audits the result and never changes it
  const p = build();
  const result = { isError: true, content: [] };
  const out = p.extension.hooks[0].handlers.afterTool({ id: "c10", name: "bash", arguments: {} }, result, fakeApi(), {});
  assert.equal(out, undefined);
  assert.equal(auditEvents.some((e) => e.kind === "tool_result" && e.error === true), true);
  ok("afterTool audits without altering the result");
}

console.log(`\npermissions contract: ${passed} checks passed`);