import {
  ThemeImportInput,
  ThemePack,
  ThemePreference,
  ThemeSummary,
  WindowChromeTheme
} from "./theme";
import { ModelProtocol } from "./provider";
import {
  SkillInstallInput,
  SkillInstallPreview,
  SkillSummary,
  SkillTargetInput
} from "./skill";

export type RuntimePhase = "starting" | "ready" | "restarting" | "stopped" | "failed";

export type RuntimeConnection = {
  baseUrl: string;
  phase: RuntimePhase;
  token: string;
};

export type RuntimeState = {
  connection?: RuntimeConnection;
  detail?: string;
  phase: RuntimePhase;
};

export type ProjectRef = {
  lastOpenedAt: string;
  name: string;
  path: string;
  pinned?: boolean;
};

export type DesktopSettings = {
  defaultModel: string;
  hasApiKey: boolean;
  hasZhipuApiKey: boolean;
  modelProtocols: Record<string, ModelProtocol>;
};

export type DesktopSettingsInput = {
  apiKey?: string;
  defaultModel: string;
  zhipuApiKey?: string;
  modelProtocols?: Record<string, ModelProtocol>;
};

export type DesktopSettingsSaveResult = {
  connection: RuntimeConnection;
  settings: DesktopSettings;
};

export type DesktopBridge = {
  appearance: {
    applyChrome: (theme: WindowChromeTheme) => Promise<void>;
    read: () => Promise<ThemePreference>;
    save: (preference: ThemePreference) => Promise<ThemePreference>;
  };
  files: {
    openExternal: (url: string) => Promise<void>;
    reveal: (filePath: string) => Promise<void>;
  };
  projects: {
    activate: (projectPath: string) => Promise<ProjectRef[]>;
    open: (projectPath: string) => Promise<void>;
    pick: () => Promise<ProjectRef | null>;
    pin: (projectPath: string, pinned: boolean) => Promise<ProjectRef[]>;
    recent: () => Promise<ProjectRef[]>;
    remove: (projectPath: string) => Promise<ProjectRef[]>;
    rename: (projectPath: string, name: string) => Promise<ProjectRef[]>;
  };
  runtime: {
    connection: () => Promise<RuntimeConnection>;
    onState: (listener: (state: RuntimeState) => void) => () => void;
    retry: () => Promise<RuntimeConnection>;
  };
  settings: {
    read: () => Promise<DesktopSettings>;
    save: (input: DesktopSettingsInput) => Promise<DesktopSettingsSaveResult>;
  };
  skills: {
    checkUpdates: (projectRoot?: string) => Promise<SkillSummary[]>;
    install: (input: SkillInstallInput) => Promise<SkillSummary[]>;
    list: (projectRoot?: string) => Promise<SkillSummary[]>;
    previewGitHub: (url: string) => Promise<SkillInstallPreview>;
    previewLocal: () => Promise<SkillInstallPreview | null>;
    remove: (input: SkillTargetInput) => Promise<SkillSummary[]>;
    setEnabled: (input: SkillTargetInput & { enabled: boolean }) => Promise<SkillSummary[]>;
    update: (input: SkillTargetInput) => Promise<SkillInstallPreview>;
  };
  themes: {
    exportFile: (themeId: string) => Promise<boolean>;
    get: (themeId: string) => Promise<ThemePack | null>;
    importFile: (input: ThemeImportInput) => Promise<ThemePack | null>;
    list: () => Promise<ThemeSummary[]>;
    remove: (themeId: string) => Promise<ThemeSummary[]>;
    save: (theme: ThemePack) => Promise<ThemePack>;
  };
};
