import { app, safeStorage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DesktopSettings, DesktopSettingsInput, ProjectRef } from "../shared/contracts/desktop";
import { ThemePreference } from "../shared/contracts/theme";
import { DEFAULT_THEME_PREFERENCE, normalizeThemePreference } from "../shared/themeCatalog";
import { loadUserConfig, saveUserConfig } from "../server/infra/userConfig";

type WindowBounds = { height: number; width: number; x?: number; y?: number };
type StoredDesktopState = {
  apiKey?: string;
  appearance: ThemePreference;
  defaultModel: string;
  recentProjects: ProjectRef[];
  window?: WindowBounds;
};

const defaults: StoredDesktopState = {
  appearance: DEFAULT_THEME_PREFERENCE,
  defaultModel: "deepseek-v4-flash",
  recentProjects: []
};

export class DesktopStore {
  private state: StoredDesktopState;
  private readonly filePath: string;

  constructor() {
    this.filePath = path.join(app.getPath("userData"), "desktop.json");
    this.state = this.read();
  }

  apiKey(): string {
    // ADR-009: 优先从 ~/.deepseeker/config.json 读取
    const configKey = loadUserConfig().apiKey;
    if (configKey) return configKey;
    // 降级:Electron safeStorage(旧版 UI 输入的 key)
    if (this.state.apiKey && safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(this.state.apiKey, "base64"));
      } catch { /* fall through */ }
    }
    return "";
  }

  zhipuApiKey(): string {
    return loadUserConfig().zhipuApiKey;
  }

  addProject(projectPath: string): ProjectRef {
    const resolved = path.resolve(projectPath);
    const existing = this.state.recentProjects.find((item) => item.path === resolved);
    const project = {
      lastOpenedAt: new Date().toISOString(),
      name: existing?.name ?? path.basename(resolved),
      path: resolved,
      pinned: existing?.pinned
    };
    this.state.recentProjects = [project, ...this.state.recentProjects.filter((item) => item.path !== resolved)].slice(0, 20);
    this.write();
    return project;
  }

  recentProjects(): ProjectRef[] {
    return this.state.recentProjects
      .filter((project) => existsSync(project.path))
      .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || right.lastOpenedAt.localeCompare(left.lastOpenedAt));
  }

  renameProject(projectPath: string, name: string): ProjectRef[] {
    const resolved = path.resolve(projectPath);
    const nextName = name.trim();
    if (!nextName) throw new Error("项目名称不能为空。");
    if (nextName.length > 80) throw new Error("项目名称不能超过 80 个字符。");
    this.updateProject(resolved, (project) => ({ ...project, name: nextName }));
    return this.recentProjects();
  }

  pinProject(projectPath: string, pinned: boolean): ProjectRef[] {
    const resolved = path.resolve(projectPath);
    this.updateProject(resolved, (project) => ({ ...project, pinned }));
    return this.recentProjects();
  }

  removeProject(projectPath: string): ProjectRef[] {
    const resolved = path.resolve(projectPath);
    this.state.recentProjects = this.state.recentProjects.filter((project) => project.path !== resolved);
    this.write();
    return this.recentProjects();
  }

  settings(): DesktopSettings {
    const config = loadUserConfig();
    return {
      defaultModel: config.model || this.state.defaultModel,
      hasApiKey: Boolean(this.apiKey()),
      hasZhipuApiKey: Boolean(config.zhipuApiKey)
    };
  }

  appearance(): ThemePreference {
    return structuredClone(this.state.appearance);
  }

  saveAppearance(preference: ThemePreference): ThemePreference {
    this.state.appearance = {
      codeThemeId: preference.codeThemeId?.trim() || undefined,
      mode: preference.mode === "dark" || preference.mode === "light" ? preference.mode : "system",
      themeId: preference.themeId.trim() || DEFAULT_THEME_PREFERENCE.themeId
    };
    this.write();
    return this.appearance();
  }

  saveSettings(input: DesktopSettingsInput): DesktopSettings {
    const defaultModel = input.defaultModel.trim() || defaults.defaultModel;
    this.state.defaultModel = defaultModel;
    if (input.apiKey !== undefined) {
      if (!input.apiKey.trim()) delete this.state.apiKey;
      else if (!safeStorage.isEncryptionAvailable()) throw new Error("系统加密存储当前不可用，API Key 未保存。");
      else this.state.apiKey = safeStorage.encryptString(input.apiKey.trim()).toString("base64");
    }
    // 普通设置统一写入 ~/.deepseeker/config.json；desktop.json 仅保留旧版本兼容字段。
    const config = loadUserConfig();
    config.model = defaultModel;
    if (input.zhipuApiKey !== undefined) config.zhipuApiKey = input.zhipuApiKey.trim();
    saveUserConfig(config);
    this.write();
    return this.settings();
  }

  windowBounds(): WindowBounds | undefined {
    return this.state.window;
  }

  saveWindowBounds(bounds: WindowBounds): void {
    this.state.window = bounds;
    this.write();
  }

  private read(): StoredDesktopState {
    try {
      if (!existsSync(this.filePath)) return structuredClone(defaults);
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoredDesktopState>;
      return {
        apiKey: parsed.apiKey,
        appearance: normalizeThemePreference(parsed.appearance),
        defaultModel: parsed.defaultModel || defaults.defaultModel,
        recentProjects: Array.isArray(parsed.recentProjects) ? parsed.recentProjects : [],
        window: parsed.window
      };
    } catch {
      return structuredClone(defaults);
    }
  }

  private write(): void {
    writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private updateProject(projectPath: string, update: (project: ProjectRef) => ProjectRef): void {
    const index = this.state.recentProjects.findIndex((project) => project.path === projectPath);
    if (index < 0) throw new Error("项目不在最近项目列表中。");
    this.state.recentProjects[index] = update(this.state.recentProjects[index]);
    this.write();
  }
}
