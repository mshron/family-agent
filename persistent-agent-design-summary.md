# Persistent agent design: context, memory, and Zulip

Summary of a design discussion, 2 Oct 2026. Several of the products below launched days or weeks ago, and Pi Durable shipped on 1 Oct 2026 and is explicitly experimental. Treat the details as a snapshot.

## 1. How existing frameworks handle one persistent messaging interface

### OpenClaw
- All DMs collapse into one "main" session by default (`session.dmScope: main`). Multiple phone numbers and channels act as transports into that one conversation. Groups and rooms get isolated sessions.
- No automatic reset by default. Compaction keeps the context bounded. Daily and idle resets are opt-in.
- Shortly before auto-compaction it runs a silent "write durable notes now" turn (suppressed with a `NO_REPLY` convention). On `/new` or `/reset` the tail of the ending conversation is saved to daily notes and re-primed into the next session.
- Built on Pi sessions (embedded Pi runner).

### Hermes (Nous Research)
- Session key includes platform and chat ID, so the same person on two platforms gets two separate sessions.
- Forum topics and Discord/Slack threads carry a `thread_id` and isolate session history from the parent.
- Memory is bounded files (`MEMORY.md`, `USER.md`) that do not auto-compact. Docs note the memory design assumes session boundaries; weeks-long single sessions get expensive and the recall loop rarely fires.
- Time-based idle/daily resets were removed upstream (v2026.9.11); only `/new` and `/stop` replace a conversation. A plugin re-adds the old policy.
- A reported bug: after compaction, memory was labeled "background reference" and the agent ignored it. Memory must survive compaction as active context.

### Dots (OpenAI), Instinct, Muse (Meta)
- **Dots:** one main conversation manages the project; separate task conversations do work and return results. Context carries across ChatGPT, Slack, Teams; texting in limited beta. Architecture not published.
- **Instinct:** one continuous thread over iMessage, WhatsApp and calls, on a persistent cloud computer. Early users asked for separate threads per job. Internals not published.
- **Muse:** WhatsApp supported; remembers details and supports "forget". Nothing found on context handling.
- All three are known only from secondary coverage.

### Pi Durable (Earendil, experimental)
- A harness: storage plus the machinery to run many conversations concurrently. Every model call and tool call is a checkpointed task; a `requestId` makes a submission exactly-once.
- Compaction is a background task whose summary lands at the next turn boundary. `reset()` starts a new context from a handoff note. Nothing is deleted, so a custom tool can search pre-handoff history.
- Conversations can fork at any message (Slack channel with threads is the post's own example). Each conversation stores its own model, tools, instructions and cwd.
- Application state lives in typed JSON "documents" committed atomically with the transcript.
- No built-in subagents and no channel adapters; you write the gateway.

## 2. Shared context vs memory

They are layers, not alternatives.

1. **Live context**: current working thread, verbatim.
2. **Small curated memory**, always loaded: stable facts, preferences, decisions, open commitments.
3. **Handoff note / compaction summary** carrying "what we were doing" across a boundary.
4. **Lossless searchable history** for detail.

Practical points:
- Write memory at boundaries (pre-compaction, handoff, topic close), not continuously.
- Tell the agent that archived history exists, or it won't search it.
- A fork or topic with memory loaded but no shared history gives "fresh, but it knows me."

## 3. Proposed design

### Mapping to Zulip
- Each (channel, topic) maps to one Pi conversation, with one session per thread that sleeps when idle (storage-backed; idle threads cost nothing).
- Key the mapping on a stable conversation ID, not the topic name, since topics can be renamed or moved.

### Three memory levels
- **User**, **channel**, **topic**. User and channel memory are system-prompt sections read fresh on every request, so edits propagate to running topics. Topic memory is the conversation plus a document and handoff notes.
- A topic's memory scope comes from its parent channel, not from where it is posted.
- Promotion happens at boundaries, such as a topic being resolved (renamed `✔ name`): free writes at topic level, small automatic writes at channel level, user-level writes as proposals to confirm. Cap sizes so the agent must consolidate. Narrower level wins on conflict.

### Memory curator thread
- Reads go straight to the store; writes go through a curator agent that dedupes, consolidates and enforces caps. Other threads send proposals as messages.
- A `memory` topic per channel acts as the curator's inbox and audit log. Keep the files (markdown in git) as the source of truth, so they are editable anywhere. Change things by replying to the curator.
- Agent-to-agent messaging goes through the harness API (with `requestId` dedup and a hop/budget limit), not through Zulip; post a one-line note in the memory topic for visibility.

### Cron-spawned topics
- Example: a finance bot opens an end-of-month cleanup topic. Use a period-encoded `requestId` (e.g. `finance-cleanup:2026-10`) so retries don't duplicate.
- Tools that move money should not be marked `replay: "safe"`, and external writes need their own idempotency keys.

### Slash commands and subagents
- Zulip has no custom slash command registration as far as I could tell; the bot parses messages starting with `/` itself and avoids built-in names (`/poll`, `/todo`, `/me`).
- Mapping: `/model` → `configure`, `/compact` → `compact()`, `/new` → `reset()`, `/stop` → abort.
- Subagents are conversations owned by the calling tool call, each with its own topic; abort cascades. Parent sees start/finish lines; child carries the detail.

## 4. Zulip specifics

- **Topic naming:** a topic is just a label on messages. Rename via `PATCH /messages/{id}` with `topic` and `propagate_mode=change_all`. Allowed depends on the org's topic-editing permissions. A small model can title a topic after the first exchange. Disable move notices for bot renames.
- **Muting:** visibility policy (none, muted, unmuted, followed) is set per exact channel/topic pair, for the calling user only. No pattern-based muting, and a bot can't mute for you. Options: a helper script using your own API key that watches events and mutes matching topics (the endpoint works before a topic has messages), or just leave everything unmuted and see how noisy it gets.
- **Dedicated `#agent-work` channel:** rejected for now because it undermines per-channel memory. It could still work if subagent topics inherit memory scope from the parent channel.
- **Privacy:** personal setup for a family; use private channels, and keep user-level memory out of shared channels.

## 5. Open decisions
- Whether phone and Zulip conversations share context (OpenClaw-style) or stay separate (Hermes-style).
- Whether subagent noise needs the muting helper.
- Markdown files vs Pi Durable documents for memory state (files favored for editability).

## 6. Future work
- **WhatsApp/SMS reach:** make WhatsApp/SMS the reachable "root" conversation, with a few phone-friendly commands (`/new`, `/status`); Zulip topics fork or run separately for project work.

## Sources
- Pi Durable announcement: https://earendil.com/posts/pi-durable/
- OpenClaw sessions: https://docs.openclaw.ai/concepts/session and https://docs.openclaw.ai/concepts/main-session
- OpenClaw compaction deep dive: https://docs.openclaw.ai/reference/session-management-compaction
- Hermes messaging gateway: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/
- Hermes session lifecycle: https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-session-lifecycle
- Hermes memory: https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
- Hermes compaction/memory bug: https://github.com/NousResearch/hermes-agent/issues/17251
- OpenAI Dots overview: https://www.datacamp.com/blog/openai-dots
- Meta Muse overview: https://www.datacamp.com/blog/muse-agent
- Instinct breakdown: https://www.vellum.ai/blog/official-instinct-breakdown
- Zulip edit-message API: https://zulip.com/api/update-message
- Zulip topic visibility API: https://zulip.com/api/update-user-topic
