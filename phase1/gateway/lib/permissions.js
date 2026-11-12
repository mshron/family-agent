// Gateway-native permission layer (Phase 2).
//
// Deterministic allow/ask/deny rules per channel over every tool call, plus
// the human approval flow for "ask": the ask posts into the conversation's
// Zulip topic, the owner reacts (check_mark / cross_mark), and the pending
// tool call resolves from the reaction event — a control path the session
// cannot write. Sessions hold no Zulip credentials and never see reaction
// events, so an approval cannot be forged from inside a conversation.
//
// Why gateway-native: the memo's candidate package
// (@gotgenes/pi-permission-system) targets pi's session/UI extension API,
// which does not fit pi-durable's harness. pi-durable's tool hooks
// (beforeTool / afterTool on the "pi.tool" task) are the seam here; the
// decision is recorded in docs/memos/phase2-hardening.md.
//
// Rule semantics:
//   - "tools": { "<tool-name>": "allow|ask|deny", "*": "..." } — last
//     matching entry wins; unmatched tools are allowed.
//   - "bash": { "<wildcard pattern>": "allow|ask|deny", ... } — patterns use
//     `*` (matches anything, including across words); last matching wins,
//     so put catch-alls first. Unmatched commands are allowed.
//   - "paths": { "<tool-name>": { "<wildcard pattern>": "allow|ask|deny" } }
//     — path-scoped rules for tools that take a `path` argument (write,
//     edit), matched like bash patterns. This is the memory gate: memory
//     files are persistent prompt content, so writes to memory/* ask. A
//     bash write to memory bypasses this surface (a residual gap, noted in
//     the dm-first memo); the gate is tamper-evidence, not a hard boundary.
//   - A per-channel "permissions" block is merged over a top-level global
//     one, surface by surface.
//
// The authorizer judge from the memo (a small model consulted before the
// human on "ask") is deliberately not wired yet: the only ask rule that
// ships is push_changes, where every occurrence should reach a human.
// The seam is `describe` + the ask flow; a judge slots in ahead of `post`
// when bash ask-rules earn their keep.

import { ToolTask, defineExtension, hook } from "@earendil-works/pi-durable";
import { ZulipDoc } from "./docs.js";

// Approve/deny reactions are matched by unicode codepoint (emoji_code,
// stable across Zulip versions) with names as a fallback. Names drift by
// server version: this org names U+2705 "check" and U+1F44D "+1"
// (captured from live approval reactions on 13 and 20 Oct), while the
// first ship matched only "check_mark"/"thumbs_up" — so every real
// approval expired unanswered. Both paths require reaction_type
// "unicode_emoji": realm emoji reuse codepoints as ids and may carry
// decision-shaped names.
const APPROVE_CODES = new Set(["2705"]); // ✅
const APPROVE_EMOJI = new Set(["check", "check_mark", "white_check_mark", "+1", "thumbs_up"]);
const DENY_CODES = new Set(["274c"]); // ❌
const DENY_EMOJI = new Set(["x", "cross_mark", "-1", "thumbs_down"]);

/** One reaction event -> "approve" | "deny" | null (null = not a decision). */
function reactionWants(event) {
  if (event.reaction_type !== "unicode_emoji") return null;
  if (APPROVE_EMOJI.has(event.emoji_name) || APPROVE_CODES.has(event.emoji_code)) return "approve";
  if (DENY_EMOJI.has(event.emoji_name) || DENY_CODES.has(event.emoji_code)) return "deny";
  return null;
}

/** "git push*" -> /^git push.*$/s. `*` is the only wildcard. */
export function patternToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "s");
}

/** Merge a global and a channel permission block; the channel wins per key.
 *  Path rules merge per tool and per pattern (a channel rule for one path
 *  does not erase the global rules for other paths of the same tool). */
export function mergePermissionConfig(global = {}, channel = {}) {
  const paths = {};
  for (const tool of new Set([...Object.keys(global.paths ?? {}), ...Object.keys(channel.paths ?? {})])) {
    paths[tool] = { ...(global.paths?.[tool] ?? {}), ...(channel.paths?.[tool] ?? {}) };
  }
  return {
    tools: { ...(global.tools ?? {}), ...(channel.tools ?? {}) },
    bash: { ...(global.bash ?? {}), ...(channel.bash ?? {}) },
    paths,
  };
}

export class PermissionRules {
  constructor(config = {}) {
    this.tools = Object.entries(config.tools ?? {});
    this.bash = Object.entries(config.bash ?? {}).map(([pattern, decision]) => ({
      re: patternToRegExp(pattern),
      pattern,
      decision,
    }));
    // tool name -> [{ re, pattern, decision }], same wildcard style as bash.
    this.paths = {};
    for (const [tool, patterns] of Object.entries(config.paths ?? {})) {
      this.paths[tool] = Object.entries(patterns ?? {}).map(([pattern, decision]) => ({
        re: patternToRegExp(pattern),
        pattern,
        decision,
      }));
    }
  }

  classifyTool(name) {
    let decision = "allow";
    let rule = null;
    for (const [pattern, d] of this.tools) {
      if (pattern === name || pattern === "*") {
        decision = d;
        rule = pattern;
      }
    }
    return { decision, rule };
  }

  classifyBash(command) {
    let decision = "allow";
    let rule = null;
    for (const { re, pattern, decision: d } of this.bash) {
      if (re.test(command)) {
        decision = d;
        rule = pattern;
      }
    }
    return { decision, rule };
  }

  /** Path-scoped rules for one tool call with a `path` argument. */
  classifyPaths(name, path) {
    const rules = this.paths[name];
    if (!rules || typeof path !== "string") return { decision: "allow", rule: null };
    let decision = "allow";
    let rule = null;
    for (const { re, pattern, decision: d } of rules) {
      if (re.test(path)) {
        decision = d;
        rule = pattern;
      }
    }
    return { decision, rule };
  }

  classifyCall(call) {
    if (call?.name === "bash") {
      return this.classifyBash(String(call.arguments?.command ?? ""));
    }
    // Path rules first (they carry the location context), then tool rules.
    const byPath = this.classifyPaths(call?.name ?? "", call?.arguments?.path);
    if (byPath.decision !== "allow") return byPath;
    return this.classifyTool(call?.name ?? "");
  }
}

/**
 * Build the permissions extension. Every injected dependency is gateway-side;
 * the module itself never talks to Zulip or Docker.
 *
 *   rulesFor(channel)      -> PermissionRules | null (null = allow all)
 *   audit                  -> { record(kind, fields) } (AuditLog)
 *   post(conversationId, content) -> approval message id (throws on failure)
 *   noteDecision(conversationId, text) -> posts the outcome note (best effort)
 *   describe(channel, call) -> extra context for the ask message ("" ok)
 *   isOwner(userId)        -> owner email string | null (null = not an owner)
 */
export function buildPermissionsExtension({
  rulesFor,
  audit,
  post,
  noteDecision,
  describe,
  isOwner,
  askTimeoutMs = 20 * 60_000,
}) {
  /** approval message id -> Set of waiters (a restart-rerun shares the id) */
  const pending = new Map();

  function settle(messageId, outcome) {
    const waiters = pending.get(messageId);
    if (!waiters || waiters.size === 0) return false;
    pending.delete(messageId);
    for (const entry of waiters) {
      clearTimeout(entry.timer);
      entry.resolve(outcome);
    }
    return true;
  }

  /** Wait for the owner's reaction on the approval message. */
  function wait(messageId, { conversationId, channel, call, signal }) {
    return new Promise((resolve) => {
      const entry = {
        conversationId,
        channel,
        call,
        resolve,
        timer: setTimeout(() => settle(messageId, { status: "expired" }), askTimeoutMs),
      };
      let waiters = pending.get(messageId);
      if (!waiters) {
        waiters = new Set();
        pending.set(messageId, waiters);
      }
      waiters.add(entry);
      if (signal) {
        const onAbort = () => {
          waiters.delete(entry);
          clearTimeout(entry.timer);
          resolve({ status: "aborted" });
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /** One reaction event. Returns true when the event resolved a pending ask. */
  async function handleReactionEvent(event) {
    if (event.op !== "add") return false;
    const waiters = pending.get(event.message_id);
    if (!waiters || waiters.size === 0) return false;
    const entry = [...waiters][0];
    const wants = reactionWants(event);
    if (!wants) {
      // A reaction landed on a pending ask but decides nothing. Keep it
      // visible in the audit: the 13-20 Oct approvals died exactly here,
      // silently, because the emoji names were guessed instead of captured.
      audit?.record("tool", {
        decision: "unmatched-reaction",
        by: `user:${event.user_id}`,
        emoji: `${event.emoji_name ?? "?"} (${event.emoji_code ?? "?"})`,
        messageId: event.message_id,
      });
      return false;
    }
    const email = await isOwner(event.user_id);
    if (!email) {
      // Fail closed toward unknown users, but keep the ask alive: the real
      // owner can still react.
      audit?.record("tool", {
        decision: "ignored-reaction",
        by: `user:${event.user_id}`,
        messageId: event.message_id,
      });
      return false;
    }
    const outcome = wants === "approve" ? { status: "approved", by: email } : { status: "denied", by: email };
    settle(event.message_id, outcome);
    audit?.record("tool", {
      channel: entry.channel,
      tool: entry.call.name,
      decision: outcome.status,
      by: email,
      messageId: event.message_id,
    });
    try {
      await noteDecision?.(
        entry.conversationId,
        wants === "approve" ? `✅ approved by ${email} — proceeding.` : `❌ denied by ${email}.`
      );
    } catch {
      /* the audit trail is the record; the note is cosmetic */
    }
    return true;
  }

  async function beforeTool(call, api, context) {
    let channel = null;
    let rules;
    try {
      const doc = await api.snapshot(ZulipDoc, api.conversationId, context);
      channel = doc?.stream ?? null;
      rules = rulesFor(channel);
    } catch (err) {
      // Fail open: an internal error in classification must not take down
      // every session. The audit trail records it.
      audit?.record("permission-error", {
        conversationId: api.conversationId,
        tool: call.name,
        error: err.message,
      });
      return undefined;
    }

    const { decision, rule } = rules?.classifyCall(call) ?? { decision: "allow", rule: null };

    if (decision === "allow") return undefined;

    if (decision === "deny") {
      audit?.record("tool", { channel, tool: call.name, decision: "deny", rule });
      return {
        block:
          `Blocked by a permission rule (${rule}). ` +
          `The rule lives in phase1/channels.json; ask the user if it should change.`,
      };
    }

    // "ask": post the approval request, then wait for the owner's reaction.
    // The ask's message id is a durable task memo, so a gateway restart that
    // re-runs this tool call reuses the same approval message instead of
    // posting a duplicate.
    let extra = "";
    try {
      extra = (await describe?.(channel, call)) ?? "";
    } catch {
      /* the generic summary is enough */
    }
    const argsText = JSON.stringify(call.arguments ?? {}).slice(0, 400);
    const waitText = askTimeoutMs >= 60_000
      ? `${Math.round(askTimeoutMs / 60_000)} minutes`
      : `${Math.round(askTimeoutMs / 1000)} seconds`;
    const content =
      `🔒 **${call.name}** needs approval.` +
      (extra ? `\n\n${extra}` : "") +
      (call.name === "bash" ? `\n\n\`${String(call.arguments?.command ?? "").slice(0, 300)}\`` : "") +
      (argsText && argsText !== "{}" ? `\n\nArguments: \`${argsText}\`` : "") +
      `\n\nReact with ✅ to approve or ❌ to deny. Auto-denied after ${waitText}.`;

    let messageId;
    try {
      const memoKey = `permission-ask:${call.id}`;
      messageId = await api.memo(memoKey, context);
      if (messageId === undefined) {
        const posted = await post(api.conversationId, content);
        messageId = await api.memo(memoKey, posted, context);
      }
    } catch (err) {
      // No approval surface, no consent: the action does not run.
      audit?.record("tool", { channel, tool: call.name, decision: "ask-failed", error: err.message });
      return {
        block:
          `The approval request could not be posted (${err.message}), so the action was not taken. ` +
          `The work stays committed in the workspace. Tell the user.`,
      };
    }

    audit?.record("tool", { channel, tool: call.name, decision: "ask", messageId });
    const outcome = await wait(messageId, {
      conversationId: api.conversationId,
      channel,
      call,
      signal: context?.abortSignal,
    });
    audit?.record("tool", { channel, tool: call.name, decision: outcome.status, by: outcome.by ?? null });

    if (outcome.status === "approved") return undefined;
    const why = {
      denied: `The user denied ${call.name}. Ask what to change.`,
      expired:
        `No approval arrived within ${waitText}; ${call.name} was not run. ` +
        `The work is committed in the workspace — ask again when the user is around.`,
      aborted: `The run was stopped before approval; ${call.name} was not run.`,
    }[outcome.status] ?? `${call.name} was not approved.`;
    return { block: why };
  }

  function afterTool(call, result) {
    try {
      audit?.record("tool_result", { tool: call.name, error: result?.isError === true });
    } catch {
      /* never affect the result */
    }
    return undefined;
  }

  const extension = defineExtension({
    name: "permissions",
    hooks: [hook(ToolTask, { beforeTool, afterTool })],
  });

  return {
    extension,
    handleReactionEvent,
    /** Pending ask waiters, for tests and inspection. */
    pendingCount: () => {
      let n = 0;
      for (const set of pending.values()) n += set.size;
      return n;
    },
  };
}