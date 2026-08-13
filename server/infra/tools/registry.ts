import { ActionKind, Effect, TargetKind } from "../../../shared/contracts/runtime";
import { ToolSpec } from "../../../shared/contracts/provider";
import { DetailMode, GroupMode, ToolImportance } from "../../../shared/projections/types";
import { analyzeCommand } from "../../domain/accessPolicy";
import { workspaceRelativeTarget } from "./security";

type ToolPresentation = {
  groupMode: GroupMode;
  detail: DetailMode;
  effect: Effect;
  importance: ToolImportance;
  action: ActionKind;
  targetKind: TargetKind;
  resolveTarget: (args: Record<string, unknown>, projectRoot: string) => string;
  resolveSemantics?: (args: Record<string, unknown>) => Partial<Pick<ToolPresentation,
    "groupMode" | "effect" | "importance" | "action" | "targetKind"
  >>;
};
export type ToolRegistration = ToolSpec & {
  presentation: ToolPresentation;
};

const COLLAPSED_FILE_DETAIL: DetailMode = {
  defaultCollapsed: true,
  pathStyle: "workspace_relative",
  previewLimit: 5
};

const COLLAPSED_RAW_DETAIL: DetailMode = {
  defaultCollapsed: true,
  pathStyle: "raw",
  previewLimit: 5
};

function classifyCommand(command: string): Partial<ToolPresentation> {
  const semantics = analyzeCommand(command);
  const normalized = command.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, "");
  if (/^(?:rg|grep)\b/.test(normalized)) {
    return {
      groupMode: "consecutive",
      effect: "read_only",
      importance: "routine",
      action: "search",
      targetKind: "workspace"
    };
  }
  if (/^(?:cat|head|tail|sed\s+-n|ls|tree|find|fd|pwd|wc|git\s+(?:status|diff|log|show|branch))\b/.test(normalized)) {
    return {
      groupMode: "consecutive",
      effect: "read_only",
      importance: "routine",
      action: "inspect",
      targetKind: "workspace"
    };
  }
  if (/^(?:(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|build|lint|check|typecheck))|npx\s+(?:tsc|eslint|vitest|playwright)|pytest|cargo\s+(?:test|check)|go\s+test)\b/.test(normalized)) {
    return {
      groupMode: "consecutive",
      effect: "process_side_effect",
      importance: "notable",
      action: "verify",
      targetKind: "process"
    };
  }
  if (semantics.readOnly) {
    return {
      groupMode: "consecutive",
      effect: "read_only",
      importance: "routine",
      action: "inspect",
      targetKind: "workspace"
    };
  }
  return {};
}


const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  additionalProperties: false,
  properties,
  ...(required.length > 0 ? { required } : {}),
  type: "object"
});

// ─────────────────────────────────────────────────────────────────────────────
// 工具注册表。
//
// 描述编写规范(对标 Anthropic 官方工具描述指南 + Claude Code / Codex 最佳实践):
//   1. 每个描述至少说明用途、适用时机、不适用场景和注意事项
//   2. 使用“适用场景”与“不适用场景”双向引导，防止工具误选
//   3. 关键工具附 Example(对标 Codex apply_patch / Claude Code Bash)
//   4. 硬性规则用 IMPORTANT / MUST / NEVER 强调
//   5. inputSchema 每个字段带 description(传给模型的 JSON Schema)
//   6. 模型可见说明统一使用中文；工具名、字段名和枚举值保持协议原文
// ─────────────────────────────────────────────────────────────────────────────

export const toolRegistry: ToolRegistration[] = [
  {
    // 搜索项目 Skill / MCP / 长尾能力(渐进式披露)
    name: "search_capabilities",
    description: "搜索未预加载进系统提示词的项目 Skill、MCP 工具或其他长尾能力。返回简短元数据；需要完整内容时，再使用 invoke_capability 加载。\n\n适用场景：需要可能以 Skill 提供的专业工作流，例如 PDF 处理、Android 开发或 iOS 开发；不确定项目中存在哪些能力。\n\n不适用场景：已经知道 capabilityId，应直接使用 invoke_capability；需要搜索项目源码，应使用 grep、glob 或 read_file。\n\n示例：\n  search_capabilities(query=\"pdf\")\n  search_capabilities(query=\"android emulator\", limit=5)",
    inputSchema: objectSchema({
      query: { type: "string", description: "搜索词，用关键词描述所需能力，例如“pdf”“android”“代码审查”" },
      limit: { type: "number", description: "最多返回多少项结果，默认 10" }
    }, ["query"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "search",
      targetKind: "workspace",
      resolveTarget: (args) => String(args.query ?? "capability index")
    }
  },
  {
    // 按 capabilityId 启用长尾能力
    name: "invoke_capability",
    description: "根据 capabilityId 启用已经发现的长尾能力。对于 Skill，完整 SKILL.md 会作为独立 ContextUpdate 注入，必须读取并遵循；若会话保留的是该 Skill 的旧内容哈希，Runtime 会按 Skill 名称解析到当前启用版本。\n\n适用场景：已经通过 search_capabilities 找到相关能力，需要其完整指令或工具访问权限。\n\n不适用场景：尚未搜索，应先调用 search_capabilities；该能力已经加载到当前上下文。\n\n示例：\n  invoke_capability(capabilityId=\"skill:pdf\")\n  invoke_capability(capabilityId=\"mcp:github\", arguments={owner: \"octocat\", repo: \"Hello-World\"})",
    inputSchema: objectSchema({
      capabilityId: { type: "string", description: "search_capabilities 返回的能力标识符，例如 'skill:pdf' 或 'mcp:github'" },
      arguments: { type: "object", additionalProperties: true, description: "可选，传递给该能力的参数" }
    }, ["capabilityId"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "notable",
      action: "inspect",
      targetKind: "workspace",
      resolveTarget: (args) => String(args.capabilityId ?? "capability")
    }
  },
  {
    name: "read_skill_resource",
    description: "读取已启用 Skill 的 references/ 内文本资料。路径始终限制在该 Skill 的 references 目录中。\n\n适用场景：SKILL.md 明确指向平台说明、检查清单或其他按需资料。\n\n不适用场景：读取项目文件应使用 read_file；读取 assets/ 应使用 materialize_skill_asset。",
    inputSchema: objectSchema({
      capabilityId: { type: "string", description: "Skill capabilityId，例如 'skill:release-electron:abcd1234'" },
      path: { type: "string", description: "references/ 下的相对文本路径" },
      maxChars: { type: "number", description: "最多读取字符数，默认 80000，最大 200000" }
    }, ["capabilityId", "path"]),
    presentation: {
      groupMode: "consecutive",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "inspect",
      targetKind: "file",
      resolveTarget: (args) => `${String(args.capabilityId ?? "skill")}/references/${String(args.path ?? "")}`
    }
  },
  {
    name: "preview_skill_install",
    description: "为当前工作区中的 Skill 文件夹、.deepcreator-skill 包，或公开 GitHub Release 生成安全安装预览。返回发布者、版本、文件、权限、脚本、SHA-256，以及下一步 install_skill 必须原样使用的 installRequest。此工具只生成临时预览，不安装任何内容。\n\n适用场景：用户要求安装刚创建或下载的 Skill；调用 install_skill 之前。\n\n不适用场景：仅创建或打包但用户没有要求安装；已经拥有仍有效的 installRequest。\n\n重要：本地 source 必须位于当前工作区内，可使用相对路径；不要猜测用户主目录或直接写入 .deepcreator/skills。scope 必须明确选择。project 在正式项目中表示当前项目，在 scratch 工作区中只表示当前临时任务；global 表示当前用户的所有项目。",
    inputSchema: objectSchema({
      source: { type: "string", description: "当前项目内的 Skill 文件夹或安装包路径，或公开 GitHub 仓库/Release HTTPS 地址" },
      scope: { type: "string", enum: ["project", "global"], description: "安装范围；project 表示当前项目或当前临时任务，global 表示该用户的所有项目" }
    }, ["source", "scope"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "read_only",
      importance: "notable",
      action: "inspect",
      targetKind: "workspace",
      resolveTarget: (args) => String(args.source ?? "Skill package"),
      resolveSemantics: (args) => /^https:\/\//i.test(String(args.source ?? "")) ? { targetKind: "network" } : {}
    }
  },
  {
    name: "install_skill",
    description: "使用 preview_skill_install 返回的 installRequest 发起 Skill 安装。Runtime 会再次校验预览 ID、名称、发布者、版本、权限、脚本、来源和完整 SHA-256；任何字段或暂存内容变化都会拒绝安装。无论当前访问模式如何，此工具都会暂停并要求用户逐次确认，确认后才原子安装。\n\n适用场景：用户明确要求安装，且刚刚获得有效 installRequest。\n\n不适用场景：尚未预览；只需打包；用户拒绝安装。\n\n重要：必须逐字段原样传入 installRequest，不得修改、概括或自行补值。不要直接复制到用户目录来绕过信任确认。",
    inputSchema: objectSchema({
      displayName: { type: "string", description: "安全预览返回的显示名称" },
      name: { type: "string", description: "安全预览返回的 Skill 名称" },
      permissions: { type: "array", items: { type: "string" }, description: "安全预览返回的完整权限列表" },
      previewId: { type: "string", description: "安全预览的临时 ID" },
      publisher: { type: "string", description: "安全预览返回的发布者" },
      revisionHash: { type: "string", description: "安全预览返回的完整 SHA-256 内容哈希" },
      scope: { type: "string", enum: ["project", "global"], description: "安全预览选定的安装范围" },
      scripts: { type: "array", items: { type: "string" }, description: "安全预览返回的脚本 ID 列表" },
      source: { type: "string", description: "安全预览返回的来源标签或 Release 地址" },
      version: { type: "string", description: "安全预览返回的版本" }
    }, ["displayName", "name", "permissions", "previewId", "publisher", "revisionHash", "scope", "scripts", "source", "version"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "workspace_write",
      importance: "critical",
      action: "external",
      targetKind: "workspace",
      resolveTarget: (args) => `${String(args.name ?? "Skill")} (${String(args.scope ?? "project")})`,
      resolveSemantics: (args) => args.scope === "global"
        ? { effect: "external_side_effect", targetKind: "workspace" }
        : { effect: "workspace_write", targetKind: "workspace" }
    }
  },
  {
    // 按关键词读取已确认的结构化记忆事实
    name: "search_memory",
    description: "按关键词读取用户确认过的结构化 MemoryFact。这些是用户或先前会话保存并经过整理的事实，例如“项目使用 pnpm”“测试使用 vitest”。本工具只读。\n\n适用场景：已注入的 `<memory-index>` 摘要被截断或需要某条事实的完整字段（category/confidence/visibility）时，按关键词检索全文；确认某条旧记忆是否仍存在。\n\n不适用场景：任务开始时检查偏好——记忆摘要已通过会话开头的 `<memory-index>` 自动注入，无需主动调用本工具；需要当前代码库状态，应使用 read_file 或 grep；需要保存新事实，应使用 save_memory。\n\n示例：\n  search_memory(query=\"package manager\")\n  search_memory(query=\"test framework\", limit=5)",
    inputSchema: objectSchema({
      query: { type: "string", description: "用于搜索已保存记忆事实的关键词或短语" },
      limit: { type: "number", description: "最多返回多少条事实，默认 10" }
    }, ["query"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "search",
      targetKind: "workspace",
      resolveTarget: (args) => String(args.query ?? "memory")
    }
  },
  {
    // 保存一条结构化记忆事实(写入 runtime.sqlite,跨会话复用)
    name: "save_memory",
    description: "保存一条已确认的结构化 MemoryFact，供后续会话和项目复用。本工具写入持久记忆库，不修改工作区文件。\n\n适用场景：用户明确要求“记住”某件事；发现了稳定、会跨会话复用的约定或事实（技术栈、测试命令、已确认的偏好）。\n\n不适用场景：临时信息或仅与当前会话相关的上下文；需要当前代码库状态，应使用 read_file 或 grep；需要检索已存记忆，应使用 search_memory。\n\n重要：① 不要保存密钥或凭据（API key、token、password、secret）——会被拦截报错。② 保存立即持久化，但写入对当前会话的 `<memory-index>` 不立即生效——该记忆将在下次上下文压缩或新会话时进入记忆索引（这是刻意的缓存保护，保存已成功，不要因为没有立即见到而重试）。\n\n示例：\n  save_memory(statement=\"项目使用 pnpm 而非 npm\", category=\"project_fact\", visibility=\"project\")\n  save_memory(statement=\"用户偏好用 vitest 做测试\", category=\"preference\", visibility=\"personal\")",
    inputSchema: objectSchema({
      statement: { type: "string", description: "要保存的事实陈述，一句话、自包含、可跨会话复用。不要包含密钥或凭据。" },
      category: { type: "string", enum: ["preference", "project_fact", "workflow", "known_issue"], description: "事实类别：preference 用户偏好；project_fact 项目事实；workflow 工作流/约定；known_issue 已知问题" },
      visibility: { type: "string", enum: ["personal", "project"], description: "可见范围：personal 跨所有项目可见（默认）；project 仅当前项目可见（自动绑定当前项目根）" },
      confidence: { type: "number", description: "置信度 0 到 1，默认 0.7；仅在高确信时调高" }
    }, ["statement", "category"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "routine",
      action: "modify",
      targetKind: "workspace",
      resolveTarget: (args) => String(args.statement ?? "memory").slice(0, 80)
    }
  },
  {
    // 列出项目文件树
    name: "list_files",
    description: "以树形结构列出项目文件，自动跳过依赖目录（node_modules、dist、.git、.venv）、构建产物和敏感文件。\n\n适用场景：任务开始时需要项目结构的整体概览；深入具体文件前需要理解目录布局。\n\n不适用场景：需要匹配特定模式的文件，应使用 glob；需要搜索文件内容，应使用 grep；项目很大且只需要其中一部分。\n\n注意：结果受 maxFiles 限制，默认 200。大型项目应优先使用带具体模式的 glob。\n\n示例：\n  list_files()\n  list_files(maxFiles=500)",
    inputSchema: objectSchema({
      maxFiles: { type: "number", description: "最多返回多少个文件条目，默认 200，并受硬性上限约束" }
    }),
    presentation: {
      groupMode: "consecutive",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "inspect",
      targetKind: "directory",
      resolveTarget: (_args, projectRoot) => workspaceRelativeTarget(projectRoot, ".")
    }
  },
  {
    // 读取文件内容
    name: "read_file",
    description: "读取项目根目录内的 UTF-8 文本文件并返回内容。大文件超过 maxChars 时会截断并给出提示。\n\n适用场景：需要检查或修改文件内容；即将编辑文件，必须先读取；可以在同一条消息中批量读取多个可能有用的文件，以便并行加载。\n\n不适用场景：只需要了解有哪些文件，应使用 glob 或 list_files；需要跨多个文件搜索模式，应使用 grep；目标是图片或二进制文件，本工具不支持。\n\n重要：使用 edit_file 或 write_file 编辑文件前，必须先读取并理解其当前内容。未读取就编辑容易导致 oldText 匹配错误。编辑成功后不要重读验证——edit_file 和 multi_edit 成功时已返回 unified diff，重读只是浪费。只有当编辑因 oldText 不匹配而失败、需要查看当前实际内容时才重读。\n\n示例：\n  read_file(path=\"src/App.tsx\")\n  read_file(path=\"package.json\")\n  # 在一条消息中批量并行读取：\n  #   read_file(path=\"src/App.tsx\"), read_file(path=\"src/main.tsx\"), read_file(path=\"vite.config.ts\")",
    inputSchema: objectSchema({
      path: { type: "string", description: "文件相对于工作区的路径，例如 'src/App.tsx' 或 'package.json'" },
      maxChars: { type: "number", description: "截断前最多读取的字符数，默认 40000、上限 200000。只需要大文件开头时应调小此值。" }
    }, ["path"]),
    presentation: {
      groupMode: "consecutive",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "inspect",
      targetKind: "file",
      resolveTarget: (args, projectRoot) => args.path
        ? workspaceRelativeTarget(projectRoot, String(args.path))
        : ""
    }
  },
  {
    // 内容搜索(结构化扫描,跨平台稳定)
    name: "grep",
    description: "在整个项目中进行快速、结构化且跨平台稳定的内容搜索，在 Windows、Linux 和 macOS 上行为一致。使用 JavaScript 正则搜索文件内容；危险正则会被拒绝，超过 2 MiB 的文件和二进制文件会被跳过。\n\n适用场景：搜索代码、字符串或标记时始终优先使用 grep，例如 TODO 注释、函数名、调用点和错误日志。本工具是主要的内容搜索入口。\n\n不适用场景：需要按名称或扩展名查找文件，应使用 glob；需要项目整体概览，应使用 list_files；需要执行 shell 命令，应使用 run_command。\n\n重要：绝不能通过 run_command 执行 rg、grep、findstr 或 find。这些 shell 命令在 Windows 与 Git Bash 组合下经常因方言差异失败，也会绕过本工具的依赖过滤和敏感文件保护。\n\n功能：\n- pattern：完整 JavaScript 正则，例如 'log.*Error'、'function\\\\s+\\\\w+'\n- output_mode：'files_with_matches' 默认只返回工作区相对路径，节省 token，建议首次搜索使用；也支持 'content'、'count'、'json'\n- 使用 glob 过滤文件类型，使用 path 限定子目录，使用 context 返回 0 至 3 行上下文\n- 搜索包含正则元字符的字面量，例如 URL 或 API Key 时，设置 fixed_strings=true\n- 自动跳过 node_modules、dist、.git，自动排除 .env、*.key、id_rsa，并对输出脱敏\n\n示例：\n  grep(pattern=\"TODO\", glob=\"**/*.ts\", output_mode=\"content\", context=2)\n  grep(pattern=\"api.deepseek.com\", fixed_strings=true)",
    inputSchema: objectSchema({
      pattern: { type: "string", description: "要搜索的 JavaScript（ECMAScript）正则。不要使用 (?i) 等 PCRE 内联标志，改用 case_sensitive=false。" },
      path: { type: "string", description: "可选，用工作区相对路径限定搜索子目录，例如 'src/'" },
      glob: { type: "string", description: "可选，用 minimatch 模式过滤文件类型，例如 '**/*.ts' 或 '**/*.{tsx,ts}'" },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count", "json"], description: "结果格式：'files_with_matches' 默认只返回路径；'content' 返回 path:line:content；'count' 返回每个文件的命中数；'json' 返回结构化数组，每项含 path/line/column/match/contextBefore/contextAfter 字段。" },
      case_sensitive: { type: "boolean", description: "是否区分大小写，默认 true。需要忽略大小写时设为 false，不要写 (?i)。" },
      fixed_strings: { type: "boolean", description: "是否把 pattern 视为字面量并转义正则元字符，默认 false。搜索 URL、API Key 或含特殊字符的字符串时使用。" },
      context: { type: "number", description: "每个匹配项前后显示多少行上下文，范围 0 至 3，默认 0" },
      max_results: { type: "number", description: "最多返回多少个匹配项，默认 200" }
    }, ["pattern"]),
    presentation: {
      groupMode: "consecutive",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "search",
      targetKind: "workspace",
      resolveTarget: (args, projectRoot) => args.path
        ? `${String(args.pattern ?? "search")} @ ${workspaceRelativeTarget(projectRoot, String(args.path))}`
        : String(args.pattern ?? "search")
    }
  },
  {
    // 文件路径匹配(minimatch,跨平台稳定)
    name: "glob",
    description: "使用 minimatch 模式快速匹配文件路径，跨平台行为稳定，在 Windows、Linux 和 macOS 上保持一致。返回工作区相对路径，并按修改时间从新到旧排序。\n\n适用场景：按名称、扩展名或路径模式查找文件时始终优先使用 glob，例如查找所有 .tsx 组件、测试文件或配置文件。本工具是主要的文件发现入口。\n\n不适用场景：需要搜索文件内容，应使用 grep；需要项目整体概览，应使用 list_files；需要执行 shell 命令，应使用 run_command。\n\n重要：绝不能通过 run_command 执行 find、ls、Get-ChildItem、dir 或 where。这些 shell 命令在 Windows 与 Git Bash 组合下经常因方言差异失败，也会绕过本工具的依赖过滤。\n\n模式语法：** 跨目录，* 匹配单个路径段，{a,b} 表示枚举，? 匹配单个字符。\n\n示例：\n  glob(pattern=\"src/components/**/*.tsx\")\n  glob(pattern=\"**/*.test.ts\")\n  glob(pattern=\"*.{json,md,yaml}\")\n\nglob 与 grep 共同组成标准的“查找文件 → 读取内容”流程。",
    inputSchema: objectSchema({
      pattern: { type: "string", description: "Minimatch glob 模式，例如 'src/**/*.tsx'、'**/*.test.ts' 或 '*.{json,md}'" },
      path: { type: "string", description: "可选，用工作区相对路径限定搜索子目录" },
      detail: { type: "boolean", description: "设为 true 时，在每个结果后附加文件大小和修改时间，默认 false" },
      limit: { type: "number", description: "最多返回多少条路径，默认 200" }
    }, ["pattern"]),
    presentation: {
      groupMode: "consecutive",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "inspect",
      targetKind: "directory",
      resolveTarget: (args, projectRoot) => args.path
        ? `${String(args.pattern ?? "match")} @ ${workspaceRelativeTarget(projectRoot, String(args.path))}`
        : String(args.pattern ?? "match")
    }
  },
  {
    // 读取 Git 工作区状态
    name: "git_status",
    description: "读取当前 Git 工作树状态和 diff 摘要，返回已暂存、未暂存、未跟踪文件列表以及精简 diff。\n\n适用场景：提交前确认有哪些改动；编辑后验证真实 diff 是否符合预期；用户询问“改了什么”。\n\n不适用场景：需要执行 commit、push、log 等任意 Git 命令，应使用 run_command；只需要读取特定文件，应使用 read_file。\n\n示例：\n  git_status()",
    inputSchema: objectSchema({}),
    presentation: {
      groupMode: "consecutive",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "read_only",
      importance: "routine",
      action: "inspect",
      targetKind: "workspace",
      resolveTarget: () => "Git working tree"
    }
  },
  {
    // 联网搜索
    name: "web_search",
    description: "联网搜索最新信息，例如新 SDK、错误消息、API 规范和库文档。返回包含标题、URL 和摘要的结果列表。\n\n适用场景：模型知识可能已经过时，例如新版本库、近期 API 变更、陌生错误消息或特定版本行为；用户询问近期信息。\n\n不适用场景：答案可以从本地代码库找到，应使用 grep、glob 或 read_file；信息稳定且已有知识足够；需要完整网页内容，应对具体 URL 使用 fetch_url。\n\n重要：联网搜索需要配置搜索后端，即 SEARCH_API_URL 和 SEARCH_API_KEY 环境变量。未配置时，错误信息会引导用户完成设置。结果会经过密钥脱敏。\n\n标准流程：先用 web_search 找到相关页面，再用 fetch_url 阅读最佳结果的完整内容。\n\n示例：\n  web_search(query=\"DeepSeek V4 function calling spec\", limit=5)\n  web_search(query=\"npm ERR! ERESOLVE peer dependency\", allowedDomains=[\"stackoverflow.com\", \"docs.npmjs.com\"])",
    inputSchema: objectSchema({
      query: { type: "string", description: "搜索词" },
      limit: { type: "number", description: "最多返回多少项结果，默认 5，最大 20" },
      allowedDomains: { type: "array", items: { type: "string" }, description: "可选，只允许这些域名的结果，例如 ['docs.python.org', 'stackoverflow.com']" },
      blockedDomains: { type: "array", items: { type: "string" }, description: "可选，排除这些域名的结果" }
    }, ["query"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "process_side_effect",
      importance: "notable",
      action: "search",
      targetKind: "workspace",
      resolveTarget: (args) => String(args.query ?? "web search")
    }
  },
  {
    // 抓取网页内容
    name: "fetch_url",
    description: "抓取指定 URL，并以 Markdown 返回内容；HTML 会转换，JSON 和纯文本会原样传递。大型页面超过 maxChars 时会截断。\n\n适用场景：web_search 找到相关页面后，需要阅读全文；需要读取 API 文档、Stack Overflow 回答或博客文章。\n\n不适用场景：还没有具体 URL，应先使用 web_search；内容位于本地项目，应使用 read_file。\n\n功能：\n- 将 HTML 转为 Markdown，保留标题、链接、列表、代码块和引用\n- 移除 script、style、nav、footer 等噪声\n- 按 maxChars 截断，默认 20000、最大 200000，并给出截断提示\n- 仅支持 http 和 https URL\n- 30 秒超时\n- 输出经过密钥脱敏\n\n示例：\n  fetch_url(url=\"https://docs.example.com/api/v2\", format=\"markdown\", maxChars=20000)",
    inputSchema: objectSchema({
      url: { type: "string", description: "要抓取的 http 或 https URL" },
      maxChars: { type: "number", description: "截断前最多返回的字符数，默认 20000，最大 200000" },
      format: { type: "string", enum: ["markdown", "text"], description: "输出格式：'markdown' 默认保留结构；'text' 移除 Markdown 语法" }
    }, ["url"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "process_side_effect",
      importance: "notable",
      action: "inspect",
      targetKind: "workspace",
      resolveTarget: (args) => String(args.url ?? "URL")
    }
  },
  {
    name: "apply_patch",
    description: "使用 Codex apply_patch 文本格式，在一个原子操作中描述一个或多个工作区文件的增删改。补丁在完整生成、解析、审批之前只是未应用的草稿；任一处失败则整批回滚，不写盘。\n\n适用场景：需要跨多个文件的协调改动（重命名一个符号并同步所有引用文件）；单次改动同时含新增、更新、删除文件；需要比逐个 edit_file 更紧凑、可整体审阅的一次性 diff。\n\n不适用场景：只改单个文件的局部，应优先用 edit_file（更小、更易审查的 diff）；创建单个新文件，应使用 write_file；单文件多处协调编辑，应使用 multi_edit。\n\n重要：格式必须以 *** Begin Patch 开始、*** End Patch 结束，使用 *** Add File / *** Update File / *** Delete File 段。更新段用 @@ hunk，内容行分别以空格（上下文）、+（新增）、-（删除）开头。匹配依赖上下文行精确比对，空白或缩进不一致会失败。\n\n示例：\n  apply_patch(patch=\"*** Begin Patch\\n*** Update File: src/config.ts\\n@@\\n-const PORT = 3000;\\n+const PORT = 8080;\\n*** End Patch\")",
    inputSchema: objectSchema({
      patch: { type: "string", description: "完整的 apply_patch 文本，包括 Begin Patch 与 End Patch 标记" }
    }, ["patch"]),
    presentation: {
      groupMode: "workspace_delta",
      detail: { ...COLLAPSED_FILE_DETAIL, defaultCollapsed: false },
      effect: "workspace_write",
      importance: "notable",
      action: "modify",
      targetKind: "workspace",
      resolveTarget: () => "工作区补丁"
    }
  },
  {
    // 创建/覆盖文件
    name: "write_file",
    description: "使用给定的完整内容创建新文件，或覆盖现有文件。\n\n适用场景：创建尚不存在的新文件；完整替换某个文件，例如重写配置；文件足够小，可以完整输出。\n\n不适用场景：只修改现有文件的一部分，应使用更节省且更安全的 edit_file；文件已经存在但尚未读取。\n\n重要：如果文件已经存在，必须先使用 read_file 读取。未读取就覆盖可能丢失未知的重要内容。局部改动应优先使用 edit_file，它能产生更小、更易审查的 diff。\n\n示例：\n  write_file(path=\"src/utils/helpers.ts\", content=\"export const add = (a: number, b: number) => a + b;\\n\")",
    inputSchema: objectSchema({
      path: { type: "string", description: "要创建或覆盖的工作区相对路径，例如 'src/utils/helpers.ts'" },
      content: { type: "string", description: "要写入的完整文件内容" }
    }, ["path", "content"]),
    presentation: {
      groupMode: "workspace_delta",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "workspace_write",
      importance: "notable",
      action: "modify",
      targetKind: "file",
      resolveTarget: (args, projectRoot) => args.path
        ? workspaceRelativeTarget(projectRoot, String(args.path))
        : ""
    }
  },
  {
    // 精确文本替换编辑
    name: "edit_file",
    description: "通过把 oldText 精确替换为 newText 来编辑现有文件。\n\n适用场景：修改现有文件的特定部分。本工具是局部编辑的首选，能产生最小且易审查的 diff。\n\n不适用场景：创建新文件，应使用 write_file；目标文件尚不存在。\n\n重要：如果 oldText 在文件中不唯一，编辑会失败。若出现多次，应提供更多周边上下文使其唯一，或设置 replaceAll=true 替换全部匹配项。\n\n示例：\n  edit_file(path=\"src/App.tsx\", oldText=\"const foo = 1;\", newText=\"const foo = 2;\")",
    inputSchema: objectSchema({
      path: { type: "string", description: "要编辑文件的工作区相对路径" },
      oldText: { type: "string", description: "要查找的精确文本。除非 replaceAll 为 true，否则必须在文件中唯一。请包含足够的周边上下文以确保唯一性。" },
      newText: { type: "string", description: "替换后的文本" },
      replaceAll: { type: "boolean", description: "设为 true 时替换 oldText 的所有匹配项，默认 false" },
      startLine: { type: "number", description: "可选，1 起始行号。注意：startLine 与 endLine 必须同时给出，且仅在 oldText 精确匹配（strict）未命中时作为 relaxed（trimEnd）窗口生效——strict 命中时此窗口被忽略。由于编辑过程中行号会随前序改动漂移，优先靠提供足够上下文的 oldText 保证唯一，行号锚定仅作兜底。" },
      endLine: { type: "number", description: "可选，1 起始结束行号（含）。必须与 startLine 同时给出，二者仅共同限定 relaxed 匹配窗口。" }
    }, ["path", "oldText", "newText"]),
    presentation: {
      groupMode: "workspace_delta",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "workspace_write",
      importance: "notable",
      action: "modify",
      targetKind: "file",
      resolveTarget: (args, projectRoot) => args.path
        ? workspaceRelativeTarget(projectRoot, String(args.path))
        : ""
    }
  },
  {
    // 批量原子编辑(多个 oldText→newText,单次写盘)
    name: "multi_edit",
    description: "在一次原子操作中，对同一个文件执行多项精确文本替换。所有编辑先应用于内存内容，只有全部成功后才写盘一次。\n\n适用场景：重构单个文件且需要三个或更多相互协调的编辑，例如重命名符号、更新导入并修正调用点。相比连续多次调用 edit_file，本工具更快，并产生一个整洁的 diff。\n\n不适用场景：只有一项改动，应使用 edit_file；创建新文件，应使用 write_file。\n\n原子性保证：只要任一 oldText 匹配失败，例如不存在或未使用 replaceAll 时存在歧义，整个批次都会回滚，不会向磁盘写入任何改动。错误结果会列出所有失败编辑的索引和原因。\n\n重要：每项编辑的 oldText 必须在原始文件内容中唯一，除非该项设置 replaceAll=true。编辑会依次应用到同一内容缓冲区，因此前面的替换对后面的编辑可见，排序时必须考虑这一点。\n\n示例：\n  multi_edit(path=\"src/App.tsx\", edits=[\n    {oldText: \"const foo = 1;\", newText: \"const foo = 2;\"},\n    {oldText: \"return null;\", newText: \"return <App/>;\"},\n    {oldText: \"import React\", newText: \"import React, { useState }\"}\n  ])",
    inputSchema: objectSchema({
      path: { type: "string", description: "要编辑文件的工作区相对路径" },
      edits: {
        type: "array",
        minItems: 1,
        description: "要原子应用的编辑数组。所有编辑必须全部成功，否则一项也不会写入。",
        items: objectSchema({
          oldText: { type: "string", description: "要查找的精确文本。除非 replaceAll 为 true，否则必须在文件中唯一。" },
          newText: { type: "string", description: "替换后的文本" },
          replaceAll: { type: "boolean", description: "设为 true 时替换 oldText 的所有匹配项，默认 false" },
          startLine: { type: "number", description: "可选，1 起始行号。注意：startLine 与 endLine 必须同时给出，且仅在该项 oldText 精确匹配未命中时作为 relaxed（trimEnd）窗口生效——行号参照的是该项应用时 workingCopy 的行号（前序 edit 已生效后），会因前序编辑而漂移，优先用足够上下文的 oldText 保证唯一。" },
          endLine: { type: "number", description: "可选，1 起始结束行号（含）。必须与 startLine 同时给出，共同限定该项的 relaxed 匹配窗口。" }
        }, ["oldText", "newText"])
      }
    }, ["path", "edits"]),
    presentation: {
      groupMode: "workspace_delta",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "workspace_write",
      importance: "notable",
      action: "modify",
      targetKind: "file",
      resolveTarget: (args, projectRoot) => args.path
        ? workspaceRelativeTarget(projectRoot, String(args.path))
        : ""
    }
  },
  {
    // 删除文件(危险操作)
    name: "delete_file",
    description: "删除项目根目录内的单个文件。这是具有破坏性且不可逆的操作，需要用户审批。\n\n适用场景：用户明确要求删除文件；重构过程中需要移除生成文件。\n\n不适用场景：只想清空文件内容但保留文件，应使用空内容调用 write_file 或使用 edit_file；用户没有要求删除。\n\n重要：删除需要用户审批，并且在 Git 之外无法撤销。调用前必须确认路径正确。\n\n示例：\n  delete_file(path=\"src/legacy/old-module.ts\")",
    inputSchema: objectSchema({
      path: { type: "string", description: "要删除文件的工作区相对路径" }
    }, ["path"]),
    presentation: {
      groupMode: "standalone",
      detail: { ...COLLAPSED_FILE_DETAIL, defaultCollapsed: false },
      effect: "workspace_write",
      importance: "critical",
      action: "modify",
      targetKind: "file",
      resolveTarget: (args, projectRoot) => args.path
        ? workspaceRelativeTarget(projectRoot, String(args.path))
        : ""
    }
  },
  {
    // 执行 shell 命令(托管对象)
    name: "run_command",
    description: "在项目根目录执行 shell 命令，例如构建、测试、Git 操作和启动进程。这是一个受托管对象：命令会在前台等待 60 秒；如果仍在运行，将返回 commandId，此时必须使用 wait_command 继续等待，或使用 stop_command 停止。\n\n适用场景：仅用于真实 shell 执行，包括构建（npm run build）、测试（npm test）、Git 操作（git commit）、启动开发服务器和运行脚本。\n\n不适用场景：搜索代码或文件，应分别使用 grep、glob、list_files 或 read_file。\n\n重要：绝不能通过 run_command 执行 rg、grep、findstr、find、cat、head、tail 或 ls。这些 shell 命令在 Windows 与 Git Bash 组合下经常因方言差异失败，也会绕过专用工具的依赖过滤和敏感文件保护。\n\nShell 语义（重要）：每次 run_command 都会 spawn 一个全新的隔离 shell——工作目录固定为项目根、不跨调用持久；环境变量也无法通过工具传入（本工具无 env 字段，只能继承进程环境）。需要在单条命令内传环境变量时，写成 VAR=val command 的前缀形式（仅对该条命令生效，不持久）。命令会在前台等待 60 秒，这 60 秒是前台等待检查点而非杀死超时——超时后进程转入后台并返回 commandId，进程继续运行直到自然结束或被 stop_command 终止。\n\n托管命令规则：\n- 命令运行超过 60 秒时会返回 commandId。使用 wait_command 继续等待，或使用 stop_command 终止。\n- 不要重复运行同一个长命令来轮询，这会创建重复进程。应对现有 commandId 使用 wait_command。\n- 仍有托管命令运行时，Run 不能结束。结束前必须调用 wait_command 或 stop_command。\n\n非安全命令，包括修改和网络访问，需要用户审批。对于非简单或潜在高风险命令，例如删除、强制推送或安装，请在调用前用 content 简短说明命令的作用和原因，帮助用户在审批前理解操作。\n\n示例：\n  run_command(command=\"npm run build\")\n  run_command(command=\"npm test\")\n  run_command(command=\"git add -A && git commit -m 'feat: add login page'\")",
    inputSchema: objectSchema({
      command: { type: "string", description: "要执行的 shell 命令，例如 'npm run build'、'git status' 或 'npx tsc --noEmit'" }
    }, ["command"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "process_side_effect",
      importance: "notable",
      action: "execute",
      targetKind: "process",
      resolveSemantics: (args) => classifyCommand(String(args.command ?? "")),
      resolveTarget: (args) => String(args.command ?? "")
    }
  },
  {
    name: "materialize_skill_asset",
    description: "把已启用 Skill 的 assets/ 中单个文件复制到当前工作区。复制会作为普通工作区修改被追踪。\n\n适用场景：Skill 提供模板、配置样例或静态资源，并明确要求将其落到项目中。\n\n不适用场景：只需阅读 references/；目标已存在且用户没有授权覆盖。",
    inputSchema: objectSchema({
      capabilityId: { type: "string", description: "Skill 能力标识 capabilityId" },
      path: { type: "string", description: "assets/ 下的相对文件路径" },
      target: { type: "string", description: "工作区内的目标相对路径" },
      overwrite: { type: "boolean", description: "目标存在时是否覆盖，默认 false" }
    }, ["capabilityId", "path", "target"]),
    presentation: {
      groupMode: "workspace_delta",
      detail: COLLAPSED_FILE_DETAIL,
      effect: "workspace_write",
      importance: "notable",
      action: "modify",
      targetKind: "file",
      resolveTarget: (args, projectRoot) => args.target
        ? workspaceRelativeTarget(projectRoot, String(args.target))
        : ""
    }
  },
  {
    name: "run_skill_script",
    description: "运行已受信任 Skill 在 skill.json 中声明的 .mjs 脚本。脚本工作目录固定为项目根目录，并复用 run_command 的 commandId、等待、停止、取消、输出裁剪和变更采集生命周期。\n\n适用场景：已加载的 Skill 明确要求执行其声明脚本。\n\n不适用场景：legacy Skill、未受信任 Skill、manifest 未声明的文件，或普通项目命令。\n\n重要：脚本以当前系统用户权限运行，但不会继承模型 API Key、Runtime Token 或 GitHub Token。仍在运行时必须使用 wait_command 或 stop_command 管理原 commandId。",
    inputSchema: objectSchema({
      capabilityId: { type: "string", description: "Skill 能力标识 capabilityId" },
      scriptId: { type: "string", description: "skill.json scripts 中声明的脚本标识" },
      args: { type: "array", items: { type: "string" }, description: "传递给脚本的字符串参数数组" }
    }, ["capabilityId", "scriptId"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "process_side_effect",
      importance: "notable",
      action: "execute",
      targetKind: "process",
      resolveTarget: (args) => `${String(args.capabilityId ?? "skill")}:${String(args.scriptId ?? "script")}`
    }
  },
  {
    // 等待托管命令
    name: "wait_command",
    description: "等待仍在运行的托管命令。返回自上次轮询以来的 stdout、stderr 增量输出，并最多阻塞 60 秒；命令退出时会提前返回。\n\n适用场景：run_command 因命令运行超过 60 秒而返回 commandId；需要收集更多输出或确认命令是否完成。\n\n不适用场景：命令已经退出，结果已经直接返回；希望停止命令而不是等待，应使用 stop_command。\n\n重要：不要重新运行原命令来轮询，这会创建重复的托管对象。始终对现有 commandId 使用 wait_command。\n\n示例：\n  wait_command(commandId=\"cmd_a1b2c3\")",
    inputSchema: objectSchema({
      commandId: { type: "string", description: "run_command 在命令仍运行时返回的 commandId" }
    }, ["commandId"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "routine",
      action: "execute",
      targetKind: "process",
      resolveTarget: (args) => String(args.commandId ?? "")
    }
  },
  {
    // 停止托管命令
    name: "stop_command",
    description: "停止托管命令及其完整进程树。对已经停止或退出的命令调用也是安全的，操作具有幂等性。\n\n适用场景：不再需要某个长时间运行的命令，例如开发服务器，需要终止它；Run 因命令仍在运行而无法结束，并且不希望继续等待。\n\n不适用场景：希望继续等待命令，应使用 wait_command。\n\n示例：\n  stop_command(commandId=\"cmd_a1b2c3\")",
    inputSchema: objectSchema({
      commandId: { type: "string", description: "要停止的托管命令 commandId" }
    }, ["commandId"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "notable",
      action: "execute",
      targetKind: "process",
      resolveTarget: (args) => String(args.commandId ?? "")
    }
  },
  {
    // 请求进入计划模式
    name: "enter_plan",
    description: "在产生任何副作用前，请求进入计划模式。计划模式只允许只读操作，包括读取、搜索、提问和形成方案，不得修改工作区或产生外部副作用。\n\n适用场景：任务复杂、跨模块、涉及重大权衡或迁移、存在安全风险、难以回滚；用户明确要求先制定计划。\n\n不适用场景：任务简单且明确，应直接完成；已经开始修改文件，计划模式只适用于实施前阶段。\n\n重要：这是独立控制工具，Run 可能暂停直至用户确认。\n\n示例：\n  enter_plan(reason=\"该重构跨越 3 个模块和 12 个文件，并存在迁移风险\")",
    inputSchema: objectSchema({
      reason: { type: "string", description: "说明本任务为何需要计划模式，例如“该重构跨越 3 个模块和 12 个文件，并存在迁移风险”" }
    }, ["reason"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "notable",
      action: "plan",
      targetKind: "plan",
      resolveTarget: () => "plan mode"
    }
  },
  {
    // 在计划或工作模式中向用户提问
    name: "ask_user",
    description: "在计划或工作模式中，向用户提出一至三个会实质影响后续工作的简短选择题，然后等待回答。支持单选和多选；每道题由界面统一提供“其他”输入，选项可以标注推荐项，但推荐不会被自动选择。\n\n适用场景：已经完成必要的只读调查，但仍存在无法自行查明、会改变实现方向或安全边界的关键选择。\n\n不适用场景：能通过读取、搜索或测试自行查明；问题琐碎；已有足够信息继续工作；只是汇报进度；询问用户是否进入计划模式，此时必须调用 enter_plan。\n\n重要：这是独立暂停工具，必须单独调用。Agent 必须提供二至四个简短选项，不要自行创建文本题，也不要传入“其他”选项、界面文案、布局或颜色。",
    inputSchema: objectSchema({
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: objectSchema({
          id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$", description: "问题的唯一稳定标识符" },
          question: { type: "string", minLength: 1, maxLength: 120, description: "用户看到的完整问题" },
          type: { type: "string", enum: ["single_choice", "multiple_choice"] },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: objectSchema({
              id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$" },
              title: { type: "string", minLength: 1, maxLength: 40 },
              description: { type: "string", maxLength: 120 },
              recommended: { type: "boolean" }
            }, ["id", "title"])
          },
          minSelections: { type: "integer", minimum: 1 },
          maxSelections: { type: "integer", minimum: 1 },
          placeholder: { type: "string", maxLength: 80 },
          multiline: { type: "boolean" }
        }, ["id", "question", "type"]),
        description: "一至三个真正阻塞后续工作的关键问题。"
      }
    }, ["questions"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "notable",
      action: "plan",
      targetKind: "plan",
      resolveTarget: () => "plan questions"
    }
  },
  {
    // 提交实施方案
    name: "submit_plan",
    description: "以 Markdown 提交一份可直接决策的完整实施计划供用户审阅。提交后 Run 会暂停并等待用户决定，绝不能自行开始实施。\n\n适用场景：在计划模式中，方案已经可直接决策，所有关键选择均已确定且没有待确认问题；ask_user 轮次已经结束，可以提交审批。\n\n不适用场景：仍有待确认问题，应先使用 ask_user；当前处于工作模式，应直接执行；任务足够简单，不需要计划。\n\n重要：这是独立控制工具。计划必须是完整、可执行的 Markdown 文档，不能只是模糊提纲；应包含改动内容、原因、文件级步骤、风险和验证命令。\n\n示例：\n  submit_plan(title=\"增加 JWT 身份认证\", markdown=\"## 目标\\n使用 JWT 保护 API...\\n## 步骤\\n1. 安装 jsonwebtoken\\n2. 创建认证中间件\\n3. 增加登录路由\\n## 验证\\n- npm test\\n- curl localhost:3000/login\")",
    inputSchema: objectSchema({
      title: { type: "string", description: "计划的简短标题，例如“使用 JWT 增加用户认证”" },
      markdown: { type: "string", description: "完整的 Markdown 计划正文，应包含目标、方案、文件级步骤、风险和验证方式" }
    }, ["title", "markdown"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "notable",
      action: "plan",
      targetKind: "plan",
      resolveTarget: () => "implementation plan"
    }
  },
  {
    // 执行期任务清单(对标 Claude Code TodoWrite / Codex update_plan)
    name: "update_tasks",
    description: "创建或替换当前 Run 的执行任务列表。这是整体任务清单、当前任务以及 pending、running、completed、blocked 状态的唯一维护渠道。调用本工具后，界面会将任务进度直接呈现给用户；不要在调用工具时的回答内容中再次汇报任务计划进度，也不要重复播报任务完成、当前任务、下一任务、阶段切换或执行批次。\n\n适用场景：任务包含三个或更多跨文件、跨阶段的独立步骤，例如“在代码库中重命名符号”可拆为读取用法、修改导入、修改调用点和运行类型检查；希望在工作过程中向用户展示进度；复杂缺陷修复包含多个调查步骤。\n\n不适用场景：简单问答或单文件编辑，应直接完成；只有一至两个步骤；当前处于计划模式，应使用 submit_plan。\n\n重要：本工具不是独占控制工具，可以与读取、搜索、编辑、命令或验证工具放在同一个 tool_calls 中。复杂任务开始时调用 update_tasks 列出步骤，状态变化时提交包含全部步骤的完整列表。任何时刻必须只保留一个 'running' 任务；已经完成的步骤保留为 'completed'，受阻步骤标记为 'blocked'。如果已经建立任务清单，所有工作和验证结束后，必须在最后一个工作工具调用之后再次调用本工具，提交不含 pending 或 running 的最终完整列表；与最后一批工作工具一起调用时，应把 update_tasks 放在这些工具之后。同一响应不要输出面向用户的最终回答；收到工具结果后的下一轮再给出最终回答。本工具不用于计划审批。\n\n示例，为“增加深色模式”建立高质量任务列表：\n  update_tasks(tasks=[\n    {taskId:'t1', label:'读取现有主题系统', status:'running'},\n    {taskId:'t2', label:'增加深色调色板 CSS 变量', status:'pending'},\n    {taskId:'t3', label:'在设置中接入主题开关', status:'pending'},\n    {taskId:'t4', label:'通过构建和手动检查验证', status:'pending'}\n  ])",
    inputSchema: objectSchema(
      {
        tasks: {
          type: "array",
          minItems: 1,
          items: objectSchema(
            {
              label: { type: "string", description: "用户可读的任务步骤说明" },
              status: { type: "string", enum: ["pending", "running", "completed", "blocked"], description: "当前状态：'pending' 尚未开始，'running' 正在进行且必须只保留一个，'completed' 已完成，'blocked' 受阻" },
              taskId: { type: "string", description: "任务的唯一标识符" }
            },
            ["taskId", "label", "status"]
          ),
          description: "完整任务列表，会替换先前列表。必须包含全部步骤，而不只是发生变化的步骤。"
        }
      },
      ["tasks"]
    ),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "routine",
      action: "task",
      targetKind: "task",
      resolveTarget: () => "execution tasks"
    }
  },
  {
    // 子代理委派：创建独立 Session/Run，结果通过 Runtime 信封异步回传。
    name: "delegate",
    description: "把一个自包含任务委派给独立子代理。子代理拥有独立系统提示词、工具白名单和会话上下文，看不到父对话。工具立即返回子会话标识；子代理终态结果稍后自动进入当前上下文，父运行在读取结果前不会结束。\n\n适用场景：需要大范围只读调查（在多个目录/命名约定里找东西、只需结论不需文件转储）时委派 explorer 并行 fan-out；需要把一段有明确边界的实现交给隔离工作区执行时委派 worker。同一步可以并行发起多个委派，每个父运行最多 4 个，是扩大并行度的主手段。\n\n不适用场景：单一明确的小改动，直接自己做更快（委派有独立会话开销）；需要跨多步骤持续交互的任务；子代理不能继续委派（深度为 1，无递归）。\n\n角色选型：agent='explorer' 只调查和读取，不能写文件、不能跑命令——适合搜索、定位、汇总 file:line 结论；agent='worker' 可修改并验证工作区（近似 full_access）——适合执行已明确的改动并自验证。选择时优先 explorer（零副作用），只有确需写入或跑验证命令时才用 worker。\n\n重要：给子代理的 message 必须完整自包含（含文件路径和足够上下文），因为子代理看不到本对话。\n\n示例：\n  delegate(agent='explorer', message='检查路由注册与对应测试，报告 file:line 和结论。')\n  # 并行 fan-out（同一条消息里多个 delegate）：\n  #   delegate(agent='explorer', message='查 auth 模块的所有导出'),\n  #   delegate(agent='explorer', message='查订单模块的测试覆盖')",
    inputSchema: objectSchema({
      agent: { type: "string", enum: ["explorer", "worker"], description: "要使用的内置子代理" },
      message: { type: "string", description: "给子代理的完整、自包含用户消息" }
    }, ["agent", "message"]),
    presentation: {
      groupMode: "standalone",
      detail: COLLAPSED_RAW_DETAIL,
      effect: "control_only",
      importance: "notable",
      action: "execute",
      targetKind: "workspace",
      resolveTarget: (args) => `${String(args.agent ?? "agent")}: ${String(args.message ?? "").slice(0, 80)}`
    }
  }
];

export const toolSpecs: ToolSpec[] = toolRegistry.map(
  ({ description, inputSchema, name }) => ({ description, inputSchema, name })
);
