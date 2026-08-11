import { app } from "electron";
import { ChildProcess, fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { RuntimeConnection, RuntimeState } from "../shared/contracts/desktop";
import { DesktopStore } from "./store";

type Listener = (state: RuntimeState) => void;
type WorkerMessage = { error?: string; port?: number; type: "ready" | "stopped" | "failed" };

export class RuntimeHost {
  private connectionValue?: RuntimeConnection;
  private listeners = new Set<Listener>();
  private process?: ChildProcess;
  private restartCount = 0;
  private state: RuntimeState = { phase: "stopped" };
  private startPromise?: Promise<RuntimeConnection>;
  private stoppingProcesses = new WeakSet<ChildProcess>();

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
    const child = this.process;
    this.connectionValue = undefined;
    if (!child) {
      this.setState({ phase: "stopped" });
      return;
    }
    this.stoppingProcesses.add(child);
    try {
      child.send({ type: "shutdown" });
    } catch {
      child.kill();
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(terminateTimer);
        clearTimeout(abandonTimer);
        resolve();
      };
      const terminateTimer = setTimeout(() => child.kill(), 1_500);
      const abandonTimer = setTimeout(finish, 4_000);
      child.once("exit", finish);
    });
    if (this.process === child) this.process = undefined;
    this.setState({ phase: "stopped" });
  }

  private prepareDataDirectory(): string {
    const target = this.store.activeProfileRuntimeDirectory();
    mkdirSync(target, { recursive: true });
    return target;
  }

  private async spawn(): Promise<RuntimeConnection> {
    this.connectionValue = undefined;
    this.setState({ phase: this.restartCount > 0 ? "restarting" : "starting" });
    const token = randomBytes(32).toString("base64url");
    const migrations = app.isPackaged
      ? path.join(process.resourcesPath, "migrations")
      : path.join(app.getAppPath(), "server/infra/migrations");
    const builtinSkills = app.isPackaged
      ? path.join(process.resourcesPath, "skills")
      : path.join(app.getAppPath(), "skills");
    // 每次 spawn 时读取 Electron 当前系统语言，确保模型获得真实的桌面环境 locale。
    const systemLocale = app.getLocale() || Intl.DateTimeFormat().resolvedOptions().locale;
    const child = fork(path.join(__dirname, "runtime-worker.js"), [], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        DEEPCREATOR_APP_VERSION: app.getVersion(),
        DEEPSEEK_API_KEY: this.store.apiKey(),
        ZHIPU_API_KEY: this.store.zhipuApiKey(),
        DEEPSEEK_MODEL: this.store.settings().defaultModel,
        DEEPSEEK_MODEL_PROTOCOLS: JSON.stringify(this.store.settings().modelProtocols),
        RUNTIME_AUTH_TOKEN: token,
        RUNTIME_BUILTIN_SKILLS_DIR: builtinSkills,
        RUNTIME_DATA_DIR: this.prepareDataDirectory(),
        RUNTIME_FRONTEND_URL: this.frontendUrl,
        RUNTIME_GLOBAL_SKILLS_DIR: path.join(app.getPath("home"), ".deepcreator", "skills"),
        RUNTIME_EVAL_REPOSITORY_ROOT: app.getAppPath(),
        RUNTIME_EVALS_ENABLED: !app.isPackaged && this.frontendUrl !== "file://" ? "1" : "0",
        RUNTIME_MIGRATIONS_DIR: migrations,
        RUNTIME_SKILL_REGISTRY_FILE: path.join(app.getPath("home"), ".deepcreator", "skill-registry.json"),
        RUNTIME_SKILL_PREVIEW_DIR: path.join(app.getPath("userData"), "skill-agent-previews"),
        RUNTIME_WORKSPACE_ROOT: app.getPath("home"),
        DEEPSEEK_LOCALE: systemLocale
      },
      execArgv: [],
      execPath: process.execPath,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    this.process = child;
    child.stdout?.on("data", (chunk) => process.stdout.write(`[runtime] ${chunk}`));
    child.stderr?.on("data", (chunk) => process.stderr.write(`[runtime] ${chunk}`));

    return new Promise<RuntimeConnection>((resolve, reject) => {
      let settled = false;
      let ready = false;
      const fail = (error: Error, terminate = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (terminate) {
          this.stoppingProcesses.add(child);
          child.kill();
          if (this.process === child) this.process = undefined;
        }
        this.setState({ detail: error.message, phase: "failed" });
        reject(error);
      };
      const timeout = setTimeout(() => fail(new Error("Runtime 启动超时（30 秒）。"), true), 30_000);
      child.on("message", (message: WorkerMessage) => {
        if (message.type === "ready" && message.port) {
          if (settled) return;
          settled = true;
          ready = true;
          clearTimeout(timeout);
          this.connectionValue = { baseUrl: `http://127.0.0.1:${message.port}`, phase: "ready", token };
          this.setState({ connection: this.connectionValue, phase: "ready" });
          resolve(this.connectionValue);
        } else if (message.type === "failed") {
          fail(new Error(message.error || "Runtime 启动失败。"));
        }
      });
      child.once("exit", (_code) => {
        clearTimeout(timeout);
        const wasCurrent = this.process === child;
        if (wasCurrent) {
          this.process = undefined;
          this.connectionValue = undefined;
        }
        if (!settled) fail(new Error("Runtime 在启动完成前退出。"));
        if (this.stoppingProcesses.has(child) || !wasCurrent || !ready) return;
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
