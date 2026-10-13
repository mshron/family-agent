# Phase 2: what landed, what waits, and the decisions behind it

> **Point of this memo:** Phase 2's software is live: a gateway-native permission layer (deny rules on dangerous bash, an approval gate on `push_changes`) and an append-only audit log. The hardware half — the second box, the credential proxy in front of every upstream, egress lockdown, key rotation — cannot be provisioned from inside the repo, so it ships as reviewed deploy assets plus this runbook. One deviation from the consolidation memo is recorded here: the permission layer is built on pi-durable's own hooks, not on `@gotgenes/pi-permission-system`.

## What is live now

1. **Permission layer** (`gateway/lib/permissions.js`). Deterministic allow/ask/deny rules per channel, over every tool call, through pi-durable's `beforeTool`/`afterTool` hooks on the built-in tool task. Rules live in `phase1/channels.json`:
   - a top-level `permissions.bash` map applies to every channel; the shipped rules deny `rm -rf /*` (any absolute path) and `sudo *`;
   - a channel's `permissions.tools` map gates named tools; `#meta` ships `push_changes: "ask"`.
   - `ask` posts an approval message into the topic (with the pending commits for a push), the owner reacts ✅/❌, and the pending tool call resolves from the reaction event. Approval integrity follows the memo's rule: sessions hold no Zulip credentials and never see reaction events, so an approval cannot be forged from inside a conversation. Only `ZULIP_OWNER_EMAILS` users may approve; unknown reactors fail closed but the ask stays live.
   - Unmatched calls are allowed. Internal errors in classification fail **open** (Phase 1 behavior, loudly audited) — a bug at 3am must not brick every session; failures of the ask flow itself fail **closed** (no approval surface, no consent, no action).
2. **Audit log** (`gateway/lib/audit.js`). One JSONL line per event at `/opt/family-agent/audit/audit.jsonl`: every tool call's decision and outcome, pushes, slash commands, thread spawns, boot/shutdown, approval decisions with the approver's email. The gateway is the only writer; the directory is never mounted into exec containers, so sessions cannot read it and cannot rewrite what is written.
3. **LLM proxy seam** (`gateway/lib/models.js`). `LLM_BASE_URL` points every model call at a credential proxy instead of OpenRouter directly. Unset (today): direct, as in Phase 1. Set (after the box split): the proxy holds the real key and this process carries a placeholder.

## The deviation: pi-durable hooks, not pi-permission-system

The consolidation memo assumed `@gotgenes/pi-permission-system` provides the machinery ("only the judge and the Zulip surface are yours to build"). That was written before the substrate migrated to pi-durable. The package targets pi's session/UI extension API — config under `~/.pi/agent/extensions`, TUI confirmation dialogs, `getPermissionsService(sessionId)` — none of which exists inside a pi-durable harness. Installing it would couple the gateway to a UI surface it has no way to answer.

pi-durable's own seam is the tool-task hooks: `beforeTool` can block a call or rewrite its arguments, `afterTool` sees the result. The layer keeps what the memo actually wanted from the package:

| Memo requirement | How it is met here |
|---|---|
| Deterministic gates, allow/ask/deny | `PermissionRules` over `channels.json`; wildcard bash patterns, last match wins |
| Approvals over a control path sessions cannot write | Reaction events on the bot's own approval messages; sessions never see events, only the gateway resolves them |
| Fail closed on indirection (`bash -c`, wrappers) | Not ported — inside an exec container the whole command string *is* one `bash -c` invocation by design; gating wrappers there is meaningless until bash rules grow finer |
| Decisions recorded gateway-side | Audit log (ask, outcome, approver, rule) |
| Disallowed tools hidden from the model | Deferred — per-channel tool lists (`channels.json` `tools`/`add`) already hide tools; rules only *gate* visible ones |

The authorizer judge (a small model consulted before the human on `ask`) is deliberately not wired: the only ask rule that ships is `push_changes`, where every occurrence should reach a human. When bash ask-rules earn their keep, the judge slots in ahead of the approval post in `beforeTool`.

## What waits for the box (Phase 2b runbook)

These need hands on infrastructure, not code. In order:

1. **Provision the gateway box** (Hetzner, cx22 unless self-hosted Zulip is likely). Private-network it with the session box.
2. **Move the gateway** there: install docker, copy `/opt/family-agent/.env` (or re-run `deploy/push-secrets.sh` with the new host), run `phase1/deploy/install.sh`; point GitHub Actions' deploy at the new box.
3. **Activate the credential proxy**: `deploy/proxy/Caddyfile` (reviewed in-repo), with the real OpenRouter key in the proxy's environment only; set `LLM_BASE_URL=http://<gateway-box-ip>:8080/llm` and a placeholder `OPENROUTER_API_KEY` in the gateway's `.env`.
4. **Lock session egress**: `deploy/egress-lockdown.sh on <gateway-box-ip>` on the session box — DNS, package registries, and the gateway box only. Operator-run, with a live session watched. Registry IPs are CDN-resolved at run time; re-run after boot.
5. **Rotate the Phase 1 credentials** (below).
6. Harden the exec container profile further (read-only rootfs, dropped capabilities) — optional, next pass.

## Credential rotation checklist

Phase 1's rule: when Phase 2 lands, rotate everything Phase 1's sessions could have seen. Exec containers never held keys (verify below), but the window the rule covers closes only by rotation:

1. Rotate the **Zulip bot API key** (organization settings → the bot user → edit) and the **OpenRouter key** (console). Generate, don't reuse.
2. Re-run `deploy/push-secrets.sh` (it rewrites the box's `.env`; update its host first if the gateway moved).
3. Restart the gateway: `docker compose -f /opt/family-agent/phase1/deploy/docker-compose.yml restart gateway`. Order matters: rotate → write `.env` → restart; expect one polling gap.
4. Set **branch protection on `main`** on GitHub (Settings → Branches) if not already done: the deploy key and `DEPLOY_SSH_KEY` both grant push/box access to anyone who can edit the repo.
5. Verify: `docker exec fa-gateway env | grep -c KEY` shows only names; a session's `env` shows none; `docker logs fa-gateway` shows no auth failures.

## Verification

Local (run before every deploy that touches the layer, from `phase1/gateway/`):

- `node scripts/permissions-contract.mjs` — 16 checks: pattern semantics, rule resolution, merge, every ask path (approve, deny, timeout, abort, post failure, rerun reuse), fail-open.
- `node scripts/permissions-smoke.mjs` — the real Harness against a fake model server: deny blocks and the model sees the refusal, allow passes, ask holds the run until the approval reaction.

Live (in Zulip, after deploy):

- In `#meta`, ask the agent to push a trivial commit: the approval message lists the commits; ✅ pushes, ❌ refuses with a message the agent sees.
- In any channel, `bash rm -rf /tmp/x` is refused with the rule name; the spoiler shows the refusal.
- On the box, `tail /opt/family-agent/audit/audit.jsonl` shows the decisions with approver emails.

## Known gaps

- A gateway restart while an ask is pending: the run resumes and reuses the approval message (a durable task memo prevents duplicate posts), but the reaction path may be missed — the re-run waits out its timeout and refuses. Safe (no action without consent), wasteful, rare.
- `ZULIP_OWNER_EMAILS` empty or unverifiable (org email-visibility policy): asks post and can never be approved. The gateway logs this at boot.
- The idle sweep may stop a conversation's watcher during a long ask (cosmetic: the end spoiler is lost; the reply still posts).
- One ask rule exists; the judge and MCP/path rules arrive with Phase 3's tool surface.