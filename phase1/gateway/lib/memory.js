// Memory loading: the gateway reads memory files fresh before every
// message, so edits propagate to running conversations on the next
// message (see the memo's Memory section).

import { readFile } from "node:fs/promises";
import path from "node:path";

async function readIfPresent(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Build the memory preamble for one message.
 * @param {string} workspaceDir host path of the workspace repo
 * @param {string} stream Zulip stream name
 * @returns {Promise<string|null>} preamble, or null when no memory files exist
 */
export async function buildMemoryPreamble(workspaceDir, stream) {
  const userMemory = await readIfPresent(
    path.join(workspaceDir, "memory", "user.md")
  );
  const channelMemory = await readIfPresent(
    path.join(workspaceDir, "memory", "channels", `${stream}.md`)
  );
  if (!userMemory && !channelMemory) return null;

  const parts = [
    "A system note follows. It is long-term memory for you, not a message from the user.",
    "",
  ];
  if (userMemory) {
    parts.push(`<memory-user>\n${userMemory.trim()}\n</memory-user>`);
  }
  if (channelMemory) {
    parts.push(`<memory-channel stream="${stream}">\n${channelMemory.trim()}\n</memory-channel>`);
  }
  parts.push("");
  parts.push("The user's message follows after this note.");
  return parts.join("\n");
}
