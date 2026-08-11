import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeRuntimeWorkerControl,
  runtimeWorkerControlFromLine
} from "../shared/runtimeWorkerProtocol";

test("round-trips Runtime Worker control messages without treating logs as control data", () => {
  const ready = { port: 43123, type: "ready" as const };
  assert.deepEqual(runtimeWorkerControlFromLine(encodeRuntimeWorkerControl(ready).trimEnd()), ready);
  assert.deepEqual(runtimeWorkerControlFromLine(encodeRuntimeWorkerControl({ type: "shutdown" }).trimEnd()), { type: "shutdown" });
  assert.equal(runtimeWorkerControlFromLine("ordinary Runtime output"), undefined);
  assert.equal(runtimeWorkerControlFromLine("__DEEPCREATOR_RUNTIME_CONTROL__not-json"), undefined);
});
