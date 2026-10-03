# One system on Hetzner: Zulip as the interface, pi sessions as the engine

> **Point of this memo:** The target is no longer "move three systems onto two boxes." It is one system: Zulip is the only chat surface, every interaction — asking a question, coding, planning finances — happens in a pi session reached through a Zulip topic, and the sessions themselves are powerful (full tools, real workspace, git) instead of tool-restricted. Nanobot, LibreChat, the code interpreter, and Fly.io all retire. Two things survive from the old design: the credential proxy and the append-only log, kept as trusted services on the other box from the sessions. This memo covers the target architecture, the sandboxing question, a migration plan, and the decisions that are still open.
>
> This replaces the earlier "lift-and-shift nanobot" recommendation in this file. That option assumed nanobot had a future; under the single-system goal it does not, so the build order changes.

## Assumptions

1. **Build on new boxes; the old boxes stay untouched until the end.** Two new Hetzner boxes — the *gateway box* (trusted services) and the *session box* (sandboxed sessions) — joined to the existing private network: the session box is provisioned in Phase 1 (the feel test runs on it alone), the gateway box in Phase 2. The existing chat box (`128.140.56.71` / `10.0.0.2`, LibreChat) and code box (`128.140.54.129` / `10.0.0.3`, codeapi) keep running throughout the build and are backed up and shut down only after the new system replaces them (Phase 6). The overlap costs a few euros a month; the insurance is never being without a working system. Sizing: sessions wait on LLM APIs most of the time, so the session box's 8 GB covers roughly 6–10 warm session containers (~0.5–1 GB each with Node). The gateway box starts at cx33 if Phase 7 (self-hosted Zulip) is likely, cx22 otherwise; resize up (a reboot) as needed.
2. "One system" means: humans open Zulip (cloud or self-hosted — open question), topics route to pi sessions, sessions do everything.
3. The credential proxy and log service survive as separate trusted services. Sessions never hold API keys and can only append to logs.
4. A third box is available if needed; default plan uses two.
5. API spend is unchanged by infrastructure, but session power changes the model mix — see Model routing below.
6. Identity is Zulip's job. You are the only user today; when others join they are Zulip users on your org — the model knows them by Zulip identity, user-level memory is keyed on Zulip user IDs, and channel membership (private channels) is the access boundary. Open question 4 covers the one part this does not settle: how much session power a new user gets.

## Target architecture

```
People (you, family, friends)
   │  Zulip apps: web, desktop, phone
   ▼
Zulip — one org, channels = domains (#finance, #coding, …), topics = threads
   │  event queue (bot polls; Zulip needs no inbound path to you)
   ▼
Gateway (new, small)          trusted box — gateway box (new)
   • routes (channel, topic) → conversation
   • slash commands, subagents, cron-spawned topics
   • credential proxy (Caddy): every API key lives here and
     only here; sessions send unauthenticated requests to it
   • log service: append-only, POST-only; sessions write, read nothing
   • memory + workspaces: git repos (markdown memory, project files)
   ▼
Session host — session box (new), no public inbound
   • one sandboxed container per conversation
   • pi with its own tools: read, bash, edit, write
   • LLM provider = custom endpoint pointed at the credential proxy
   • outbound allowed only to: gateway box private IP (proxy, log), DNS,
     and (decision pending) package registries
```

**Terminology:** A *conversation* is one persistent pi context, keyed by a stable ID, mapped to one Zulip (channel, topic) pair. *Session power* means the session can run arbitrary shell commands and edit files in a real directory tree, like a coding agent, rather than calling a fixed list of safe tools. *Blast radius* is the set of things a compromised session can damage.

Component table:

| Component | Status | Notes |
|---|---|---|
| Zulip | Survives, becomes the only interface | Cloud now; self-host is now a live option (open question 3) |
| Gateway | **New build** | Zulip event loop → conversations; the design summary of 2 Oct is its specification |
| pi | Becomes the engine | Today it runs finance sessions interactively on the Mac; the design summary already targets it |
| Credential proxy (Caddy) | Survives from nanobot stack | Holds every key: LLM routes (anthropic, tinfoil, groq) *and* MCP tool credentials (fastmail, gmail, brave, simplefin) — sessions see internal proxy URLs only |
| Log service | Survives from nanobot stack | Append-only JSONL; wired to pi via an extension |
| Memory + workspaces | **New build** | Git repos; three memory levels per the design summary |
| Nanobot stack | **Retires** | Fly apps destroyed; guardrail *ideas* port, the wrapper does not |
| LibreChat stack | **Retires** | Nobody else uses it today; when someone joins, they join Zulip (assumption 6) |
| Code interpreter (codeapi) | **Retires** | Sessions run code in their own sandbox; no separate execution tier |

## The substrate choice: what the gateway is built on

The gateway is small either way; the choice is what provides conversations, persistence, and replay underneath it.

### Option A — Pi Durable (decided)

Pi Durable (Earendil, shipped 1 Oct 2026) is a harness built for exactly this shape: storage plus machinery for many concurrent conversations, checkpointed model and tool calls, `requestId` for exactly-once submissions, background compaction landing at turn boundaries, `reset()` with a handoff note, fork at any message, typed documents committed with the transcript. Per the design summary, it has no channel adapters — you write only the Zulip gateway, which is the part that is genuinely yours.

- **For:** The design summary's proposal maps onto Pi Durable concepts one-to-one: (channel, topic) → conversation, cron topics with period-encoded `requestId` (retries cannot duplicate a month-end cleanup), `reset()`/`compact()` behind `/new`/`/compact`, subagents as conversations owned by tool calls. You are not re-solving persistence, replay, or compaction.
- **Against:** One week old and explicitly experimental. Building your only interface on it couples you to its pace.
- **Mitigation:** Keep the exit path cheap. The Zulip adapter, the memory files, and the sandbox runner are yours and are most of the work; if Pi Durable stalls, they port to the pi SDK (Option B) without redesign. Write the adapter against a thin interface from day one.

### Option B — Build directly on the pi SDK

The pi SDK (stable, 1.0.0) embeds the agent in a process; you own sessions, persistence, dedup, and memory yourself.

- **For:** No experimental dependency; everything is under your control.
- **Against:** You rebuild exactly the parts Pi Durable exists to provide — checkpointing, replay, exactly-once cron, background compaction, conversation forking — each of which is subtle (the design summary spent most of its length on why). This is the largest amount of new code for the least new capability.

### Option C — OpenClaw

Built on Pi sessions, mature main-session model, DM consolidation. But: no native Zulip channel (its transports are Telegram, WhatsApp, Discord, Slack), and its session/memory model conflicts with the design summary (it collapses DMs into one main session; you want per-topic conversations with three memory levels). You would write the Zulip adapter anyway *and* fight its opinions. Rejected for the core. Keep it in mind for the future phone/SMS work, where its model fits better.

**Decision (2 Oct): Option A, with the thin-interface exit path.** The alternatives above record why they were rejected — Option B rebuilds what Pi Durable already provides, for no new capability; Option C costs a Zulip adapter anyway and then fights a session model that contradicts the design summary. Keep the exit path cheap (the Zulip adapter, memory files, and sandbox runner are yours and port to the pi SDK without redesign) and prototype the feel test (Phase 1) before committing.

## Sandboxing

This is the place the new design raises the stakes. The old nanobot agent exposed a fixed list of vetted tools (email, search, browser) and could damage little. A pi session with `bash` in a workspace is a general-purpose program under prompt-injection risk. The compensating principle: **sessions get power through the workspace, not through credentials.** A session should be able to read, write, compute, and version anything in its mounted repos — and reach nothing else.

### Threat model

1. **Primary: prompt injection** — malicious email/web content steers a session. Controls: ingress scanning (below), credential starvation, the permission layer with its judge, the append-only finance discipline, and human approval in-topic for consequential actions.
2. **Secondary: model error** — no adversary required. A helpful model given an email MCP can mass-delete mail, rewrite a file, or push a bad commit out of honest confusion. The permission gates exist as much for this as for injection: deny and ask rules bound what a *mistake* can do, exactly like they bound an attack. Model choice also matters here — which is part of why the default is a known-good model with an escalation path, not an unproven one.
3. **Tertiary: container escape** — newly relevant because sessions hold general `bash`. Controls: the sandbox itself (below) plus egress firewalling, so even an escape reaches a network with almost nothing on it.

**Ingress scanning — defense in depth, upstream of every session.** The PromptGuard idea survives, relocated to where a compromised session cannot bypass it: outside the session. Two checkpoints: the gateway scans inbound Zulip messages on arrival, and the credential proxy scans *responses* from open-world APIs (email bodies, web fetches) before they return to the session. Flagged content arrives tagged or quarantined, never silently passed. The scanner fails open when unavailable — the in-session permission layer is the backstop, not the other way round.

### Credential starvation (the strong control)

- No API keys in the session environment, ever. The session's LLM provider is a custom endpoint pointed at the credential proxy — pi supports OpenAI-compatible custom providers — so even the model key is injected proxy-side, not held by the session.
- Tool APIs (email, search, finance MCP) route through the same proxy.
- Log service is append-only; sessions cannot read audit trails.
- Network egress from the session box allows only: the gateway box's private IP, DNS, and (pending decision) package registries.

Two credentials leak into this model by necessity, and both need deliberate decisions:

- **Git push.** Sessions must push work (finance repo, memory repos, project repos). Three shapes, weakest first:
  - *Deploy key in the workspace.* An SSH key whose permission is exactly one repo, stored under the session's `.ssh/`. Simple, but the session physically holds a credential, and it can force-push history unless the remote forbids it.
  - *Proxy-fronted git.* The gateway box runs bare repos; sessions push to an internal URL (`http://gateway/git/<repo>`) and the proxy injects a per-repo token and enforces per-repo path rules — the same credential-starvation pattern as every other API. Sessions hold no git credential at all.
  - *Gateway-mediated publish.* Sessions only commit locally; a trusted-side sync job pushes when a topic goes idle or on `/publish`. Sessions never see a remote.

  Start with proxy-fronted git (it is the same pattern as everything else in this design). On the remote, protected branches that reject force-pushes turn the finance repo's append-only *policy* into a mechanism; where the remote is GitHub (finance today), branch protection needs no new infra.
- **Package installs.** `uv` and `npm` need PyPI/npm to be useful. Allow read-only registry egress, then gate the *new*: when a session wants to add a package or move a pin, an `ask` fires and a flash-model reviewer (an authorizer link, same as the permission judge) checks the lockfile diff — what the package is, whether it is established, whether anything smells like typosquatting. A flash model over a lockfile diff costs fractions of a cent and catches the common poisoning shapes. The remaining hole is a compromised *existing* pin, which egress rules cannot help and periodic lockfile review has to.

### The sandbox itself

| Option | Isolation | On these boxes | Cost |
|---|---|---|---|
| Hardened Docker (cap_drop ALL, read-only rootfs, no-new-privileges, seccomp) | Weakest of the three — shares the host kernel, shrinks its attack surface | Already proven (this is the polynumeral profile) | None — start here |
| gVisor (`runsc` Docker runtime; a user-space kernel that intercepts syscalls) | Strong — a session exploiting a kernel bug still sits inside gVisor | Works: needs no `/dev/kvm`, unlike microVMs | Moderate syscall overhead (worst on syscall-heavy builds); some debugging friction |
| NsJail | Middle — namespaces + seccomp, shares kernel | Proven: this is what codeapi runs in on the old code box | Config-heavy; needs elevated caps on the host; awkward per-conversation |
| microVM (Firecracker, libkrun) | Strongest | **Not available** — the runbook already established Hetzner shared-vCPU boxes have no `/dev/kvm` | Would require different hardware |

**Recommendation:** Start with the hardened Docker profile (it exists, it is understood, and the egress chokepoint carries most of the security weight while sessions are young). Add gVisor as a deliberate upgrade once the loop works — installing `runsc` is a host-side change, no redesign. NsJail earns nothing over gVisor here. Revisit hardware only if kernel escape enters the threat model seriously (it mostly enters when *other people's* code runs, which is not this system).

**Off-the-shelf isolation, before building your own.** pi's containerization guide lists four patterns; three matter here, with their tradeoffs:

- *Your own runner on plain Docker.* You compose the profile (hardening flags, mounts, egress rules) and own the runner — roughly a hundred lines that `docker run`s a conversation container and connects it to the gateway. Full control, no third party in the security path; you are also the maintainer of the runner.
- *Docker Sandboxes* (`sbx`).* Managed sandbox plus host-side credential substitution through its own proxy. Closest to done-for-you, but it is a Docker Desktop-era product aimed at local use; running it as a multi-conversation server on Hetzner is off its paved road.
- *OpenShell* (NVIDIA).* Remote sandboxes with filesystem, process, network, *and credential* policies, plus inference routing that keeps model keys outside the sandbox — the same shape as the credential proxy, off the shelf. If its policies match, it replaces both the container runner and part of the proxy. Against it: a third-party component sitting inside your security boundary, its own gateway service to operate, and your sessions written against NVIDIA's abstractions rather than plain Docker.
- *Gondolin.* Host-local micro-VM; needs virtualization; irrelevant on these boxes.

**Decision (2 Oct): the thin runner on plain Docker — no third-party component inside the security boundary.** OpenShell and Docker Sandboxes are rejected: both put someone else's gateway or proxy service in the middle of the credential path, and running sessions on third-party infra is out of scope for this system. The runner is roughly a hundred lines you own. If runner maintenance ever hurts, the answer is more policy in the runner and gVisor underneath it — not a vendor.

### Where the agent loop runs, and container lifecycle

The agent loop runs *inside* the per-conversation container. The gateway spawns one container per active conversation; pi runs there in RPC mode (pi's RPC mode speaks JSONL commands and events across a process boundary — built for exactly this); the gateway, on the gateway box, drives it over the private network. Pi Durable storage lives on a volume the container mounts, so the container itself is disposable.

- **Spin-up:** ~100–500 ms for a cached container start plus ~1–2 s of Node/pi boot. The gateway hides even that with a keep-warm pool: idle containers are destroyed after ~15–30 minutes, and the next message in the topic respawns from storage. Idle conversations cost nothing — storage-backed, per the design summary — so a topic can sit for weeks and come back exactly where it left off.
- **Why the whole loop inside, not tool calls routed out:** the alternative — pi on a trusted host with `bash`/`read`/`write` routed into per-topic containers, Gondolin-style — keeps the agent process trusted, but every tool, MCP server, and shell invocation crosses a boundary you build and maintain per tool. Everything-inside is one boundary, built once.
- **Extensions run inside with the session.** Permission config and extension code mount read-only, so a session can neither loosen policy nor rewrite its own gates.
- **gVisor composes unchanged** — it is a runtime choice per container, not an architecture choice.

Two shaping decisions that matter more than the runtime:

- **Workspace scoping by channel.** Mount only the channel's repo into its sessions. An injection arriving via email in `#email` or a web page in `#research` then cannot touch the finance repo, because no finance channel session has it mounted. This is cheap and closes the most likely cross-domain attack path. Make it a rule: *a session sees exactly its channel's workspace, user-level memory, and nothing else.*
- **Resource limits per session** (CPU, memory, PIDs), so a runaway loop cannot starve the box or the other sessions.

## Permissions: auto mode, not allow-everything

Full-power sessions need a permission layer: safe calls run, risky calls are reviewed, the worst are denied — automatically, most of the time. The machinery exists; only the judge and the Zulip surface are yours to build.

1. **Deterministic gates — `@gotgenes/pi-permission-system`** (an active fork of MasuRii's original; version 37 as of this writing, updated within the last day). Allow/ask/deny per tool; bash wildcard patterns (`rm -rf *: deny`, `git push: ask`); MCP and skill gating by name; path rules that deny `.env`, `~/.ssh/*`, and similar across *every* tool, matched against symlink-resolved paths so a deny cannot be evaded by an alias; fail-closed on commands the parser cannot resolve and on wrappers that hide their payload (`bash -c`, `eval`, `sudo`, `xargs`, `find -exec`). Disallowed tools are hidden from the model before it starts, so it never wastes turns probing for them. Project-level config loads only after project trust — an untrusted workspace cannot loosen the server's global policy.
2. **The auto-review judge — `authorizerChain`.** The package's extension point for exactly the Claude Code auto-mode idea: when a call lands on `ask`, a registered decision link — "a light model judge" in its own docs — is consulted ahead of any human prompt. The chain owner caps what a link may allow, so the judge can never exceed policy. This is the only code to write.
3. **Human fallback over Zulip — with approval integrity.** When the judge defers, or the category is marked always-human (anything money-adjacent), the ask is posted into the topic; approve by reply or reaction. The anti-forgery rule: **sessions hold no Zulip credentials and never see raw Zulip events.** The gateway holds the Zulip token; it reads your reaction and resolves the ask over a control path the session cannot write — the permission extension's RPC surface, not the conversation transcript. A compromised session can beg for approval but cannot forge it, because your approval only ever travels through the gateway it does not control. Decisions (ask + outcome) are recorded gateway-side so the judge learns your policy over time; that record lives outside every session.

This replaces the old action-review layer cleanly: the gates take its easy cases, the judge *is* its model call, the always-human categories are its policy list. If you would rather not take the dependency, pi's own docs show the minimal homegrown version — a `pi.on("tool_call")` handler reading MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) and confirming the calls Codex asks for — but you would be rebuilding the fail-closed parser and path matching yourself. The judge model sees command content — sometimes financial or personal — so retention matters. Candidates: a tinfoil model (attested enclaves, already in your stack, no retention by construction), a Groq small model (fast; verify current API data terms before trusting it), or an OpenRouter model flagged ZDR — `typesafe/jev-router` exists on OpenRouter (1M context) but its ZDR status is not exposed by the public API; confirm the badge on the model page before routing judge traffic through it.

## Memory and workspaces

"Better memory" and "less separation between coding and answering" are the same design: the workspace is the memory. Sessions write notes, code, and deliverables into the channel's repo; the next topic in the channel starts with that work on disk. Per the design summary:

- **Conventions over ceremony.** The system prompt tells sessions where things go: scratch notes in `notes/` (one file per topic or day), finished writeups in `docs/` (named `YYYY-MM-DD-topic.md`), nothing else at the repo root. Sessions write freely; later sessions find past work by searching the shared filesystem. No topic needs to be "resolved" before its work is saved.
- **Search replaces curation.** Pi Durable gives lossless history search across past conversations (including pre-handoff context); the workspace gives grep over everything ever written; the memory files hold the stable facts. A topic's own transcript is its working memory.
- **User and channel memory stay system-prompt sections** loaded fresh every request (edits propagate to running topics), user memory keyed on Zulip user IDs. Markdown in git remains the source of truth — editable anywhere, diffable, backed up like everything else.
- **How the files update — like any other file.** Memory lives in `memory/` inside the workspace; sessions edit it with their own tools, and the permission system's path rules make the policy a one-liner: writes to `notes/` and `docs/` are free; writes to `memory/` are `ask`, with the judge auto-resolving routine additions and deferring odd ones. Every change is a git commit — the diff is the review surface, revert is `git revert`, and because memory loads fresh per request, an edit reaches every running topic on the next message. (Precedent: the finance repo's `memories.md` already works exactly this way — sessions append one-liners and commit.)
- **User memory is stronger-gated, with visibility.** User memory is mounted into every channel, so a poisoned line would propagate everywhere. User-memory writes therefore never take the judge-only path — they are always-ask, and each accepted change posts a one-line note to that channel's `memory` topic (the design summary's curator inbox reduced to an audit log: see it, don't manage it). Memory poisoning is the injection attack that outlives the session; the gate, the note, and git history are the controls.
- **Concurrent writes are rare and reconciled.** Writes are small appends, and active topics in one channel rarely run at the same moment; when they do, git merges or the tidy pass sorts it out.
- **Sessions sleep when idle** (storage-backed); idle conversations cost nothing, so topics can stay open for weeks without memory pressure.

Phase 1 needs only: user + channel files loaded per request, the `notes/`/`docs/` conventions in the system prompt, handoff notes on `/new`, and `/model` `/compact` `/stop` wired.

## What retires, and what you actually lose

| LibreChat feature | Replacement | Honest gap |
|---|---|---|
| Chat with LLMs (web UI, phone) | Zulip topics → sessions | Different UX: threaded work-chat rather than a chat app — fine for a system with one user; topics, search, per-stream notification control |
| Friends' logins | Nobody else yet | Zulip accounts on your org whenever someone joins (open question 4) |
| Artifacts (in-browser rendered React/HTML) | See the Artifacts section below | Solved in tiers, not lost |
| RAG (upload documents, ask) | Drop the file into the Zulip topic — the gateway stages attachments into the channel workspace, and the session greps/reads the actual file (grep + read beats embeddings at personal scale) | Nearly no gap once the staging hook exists; a large multi-document corpus still wants an index, which a session can build with `uv` when needed |
| Code interpreter | Sessions' own sandboxed bash | Gain, not loss: stateful, full Python/uv, your own packages — this is the "no separate code execution" point |
| Model comparison (OpenRouter endpoint) | `/model` per conversation | Fine for you; family loses the model menu unless you expose it |
| Admin panel | Zulip org admin + box SSH | Fine |

Also retired: the nanobot two-layer guardrail *code*. Layer 1 PromptGuard survives as ingress scanning at the gateway and proxy (Threat model) — upstream of every session, where nothing can bypass it. Layer 2 action review is replaced by the permission layer with its authorizer judge (see Permissions). The garmin-mcp sidecar: either expose it through the proxy to health-channel sessions, or drop it — decide by whether you used it.

## Model routing: the `auto` plan

The default model is GLM-5.3-flash (token-efficient; your `coder` agent already runs `openrouter/z-ai/glm-5.3-flash`), escalating inside a thread when warranted. **Do not build the machinery: pi ships it.** A *virtual model* (`pi.registerVirtualModel()`) is a selectable model — e.g. `router/auto` — whose `route()` function picks the physical model for each request. What you get:

- **Thinking levels as escalation.** `auto:low` → GLM-5.3-flash, `auto:high` → a strong model. The level's meaning is yours to define; it need not be a reasoning budget.
- **Sticky routing.** Tool follow-ups and retries stay on the physical model that handled the turn, which keeps prompt caches and thinking signatures valid.
- **Router state.** JSON state stored per session branch — a `plan`/`build` phase, say — that survives compaction and follows forks.
- **Classifiers inside routing.** A router can call a small classifier on the opening message to decide — this is ChatGPT-style "Auto", exactly.
- **Auditability.** The transcript records every dispatched model, and pi's `/session` lists cost per physical model, so you can see what escalation cost after the fact.

pi ships a complete example, `jev-router.ts`: a classifier picks a strong model for planning, it switches to a cheaper model after the first edit, with the phase kept in router state. Start from it. What remains is policy (open question 2), not machinery.

## Artifacts in the new system

Zulip renders Markdown, tables, and math, and by design never runs HTML or JavaScript in a message. So artifacts become either attachments to messages, or pages a session produces and you open. Four tiers, in build order:

1. **Attach rendered output.** Sessions produce charts (matplotlib), generated images (codemode), PDFs, CSVs; the gateway uploads them with the reply. Covers most "show me" needs.
2. **`mark` as the session's preview loop.** Install `mark` + vivify-server on the session host (remote mode, Tailscale-reached, as in your existing setup) and give sessions a small `mark` skill: the session writes its document, runs `mark docs/memos/foo.md`, and posts the Tailscale URL into the topic. You get the click-to-comment loop you already use for document feedback — comments land in `.comments.md` beside the doc, the session addresses them — with no new software to build. Caddy only enters if previews must leave Tailscale.
3. **Client-side React rendering — the actual LibreChat Artifacts feel.** Keep the self-hosted sandpack-bundler from the old chat box (redeploy it to the gateway box if this tier survives Phase 6), and add a thin viewer page: an artifact message carries a link; the page fetches the artifact's code and bundles it in the browser via Sandpack. Nothing executes on your boxes; the session sandbox is not involved. This is the only real build among the four.
4. **Live dev-server previews.** The session runs a real dev server (Vite, or any static server) in its sandbox; Caddy routes `<topic>.preview.shron.net` to it — TLS terminates on the gateway box and the proxy hop stays on the private network, so the session box keeps no public inbound. Most powerful, and the truest to "power through the workspace"; needs per-URL access tokens, and is worth scoping to Tailscale first (your `mark` preview already runs over Tailscale, so the pattern is known).

**Recommendation:** build tiers 1–2 in Phase 3 (both small); add tier 4 the next time you build anything app-shaped; skip tier 3 unless one-shot replayable artifacts turn out to matter (open question 5). Tier 3 vs 4, since both end in "open a URL": tier 3 renders one-shot artifact code *in your browser* with no server process, so the link outlives the session and replays while it sleeps; tier 4 needs a live dev server per open preview, but gives the real dev loop — HMR, a running backend, everything. Same Tailscale path either way; the difference is process lifecycle, not network.

## Where things run

- **Session box (new) — sandboxed sessions.** No public inbound. Runs the sandboxed session containers, the runner, and the workspaces on an encrypted volume (open question 8). Outbound: the gateway box's private IP, DNS, package registries.
- **Gateway box (new) — trusted services.** Gateway, credential proxy, log service, ingress scanning, memory/workspace git remotes, cron scheduler, Caddy for any public HTTPS (artifact previews).
- **Old chat and code boxes — untouched until Phase 6.** LibreChat and codeapi keep running for the whole build; nothing in Phases 1–5 depends on them and nothing user-facing changes until you cut over. They are backed up and shut down in Phase 6.
- **Zulip Cloud (for now).** The bot polls Zulip's event queue; nothing on your boxes needs an inbound port for it.

The keys/logs-vs-sessions split lands on the two-new-box boundary: a fully escaped session on the session box reaches a network whose only interesting occupant is the proxy built to be talked to by untrusted sessions, and a log service built to accept posts from them.

## Migration plan

Each phase has a verification step. Phases 1–4 build the new system while the old ones keep running; nothing user-facing changes until Phase 5.

### Phase 0 — Decisions (nothing touched)

Decided (2 Oct; recorded so the phases can assume them): Pi Durable as substrate with a thin-interface exit path; the plain-Docker runner with no third-party isolation component; proxy-fronted git; workspace scoping by channel; new boxes for the build with the old ones untouched until Phase 6; Zulip Cloud through the build.

Still open at provision time: finance data residency (open question 8 — does not block Phases 1–4); gateway box size — cx33 if Phase 7 (self-hosted Zulip) is likely, cx22 otherwise.

### Phase 1 — Feel test: interaction and memory, nothing else

> **Status (3 Oct): built, deployed to the code box, and verified end to end** — gateway, session containers, memory model, `auto` routing, search MCP, `/new` handoffs, and restart durability. Runbook and morning steps: `phase1/README.md`.

The point of Phase 1 is to learn whether the Zulip↔session interaction and the memory model feel right — before any security machinery exists. It deliberately runs ahead of the controls in the Threat model; that is survivable because of what Phase 1 omits, not because running bare is safe in general.

- One box only: the session box, provisioned by extending the chat repo's Terraform. Gateway and session run together on it — no proxy, no log service, no egress lockdown, no hardened profile. Plain Docker; real credentials in the environment: a new bot user in the existing Zulip org, the existing LLM key, a Kagi key. (A laptop would be even faster, but the Mac holds the finance repo; a bare box keeps the feel test away from it.)
- Cloud Zulip, a scratch private stream. (channel, topic) → conversation; replies post back; `/new` `/compact` `/stop` `/model` wired.
- The memory model in full: user + channel memory files loaded per request, the `notes/`/`docs/` conventions in the system prompt, handoff notes on `/new`.
- Register the `auto` virtual model: GLM-5.3-flash default, escalation by thinking level (Model routing section).
- Kagi MCP as the only tool beyond pi's own read/bash/edit/write.
- **Verify:** a conversation in a scratch topic answers, follows the memory conventions, and survives a gateway restart. Memory edits show up on the next message. `/session` shows what the auto model spent.
- **Rules that make running bare acceptable:** no email, no finance repo, no deploy keys, no browsing MCP. Kagi search results are the only untrusted text entering a session, and that is as far as ingestion goes. When Phase 2 lands, rotate everything Phase 1's sessions could have seen: the bot key and the API keys in their environment.

### Phase 2 — Harden: two boxes, proxy, permissions, logging

Everything Phase 1 skipped arrives here — against a system you already like using, which is the point of the order.

- Second box: the gateway box. Move the gateway onto it; give the session box the hardened container profile and the egress rules (gateway box private IP, DNS, package registries).
- Credential proxy in front of every upstream; the pi provider re-pointed at it; log service recording events via a pi extension.
- The permission system active with the authorizer judge (Permissions section); asks resolved through the gateway control path; blocks surfaced in a topic.
- Proxy-fronted git for workspaces and memory; branch protection on remotes; rotate the Phase 1 credentials.
- **Verify:** `env` inside a session shows no keys — only proxy URLs. An egress attempt to an unlisted host fails. A benign-but-blocked action is refused and reported. A `memory/` write lands as a git commit behind the gate.

### Phase 3 — Tools, guardrail, finance, and artifacts

- Email, search, and finance MCP routed through the proxy, with ingress scanning on open-world responses (Threat model). Per-channel workspace repos created and mounted, scoped per the Workspace scoping rule.
- The finance channel: workspace = the finance repo; the month-end review becomes a topic.
- Artifact tiers 1–2 from the Artifacts section: uploads with replies; `mark` installed on the session host with the skill wired.
- **Verify:** a session in `#research` cannot see the finance repo. A benign-but-blocked test action is refused, logged, and reported; a borderline ask is auto-resolved by the judge; a money-adjacent ask reaches the topic instead. The finance session proposes a categorization rule and waits for your in-topic approval. A chart attached to a reply renders in Zulip, and the same artifact's HTML opens from the posted link.

### Phase 4 — Cron

- SimpleFin fetch, pipeline build, journal targets as host cron/systemd timers, committing and pushing.
- Cron-spawned topics with period-encoded `requestId` (the design summary's `finance-cleanup:2026-10` pattern).
- Dead-man alerts to a Zulip topic when a job misses.
- **Verify:** trigger the same cron job twice by hand; the second run dedupes. Kill a job; the alert arrives.

### Phase 5 — Adoption and user cutover

- You move daily use to Zulip. LibreChat runs in parallel until you stop opening it; Zulip invites only matter when a second user exists.
- **Verify:** two weeks of daily use without needing to fall back.

### Phase 6 — Retirement

- Destroy the three Fly apps (the nanobot bot has been idle since Phase 3 — use a *new* bot user for the gateway from the start, since two pollers on one Zulip user double-respond).
- Back up and shut down the old chat and code boxes entirely: a final Mongo backup to the existing Hetzner Object Storage bucket, then LibreChat, codeapi, and the boxes themselves go.
- Move the log service's history and nanobot's `MEMORY.md` into the new memory repo (a real curation task — read it, keep what is true, discard what is stale).
- **Verify:** billing shows Fly and the old two boxes gone; backups for logs + all repos exist in Object Storage/git remotes.

### Phase 7 (optional, later) — Self-host Zulip

See open question 3 — docker-zulip on the gateway box is the documented path. Only after the system is stable; not coupled to this migration.

## Major open questions

1. **Permission policy and the judge.** The mechanism is settled: `@gotgenes/pi-permission-system` for allow/ask/deny, its `authorizerChain` for the light-model judge that auto-resolves asks (see Permissions). The work is policy: the ask-categories — email sends, outbound writes, `git push`, anything money-adjacent, which should be always-human and never judge-resolved — and the judge's model — cheap, fast, low-retention (see Permissions for the candidates and the ZDR caveat). Noise is the failure mode: a judge consulted too often gets switched off. Decide empirically in Phase 3.
2. **Escalation policy for `auto`.** The machinery is free (Model routing section); the policy is the work. Escalate on the explicit thinking level, on a classifier's read of the opening message, on signals like tool-loop length? De-escalate when? Start from the simplest rule set and let `/session`'s per-model costs show what it costs. Decide during the Phase 1 feel test.
3. **Zulip Cloud or self-host?** The data-access facts, from Zulip's own policy pages: on Zulip Cloud, all messages and file uploads rest on Kandra Labs' disks. TLS in transit, no end-to-end encryption, and the hosting operator can in principle read content — their privacy policy commits to not selling data and they publish a DPA and subprocessor list, but that is a promise, not a cryptographic boundary. The LibreChat-plus-tinfoil posture you had — chat content opaque even to the operator — does not survive Zulip Cloud. Two responses: (a) keep sensitive detail out of message bodies — sessions write numbers into workspace files and post summaries or `mark` links instead — a convention that costs little and composes with the artifact tiers; or (b) self-host Zulip and regain the old posture.

   The self-host option, researched ([zulip/docker-zulip](https://github.com/zulip/docker-zulip)): it is the **official** image, current (`ghcr.io/zulip/zulip-server:12.3`), compose-based, maintained in Zulip's own org, and needs root (no rootless Docker — it raises `ulimit`s). Zulip's own caveat: Docker "moderately increases the effort required to install, maintain, and upgrade" versus their standard installer on a bare VM, and they recommend ≥2 GB RAM for a production server (a single-user org sits far below it; the dependent containers — postgres, memcached, redis — can be capped hard). It fits this stack exactly: compose, Caddy, the secrets pattern, and `pg_dump` to the existing Object Storage bucket, same as the old Mongo backup. Recommendation: Cloud through the build with the content convention from day one; at Phase 7, docker-zulip on the gateway box (sized cx33 from the start) is the path, with the standard installer on a third box as the alternative if compose upkeep ever annoys. The trigger is privacy, not price.
4. **When someone else joins.** Identity is settled (assumption 6): Zulip users, Zulip-keyed memory, channel membership as the access boundary. What remains open is power — a new user gets the same sandboxed full-tools sessions as you, or a restricted corner — and the permission system's per-user config is the natural place to draw that line.
5. **Which artifact tiers do you actually need?** Only your own usage matters now. Check your LibreChat history before Phase 5: if you rarely made React artifacts, tiers 1–2 cover you and tier 3 never gets built; if you lived in them, build tier 3 early. Dev-server previews (tier 4) are the long-run answer regardless.
6. **Git credentials and remote protection.** The three shapes are laid out under Credential starvation. The open part is where the memory and workspace repos live — gateway-box bare repos vs GitHub — and therefore where branch protection and force-push rejection are enforced. Decide in Phase 2, before sessions can push.
7. **Phone/SMS reach.** The design summary leaves open whether a phone conversation shares context with Zulip (OpenClaw-style) or stays separate. Deferred — but the thin interface in Phase 1 should not preclude either.
8. **Finance data residency.** Carried over from the previous version of this memo and still unresolved: full move to the session box behind an encrypted (LUKS) volume, split (pipeline on the box, statements and interactive work on the Mac), or stay on the Mac entirely. The data is already off the Mac via git and SimpleFin; the marginal question is at-rest copies on a disk you control. Blocks Phase 3 only for the finance channel.

## Areas to think about more deeply

**Power through workspace, not credentials.** This is the design principle that makes "more power, less separation" safe, and every component follows from it: git-deploy keys are scoped, the LLM key lives in the proxy, egress is a chokepoint, work is versioned. When a new capability is wanted later, the question is not "what tool do we give the session" but "what repo do we mount, and what proxy route does it get."

**One interface is one failure domain.** When Zulip is down — theirs or yours — you lose the agent, the family chat, and the cron alerts, all at once. You still have SSH; your family has nothing. Two mitigations worth weighing: keep cron dead-man alerts on a second channel (email, or a tiny probe posting to a different service), and if you self-host Zulip later, its monitoring must not depend on the agent.

**Clutter is the memory risk now.** The curator was the design summary's answer to consolidation; the decided model — conventions plus search — drops the ceremony and inherits the failure mode instead: `notes/` and `docs/` nobody tidies, where the fifth session re-derives what the first wrote because search returned too much. Two cheap guards: a periodic tidy topic per channel (a flash-model pass that merges duplicate notes and reports what it touched), and user/channel memory files small enough that hand-curation stays trivial. Watch for the quiet failure the design summary flagged — memory that exists but is ignored. Test memory the way you would test search: by asking questions weeks later and seeing what comes back.

**Everything becomes git.** Memory, workspaces, finance rules, code — the consolidation quietly makes git the system of record for your entire digital life at rest. One backup story (remotes + Object Storage), one audit story (history), one integrity story (append-only discipline where it matters). It also concentrates: a future where a hostile commit matters more than a hostile container. Remote-side protection (question 6) is the control; give it the seriousness you currently give container hardening.

**Single-provider concentration, again.** One Hetzner account now holds the interface (if self-hosted Zulip later), the engine, the data, and the backups; one 1Password account is the keys to all of it. This was true in the previous plan and remains true; it is the price of consolidation and worth stating once, plainly, rather than rediscovering.

## Sources reviewed

- `persistent-agent-design-summary.md` (this repo) — the specification this target implements: Pi Durable, (channel, topic) → conversation, three memory levels, curator, cron topics, slash commands
- `~/code/chat` — box facts (IPs, specs, no-KVM constraint), secrets pattern, tinfoil routing, Object Storage backups
- `~/Documents/Research/polynumeral-assistant` — the surviving components: credential proxy, log service, action review; the retiring: nanobot wrapper, Fly deployment
- `~/finance` — pipeline, append-only discipline, MCP server, memories; the finance channel's future workspace
- pi 1.0.0 docs (`custom-provider`, `sdk`, `extensions`, `cli-integration`) — the integration points the target depends on: proxied providers, embedded gateway, log/review hooks, cron-mode runs
