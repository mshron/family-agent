---
name: email-unsubscribe
description: Agentic email unsubscribe workflow. Use when the user wants to unsubscribe from email senders, clean up subscriptions, or manage mailing lists.
---

# Email Unsubscribe Workflow

Multi-step agentic workflow for unsubscribing from email mailing lists. Uses real URLs from email headers — NEVER fabricate or guess URLs.

## Step 1: Discover Accounts

Call `email_accounts()`. Returns a list like `["fastmail", "gmail"]`. Use these names in every email tool call.

## Step 2: Search for Emails

```
email_search(after="2026-03-01", limit=20)
```

Returns sender, subject, date, and `has_list_unsubscribe` for each message. Page through with `offset`:

```
email_search(after="2026-03-01", limit=20, offset=20)
```

For a specific account: `email_search(account="fastmail", after="2026-03-01")`.

Identify senders the user wants to unsubscribe from based on the subjects and sender addresses. Group by sender.

## Step 3: Get Unsubscribe Headers

For messages with `has_list_unsubscribe: true`:

```
email_get_headers(account="fastmail", message_id="msg-abc123")
```

Returns the real unsubscribe URLs. These are the ONLY URLs you may use. Example:

```json
{
  "List-Unsubscribe": "<https://real-url.example.com/unsub?token=abc123>, <mailto:unsub@example.com>",
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
}
```

## Step 4: Unsubscribe, One Sender at a Time

Process senders ONE AT A TIME. Complete each before starting the next.

**Method A — visit the unsubscribe URL with the browser:**

```bash
agent-browser open "https://example.com/unsub?token=abc123"
agent-browser wait --load networkidle
agent-browser snapshot -i
```

Read the snapshot. If the page shows a confirmation button, click it (`agent-browser click @e3`), re-snapshot, and verify by reading the page. Only claim success when the page confirms it.

**Method B — mailto:** if the header contains a `mailto:` URL, use `email_send` with that address; the ask posts in the conversation and the user approves it with a reaction. Body: short, e.g. "Please unsubscribe me from this list."

**Method C — bot detection:** if the page shows a Cloudflare challenge or CAPTCHA, stop. Report the exact URL back to the user so they can visit it manually.

**Method D — no header:** if `has_list_unsubscribe` is false, there is no URL to work with. Tell the user.

## Step 5: Clean Up

Close the browser when done:

```bash
agent-browser close
```

## Rules

- **NEVER fabricate URLs.** Only URLs from `email_get_headers` output.
- **Never enter the user's credentials on third-party pages.**
- Verify every result by reading the page after clicking; report the actual outcome, not an assumption.
- There is no email delete tool — unsubscribe works via the sender's own mechanisms only.
- Close the browser session when done.
