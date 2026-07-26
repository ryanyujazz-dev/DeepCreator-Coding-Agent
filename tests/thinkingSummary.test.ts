import assert from "node:assert/strict";
import test from "node:test";
import { ModelRequest, ModelResponse, Provider } from "../shared/contracts/provider";
import {
  THINKING_SUMMARY_LIMITS,
  ThinkingSummaryLoop,
  parseThinkingTitle,
  shouldStartFirstSummary
} from "../server/app/thinkingSummary";

const capabilities = {
  contextWindowTokens: 128_000,
  supportsParallelToolCalls: true,
  supportsStrictTools: false,
  supportsThinking: true,
  supportsTools: true
};

function response(answer: string): ModelResponse {
  return {
    answer,
    continuationMessage: { role: "assistant", text: answer },
    finishCause: "complete",
    thinking: "",
    toolCalls: []
  };
}

class ControlledProvider implements Provider {
  readonly capabilities = capabilities;
  readonly requests: ModelRequest[] = [];
  private readonly pending: Array<(value: ModelResponse) => void> = [];

  stream(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return new Promise((resolve) => this.pending.push(resolve));
  }

  resolve(index: number, title: string): void {
    this.pending[index](response(JSON.stringify({ title })));
  }

  resolveRaw(index: number, answer: string): void {
    this.pending[index](response(answer));
  }
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("starts only the first Run summary early at a natural, hard, or timed boundary", () => {
  assert.equal(shouldStartFirstSummary(`${"a".repeat(299)}\n\n`, 0), true);
  assert.equal(shouldStartFirstSummary("a".repeat(THINKING_SUMMARY_LIMITS.firstHardChars), 0), true);
  assert.equal(shouldStartFirstSummary("a".repeat(THINKING_SUMMARY_LIMITS.firstTimedMinChars), THINKING_SUMMARY_LIMITS.firstMaxWaitMs), true);
  assert.equal(shouldStartFirstSummary("a".repeat(THINKING_SUMMARY_LIMITS.firstTimedMinChars - 1), THINKING_SUMMARY_LIMITS.firstMaxWaitMs), false);
  assert.equal(shouldStartFirstSummary("a".repeat(THINKING_SUMMARY_LIMITS.firstNaturalMinChars), 0), false);
});

test("parses one strict progressive title and rejects invalid or completed titles", () => {
  assert.equal(parseThinkingTitle('```json\n{"title":"核对页面跳转参数"}\n```'), "核对页面跳转参数");
  assert.equal(parseThinkingTitle('{"title":"已完成页面修复"}'), undefined);
  assert.equal(parseThinkingTitle('{"title":"完成项目审查与修复"}'), undefined);
  assert.equal(parseThinkingTitle('{"title":"检查接口","extra":true}'), undefined);
  assert.equal(parseThinkingTitle('{"title":"太短"}'), undefined);
  assert.equal(parseThinkingTitle('{"title":"Review route parameters"}'), "Review route parameters");
});

test("emits the first title early and does not summarize that step again when it seals", async () => {
  const provider = new ControlledProvider();
  const titles: string[] = [];
  const loop = new ThinkingSummaryLoop({ model: "deepseek-v4-flash", onTitle: (title) => titles.push(title), provider });

  loop.append("思".repeat(THINKING_SUMMARY_LIMITS.firstHardChars));
  assert.equal(provider.requests.length, 1);
  provider.resolve(0, "规划前后端排查范围");
  await nextTurn();
  loop.append("继续核对页面路由和接口定义。");
  loop.endModelStep();
  await loop.finish();

  assert.equal(provider.requests.length, 1);
  assert.deepEqual(titles, ["规划前后端排查范围"]);
  assert.equal(provider.requests[0].thinkingMode, "disabled");
  assert.deepEqual(provider.requests[0].tools, []);
});

test("summarizes every later thinking step exactly once at its sealed boundary", async () => {
  const provider = new ControlledProvider();
  const titles: string[] = [];
  const loop = new ThinkingSummaryLoop({ model: "glm-5-turbo", onTitle: (title) => titles.push(title), provider });

  loop.append("先检查首个页面的路由参数。");
  loop.endModelStep();
  provider.resolve(0, "核对页面跳转参数");
  await nextTurn();

  loop.append("分".repeat(2_000));
  assert.equal(provider.requests.length, 1, "later steps never summarize in the middle of thinking");
  loop.append("继续检查接口异常处理。");
  loop.endModelStep();
  assert.equal(provider.requests.length, 2);
  provider.resolve(1, "检查接口异常处理");
  await loop.finish();

  assert.deepEqual(titles, ["核对页面跳转参数", "检查接口异常处理"]);
});

test("retries the first early summary once at step end when its output is invalid", async () => {
  const provider = new ControlledProvider();
  const titles: string[] = [];
  const loop = new ThinkingSummaryLoop({ model: "deepseek-v4-flash", onTitle: (title) => titles.push(title), provider });

  loop.append("思".repeat(THINKING_SUMMARY_LIMITS.firstHardChars));
  loop.append("保留 step 后半段思考。");
  loop.endModelStep();
  provider.resolveRaw(0, "不是 JSON");
  await nextTurn();

  assert.equal(provider.requests.length, 2);
  const retryInput = JSON.parse(provider.requests[1].messages.at(-1)?.text ?? "{}") as { thinking: string };
  assert.match(retryInput.thinking, /保留 step 后半段思考/);
  provider.resolve(1, "核对页面跳转参数");
  await loop.finish();
  assert.deepEqual(titles, ["核对页面跳转参数"]);
});

test("keeps only the latest sealed step while one summary request is still running", async () => {
  const provider = new ControlledProvider();
  const titles: string[] = [];
  const loop = new ThinkingSummaryLoop({ model: "deepseek-v4-flash", onTitle: (title) => titles.push(title), provider });

  loop.append("第一步短思考。");
  loop.endModelStep();
  loop.append("第二步思考。");
  loop.endModelStep();
  loop.append("第三步最新思考。");
  loop.endModelStep();
  provider.resolve(0, "规划前后端排查范围");
  await nextTurn();

  assert.deepEqual(titles, ["规划前后端排查范围"]);
  assert.equal(provider.requests.length, 2);
  const latest = JSON.parse(provider.requests[1].messages.at(-1)?.text ?? "{}") as { thinking: string };
  assert.equal(latest.thinking, "第三步最新思考。");
  provider.resolve(1, "检查最新实现状态");
  await loop.finish();
  assert.deepEqual(titles, ["规划前后端排查范围", "检查最新实现状态"]);
});

test("seeds a resumed Run with the previous thinking-title exchange", async () => {
  const provider = new ControlledProvider();
  const loop = new ThinkingSummaryLoop({
    initialThinking: "先检查路由定义和页面接收参数。",
    initialTitle: "核对页面跳转参数",
    model: "glm-5-turbo",
    onTitle: () => undefined,
    provider
  });
  loop.append("继续确认 query 与目标页面字段一致。");
  loop.endModelStep();

  assert.deepEqual(provider.requests[0].messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
  provider.resolve(0, "核对页面跳转参数");
  await loop.finish();
});

test("bounds final draining and ignores a summary that returns after cancellation", async () => {
  const provider = new ControlledProvider();
  const titles: string[] = [];
  const loop = new ThinkingSummaryLoop({ model: "deepseek-v4-flash", onTitle: (title) => titles.push(title), provider });
  loop.append("正在分析路由参数如何传递到目标页面。");
  loop.endModelStep();

  const startedAt = Date.now();
  await loop.finish(25);
  assert.ok(Date.now() - startedAt < 500);
  provider.resolve(0, "核对页面跳转参数");
  await nextTurn();
  assert.deepEqual(titles, []);
});
