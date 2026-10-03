// Auto-topic naming for Zulip's general chat: a small LLM call names the
// thread, and the rename moves the whole unprocessed burst retroactively.

import { smallLlm } from "./models.js";

export const GENERAL_CHAT = "general chat";

const NAMING_SYSTEM = [
  "You name Zulip chat threads. Read the messages and reply with a topic name.",
  "Rules: 2 to 4 words. Title Case. Describe the subject, not the greeting.",
  "No quotes, no punctuation at the ends, no words like 'thread' or 'topic'.",
  "If the messages are casual chat, name the theme. Reply with the name only.",
].join(" ");

export function sanitizeTopicName(raw) {
  let name = raw
    .split("\n")[0]
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .replace(/[`*_]/g, "")
    .trim();
  if (name.length > 60) name = name.slice(0, 57).trimEnd() + "...";
  if (name.length === 0) name = "Chat";
  return name;
}

/**
 * Name a burst of general-chat messages.
 * @param {Array<{sender: string, content: string}>} messages
 * @returns {Promise<string>} a topic name
 */
export async function nameTopic({ apiKey, messages }) {
  const transcript = messages
    .slice(-8)
    .map((m) => `${m.sender}: ${m.content}`)
    .join("\n")
    .slice(0, 4000);
  const raw = await smallLlm({
    apiKey,
    system: NAMING_SYSTEM,
    user: `Messages:\n\n${transcript}`,
    maxTokens: 200,
  });
  return sanitizeTopicName(raw);
}
