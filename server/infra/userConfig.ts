import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// ADR-009: 用户配置统一为 ~/.deepseeker/config.json
//
// 不再使用 .env.local / 环境变量。配置全部通过结构化 JSON 管理。
// 对标 Claude Code 的 ~/.claude/settings.json。
// ─────────────────────────────────────────────────────────────────────────────

export type UserConfig = {
  /** DeepSeek API key。为空时自动降级到 mock 模式。 */
  apiKey: string;
  /** 智谱 GLM API key。为空时 GLM 模型不可用。 */
  zhipuApiKey: string;
  /** 默认模型。 */
  model: string;
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
  permissions: { allow: [], deny: [] }
};

function configPath(): string {
  return path.join(homedir(), ".deepseeker", "config.json");
}

/**
 * 加载用户配置。如果 config.json 不存在,返回默认值。
 * 不会抛异常——解析失败时回退到默认值。
 */
export function loadUserConfig(): UserConfig {
  const file = configPath();
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<UserConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * 确保 ~/.deepseeker/config.json 存在。首次运行时创建模板。
 * 如果已存在则不覆盖。
 */
export function ensureUserConfig(): void {
  const file = configPath();
  if (existsSync(file)) return;
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
}
