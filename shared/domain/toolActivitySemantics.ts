import { AggregateHeadlineKind, ToolState } from "../contracts/runtime";

const HEADLINE_PRIORITY: Record<AggregateHeadlineKind, number> = {
  browse: 10,
  locate: 20,
  read: 30,
  execute: 35,
  review: 40,
  inspect_environment: 45,
  modify: 50,
  verify: 55,
  verify_runtime: 58,
  build: 60,
  modify_and_verify: 65,
  configure_environment: 70,
  install_dependencies: 72,
  prepare_environment: 75,
  start_service: 78,
  start_database: 80,
  initialize_database: 85,
  external: 90,
  deploy: 100
};

const CONTROL_TOOLS = new Set([
  "ask_user",
  "enter_plan",
  "invoke_capability",
  "stop_command",
  "submit_plan",
  "update_tasks",
  "wait_command"
]);

export function headlinePriority(kind: AggregateHeadlineKind): number {
  return HEADLINE_PRIORITY[kind];
}

function commandText(tool: ToolState): string {
  return (tool.normalizedTarget || tool.argumentsPreview).toLowerCase();
}

function supportOnlyCommand(command: string): boolean {
  const segments = command
    .split(/&&|\|\||[;\n]/)
    .map((segment) => segment.trim().replace(/^(?:[a-z_][a-z0-9_]*=[^\s]+\s+)*/i, ""))
    .filter(Boolean);
  return segments.length > 0 && segments.every((segment) => /^(?:cd\b|echo\b|printf\b|sleep\b|true\b|:)/.test(segment));
}

function commandHeadline(tool: ToolState): AggregateHeadlineKind | undefined {
  const command = commandText(tool);
  if (/\b(?:kubectl\s+apply|helm\s+(?:install|upgrade)|terraform\s+apply|vercel\s+deploy|netlify\s+deploy|npm\s+publish|git\s+push)\b/.test(command)) return "deploy";
  if (/\b(?:alembic\s+upgrade|prisma\s+migrate|sequelize\s+db:migrate|knex\s+migrate|manage\.py\s+migrate|seed(?:_data)?\.py|db:seed)\b/.test(command)) return "initialize_database";
  if (/\b(?:docker(?:-compose|\s+compose)\s+up|docker\s+run)\b/.test(command) && /\b(?:postgres|postgresql|mysql|mariadb|mongo|redis|database|db)\b/.test(command)) return "start_database";
  if (/\b(?:docker(?:-compose|\s+compose)\s+up|systemctl\s+start|service\s+\S+\s+start|npm\s+run\s+(?:dev|start)|pnpm\s+(?:dev|start)|yarn\s+(?:dev|start)|uvicorn|gunicorn)\b/.test(command)) return "start_service";
  if (/\bopen\s+-a\s+(?:docker|podman)\b/.test(command)) return "prepare_environment";
  if (/\b(?:npm|pnpm|yarn)\s+(?:install|add)\b|\b(?:pip|pip3)\s+install\b|\b(?:poetry|bundle)\s+install\b|\bcargo\s+fetch\b/.test(command)) return "install_dependencies";
  if (/\b(?:npm|pnpm|yarn)\s+run\s+build\b|\bnpx\s+(?:vite|webpack)\s+build\b|\bcargo\s+build\b|\bgo\s+build\b/.test(command)) return "build";
  if (/\bpython\d*\s+-c\b[^\n]*(?:\bimport\b|from\s+\S+\s+import)|\bcurl\b[^\n]*(?:health|ready|status)/.test(command)) return "verify_runtime";
  if (/\b(?:docker\s+info|docker\s+version|podman\s+info|which\s+\S+|where\s+\S+|pg_isready|--version\b|\/applications\/docker\.app)\b/.test(command)) return "inspect_environment";
  if (/\b(?:prettier|eslint)\b[^\n]*(?:--write|--fix)|\b(?:gofmt|rustfmt)\b/.test(command)) return "modify";
  if (tool.action === "verify") return "verify";
  if (supportOnlyCommand(command)) return undefined;
  if (tool.action === "inspect" || tool.action === "search") return "read";
  return tool.action === "execute" ? "execute" : undefined;
}

function environmentConfiguration(tool: ToolState): boolean {
  if (tool.action !== "modify") return false;
  const target = tool.normalizedTarget.replaceAll("\\", "/").toLowerCase();
  const name = target.split("/").at(-1) ?? target;
  return /^\.env(?:\.|$)/.test(name)
    || /^(?:docker-compose|compose)\.ya?ml$/.test(name)
    || /^(?:devcontainer\.json|\.tool-versions)$/.test(name);
}

export function headlineKindForTool(tool: ToolState): AggregateHeadlineKind | undefined {
  if (CONTROL_TOOLS.has(tool.toolName) || tool.action === "task" || tool.action === "plan") return undefined;
  if (tool.toolName === "run_command") return commandHeadline(tool);
  if (tool.toolName === "list_files") return "browse";
  if (tool.toolName === "glob" || tool.toolName === "grep" || tool.toolName === "web_search" || tool.action === "search") return "locate";
  if (tool.toolName === "read_file" || tool.toolName === "fetch_url") return "read";
  if (tool.toolName === "git_status") return "review";
  if (environmentConfiguration(tool)) return "configure_environment";
  if (tool.action === "modify") return "modify";
  if (tool.action === "verify") return "verify";
  if (tool.action === "execute") return "execute";
  if (tool.action === "external") return "external";
  if (tool.action === "inspect") return "read";
  return undefined;
}

export function dominantHeadlineKind(tools: ToolState[]): AggregateHeadlineKind | undefined {
  const candidates = tools.flatMap((tool) => {
    const candidate = headlineKindForTool(tool);
    return candidate ? [candidate] : [];
  });
  if (candidates.includes("modify") && candidates.some((candidate) =>
    candidate === "verify" || candidate === "verify_runtime" || candidate === "build"
  )) candidates.push("modify_and_verify");
  return candidates.reduce<AggregateHeadlineKind | undefined>((dominant, candidate) => {
    if (!dominant || headlinePriority(candidate) > headlinePriority(dominant)) return candidate;
    return dominant;
  }, undefined);
}

export function headlineLabel(kind: AggregateHeadlineKind): string {
  return ({
    browse: "浏览项目结构",
    locate: "定位相关内容",
    read: "读取相关信息",
    review: "检查工作区改动",
    inspect_environment: "检查运行环境",
    modify: "修改项目文件",
    modify_and_verify: "修改并验证项目",
    configure_environment: "配置项目环境",
    execute: "执行项目命令",
    verify: "验证改动",
    verify_runtime: "验证运行环境",
    build: "构建项目",
    install_dependencies: "安装项目依赖",
    prepare_environment: "准备运行环境",
    start_service: "启动项目服务",
    start_database: "启动数据库",
    initialize_database: "初始化数据库",
    external: "处理外部操作",
    deploy: "发布项目"
  } satisfies Record<AggregateHeadlineKind, string>)[kind];
}
