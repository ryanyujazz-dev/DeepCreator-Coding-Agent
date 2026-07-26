import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { ZhipuProvider } from "../server/infra/zhipu";

test("keeps ordinary GLM thinking enabled and disables it only for summary requests", async () => {
  const requestBodies: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk.toString()));
    request.on("end", () => {
      requestBodies.push(body);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: requestBodies.length === 1 ? "普通回答" : '{"title":"核对页面跳转参数"}' }, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const provider = new ZhipuProvider("test-key", `http://127.0.0.1:${address.port}`);
    await provider.stream({
      messages: [{ role: "user", text: "检查项目" }],
      model: "glm-5.2",
      tools: []
    });
    await provider.stream({
      maxOutputTokens: 96,
      messages: [{ role: "user", text: '{"thinking":"检查路由参数"}' }],
      model: "glm-5-turbo",
      thinkingMode: "disabled",
      tools: []
    });

    const ordinary = JSON.parse(requestBodies[0]) as Record<string, unknown>;
    const summary = JSON.parse(requestBodies[1]) as Record<string, unknown>;
    assert.deepEqual(ordinary.thinking, { type: "enabled" });
    assert.equal(ordinary.model, "glm-5.2");
    assert.deepEqual(summary.thinking, { type: "disabled" });
    assert.equal(summary.model, "glm-5-turbo");
    assert.equal(summary.tools, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
