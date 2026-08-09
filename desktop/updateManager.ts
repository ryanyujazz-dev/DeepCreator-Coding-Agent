import { AppUpdateState } from "../shared/contracts/update";

export type NativeUpdateDownload = {
  releaseDate: Date;
  releaseName: string;
  releaseNotes: string;
};

export type NativeUpdateController = {
  checkForUpdates: () => void;
  onAvailable: (listener: () => void) => void;
  onChecking: (listener: () => void) => void;
  onDownloaded: (listener: (download: NativeUpdateDownload) => void) => void;
  onError: (listener: (error: Error) => void) => void;
  onNotAvailable: (listener: () => void) => void;
  quitAndInstall: () => void;
};

type UpdateManagerOptions = {
  configure: () => { stopUpdates: () => void };
  currentVersion: string;
  isPackaged: boolean;
  now?: () => Date;
  platform: string;
  prepareToInstall: () => Promise<void>;
  updater: NativeUpdateController;
};

type Listener = (state: AppUpdateState) => void;

function bounded(value: string, maximum: number): string {
  return value.trim().slice(0, maximum);
}

export class UpdateManager {
  private initialized = false;
  private readonly listeners = new Set<Listener>();
  private readonly now: () => Date;
  private state: AppUpdateState;
  private stopUpdates?: () => void;

  constructor(private readonly options: UpdateManagerOptions) {
    const supported = options.isPackaged && (options.platform === "darwin" || options.platform === "win32");
    this.now = options.now ?? (() => new Date());
    this.state = {
      currentVersion: options.currentVersion,
      detail: supported ? undefined : options.isPackaged ? "当前系统暂不支持应用内更新。" : "开发版本不连接发布更新服务。",
      phase: supported ? "idle" : "unsupported",
      supported
    };
  }

  getState(): AppUpdateState {
    return { ...this.state };
  }

  initialize(): AppUpdateState {
    if (this.initialized || !this.state.supported) return this.getState();
    this.initialized = true;
    const updater = this.options.updater;
    updater.onChecking(() => this.transition({ detail: undefined, phase: "checking" }));
    updater.onAvailable(() => this.transition({ detail: undefined, phase: "downloading" }));
    updater.onNotAvailable(() => this.transition({
      availableVersion: undefined,
      checkedAt: this.now().toISOString(),
      detail: undefined,
      phase: "current",
      releaseDate: undefined,
      releaseNotes: undefined
    }));
    updater.onDownloaded((download) => {
      this.stopUpdates?.();
      this.stopUpdates = undefined;
      this.transition({
        availableVersion: bounded(download.releaseName, 200) || "新版本",
        checkedAt: this.now().toISOString(),
        detail: undefined,
        phase: "ready",
        releaseDate: download.releaseDate.toISOString(),
        releaseNotes: bounded(download.releaseNotes, 4_000)
      });
    });
    updater.onError((error) => {
      if (this.state.phase === "ready" || this.state.phase === "installing") return;
      this.transition({
        checkedAt: this.now().toISOString(),
        detail: bounded(error.message || "检查更新失败。", 1_000),
        phase: "error"
      });
    });
    try {
      const controller = this.options.configure();
      this.stopUpdates = controller.stopUpdates;
    } catch (error) {
      this.transition({
        checkedAt: this.now().toISOString(),
        detail: bounded(error instanceof Error ? error.message : String(error), 1_000),
        phase: "error"
      });
    }
    return this.getState();
  }

  check(): AppUpdateState {
    if (!this.state.supported) return this.getState();
    if (["checking", "downloading", "ready", "installing"].includes(this.state.phase)) return this.getState();
    this.transition({ detail: undefined, phase: "checking" });
    try {
      this.options.updater.checkForUpdates();
    } catch (error) {
      this.transition({
        checkedAt: this.now().toISOString(),
        detail: bounded(error instanceof Error ? error.message : String(error), 1_000),
        phase: "error"
      });
    }
    return this.getState();
  }

  async install(): Promise<AppUpdateState> {
    if (this.state.phase !== "ready") throw new Error("更新尚未下载完成。");
    this.transition({ detail: undefined, phase: "installing" });
    try {
      await this.options.prepareToInstall();
      this.options.updater.quitAndInstall();
      return this.getState();
    } catch (error) {
      this.transition({
        detail: bounded(error instanceof Error ? error.message : String(error), 1_000),
        phase: "error"
      });
      throw error;
    }
  }

  onState(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.stopUpdates?.();
    this.stopUpdates = undefined;
    this.listeners.clear();
  }

  private transition(patch: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }
}
