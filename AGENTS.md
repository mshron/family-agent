# Workspace conventions — #meta (the family-agent system repo)

You are an agent in the #meta channel. Your workspace is the family-agent
repository itself: the code of the system you run on. You can read and edit
all of it.

## Layout

- `phase1/gateway/` — the Node gateway: Zulip bridge, the pi-durable
  harness, tools, and per-channel configuration.
- `phase1/exec/` — the exec container image. Tools (bash, read, write,
  edit) run inside it.
- `phase1/deploy/` — box install, CI/CD pull-deploy, the secrets pusher.
- `phase1/workspace/` — the skeleton that other channels' workspaces start
  from (their AGENTS.md lives here).
- `phase1/channels.json` — which streams exist and which tools each
  channel gets.
- `docs/memos/` — design decisions. Read `hetzner-consolidation.md` before
  you change architecture.
- `.github/workflows/deploy.yml` — CI/CD.

## How deploys work

1. You commit your work here.
2. You call `push_changes`. The gateway pushes `origin main` using a
   deploy key that only the gateway can read.
3. GitHub Actions runs the `deploy` workflow, which connects to the box
   and runs `phase1/deploy/pull-deploy.sh`: this clone is reset to
   `origin/main`, `phase1/` is copied to `/opt/family-agent/phase1`, and
   the gateway restarts with the new code.

Consequences:

- Commit and push before you finish. A deploy resets this clone to
  `origin/main`: unpushed commits are discarded, uncommitted changes are
  lost.
- A deploy restarts the gateway. Runs that are in flight complete in the
  durable store, but their replies may not post. If the user reports a
  missing reply, tell them to resend.
- The box holds runtime state that is never in this repo: `.env`
  (secrets), `workspaces/` (other channels' files), `durable/`
  (conversation store), `skills/`. Do not try to edit those from here;
  they are outside your mount.

## Adding a channel

Channels are now membership-driven: Zulip itself is the source of truth
for which streams the gateway watches. `channels.json` keeps only the
*seed* streams (self-subscribed at boot; currently `scratch` and `meta`)
and per-channel tool overrides.

To add a channel from the Zulip app:

1. Create a stream and invite the bot. The gateway's control queue picks
   up the `subscription` add event. If no configured owner is a member of
   the stream, the invite is declined and the bot leaves.
2. On acceptance the gateway provisions the workspace (from the
   `phase1/workspace/` skeleton) and skills directory at runtime, starts a
   poller, and posts a greeting in a `family-agent` topic.

If a channel needs tools beyond the standard set, add a
`channels.<name>` block to `phase1/channels.json` in a normal commit
(that is where #fitness will get Garmin tools once they are built). No
deploy is needed just to watch a new stream.

Removing the bot from a stream stops its poller for that channel.

Do not remove or rename channels other channels depend on, and do not
touch the `meta` or `dm` entries.

## Rules

- No secrets in commits. Keys live on the box, outside this repo.
- Keep the repository root clean: this is a code repo, not a notes
  workspace. Put scratch work in `notes/` and delete it before you push,
  or keep it only if it is worth keeping in history.
- This channel has no memory files. This repository and `history_search`
  are your memory.
