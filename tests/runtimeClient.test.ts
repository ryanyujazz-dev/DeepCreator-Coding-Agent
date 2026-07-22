import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeClient, SSEDecoder } from "../src/runtimeApi";

test("decodes fragmented SSE data without depending on chunk boundaries", () => {
  const decoder = new SSEDecoder();
  assert.deepEqual(decoder.push("data: {\"kind\":\"heart"), []);
  assert.deepEqual(decoder.push("beat\",\"offset\":2}\n\n"), ['{"kind":"heartbeat","offset":2}']);
  assert.deepEqual(decoder.push("data: first\r\ndata: second\r\n\r\n"), ["first\nsecond"]);
});

test("sends a bodyless cancellation request without declaring JSON content", async () => {
  const originalFetch = globalThis.fetch;
  let request: { input: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input, init) => {
    request = { input: String(input), init };
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
      status: 200
    });
  }) as typeof fetch;

  try {
    const client = new RuntimeClient();
    client.configure({ baseUrl: "http://runtime.test", token: "test-token" });
    await client.cancelRun("run_cancel");
    assert.equal(request?.input, "http://runtime.test/api/runs/run_cancel/cancel");
    assert.equal(request?.init?.method, "POST");
    assert.equal(request?.init?.body, undefined);
    const headers = new Headers(request?.init?.headers);
    assert.equal(headers.has("Content-Type"), false);
    assert.equal(headers.get("Authorization"), "Bearer test-token");

    await client.stopCommand("command_1");
    assert.equal(request?.input, "http://runtime.test/api/commands/command_1/stop");
    assert.equal(request?.init?.body, undefined);
    assert.equal(new Headers(request?.init?.headers).has("Content-Type"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
