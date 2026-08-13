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
    assert.equal(JSON.parse(requestBody).thinking, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("sends an explicit disabled thinking mode for summary requests", async () => {
  let requestBody = "";
  const server = createServer((request, response) => {
    request.on("data", (chunk) => (requestBody += chunk.toString()));
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"title":"核对页面跳转参数"}' }, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const provider = new DeepSeekProvider("test-key", `http://127.0.0.1:${address.port}`);
    await provider.stream({
      maxOutputTokens: 96,
      messages: [{ role: "user", text: '{"thinking":"检查路由参数"}' }],
      model: "deepseek-v4-flash",
      thinkingMode: "disabled",
      tools: []
    });
    const parsed = JSON.parse(requestBody) as Record<string, unknown>;
    assert.deepEqual(parsed.thinking, { type: "disabled" });
    assert.equal(parsed.model, "deepseek-v4-flash");
    assert.equal(parsed.tools, undefined);
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

test("decodes Responses semantic events without a DONE sentinel and preserves native search citations", async () => {
  let requestBody = "";
  let requestPath = "";
  const server = createServer((request, response) => {
    requestPath = request.url ?? "";
    request.on("data", (chunk) => (requestBody += chunk.toString()));
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const events = [
        { type: "response.created", sequence_number: 0 },
        { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { id: "rs_1", type: "reasoning", status: "in_progress" } },
        { type: "response.reasoning_text.delta", sequence_number: 2, output_index: 0, item_id: "rs_1", delta: "先搜索" },
        { type: "response.output_item.done", sequence_number: 3, output_index: 0, item: { id: "rs_1", type: "reasoning", status: "completed" } },
        { type: "response.output_item.added", sequence_number: 4, output_index: 1, item: { id: "ws_1", type: "web_search_call", status: "in_progress", action: { type: "search", query: "Responses API" } } },
        { type: "response.web_search_call.searching", sequence_number: 5, output_index: 1, item_id: "ws_1" },
        { type: "response.web_search_call.completed", sequence_number: 6, output_index: 1, item_id: "ws_1" },
        { type: "response.output_item.done", sequence_number: 7, output_index: 1, item: { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "Responses API" } } },
        { type: "response.output_item.added", sequence_number: 8, output_index: 2, item: { id: "msg_1", type: "message", status: "in_progress", content: [] } },
        { type: "response.output_text.delta", sequence_number: 9, output_index: 2, item_id: "msg_1", delta: "来源" },
        { type: "response.output_text.annotation.added", sequence_number: 10, output_index: 2, item_id: "msg_1", annotation: { type: "url_citation", start_index: 0, end_index: 2, title: "官方文档", url: "https://example.com/docs" } },
        { type: "response.output_item.done", sequence_number: 11, output_index: 2, item: { id: "msg_1", type: "message", status: "completed", content: [{ type: "output_text", text: "来源", annotations: [{ type: "url_citation", start_index: 0, end_index: 2, title: "官方文档", url: "https://example.com/docs" }] }] } },
        { type: "response.output_item.added", sequence_number: 12, output_index: 3, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "read_file", status: "in_progress", arguments: "" } },
        { type: "response.function_call_arguments.delta", sequence_number: 13, output_index: 3, item_id: "fc_1", delta: "{\"path\":\"src/App.tsx\"}" },
        { type: "response.output_item.done", sequence_number: 14, output_index: 3, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "read_file", status: "completed", arguments: "{\"path\":\"src/App.tsx\"}" } },
        { type: "response.completed", sequence_number: 15, response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } } } }
      ];
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const fragments: string[] = [];
    const provider = new DeepSeekProvider("test-key", `http://127.0.0.1:${address.port}/chat/completions`);
    const result = await provider.stream({
      messages: [{ role: "user", text: "查资料后读文件" }],
      model: "deepseek-v4-flash",
      modelStepId: "step_responses",
      onFragment: (fragment) => fragments.push(fragment.kind),
      protocol: "responses",
      tools: [
        { name: "web_search", description: "search", inputSchema: { type: "object" } },
        { name: "read_file", description: "read", inputSchema: { type: "object" } }
      ]
    });
    assert.equal(requestPath, "/responses");
    const body = JSON.parse(requestBody) as { input: unknown[]; tools: Array<Record<string, unknown>> };
    assert.ok(body.tools.some((tool) => tool.type === "web_search"));
    assert.equal(body.tools.some((tool) => recordFunctionName(tool) === "web_search"), false);
    assert.equal(result.thinking, "先搜索");
    assert.equal(result.answer, "来源");
    assert.deepEqual(result.toolCalls, [{ argumentsText: "{\"path\":\"src/App.tsx\"}", callId: "call_1", index: 3, name: "read_file" }]);
    assert.equal(result.usage?.cacheHitTokens, 40);
    assert.equal(result.continuationMessage.outputItems?.find((item) => item.itemId === "msg_1")?.citations?.[0].title, "官方文档");
    assert.ok(fragments.includes("output_item"));
    assert.ok(fragments.includes("thinking"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

function recordFunctionName(tool: Record<string, unknown>): string | undefined {
  return tool.type === "function" && typeof tool.name === "string" ? tool.name : undefined;
}

test("round-trips a prior web_search_call with action.queries so /responses does not 400", async () => {
  let requestBody = "";
  const server = createServer((request, response) => {
    request.on("data", (chunk) => (requestBody += chunk.toString()));
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      // 第二轮:历史里已有一个上轮产生的 web_search_call,DeepSeek 响应流只回传了
      // action.query(单字符串),但请求侧校验要求 action.queries(数组)。
      const events = [
        { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { id: "msg_2", type: "message", status: "in_progress", content: [] } },
        { type: "response.output_text.delta", sequence_number: 2, output_index: 0, item_id: "msg_2", delta: "继续" },
        { type: "response.output_item.done", sequence_number: 3, output_index: 0, item: { id: "msg_2", type: "message", status: "completed", content: [{ type: "output_text", text: "继续" }] } },
        { type: "response.completed", sequence_number: 4, response: { usage: { input_tokens: 10, output_tokens: 5 } } }
      ];
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const provider = new DeepSeekProvider("test-key", `http://127.0.0.1:${address.port}/chat/completions`);
    await provider.stream({
      messages: [
        { role: "user", text: "查资料" },
        {
          role: "assistant",
          outputItems: [{
            itemId: "ws_prior",
            modelStepId: "step_prior",
            outputIndex: 0,
            sequence: 1,
            status: "completed",
            type: "hosted_tool",
            toolName: "web_search",
            searchQuery: "Responses API",
            searchStatus: "completed"
          }],
          text: null
        },
        { role: "user", text: "接着说" }
      ],
      model: "deepseek-v4-pro",
      modelStepId: "step_roundtrip",
      protocol: "responses",
      tools: [{ name: "web_search", description: "search", inputSchema: { type: "object" } }]
    });
    const body = JSON.parse(requestBody) as { input: Array<Record<string, unknown>> };
    const replayed = body.input.find((item) => item.type === "web_search_call") as
      | { action?: { queries?: unknown[]; query?: string } } | undefined;
    assert.ok(replayed, "历史 web_search_call 应被回放进 input");
    assert.ok(Array.isArray(replayed?.action?.queries) && (replayed?.action?.queries?.length ?? 0) > 0,
      "回放的 web_search_call.action 必须带非空 queries 数组,否则 /responses 会 400 missing field queries");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("streams custom apply_patch input as an unapplied tool call", async () => {
  let requestBody = "";
  const patch = "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch";
  const server = createServer((request, response) => {
    request.on("data", (chunk) => (requestBody += chunk.toString()));
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const events = [
        { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { id: "ct_1", type: "custom_tool_call", call_id: "patch_1", name: "apply_patch", status: "in_progress", input: "" } },
        { type: "response.custom_tool_call_input.delta", sequence_number: 2, output_index: 0, item_id: "ct_1", delta: patch },
        { type: "response.output_item.done", sequence_number: 3, output_index: 0, item: { id: "ct_1", type: "custom_tool_call", call_id: "patch_1", name: "apply_patch", status: "completed", input: patch } },
        { type: "response.completed", sequence_number: 4, response: { usage: { input_tokens: 10, output_tokens: 10 } } }
      ];
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const provider = new DeepSeekProvider("test-key", `http://127.0.0.1:${address.port}/chat/completions`);
    const result = await provider.stream({
      messages: [{ role: "user", text: "创建文件" }],
      model: "deepseek-v4-flash",
      modelStepId: "step_patch",
      protocol: "responses",
      tools: [{ name: "apply_patch", description: "patch", inputSchema: { type: "object" } }]
    });
    const body = JSON.parse(requestBody) as { tools: Array<Record<string, unknown>> };
    assert.deepEqual(body.tools[0], { type: "custom", name: "apply_patch", description: "patch" });
    assert.equal(result.toolCalls[0].name, "apply_patch");
    assert.equal(JSON.parse(result.toolCalls[0].argumentsText).patch, patch);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("fails unsealed Responses calls without emitting a Runtime tool call", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = [
      { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { id: "fc_open", type: "function_call", call_id: "call_open", name: "read_file", status: "in_progress", arguments: "" } },
      { type: "response.function_call_arguments.delta", sequence_number: 2, output_index: 0, item_id: "fc_open", delta: "{\"path\":" },
      { type: "response.failed", sequence_number: 3, response: { error: { message: "provider stopped" } } }
    ];
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const fragments: Array<{ kind: string; status?: string }> = [];
  try {
    const provider = new DeepSeekProvider("test-key", `http://127.0.0.1:${address.port}/chat/completions`);
    await assert.rejects(provider.stream({
      messages: [{ role: "user", text: "读取文件" }],
      model: "deepseek-v4-flash",
      modelStepId: "step_failed",
      onFragment: (fragment) => fragments.push({ kind: fragment.kind, status: fragment.kind === "output_item" ? fragment.item.status : undefined }),
      protocol: "responses",
      tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }]
    }), /provider stopped/);
    assert.equal(fragments.some((fragment) => fragment.kind === "tool_call"), false);
    assert.equal(fragments.filter((fragment) => fragment.kind === "output_item").at(-1)?.status, "failed");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
