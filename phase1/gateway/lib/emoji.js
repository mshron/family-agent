// Jev-picked thinking reaction. Instead of always reacting :eyes while a run
// is live, the gateway asks Jev — TypeSafe's System One decision model,
// reached through OpenRouter's Decisions API — which single emoji best
// acknowledges the message. Jev returns a typed Choice with probabilities,
// so there is no text to parse; the reaction name branches on it directly.
//
// Fails closed to "eyes": any error, timeout, or a low-confidence top pick
// falls back, and the raw choice is still audited so the fallbacks can be
// tuned later.

const EYES = "eyes";

// Zulip default-emoji names (gemoji style), each with a one-line criterion
// for Jev. Deliberately small and boring: the reaction is an acknowledgement
// on the way to a reply, not a performance.
const CANDIDATES = {
  eyes: "Watching, reading, or on it — the neutral default.",
  thinking: "The message raises a puzzle or needs real consideration.",
  question: "The message is a direct question awaiting an answer.",
  check: "A confirmation, agreement, or completed instruction.",
  thumbs_up: "Approval or a simple yes-able request.",
  thumbs_down: "Clear disapproval of something stated.",
  fire: "Exciting, impressive, or excellent news.",
  sparkles: "Delightful, polished, or a nice touch.",
  bulb: "An idea, insight, or clever observation.",
  exclamation: "Urgent, surprising, or important.",
  warning: "Something risky, broken, or concerning.",
  clap: "Praise for work or effort the message shares.",
  tada: "Celebration — a milestone, release, or good news.",
  heart: "Gratitude, affection, or kindness.",
  cry: "Bad news deserving sympathy.",
  laughing: "A joke or something genuinely funny.",
  rocket: "Shipping, launching, or forward momentum.",
  coffee: "Casual low-stakes chat.",
};

/** The OpenRouter origin, derived from the shared LLM base URL. models.js
 *  treats LLM_BASE_URL as the /api/v1 root (or the proxy's /llm root);
 *  the Decisions API lives at /api/alpha/decisions on the same origin —
 *  its own /decisions route on the proxy, since the /llm route maps to
 *  /api/v1 upstream and cannot carry /api/alpha. */
export function decisionsUrl(baseUrl = process.env.LLM_BASE_URL) {
  let base = baseUrl || "https://openrouter.ai/api/v1";
  if (base.endsWith("/llm")) return `${base.slice(0, -"/llm".length)}/decisions`;
  if (base.endsWith("/api/v1")) base = base.slice(0, -"/api/v1".length);
  return `${base}/api/alpha/decisions`;
}

/** Branch on a Decisions API answer. Returns the emoji name to react with;
 *  "eyes" when the answer is unusable or the top pick is below threshold. */
export function decideEmoji(answers, minTop = 0.2) {
  const a = answers?.emoji;
  if (!a || a.type !== "choice" || typeof a.choice !== "string") return EYES;
  if (!Object.hasOwn(CANDIDATES, a.choice)) return EYES;
  const top = a.probabilities?.[a.choice] ?? 0;
  if (typeof top !== "number" || top < minTop) return EYES;
  return a.choice;
}

/** One Jev call: which emoji acknowledges this message? Returns
 *  { emoji, choice, confidence, probabilities, cost } — never throws. */
export async function pickThinkingEmoji({
  apiKey,
  content,
  surface = "chat message",
  timeoutMs = 4000,
  baseUrl,
}) {
  const state = {
    surface,
    message: String(content ?? "").slice(0, 800),
  };
  try {
    const res = await fetch(decisionsUrl(baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "typesafe/jev-1.13",
        state,
        questions: {
          emoji: {
            type: "choice",
            instructions:
              "Pick the single emoji reaction that best acknowledges this message while a reply is being prepared. " +
              "Prefer a neutral or fitting choice over a strong emotion unless the message clearly calls for one. " +
              "If nothing fits, choose eyes.",
            criteria: CANDIDATES,
          },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Decisions API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = await res.json();
    const a = body?.answers?.emoji;
    return {
      emoji: decideEmoji(body?.answers),
      choice: a?.choice ?? EYES,
      confidence: a?.confidence,
      probabilities: a?.probabilities,
      cost: body?.usage?.cost,
    };
  } catch (err) {
    return { emoji: EYES, choice: EYES, error: err.message };
  }
}