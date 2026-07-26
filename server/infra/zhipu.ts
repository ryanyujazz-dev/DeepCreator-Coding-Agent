import {
  Provider,
  ProviderBalance,
  Summary,
  SummaryRequest,
  FinishCause,
  ModelRequest,
  ModelResponse,
  Usage
} from "../../shared/contracts/provider";
import { decodeCompatibleStream, toCompatibleMessage, toCompatibleTools } from "./openAiCompatibleStream";

// ─────────────────────────────────────────────────────────────────────────────
// 智谱 GLM Provider
//
// 智谱 API (https://open.bigmodel.cn/api/paas/v4/chat/completions) 与 OpenAI 兼容:
//   - 认证: Bearer <api-key>,key 格式为 <id>.<secret>
//   - 流式: SSE, data: {...}\n\n, 终止标记 data: [DONE]
//   - 工具调用: tool_calls[].function.arguments 为 JSON 字符串(增量拼接)
//   - 深度思考: reasoning_content 字段(需在请求中带 thinking 参数)
//   - finish_reason: stop | tool_calls | length | sensitive | content_filter
//
// 与 DeepSeek 的差异:
//   - base URL 不同(open.bigmodel.cn vs api.deepseek.com)
//   - thinking 模式通过请求体 thinking 参数控制(DeepSeek 自动启用)
//   - finish_reason 多一个 "sensitive"(内容审核)
//   - 余额查询 API 不同(/paas/v4/billing 不稳定,暂用模型自检)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

function mapFinishCause(value?: string | null): FinishCause {
  if (value === "stop") return "complete";
  if (value === "tool_calls") return "tool_calls";
  if (value === "length") return "length";
  if (value === "content_filter" || value === "sensitive") return "content_filter";
  if (value === "insufficient_system_resource") return "insufficient_system_resource";
  return "unknown";
}

function mapUsage(raw?: Record<string, number | undefined>): Usage | undefined {
  if (!raw) return undefined;
  return {
    inputTokens: raw.prompt_tokens,
    outputTokens: raw.completion_tokens
  };
}

export class ZhipuProvider implements Provider {
  readonly capabilities = {
    // GLM-4.5 系列上下文窗口为 128K(模型固有能力,不是用户配置)。
    contextWindowTokens: 128_000,
    supportsParallelToolCalls: true,
    supportsStrictTools: false,
    supportsThinking: true,
    supportsTools: true
  };

  constructor(
    private readonly apiKey: string,
    private readonly apiUrl = process.env.ZHIPU_API_URL ?? DEFAULT_API_URL,
    private readonly balanceRequestTimeoutMs = 10_000
  ) {}

  async summarizeContext(request: SummaryRequest): Promise<Summary> {
    const response = await this.stream({
      maxOutputTokens: 2_048,
      messages: [
        {
          role: "system",
          text: "你是上下文压缩器。只从给定对话中提取语义信息，不推断文件变更、命令状态、测试结果、审批或工具事实。只输出 JSON 对象，字段为 objective、constraints、decisions、unresolvedQuestions。数组最多 20 项，每项简短。"
        },
        { role: "user", text: request.transcript }
      ],
      model: request.model,
      signal: request.signal,
      tools: []
    });
    const match = response.answer.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("智谱语义压缩未返回 JSON。");
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const list = (value: unknown) => Array.isArray(value)
      ? value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 20).map((item) => item.slice(0, 500))
      : [];
    return {
      constraints: list(raw.constraints),
      decisions: list(raw.decisions),
      objective: typeof raw.objective === "string" ? raw.objective.trim().slice(0, 1_200) : undefined,
      unresolvedQuestions: list(raw.unresolvedQuestions)
    };
  }

  async stream(request: ModelRequest): Promise<ModelResponse> {
    if (!this.apiKey) throw new Error("缺少智谱 API Key。请在配置中设置后重启 Runtime。");
    const body: Record<string, unknown> = {
      messages: request.messages.map(toCompatibleMessage),
      model: request.model,
      stream: true,
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {})
    };
    if (request.tools.length > 0) {
      body.tools = toCompatibleTools(request.tools);
    }
    // GLM 普通请求保持显式启用；轻量摘要请求可单独关闭思考。
    body.thinking = { type: request.thinkingMode ?? "enabled" };

    const response = await fetch(this.apiUrl, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      method: "POST",
      signal: request.signal
    });
    if (!response.ok) {
      throw new Error(`智谱 API 请求失败：${response.status} ${await response.text()}`);
    }
    if (!response.body) throw new Error("智谱响应没有可读取的流。");

    return decodeCompatibleStream({
      body: response.body,
      dialect: {
        finishCause: mapFinishCause,
        providerLabel: "智谱",
        textToolPattern: /<[｜|]{0,2}tool_calls\b/i,
        usage: mapUsage
      },
      onFragment: request.onFragment
    });
  }

  // 智谱余额查询:GET /paas/v4/billing
  // 该接口稳定性一般(不同套餐返回结构不同),失败静默,不影响主流程。
  async getBalance(): Promise<ProviderBalance> {
    if (!this.apiKey) throw new Error("缺少智谱 API Key，无法查询余额。");
    const balanceUrl = new URL("../billing", this.apiUrl).toString();
    const signal = AbortSignal.timeout(this.balanceRequestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(balanceUrl, {
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        method: "GET",
        signal
      });
    } catch (error) {
      if (signal.aborted) {
        throw new Error(`智谱余额查询超时:超过 ${this.balanceRequestTimeoutMs}ms。`);
      }
      throw error;
    }
    if (!response.ok) throw new Error(`智谱余额查询失败:HTTP ${response.status}`);
    const data = await response.json() as Record<string, unknown>;
    // 兼容两种返回结构:数组形式(balanceInfos)或对象形式(data)
    const infos = data.balanceInfos as Array<{ balance: string; subject: string }> | undefined;
    if (Array.isArray(infos) && infos.length > 0) {
      return {
        balanceInfos: infos.map((item) => ({
          currency: "CNY",
          grantedBalance: 0,
          toppedUpBalance: 0,
          totalBalance: Number(item.balance) || 0
        })),
        isAvailable: true
      };
    }
    const d = (data.data ?? data) as { totalBalance?: string; grantedBalance?: string; toppedUpBalance?: string };
    return {
      balanceInfos: [{
        currency: "CNY",
        grantedBalance: Number(d.grantedBalance) || 0,
        toppedUpBalance: Number(d.toppedUpBalance) || 0,
        totalBalance: Number(d.totalBalance) || 0
      }],
      isAvailable: true
    };
  }
}
