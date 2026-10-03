// Channel configuration: which tools each channel gets, which streams the
// gateway ingests. Loaded from channels.json (mounted into the container),
// so a config change needs only a gateway restart, not a rebuild.

import { readFile } from "node:fs/promises";

/** Tool names every channel gets unless the config says otherwise. */
export const STANDARD_TOOLS = [
  // coding-tools extension
  "read",
  "write",
  "edit",
  "bash",
  // zulip extension
  "search",
  "summarize_url",
  "history_search",
  "spawn_thread",
  "fork_thread",
];

export class ChannelConfig {
  constructor(raw) {
    this.raw = raw ?? {};
    this.channels = this.raw.channels ?? {};
  }

  /** All stream names the gateway should ingest. */
  get streams() {
    const list = this.raw.streams ?? [];
    return Array.isArray(list) && list.length > 0 ? list : ["scratch"];
  }

  /**
   * The tool name list for one channel key (a stream name, or "dm" for
   * direct messages). `tools` replaces the standard set; `add` appends.
   */
  toolsFor(channel) {
    const conf = this.channels[channel] ?? {};
    if (Array.isArray(conf.tools)) {
      return [...new Set([...conf.tools])];
    }
    const added = Array.isArray(conf.add) ? conf.add : [];
    return [...new Set([...STANDARD_TOOLS, ...added])];
  }
}

export async function loadChannelConfig(path) {
  try {
    const text = await readFile(path, "utf8");
    return new ChannelConfig(JSON.parse(text));
  } catch (err) {
    if (err.code === "ENOENT") return new ChannelConfig(null);
    throw err;
  }
}
