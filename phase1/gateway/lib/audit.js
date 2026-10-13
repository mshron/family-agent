// Append-only audit log (Phase 2). The gateway is the only writer; the
// directory is never mounted into exec containers, so sessions cannot read
// it and cannot edit what is already written (append-only file mode).
//
// One JSON object per line: { ts, kind, ...fields }. Kept deliberately
// tiny: this is the trusted record of what sessions did, not a replacement
// for the durable store or gateway logs.

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export class AuditLog {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "audit.jsonl");
  }

  /** Append one event. Never throws: a broken audit path must not kill runs. */
  record(kind, fields = {}) {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), kind, ...fields }) + "\n");
    } catch (err) {
      console.error(new Date().toISOString(), "audit write failed:", err.message);
    }
  }
}