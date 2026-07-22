import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { DeepSeekProvider } from "../server/infra/deepseek";

test("normalizes thinking, answer, usage, and interleaved tool-call chunks", async () => {
  let requestBody = "";
  const server = createServer((request, response) => {
    request.on("data", (chunk) => (requestBody += chunk.toString()));
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunks = [
        { choices: [{ delta: { reasoning_content: "先检查" }, finish_reason: null }] },
        { choices: [{ delta: { content: "我会处理。" }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read_file", arguments: "{\"path\":" } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "git_status", arguments: "{}" } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"src/App.tsx\"}" } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 90, completion_tokens: 20, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 50 } }
      ];
      for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const fragments: Array<{ kind: string; name?: string }> = [];
    const provider = new DeepSeekProvider("test-key", `http://127.0.0.1:${address.port}`);
    const result = await provider.stream({
      messages: [
        { role: "user", text: "检查项目" },
        {
          continuationThinking: "保留工具推理",
          role: "assistant",
          text: "先读取文件",
          toolCalls: [{ argumentsText: "{\"path\":\"src/App.tsx\"}", callId: "previous_call", index: 0, name: "read_file" }]
        },
        { role: "tool", text: "文件内容", toolCallKey: "previous_call" }
      ],
      model: "deepseek-chat",
      onFragment: (fragment) => fragments.push({ kind: fragment.kind, name: fragment.kind === "tool_call" ? fragment.name : undefined }),
      tools: []
    });
    assert.equal(result.thinking, "先检查");
    assert.equal(result.answer, "我会处理。");
    assert.deepEqual(result.toolCalls.map((call) => [call.callId, call.name, call.argumentsText]), [
      ["call_a", "read_file", "{\"path\":\"src/App.tsx\"}"],
      ["call_b", "git_status", "{}"]
    ]);
    assert.equal(result.continuationMessage.continuationThinking, "先检查");
    assert.equal(result.usage?.cacheHitTokens, 40);
    assert.equal(result.usage?.cacheMissTokens, 50);
    assert.ok(fragments.some((fragment) => fragment.kind === "thinking"));
    assert.ok(fragments.some((fragment) => fragment.kind === "tool_call"));
    assert.equal(fragments.filter((fragment) => fragment.kind === "tool_call").at(-1)?.name, "read_file");
    assert.equal(JSON.parse(requestBody).messages[0].content, "检查项目");
    assert.equal(JSON.parse(requestBody).messages[1].reasoning_content, "保留工具推理");
    assert.equal(JSON.parse(requestBody).messages[2].tool_call_id, "previous_call");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("constrains provider compaction summaries to semantic fields", async () => {
  let requestBody = "";
  const server = createServer((request, response) => {
    request.on("data", (chunk) => (requestBody += chunk.toString()));
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "extract" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"objective":"修复登录","constraints":["保持 API"],"decisions":["使用锁"],"unresolvedQuestions":["锁粒度？"],"changedFiles":["fake.ts"]}' }, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const provider = new DeepSeekProvider("test-key", `http://127.0.0.1:${address.port}`);
    const summary = await provider.summarizeContext({ model: "deepseek-chat", transcript: "USER: 修复登录" });
    assert.deepEqual(summary, {
      constraints: ["保持 API"],
      decisions: ["使用锁"],
      objective: "修复登录",
      unresolvedQuestions: ["锁粒度？"]
    });
    const parsedRequest = JSON.parse(requestBody) as { max_tokens: number; messages: Array<{ role: string }>; tools?: unknown };
    assert.equal(parsedRequest.max_tokens, 2_048);
    assert.deepEqual(parsedRequest.messages.map((message) => message.role), ["system", "user"]);
    assert.equal(parsedRequest.tools, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("queries the balance endpoint with authorization and normalizes amounts", async () => {
  let requestAuthorization: string | undefined;
  let requestUrl: string | undefined;
  const server = createServer((request, response) => {
    requestAuthorization = request.headers.authorization;
    requestUrl = request.url;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      balance_infos: [{
        currency: "CNY",
        granted_balance: "1.25",
        topped_up_balance: "8.75",
        total_balance: "10.00"
      }],
      is_available: true
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const provider = new DeepSeekProvider("test-key", `http://127.0.0.1:${address.port}/chat/completions`);
    const result = await provider.getBalance();
    assert.equal(requestUrl, "/user/balance");
    assert.equal(requestAuthorization, "Bearer test-key");
    assert.deepEqual(result, {
      balanceInfos: [{
        currency: "CNY",
        grantedBalance: 1.25,
        toppedUpBalance: 8.75,
        totalBalance: 10
      }],
      isAvailable: true
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("aborts a balance request when the provider does not respond", async () => {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const provider = new DeepSeekProvider("test-key", `http://127.0.0.1:${address.port}/chat/completions`, 20);
    await assert.rejects(provider.getBalance(), /DeepSeek 余额查询超时:超过 20ms/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
