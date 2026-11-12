# Single-thread family agent: texting entryways, a session manager, and self-authoring skills

> **Point of this memo:** The Zulip problem is an interface problem, not an engine problem. The engine we built — a pi-durable Harness that owns every conversation, one exec container per conversation, uploads, memory, skills — is exactly the substrate a "text your assistant" product needs. The proposal: keep the engine, add an entryway layer (Signal first, local chat later), and change the routing policy from "one Zulip topic = one conversation" to "one person = one front conversation; one job = one headless task conversation" (the Dots model, self-hosted). The flagship use case — text a .docx, get the APA-fixed .docx back, and watch the system write a skill for it on the second occurrence — needs three new pieces, all small: a Signal adapter, a `run_task` subagent tool (pi-durable ships the pattern), and a gated `save_skill` tool with a curation policy. This memo covers the research, the design, what each piece would take, and the risks. Signal is unofficial-client territory; that risk is stated plainly below.

## The problem with Zulip, stated precisely

Zulip gives us topics, threads, reactions, uploads, and an event queue — but to a family member it presents as *another chat app where you talk to an AI*. The parts that make it a good operator surface (streams, topics, per-channel workspaces) are invisible to a non-technical user, and the parts that are visible (type a message, get a reply) are the same as every AI chat product. The result: no differentiation the user can feel, plus an install-and-account hurdle.

What actually differentiates this system is the engine: real sandboxed sessions with bash, files, memory, search, skills, and durable history — reached through a phone's *existing* messaging app. Instinct (one continuous thread over iMessage/WhatsApp, on a persistent cloud computer), Muse (WhatsApp), and OpenAI's Dots (one main conversation that manages; separate task conversations that do work) all bet on this shape. Dots is the closest to what we want, and its model is the one to copy: **the front conversation is the relationship; task conversations are the hands.**

## What changes, what does not

| | Today (Zulip-primary) | Proposed (single-thread primary) |
|---|---|---|
| Unit of conversation | (stream, topic) pair | One front conversation per person; one task conversation per job |
| Front surface | Zulip app (install, account) | Signal (already on phones); local chat later |
| Task work | A spawned Zulip topic the user can see | A headless pi-durable conversation; user sees only the result |
| Engine | pi-durable Harness, DockerExecutionEnv | Unchanged |
| Memory | Channel + user files per workspace | Per-person user files + shared family memory (restructure, see below) |
| Skills | Read-only layers, installed by hand | Same layers, plus agent-authored via a gated tool |
| Operator surface | Zulip (#meta, push approvals, topics) | Unchanged — Zulip stays as *our* dev surface |

The design answers the old open question 7 (phone reach) in the OpenClaw direction: one front conversation per person, shared across entryways. A Signal message, a local chat message, and (if kept) a Zulip DM all feed the same front conversation for that person. Early Instinct users asked for separate threads per job; headless task conversations give us that without cluttering the front thread — the user never sees a "topic" unless they ask for one.

## What the engine already provides (research findings)

This section is the load-bearing fact of the memo: most of the "global session manager" already exists in shipped code.

1. **The Harness is the session manager.** `phase1/gateway/gateway.js` hosts one pi-durable Harness over JSONL storage; every conversation is durable, checkpointed, exactly-once by `requestId`, forkable, and searchable. The gateway already routes two shapes of front conversation (stream topics and DM groups — a DM group is one continuous conversation, which *is* the single-thread model).
2. **Subagents are a shipped pi-durable feature, not new design.** The pi-durable README documents task-owned conversations: a tool creates a child inside `api.commit()` with `ownership: { kind: "task", taskId: api.taskId }`, submits work to it, and returns its answer as the tool result. Aborting the parent aborts the child; a `replay: "safe"` tool plus the ownership index makes crash-rerun find the same child. Foreground (tool waits for the answer) and background (child posts results back to the parent as follow-up inputs) both have example code in the package. `spawn_thread` in `lib/tools.js` already creates conversations from inside a tool call — the headless variant is *simpler*, because it posts nothing to any chat surface.
3. **Execution isolation is per conversation.** `DockerExecutionEnv` builds one exec container per conversation from its ID, mounting that conversation's workspace. A task conversation gets its own container and its own scratch directory by construction. Container spin-up (~100–500 ms plus Node boot) is well inside texting latency.
4. **File ingestion already exists.** Zulip uploads are downloaded into the channel workspace's `uploads/` before the turn starts. The Signal adapter needs the same staging step for inbound attachments.
5. **Skills are plain directories, listed per request.** `skillsSection` re-reads `SKILL.md` frontmatter on every message and mounts are live bind mounts, so a new skill directory is visible to the next message without a gateway restart (the `install.sh` comment says restart on add/remove; verify this at build time — if the listing is live, and it appears to be, no reload hook is needed).

So the session manager, the task sandbox, and the skill discovery mechanism are all in hand. What is genuinely new: the Signal adapter, the per-person front-conversation policy, the `run_task` and `save_skill` tools, and a per-user memory restructure.

## Entryway research

### Signal (recommended first entryway)

**Mechanism:** [signal-cli](https://github.com/AsamK/signal-cli) (AsamK), the unofficial Java Signal client. It runs as a daemon in JSON-RPC mode (`signal-cli jsonRpc`, stdio or a TCP/unix socket); the gateway connects and receives `receive` messages as they arrive — the same poll-the-queue shape as the Zulip bridge, no inbound ports. Commands cover everything we need: `send` (with attachment file paths), reactions, typing indicators, read receipts, groups. Inbound attachments land as files in signal-cli's data directory; the event gives their paths, and the gateway stages them into the task workspace. Outbound, the gateway hands the produced file's host path to `send`. Signal's attachment limit (100 MB) is far above any .docx we will see. A community REST/websocket wrapper ([signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api)) exists if we want HTTP instead of raw JSON-RPC; it is the same engine underneath.

**Registration:** the bot needs a phone number. Two paths:

- *Primary registration* (`signal-cli -u NUMBER register`): needs an SMS or voice verification code (a spare SIM, or a Twilio number that receives SMS; Signal sometimes demands a captcha challenge, which signal-cli supports via a token). This occupies the number.
- *Linked (secondary) device*: recent signal-cli versions can link as a secondary device to an account registered on a real phone. Register Signal once on any spare Android phone, then link signal-cli to it. Verify the current signal-cli version's support at build time; linked-device support is newer than most signal-cli documentation on the web.

**The risk, stated plainly:** signal-cli is an unofficial client. Signal has no published bot API; the server can (and does) change behavior without notice — signald, a similar project, was effectively broken by server-side rate limits in 2023–24. Primary-registered numbers running unofficial clients have been banned. Mitigations that fit our use: a dedicated number (never one we care about), low volume (a family, not a service), linked-device registration rather than primary where possible, and a fallback path (below). This risk does not kill the plan; it sets expectations and argues for keeping the entryway layer thin and swappable.

**What Signal buys us:** end-to-end encryption (message content never rests in plaintext on a third-party cloud — this *resolves* the old open question 3's tension with Zulip Cloud), no app install beyond Signal itself, real texting semantics (attachments, reactions, typing), and a front door that feels like a person, not a product.

**Family mechanics:** each family member installs Signal (free) and messages the bot's number. One front conversation per person, keyed on their Signal UUID. A family *group* chat maps to one shared front conversation per group, exactly like today's DM groups. Signal splits very long messages automatically, but the front session's instructions should demand short replies: answer in text; deliver outputs as attachments; offer a link or a file when the answer is long.

### Alternatives, for honesty

| Entryway | Effort | Ban/ToS risk | Privacy | Notes |
|---|---|---|---|---|
| Signal (signal-cli) | Moderate (new adapter) | **Real, unofficial client** | E2E, no cloud copy | Recommended primary |
| Telegram Bot API | Low (official API) | None | Cloud-stored content | Easiest by far; feels like "an app," weaker privacy; keep as the documented fallback if Signal breaks |
| WhatsApp (Baileys et al.) | Moderate | Real, unofficial | E2E-ish, Meta cloud backups | No advantage over Signal for this family |
| SMS/MMS (Twilio) | Low (official API) | None | None (carrier plaintext) | Works on any phone without installing anything; per-message cost; MMS attachments are unreliable — a fallback, not the front door |
| iMessage | High (no sanctioned API) | Real | — | Not worth it |

### Local chat (second entryway, later)

The Harness owns the durable store, so a second process cannot open it directly; every entryway must go through the gateway. The cheap options: (a) a small web chat page served on the tailnet (Caddy + one HTTP endpoint in the gateway that submits to the front conversation), or (b) an SSH command that pipes stdin into the same endpoint. Option (a) is a day-shaped small build and gives a browser surface with real rendering (tables, links) that Signal cannot. The entryway layer makes this additive: adding local chat never touches conversation logic.

## The flagship walkthrough (the .docx use case, end to end)

1. Wife texts the bot's Signal number: "fix the citations in this to APA" with a .docx attached.
2. The Signal adapter receives the event, stages the attachment into her front conversation's workspace (`uploads/`), and submits the message with `requestId = signal:<messageId>` (exactly-once, same pattern as Zulip ids).
3. The front conversation sees: her memory, family memory, skills list, the message, the file path. It calls `run_task(task: "Convert citations in uploads/paper.docx to APA 7 style; return the corrected file")`.
4. `run_task` creates a task-owned child conversation with its own container and scratch workspace (or a scoped `tasks/` dir in hers). The exec image carries `pandoc` and `python-docx` (a build-time addition to `phase1/exec/Dockerfile`). The child does the work with full tools.
5. The child finishes; the tool result returns to the front conversation: summary plus output path. The front session replies in text ("done — 14 citations fixed, 3 were missing DOIs") and the gateway sends the corrected .docx back as a Signal attachment.
6. The front conversation logs the job in a small task ledger (see the skill loop below).

Latency budget: container spin-up ~1–2 s, then model/tool work — the same as any agent run; a "typing…" indicator covers it.

For the wife this is: *text a file, get a file back.* No topics, no app, no account. That is the differentiation Zulip could not give her.

## The skill loop: auto-create, apply feedback, gate it

**Mechanism.** Skills are directories with `SKILL.md`. The exec containers mount the skill layers read-only, so a task session cannot write them directly. Add a gateway-side tool instead:

- `save_skill(name, description, content)` — writes or replaces `SKILL.md` in the appropriate skills layer (gateway side), gated.
- `update_skill(name, change_note, content)` — same, with the diff shown in the front thread.

**Creation policy (the "after seeing this twice" part).** No new machinery is needed to detect recurrence — the front conversation has `history_search` over every past conversation and a task ledger. Give the front session explicit instructions: *after each completed task, decide whether this kind of job has now happened more than once (search the ledger and history); on the second success, write a skill that captures the procedure, the tools, and the format specifics (e.g., "APA 7; use pandoc with the apa.csl style; check DOIs against crossref").* The skill that emerges is exactly what a human would write: a procedure, plus the wife's specific preferences. If prompt-driven curation proves unreliable, the fallback is a periodic flash-model pass over recent task transcripts (a "tidy pass" for skills) — but try the free version first.

**Feedback policy.** Feedback arrives in the front thread as ordinary text ("journal titles should be italic, not the issue numbers underlined" or simply "wrong, here's the style guide"). The front session maps the feedback to the skill (the ledger records which skill a task used), rewrites `SKILL.md`, and posts the diff. The next task run loads the amended skill. This is the loop you described, and it is prompt engineering over two tools, not a subsystem.

**Gating — this is a security boundary, not a formality.** A skill is persistent prompt content that every future session loads. A poisoned skill is the injection attack that outlives the session, exactly like user-memory poisoning (hetzner memo, "Memory and workspaces"). Therefore:

- `save_skill`/`update_skill` are `ask`-gated in the permission layer, with the judge auto-approving routine edits only when the skill is young; the ask lands in the front thread as a one-line diff the owner can approve by reply.
- Make the skills directory a git repo (today it is plain files on the box under `/opt/family-agent/skills`; the hetzner memo's "everything becomes git" principle says version them). Diff is then the review surface; revert is `git revert`.
- Task sessions run with document content treated as untrusted text (below).

## Security and policy deltas

1. **Untrusted document content.** The .docx arrives from a family member, but its *contents* are open-world text and can carry prompt injection. The existing defenses compose: task sessions see only their scoped workspace, no credentials in their environment (the Phase 2 starvation pattern), permission gates on consequential actions, and ingress scanning at the gateway can extend to attachment text. The new surface is small: one more open-world input path, same class as Zulip uploads today.
2. **Second user = the open question 4 problem, now real.** The wife gets her own front conversation, but what power do her task sessions get? Recommendation: same sandboxed full-tools task sessions as the owner, but her permission config is stricter — money-adjacent and outbound-send actions always-human, and asks resolve only in *her* thread with *her* approval (the approval-integrity pattern ports unchanged: sessions hold no Signal credentials and never see raw Signal events; the gateway resolves asks over a control path sessions cannot write). Per-user permission config is where this line gets drawn.
3. **Memory restructure.** Today `memory/user.md` is one shared file per channel workspace; that model breaks with a second person. Restructure: per-person memory (`memory/users/<signal-uuid>.md`), loaded into that person's front conversation and into task sessions spawned from it, plus a shared family memory for group conversations. This is a real (but contained) edit to `sections.js` and the workspace skeleton.
4. **Signal credentials** live only in the gateway's env, like the Zulip key — a compromised session can beg over Signal but cannot forge approval or read the key.
5. **One more single point of failure.** The hetzner memo's "one interface is one failure domain" gets a second instance: if signal-cli or Signal-the-service breaks, the family front door breaks. Mitigations: the Telegram fallback adapter (low effort, official API) and Zulip DMs remain as an always-on secondary path.

## What it would take

Ordered so each step is verifiable and nothing requires a big-bang cutover. Sizes are described by what they touch, not by time.

**Step 1 — Entryway adapter layer.** Extract the thin adapter interface the hetzner memo already mandated: a route doc with a `kind` field (`zulip` | `signal` | `local`), a reply interface (`postText`, `postAttachment`, `postReaction`, `resolveAsk`), and per-entryway pollers. `gateway.js`'s Zulip routing becomes one implementation. Touches: routing table, docs, reply paths, ask resolution — the largest single refactor in this plan, and mostly mechanical.

**Step 2 — Signal bridge.** A signal-cli container (compose service, JVM, a few hundred MB), the bot number registered, a JSON-RPC client in the gateway, inbound staging of attachments, outbound send-with-attachment, typing indicator while a run is live (the text-messaging equivalent of the eyes reaction). *Verify:* text a photo from a phone, the agent sees it; the agent's reply with an attached file arrives on the phone; a restart mid-run does not double-post.

**Step 3 — `run_task` subagent tool.** Port the pi-durable README's subagent example: task-owned child, own container via `DockerExecutionEnv` (already per-conversation), scoped task workspace, `requestId` dedup, result returned as the tool result, abort cascades. Add `pandoc` + `python-docx` to the exec image. *Verify:* the .docx walkthrough end to end, using a hand-written APA skill.

**Step 4 — Skills loop.** `save_skill`/`update_skill` tools, ask-gated; skills directory as a git repo; front-session curation instructions; task ledger. *Verify:* run the citation job twice with no skill; the skill is proposed and written on the second occurrence; send feedback; the diff posts and the skill changes; the third run loads it. Then: run with the skill *wrong on purpose* and confirm the ask fires before an overwrite.

**Step 5 — Family cutover.** Per-user memory, the wife's permission profile, her Signal conversation provisioned from the workspace skeleton. Zulip stays as-is: our operator surface, plus the DM path as fallback. *Verify:* two weeks of the wife texting without anyone opening Zulip.

Out of scope until wanted: background (async) tasks — the pi-durable background-subagent example is the pattern; local chat entryway; cron jobs that text proactively.

## Open questions

1. **The bot number.** Spare SIM vs Twilio number; primary vs linked-device registration. This is an operational decision with the ban risk attached; decide before Step 2.
2. **Per-person or per-entryway front conversation?** This memo recommends per-person (one thread about *you*, wherever you type from). The alternative — a separate front thread per entryway, Hermes-style — is simpler isolation but defeats the "single assistant" feel. Confirm the recommendation by using the Signal bridge for a week before Step 5.
3. **Skill creation autonomy.** Propose-then-confirm (skill written only after an in-thread approval) vs judge-auto-approved with a posted diff. This memo assumes the latter for low-stakes edits; tune empirically as the hetzner memo says for the permission judge.
4. **Does Zulip remain a family surface at all?** Recommendation: no — family gets Signal; Zulip is the operator/development surface. But group conversations (a family Signal group) may want topic-like splitting for long projects; `fork_thread` has no Signal representation, so a fork over Signal must either be invisible (headless) or surfaced as "I started a separate job on that." Design when it comes up.
5. **Message-length UX over Signal.** Long answers are bad texting. The conventions section needs a hard rule (short text, deliverables as attachments); whether to auto-split or to post a summary-plus-file is a feel-test question.

## Sources reviewed

- pi-durable README (installed package, v1.0.4): task-owned conversations, subagent examples (foreground and background), ownership and abort semantics.
- `phase1/gateway/`: gateway.js (routing, DM model, approval integrity), lib/tools.js (spawn_thread/fork_thread pattern), lib/sections.js (skills listing, memory), lib/docs.js (conversation docs), skills/install.sh.
- Persistent-agent design summary (2 Oct): OpenClaw main-session model, Dots/Instinct/Muse survey, memory levels, phone-reach open question.
- hetzner-consolidation.md: thin-interface mandate, memory poisoning controls, "everything becomes git," failure-domain warning.
- Signal integration facts are a snapshot of my knowledge: signal-cli (AsamK) JSON-RPC mode, registration paths (primary, linked device), attachment handling; bbernhard/signal-cli-rest-api; signald's 2023–24 breakage as the cautionary precedent. Verify current signal-cli capability at build time.
