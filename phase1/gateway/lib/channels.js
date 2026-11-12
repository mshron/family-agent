// Channel configuration: which tools each channel gets, which streams the
// gateway ingests. Loaded from channels.json (mounted into the container),
// so a config change needs only a gateway restart, not a rebuild.

import { readFile } from "node:fs/promises";
import { mergePermissionConfig } from "./permissions.js";

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
  "upload_file",
  "save_skill",
  "update_skill",
];

export class ChannelConfig {
  constructor(raw) {
    this.raw = raw ?? {};
    this.channels = this.raw.channels ?? {};
    // email -> { workStream }: the per-person work stream for task
    // conversations spawned from that person's DM. Empty by default; owners
    // get an auto-derived stream instead (see the gateway's resolver).
    this.people = this.raw.people ?? {};
  }

  /** All stream names the gateway should ingest. */
  get streams() {
    const list = this.raw.streams ?? [];
    return Array.isArray(list) && list.length > 0 ? list : ["scratch"];
  }

  /** True for every direct-message channel key ("dm" or "dm-<ids>"). */
  isDm(channel) {
    return channel === "dm" || String(channel).startsWith("dm-");
  }

  /** The config block that applies to a DM channel: its own, else "dm". */
  dmConf(channel) {
    return this.channels[channel] ?? this.channels["dm"];
  }

  /**
   * The tool name list for one channel key (a stream name, or a "dm-<ids>"
   * direct message group). `tools` replaces the standard set; `add` appends.
   * DM conversations get run_task on top of the standard set (spawn_thread
   * and fork_thread refuse there anyway).
   */
  toolsFor(channel) {
    const conf = this.isDm(channel) ? this.dmConf(channel) : this.channels[channel];
    if (Array.isArray(conf?.tools)) {
      return [...new Set([...conf.tools])];
    }
    const base = this.isDm(channel)
      ? [...STANDARD_TOOLS, "run_task"]
      : STANDARD_TOOLS;
    const added = Array.isArray(conf?.add) ? conf.add : [];
    return [...new Set([...base, ...added])];
  }

  /**
   * The permission rule config for one channel: the top-level
   * `permissions` block merged with the channel's own, per surface. DM
   * channels get the shared "dm" block underneath their own, so one block
   * configures every DM conversation and a specific one can still
   * override. Keys the running gateway does not know are ignored, so an
   * older deploy can run a newer channels.json (and vice versa).
   */
  permissionConfigFor(channel) {
    if (!this.isDm(channel)) {
      return mergePermissionConfig(this.raw.permissions, this.channels[channel]?.permissions);
    }
    const withDm = mergePermissionConfig(this.raw.permissions, this.channels["dm"]?.permissions);
    return mergePermissionConfig(withDm, this.channels[channel]?.permissions);
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
