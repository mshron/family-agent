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
  }),
});
