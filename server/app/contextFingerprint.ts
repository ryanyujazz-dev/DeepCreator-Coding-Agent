import { ContextEntry } from "../../shared/contracts/context";
import { stableDigest } from "../../shared/domain/digest";

export function contextFingerprint(records: ContextEntry[]): string {
  return stableDigest(records.map((record) => `${record.recordId}:${record.sequence}`).join("|"));
}
