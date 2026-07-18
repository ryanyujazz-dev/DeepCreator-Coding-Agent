import { createHash } from "node:crypto";
import { ToolResult } from "../../shared/contracts/tool";

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
  if (toolName === "read_file") return 18_000;
  if (toolName === "run_command") return 14_000;
  if (toolName === "list_files" || toolName === "search_files") return 12_000;
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
  const facts = [
    result.command ? `命令：${result.command}` : undefined,
    result.exitCode !== undefined ? `退出码：${result.exitCode}` : undefined,
    result.timedOut ? "状态：执行超时" : undefined,
    wasTruncated ? `裁剪：原始 ${Buffer.byteLength(fullText)} 字节，保留 ${Buffer.byteLength(body)} 字节` : undefined
  ].filter(Boolean);
  return {
    digest: createHash("sha256").update(fullText).digest("hex"),
    fullText,
    modelText: [...facts, body].filter(Boolean).join("\n"),
    originalBytes: Buffer.byteLength(fullText),
    retainedBytes: Buffer.byteLength(body),
    wasTruncated
  };
}
