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
3. The **invite gate** runs: if `ZULIP_OWNER_EMAILS` is configured, at
   least one owner user id must be a subscriber of the stream (checked
   against `GET /streams/{id}/members`, not the event payload, which does
   not reliably identify the inviter). Fail-open when no owners are
   configured; fail-closed when owners are configured but none resolve at
   boot. Rejected invites: the bot unsubscribes.
4. On acceptance: workspace copied from `phase1/workspace/` (git
   initialized) via `lib/provision.js`, `skills/<stream>/` created, a
   per-stream poller starts, and a greeting is posted in a
   `family-agent` topic.
5. Removal from a stream stops that poller. Boot-time discovery
   (`GET /users/me/subscriptions`) reapplies all of this after restarts.

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
