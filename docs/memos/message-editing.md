# Message editing and deletion

Design for "edit history" — a user edits or deletes a message they already
sent, and the agent's durable history follows. Written 12 Oct 2026, from the
#meta review; not yet implemented.

## Decisions (confirmed by Max 13 Oct 2026)

1. **Case B fork scope.** The fork drops the edited message and everything
   after it; the old topic keeps its full visible history. Confirmed.
2. **Fork topic naming.** Reuse the existing small-LLM topic namer
   (`nameTopic`, fed the old topic + corrected text), falling back to
   `"<old> — edited"`. Confirmed.
3. **Delete-of-latest.** Silent: the turn vanishes from context, the bot's
   reply is deleted, nothing re-runs, nothing posted. Confirmed.
4. **DM scope.** DMs support latest-message edit/delete only (there are no
   topics to fork into); an edit of an older DM message gets a note instead.
   Confirmed.
5. **Shipping gate.** The `edits` omit mechanism is public protocol but used
   here beyond what the codebase already exercises: gate on a faux-provider
   test of omit-on-a-real-turn plus a live matrix in #scratch (edit/delete,
   latest/older, idle/typing, DM, restart-mid-edit, delete-own-message
   policy). Confirmed.

## Desired behavior

- **Edit the most recent message you sent** → the agent deletes its most
  recent reply and re-runs on the corrected text, in place, in the same topic.
- **Edit or delete a message further back** → the conversation forks at that
  point into a new topic; the corrected branch continues there. The old topic
  keeps its history untouched (Zulip does not let the bot rewrite other
  people's messages, and the old topic's visible history must keep matching
  its own conversation).

Both primitives exist in Pi Durable (`@earendil-works/pi-durable` 1.0.4):

1. **Fork at any entry** — `Conversation.fork(entryId)` /
   `tx.forkConversation(parent, at, { ownership })`. The fork sees the
   parent's entries up to `at` (inclusive), keeps the parent's agent as of
   that entry, and gets a fresh provider session identity. Already proven in
   production by `fork_thread`.
2. **Context edits** — `EntryRecord.edits: ContextEdit[]`, written through
   `tx.appendEntry()`: `{ target, action: "omit" }` or
   `{ target, action: "replace", messages }`. "Context-only overrides of
   earlier visible entries": nothing is deleted, but the target entry stops
   contributing (or contributes the replacement messages) to model context.
   `deriveContext()` collects edits from every entry in the active range, so a
   single appended entry can supersede several earlier ones. Compaction
   already relies on this mechanism (its baseline omits retained system
   entries).

So the durable store never loses anything: an edit is a *new entry* that
overrides old context, and a fork is a *new conversation* that re-reads old
context. The only destructive action is on the Zulip side (deleting the bot's
own stale posts), which is what the spec asks for.

## Zulip side

- **Events.** The per-stream and private queues register with
  `event_types: ["message", "update_message", "delete_message"]`
  (the control queue stays `["subscription"]`). The `narrow` parameter only
  filters `message` events, so edit/delete events for messages in the stream
  arrive on the stream's queue regardless of its narrow.
- **`update_message`** carries `message_id`, `edit_timestamp`, `editor`, and
  — only for content changes — `content` (the new raw Zulip markdown) and
  `orig_content`. Topic/channel moves arrive with subject/stream fields and
  no content fields; `rendering_only: true` marks URL-preview re-renders.
  Route: ignore rendering-only, ignore moves, handle content edits.
- **`delete_message`** carries `message_ids`/`message_id` and, for stream
  messages, `stream_id` + `topic` — but not, on current Zulip, enough to route
  a direct-message deletion (no recipient info). So routing uses an index.
- **Routing index.** Every ingested message records
  `GatewayDoc.messages[message_id] = conversationId` (session-scope doc,
  latest-history, ring-buffered to the last ~1000). Edit and delete events
  resolve through it; an edit of a pre-index message falls back to
  `GET /messages/{id}` (which returns stream/topic/DM recipients), a delete
  of one is ignored (cannot be fetched after deletion).
- **Deleting stale bot posts.** `DELETE /messages/{id}` deletes the bot's own
  messages, subject to the organization's message-deletion policy and time
  limit (recent messages are fine). The gateway records the ids it posts for
  the current turn in `ZulipDoc.tailPosts` (reply + tool-call spoilers) and
  deletes exactly that list before re-running. A delete past the org limit is
  caught and mentioned in the reply rather than failing the turn.

## Flows

Let `E_u` be the entry of the edited message's original submission, found via
`tx.submissionByRequest(conv, "zulip:<message_id>")` (requestIds *are* the
Zulip↔entry mapping; nothing else needs bookkeeping). "Latest" means: the
newest `pi.user` entry of the conversation belongs to the same Zulip message
(strip the `:e<ts>` suffix a previous edit may have added).

### Case A — edit/delete of the latest user message (same topic)

1. Route the event to its conversation (index → doc).
2. `await conversation.abort(context, { background: true })` — stops the
   stale run if one is live, withdraws any queued follow-ups, kills an
   in-flight compaction (it would summarize history we are about to reopen;
   it re-runs later).
3. One commit: append a `zulip.edit` entry
   (`data: { messageId, editor, timestamp, action, targets }`) whose `edits`
   omit every entry at or above `E_u` (the stale input and its whole run —
   assistant, tool calls, tool results). If the submission was queued and
   never placed, there is nothing to omit.
4. Delete `doc.tailPosts` bot messages from the Zulip topic, clear the list.
5. **Edit:** re-submit the corrected markdown as a normal input with
   `requestId: "zulip:<id>:e<edit_timestamp>"` (exactly-once across restarts;
   a re-delivered event finds the existing submission and skips) and post
   the fresh answer in the same topic, eyes-reaction on the edited message.
   **Delete:** nothing re-runs; the turn is simply gone from context.

Model context afterwards is exactly "as if the message had been written
correctly": earlier turns verbatim, then the corrected input. Same
conversation id, so the topic↔conversation binding, watcher, exec container,
and prompt-cache prefix all survive.

### Case B — edit/delete further back (fork to a new topic)

1. Same lookup of `E_u`. Streams only (DMs have no topics; a DM edit of an
   older message gets a note instead).
2. Fork point: the newest entry with id < `E_u` (a short newest-first
   `scanEntries`); if the edited message was the first entry ever, start a
   fresh conversation. The fork carries everything *before* the edited
   message and drops the edited message and everything after it.
3. In the creating commit, give the fork a `ZulipDoc`: same stream, new topic,
   `origin: { forkOf, editedMessage }`, and the parent's `model` preference.
   (`ZulipDoc.fork: "initial"` means forks start blank; the conversationCreated
   hook initializes the doc and we fill it in the same commit.)
4. New topic name: `nameTopic` (the existing small-LLM namer, fed the old
   topic and the corrected text), falling back to `"<old> — edited"`,
   de-duplicated against existing topics.
5. Post a header in the new topic ("forked from X — an earlier message was
   edited/deleted; the corrected history continues here"),
   `registerConversation`, `ensureWatcher`.
6. **Edit:** submit the corrected text to the fork (same requestId scheme)
   and post its answer there. **Delete:** the fork waits for the next
   message. The old topic and its conversation are untouched and keep
   serving new messages.

## Race handling

- `promptRoute` currently posts `*(no answer: <reason>)*` when a submission
  settles non-`done`. Aborts now settle `unanswered/aborted`; that case
  becomes silent (`/stop` already posts its own "Stopped.").
- Window between a run settling and its reply posting: if an edit lands
  there, the stale reply can still post. Guard: before posting, `promptRoute`
  checks for a `zulip.edit` entry newer than its input that targets its
  entries, and skips.
- Two quick edits of the same message: the "latest" test keys on the Zulip
  message id, so the second edit re-runs in place too (omit from the newest
  entry of that message's turn).
- Topic renames arrive as `update_message` with subject fields and no
  content fields → ignored. Bot-authored messages are never in the index.

## Steering and forced stop

Editing covers "what I said was wrong"; the other half of the same problem is
"what you are doing is wrong, stop". Today there is exactly one stop
mechanism, and it is crude:

- **`/stop`** — the gateway calls `conversation.abort(context)`. The run
  settles `unanswered/aborted`, nothing is posted, and the entries the model
  already wrote stay in context (a partial turn remains visible to the next
  run). Queued follow-ups are withdrawn with it.
- **Edit-of-latest (this memo)** is a second, stronger stop: it aborts *and*
  rewinds — the aborted run's entries are omitted from context entirely, so
  the conversation looks like the turn never happened.

What is missing is **mid-run steering**: telling the agent something while it
is already working, without restarting the turn. Three candidate shapes:

1. **Queue-and-continue.** The user's message is submitted as a normal input;
   pi-durable holds it as a queued follow-up and the live run picks it up at
   the next tool-call boundary. Cheapest, but the agent only hears it at a
   boundary — a long tool call (or a stuck one) delays it indefinitely.
2. **Abort-and-replay (reuse Case A).** Treat a mid-run message as an edit of
   the in-flight turn: abort, omit the aborted run's entries, and submit the
   user's message as the new input. The agent restarts the turn having seen
   the instruction, having lost only its own partial work. This is exactly the
   Case A machinery, so it is nearly free — but it discards genuine progress
   (a long tool result the agent would rather keep).
3. **True injection.** Append a user entry to the live run's context between
   turns of the agent loop (pi's native steering). Strongest UX, but it needs
   a pi-durable primitive the codebase does not exercise yet — same shipping
   risk as the `edits` omit mechanism, so it would need its own faux-provider
   test.

**Force-stop:** `/stop` is the force stop and it is as hard as it gets —
`abort()` cancels the run at the provider/tool boundary. It cannot be
ignored by the model because it never reaches the model. Two gaps worth
closing when this ships: a tool call stuck inside the exec container is only
reclaimed when its timeout fires (abort cancels the pending result, the
capacity frees up, but the container-side process keeps running to its
timeout), and there is no per-tool cancel UI — `Esc`-style interruption does
not exist in Zulip, so `/stop` is all-or-nothing per run.

Proposal: ship **`/stop` + edit-of-latest** (both exist in this design) and
treat 2 (abort-and-replay) as the default steering behavior — it reuses the
edit machinery verbatim and needs no new protocol surface. Revisit true
injection once pi-durable 1.x exposes a steer primitive worth gating on.

## Accepted edges

- `/new`'d topic: an edit from before the reset forks pre-reset history.
- `history_search` matches raw entries, so pre-edit text can still be found.
- Edits of slash-command messages: ignored (commands never enter the
  transcript). Edits of never-ingested messages (gateway was down): the
  corrected text is ingested as a fresh input; deletions are ignored.
- Compaction undone by an edit is regenerated by the background policy.

## Implementation footprint

- `lib/zulip.js`: `deleteMessage(id)`; per-queue event types.
- `lib/docs.js`: `tailPosts` on `ZulipDoc` (version stays 1; absence
  tolerated), `messages` ring on `GatewayDoc`.
- `gateway.js`: event dispatch, the two handlers, index writes, tail-post
  recording, the two guards. ~200 lines.
- `phase1/README.md`: behavior list.

## Verification before shipping

1. Faux-provider test (scratch checkout of pi-durable 1.0.4): a conversation
   with a completed turn; append a `zulip.edit` entry omitting the last input
   and answer; assert the derived model context ends at the earlier turn;
   submit again and confirm the run sees only corrected history. This is the
   one Pi Durable mechanism we would be using beyond what the codebase
   already exercises.
2. Live matrix in #scratch: edit latest (idle), edit latest (while typing),
   edit older, delete latest, delete older, edit twice quickly, edit in a
   DM, delete-own-message policy check, restart mid-edit (requestId dedup).