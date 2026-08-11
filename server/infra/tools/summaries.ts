import { redactSensitiveText } from "./security";

export function summarizeToolArguments(name: string, args: Record<string, unknown>): string {
  if (name === "submit_plan") return "";
  const safe = { ...args };
  if (name === "write_file" && typeof safe.content === "string") {
    safe.content = `[文件内容已从事件日志省略，共 ${safe.content.length} 字符]`;
  }
  if (name === "edit_file") {
    if (typeof safe.oldText === "string") safe.oldText = `[原文本已省略，共 ${safe.oldText.length} 字符]`;
    if (typeof safe.newText === "string") safe.newText = `[新文本已省略，共 ${safe.newText.length} 字符]`;
  }
  if (name === "multi_edit" && Array.isArray(safe.edits)) {
    safe.edits = (safe.edits as Array<Record<string, unknown>>).map((edit) => ({
      ...edit,
      newText: typeof edit.newText === "string" ? `[新文本已省略，共 ${edit.newText.length} 字符]` : edit.newText,
      oldText: typeof edit.oldText === "string" ? `[原文本已省略，共 ${edit.oldText.length} 字符]` : edit.oldText
    }));
  }
  if (name === "apply_patch" && typeof safe.patch === "string") {
    safe.patch = `[补丁正文已从参数摘要省略，共 ${safe.patch.length} 字符]`;
  }
  return redactSensitiveText(JSON.stringify(safe));
}

export function summarizeToolResult(name: string, args: Record<string, unknown>, output: string): string {
  if (name === "read_file") return `已读取 ${String(args.path ?? "文件")}`;
  if (name === "list_files") {
    const count = output.split("\n").filter(Boolean).length;
    return `已列出 ${count} 个项目文件`;
  }
  if (name === "grep") {
    if (output.startsWith("未找到匹配内容。")) return `未找到匹配 ${String(args.pattern ?? "")}`;
    const count = output.split("\n").filter((line) => !line.startsWith("(") && line.trim()).length;
    return `搜索 ${String(args.pattern ?? "")}，命中 ${count} 行`;
  }
  if (name === "glob") {
    if (output === "未匹配到任何文件。") return `未匹配 ${String(args.pattern ?? "")}`;
    const count = output.split("\n").filter((line) => !line.startsWith("(") && line.trim()).length;
    return `匹配 ${String(args.pattern ?? "")}，找到 ${count} 个文件`;
  }
  if (name === "wait_command") return `已检查命令 ${String(args.commandId ?? "")}`;
  if (name === "stop_command") return `已停止命令 ${String(args.commandId ?? "")}`;
  if (name === "web_search") return `搜索 ${String(args.query ?? "")}`;
  if (name === "fetch_url") return `已抓取 ${String(args.url ?? "URL")}`;
  if (name === "edit_file") return `已编辑 ${String(args.path ?? "文件")}`;
  if (name === "multi_edit") {
    const count = Array.isArray(args.edits) ? args.edits.length : 0;
    return `已原子编辑 ${String(args.path ?? "文件")}(${count} 处替换)`;
  }
  if (name === "apply_patch") return output;
  return redactSensitiveText(output).slice(0, 2_000);
}
