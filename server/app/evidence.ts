import { ToolResult } from "../../shared/contracts/tool";
import { stableDigest, utf8ByteLength } from "../../shared/domain/digest";

export type ReducedEvidence = {
  modelText: string;
  fullText: string;
  wasTruncated: boolean;
  originalBytes: number;
  retainedBytes: number;
  digest: string;
};

function redact(text: string, sensitiveValues: string[]): string {
  let result = text.replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]");
  for (const value of sensitiveValues.filter((item) => item.length >= 12)) result = result.split(value).join("[REDACTED_SECRET]");
  return result;
}

function limitFor(toolName: string): number {
  if (toolName === "read_file" || toolName === "edit_file" || toolName === "multi_edit") return 18_000;
  if (toolName === "run_command" || toolName === "wait_command" || toolName === "stop_command") return 14_000;
  if (toolName === "grep") return 14_000;
  if (toolName === "list_files" || toolName === "search_files" || toolName === "glob") return 12_000;
  return 8_000;
}

function middleTruncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.68);
  const tail = limit - head;
  return `${text.slice(0, head)}\n\n[...中间内容已由 Runtime 裁剪...]\n\n${text.slice(-tail)}`;
}

export function reduceToolEvidence(toolName: string, result: ToolResult, sensitiveValues: string[] = []): ReducedEvidence {
  const fullText = redact(result.output || "（工具未返回文本）", sensitiveValues);
  const limit = limitFor(toolName);
  const body = middleTruncate(fullText, limit);
  const wasTruncated = body !== fullText;
  const originalBytes = utf8ByteLength(fullText);
  const retainedBytes = utf8ByteLength(body);
  const facts = [
    result.command ? `命令：${result.command}` : undefined,
    result.commandId ? `命令标识：${result.commandId}` : undefined,
    result.exitCode !== undefined ? `退出码：${result.exitCode}` : undefined,
    result.timedOut ? "状态：执行超时" : undefined,
    wasTruncated ? `裁剪：原始 ${originalBytes} 字节，保留 ${retainedBytes} 字节` : undefined
  ].filter(Boolean);
  return {
    digest: stableDigest(fullText),
    fullText,
    modelText: [...facts, body].filter(Boolean).join("\n"),
    originalBytes,
    retainedBytes,
    wasTruncated
  };
}
