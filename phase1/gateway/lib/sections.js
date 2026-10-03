// System prompt sections: conventions (AGENTS.md) and memory files, read
// fresh from the channel workspace before every request, so edits reach
// every running conversation on its next message.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { section } from "@earendil-works/pi-durable";
import { ZulipDoc } from "./docs.js";

async function readIfPresent(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export function workspaceDir(env, stream) {
  return path.join(env.WORKSPACES_DIR, stream);
}

export async function streamOfConversation(input, context) {
  const doc = await input.read.snapshot(ZulipDoc, input.conversationId, context);
  return doc?.stream ?? null;
}

/** AGENTS.md from the conversation's channel workspace. */
export function conventionsSection(env) {
  return section(
    "conventions",
    async (input, context) => {
      const stream = await streamOfConversation(input, context);
      if (!stream) return undefined;
      const text = await readIfPresent(
        path.join(workspaceDir(env, stream), "AGENTS.md")
      );
      return text ?? undefined;
    },
    { tag: false }
  );
}

/** User + channel memory, as today's gateway preamble did. */
export function memorySection(env) {
  return section("memory", async (input, context) => {
    const stream = await streamOfConversation(input, context);
    if (!stream) return undefined;
    const dir = workspaceDir(env, stream);
    const [userMemory, channelMemory] = await Promise.all([
      readIfPresent(path.join(dir, "memory", "user.md")),
      readIfPresent(path.join(dir, "memory", "channels", `${stream}.md`)),
    ]);
    if (!userMemory && !channelMemory) return undefined;
    const parts = [];
    if (userMemory) parts.push(`<user>\n${userMemory.trim()}\n</user>`);
    if (channelMemory) {
      parts.push(`<channel stream="${stream}">\n${channelMemory.trim()}\n</channel>`);
    }
    return [
      "Long-term memory loaded fresh for this message. Not a message from the user.",
      ...parts,
    ].join("\n");
  });
}
