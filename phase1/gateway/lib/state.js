// Persistent conversation state: which session file each conversation
// uses. Kept on the sessions volume so gateway restarts resume correctly,
// including sessions that were rotated by /new.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export class ConversationIndex {
  constructor(stateDir) {
    this.file = path.join(stateDir, "gateway-index.json");
    this.data = { conversations: {} }; // key -> { sessionFile, sessionFileUpdatedAt }
  }

  async load() {
    try {
      const raw = await readFile(this.file, "utf8");
      this.data = JSON.parse(raw);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  get(key) {
    return this.data.conversations[key] || null;
  }

  async setSessionFile(key, sessionFile) {
    this.data.conversations[key] = {
      ...(this.data.conversations[key] || {}),
      sessionFile,
      sessionFileUpdatedAt: new Date().toISOString(),
    };
    await this._save();
  }

  async _save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.data, null, 2));
  }
}
