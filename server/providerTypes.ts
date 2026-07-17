export type ProviderToolCall = {
  callKey: string;
  index: number;
  name: string;
  argumentsText: string;
};

export type ProviderMessage = {
  role: "system" | "user" | "assistant" | "tool";
  text?: string | null;
  toolCallKey?: string;
  toolCalls?: ProviderToolCall[];
  continuationThinking?: string;
};

export type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
};

export type ProviderFinishCause =
  | "complete"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "insufficient_system_resource"
  | "cancelled"
  | "unknown";

export type ProviderProtocolIssue = {
  code: "incomplete_stream" | "text_tool_protocol" | "finish_mismatch" | "unknown_finish" | "empty_response";
  message: string;
  retryable: boolean;
};

export type ProviderFragment =
  | { kind: "thinking"; text: string }
  | { kind: "answer"; text: string }
  | { kind: "tool_call"; callKey: string; index: number; name?: string; argumentsText?: string }
  | { kind: "usage"; usage: ProviderUsage };

export type ProviderResponse = {
  answer: string;
  thinking: string;
  toolCalls: ProviderToolCall[];
  usage?: ProviderUsage;
  finishCause: ProviderFinishCause;
  continuationMessage: ProviderMessage;
  protocolIssue?: ProviderProtocolIssue;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ProviderRequest = {
  model: string;
  messages: ProviderMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  onFragment?: (fragment: ProviderFragment) => void;
};

export type ProviderCapabilities = {
  contextWindowTokens: number;
  supportsThinking: boolean;
  supportsTools: boolean;
  supportsStrictTools: boolean;
  supportsParallelToolCalls: boolean;
};

export interface ProviderAdapter {
  readonly capabilities: ProviderCapabilities;
  stream(request: ProviderRequest): Promise<ProviderResponse>;
}
