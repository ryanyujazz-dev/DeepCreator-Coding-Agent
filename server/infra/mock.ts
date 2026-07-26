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
    if (request.thinkingMode === "disabled") {
      await wait(20, request.signal);
      const answer = JSON.stringify({ title: "梳理当前思路" });
      request.onFragment?.({ kind: "answer", text: answer });
      return {
        answer,
        continuationMessage: { role: "assistant", text: answer },
        finishCause: "complete",
        thinking: "",
        toolCalls: [],
        usage: { inputTokens: 64, outputTokens: 12 }
      };
    }
    const transcript = request.messages.map((message) => message.text ?? "").join("\n");
    const approved = transcript.includes('"decision":"start_work"');
    const planning = !approved && (transcript.includes('<mode_context mode="plan"') || transcript.includes('"decision":"continue_planning"'));
    if (planning) {
      const call = {
        argumentsText: JSON.stringify({
          markdown: "## 目标\n\n在不修改工作区的前提下确认范围，并形成可验证的实施路径。\n\n## 实施步骤\n\n1. 读取与目标直接相关的代码和规范。\n2. 在工作模式中完成最小而完整的修改。\n3. 运行与改动风险相称的检查，并核对最终差异。\n\n## 验收标准\n\n- 目标行为可复现。\n- 构建与相关测试通过。\n- 不引入任务范围外的变更。",
          title: "Mock 实施方案"
        }),
        callId: `mock_submit_${Date.now()}`,
        index: 0,
        name: "submit_plan"
      };
      await wait(80, request.signal);
      request.onFragment?.({ argumentsText: call.argumentsText, callId: call.callId, index: call.index, kind: "tool_call", name: call.name });
      return {
        answer: "",
        continuationMessage: { role: "assistant", text: null, toolCalls: [call] },
        finishCause: "tool_calls",
        thinking: "",
        toolCalls: [call],
        usage: { inputTokens: 320, outputTokens: 96 }
      };
    }
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
