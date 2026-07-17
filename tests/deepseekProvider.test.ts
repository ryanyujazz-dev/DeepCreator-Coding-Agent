import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { DeepSeekProvider } from "../server/deepseekProvider";

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
        { choices: [], usage: { prompt_tokens: 90, completion_tokens: 20, prompt_cache_hit_tokens: 40 } }
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
      messages: [{ role: "user", text: "检查项目" }],
      model: "deepseek-chat",
      onFragment: (fragment) => fragments.push({ kind: fragment.kind, name: fragment.kind === "tool_call" ? fragment.name : undefined }),
      tools: []
    });
    assert.equal(result.thinking, "先检查");
    assert.equal(result.answer, "我会处理。");
    assert.deepEqual(result.toolCalls.map((call) => [call.callKey, call.name, call.argumentsText]), [
      ["call_a", "read_file", "{\"path\":\"src/App.tsx\"}"],
      ["call_b", "git_status", "{}"]
    ]);
    assert.equal(result.continuationMessage.continuationThinking, "先检查");
    assert.equal(result.usage?.cacheHitTokens, 40);
    assert.ok(fragments.some((fragment) => fragment.kind === "thinking"));
    assert.ok(fragments.some((fragment) => fragment.kind === "tool_call"));
    assert.equal(fragments.filter((fragment) => fragment.kind === "tool_call").at(-1)?.name, "read_file");
    assert.equal(JSON.parse(requestBody).messages[0].content, "检查项目");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
