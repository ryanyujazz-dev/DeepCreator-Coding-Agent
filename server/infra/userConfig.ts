import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ModelProtocol } from "../../shared/contracts/provider";

// ─────────────────────────────────────────────────────────────────────────────
// ADR-009: 普通用户配置统一为 ~/.deepcreator/config.json
//
// 不再读取项目内的 .env.local。桌面端历史 DeepSeek 密钥仍可由
// safeStorage 兼容解析，Runtime 环境变量只承担宿主到 worker 的进程传递。
// ─────────────────────────────────────────────────────────────────────────────

export type UserConfig = {
  /** DeepSeek API key。为空时自动降级到 mock 模式。 */
  apiKey: string;
  /** 智谱 GLM API key。为空时 GLM 模型不可用。 */
  zhipuApiKey: string;
  /** 默认模型。 */
  model: string;
  /** Per-model transport protocol overrides. */
  modelProtocols: Record<string, ModelProtocol>;
  /** 上下文窗口 token 数。 */
  contextWindowTokens: number;
  /** 用户语言环境(如 zh-CN、en-US)。 */
  locale: string;
  /** 跨会话权限规则(对标 Claude Code settings.local.json 的 allow/deny)。 */
  permissions?: PermissionRules;
};

/** 权限规则——持久化的 allow/deny 列表,跨会话生效。 */
export type PermissionRules = {
  /** 允许的工具调用模式(不再弹出审批)。 */
  allow?: string[];
  /** 拒绝的工具调用模式(自动拒绝)。 */
  deny?: string[];
};

const DEFAULT_CONFIG: UserConfig = {
  apiKey: "",
  zhipuApiKey: "",
  contextWindowTokens: 1_000_000,
  locale: "en-US",
  model: "deepseek-v4-flash",
  modelProtocols: { "deepseek-v4-flash": "responses" },
  permissions: { allow: [], deny: [] }
};

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串。`);
  return value;
}

export function parseUserConfig(raw: string): UserConfig {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("配置根节点必须是对象。");
  const input = parsed as Record<string, unknown>;
  const contextWindowTokens = input.contextWindowTokens ?? DEFAULT_CONFIG.contextWindowTokens;
  if (!Number.isSafeInteger(contextWindowTokens) || Number(contextWindowTokens) <= 0) {
    throw new Error("contextWindowTokens 必须是正整数。");
  }
  let permissions = DEFAULT_CONFIG.permissions;
  let modelProtocols = { ...DEFAULT_CONFIG.modelProtocols };
  if (input.modelProtocols !== undefined) {
    if (!input.modelProtocols || typeof input.modelProtocols !== "object" || Array.isArray(input.modelProtocols)) {
      throw new Error("modelProtocols 必须是对象。");
    }
    modelProtocols = {};
    for (const [model, protocol] of Object.entries(input.modelProtocols as Record<string, unknown>)) {
      if (protocol !== "chat" && protocol !== "responses") throw new Error(`modelProtocols.${model} 必须是 chat 或 responses。`);
      modelProtocols[model] = protocol;
    }
  }
  if (input.permissions !== undefined) {
    if (!input.permissions || typeof input.permissions !== "object" || Array.isArray(input.permissions)) {
      throw new Error("permissions 必须是对象。");
    }
    const candidate = input.permissions as Record<string, unknown>;
    for (const field of ["allow", "deny"] as const) {
      if (candidate[field] !== undefined && (!Array.isArray(candidate[field]) || !candidate[field].every((item) => typeof item === "string"))) {
        throw new Error(`permissions.${field} 必须是字符串数组。`);
      }
    }
    permissions = {
      allow: candidate.allow as string[] | undefined,
      deny: candidate.deny as string[] | undefined
    };
  }
  return {
    apiKey: optionalString(input.apiKey, "apiKey") ?? DEFAULT_CONFIG.apiKey,
    contextWindowTokens: Number(contextWindowTokens),
    locale: optionalString(input.locale, "locale") ?? DEFAULT_CONFIG.locale,
    model: optionalString(input.model, "model") ?? DEFAULT_CONFIG.model,
    modelProtocols,
    permissions,
    zhipuApiKey: optionalString(input.zhipuApiKey, "zhipuApiKey") ?? DEFAULT_CONFIG.zhipuApiKey
  };
}

function configPath(): string {
  return path.join(homedir(), ".deepcreator", "config.json");
}

function previousConfigPath(): string {
  return path.join(homedir(), ".deepseeker", "config.json");
}

/**
 * 加载用户配置。如果 config.json 不存在，返回默认值。
 * 已存在但损坏的配置必须显式报错，避免后续保存用默认值覆盖原文件。
 */
export function loadUserConfig(): UserConfig {
  const file = configPath();
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  try {
    return parseUserConfig(readFileSync(file, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取用户配置 ${file}：${detail}`, { cause: error });
  }
}

/**
 * 确保 ~/.deepcreator/config.json 存在。首次运行时创建模板。
 * 如果已存在则不覆盖。
 */
export function ensureUserConfig(): void {
  const file = configPath();
  if (existsSync(file)) return;
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const previous = previousConfigPath();
  if (existsSync(previous)) {
    writeFileSync(file, readFileSync(previous, "utf8"), { encoding: "utf8", mode: 0o600 });
    return;
  }
  writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
}

/** 配置文件路径(用于 UI 显示/诊断)。 */
export function userConfigPath(): string {
  return configPath();
}

// ─────────────────────────────────────────────────────────────────────────────
// 权限规则匹配与持久化(跨会话 allow/deny)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 检查工具调用是否匹配持久化权限规则。
 * 返回 "allow"(自动放行)、"deny"(自动拒绝)或 undefined(需弹审批)。
 * 规则格式:"<toolName>:<target>" 或 "<toolName>:*" 或 "*:<target>"
 */
export function checkPersistentPermission(toolName: string, target: string, rules?: PermissionRules): "allow" | "deny" | undefined {
  if (!rules) return undefined;
  const patterns = [`${toolName}:${target}`, `${toolName}:*`, `*:${target}`, "*:*"];
  if (rules.deny?.some((rule) => patterns.includes(rule) || matchPattern(rule, toolName, target))) return "deny";
  if (rules.allow?.some((rule) => patterns.includes(rule) || matchPattern(rule, toolName, target))) return "allow";
  return undefined;
}

function matchPattern(rule: string, toolName: string, target: string): boolean {
  const [ruleTool, ruleTarget] = rule.split(":");
  const toolOk = ruleTool === "*" || ruleTool === toolName;
  const targetOk = ruleTarget === "*" || ruleTarget === target;
  return toolOk && targetOk;
}

/**
 * 追加一条 allow 规则到 config.json 并持久化。
 * 用户审批时选择 "allow_session" 或 "allow_run" 时可调用此方法升级为持久化。
 */
export function addAllowRule(rule: string): void {
  const config = loadUserConfig();
  if (!config.permissions) config.permissions = { allow: [], deny: [] };
  if (!config.permissions.allow?.includes(rule)) {
    config.permissions.allow = [...(config.permissions.allow ?? []), rule];
    saveUserConfig(config);
  }
}

/**
 * 追加一条 deny 规则到 config.json 并持久化。
 */
export function addDenyRule(rule: string): void {
  const config = loadUserConfig();
  if (!config.permissions) config.permissions = { allow: [], deny: [] };
  if (!config.permissions.deny?.includes(rule)) {
    config.permissions.deny = [...(config.permissions.deny ?? []), rule];
    saveUserConfig(config);
  }
}

/** 保存配置(覆盖写入)。 */
export function saveUserConfig(config: UserConfig): void {
  const file = configPath();
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
