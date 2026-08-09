import { app, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LocalProfileAvatar, LocalProfileInput } from "../shared/contracts/auth";
import { DesktopSettings, DesktopSettingsInput, ProjectRef } from "../shared/contracts/desktop";
import { ModelProtocol } from "../shared/contracts/provider";
import { ThemePreference } from "../shared/contracts/theme";
import { DEFAULT_THEME_PREFERENCE, normalizeThemePreference } from "../shared/themeCatalog";
import { loadUserConfig } from "../server/infra/userConfig";

type WindowBounds = { height: number; width: number; x?: number; y?: number };
type DeviceState = {
  appearance: ThemePreference;
  legacyApiKey?: string;
  legacyDefaultModel?: string;
  legacyRecentProjects?: ProjectRef[];
  localProfileId?: string;
  localProfileSetupComplete?: boolean;
  profileMigrationOwner?: string;
  window?: WindowBounds;
};
type ProfileState = {
  apiKey?: string;
  defaultModel: string;
  modelProtocols: Record<string, ModelProtocol>;
  recentProjects: ProjectRef[];
  localAvatar?: LocalProfileAvatar;
  localDisplayName?: string;
  zhipuApiKey?: string;
};

const defaultModel = "deepseek-v4-flash";
const deviceDefaults: DeviceState = { appearance: DEFAULT_THEME_PREFERENCE };
const profileDefaults: ProfileState = {
  defaultModel,
  modelProtocols: { [defaultModel]: "responses" },
  recentProjects: []
};
const userIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const localAvatars = new Set<LocalProfileAvatar>(["amber", "blue", "green", "slate"]);

function decrypt(value?: string): string {
  if (!value || !safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch {
    return "";
  }
}

function encrypt(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统加密存储当前不可用，凭据未保存。");
  return safeStorage.encryptString(normalized).toString("base64");
}

export class DesktopStore {
  private activeProfile?: { directory: string; filePath: string; id: string; state: ProfileState };
  private device: DeviceState;
  private readonly deviceFile: string;

  constructor() {
    this.deviceFile = path.join(app.getPath("userData"), "desktop.json");
    this.device = this.readDevice();
  }

  activateProfile(userId: string, options: { claimLegacy?: boolean } = {}): void {
    if (!userIdPattern.test(userId)) throw new Error("账号标识无效。");
    const directory = path.join(app.getPath("userData"), "profiles", userId.toLowerCase());
    const filePath = path.join(directory, "profile.json");
    mkdirSync(directory, { recursive: true });
    let state = this.readProfile(filePath);
    const claimingLegacy = options.claimLegacy !== false && !this.device.profileMigrationOwner;
    if (!state) {
      state = claimingLegacy ? this.legacyProfile() : structuredClone(profileDefaults);
      this.writeProfile(filePath, state);
    }
    if (claimingLegacy) {
      this.copyLegacyRuntime(directory);
      this.device.profileMigrationOwner = userId.toLowerCase();
      this.writeDevice();
    }
    this.activeProfile = { directory, filePath, id: userId.toLowerCase(), state };
  }

  deactivateProfile(): void {
    this.activeProfile = undefined;
  }

  activeProfileDirectory(): string {
    if (!this.activeProfile) throw new Error("DeepCreator Profile 尚未准备好。");
    return this.activeProfile.directory;
  }

  activeProfileId(): string | undefined {
    return this.activeProfile?.id;
  }

  localProfileId(): string {
    if (this.device.localProfileId && userIdPattern.test(this.device.localProfileId)) {
      if (this.device.localProfileSetupComplete === undefined) {
        this.device.localProfileSetupComplete = Boolean(this.device.profileMigrationOwner);
        this.writeDevice();
      }
      return this.device.localProfileId;
    }
    const migratedProfile = this.device.profileMigrationOwner;
    this.device.localProfileId = migratedProfile && userIdPattern.test(migratedProfile)
      ? migratedProfile.toLowerCase()
      : randomUUID();
    this.device.localProfileSetupComplete = Boolean(migratedProfile && userIdPattern.test(migratedProfile));
    this.writeDevice();
    return this.device.localProfileId;
  }

  localProfile(): LocalProfileInput {
    const profile = this.requireProfile();
    return {
      avatar: profile.state.localAvatar && localAvatars.has(profile.state.localAvatar) ? profile.state.localAvatar : "blue",
      displayName: profile.state.localDisplayName?.trim() || "本地 Profile"
    };
  }

  localProfileSetupRequired(): boolean {
    return this.device.localProfileSetupComplete !== true;
  }

  saveLocalProfile(input: LocalProfileInput): LocalProfileInput {
    const profile = this.requireProfile();
    const displayName = typeof input?.displayName === "string" ? input.displayName.trim() : "";
    if (!displayName) throw new Error("请输入 Profile 名称。");
    if (displayName.length > 30) throw new Error("Profile 名称不能超过 30 个字符。");
    if ([...displayName].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })) throw new Error("Profile 名称不能包含控制字符。");
    if (!localAvatars.has(input.avatar)) throw new Error("请选择有效的 Profile 头像。");
    profile.state.localAvatar = input.avatar;
    profile.state.localDisplayName = displayName;
    this.writeActiveProfile();
    this.device.localProfileSetupComplete = true;
    this.writeDevice();
    return { avatar: input.avatar, displayName };
  }

  apiKey(): string {
    return decrypt(this.requireProfile().state.apiKey);
  }

  zhipuApiKey(): string {
    return decrypt(this.requireProfile().state.zhipuApiKey);
  }

  addProject(projectPath: string): ProjectRef {
    const profile = this.requireProfile();
    const resolved = path.resolve(projectPath);
    const existing = profile.state.recentProjects.find((item) => item.path === resolved);
    const project = {
      lastOpenedAt: new Date().toISOString(),
      name: existing?.name ?? path.basename(resolved),
      path: resolved,
      pinned: existing?.pinned
    };
    profile.state.recentProjects = [project, ...profile.state.recentProjects.filter((item) => item.path !== resolved)].slice(0, 20);
    this.writeActiveProfile();
    return project;
  }

  recentProjects(): ProjectRef[] {
    if (!this.activeProfile) return [];
    return this.activeProfile.state.recentProjects
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
    const profile = this.requireProfile();
    const resolved = path.resolve(projectPath);
    profile.state.recentProjects = profile.state.recentProjects.filter((project) => project.path !== resolved);
    this.writeActiveProfile();
    return this.recentProjects();
  }

  settings(): DesktopSettings {
    const state = this.requireProfile().state;
    return {
      defaultModel: state.defaultModel,
      hasApiKey: Boolean(this.apiKey()),
      hasZhipuApiKey: Boolean(this.zhipuApiKey()),
      modelProtocols: { ...state.modelProtocols }
    };
  }

  appearance(): ThemePreference {
    return structuredClone(this.device.appearance);
  }

  saveAppearance(preference: ThemePreference): ThemePreference {
    this.device.appearance = {
      codeThemeId: preference.codeThemeId?.trim() || undefined,
      mode: preference.mode === "dark" || preference.mode === "light" ? preference.mode : "system",
      themeId: preference.themeId.trim() || DEFAULT_THEME_PREFERENCE.themeId
    };
    this.writeDevice();
    return this.appearance();
  }

  saveSettings(input: DesktopSettingsInput): DesktopSettings {
    const profile = this.requireProfile();
    profile.state.defaultModel = input.defaultModel.trim() || defaultModel;
    if (input.apiKey !== undefined) profile.state.apiKey = encrypt(input.apiKey);
    if (input.zhipuApiKey !== undefined) profile.state.zhipuApiKey = encrypt(input.zhipuApiKey);
    if (input.modelProtocols) profile.state.modelProtocols = { ...input.modelProtocols };
    this.writeActiveProfile();
    return this.settings();
  }

  windowBounds(): WindowBounds | undefined {
    return this.device.window;
  }

  saveWindowBounds(bounds: WindowBounds): void {
    this.device.window = bounds;
    this.writeDevice();
  }

  private copyLegacyRuntime(profileDirectory: string): void {
    const source = path.join(app.getPath("userData"), "runtime");
    const target = path.join(profileDirectory, "runtime");
    if (!existsSync(source) || existsSync(target)) return;
    const temporary = path.join(profileDirectory, `.runtime-migration-${process.pid}`);
    rmSync(temporary, { force: true, recursive: true });
    try {
      cpSync(source, temporary, { errorOnExist: true, force: false, recursive: true });
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true, recursive: true });
      throw error;
    }
  }

  private legacyProfile(): ProfileState {
    const config = loadUserConfig();
    const canEncrypt = safeStorage.isEncryptionAvailable();
    return {
      apiKey: this.device.legacyApiKey || (canEncrypt ? encrypt(config.apiKey) : undefined),
      defaultModel: config.model || this.device.legacyDefaultModel || defaultModel,
      modelProtocols: { ...config.modelProtocols },
      recentProjects: [...(this.device.legacyRecentProjects ?? [])],
      zhipuApiKey: canEncrypt ? encrypt(config.zhipuApiKey) : undefined
    };
  }

  private readDevice(): DeviceState {
    try {
      if (!existsSync(this.deviceFile)) return structuredClone(deviceDefaults);
      const parsed = JSON.parse(readFileSync(this.deviceFile, "utf8")) as Record<string, unknown>;
      return {
        appearance: normalizeThemePreference(parsed.appearance),
        legacyApiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
        legacyDefaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : undefined,
        legacyRecentProjects: Array.isArray(parsed.recentProjects) ? parsed.recentProjects as ProjectRef[] : [],
        localProfileId: typeof parsed.localProfileId === "string" && userIdPattern.test(parsed.localProfileId)
          ? parsed.localProfileId.toLowerCase()
          : undefined,
        localProfileSetupComplete: typeof parsed.localProfileSetupComplete === "boolean" ? parsed.localProfileSetupComplete : undefined,
        profileMigrationOwner: typeof parsed.profileMigrationOwner === "string" ? parsed.profileMigrationOwner : undefined,
        window: parsed.window as WindowBounds | undefined
      };
    } catch {
      return structuredClone(deviceDefaults);
    }
  }

  private readProfile(filePath: string): ProfileState | undefined {
    try {
      if (!existsSync(filePath)) return undefined;
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ProfileState>;
      return {
        apiKey: parsed.apiKey,
        defaultModel: parsed.defaultModel || defaultModel,
        modelProtocols: parsed.modelProtocols && typeof parsed.modelProtocols === "object" ? parsed.modelProtocols : { ...profileDefaults.modelProtocols },
        recentProjects: Array.isArray(parsed.recentProjects) ? parsed.recentProjects : [],
        localAvatar: typeof parsed.localAvatar === "string" && localAvatars.has(parsed.localAvatar as LocalProfileAvatar)
          ? parsed.localAvatar as LocalProfileAvatar
          : undefined,
        localDisplayName: typeof parsed.localDisplayName === "string" ? parsed.localDisplayName : undefined,
        zhipuApiKey: parsed.zhipuApiKey
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`无法读取账号本机配置：${detail}`);
    }
  }

  private requireProfile(): NonNullable<DesktopStore["activeProfile"]> {
    if (!this.activeProfile) throw new Error("DeepCreator Profile 尚未准备好。");
    return this.activeProfile;
  }

  private updateProject(projectPath: string, update: (project: ProjectRef) => ProjectRef): void {
    const profile = this.requireProfile();
    const index = profile.state.recentProjects.findIndex((project) => project.path === projectPath);
    if (index < 0) throw new Error("项目不在最近项目列表中。");
    profile.state.recentProjects[index] = update(profile.state.recentProjects[index]);
    this.writeActiveProfile();
  }

  private writeActiveProfile(): void {
    const profile = this.requireProfile();
    this.writeProfile(profile.filePath, profile.state);
  }

  private writeDevice(): void {
    mkdirSync(path.dirname(this.deviceFile), { recursive: true });
    const serializable = {
      appearance: this.device.appearance,
      localProfileId: this.device.localProfileId,
      localProfileSetupComplete: this.device.localProfileSetupComplete,
      profileMigrationOwner: this.device.profileMigrationOwner,
      window: this.device.window
    };
    this.writeJson(this.deviceFile, serializable);
  }

  private writeProfile(filePath: string, state: ProfileState): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.writeJson(filePath, state);
  }

  private writeJson(filePath: string, value: unknown): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, filePath);
  }
}
