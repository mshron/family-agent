# Membership-driven channels

Date: 2026 (see git history for exact date)

## Decision

Zulip stream membership is the source of truth for which channels the
gateway watches. `channels.json` no longer lists every stream; it keeps:

- `streams` — seed streams, self-subscribed at boot (today: `scratch`,
  `meta`), with owners added to them as before.
- `channels` — per-channel tool overrides (`add`, `tools`, `push`).

Everything else is joined by invitation:

1. A user creates a stream in the Zulip app and invites the bot.
2. The bot's control queue (event types `["subscription"]`, no narrow)
   receives the `subscription`/`add` event.
3. ~~The **invite gate**: if `ZULIP_OWNER_EMAILS` is configured, at least
   one owner user id must be a subscriber of the stream.~~ **Removed
   2026-10-12 (Max's decision):** the system is becoming multi-user, and any
   member of the organization may invite the bot. Every invitation is
   accepted. `ZULIP_OWNER_EMAILS` still seeds the owner into the channels in
   `channels.json`, nothing more. (The gate's first version also had a bug
   — it read `user_id` off the API response body instead of `body.user` —
   which declined every invite, including ones it should have accepted.)
4. On acceptance: workspace copied from `phase1/workspace/` (git
   initialized) via `lib/provision.js`, `skills/<stream>/` created, a
   per-stream poller starts, and a greeting is posted in a
   `family-agent` topic.
5. Removal from a stream stops that poller. Boot-time discovery
   (`GET /users/me/subscriptions`) reapplies all of this after restarts.

**Direct-message workspaces (2026-10-12, Max's decision):** DMs are
multi-user now that invitations are open. Each DM group keys its own
workspace and channel (`dm-<sorted other user ids>`), provisioned at
runtime like invited channels; `history_search` and memory therefore stay
per group, and one person's DM memory never leaks into another's.
Conversations created before this change are migrated at boot: their
doc's `stream` field is rewritten from `dm` to the group key (the old
shared `workspaces/dm` directory is copied per group on the box, then
removed).

## Why this shape

- Creating a channel is a Zulip-app action; no deploy, no config edit.
- State lives in Zulip, so restarts and deploys cannot drift from it.
- It is the routing primitive a future multi-bot setup needs: one bot per
  set of memberships, each with its own tools and durable store.

## Infrastructure changes

- Gateway image now has `git` (runtime workspace provisioning).
- `skills/` is mounted read-write (the gateway creates channel layers).
- The workspace skeleton is mounted read-only at
  `/app/workspace-skeleton` for the gateway to copy.

## Deliberately not automatic

- Tool-set selection for new channels: default is the standard set;
  granting `push` or extra tools stays a deliberate `channels.json` commit.
- The bot never subscribes itself to a stream nobody invited it to.
