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

// Card fill runs as page JavaScript: detection on real attributes
// (autocomplete hints first, name/id/placeholder fallbacks), values set
// via the native property setter + input/change events so framework forms
// (React et al.) register them. The eval script carries the card values
// and lives only inside this container; the result is labels only.
function fillCardScript() {
  const c = {
    number: CARD.number,
    cvc: CARD.cvc,
    name: CARD.name,
    exp: CARD.expMonth && CARD.expYear ? `${CARD.expMonth}/${CARD.expYear}` : "",
    expMonth: CARD.expMonth,
    expYear: CARD.expYear,
  };
  return `
(function () {
  var values = ${JSON.stringify(c)};
  var rx = {
    number: /(cc|card)[- _]?number|cardnumber|ccnum/i,
    cvc: /(^|[^a-z])(cvc|cvv)|cc-?cs|security[ _]?code|card[ _]?verification/i,
    expMonth: /exp(ir(ation|y)?)?[ _-]?month|cc-?exp-?month/i,
    expYear: /exp(ir(ation|y)?)?[ _-]?year|cc-?exp-?year/i,
    exp: /exp(ir(ation|y)?)?([ _-]?(date|field))?$|mm[ \/]?yy/i,
    name: /cc-?name|card[ _]?name|name[ _]?on[ _]?card|cardholder/i,
  };
  function label(el) {
    return (el.getAttribute("autocomplete") || el.name || el.id || el.getAttribute("placeholder") || "field").slice(0, 30);
  }
  function set(el, value) {
    if (!value) return false;
    var proto = Object.getPrototypeOf(el);
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  var found = {};
  var fields = { number: null, cvc: null, expMonth: null, expYear: null, exp: null, name: null };
  var els = document.querySelectorAll("input, select");
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (el.disabled || el.readOnly) continue;
    var attrs = [el.getAttribute("autocomplete"), el.name, el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label")].join(" ");
    var ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (ac === "cc-number" || (!fields.number && rx.number.test(attrs))) fields.number = el;
    if (/^cc-csc$|^cc-cvc$/.test(ac) || (!fields.cvc && rx.cvc.test(attrs))) fields.cvc = el;
    if (ac === "cc-exp-month" || (!fields.expMonth && rx.expMonth.test(attrs))) fields.expMonth = el;
    if (ac === "cc-exp-year" || (!fields.expYear && rx.expYear.test(attrs))) fields.expYear = el;
    if (ac === "cc-exp" || (!fields.exp && !rx.expMonth.test(attrs) && !rx.expYear.test(attrs) && rx.exp.test(attrs))) fields.exp = el;
    if (ac === "cc-name" || (!fields.name && rx.name.test(attrs))) fields.name = el;
  }
  var filled = [];
  if (fields.number) { set(fields.number, values.number) && filled.push(label(fields.number)); }
  if (fields.cvc) { set(fields.cvc, values.cvc) && filled.push(label(fields.cvc)); }
  if (fields.expMonth) { set(fields.expMonth, values.expMonth) && filled.push(label(fields.expMonth)); }
  if (fields.expYear) { set(fields.expYear, values.expYear) && filled.push(label(fields.expYear)); }
  if (!fields.expMonth && !fields.expYear && fields.exp) { set(fields.exp, values.exp) && filled.push(label(fields.exp)); }
  if (fields.name) { set(fields.name, values.name) && filled.push(label(fields.name)); }
  return JSON.stringify({ filled: filled });
})()`;
}

async function handleFillCard(key) {
  if (!CARD.number) {
    return { ok: false, filled: [], output: "", note: "no card configured on the vault (CARD_NUMBER unset)" };
  }
  const script = fillCardScript();
  const r = await runCli(key, ["eval", "-b", Buffer.from(script).toString("base64")]);
  let filled = [];
  let note = "";
  try {
    const m = (r.output || "").match(/\{[^]*\}/);
    if (m) filled = JSON.parse(m[0]).filled || [];
  } catch {
    /* fall through */
  }
  if (r.code !== 0 || filled.length === 0) {
    note = filled.length === 0 && r.code === 0
      ? "no card fields detected on this page — some merchants embed card fields in a provider's cross-origin iframe, which cannot be filled; tell the user if so"
      : "card fill failed: " + redact(r.output).slice(0, 200);
  } else {
    note = "filled: " + filled.join(", ");
  }
  return { ok: r.code === 0 && filled.length > 0, filled, output: "", note };
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
