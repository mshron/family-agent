// Vault browser service: the ONE browser, living on the trusted box.
// Each conversation gets its own agent-browser daemon (lazy start, idle
// sweep). Sessions drive it through fa-proxy's /browser route; card data
// exists only in this process's environment and is typed only by
// fill-card, whose outputs are field labels, never values. Everything
// the service returns passes redact() first: PAN-shaped digit runs never
// leave this box.

const http = require("node:http");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 8090);
const DATA_ROOT = "/tmp/agent-browser";
const MAX_INSTANCES = Number(process.env.MAX_INSTANCES || 8);
const IDLE_MS = 30 * 60 * 1000;

const CARD = {
  number: (process.env.CARD_NUMBER || "").replace(/\s+/g, ""),
  name: process.env.CARD_NAME || "",
  expMonth: process.env.CARD_EXP_MONTH || "",
  expYear: process.env.CARD_EXP_YEAR || "",
  cvc: process.env.CARD_CVC || "",
};

const instances = new Map(); // key -> { dir, last: ms }

function acquire(key) {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) throw new Error("bad instance key");
  let inst = instances.get(key);
  if (!inst) {
    if (instances.size >= MAX_INSTANCES) {
      throw new Error("too many browser instances active; close one (browser close) or retry later");
    }
    const dir = path.join(DATA_ROOT, key);
    fs.mkdirSync(dir, { recursive: true });
    inst = { dir, last: Date.now() };
    instances.set(key, inst);
  }
  inst.last = Date.now();
  return inst;
}

function release(key) {
  const inst = instances.get(key);
  if (inst) {
    fs.rmSync(inst.dir, { recursive: true, force: true });
    instances.delete(key);
  }
}

function runCli(key, args) {
  const inst = acquire(key);
  return new Promise((resolve) => {
    execFile(
      "agent-browser",
      args,
      {
        env: {
          ...process.env,
          AGENT_BROWSER_DATA_DIR: inst.dir,
          AGENT_BROWSER_SOCKET_DIR: inst.dir,
        },
        timeout: 90_000,
      },
      (err, stdout, stderr) => {
        const output = `${stdout || ""}${stderr && !stdout.trim() ? stderr : ""}`.trim();
        resolve({ code: err ? err.code ?? 1 : 0, output });
      }
    );
  });
}

// Redaction at the source: a 13-19 digit run (spaces/dashes allowed) never
// crosses to the session box. Short secrets (CVC) never enter output at
// all — fill-card reports field labels only.
function redact(text) {
  return String(text).replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => m.replace(/\d/g, "*"));
}

// Tokenize a command string the way a shell would for simple cases:
// "fill @e3 \"some text\"" -> ["fill","@e3","some text"]
function tokenize(command) {
  const out = [];
  for (const tok of String(command).match(/"[^"]*"|\S+/g) || []) {
    out.push(tok.startsWith('"') && tok.endsWith('"') ? tok.slice(1, -1) : tok);
  }
  return out;
}

// Card-field detection over snapshot -i output. Autocomplete hints are the
// reliable signal; name/id/placeholder words are the fallback.
const PATTERNS = {
  number: /(cc-number|cardnumber|card-?number|ccnum)/i,
  cvc: /(cc-csc|cc-cvc|cvc|cvv|security[ -]?code)/i,
  exp: /(cc-exp$|card-?exp(?!ir[- ]?(month|year))|expir(?:ation|y)[- ]?(date|field)?$)/i,
  expMonth: /(cc-exp-?month|expir[- ]?month|exp[- ]?month)/i,
  expYear: /(cc-exp-?year|expir[- ]?year|exp[- ]?year)/i,
  name: /(cc-name|card-?name|name[ -]?on[ -]?card)/i,
};

function cardFields(snapshotText) {
  const fields = {};
  for (const line of String(snapshotText).split("\n")) {
    const m = line.match(/^(@e\d+)/);
    if (!m) continue;
    const ref = m[1];
    const low = line.toLowerCase();
    for (const [field, re] of Object.entries(PATTERNS)) {
      if (!fields[field] && re.test(low)) fields[field] = ref;
    }
  }
  return fields;
}

async function handleFillCard(key) {
  const snap = await runCli(key, ["snapshot", "-i"]);
  const fields = cardFields(snap.output);
  if (!fields.number) {
    return { ok: true, filled: [], output: redact(snap.output).slice(0, 1500), note: "no card fields detected on this page — navigate to the payment form first" };
  }
  if (!CARD.number) {
    return { ok: false, filled: [], output: "", note: "no card configured on the vault (CARD_NUMBER unset)" };
  }
  const filled = [];
  const fill = async (ref, value, label) => {
    const r = await runCli(key, ["fill", ref, value]);
    if (r.code === 0) filled.push(label);
  };
  await fill(fields.number, CARD.number, "card number");
  if (fields.cvc && CARD.cvc) await fill(fields.cvc, CARD.cvc, "cvc");
  if (fields.name && CARD.name) await fill(fields.name, CARD.name, "name on card");
  if (fields.exp && CARD.expMonth && CARD.expYear) {
    await fill(fields.exp, `${CARD.expMonth}/${CARD.expYear}`, "expiry");
  } else {
    if (fields.expMonth && CARD.expMonth) await fill(fields.expMonth, CARD.expMonth, "expiry month");
    if (fields.expYear && CARD.expYear) await fill(fields.expYear, CARD.expYear, "expiry year");
  }
  return { ok: true, filled, output: "", note: `filled: ${filled.join(", ") || "none"}` };
}

const json = (res, status, data) => {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { ok: false, output: "POST only" });
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let data;
    try {
      data = JSON.parse(body || "{}");
    } catch {
      return json(res, 400, { ok: false, output: "bad json" });
    }
    try {
      if (req.url === "/run") {
        const args = tokenize(data.command || "");
        if (args.length === 0) return json(res, 400, { ok: false, output: "empty command" });
        const result = await runCli(data.key, args);
        if (args[0] === "close") release(data.key);
        return json(res, 200, { ok: result.code === 0, code: result.code, output: redact(result.output) });
      }
      if (req.url === "/fill-card") {
        const result = await handleFillCard(data.key);
        return json(res, 200, result);
      }
      if (req.url === "/health") return json(res, 200, { ok: true, instances: instances.size });
      return json(res, 404, { ok: false, output: "unknown route" });
    } catch (err) {
      return json(res, 500, { ok: false, output: String(err.message || err) });
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [key, inst] of [...instances]) {
    if (now - inst.last > IDLE_MS) {
      runCli(key, ["close"]).finally(() => release(key));
    }
  }
}, 5 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`vault browser service on :${PORT} (max ${MAX_INSTANCES} instances, idle ${IDLE_MS / 60000}m)`));
