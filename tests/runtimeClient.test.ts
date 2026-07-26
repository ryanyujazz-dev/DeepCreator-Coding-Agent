import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeClient, SSEDecoder, parseEventMessage } from "../src/runtimeApi";
import { ContractViolationError } from "../shared/schemas/api";

test("decodes fragmented SSE data without depending on chunk boundaries", () => {
  const decoder = new SSEDecoder();
  assert.deepEqual(decoder.push("data: {\"kind\":\"heart"), []);
  assert.deepEqual(decoder.push("beat\",\"offset\":2}\n\n"), ['{"kind":"heartbeat","offset":2}']);
  assert.deepEqual(decoder.push("data: first\r\ndata: second\r\n\r\n"), ["first\nsecond"]);
});

test("validates SSE envelopes and every transported Event", () => {
  assert.deepEqual(parseEventMessage(JSON.stringify({
    kind: "heartbeat",
    offset: 4,
    sessionId: "session_contract"
  })), []);
  assert.throws(
    () => parseEventMessage(JSON.stringify({
      events: [{ type: "run.finished" }],
      kind: "events",
      sessionId: "session_contract"
    })),
    /Invalid Event/
  );
  assert.throws(
    () => parseEventMessage(JSON.stringify({ kind: "unknown", sessionId: "session_contract" })),
    ContractViolationError
  );
});

test("rejects a successful HTTP response that violates its declared contract", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: "yes" }), {
    headers: { "Content-Type": "application/json" },
    status: 200
  })) as typeof fetch;
  try {
    await assert.rejects(new RuntimeClient().cancelRun("run_invalid"), ContractViolationError);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("uses the latest Runtime connection after a desktop restart", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ authorization: string | null; url: string }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({
      authorization: new Headers(init?.headers).get("Authorization"),
      url: String(input)
    });
    return new Response(JSON.stringify({ sessions: [] }), {
      headers: { "Content-Type": "application/json" },
      status: 200
    });
  }) as typeof fetch;

  try {
    const client = new RuntimeClient();
    client.configure({ baseUrl: "http://127.0.0.1:41001", token: "old-token" });
    await client.listSessions();
    client.configure({ baseUrl: "http://127.0.0.1:41002", token: "new-token" });
    await client.listSessions();

    assert.deepEqual(requests, [
      { authorization: "Bearer old-token", url: "http://127.0.0.1:41001/api/sessions" },
      { authorization: "Bearer new-token", url: "http://127.0.0.1:41002/api/sessions" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
