// System prompt sections: conventions (AGENTS.md) and memory files, read
// fresh from the channel workspace before every request, so edits reach
// every running conversation on its next message.

import { readdir, readFile, stat } from "node:fs/promises";
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

/** Minimal SKILL.md frontmatter reader: `---` blocks with name/description. */
function parseSkillMeta(text) {
  const meta = {};
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return meta;
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  return meta;
}

async function listSkills(hostDir, containerDir) {
  let entries;
  try {
    entries = await readdir(hostDir);
  } catch {
    return [];
  }
  const skills = [];
  for (const name of entries) {
    const text = await readIfPresent(path.join(hostDir, name, "SKILL.md"));
    if (!text) continue;
    const meta = parseSkillMeta(text);
    skills.push({
      name: meta.name || name,
      description: meta.description || "",
      at: path.join(containerDir, name, "SKILL.md"),
    });
  }
  return skills;
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

/** Available skills (global layer, then the channel layer on top). */
export function skillsSection(env) {
  return section("skills", async (input, context) => {
    const stream = await streamOfConversation(input, context);
    if (!stream) return undefined;
    const [global, channel] = await Promise.all([
      listSkills(path.join(env.SKILLS_DIR, "global"), "/skills"),
      listSkills(path.join(env.SKILLS_DIR, stream), "/channel-skills"),
    ]);
    if (global.length === 0 && channel.length === 0) return undefined;
    const lines = [
      "Skills available. Read a skill's SKILL.md when a task matches its description. Not a message from the user.",
      "Global:",
      ...(global.length
        ? global.map((s) => `- ${s.name} (${s.at}): ${s.description}`)
        : ["- (none)"]),
      `Channel (${stream}):`,
      ...(channel.length
        ? channel.map((s) => `- ${s.name} (${s.at}): ${s.description}`)
        : ["- (none)"]),
    ];
    return lines.join("\n");
  });
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
