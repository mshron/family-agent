#!/usr/bin/env node
// Minimal stdio MCP server exposing web search through Kagi or Brave.
// One tool: `search` (and `summarize_url` on Kagi). Selected by SEARCH_PROVIDER.
// Zero npm dependencies: plain JSON-RPC over stdin/stdout, fetch for HTTP.
//
// Wire format: one JSON object per line. Requests may be notifications
// (no `id`) which take no response.

const PROVIDER = process.env.SEARCH_PROVIDER || "brave";
const KAGI_KEY = process.env.KAGI_API_KEY || "";
const BRAVE_KEY = process.env.BRAVE_API_KEY || "";

function log(...args) {
  // MCP stdio reserves stdout for protocol; logs go to stderr.
  console.error("[search-mcp]", ...args);
}

async function kagiSearch(query, limit) {
  const url = new URL("https://kagi.com/api/v2/search");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.min(limit, 25)));
  const res = await fetch(url, {
    headers: { Authorization: `Bot ${KAGI_KEY}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Kagi API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const results = body?.data || [];
  return results
    .filter((r) => r.title && r.url)
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ""}`);
}

async function kagiSummarize(targetUrl) {
  const url = new URL("https://kagi.com/api/v2/summarize");
  url.searchParams.set("url", targetUrl);
  url.searchParams.set("summary_engine", "cecil");
  const res = await fetch(url, {
    headers: { Authorization: `Bot ${KAGI_KEY}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Kagi API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body?.data?.output || "(no summary produced)";
}

async function braveSearch(query, limit) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(limit, 20)));
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": BRAVE_KEY,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Brave API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const results = body?.web?.results || [];
  return results
    .filter((r) => r.title && r.url)
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.description || "").replace(/<[^>]+>/g, "")}`);
}

function toolsFor(provider) {
  const search = {
    name: "search",
    description:
      "Search the web and return ranked results with titles, URLs, and snippets. Use for facts, current events, and anything you do not know.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Number of results (default 5)" },
      },
      required: ["query"],
    },
  };
  const tools = [search];
  if (provider === "kagi") {
    tools.push({
      name: "summarize_url",
      description: "Fetch and summarize the content of a web page.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "Page URL" } },
        required: ["url"],
      },
    });
  }
  return tools;
}

async function callTool(name, args) {
  if (name === "search") {
    const query = String(args.query || "");
    const limit = Number(args.limit) || 5;
    if (!query) throw new Error("query is required");
    const lines =
      PROVIDER === "kagi"
        ? await kagiSearch(query, limit)
        : await braveSearch(query, limit);
    return lines.length
      ? `Web search results for "${query}":\n\n${lines.join("\n\n")}`
      : `No results for "${query}".`;
  }
  if (name === "summarize_url" && PROVIDER === "kagi") {
    return kagiSummarize(String(args.url || ""));
  }
  throw new Error(`Unknown tool: ${name}`);
}

const TOOLS = toolsFor(PROVIDER);

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim()) handle(line.trim());
  }
});
process.stdin.on("end", () => process.exit(0));

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // Ignore malformed lines; MCP servers do not reply to garbage.
  }
  const method = msg.method;
  if (msg.id === undefined) return; // Notification: nothing to answer.
  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "search", version: "1.0.0" },
        },
      });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      try {
        const text = await callTool(name, args);
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text }] },
        });
      } catch (err) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            isError: true,
            content: [{ type: "text", text: String(err.message || err) }],
          },
        });
      }
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    } else {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  } catch (err) {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32603, message: String(err.message || err) },
    });
  }
}

log(`starting, provider=${PROVIDER}, kagi_key=${KAGI_KEY ? "present" : "absent"}, brave_key=${BRAVE_KEY ? "present" : "absent"}`);
