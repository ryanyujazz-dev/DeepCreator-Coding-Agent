import assert from "node:assert/strict";
import test from "node:test";
import { executeToolStep } from "../server/app/toolStepExecutor";
import { ToolCall } from "../shared/contracts/provider";

function call(index: number, name: string): ToolCall {
  return { argumentsText: "{}", callId: `call_${index}`, index, name };
}

test("runs consecutive parallel-safe tools together and keeps serial barriers", async () => {
  const events: string[] = [];
  const calls = [call(2, "read_file"), call(0, "read_file"), call(1, "write_file"), call(3, "read_file")];
  const results = await executeToolStep({
    calls,
    execute: async (item) => {
      events.push(`start:${item.callId}`);
      await Promise.resolve();
      events.push(`done:${item.callId}`);
      return { contextRecords: [], mutatedWorkspace: false, protocolError: false, target: item.callId };
    },
    parallel: (name) => name === "read_file"
  });

  assert.deepEqual(results.map((item) => item.call.index), [0, 1, 2, 3]);
  assert.ok(events.indexOf("done:call_0") < events.indexOf("start:call_1"));
  assert.ok(events.indexOf("done:call_1") < events.indexOf("start:call_3"));
});
