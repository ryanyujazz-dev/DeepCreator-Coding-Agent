import { app, utilityProcess, UtilityProcess } from "electron";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { RuntimeConnection, RuntimeState } from "../shared/contracts/desktop";
import { DesktopStore } from "./store";

type Listener = (state: RuntimeState) => void;
type WorkerMessage = { error?: string; port?: number; type: "ready" | "stopped" | "failed" };

export class RuntimeHost {
  private connectionValue?: RuntimeConnection;
  private intentionalStop = false;
  private listeners = new Set<Listener>();
  private process?: UtilityProcess;
  private restartCount = 0;
  private state: RuntimeState = { phase: "stopped" };
  private startPromise?: Promise<RuntimeConnection>;

  constructor(
    private readonly store: DesktopStore,
    private readonly frontendUrl: string
  ) {}

  connection(): Promise<RuntimeConnection> {
    return this.connectionValue ? Promise.resolve(this.connectionValue) : this.start();
  }

  currentState(): RuntimeState {
    return this.state;
  }

  onState(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async restart(): Promise<RuntimeConnection> {
    await this.stop();
    this.restartCount = 0;
    return this.start();
  }

  start(): Promise<RuntimeConnection> {
    if (this.connectionValue) return Promise.resolve(this.connectionValue);
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.spawn().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.intentionalStop = true;
    const child = this.process;
    this.process = undefined;
    this.connectionValue = undefined;
    if (!child) {
      this.setState({ phase: "stopped" });
      return;
    }
    child.postMessage({ type: "shutdown" });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 1_500);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    this.setState({ phase: "stopped" });
  }

  private prepareDataDirectory(): string {
    const target = path.join(app.getPath("userData"), "runtime");
    mkdirSync(target, { recursive: true });
    const legacy = path.join(app.getAppPath(), ".deepseeker");
    if (!existsSync(path.join(target, "runtime.sqlite")) && existsSync(path.join(legacy, "runtime.sqlite"))) {
      cpSync(legacy, target, { recursive: true, errorOnExist: false, force: false });
    }
    return target;
  }

  private async spawn(): Promise<RuntimeConnection> {
    this.intentionalStop = false;
    this.connectionValue = undefined;
    this.setState({ phase: this.restartCount > 0 ? "restarting" : "starting" });
    const token = randomBytes(32).toString("base64url");
    const migrations = app.isPackaged
      ? path.join(process.resourcesPath, "migrations")
      : path.join(app.getAppPath(), "server/infra/migrations");
    // 每次 spawn 时重新读 config,确保前端刚保存的 key/locale 能被 worker 拿到。
    const { loadUserConfig } = await import("../server/infra/userConfig");
    const userConfig = loadUserConfig();
    const child = utilityProcess.fork(path.join(__dirname, "runtime-worker.js"), [], {
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: this.store.apiKey(),
        DEEPSEEK_MODEL: this.store.settings().defaultModel,
        RUNTIME_AUTH_TOKEN: token,
        RUNTIME_DATA_DIR: this.prepareDataDirectory(),
        RUNTIME_FRONTEND_URL: this.frontendUrl,
        RUNTIME_MIGRATIONS_DIR: migrations,
        RUNTIME_WORKSPACE_ROOT: app.getPath("home"),
        DEEPSEEK_LOCALE: userConfig.locale
      },
      serviceName: "DeepSeeker Runtime",
      stdio: "pipe"
    });
    this.process = child;
    child.stdout?.on("data", (chunk) => process.stdout.write(`[runtime] ${chunk}`));
    child.stderr?.on("data", (chunk) => process.stderr.write(`[runtime] ${chunk}`));

    return new Promise<RuntimeConnection>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => fail(new Error("Runtime 启动超时。")), 15_000);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.setState({ detail: error.message, phase: "failed" });
        reject(error);
      };
      child.on("message", (message: WorkerMessage) => {
        if (message.type === "ready" && message.port) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.connectionValue = { baseUrl: `http://127.0.0.1:${message.port}`, phase: "ready", token };
          this.setState({ phase: "ready" });
          resolve(this.connectionValue);
        } else if (message.type === "failed") {
          fail(new Error(message.error || "Runtime 启动失败。"));
        }
      });
      child.once("exit", (_code) => {
        clearTimeout(timeout);
        this.process = undefined;
        this.connectionValue = undefined;
        if (!settled) fail(new Error("Runtime 在启动完成前退出。"));
        if (this.intentionalStop) return;
        if (this.restartCount < 1) {
          this.restartCount += 1;
          this.setState({ detail: "Runtime 意外退出，正在自动恢复。", phase: "restarting" });
          setTimeout(() => void this.start().catch(() => undefined), 1_000);
        } else {
          this.setState({ detail: "Runtime 再次退出，请手动重试。", phase: "failed" });
        }
      });
    });
  }

  private setState(state: RuntimeState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
