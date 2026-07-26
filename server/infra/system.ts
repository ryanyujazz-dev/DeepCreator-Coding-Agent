import { randomUUID } from "node:crypto";
import { SystemPort } from "../app/systemPort";

export const nodeSystem: SystemPort = {
  createId: (prefix) => `${prefix}_${randomUUID()}`,
  now: () => new Date().toISOString(),
  nowMs: () => Date.now()
};
