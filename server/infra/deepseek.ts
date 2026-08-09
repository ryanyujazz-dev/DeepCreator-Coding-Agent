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
import { decodeResponsesStream, toResponsesBody } from "./responsesStream";

const DEFAULT_API_URL = "https://api.deepseek.com/chat/completions";

// DeepSeek 账户余额查询结果复用 ProviderBalance 类型(shared/contracts/provider.ts)。
// getBalance 返回 ProviderBalance,与 Provider 接口定义一致。

function mapFinishCause(value?: string | null): FinishCause {
  if (value === "stop") return "complete";
  if (value === "tool_calls") return "tool_calls";
  if (value === "length") return "length";
  if (value === "content_filter") return "content_filter";
  if (value === "insufficient_system_resource") return "insufficient_system_resource";
  return "unknown";
}

function mapUsage(raw?: Record<string, number | undefined>): Usage | undefined {
  if (!raw) return undefined;
  return {
    cacheHitTokens: raw.prompt_cache_hit_tokens,
    cacheMissTokens: raw.prompt_cache_miss_tokens,
    inputTokens: raw.prompt_tokens,
    outputTokens: raw.completion_tokens
  };
}

export class DeepSeekProvider implements Provider {
  readonly capabilities = {
    contextWindowTokens: Number(process.env.DEEPSEEK_CONTEXT_WINDOW_TOKENS ?? 1_000_000),
    supportsParallelToolCalls: true,
    supportsStrictTools: false,
    supportsThinking: true,
    supportsTools: true
  };

  constructor(
    private readonly apiKey: string,
    private readonly apiUrl = process.env.DEEPSEEK_API_URL ?? DEFAULT_API_URL,
    private readonly balanceRequestTimeoutMs = 10_000
  ) {}

  // 查询账户余额(GET https://api.deepseek.com/user/balance)。
  // 从 this.apiUrl(默认 chat/completions 端点)取 origin 拼出 balance endpoint,
  // 这样用户自定义了 DEEPSEEK_API_URL 时余额接口也会跟着走同一个 host。
  async getBalance(): Promise<ProviderBalance> {
    if (!this.apiKey) throw new Error("缺少 DEEPSEEK_API_KEY,无法查询余额。");
    const balanceUrl = new URL("/user/balance", new URL(this.apiUrl).origin).toString();
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
        throw new Error(`DeepSeek 余额查询超时:超过 ${this.balanceRequestTimeoutMs}ms。`);
      }
      throw error;
    }
    if (!response.ok) throw new Error(`DeepSeek 余额查询失败:HTTP ${response.status}`);
    const data = await response.json() as {
      is_available: boolean;
      balance_infos: Array<{ currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }>;
    };
    return {
      isAvailable: data.is_available,
      balanceInfos: (data.balance_infos ?? []).map((item) => ({
        currency: item.currency,
        totalBalance: Number(item.total_balance),
        grantedBalance: Number(item.granted_balance),
        toppedUpBalance: Number(item.topped_up_balance)
      }))
    };
  }

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
      protocol: "chat",
      signal: request.signal,
      tools: []
    });
    const match = response.answer.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("DeepSeek 语义压缩未返回 JSON。");
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
    if (!this.apiKey) throw new Error("缺少 DEEPSEEK_API_KEY。请在 .env.local 中配置后重启 Runtime。");
    const responses = request.protocol === "responses";
    const targetUrl = responses
      ? process.env.DEEPSEEK_RESPONSES_API_URL ?? new URL("/responses", new URL(this.apiUrl).origin).toString()
      : this.apiUrl;
    const response = await fetch(targetUrl, {
      body: JSON.stringify(responses ? toResponsesBody(request) : {
        messages: request.messages.map(toCompatibleMessage),
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
        model: request.model,
        stream: true,
        stream_options: { include_usage: true },
        ...(request.thinkingMode ? { thinking: { type: request.thinkingMode } } : {}),
        ...(request.tools.length > 0
          ? {
              tools: toCompatibleTools(request.tools)
            }
          : {})
      }),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      method: "POST",
      signal: request.signal
    });
    if (!response.ok) {
      throw new Error(`DeepSeek API 请求失败：${response.status} ${await response.text()}`);
    }
    if (!response.body) throw new Error("DeepSeek 响应没有可读取的流。");

    if (responses) {
      return decodeResponsesStream({
        body: response.body,
        modelStepId: request.modelStepId ?? "model_step_unknown",
        onFragment: request.onFragment
      });
    }
    return decodeCompatibleStream({
      body: response.body,
      dialect: {
        finishCause: mapFinishCause,
        providerLabel: "DeepSeek",
        textToolPattern: /<[｜|]{0,2}DSML[｜|]{0,2}(?:tool_calls|invoke)|<\/?tool_calls\b/i,
        usage: mapUsage
      },
      onFragment: request.onFragment
    });
  }
}
