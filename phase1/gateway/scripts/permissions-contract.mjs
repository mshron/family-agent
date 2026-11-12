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

// --- path rules (the memory gate) ------------------------------------------

{
  const memoryRules = new PermissionRules({
    paths: {
      write: { "memory/*": "ask", "memory/channels/*": "deny" }, // last wins
      edit: { "memory/*": "ask" },
    },
  });
  assert.deepEqual(
    memoryRules.classifyCall({ name: "write", arguments: { path: "memory/user.md" } }),
    { decision: "ask", rule: "memory/*" }
  );
  assert.deepEqual(
    memoryRules.classifyCall({ name: "edit", arguments: { path: "memory/user.md" } }),
    { decision: "ask", rule: "memory/*" }
  );
  assert.deepEqual(
    memoryRules.classifyCall({
      name: "write",
      arguments: { path: "memory/channels/scratch.md" },
    }),
    { decision: "deny", rule: "memory/channels/*" }
  );
  assert.deepEqual(
    memoryRules.classifyCall({ name: "write", arguments: { path: "notes/x.md" } }),
    { decision: "allow", rule: null }
  );
  assert.deepEqual(
    memoryRules.classifyCall({ name: "write", arguments: {} }),
    { decision: "allow", rule: null }
  );
  // a path rule does not shadow an unrelated tool rule: read stays free
  assert.deepEqual(
    memoryRules.classifyCall({ name: "read", arguments: { path: "memory/user.md" } }),
    { decision: "allow", rule: null }
  );
  ok("path rules: memory writes ask, deeper rule wins, other paths allow");
}
{
  const merged = mergePermissionConfig(
    { paths: { write: { "memory/*": "ask" } } },
    { paths: { write: { "memory/drafts/*": "allow" } } }
  );
  assert.equal(merged.paths.write["memory/*"], "ask");
  assert.equal(merged.paths.write["memory/drafts/*"], "allow");
  ok("merge: channel path rules overlay global ones");
}

// --- channel config (tools, dm fallback, people) ----------------------------

{
  const { ChannelConfig } = await import("../lib/channels.js");
  const config = new ChannelConfig({
    streams: ["scratch", "meta"],
    permissions: { tools: { email_send: "ask", browser_pay: "ask" } },
    channels: {
      meta: { add: ["push_changes"] },
      dm: { permissions: { tools: { push_changes: "deny" } } },
      "dm-1-2": {},
    },
    people: { "a@example.com": { workStream: "a-work" } },
  });
  // DMs get run_task on top of the standard set; streams do not
  assert.equal(config.toolsFor("dm-1").includes("run_task"), true);
  assert.equal(config.toolsFor("dm-1").includes("push_changes"), false);
  assert.equal(config.toolsFor("meta").includes("run_task"), false);
  assert.equal(config.toolsFor("meta").includes("push_changes"), true);
  // the shared dm block configures every dm channel; a specific dm channel
  // can still override it
  assert.equal(config.permissionConfigFor("dm-7").tools.push_changes, "deny");
  assert.equal(config.permissionConfigFor("dm-1-2").tools.push_changes, "deny");
  assert.deepEqual(
    config.permissionConfigFor("scratch").tools.push_changes,
    undefined
  );
  assert.equal(config.people["a@example.com"].workStream, "a-work");
  // The skills loop (dm-first memo, step 5) ships in every tool set, with
  // post-hoc consent: no ask rule gates it (autonomy, 12 Nov review)
  assert.equal(config.toolsFor("dm-1").includes("save_skill"), true);
  assert.equal(config.toolsFor("scratch").includes("delete_skill"), true);
  assert.equal(config.toolsFor("scratch").includes("memory_search"), true);
  const rules = new PermissionRules(config.permissionConfigFor("dm-1"));
  assert.equal(rules.classifyTool("save_skill").decision, "allow");
  assert.equal(rules.classifyTool("delete_skill").decision, "allow");
  // Memory writes ungated too (12 Nov review, second pass): recall goes
  // through memory_search, consent through the reply text.
  assert.equal(rules.classifyPaths("write", "memory/user.md").decision, "allow");
  assert.equal(rules.classifyPaths("edit", "memory/x.md").decision, "allow");
  // Email (Phase 3): reads are free, every outbound send waits for a
  // human — the capability-channel policy from phase2-hardening.md.
  assert.equal(config.toolsFor("dm-1").includes("email_search"), true);
  assert.equal(config.toolsFor("scratch").includes("email_send"), true);
  assert.equal(rules.classifyTool("email_search").decision, "allow");
  assert.equal(rules.classifyTool("email_get_body").decision, "allow");
  assert.equal(rules.classifyTool("email_send").decision, "ask");
  // The vault browser (13 Nov): browsing and card fills are free; the
  // purchase click is the money action — every one waits for a human.
  assert.equal(config.toolsFor("dm-1").includes("browser"), true);
  assert.equal(config.toolsFor("scratch").includes("fill_card"), true);
  assert.equal(rules.classifyTool("browser").decision, "allow");
  assert.equal(rules.classifyTool("fill_card").decision, "allow");
  assert.equal(rules.classifyTool("browser_pay").decision, "ask");
  ok("channel config: dm tool set, dm permission fallback, people entries, skills and memory ungated, email_send + browser_pay ask-gated");
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
  // events below carry the fields live Zulip events carry: names and
  // codepoints captured from the real approval reactions of 13/20 Oct
  const ignored = await p.handleReactionEvent({
    op: "add", message_id: posted[0].id, user_id: 5,
    emoji_name: "check", emoji_code: "2705", reaction_type: "unicode_emoji",
  });
  assert.equal(ignored, false);
  assert.equal(p.pendingCount(), 1);
  // wrong emoji: ignored
  const ignored2 = await p.handleReactionEvent({
    op: "add", message_id: posted[0].id, user_id: OWNER_ID,
    emoji_name: "eyes", emoji_code: "1f440", reaction_type: "unicode_emoji",
  });
  assert.equal(ignored2, false);
  // reaction removal: ignored
  const ignored3 = await p.handleReactionEvent({
    op: "remove", message_id: posted[0].id, user_id: OWNER_ID,
    emoji_name: "check", emoji_code: "2705", reaction_type: "unicode_emoji",
  });
  assert.equal(ignored3, false);
  // a realm emoji cannot approve, even one whose id is a codepoint
  const realm = await p.handleReactionEvent({
    op: "add", message_id: posted[0].id, user_id: OWNER_ID,
    emoji_name: "check", emoji_code: "2705", reaction_type: "realm_emoji",
  });
  assert.equal(realm, false);
  // owner approves: the live event shape, name "check", codepoint 2705
  const resolved = await p.handleReactionEvent({
    op: "add", message_id: posted[0].id, user_id: OWNER_ID,
    emoji_name: "check", emoji_code: "2705", reaction_type: "unicode_emoji",
  });
  assert.equal(resolved, true);
  assert.equal(p.pendingCount(), 0);
  assert.equal(await decision, undefined); // allowed
  assert.equal(notes[0].includes("approved by max@example.com"), true);
  // audit: ask + approved recorded
  const kinds = auditEvents.filter((e) => e.decision).map((e) => e.decision);
  assert.equal(kinds.includes("ask"), true);
  assert.equal(kinds.includes("approved"), true);
  assert.equal(kinds.includes("ignored-reaction"), true);
  assert.equal(kinds.includes("unmatched-reaction"), true);
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
  await p.handleReactionEvent({
    op: "add", message_id: posted.at(-1).id, user_id: OWNER_ID,
    emoji_name: "x", emoji_code: "274c", reaction_type: "unicode_emoji",
  });
  const result = await decision;
  assert.match(result.block, /denied/);
  ok("ask: deny path blocks the call");
}

{
  // ask rule: "+1" (the owner approval reaction of 13 Oct) approves too
  const p = build();
  const decision = p.extension.hooks[0].handlers.beforeTool(
    { id: "c4b", name: "push_changes", arguments: {} },
    fakeApi(),
    {}
  );
  await new Promise((r) => setTimeout(r, 5));
  await p.handleReactionEvent({
    op: "add", message_id: posted.at(-1).id, user_id: OWNER_ID,
    emoji_name: "+1", emoji_code: "1f44d", reaction_type: "unicode_emoji",
  });
  assert.equal(await decision, undefined);
  ok("ask: the +1 reaction approves");
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
  await p.handleReactionEvent({
    op: "add", message_id: posted.at(-1).id, user_id: OWNER_ID,
    emoji_name: "check", emoji_code: "2705", reaction_type: "unicode_emoji",
  });
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

// --- per-person resolution (dm-first memo, step 5) --------------------------

{
  // A person may resolve asks born in their own conversation; a stranger
  // may not. mayResolve is consulted after isOwner, so owners resolve first.
  const PERSON_ID = 77;
  const p = build({
    mayResolve: async (id, conversationId) =>
      id === PERSON_ID && conversationId === 42 ? "Wife Name" : null,
  });
  const api = fakeApi();
  const decision = p.extension.hooks[0].handlers.beforeTool(
    { id: "c9a", name: "push_changes", arguments: {} },
    api,
    {}
  );
  await new Promise((r) => setTimeout(r, 5));
  const messageId = posted.at(-1).id;
  // a stranger's approval changes nothing
  const stranger = await p.handleReactionEvent({
    op: "add", message_id: messageId, user_id: 55,
    emoji_name: "check", emoji_code: "2705", reaction_type: "unicode_emoji",
  });
  assert.equal(stranger, false);
  assert.equal(p.pendingCount(), 1);
  // the person's approval resolves, credited by name
  const resolved = await p.handleReactionEvent({
    op: "add", message_id: messageId, user_id: PERSON_ID,
    emoji_name: "check", emoji_code: "2705", reaction_type: "unicode_emoji",
  });
  assert.equal(resolved, true);
  assert.equal(await decision, undefined);
  assert.ok(auditEvents.some((e) => e.decision === "approved" && e.by === "Wife Name"));
  assert.ok(notes.some((n) => n.includes("approved by Wife Name")));
  ok("mayResolve: the person approves their own ask; strangers cannot");
}
{
  // The owner resolves by isOwner even when mayResolve declines.
  const p = build({
    mayResolve: async () => null,
  });
  const api = fakeApi();
  const decision = p.extension.hooks[0].handlers.beforeTool(
    { id: "c9b", name: "push_changes", arguments: {} },
    api,
    {}
  );
  await new Promise((r) => setTimeout(r, 5));
  const messageId = posted.at(-1).id;
  const resolved = await p.handleReactionEvent({
    op: "add", message_id: messageId, user_id: OWNER_ID,
    emoji_name: "check", emoji_code: "2705", reaction_type: "unicode_emoji",
  });
  assert.equal(resolved, true);
  assert.equal(await decision, undefined);
  ok("mayResolve: owners still resolve when mayResolve declines");
}

{
  // No auto-deny by default (12 Nov review): the ask waits until someone
  // reacts or the run is stopped. An env-set timeout keeps the old text.
  const p = build({ askTimeoutMs: 0 });
  p.extension.hooks[0].handlers.beforeTool(
    { id: "c9c", name: "push_changes", arguments: {} },
    fakeApi(),
    {}
  );
  await new Promise((r) => setTimeout(r, 5));
  assert.match(posted.at(-1).content, /waits until you do\./);
  assert.doesNotMatch(posted.at(-1).content, /Auto-denied/);
  ok("ask: no timeout means the ask waits for a reaction");
}

{
  // Email scoping (13 Nov): per person, fail closed. Owners default to
  // the system accounts; a people entry overrides; nobody else — a second
  // spouse, a shared channel, an unresolved person — gets any account.
  const { ChannelConfig } = await import("../lib/channels.js");
  const cfg = new ChannelConfig({
    streams: ["scratch"],
    channels: {},
    people: { "w@example.com": { workStream: "w-work", emailAccounts: ["gmail-w"] } },
  });
  assert.deepEqual(cfg.people["w@example.com"].emailAccounts, ["gmail-w"]);

  const { buildZulipTools } = await import("../lib/tools.js");
  const fakeApi = { conversationId: "c1" };
  const toolOf = (ext, name) => ext.tools.find((t) => t.name === name);
  const none = buildZulipTools({ emailAccountsFor: async () => [] });
  const r1 = await toolOf(none, "email_accounts").execute({}, fakeApi, {});
  assert.match(r1.content[0].text, /No email access/);
  const r2 = await toolOf(none, "email_get_body").execute({ account: "fastmail", message_id: "x" }, fakeApi, {});
  assert.match(r2.content[0].text, /No email access/);
  const mine = buildZulipTools({ emailAccountsFor: async () => ["fastmail"] });
  const r3 = await toolOf(mine, "email_search").execute(
    { after: "2026-11-01", account: "gmail" },
    fakeApi,
    {}
  );
  assert.match(r3.content[0].text, /not available/);
  ok("email: person-scoped accounts, fail closed");
}

console.log(`\npermissions contract: ${passed} checks passed`);