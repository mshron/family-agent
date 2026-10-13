// Shared document definitions. Every conversation carries a zulip doc; the
// gateway routes messages by it and history_search scopes by its stream.

import { defineDoc } from "@earendil-works/pi-durable";

export const ZulipDoc = defineDoc({
  kind: "app.zulip",
  version: 1,
  scope: "conversation",
  history: "latest",
  // Forks and spawned threads get their own mapping, not the parent's.
  fork: "initial",
  initial: () => ({
    stream: null,
    topic: null,
    origin: null,
    // Direct-message conversations: the participants' emails (all, bot
    // included). Null for stream conversations.
    recipients: null,
    // Message ids the gateway posted for the current turn (reply + tool-call
    // spoilers). Deleted before an edit/delete re-runs the turn.
    tailPosts: [],
  }),
});

/** Gateway bookkeeping (general-chat naming boundaries), session-wide. */
export const GatewayDoc = defineDoc({
  kind: "app.gateway",
  version: 1,
  scope: "session",
  history: "latest",
  initial: () => ({
    // stream -> { generalChatLastProcessed: messageId }
    boundaries: {},
    // Zulip message id -> { conversationId, requestId }: the routing index
    // for edit/delete events. Ring-buffered to the last ~1000 ingested
    // messages (oldest evicted). requestId is the conversation-scoped key of
    // the message's *current* turn — an edit rewrites it.
    messages: {},
  }),
});
