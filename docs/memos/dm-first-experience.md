# DM-first: a Dots/Instinct/Muse experience on the Zulip DM

> **Point of this memo:** The single-thread "text your assistant" experience does not need a new front door. It is a feature set on the Zulip DM the gateway already runs — one front conversation per person, task subagents that a person can watch but does not have to, memory the person can see and edit, and a little proactivity. The owner's proposal is adopted as the core shape: **one work channel per person where task conversations live as topics; the DM stays the default surface.** Most features reuse machinery that exists (spawn, spoilers, uploads, memory, permissions); the genuinely new parts are a synchronous `run_task` that returns its answer to the DM, per-person workspaces and memory, and a small set of chat commands. This memo decomposes what Dots, Muse, and Instinct actually deliver, maps each element to what we have, and gives a build order with verification steps. Product details of the three named apps come from secondary coverage; treat them as a snapshot.

## What the reference products' experience consists of

Strip away the branding and the three products deliver overlapping features:

| Feature | Dots | Instinct | Muse |
|---|---|---|---|
| One continuous thread per person (the relationship lives there) | Yes | Yes (iMessage/WhatsApp/calls) | Yes (WhatsApp) |
| Tasks delegated to separate work sessions the user rarely sees | Yes (main conversation manages, task conversations work) | Requested by early users (per-job threads) | — |
| A persistent "computer" per person (files and installs accumulate) | Yes | Yes (persistent cloud computer) | — |
| Memory the person can inspect and correct ("forget X") | — | Yes | Yes (remember/forget) |
| Proactivity (agent-initiated messages: done, reminders, digests) | Yes | Yes | Yes |
| Deliverables returned in-band (files in the chat) | Yes | Yes | Yes |

None of these depend on the transport. All of them can live in a Zulip DM.

## The shape: DM-first, with a per-person work channel

- **Front conversation.** One DM conversation per person, continuous, never auto-reset. It carries the relationship: memory, preferences, task ledger, small talk, triage. This is what a DM already is today — the change is policy (per-person, not per-DM-group) and the tools below.
- **Work channel.** One private stream per person, e.g. `#max-work` and `#<wife>-work`, created and the bot invited like any stream (membership-driven; `channels.json` needs no change). Every delegated job runs as a **topic** there. The person is a member and can browse, reply inside a task topic to steer it, or mute the stream — but nothing requires them to look.
- **Division of labor.** The DM triages, delegates, and reports. Task conversations do the work, post their progress and tool-call spoilers in their topics, and hand back results. This is the Dots model, with Zulip topics as the visible task conversations — and it reuses machinery that already works: `spawn_thread` creates conversations from a tool call, the gateway runs tasks in child conversations and posts replies there, and `naming.js` auto-names topics with the small model.

The one structural change to spawn: today `spawn_thread` is fire-and-forget and gated off in DMs. The DM's version — call it `run_task` — does three things differently: it spawns into the person's work stream (not the current channel), it **waits for the child's answer and returns it as the tool result** (the pi-durable subagent pattern: task-owned child, `submit` + `wait`, abort cascades, crash-rerun finds the same child), and it hands back any output files so the gateway can attach them to the DM reply. Fire-and-forget is supported too (decided in review): jobs that do not block a reply run in the same target stream, and their result arrives later as a proactive DM message, deduped by `requestId` so a crash-rerun cannot double-post.

**Why the work channel earns its keep beyond taste:** it gives long jobs somewhere to be noisy without polluting the DM (progress posts, spoilers, retries), it gives the person *optional* depth (open the topic, watch the work, steer it in place — which is the thing early Instinct users asked for), and it keeps the DM's context small, which is the real currency of a front thread.

## Feature by feature: what exists, what is new

1. **Single continuous thread.** DM support is built (uploads, spoilers, reactions, commands, asks all work there). New: key the front conversation and its workspace on the person, not the DM group, so later entryways feed the same thread. Moderate, mostly routing.
2. **Task delegation.** New tool `run_task` as described above. The largest single build item, and it is the pi-durable README's own example plus the existing spawn machinery. *Verify:* the .docx walkthrough from `single-thread-family-agent.md`, with the APA work visible as a `#<wife>-work` topic and the file returning as a DM attachment.
3. **Deliverables in-band.** Outbound file upload with a DM reply (upload API call; inbound staging already exists). Small.
4. **Persistent computer.** One workspace per person (`workspaces/<person>/`), mounted into both the DM conversation and her task conversations; tasks work under `tasks/<task-name>/`, uploads land in `uploads/`, outputs accumulate. The front conversation can find last week's document by search (files on disk) or `history_search` (transcripts). No new machinery — a `workspaceDir` change keyed on person.
5. **Visible, correctable memory (the Muse feature).** Memory files are already markdown, loaded fresh per message, edit-gated. What DMs add is the *interface*: front-session instructions that "remember that" / "actually, forget the part about X" map to edits of that person's memory file, and a `/memory` command that posts the current file contents. Every write keeps its ask-gate and lands as a diff the person just approved — memory the person can audit is the point. Small: instructions plus one command.
6. **Chat commands.** `/new` `/stop` `/model` exist. Add `/tasks` (list this person's open and recent task topics, from the durable doc index) and `/memory`. Small.
7. **Proactivity — from day one (changed in review).** Two tiers, both through the existing durable-submit path with `requestId` dedup: (a) task completion — the front conversation posts the result to the DM without being asked (this falls out of `run_task`); (b) scheduled/initiated — cron-spawned submissions (reminders, dead-man alerts, and the nightly memory-consolidation turn described below) DM'd or run silently in the front conversation. The policy stands even though both tiers ship early: *initiate only to deliver a result, an approved reminder, or a scheduled pass.* Rate-limit agent-initiated messages at the gateway so a bug cannot text-storm anyone.
8. **Voice notes (Instinct's calls).** Later tier: Zulip DMs accept audio-file uploads, so inbound voice notes transcribed by a model and outbound TTS are possible without a new transport. Not in the build plan; noted so the DM-first design does not preclude it.

## The long thread: compaction, and the memory model we adopt

A front conversation that never resets grows without bound, so compaction is not an edge case here — it is the normal operating mode of the DM. Three pi-durable facts make it safe:

1. **Compaction is invisible.** It runs as a background task; the conversation keeps working, and the summary is placed when idle or at the next turn boundary. The person never sees a ceremony.
2. **Nothing is deleted.** Older entries stay in storage, so `history_search` reaches pre-compaction turns indefinitely (scoped to the person once keying is per-person).
3. **The summary carries instructions.** `compact(instructions)` lets the gateway pass standing guidance for front conversations — keep open commitments, standing preferences, task state — and a `beforeCompact` hook can decline or replace a summary.

The load-bearing decision, learned from both reference products: **memory does not live in the transcript.** It lives in workspace files, injected as system-prompt sections read fresh on every request (the gateway's `memorySection` already works this way). Compaction rewrites the transcript; it cannot touch the sections. This is the fix for Hermes's reported bug, where post-compaction memory was labeled "background reference" and the agent ignored it — our memory is not appended reference material, it is live context on every request.

What we adopt from each product:

- **OpenClaw — adopt the whole shape.** `dmScope: main` (one main session per person, every private transport feeds it, groups isolated) is the person-keyed front conversation. No auto-reset; compaction bounds context; resets only on command. Its best trick is the **durable-notes turn**: just before a compaction or reset, a silent "write durable notes now" pass extracts facts into memory before the tail is summarized away. We adopt it with a pi-durable-native twist: the gateway watches `compaction_end` events and submits a silent consolidation turn after a compaction lands — and because compacted entries stay in storage, the same pass can instead run on a nightly cron and read the pre-compaction range through `history_search`. The nightly option is recommended; it doubles as the scheduled-proactivity anchor. On `/new`, OpenClaw saves the ending conversation's tail as notes and re-primes the next context — pi-durable's `reset()` with a handoff note, already wired.
- **Hermes — adopt the lessons, reject the model.** Reject its session key (platform + chat ID gives the same person two sessions and two memories — exactly what person-keying avoids). Take two lessons: memory must survive compaction as *active* context (solved by construction above), and memory files stay small, curated, and never auto-compacted — the size cap is what forces consolidation. Its "recall loop rarely fires" in long sessions is the argument for explicit recall (`history_search`, grep over files) over hoped-for behavior.

Mapped to our three levels: user memory per person (`memory/users/<person>.md`, always ask-gated, diff posted in the DM), channel memory per work stream, and topic memory as the conversation itself plus handoff notes. The daily-journal role is played by the task ledger and `notes/` files in the person's workspace. Automatic background compaction runs with the shipped settings (`reserveTokens`, `keepRecentTokens`); the person never configures anything. The acceptable cost of a compacted front thread: a follow-up that leaned on a compacted detail gets answered from memory or search instead of verbatim context — and real work happens in task conversations with fresh contexts anyway.

## Security and policy deltas

1. **Per-person isolation.** A task conversation mounts only its person's workspace. A poisoned document processed for one person cannot touch another person's files or memory — the same workspace-scoping rule as channels, now keyed on people.
2. **Per-person memory and permissions.** The memory restructure from `single-thread-family-agent.md` is required here (one shared `user.md` per channel breaks with two people): `memory/users/<person>.md` plus a per-person permission profile. The second user's profile is stricter: money-adjacent and outbound-send actions always-human, asks resolved in her DM, never judge-resolved.
3. **Approval integrity unchanged.** Asks surface in the DM; sessions never hold Zulip credentials; reactions/replies resolve over the gateway control path. The 20-minute auto-deny already matches a texting rhythm.
4. **Prompt injection from documents.** Document contents are untrusted text in a task session with bash. Existing defenses compose (scoped workspace, credential starvation, permission gates); the task instructions should state it plainly: the document's text is data, not instructions.
5. **Proactivity is an attack surface.** An agent that initiates messages can be steered by injected content into spamming or phishing-shaped texts. Because both proactivity tiers ship early (review change), the controls are day-one, not later: initiation limited to results, approved reminders, and scheduled passes; a gateway-side rate limit on agent-initiated messages; and quiet hours before any digest-like feature.

## Build order

1. **Person-keyed front conversations and workspaces.** Route DM conversations and workspaces by person; create `#<wife>-work`, invite the bot, invite her, let her mute. *Verify:* her DM sees only her memory; her uploads persist across `/new`.
2. **`run_task` with the work-stream target and synchronous result; fire-and-forget background tasks; DM reply attachments.** *Verify:* the .docx walkthrough end to end; a crash mid-task reruns without duplicating the topic or the reply; `/stop` in the DM kills the task and its topic goes quiet; a background job's late result arrives exactly once as a proactive DM.
3. **Scheduled proactivity and the consolidation turn (moved up in review).** Cron-spawned submissions with period-encoded `requestId`s (`reminder:...`, `consolidate:2026-10-27`); the nightly memory-consolidation pass writing gated diffs; the gateway rate limit and quiet hours. *Verify:* an approved reminder fires once; a deliberate double-submit dedupes; the consolidation turn reads pre-compaction history and proposes memory edits; the rate limit holds when a task is made to fail loudly.
4. **Memory interface and `/tasks` `/memory`.** *Verify:* "remember I prefer…" produces a gated diff; "/memory" shows it; "forget that" removes it; a task session in her work stream sees the amended memory on its next message.
5. **Skills loop (from the prior memo) over this shape.** *Verify:* second citation job proposes the skill; feedback amends it; third job loads it — all observed from the DM.

Out of scope until wanted: voice, digests beyond reminders, other entryways (the person-keying in step 1 is what keeps them open).

## Open questions

Decisions closed in review: per-person work streams with the person invited and free to mute; fire-and-forget background tasks supported with proactive result delivery; scheduled proactivity in the initial build.

1. **Proactivity scope and quiet hours.** Results, approved reminders, and scheduled passes are settled. What remains open is everything beyond that: morning digests, proactive suggestions. Decide by feel after the first two tiers have run for a while.
2. **Consolidation cadence.** Nightly (recommended — it reads pre-compaction entries from storage, so nothing is lost by waiting) vs. after-compaction-only (event-driven, but a chatty person compacts often and gets many small passes).
3. **Task ledger location:** a markdown file in the person's workspace (grep-able, person-visible, backed up with everything else) vs. a durable document. The file is recommended — it is also what the skill-recurrence instructions and the nightly consolidation pass read.

## Implementation (as built, 12 Nov 2026)

The build order's steps 1–4 shipped in one gateway change (the skills loop, step 5, remains). As-built deltas from the plan:

1. **Work streams resolve without config for owners.** A `people` entry in channels.json (email → stream name) wins; an owner without one gets an auto-derived `<first-name>-work` stream, created, joined, and invited on first `run_task`. Anyone else fails closed: delegation needs a `people` entry.
2. **The shared workspace is a channel-level override**, not a new workspace scheme: a work stream's conversations mount the person's DM workspace (files, uploads, memory, conventions). Skills stay per-stream. Task conversations therefore read and write the person's memory — which is why the memory gate below had to be global.
3. **The memory gate is a new `paths` permission surface** (`write`/`edit` on `memory/*` → ask, in the global block): it covers the DM front conversation *and* task conversations. Residual gap: a bash write to memory bypasses it — the gate is tamper-evidence, not a hard boundary. The wife's asks will post in the work topic; until her permission profile lands (step 5), only owners can resolve them.
4. **The consolidation pass proposes, never writes** (a 5am ask that auto-denies would be worse): it lists edits, the person confirms in chat, the session applies them through the ask gate. Scheduled passes run quiet — spoilers suppressed — and `CONSOLIDATE_HOUR` (default 5) and `PROACTIVE_LIMIT_PER_HOUR` (default 8) are env-tunable.
5. **Task conversations run the flash model** unless the front conversation pinned strong (`/model strong`); the fire-and-forget path gets the auto-classifier like any spawned thread. Their instructions are the stream ones ("Max's personal assistant") — generic wording when the second user arrives is part of step 5.
6. **Existing DM conversations are migrated at boot**: the person field is backfilled, and tools/instructions are reconfigured (they are fixed at creation) — without this, the flagship DM would never have offered `run_task`.
7. **Provider errors never post raw** (added after the first live 502): an upstream gateway can wrap a transient 5xx in a completed message, so the harness's retry policy never classifies it and the raw `litellm.BadGatewayError` text arrives as the reply. The gateway now recognizes error-shaped replies at every posting choke point, retries the front conversation's turn once automatically (crash-rerun safe via a `:r1` requestId), and otherwise posts a one-line "the model service failed — send it again" notice. Task failures post the notice in the topic and the DM report says the task failed. Residual: task conversations do not auto-retry; the person is offered a rerun.

Verified by `node --check` over every touched file and the extended contract script (20 checks; path rules, dm tool fallback, dm permission fallback, people entries) plus the permissions smoke run. The .docx walkthrough and the live work-stream flows (auto-creation, sync wait, background report, consolidation) need the box: they are the deploy's acceptance tests.

## Sources reviewed

- `phase1/gateway/`: gateway.js (DM routing, ask resolution, approval integrity), lib/tools.js (spawn_thread/fork_thread), lib/naming.js (topic auto-naming), lib/sections.js (memory, skills listing), lib/provision.js (workspace skeleton).
- pi-durable README (installed package, v1.0.4): task-owned subagent conversations, foreground/background patterns, abort and rerun semantics.
- Persistent-agent design summary (2 Oct): Dots/Instinct/Muse feature survey, OpenClaw main-session model, memory levels.
- docs/memos/single-thread-family-agent.md: the flagship walkthrough, skill loop, security deltas this memo builds on.
