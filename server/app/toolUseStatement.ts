import { ToolCall } from "../../shared/contracts/provider";
import { ToolUseStatement } from "../../shared/contracts/runtime";

export const TOOL_USE_STATEMENT_NAME = "tools_use_statement";

type StatementArguments = {
  mode?: unknown;
  title?: unknown;
};

export type ToolUseStatementGate = {
  active?: ToolUseStatement;
  armed?: ToolUseStatement;
};

export type ToolUseStatementResolution = ToolUseStatementGate & {
  kind: "declaration" | "tools" | "none" | "rejected";
  error?: string;
  statementByCallId: Map<string, ToolUseStatement>;
};

function parseArguments(text: string): StatementArguments | undefined {
  try {
    const parsed = text.trim() ? JSON.parse(text) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as StatementArguments
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTitle(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, 80)
    : "";
}

function reject(
  active: ToolUseStatement | undefined,
  error: string
): ToolUseStatementResolution {
  return {
    active,
    error,
    kind: "rejected",
    statementByCallId: new Map()
  };
}

export function resolveToolUseStatement(input: ToolUseStatementGate & {
  calls: ToolCall[];
  contentBoundary: boolean;
  modelStepId: string;
}): ToolUseStatementResolution {
  const active = input.contentBoundary ? undefined : input.active;
  if (input.calls.length === 0) {
    return {
      active,
      kind: "none",
      statementByCallId: new Map()
    };
  }

  const declarations = input.calls.filter((call) => call.name === TOOL_USE_STATEMENT_NAME);
  const actualCalls = input.calls.filter((call) => call.name !== TOOL_USE_STATEMENT_NAME);

  if (declarations.length > 0) {
    if (input.calls.length !== 1 || declarations.length !== 1) {
      return reject(
        active,
        "工具协议错误：tools_use_statement 必须是当前 assistant 轮次中的唯一工具调用，不能在同一轮包含普通工具。"
      );
    }
    if (input.armed) {
      return reject(
        active,
        "工具协议错误：上一次 tools_use_statement 尚未被消耗。现在应直接调用目标普通工具，不要再次声明。"
      );
    }

    const declaration = declarations[0];
    const args = parseArguments(declaration.argumentsText);
    if (!args) {
      return reject(active, "工具协议错误：tools_use_statement 参数必须是有效 JSON。");
    }
    const requestedMode = args.mode;
    const requestedTitle = normalizeTitle(args.title);
    if (requestedMode !== "new" && requestedMode !== "continue") {
      return reject(active, "工具协议错误：tools_use_statement 的 mode 必须是 \"new\" 或 \"continue\"。");
    }
    if (requestedMode === "new" && !requestedTitle) {
      return reject(active, "工具协议错误：mode=\"new\" 必须提供简短且非空的 title。");
    }
    if (requestedMode === "continue" && (!active || input.contentBoundary)) {
      return reject(active, "工具协议错误：mode=\"continue\" 要求存在有效的工作目的组，并且期间没有 assistant content 中断。请改用 mode=\"new\"。");
    }
    if (requestedMode === "continue" && requestedTitle) {
      return reject(active, "工具协议错误：mode=\"continue\" 时应省略 title。");
    }

    const repeatedPurpose = requestedMode === "new"
      && Boolean(active)
      && requestedTitle === active?.title;
    const statement: ToolUseStatement = requestedMode === "continue" || repeatedPurpose
      ? {
          groupId: active!.groupId,
          mode: "continue",
          normalized: repeatedPurpose || undefined,
          statementId: `statement:${declaration.callId}`,
          title: active!.title
        }
      : {
          groupId: `tool_group:${declaration.callId || input.modelStepId}`,
          mode: "new",
          statementId: `statement:${declaration.callId}`,
          title: requestedTitle
        };
    return {
      active: statement,
      armed: statement,
      kind: "declaration",
      statementByCallId: new Map()
    };
  }

  if (!input.armed || input.contentBoundary) {
    return reject(
      active,
      "工具协议错误：本批普通工具已被拒绝，因为前一轮缺少有效且独立的 tools_use_statement。请先把 tools_use_statement 作为唯一工具调用，等待其结果，再在下一轮 assistant 消息中调用普通工具。"
    );
  }

  return {
    active: input.armed,
    kind: "tools",
    statementByCallId: new Map(actualCalls.map((call) => [call.callId, input.armed!]))
  };
}
