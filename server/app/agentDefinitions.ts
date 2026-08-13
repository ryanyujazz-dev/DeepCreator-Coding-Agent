import { AgentId, AccessMode } from "../../shared/contracts/runtime";
import { ToolHost } from "./toolHost";

export type AgentDefinition = {
  agentId: AgentId;
  displayName: string;
  description: string;
  model: "inherit";
  maxAccessMode: AccessMode;
  systemPrompt: string;
  tools: ReadonlySet<string>;
};

const EXPLORER_TOOLS = new Set([
  "search_capabilities",
  "invoke_capability",
  "read_skill_resource",
  "search_memory",
  "list_files",
  "read_file",
  "grep",
  "glob",
  "git_status",
  "git_diff",
  "web_search",
  "fetch_url",
  "ask_user",
  "update_tasks"
]);

const WORKER_TOOLS = new Set([
  ...EXPLORER_TOOLS,
  "write_file",
  "edit_file",
  "multi_edit",
  "delete_file",
  "materialize_skill_asset",
  "preview_skill_install",
  "install_skill",
  "run_skill_script",
  "run_command",
  "git_commit",
  "stop_command"
]);

const DEFINITIONS: Record<AgentId, AgentDefinition> = {
  explorer: {
    agentId: "explorer",
    description: "在独立上下文中调查代码、文档和外部资料，不修改工作区。",
    displayName: "Explorer",
    maxAccessMode: "smart_approval",
    model: "inherit",
    systemPrompt: `你是 Explorer 子代理。你只负责调查、定位、读取、比较和形成有证据的结论。
你拥有独立上下文，看不到父代理对话；用户消息已经包含完成任务所需的信息。
不得修改工作区、运行命令或委派其他代理。结论必须直接回答委派任务，保留关键文件路径和验证依据。
Capability 只能用于加载 Skill 指令，不得调用 MCP 或其他外部能力来绕过工具白名单。`,
    tools: EXPLORER_TOOLS
  },
  worker: {
    agentId: "worker",
    description: "在独立上下文中完成明确的代码修改、命令执行和验证。",
    displayName: "Worker",
    maxAccessMode: "full_access",
    model: "inherit",
    systemPrompt: `你是 Worker 子代理。你在独立上下文中完成父代理委派的具体工程任务。
你看不到父代理对话；只把当前用户消息作为任务要求。可以检查、修改和验证工作区，但不能委派其他代理，也不能进入独立 Plan Mode。
修改必须保持范围聚焦，遵循项目规则，执行与风险相称的验证，并在最终内容中准确说明结果和未完成事项。
Capability 只能用于加载 Skill 指令，不得调用 MCP 或其他外部能力来绕过工具白名单。`,
    tools: WORKER_TOOLS
  }
};

const ACCESS_ORDER: AccessMode[] = ["request_approval", "smart_approval", "full_access"];

export function stricterAccess(left: AccessMode, right: AccessMode): AccessMode {
  return ACCESS_ORDER[Math.min(ACCESS_ORDER.indexOf(left), ACCESS_ORDER.indexOf(right))];
}

export function accessExceeds(requested: AccessMode, maximum: AccessMode): boolean {
  return ACCESS_ORDER.indexOf(requested) > ACCESS_ORDER.indexOf(maximum);
}

export function agentDefinition(agentId: AgentId): AgentDefinition {
  return DEFINITIONS[agentId];
}

export function createAgentToolHost(delegate: ToolHost, definition: AgentDefinition): ToolHost {
  const allowed = definition.tools;
  return {
    capture: delegate.capture.bind(delegate),
    changes: delegate.changes.bind(delegate),
    checkpoint: delegate.checkpoint.bind(delegate),
    close: delegate.close.bind(delegate),
    execute: (input) => {
      if (!allowed.has(input.name)) throw new Error(`子代理 ${definition.agentId} 无权调用工具 ${input.name}。`);
      if (input.name === "invoke_capability" && !String(input.args.capabilityId ?? "").startsWith("skill:")) {
        throw new Error("子代理只能通过 invoke_capability 加载 Skill，不能调用 MCP 或其他外部能力。");
      }
      return delegate.execute(input);
    },
    has: (name) => allowed.has(name) && delegate.has(name),
    kind: delegate.kind.bind(delegate),
    names: () => delegate.names().filter((name) => allowed.has(name)),
    outline: delegate.outline.bind(delegate),
    parallel: (name) => allowed.has(name) && delegate.parallel(name),
    prepare: delegate.prepare.bind(delegate),
    retain: delegate.retain.bind(delegate),
    runningCommands: delegate.runningCommands.bind(delegate),
    specs: delegate.specs.filter((spec) => allowed.has(spec.name)),
    stopCommands: delegate.stopCommands.bind(delegate),
    takeSettledCommands: delegate.takeSettledCommands.bind(delegate),
    waitForSettled: delegate.waitForSettled.bind(delegate),
    summarizeArgs: delegate.summarizeArgs.bind(delegate),
    summarizeResult: delegate.summarizeResult.bind(delegate),
    title: delegate.title.bind(delegate)
  };
}
