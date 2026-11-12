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

The one structural change to spawn: today `spawn_thread` is fire-and-forget and gated off in DMs. The DM's version — call it `run_task` — does three things differently: it spawns into the person's work stream (not the current channel), it **waits for the child's answer and returns it as the tool result** (the pi-durable subagent pattern: task-owned child, `submit` + `wait`, abort cascades, crash-rerun finds the same child), and it hands back any output files so the gateway can attach them to the DM reply. Fire-and-forget stays available for jobs that do not block a reply ("set up a weekly reminder"), using the same target stream.

**Why the work channel earns its keep beyond taste:** it gives long jobs somewhere to be noisy without polluting the DM (progress posts, spoilers, retries), it gives the person *optional* depth (open the topic, watch the work, steer it in place — which is the thing early Instinct users asked for), and it keeps the DM's context small, which is the real currency of a front thread.

## Feature by feature: what exists, what is new

1. **Single continuous thread.** DM support is built (uploads, spoilers, reactions, commands, asks all work there). New: key the front conversation and its workspace on the person, not the DM group, so later entryways feed the same thread. Moderate, mostly routing.
2. **Task delegation.** New tool `run_task` as described above. The largest single build item, and it is the pi-durable README's own example plus the existing spawn machinery. *Verify:* the .docx walkthrough from `single-thread-family-agent.md`, with the APA work visible as a `#<wife>-work` topic and the file returning as a DM attachment.
3. **Deliverables in-band.** Outbound file upload with a DM reply (upload API call; inbound staging already exists). Small.
4. **Persistent computer.** One workspace per person (`workspaces/<person>/`), mounted into both the DM conversation and her task conversations; tasks work under `tasks/<task-name>/`, uploads land in `uploads/`, outputs accumulate. The front conversation can find last week's document by search (files on disk) or `history_search` (transcripts). No new machinery — a `workspaceDir` change keyed on person.
5. **Visible, correctable memory (the Muse feature).** Memory files are already markdown, loaded fresh per message, edit-gated. What DMs add is the *interface*: front-session instructions that "remember that" / "actually, forget the part about X" map to edits of that person's memory file, and a `/memory` command that posts the current file contents. Every write keeps its ask-gate and lands as a diff the person just approved — memory the person can audit is the point. Small: instructions plus one command.
6. **Chat commands.** `/new` `/stop` `/model` exist. Add `/tasks` (list this person's open and recent task topics, from the durable doc index) and `/memory`. Small.
7. **Proactivity.** Two tiers, both through the existing durable-submit path with `requestId` dedup: (a) task completion — the front conversation posts the result to the DM without being asked (this falls out of `run_task`); (b) scheduled/initiated — cron-spawned submissions (morning digest, reminders, dead-man alerts) DM'd to the person. Start with (a) only, plus a rule in the front session's instructions: *never initiate except to deliver a result or an approved reminder.* Rate-limit agent-initiated messages at the gateway so a bug cannot text-storm anyone. Moderate, mostly policy.
8. **Voice notes (Instinct's calls).** Later tier: Zulip DMs accept audio-file uploads, so inbound voice notes transcribed by a model and outbound TTS are possible without a new transport. Not in the build plan; noted so the DM-first design does not preclude it.

## Security and policy deltas

1. **Per-person isolation.** A task conversation mounts only its person's workspace. A poisoned document processed for one person cannot touch another person's files or memory — the same workspace-scoping rule as channels, now keyed on people.
2. **Per-person memory and permissions.** The memory restructure from `single-thread-family-agent.md` is required here (one shared `user.md` per channel breaks with two people): `memory/users/<person>.md` plus a per-person permission profile. The second user's profile is stricter: money-adjacent and outbound-send actions always-human, asks resolved in her DM, never judge-resolved.
3. **Approval integrity unchanged.** Asks surface in the DM; sessions never hold Zulip credentials; reactions/replies resolve over the gateway control path. The 20-minute auto-deny already matches a texting rhythm.
4. **Prompt injection from documents.** Document contents are untrusted text in a task session with bash. Existing defenses compose (scoped workspace, credential starvation, permission gates); the task instructions should state it plainly: the document's text is data, not instructions.
5. **Proactivity is an attack surface.** An agent that initiates messages can be steered by injected content into spamming or phishing-shaped texts. The initiation policy (results and approved reminders only, rate-limited gateway-side) is the control; revisit before adding digests.

## Build order

1. **Person-keyed front conversations and workspaces.** Route DM conversations and workspaces by person; create `#<wife>-work`, invite the bot. *Verify:* her DM sees only her memory; her uploads persist across `/new`.
2. **`run_task` with the work-stream target and synchronous result; DM reply attachments.** *Verify:* the .docx walkthrough end to end; a crash mid-task reruns without duplicating the topic or the reply; `/stop` in the DM kills the task and its topic goes quiet.
3. **Memory interface and `/tasks` `/memory`.** *Verify:* "remember I prefer…" produces a gated diff; "/memory" shows it; "forget that" removes it; a task session in her work stream sees the amended memory on its next message.
4. **Skills loop (from the prior memo) over this shape.** *Verify:* second citation job proposes the skill; feedback amends it; third job loads it — all observed from the DM.
5. **Scheduled proactivity.** *Verify:* an approved reminder fires once; a deliberate double-submit dedupes; the rate limit holds when a task is made to fail loudly.

Out of scope until wanted: voice, digests beyond reminders, other entryways (the person-keying in step 1 is what keeps them open).

## Open questions

1. **Stream naming and membership.** `#<name>-work` per person invites name sprawl in the sidebar for streams the person may never open. Alternative: one shared `#work` stream with topics prefixed by person, at the cost of cross-person visibility. Recommend per-person streams (private; only that person and the bot are members); confirm with the first second user.
2. **Should the person be subscribed at all?** Inviting them means a sidebar entry they may mute; not inviting means the DM's topic links are dead links. Recommend: invite, and let them mute.
3. **Fire-and-forget tasks in the DM:** whether the front session may start background jobs whose results arrive later as proactive messages, or whether every task must block its reply. The durable background-subagent pattern supports both; policy is a feel question.
4. **Task ledger location:** a markdown file in the person's workspace (grep-able, person-visible, backed up with everything else) vs. a durable document. The file is recommended — it is also what the skill-recurrence instructions read.

## Sources reviewed

- `phase1/gateway/`: gateway.js (DM routing, ask resolution, approval integrity), lib/tools.js (spawn_thread/fork_thread), lib/naming.js (topic auto-naming), lib/sections.js (memory, skills listing), lib/provision.js (workspace skeleton).
- pi-durable README (installed package, v1.0.4): task-owned subagent conversations, foreground/background patterns, abort and rerun semantics.
- Persistent-agent design summary (2 Oct): Dots/Instinct/Muse feature survey, OpenClaw main-session model, memory levels.
- docs/memos/single-thread-family-agent.md: the flagship walkthrough, skill loop, security deltas this memo builds on.
