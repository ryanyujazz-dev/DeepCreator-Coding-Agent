export type RuntimePhase = "starting" | "ready" | "restarting" | "stopped" | "failed";

export type RuntimeConnection = {
  baseUrl: string;
  phase: RuntimePhase;
  token: string;
};

export type RuntimeState = {
  detail?: string;
  phase: RuntimePhase;
};

export type ProjectRef = {
  lastOpenedAt: string;
  name: string;
  path: string;
};

export type DesktopSettings = {
  defaultModel: string;
  hasApiKey: boolean;
};

export type DesktopSettingsInput = {
  apiKey?: string;
  defaultModel: string;
};

export type DesktopBridge = {
  files: {
    openExternal: (url: string) => Promise<void>;
    reveal: (filePath: string) => Promise<void>;
  };
  projects: {
    pick: () => Promise<ProjectRef | null>;
    recent: () => Promise<ProjectRef[]>;
  };
  runtime: {
    connection: () => Promise<RuntimeConnection>;
    onState: (listener: (state: RuntimeState) => void) => () => void;
    retry: () => Promise<RuntimeConnection>;
  };
  settings: {
    read: () => Promise<DesktopSettings>;
    save: (input: DesktopSettingsInput) => Promise<DesktopSettings>;
  };
};
