// Model-facing tools beyond the built-ins: web search, channel-scoped
// history search, thread creation (fork or fresh subagent thread), and
// email (Fastmail via JMAP, Gmail via the vault IMAP/SMTP sidecar) —
// ported from the nanobot's MCP server, all credential-free on this side:
// every call routes through the vault proxy, which holds the keys.

import { Type } from "@earendil-works/pi-ai";
import {
  configure,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { contentText } from "@earendil-works/pi-ai";
import { ZulipDoc } from "./docs.js";

// ---------------------------------------------------------------------------
// Web search (Kagi or Brave), ported from the old MCP server.

const CONFIG = (() => {
  if (process.env.SEARCH_CONFIG) {
    try {
      return JSON.parse(process.env.SEARCH_CONFIG);
    } catch {
      /* fall through */
    }
  }
  return {
    provider: process.env.SEARCH_PROVIDER || "brave",
    proxyUrl: process.env.SEARCH_PROXY_URL || "",
    kagi_key: process.env.KAGI_API_KEY || "",
    brave_key: process.env.BRAVE_API_KEY || "",
  };
})();

// Credential proxy mode (Phase 2, fa-proxy): keys live proxy-side and
// callers send no auth headers at all. Direct mode (SEARCH_PROXY_URL
// unset) keeps keys in the gateway env for local runs and rollback.
const PROXY = CONFIG.proxyUrl;

async function kagiSearch(query, limit) {
  const url = PROXY
    ? new URL(`${PROXY}/kagi/search`)
    : new URL("https://kagi.com/api/v2/search");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.min(limit, 25)));
  const res = await fetch(url, {
    headers: PROXY ? {} : { Authorization: `Bot ${CONFIG.kagi_key}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Kagi API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return (body?.data || [])
    .filter((r) => r.title && r.url)
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ""}`);
}

async function kagiSummarize(targetUrl) {
  const url = PROXY
    ? new URL(`${PROXY}/kagi/summarize`)
    : new URL("https://kagi.com/api/v2/summarize");
  url.searchParams.set("url", targetUrl);
  url.searchParams.set("summary_engine", "cecil");
  const res = await fetch(url, {
    headers: PROXY ? {} : { Authorization: `Bot ${CONFIG.kagi_key}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Kagi API ${res.status}`);
  const body = await res.json();
  return body?.data?.output || "(no summary produced)";
}

async function braveSearch(query, limit) {
  const url = PROXY
    ? new URL(`${PROXY}/brave/web/search`)
    : new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(limit, 20)));
  const res = await fetch(url, {
    headers: PROXY
      ? { Accept: "application/json" }
      : { Accept: "application/json", "X-Subscription-Token": CONFIG.brave_key },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Brave API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return (body?.web?.results || [])
    .filter((r) => r.title && r.url)
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.description || "").replace(/<[^>]+>/g, "")}`);
}

// ---------------------------------------------------------------------------
// Email (dm-first memo Phase 3; ported from the nanobot email tools).
// Credentials live vault-side only: Fastmail's JMAP token is injected by
// fa-proxy; Gmail's app password lives in the gmail-proxy container.
// Read tools run freely; email_send is ask-gated in channels.json — every
// outbound message waits for a human reaction. There is no delete tool:
// automated tooling must not be able to destroy mail (the old system's
// rule, kept).

const EMAIL_ACCOUNTS = (process.env.EMAIL_ACCOUNTS || "fastmail,gmail")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Accounts allowed for this conversation. The gateway injects the
 *  resolver through buildZulipTools (person-scoped, fail closed); without
 *  it — local runs and tests — the env default list stands. */
let emailAccountsResolver = null;

async function allowedAccounts(api) {
  if (emailAccountsResolver) {
    return await emailAccountsResolver(api.conversationId);
  }
  return EMAIL_ACCOUNTS;
}

const noAccess = () => ({
  content: [
    {
      type: "text",
      text: "No email access is configured for this conversation. If this is your own DM, ask the owner to configure accounts for you.",
    },
  ],
});

// Fastmail JMAP client: session discovery + batched method calls, all
// through the proxy (token injected there). Direct mode (no proxy) needs
// FASTMAIL_API_TOKEN in this process's env — local runs only.
const fastmailJmap = (() => {
  const base = PROXY ? `${PROXY}/fastmail` : "https://api.fastmail.com";
  let accountId = null;
  let apiPath = null;
  const authHeaders = () =>
    PROXY ? {} : { Authorization: `Bearer ${process.env.FASTMAIL_API_TOKEN || ""}` };
  async function ensureSession() {
    if (accountId && apiPath) return;
    const res = await fetch(`${base}/jmap/session`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Fastmail session ${res.status}`);
    const data = await res.json();
    accountId = data.primaryAccounts?.["urn:ietf:params:jmap:mail"];
    if (!accountId) throw new Error("no JMAP mail account in Fastmail session");
    apiPath = `${base}${new URL(data.apiUrl).pathname}`;
  }
  async function call(methodCalls) {
    await ensureSession();
    const res = await fetch(apiPath, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        using: [
          "urn:ietf:params:jmap:core",
          "urn:ietf:params:jmap:mail",
          "urn:ietf:params:jmap:submission",
        ],
        methodCalls: methodCalls.map(([name, args, cid]) => [
          name,
          { accountId, ...args },
          cid,
        ]),
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Fastmail JMAP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    for (const [name, body] of data.methodResponses) {
      if (name === "error") throw new Error(`Fastmail JMAP error: ${JSON.stringify(body).slice(0, 200)}`);
    }
    return data.methodResponses;
  }
  async function mailboxId(folder) {
    const responses = await call([["Mailbox/get", { properties: ["name"] }, "mb"]]);
    const mbox = responses[0][1].list.find((m) => m.name.toLowerCase() === folder.toLowerCase());
    return mbox?.id || null;
  }
  return { call, mailboxId };
})();

async function fastmailSearch({ after, before, folder, limit, offset }) {
  const mailboxId = await fastmailJmap.mailboxId(folder);
  if (!mailboxId) return { total: 0, emails: [] };
  const responses = await fastmailJmap.call([
    [
      "Email/query",
      {
        filter: {
          inMailbox: mailboxId,
          after: `${after}T00:00:00Z`,
          before: `${before}T00:00:00Z`,
        },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit,
        position: offset,
      },
      "q",
    ],
    [
      "Email/get",
      {
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: ["id", "from", "subject", "receivedAt", "header:List-Unsubscribe"],
      },
      "g",
    ],
  ]);
  const total = responses[0][1].total ?? 0;
  const emails = (responses[1][1].list || []).map((e) => ({
    message_id: e.id,
    sender: e.from?.[0]?.email || "",
    subject: e.subject || "",
    date: e.receivedAt || "",
    has_list_unsubscribe: Boolean(e["header:List-Unsubscribe"]),
  }));
  return { total, emails };
}

async function fastmailGet(messageId, properties, extra = {}) {
  const responses = await fastmailJmap.call([["Email/get", { ids: [messageId], properties, ...extra }, "g"]]);
  return responses[0][1].list?.[0] || null;
}

async function fastmailSend(to, subject, body) {
  const responses = await fastmailJmap.call([
    [
      "Email/set",
      {
        create: {
          draft1: {
            to: [{ email: to }],
            subject,
            bodyValues: { body: { value: body, charset: "utf-8" } },
            textBody: [{ partId: "body", type: "text/plain" }],
            mailboxIds: {},
          },
        },
      },
      "s",
    ],
    [
      "EmailSubmission/set",
      {
        create: {
          sub1: {
            emailId: "#draft1",
            envelope: { mailFrom: { email: "" }, rcptTo: [{ email: to }] },
          },
        },
        onSuccessDestroyEmail: ["#sub1"],
      },
      "t",
    ],
  ]);
  if (responses[0][1].notCreated) throw new Error(`Fastmail draft failed: ${JSON.stringify(responses[0][1].notCreated)}`);
  if (responses[1][1].notCreated) throw new Error(`Fastmail submit failed: ${JSON.stringify(responses[1][1].notCreated)}`);
  return "sent";
}

// Gmail: REST-shaped calls served by the vault IMAP/SMTP sidecar (the
// sidecar emulates the Gmail REST API over IMAP with the app password).
// There is no direct mode — the sidecar holds the credential.
const gmailUrl = (path) => `${PROXY}/gmail/gmail/v1/users/me${path}`;

const GMAIL_LABELS = {
  inbox: "INBOX",
  sent: "SENT",
  drafts: "DRAFT",
  trash: "TRASH",
  spam: "SPAM",
  starred: "STARRED",
  important: "IMPORTANT",
  unread: "UNREAD",
};

function gmailHeader(headers, name) {
  const h = (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

async function gmailSearch({ after, before, folder, limit, offset }) {
  if (!PROXY) throw new Error("gmail requires the vault proxy (SEARCH_PROXY_URL)");
  const ymd = (iso) => iso.replace(/-/g, "/");
  const params = new URLSearchParams({
    q: `after:${ymd(after)} before:${ymd(before)}`,
    labelIds: GMAIL_LABELS[folder.toLowerCase()] || folder,
    maxResults: "500",
  });
  const res = await fetch(gmailUrl(`/messages?${params}`), {
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Gmail list ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const stubs = (await res.json()).messages || [];
  const total = stubs.length;
  const page = stubs.slice(offset, offset + limit);
  const emails = [];
  for (const stub of page) {
    const r = await fetch(
      gmailUrl(`/messages/${stub.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe`),
      { signal: AbortSignal.timeout(20000) }
    );
    if (!r.ok) continue;
    const msg = await r.json();
    const from = gmailHeader(msg.payload?.headers, "From") || "";
    emails.push({
      message_id: stub.id,
      sender: from.includes("<") ? from.split("<")[1].split(">")[0] : from,
      subject: gmailHeader(msg.payload?.headers, "Subject") || "",
      date: gmailHeader(msg.payload?.headers, "Date") || "",
      has_list_unsubscribe: Boolean(gmailHeader(msg.payload?.headers, "List-Unsubscribe")),
    });
  }
  return { total, emails };
}

async function gmailGet(messageId, format) {
  if (!PROXY) throw new Error("gmail requires the vault proxy (SEARCH_PROXY_URL)");
  const res = await fetch(gmailUrl(`/messages/${messageId}?format=${format}`), {
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Gmail get ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function gmailExtractBody(payload) {
  const data = payload?.body?.data;
  const mime = payload?.mimeType || "";
  let plain = "";
  if (data && mime === "text/plain") {
    plain = Buffer.from(data, "base64url").toString("utf8");
  }
  let html = "";
  for (const part of payload?.parts || []) {
    const d = part.body?.data;
    if (d && part.mimeType === "text/html") html = Buffer.from(d, "base64url").toString("utf8");
    else if (d && part.mimeType === "text/plain" && !plain) plain = Buffer.from(d, "base64url").toString("utf8");
    else if (part.parts) {
      const nested = gmailExtractBody(part);
      if (nested && !html && !plain) html = nested;
    }
  }
  return html || plain;
}

async function gmailSend(to, subject, body) {
  if (!PROXY) throw new Error("gmail requires the vault proxy (SEARCH_PROXY_URL)");
  const mime = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    body,
  ].join("\r\n");
  const res = await fetch(gmailUrl("/messages/send"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(mime).toString("base64url") }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Gmail send ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return "sent";
}

async function emailSearchOn(account, args) {
  if (account === "fastmail") return fastmailSearch(args);
  if (account === "gmail") return gmailSearch(args);
  throw new Error(`unknown account '${account}' (available: ${EMAIL_ACCOUNTS.join(", ")})`);
}

const emailAccountsTool = defineTool({
  name: "email_accounts",
  description: "List the email account names you may use. Use these with email_search, email_get_headers, email_get_body, and email_send.",
  parameters: Type.Object({}),
  replay: "safe",
  async execute(args, api) {
    const allowed = await allowedAccounts(api);
    if (allowed.length === 0) return noAccess();
    return { content: [{ type: "text", text: JSON.stringify(allowed) }] };
  },
});

const emailSearchTool = defineTool({
  name: "email_search",
  description:
    'Search email in a date range. Returns sender, subject, date, and whether the message has a List-Unsubscribe header. Examples: email_search(after="2026-11-01") for one account; leave account empty to merge all accounts.',
  parameters: Type.Object({
    after: Type.String({ description: 'Start date, ISO "YYYY-MM-DD"' }),
    before: Type.Optional(Type.String({ description: 'End date, ISO "YYYY-MM-DD". Defaults to today.' })),
    folder: Type.Optional(Type.String({ description: "Mailbox folder (default Inbox)" })),
    account: Type.Optional(Type.String({ description: "Account from email_accounts(); empty merges all accounts" })),
    limit: Type.Optional(Type.Number({ description: "Max results (default 20, max 50)" })),
    offset: Type.Optional(Type.Number({ description: "Results to skip for pagination (default 0)" })),
  }),
  replay: "safe",
  async execute(args, api) {
    const allowed = await allowedAccounts(api);
    if (allowed.length === 0) return noAccess();
    if (args.account && !allowed.includes(args.account)) {
      return {
        content: [{ type: "text", text: `Account '${args.account}' is not available in this conversation (available: ${allowed.join(", ")})` }],
      };
    }
    const limit = Math.min(Number(args.limit) || 20, 50);
    const offset = Number(args.offset) || 0;
    const before = args.before || new Date().toISOString().slice(0, 10);
    const folder = args.folder || "Inbox";
    const accounts = args.account ? [args.account] : allowed;
    const merged = [];
    let total = 0;
    for (const account of accounts) {
      const result = await emailSearchOn(account, { after: args.after, before, folder, limit: args.account ? limit : offset + limit, offset: args.account ? offset : 0 });
      total += result.total;
      merged.push(...result.emails.map((e) => ({ account, ...e })));
    }
    merged.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const page = args.account ? merged : merged.slice(offset, offset + limit);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ total, offset: args.account ? offset : offset, limit, emails: page }),
        },
      ],
    };
  },
});

const emailHeadersTool = defineTool({
  name: "email_get_headers",
  description:
    "Get key headers (From, Subject, List-Unsubscribe, List-Unsubscribe-Post) for one message — use for unsubscribe workflows.",
  parameters: Type.Object({
    account: Type.String({ description: "Account from email_accounts()" }),
    message_id: Type.String({ description: "Message id from email_search" }),
  }),
  replay: "safe",
  async execute(args, api) {
    const allowed = await allowedAccounts(api);
    if (!allowed.includes(args.account)) return noAccess();
    if (args.account === "fastmail") {
      const email = await fastmailGet(args.message_id, [
        "header:List-Unsubscribe",
        "header:List-Unsubscribe-Post",
        "header:From",
        "header:Subject",
      ]);
      const headers = {};
      for (const k of ["List-Unsubscribe", "List-Unsubscribe-Post", "From", "Subject"]) {
        const v = email?.[`header:${k}`];
        if (v) headers[k] = v.trim();
      }
      return { content: [{ type: "text", text: JSON.stringify(headers, null, 2) }] };
    }
    if (args.account === "gmail") {
      const msg = await gmailGet(args.message_id, "metadata");
      const headers = {};
      for (const name of ["List-Unsubscribe", "List-Unsubscribe-Post", "From", "Subject"]) {
        const v = gmailHeader(msg.payload?.headers, name);
        if (v) headers[name] = v.trim();
      }
      return { content: [{ type: "text", text: JSON.stringify(headers, null, 2) }] };
    }
    return { content: [{ type: "text", text: `unknown account '${args.account}'` }] };
  },
});

const emailBodyTool = defineTool({
  name: "email_get_body",
  description: "Get the body of one message (HTML preferred, plain text fallback).",
  parameters: Type.Object({
    account: Type.String({ description: "Account from email_accounts()" }),
    message_id: Type.String({ description: "Message id from email_search" }),
  }),
  replay: "safe",
  async execute(args, api) {
    const allowed = await allowedAccounts(api);
    if (!allowed.includes(args.account)) return noAccess();
    if (args.account === "fastmail") {
      const email = await fastmailGet(args.message_id, ["bodyValues", "htmlBody", "textBody"], {
        fetchHTMLBodyValues: true,
        fetchTextBodyValues: true,
      });
      const values = email?.bodyValues || {};
      for (const part of email?.htmlBody || []) {
        if (part.partId && values[part.partId]) {
          return { content: [{ type: "text", text: values[part.partId].value }] };
        }
      }
      for (const part of email?.textBody || []) {
        if (part.partId && values[part.partId]) {
          return { content: [{ type: "text", text: values[part.partId].value }] };
        }
      }
      return err("(empty body)");
    }
    if (args.account === "gmail") {
      const msg = await gmailGet(args.message_id, "full");
      const body = gmailExtractBody(msg.payload);
      return { content: [{ type: "text", text: body || "(empty body)" }] };
    }
    return { content: [{ type: "text", text: `unknown account '${args.account}'` }] };
  },
});

const emailSendTool = defineTool({
  name: "email_send",
  description:
    "Send an email from one of the user's accounts. Requires approval: the ask posts in the conversation and waits for the user's reaction. Use for replies, unsubscribe-by-mailto, and anything the user asks to be sent.",
  parameters: Type.Object({
    account: Type.String({ description: "Account from email_accounts()" }),
    to: Type.String({ description: "Recipient address" }),
    subject: Type.String({ description: "Subject line" }),
    body: Type.String({ description: "Body text (plain text)" }),
  }),
  replay: "safe",
  async execute(args, api) {
    const allowed = await allowedAccounts(api);
    if (!allowed.includes(args.account)) return noAccess();
    const result =
      args.account === "fastmail"
        ? await fastmailSend(args.to, args.subject, args.body)
        : args.account === "gmail"
          ? await gmailSend(args.to, args.subject, args.body)
          : (() => { throw new Error(`unknown account '${args.account}'`); })();
    return { content: [{ type: "text", text: `Email sent to ${args.to} ("${args.subject}").` }] };
  },
});


const searchTool = defineTool({
  name: "search",
  description:
    "Search the web and return ranked results with titles, URLs, and snippets. Use for facts, current events, and anything you do not know.",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    limit: Type.Optional(Type.Number({ description: "Number of results (default 5)" })),
  }),
  replay: "safe",
  async execute(args) {
    const limit = Number(args.limit) || 5;
    const lines =
      CONFIG.provider === "kagi" && (PROXY || CONFIG.kagi_key)
        ? await kagiSearch(args.query, limit)
        : await braveSearch(args.query, limit);
    return {
      content: [
        {
          type: "text",
          text: lines.length
            ? `Web search results for "${args.query}":\n\n${lines.join("\n\n")}`
            : `No results for "${args.query}".`,
        },
      ],
    };
  },
});

const summarizeTool = defineTool({
  name: "summarize_url",
  description: "Fetch and summarize the content of a web page (Kagi only).",
  parameters: Type.Object({ url: Type.String({ description: "Page URL" }) }),
  replay: "safe",
  async execute(args) {
    if (!(CONFIG.provider === "kagi" && (PROXY || CONFIG.kagi_key))) {
      return { content: [{ type: "text", text: "summarize_url is available only when the Kagi provider is configured." }] };
    }
    const text = await kagiSummarize(args.url);
    return { content: [{ type: "text", text }] };
  },
});

// ---------------------------------------------------------------------------
// Channel-scoped history search over past conversations in this channel.

function scoreText(terms, text) {
  let score = 0;
  const lower = text.toLowerCase();
  for (const term of terms) {
    let idx = 0;
    let hits = 0;
    while ((idx = lower.indexOf(term, idx)) !== -1) {
      hits += 1;
      idx += term.length;
    }
    score += hits;
  }
  return score;
}

function entryText(entry) {
  if (!entry.model) return "";
  return entry.model
    .map((m) => (m.role === "user" || m.role === "assistant" ? contentText(m.content) : ""))
    .filter(Boolean)
    .join("\n");
}

const historySearchTool = defineTool({
  name: "history_search",
  description:
    "Search past conversation transcripts in this channel (all topics, including ended ones). Returns matching snippets with their topic names. Use this to recall what was discussed or decided earlier.",
  parameters: Type.Object({
    query: Type.String({ description: "Search terms" }),
  }),
  replay: "safe",
  async execute(args, api, context) {
    const mine = await api.snapshot(ZulipDoc, api.conversationId, context);
    if (!mine?.stream) {
      return { content: [{ type: "text", text: "No channel mapping for this conversation." }] };
    }
    const terms = args.query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);

    const matches = [];
    let cursor = undefined;
    for (;;) {
      const page = await api.commit(
        (tx) => tx.scanConversations({}, 50, cursor),
        context
      );
      for (const record of page.items) {
        if (record.id === api.conversationId) continue;
        const doc = await api.snapshot(ZulipDoc, record.id, context);
        if (doc?.stream !== mine.stream || !doc?.topic) continue;
        let entryCursor = undefined;
        let scanned = 0;
        let best = null;
        for (;;) {
          const entries = await api.commit(
            (tx) => tx.scanEntries({ conversationId: record.id }, 200, entryCursor),
            context
          );
          for (const entry of entries.items) {
            const text = entryText(entry);
            if (!text) continue;
            const score = scoreText(terms, text);
            if (score > 0 && (!best || score > best.score)) {
              best = { score, text: text.slice(0, 400) };
            }
          }
          scanned += entries.items.length;
          entryCursor = entries.next;
          if (!entryCursor || scanned >= 600) break;
        }
        if (best) {
          matches.push({ topic: doc.topic, score: best.score, snippet: best.text });
        }
      }
      cursor = page.next;
      if (!cursor || matches.length >= 30) break;
    }

    matches.sort((a, b) => b.score - a.score);
    const top = matches.slice(0, 6);
    if (top.length === 0) {
      return {
        content: [{ type: "text", text: `No past conversations in this channel match "${args.query}".` }],
      };
    }
    const lines = top.map(
      (m, i) => `${i + 1}. Topic "${m.topic}" (relevance ${m.score}):\n   ${m.snippet.replace(/\n/g, "\n   ").slice(0, 350)}`
    );
    return {
      content: [
        {
          type: "text",
          text: `Matches in this channel's history for "${args.query}":\n\n${lines.join("\n\n")}\n\nOpen that topic's conversation directly by asking the user, or use fork_thread with its topic name to work from it.`,
        },
      ],
    };
  },
});

// Upstream provider failures can arrive as the model's own output (a
// completed message whose text is the error), bypassing the harness's retry
// classification. Same shape test the gateway uses before posting replies.
const PROVIDER_ERROR_RE =
  /^(Error calling LLM|litellm\.|OpenAIException|Error code: [45]\d\d|API error|Rate limit)/i;

// ---------------------------------------------------------------------------
// Threads: fork this conversation, or spawn a fresh subagent thread.

export function buildZulipTools({
  onThreadCreated,
  onPushChanges,
  onUpload,
  resolveWorkStream,
  onTaskAgent,
  onSaveSkill,
  onTaskLedger,
  emailAccountsFor,
  onMemorySearch,
  uniqueTopicFor,
}) {
  emailAccountsResolver = emailAccountsFor ?? null;
  const err = (text) => ({ content: [{ type: "text", text }] });

  // The DM front conversation's delegation tool (the dm-first memo). It
  // starts a task conversation as a topic of the person's work stream:
  // the task's steps and spoilers are visible there, while the DM gets the
  // answer. Sync runs use the pi-durable subagent pattern — the child is
  // owned by this tool call's task, so a crash rerun reuses it and /stop
  // aborts it; wait=false runs ownerless in the background, and the
  // gateway posts the result back into the DM when it finishes.
  const runTaskTool = defineTool({
    name: "run_task",
    description:
      "Start a task conversation for a self-contained job and get its answer back. The task runs in the person's work stream as its own topic (its steps are visible there) while this conversation waits. Use it for multi-step jobs: document processing, file transformations, deliverables. Pass file paths (uploads land in uploads/). Set wait=false to run in the background instead; the result will be posted into this thread when the task finishes.",
    parameters: Type.Object({
      topic: Type.String({ description: "Short topic name for the task, 2-4 words" }),
      task: Type.String({ description: "The complete, self-contained task for the task conversation, including the file paths it should use" }),
      wait: Type.Optional(Type.Boolean({ description: "Wait for the result and return it (default true). false = run in the background." })),
    }),
    replay: "safe",
    async execute(args, api, context) {
      const mine = await api.snapshot(ZulipDoc, api.conversationId, context);
      if (!mine) return err("No channel mapping for this conversation.");
      if (!mine.recipients) {
        return err("run_task is for direct messages — in a channel, use spawn_thread instead.");
      }
      if (!resolveWorkStream || !onTaskAgent || !uniqueTopicFor) {
        return err("run_task is not available in this channel.");
      }
      const target = await resolveWorkStream(mine);
      if (!target?.stream) return err(target?.error || "No work stream is configured for this conversation.");
      const stream = target.stream;
      const topic = uniqueTopicFor(stream, args.topic);
      const header =
        `*(task for ${mine.person?.name ?? mine.person?.email ?? "the user"}, ` +
        `delegated from the direct-message thread — task: ${String(args.task).slice(0, 150)})*`;
      const mapping = { kind: "task", stream, topic, header, fromDm: mine.stream };
      // tx.createConversation only takes ownership; the agent (model,
      // instructions, tools) is set with configure() and the doc in the same
      // commit — the pattern spawn_thread already uses. Runs on the caller's
      // tx; never nests commits.
      const createChild = async (tx, ownership) => {
        const record = await tx.createConversation({ ownership });
        await configure(tx, record.id, onTaskAgent(stream, mine.model, mine.person));
        const doc = await tx.doc(ZulipDoc, record.id);
        doc.stream = stream;
        doc.topic = topic;
        doc.origin = { taskFrom: mine.topic };
        doc.model = "auto";
        return record.id;
      };

      const ledger = async (text) => {
        try {
          await onTaskLedger?.(stream, text);
        } catch {
          /* the ledger is a side record; never fail the task for it */
        }
      };
      await ledger(`started "${topic}" (${args.wait === false ? "background" : "sync"}) → #${stream}`);

      if (args.wait !== false) {
        // Sync: the child belongs to this tool call's task. The ownership
        // index makes a crash rerun reuse the same child; the same
        // requestId makes it reuse the same submission.
        let childId = await api.commit(async (tx) => {
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (existing !== undefined) return existing.id;
          return createChild(tx, { kind: "task", taskId: api.taskId });
        }, context);
        await api.details({ conversationId: childId }, context);
        await onThreadCreated?.(childId, mapping);
        const child = await api.conversation(childId, context);
        if (!child) return err(`The task conversation is gone (${topic}).`);
        const submission = await child.submit(
          { type: "input", content: args.task, requestId: `task:${childId}`, whenBusy: "followUp" },
          context
        );
        const settled = await submission.wait(context);
        if (settled.status !== "done") {
          await ledger(`aborted "${topic}" — ${settled.status}`);
          return err(
            `The task "${topic}" did not finish (${settled.status}` +
              `${settled.reason ? ": " + settled.reason : ""}). Tell the user what happened.`
          );
        }
        const answer = await api.commit(async (tx) => {
          const page = await tx.scanEntries(
            { conversationId: childId, minEntryId: settled.answer, maxEntryId: settled.answer },
            1
          );
          const message = page.items[0]?.model?.[0];
          return message && message.role === "assistant"
            ? contentText(message.content).trim()
            : "";
        }, context);
        // A provider failure can arrive as the task's own output (upstream
        // 5xx wrapped in a completed message); the raw text must not be
        // relayed into the person's thread.
        if (PROVIDER_ERROR_RE.test(answer.slice(0, 200))) {
          await ledger(`failed "${topic}" — model service error`);
          return err(
            `Task "${topic}" hit a model-service error and did not complete. ` +
            `Tell the user it failed, and offer to run it again.`
          );
        }
        await ledger(
          `finished "${topic}" — ${answer.slice(0, 120).replace(/\n/g, " ") || "done"}`
        );
        return {
          content: [
            {
              type: "text",
              text:
                `Task "${topic}" finished (visible in ${stream}). Answer:\n\n` +
                (answer.slice(0, 4000) || "*(no text — check the task topic)*"),
            },
          ],
        };
      }

      // Fire-and-forget: an ownerless child the gateway submits itself
      // (runSpawnedThread), posting the answer in the task topic and a
      // follow-up here when it finishes. The memo keeps the child out of
      // this call's ownership so the call can return at once.
      let childId = await api.memo(`taskspawn:${stream}:${topic}`, context);
      if (childId === undefined) {
        childId = await api.commit((tx) => createChild(tx, { kind: "ownerless" }), context);
        await api.memo(`taskspawn:${stream}:${topic}`, childId, context);
      }
      await onThreadCreated?.(childId, {
        ...mapping,
        task: args.task,
        notify: { dmChannel: mine.stream },
      });
      return {
        content: [
          {
            type: "text",
            text: `Background task "${topic}" started in ${stream}. Its result will be posted here when it finishes. Tell the user it is running and where it is visible.`,
          },
        ],
      };
    },
  });

  const spawnThreadTool = defineTool({
    name: "spawn_thread",
    description:
      "Start a new conversation in a new topic of this channel and give it a task. It runs independently and answers in that topic; this conversation continues without waiting. Returns the topic name.",
    parameters: Type.Object({
      topic: Type.String({ description: "Short topic name for the new thread, 2-4 words" }),
      task: Type.String({ description: "The complete task for the new conversation" }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      const mine = await api.snapshot(ZulipDoc, api.conversationId, context);
      if (!mine?.stream) {
        return { content: [{ type: "text", text: "No channel mapping for this conversation." }] };
      }
      if (mine.recipients) {
        return { content: [{ type: "text", text: "spawn_thread is not available in direct messages (there are no topics to spawn)." }] };
      }
      let childId = await api.memo(`spawn:${args.topic}`, context);
      if (childId === undefined) {
        childId = await api.commit(async (tx) => {
          const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
          const doc = await tx.doc(ZulipDoc, record.id);
          doc.stream = mine.stream;
          doc.topic = args.topic;
          doc.origin = { spawnedFrom: mine.topic };
          return record.id;
        }, context);
        await api.memo(`spawn:${args.topic}`, childId, context);
      }
      // The gateway learns the mapping and runs the task itself: the tool's
      // invocation ends when the tool returns, and a submission handle bound to
      // it dies with it.
      onThreadCreated?.(childId, {
        stream: mine.stream,
        topic: args.topic,
        header: `*(new thread, spawned from "${mine.topic}" — task: ${args.task})*`,
        task: args.task,
      });
      return {
        content: [{ type: "text", text: `Thread started in topic "${args.topic}". It will reply there.` }],
      };
    },
  });

  const forkThreadTool = defineTool({
    name: "fork_thread",
    description:
      "Fork this conversation into a new topic: the new thread starts with this conversation's full history and continues independently. Use it to take one branch of the discussion aside. Returns the new topic name.",
    parameters: Type.Object({
      topic: Type.String({ description: "Short topic name for the forked thread, 2-4 words" }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      const mine = await api.snapshot(ZulipDoc, api.conversationId, context);
      if (!mine?.stream) {
        return { content: [{ type: "text", text: "No channel mapping for this conversation." }] };
      }
      if (mine.recipients) {
        return { content: [{ type: "text", text: "fork_thread is not available in direct messages (there are no topics to fork into)." }] };
      }
      let forkId = await api.memo(`fork:${args.topic}`, context);
      if (forkId === undefined) {
        // Fork at the newest entry, inside a commit so the doc is set atomically.
        forkId = await api.commit(async (tx) => {
          const latest =
            (await tx.latestHeadMarker(api.conversationId))?.head ??
            (await tx.scanEntries({ conversationId: api.conversationId }, 1)).items[0]?.id;
          if (!latest) {
            throw new Error("conversation has no entries to fork from");
          }
          const record = await tx.forkConversation(api.conversationId, latest, {
            ownership: { kind: "ownerless" },
          });
          const doc = await tx.doc(ZulipDoc, record.id);
          doc.stream = mine.stream;
          doc.topic = args.topic;
          doc.origin = { forkOf: mine.topic };
          return record.id;
        }, context);
        await api.memo(`fork:${args.topic}`, forkId, context);
      }
      onThreadCreated?.(forkId, {
        stream: mine.stream,
        topic: args.topic,
        header: `*(fork of "${mine.topic}" — full history carried over; continue here)*`,
      });
      return {
        content: [{ type: "text", text: `Forked into topic "${args.topic}" with this conversation's history. Continue the fork there.` }],
      };
    },
  });

  // Hand a file to the user: the gateway reads the path from the
  // channel's workspace mount (a path outside it is refused), uploads it
  // to Zulip with the bot's credentials, and returns a shareable link.
  // Sessions hold no Zulip credentials, so only the gateway side can
  // actually move bytes out of the workspace.
  const uploadFileTool = defineTool({
    name: "upload_file",
    description:
      "Upload a file from the workspace to Zulip and return a download link, so you can hand a file to the user (a PDF, image, data export, anything too big to paste). Use it whenever the user should receive a file that lives in the workspace, then include the returned markdown link in your reply.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative path of the file, e.g. notes/report.pdf" }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      const mine = await api.snapshot(ZulipDoc, api.conversationId, context);
      if (!mine?.stream) {
        return { content: [{ type: "text", text: "No channel mapping for this conversation." }] };
      }
      if (!onUpload) {
        return { content: [{ type: "text", text: "upload_file is not available in this channel." }] };
      }
      let result;
      try {
        result = await onUpload(mine.stream, args.path);
      } catch (err) {
        return { content: [{ type: "text", text: `Upload failed: ${err.message}` }] };
      }
      const sizeText =
        result.size < 1024 * 1024
          ? `${Math.max(1, Math.round(result.size / 1024))} KB`
          : `${(result.size / 1024 / 1024).toFixed(1)} MB`;
      return {
        content: [
          {
            type: "text",
            text:
              `Uploaded ${result.name} (${sizeText}). Share it in your reply with this markdown link ` +
              `(Zulip renders it as a file link the user can open or download):\n\n` +
              `[${result.name}](${result.url})`,
          },
        ],
      };
    },
  });

  // The meta channel's push: the gateway runs git push with a deploy key
  // that lives only on the gateway side, so agents can trigger a push but
  // never read the key.
  const pushChangesTool = defineTool({
    name: "push_changes",
    description:
      "Push the workspace repository's commits to the origin remote on GitHub (branch main). The gateway first posts an approval message in the topic listing the commits; the push runs only after the owner reacts with a check mark (auto-denied after 20 minutes). Use it after committing work that should deploy; CI/CD picks it up from there.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api, context) {
      const mine = await api.snapshot(ZulipDoc, api.conversationId, context);
      if (!mine?.stream) {
        return { content: [{ type: "text", text: "No channel mapping for this conversation." }] };
      }
      const out = await onPushChanges?.(api.conversationId, mine.stream);
      return {
        content: [{ type: "text", text: out ?? "push_changes is not available in this channel." }],
      };
    },
  });

  // Skills loop (dm-first memo, step 5, revised the same day for autonomy):
  // the agent saves and amends skills on its own and asks the person
  // afterward whether to keep each one (post-hoc consent; the git-versioned
  // tree is the tamper-evidence, and delete_skill removes what the person
  // declines). Skills are prompt content: the exec containers mount the
  // skills tree read-only, so writes happen gateway-side. A front
  // conversation saves into the person's work stream, where task
  // conversations load skills; a task or stream conversation saves into
  // its own stream.
  const skillResult = (mode, r) =>
    `Skill ${mode === "save" ? "saved" : "updated"}: ${r.dir}. Future task conversations in that stream load it automatically when the description matches. ` +
    `Tell the person now what you kept and why, and ask whether to keep it. ` +
    `If they say no, call delete_skill with the same name.`;
  const saveSkillTool = defineTool({
    name: "save_skill",
    description:
      "Save a skill: a reusable, step-by-step method for a kind of job, stored as a skill that future task conversations load automatically. Use it when a job reveals a repeatable method (a workflow, a file format, a recurring deliverable) or when the person gives durable feedback on how work should be done. After saving, tell the person what you kept and ask whether to keep it. Name it after the kind of job (e.g. 'apa-citation-fixes'); instructions are the complete method, written for an agent that knows nothing else.",
    parameters: Type.Object({
      name: Type.String({ description: "Short skill name, kebab-case (e.g. 'docx-citation-fixes')" }),
      description: Type.String({ description: "One sentence: what the skill does and when to use it — this is what future agents see when deciding to load it" }),
      instructions: Type.String({ description: "The complete method as markdown: steps, commands, file paths, conventions. Written for an agent in a fresh task conversation." }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      if (!onSaveSkill) return err("save_skill is not available in this channel.");
      try {
        const r = await onSaveSkill(api.conversationId, { ...args, mode: "save" });
        return { content: [{ type: "text", text: skillResult("save", r) }] };
      } catch (e) {
        return err(`save_skill failed: ${e.message}`);
      }
    },
  });
  const updateSkillTool = defineTool({
    name: "update_skill",
    description:
      "Update the instructions of an existing skill (from feedback or a changed method). Tell the person what changed, and ask whether to keep it. Keep the description accurate; instructions replace the old ones entirely.",
    parameters: Type.Object({
      name: Type.String({ description: "The existing skill's name" }),
      instructions: Type.String({ description: "The complete updated method as markdown (replaces the old instructions)" }),
      description: Type.Optional(Type.String({ description: "New one-sentence description (unchanged if omitted)" })),
    }),
    replay: "safe",
    async execute(args, api, context) {
      if (!onSaveSkill) return err("update_skill is not available in this channel.");
      try {
        const r = await onSaveSkill(api.conversationId, { ...args, mode: "update" });
        return { content: [{ type: "text", text: skillResult("update", r) }] };
      } catch (e) {
        return err(`update_skill failed: ${e.message}`);
      }
    },
  });

  const deleteSkillTool = defineTool({
    name: "delete_skill",
    description:
      "Delete a skill the person declined to keep (or one that proved wrong). Removed skills stop loading in future conversations; the git history keeps the old text.",
    parameters: Type.Object({
      name: Type.String({ description: "The skill's name" }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      if (!onSaveSkill) return err("delete_skill is not available in this channel.");
      try {
        const r = await onSaveSkill(api.conversationId, { ...args, mode: "delete" });
        return {
          content: [
            { type: "text", text: `Skill deleted: ${r.dir}. Confirm to the person that it is gone.` },
          ],
        };
      } catch (e) {
        return err(`delete_skill failed: ${e.message}`);
      }
    },
  });

  // Memory recall (dm-first memo, the OpenClaw lore shape): the
  // always-loaded memory stays small; durable detail lives in memory topic
  // files, found by explicit search. Hermes's lesson: hoped-for recall rarely
  // fires — the agent goes looking.
  const memorySearchTool = defineTool({
    name: "memory_search",
    description:
      "Search this person's memory files (memory/) for remembered facts, preferences, and detail not in the loaded memory. Use when a task needs something that may be remembered — before asking the user.",
    parameters: Type.Object({
      query: Type.String({ description: "What to look for: key terms, not a sentence" }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      if (!onMemorySearch) return err("memory_search is not available in this channel.");
      let hits;
      try {
        hits = await onMemorySearch(api.conversationId, args.query);
      } catch (e) {
        return err(`memory_search failed: ${e.message}`);
      }
      if (!hits || hits.length === 0) {
        return {
          content: [
            { type: "text", text: `Nothing in memory matches "${args.query}". Read memory/user.md if you have not, then ask the user.` },
          ],
        };
      }
      const lines = hits.map(
        (h) => `${h.file}:${h.line} — ${h.text}`
      );
      return {
        content: [
          {
            type: "text",
            text: `Memory matches for "${args.query}" (best first):

${lines.join("\n")}

Read the full file (workspace-relative path) for context around a match.`,
          },
        ],
      };
    },
  });

  return defineExtension({
    name: "zulip",
    tools: [
      searchTool,
      summarizeTool,
      historySearchTool,
      runTaskTool,
      spawnThreadTool,
      forkThreadTool,
      pushChangesTool,
      uploadFileTool,
      saveSkillTool,
      emailAccountsTool,
      emailSearchTool,
      emailHeadersTool,
      emailBodyTool,
      emailSendTool,
      updateSkillTool,
      deleteSkillTool,
      memorySearchTool,
    ],
  });
}
