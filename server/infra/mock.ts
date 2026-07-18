import { Provider, ModelRequest, ModelResponse } from "../../shared/contracts/provider";

const wait = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("运行已取消。", "AbortError"));
      },
      { once: true }
    );
  });

export class MockProvider implements Provider {
  readonly capabilities = {
    contextWindowTokens: 1_000_000,
    supportsParallelToolCalls: true,
    supportsStrictTools: false,
    supportsThinking: true,
    supportsTools: true
  };

  async stream(request: ModelRequest): Promise<ModelResponse> {
    const thinking = "先识别用户目标和现有上下文，再给出清晰、可验证的回答。";
    const answer = "Mock Runtime 已完成本次请求。事件流、持久化和多轮会话链路均使用与真实 Provider 相同的运行机制。";
    for (const text of [thinking.slice(0, 14), thinking.slice(14)]) {
      await wait(80, request.signal);
      request.onFragment?.({ kind: "thinking", text });
    }
    for (const text of [answer.slice(0, 24), answer.slice(24, 48), answer.slice(48)]) {
      await wait(80, request.signal);
      request.onFragment?.({ kind: "answer", text });
    }
    return {
      answer,
      continuationMessage: { role: "assistant", text: answer },
      finishCause: "complete",
      thinking,
      toolCalls: [],
      usage: { inputTokens: 320, outputTokens: 48 }
    };
  }
}
