import assert from "node:assert/strict";
import test from "node:test";
import { Provider } from "../shared/contracts/provider";
import { streamProviderWithRecovery } from "../server/app/providerRecovery";

function provider(stream: Provider["stream"]): Provider {
  return {
    capabilities: {
      contextWindowTokens: 128_000,
      supportsParallelToolCalls: true,
      supportsStrictTools: false,
      supportsThinking: true,
      supportsTools: true
    },
    stream
  };
}

test("retries transient failures before any stream fragment", async () => {
  let attempts = 0;
  const notices: number[] = [];
  const response = await streamProviderWithRecovery({
    onRetry: ({ attempt }) => notices.push(attempt),
    policy: { baseDelayMs: 1, maxAttempts: 3 },
    provider: provider(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("503 upstream unavailable");
      return {
        answer: "ok",
        continuationMessage: { role: "assistant", text: "ok" },
        finishCause: "complete",
        thinking: "",
        toolCalls: []
      };
    }),
    request: { messages: [], model: "test", tools: [] }
  });

  assert.equal(response.answer, "ok");
  assert.deepEqual(notices, [2, 3]);
});

test("does not retry after streamed output has started", async () => {
  let attempts = 0;
  await assert.rejects(() => streamProviderWithRecovery({
    policy: { baseDelayMs: 1, maxAttempts: 3 },
    provider: provider(async (request) => {
      attempts += 1;
      request.onFragment?.({ kind: "answer", text: "partial" });
      throw new Error("network disconnected");
    }),
    request: { messages: [], model: "test", onFragment: () => undefined, tools: [] }
  }), /network disconnected/);
  assert.equal(attempts, 1);
});

test("abort interrupts retry backoff", async () => {
  const controller = new AbortController();
  const pending = streamProviderWithRecovery({
    onRetry: () => controller.abort(),
    policy: { baseDelayMs: 1_000, maxAttempts: 3 },
    provider: provider(async () => {
      throw new Error("429 rate limited");
    }),
    request: { messages: [], model: "test", tools: [] },
    signal: controller.signal
  });
  await assert.rejects(() => pending, /运行已取消/);
});
