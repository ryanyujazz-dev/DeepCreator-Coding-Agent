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

export interface Provider {
  readonly capabilities: ModelCaps;
  summarizeContext?(request: SummaryRequest): Promise<Summary>;
  stream(request: ModelRequest): Promise<ModelResponse>;
}
