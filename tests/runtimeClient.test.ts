import assert from "node:assert/strict";
import test from "node:test";
import { SSEDecoder } from "../src/runtimeApi";

test("decodes fragmented SSE data without depending on chunk boundaries", () => {
  const decoder = new SSEDecoder();
  assert.deepEqual(decoder.push("data: {\"kind\":\"heart"), []);
  assert.deepEqual(decoder.push("beat\",\"offset\":2}\n\n"), ['{"kind":"heartbeat","offset":2}']);
  assert.deepEqual(decoder.push("data: first\r\ndata: second\r\n\r\n"), ["first\nsecond"]);
});
