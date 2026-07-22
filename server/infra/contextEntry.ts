import { randomUUID } from "node:crypto";
import { ContextEntry, ContextInput } from "../../shared/contracts/context";

export function createContextEntry(input: ContextInput, sequence: number): ContextEntry {
  return {
    ...input,
    createdAt: input.createdAt ?? new Date().toISOString(),
    recordId: input.recordId ?? `context_${randomUUID()}`,
    sequence
  };
}
