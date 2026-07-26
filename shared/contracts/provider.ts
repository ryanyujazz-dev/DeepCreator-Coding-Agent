export type ToolCall = {
  callId: string;
  index: number;
  name: string;
  argumentsText: string;
};

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  text?: string | null;
  toolCallKey?: string;
  toolCalls?: ToolCall[];
  continuationThinking?: string;
};

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
};

export type FinishCause =
  | "complete"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "insufficient_system_resource"
  | "cancelled"
  | "unknown";

export type ModelIssue = {
  code: "incomplete_stream" | "text_tool_protocol" | "finish_mismatch" | "unknown_finish" | "empty_response";
  message: string;
  retryable: boolean;
};

export type ModelDelta =
  | { kind: "thinking"; text: string }
  | { kind: "answer"; text: string }
  | { kind: "tool_call"; callId: string; index: number; name?: string; argumentsText?: string }
  | { kind: "usage"; usage: Usage };

export type ModelResponse = {
  answer: string;
  thinking: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishCause: FinishCause;
  continuationMessage: ModelMessage;
  protocolIssue?: ModelIssue;
};

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ModelRequest = {
  model: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  maxOutputTokens?: number;
  thinkingMode?: "enabled" | "disabled";
  signal?: AbortSignal;
  onFragment?: (fragment: ModelDelta) => void;
};

export type SummaryRequest = {
  model: string;
  transcript: string;
  signal?: AbortSignal;
};

export type Summary = {
  objective?: string;
  constraints: string[];
  decisions: string[];
  unresolvedQuestions: string[];
};

export type ModelCaps = {
  contextWindowTokens: number;
  supportsThinking: boolean;
  supportsTools: boolean;
  supportsStrictTools: boolean;
  supportsParallelToolCalls: boolean;
};

// Provider 账户余额查询结果(可选实现)。
// DeepSeek 官方 GET /user/balance 返回结构归一化后的类型。
export type ProviderBalance = {
  isAvailable: boolean;
  balanceInfos: Array<{
    currency: string;
    totalBalance: number;
    grantedBalance: number;
    toppedUpBalance: number;
  }>;
};

/** 模型供应商标识。 */
export type ProviderFamily = "deepseek" | "zhipu" | "mock";

/** 可选模型的元数据,供前端渲染模型选择器和路由判断使用。 */
export type ModelOption = {
  /** 传给 API 的模型标识(如 "deepseek-v4-flash"、"glm-4.5")。 */
  id: string;
  /** 用户可读名称。 */
  label: string;
  /** 供应商。 */
  provider: ProviderFamily;
  /** 简短描述。 */
  description: string;
};

export interface Provider {
  readonly capabilities: ModelCaps;
  summarizeContext?(request: SummaryRequest): Promise<Summary>;
  stream(request: ModelRequest): Promise<ModelResponse>;
  // 可选:某些 provider(如 DeepSeek)支持账户余额查询,用于在 UI 显示剩余额度。
  getBalance?(): Promise<ProviderBalance>;
}
