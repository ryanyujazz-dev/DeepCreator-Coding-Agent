import { RunRegistry as RuntimeRunRegistry } from "../../server/app/runRegistry";
import { SystemPort } from "../../server/app/systemPort";

let sequence = 0;

export const testSystem: SystemPort = {
  createId: (prefix) => `${prefix}_test_${sequence += 1}`,
  now: () => "2026-01-01T00:00:00.000Z",
  nowMs: () => 1_767_225_600_000
};

export class TestRunRegistry extends RuntimeRunRegistry {
  constructor() {
    super(testSystem);
  }
}
