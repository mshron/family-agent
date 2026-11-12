# Phase 2: what landed, what waits, and the decisions behind it

> **Point of this memo:** Phase 2's software is live: a gateway-native permission layer (deny rules on dangerous bash, an approval gate on `push_changes`), an append-only audit log, and — since 12 Nov, evening — the credential proxy itself, activated single-box. What remains is operator work: egress lockdown and key rotation, both runbooked below. One deviation from the consolidation memo is recorded here: the permission layer is built on pi-durable's own hooks, not on `@gotgenes/pi-permission-system`.

## What is live now

1. **Permission layer** (`gateway/lib/permissions.js`). Deterministic allow/ask/deny rules per channel, over every tool call, through pi-durable's `beforeTool`/`afterTool` hooks on the built-in tool task. Rules live in `phase1/channels.json`:
   - a top-level `permissions.bash` map applies to every channel; the shipped rules deny `rm -rf /*` (any absolute path) and `sudo *`;
   - a channel's `permissions.tools` map gates named tools; `#meta` ships `push_changes: "ask"`.
   - `ask` posts an approval message into the topic (with the pending commits for a push), the owner reacts ✅/❌, and the pending tool call resolves from the reaction event. Approval integrity follows the memo's rule: sessions hold no Zulip credentials and never see reaction events, so an approval cannot be forged from inside a conversation. Only `ZULIP_OWNER_EMAILS` users may approve; unknown reactors fail closed but the ask stays live.
   - Unmatched calls are allowed. Internal errors in classification fail **open** (Phase 1 behavior, loudly audited) — a bug at 3am must not brick every session; failures of the ask flow itself fail **closed** (no approval surface, no consent, no action).
2. **Audit log** (`gateway/lib/audit.js`). One JSONL line per event at `/opt/family-agent/audit/audit.jsonl`: every tool call's decision and outcome, pushes, slash commands, thread spawns, boot/shutdown, approval decisions with the approver's email. The gateway is the only writer; the directory is never mounted into exec containers, so sessions cannot read it and cannot rewrite what is written.
3. **LLM proxy seam** (`gateway/lib/models.js`). `LLM_BASE_URL` points every model call at the credential proxy (`fa-proxy`) instead of OpenRouter directly; the proxy holds the real key and this process carries a placeholder. Search goes through the same proxy (`SEARCH_PROXY_URL`), keys living in `/opt/family-agent/proxy.env` only.

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

## What is live since the single-box activation (12 Nov, morning)

(Kept for the record; the same evening the proxy moved to the vault box — see
"The split as shipped" below. The runbook's two-box-first order was overtaken
by events.) The credential proxy activated on the session box itself:

1. **`fa-proxy`** (Caddy, `deploy/proxy/Caddyfile`) runs as a compose service
   beside the gateway. Keys live only in `/opt/family-agent/proxy.env` (mode
   600): OpenRouter, Kagi, Brave. The gateway's `.env` holds a placeholder
   `OPENROUTER_API_KEY` plus `LLM_BASE_URL=http://fa-proxy:8080/llm` and
   `SEARCH_PROXY_URL=http://fa-proxy:8080`; the search tools send no auth
   headers in proxy mode (direct mode remains for local runs and rollback:
   unset `LLM_BASE_URL`/`SEARCH_PROXY_URL`, restore keys in `.env`).
2. **Why the deviation:** the gateway process is trusted either way — the
   property that ships is that key material leaves the environment of the
   process that talks to the untrusted half of the network, and Phase 3
   open-world responses get a checkpoint. The DM-first system is mid
   acceptance testing (a bad moment to move boxes), the dead stacks that
   motivated the urgency are destroyed, and moving the proxy to a gateway box
   later is one URL change. The split remains open, not scheduled.
3. **Known exception, by design:** the mark sidecar token is *not* proxied.
   Its viewer URL carries the token into conversations on purpose
   (`phase1/exec/mark`); fronting only the registration call would change
   nothing. A real fix means sidecar sessions — deferred.

## Design conclusions recorded from the split discussion (12 Nov, evening)

1. **Capability-channel exfiltration is the residual risk that stays.** A
   hijacked agent can always misuse its own capabilities — make a tarball,
   send it through the sanctioned email tool. The network cannot fix this;
   the tool layer does: outbound-send as a policy point (volume caps,
   attachment inspection, ask-gating for bulk sends — the wife's profile
   already specifies outbound-send always-human), rate limits, and ingress
   scanning at the proxy to catch the injected instruction upstream. Our
   tools execute gateway-side rather than as MCP servers inside sessions,
   so the inspection point is one chokepoint, not N self-attesting servers.
2. **Sessions get no direct network world at all.** Search and fetches run
   gateway-side and pass through the proxy's checkpoint; the session's own
   egress shrinks to DNS, package registries, and the trusted box. Ingress
   for a session is tool results — the controlled path.
3. **The split's pragmatic shape: move the proxy, not the gateway.**
   pi-durable made the gateway process the session runtime; moving it off
   the session box means a shared-storage redesign (proxy-fronted
   workspaces) that the threat model does not yet justify. The property the
   user asked about — key material on a machine that no session container
   can route to, safe even against session-box host root — is delivered by
   moving only the proxy and monitoring to the second box. The gateway
   container's `docker.sock` mount means a gateway compromise is already
   host-equivalent wherever it runs; that risk is unchanged by the split.
4. **Monitoring belongs on the trusted box.** A small, static, 3-container
   machine where any change is signal: auditd, file-integrity (AIDE),
   central syslog receiving the session box's logs (absence of forwarded
   logs is itself a signal), unattended-upgrades. The session box cannot be
   trusted to report its own compromise.

## The split as shipped (12 Nov, night)

The single-box activation lasted half a day. The **vault box** (cx23,
49.13.26.153 public, 10.0.0.4 on chat-net) now holds:

- **fa-proxy**, published on the private IP only, host-firewalled to the
  session box's IP (10.0.0.3). After the deploy that retired the session
  box's fa-proxy service, its `proxy.env` was deleted: the session box holds
  no upstream credential at all. A full compromise of it — host root
  included — reaches no key material.
- **Monitoring**: auditd, AIDE baseline, unattended-upgrades, rsyslog
  receiving the session box's host logs (journald forward over TCP 514;
  absence of forwarded logs is itself a signal).
- **Backups**: nightly 04:15 rsync of `durable/`, `audit/`, `workspaces/`,
  `skills/` from the session box through a restricted rrsync key (forced
  command, write-only into the backup tree, no `--delete` — a damaged
  source never destroys the copy). First run verified: 143 MB workspaces,
  9.9 MB durable.

Session-box side: gateway recreated with `LLM_BASE_URL` and
`SEARCH_PROXY_URL` at `10.0.0.4:8080`; **egress lockdown ON** (v4+v6;
  registries for builds, Zulip, GitHub for the deploy key, the vault IP,
  the mark sidecar's on-host address; everything else REJECTed). Verified
  from a live exec container: internet refused, allowed paths open.
  LibreChat's sandbox-runner still lives on this box and is subject to the
  same rules — its code-interpreter may have lost outbound access it
  needed; watched, and `egress-lockdown.sh off` reverts in one command.

Two operational lessons, both from my own mistakes that evening:

1. **`docker compose restart` does not re-read `env_file`.** The cutover
   restarted instead of recreating, so the gateway kept its old LLM URL for
   half an hour after the old proxy container was removed; two user
   messages got the provider-error fallback. Env changes ship via
   `up -d` (recreates on config change). Verification must check the live
   process environment — `docker exec fa-gateway env` — not the file, and
   not the network path from the container's shell.
2. **Never overwrite `authorized_keys`; append.** I replaced the file
   with only the new restricted backup key and locked every human out of
   the brand-new vault. The API root-password reset is useless on the
   standard image: password SSH auth is disabled, and the console is the
   reset password's only consumer. Recovery was destroy-and-recreate with
   everything in cloud-init — which is the real lesson: **the box is a
   script, not a pet.** `proxy.env` is the only state outside the repo,
   and it moves in one scp; `deploy/proxy/cloud-init.yaml` now carries the
   rest.

## What still waits for the operator

1. **Rotate the exposed keys** (below).
2. Harden the exec container profile further (read-only rootfs, dropped
   capabilities) — optional, next pass.
3. Re-run `egress-lockdown.sh on` after a box reboot or registry IP
   churn (CDN-resolved at run time); a systemd/cron wrapper belongs on the
   box when this becomes default.

## Credential rotation checklist (revised 12 Nov)

The old checklist assumed the nanobot stacks were live neighbors. They are
destroyed (Fly apps deleted; the local Apple Containers stack stopped and
its launch agent disabled). What remains exposed is *files*: the dead stack's
`.env` on the Mac (`~/code/polynumeral-assistant/.env`) still holds valid
credentials for the bot user and several APIs.

**Keys of the live system that sat in the dead stack's env — rotate these:**

1. **Zulip bot API key** (Zulip org settings → the bot user → edit). New value
   goes to `/opt/family-agent/.env` on the box (`ZULIP_API_KEY`), then
   `docker compose -f /opt/family-agent/phase1/deploy/docker-compose.yml
   restart gateway`. One polling gap.
2. **Brave search key** (Brave dashboard). New value goes to
   `/opt/family-agent/proxy.env` on the box (`BRAVE_API_KEY`), then
   `docker restart fa-proxy`. No gateway restart needed.

**Keys that never sat in the dead stack — no rotation required:** OpenRouter
(sourced from `~/.pi/agent/auth.json`), Kagi (sourced from 1Password), the
mark token (Phase 1-only). Rotate on general hygiene if desired.

**Dead-stack credentials that are still valid until rotated or revoked —
kill them at their providers:** the Fastmail token, the Gmail app password,
the Groq key, the Anthropic key, the Zulip test-user key (all in the dead
`.env` on the Mac). The stacks that used them are gone; revoke rather than
rotate. Then scrub that file.

**Repo hygiene, if not already done:** branch protection on `main` on GitHub
(Settings → Branches) — the deploy key and `DEPLOY_SSH_KEY` both grant
push/box access to anyone who can edit the repo.

Verification after any rotation: `docker exec fa-gateway env | grep -c KEY`
shows only names; a session's `env` shows none; `docker logs fa-gateway`
shows no auth failures. Note: `push-secrets.sh` rewrites `.env` wholesale
and is for cold setups — on the live box, edit the two files in place.

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