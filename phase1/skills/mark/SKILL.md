---
name: mark
description: The default way to show the user a markdown file — a live browser preview (Vivify) at a tailnet URL, with click-to-comment review that writes reader feedback to a .comments.md file beside the doc. Use whenever the user should read a markdown doc you wrote or edited, whenever they ask to see/preview/render/review one, and whenever a .comments.md review file (full filename + suffix, e.g. spec.md.comments.md) exists next to a markdown doc you are editing. Prefer mark over pasting rendered content into the chat.
keywords: [markdown, preview, vivify, review, comments, feedback]
---

# mark — markdown preview with inline review

Two halves: a `mark <file.md>` command that prints a live-reloading
preview URL, and a review loop where the human clicks any paragraph in
the preview to leave a comment, which lands in `<file>.comments.md` beside
the doc for you to address.

**This is the default markdown viewer.** When you finish writing or
editing a markdown doc the user will want to read — a memo, a plan, a
report — run `mark` on it and post the URL. Don't paste rendered content
into the chat instead.

## Running mark here

There is no browser on this machine and the preview runs on the host.
The `mark` command registers the doc with the preview server and prints
a URL; **always post that URL in your reply** — it is the deliverable.
Example:

```text
$ mark docs/memos/proposal.md
http://100.x.y.z:31622/viewer/opt/family-agent/workspaces/<channel>/docs/memos/proposal.md#ct=<token>
```

Post the URL exactly as printed, including the `#ct=` fragment: without
it the reader can comment but the comments will not save. Only readers
on the tailnet (the owner's devices) can open the URL.

A typical round-trip:

```text
User:   Write up the migration plan in docs/memos/migration.md and open a preview.
Agent:  [writes the doc, runs `mark docs/memos/migration.md`, posts the URL]
User:   [reads the preview, clicks two paragraphs, leaves comments, then:]
        Address my comments.
Agent:  [reads docs/memos/migration.md.comments.md, edits the doc, deletes the
        resolved blocks — the preview and its comment sidebar update live]
```

The preview reloads on save, renders KaTeX and syntax highlighting, and
stays alive for 24h idle, so the URL survives old chat messages.

## Review workflow: <file>.comments.md

When working on a markdown document, check for a comments file next to it,
named by appending `.comments.md` to the **full filename** —
`proposal.md` → `proposal.md.comments.md`, never `proposal.comments.md`.
It holds the reader's inline review comments, one block per comment,
headed:

```markdown
## <name>:<line> — "<quoted passage>" (<timestamp>)
```

Treat each block as a change request against the quoted passage.

**"Review the comments," "handle the feedback," and "address my comments"
are edit requests in this workflow.** Read the comments and source
document, apply every clear requested change, and resolve its comment
block. Do not stop after summarizing the comments. Only use read-only
behavior when the user explicitly asks you to summarize, list, or report
the comments without making edits. If one request is unclear, leave that
block open and explain the ambiguity after applying the clear requests.

**The quote is the anchor, not the line number.** Comments are written
against a snapshot of the doc, so line numbers drift as it is edited —
locate the passage by searching for the quote, and use the line number
only as a tiebreaker when the quote appears more than once. If the quoted
passage has been deleted or rewritten beyond recognition, say so in your
response rather than guessing.

- **After addressing a comment, delete its block.** Comments left in the
  file render as open feedback in the reader's preview.
- **If no comment blocks remain after your edits, delete the
  `.comments.md` file itself** — don't leave an empty file behind. (The
  preview handles a missing file fine; it just shows no comments.)
- **If the resolution is worth recording** (e.g. you disagreed and left
  the text as-is), instead append ` [resolved]` to the end of its heading
  and add your response to the block body.
- **Never touch comments you haven't addressed** — they must stay open.

The comment sidebar in the preview updates live as you edit the file, so
the reader sees resolutions as they happen.
