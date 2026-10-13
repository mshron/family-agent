// Faux-provider contract test for the message-edit mechanism — shipping gate
// 1 of docs/memos/message-editing.md: the `edits` omit entry applied to a
// real completed turn. Run from the gateway dir (deps installed):
//
//   node scripts/edit-contract.mjs
//
// Scenario: two completed turns; then the gateway's edit commit (a
// `zulip.edit` entry whose `edits` omit the second turn's input and answer).
// Assert: the derived model context no longer contains the edited turn, and
// the re-submitted corrected input runs against history that ends at turn 1.
//
// The target collection mirrors gateway.js `collectTargets` on purpose —
// keep the two in sync.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  defineEntry,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import {
  fauxProvider,
  fauxAssistantMessage,
  createModels,
} from "@earendil-works/pi-ai";

const context = BACKGROUND_CONTEXT;
const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux" }] });
const models = createModels();
models.setProvider(faux.provider);

const registry = createRegistry();
defineEntry("zulip.edit"); // the kind the gateway appends

const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const conv = await harness.root(context, {
  agent: { model: { provider: "faux", modelId: "faux-1" } },
});

// Turn 1: stays.
faux.setResponses([fauxAssistantMessage("first answer")]);
const r1 = await (await conv.submit({ type: "input", content: "first question" }, context)).wait(context);
if (r1.status !== "done") throw new Error(`turn 1 settled ${r1.status}: ${r1.reason}`);

// Turn 2: submitted with a Zulip requestId, then edited away.
faux.appendResponses([fauxAssistantMessage("second answer")]);
const r2 = await (
  await conv.submit({ type: "input", content: "second question", requestId: "zulip:42" }, context)
).wait(context);
if (r2.status !== "done") throw new Error(`turn 2 settled ${r2.status}`);
const sub2 = await harness.commit((tx) => tx.submissionByRequest(conv.id, "zulip:42"), context);
const inputEntry = sub2.entry;
console.log("turn 2 input entry", inputEntry, "answer", r2.answer);

// collectTargets: active-range entry ids at or above the edited input.
const targets = await harness.commit(async (tx) => {
  const marker = await tx.latestHeadMarker(conv.id);
  const ids = new Set();
  if (marker && marker.id >= inputEntry) ids.add(marker.id);
  let cursor;
  for (;;) {
    const page = await tx.scanEntries({ conversationId: conv.id }, 100, cursor);
    for (const e of page.items) if (e.id >= inputEntry) ids.add(e.id);
    const oldest = page.items[page.items.length - 1]?.id;
    cursor = page.next;
    if (!cursor || (oldest !== undefined && oldest < inputEntry)) break;
  }
  return [...ids].sort((a, b) => a - b);
}, context);
console.log("targets:", targets);
if (!targets.includes(inputEntry) || !targets.includes(r2.answer)) {
  throw new Error("targets do not cover the edited turn");
}

// The edit commit, as the gateway does it.
await harness.commit(async (tx) => {
  await tx.appendEntry(conv.id, {
    kind: "zulip.edit",
    data: { messageId: 42, action: "edit", targets },
    edits: targets.map((t) => ({ target: t, action: "omit" })),
  });
}, context);

// The re-run must see: turn 1 verbatim, then the corrected input, and never
// the omitted turn. The faux response factory inspects the exact transcript
// the model would receive.
faux.appendResponses([
  (transcript) => {
    const userTexts = transcript.messages
      .filter((m) => m.role === "user")
      .map((m) => JSON.stringify(m.content));
    if (userTexts.some((t) => t.includes("second question"))) {
      throw new Error("run saw the omitted turn");
    }
    if (!userTexts.some((t) => t.includes("first question"))) {
      throw new Error("run lost turn 1");
    }
    if (!userTexts.some((t) => t.includes("corrected question"))) {
      throw new Error("run did not see the corrected input");
    }
    return fauxAssistantMessage("corrected answer");
  },
]);
const r3 = await (
  await conv.submit(
    { type: "input", content: "corrected question", requestId: "zulip:42:e1000" },
    context
  )
).wait(context);
if (r3.status !== "done") throw new Error(`turn 3 settled ${r3.status}: ${r3.reason}`);
console.log("re-run saw only corrected history");

// The omission must persist for a later run as well (deriveContext collects
// edits from every entry in the active range, not just the newest).
faux.appendResponses([
  (transcript) => {
    const userTexts = transcript.messages
      .filter((m) => m.role === "user")
      .map((m) => JSON.stringify(m.content));
    if (userTexts.some((t) => t.includes("second question"))) {
      throw new Error("omission did not persist across turns");
    }
    return fauxAssistantMessage("later answer");
  },
]);
const r4 = await (
  await conv.submit({ type: "input", content: "later question", requestId: "zulip:43" }, context)
).wait(context);
if (r4.status !== "done") throw new Error(`turn 4 settled ${r4.status}`);

await harness.close(context);
console.log("EDIT CONTRACT: PASS");
