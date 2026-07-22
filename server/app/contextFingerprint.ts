import { createHash } from "node:crypto";
import { ContextEntry } from "../../shared/contracts/context";

export function contextFingerprint(records: ContextEntry[]): string {
  return createHash("sha256")
    .update(records.map((record) => `${record.recordId}:${record.sequence}`).join("|"))
    .digest("hex");
}
