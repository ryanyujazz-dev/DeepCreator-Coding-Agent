import { randomUUID } from "node:crypto";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { resolveRuntimeShell } from "./shell";

export const COMMAND_CHECKPOINT_MS = 60_000;
export const COMMAND_OUTPUT_MAX_BYTES = 1024 * 1024;
export const MAX_MANAGED_COMMANDS = 64;

const COMMAND_EXIT_DRAIN_MS = 100;
const COMMAND_STOP_GRACE_MS = 2_500;
const MODEL_OUTPUT_MAX_CHARS = 14_000;

export type ManagedCommandState = "running" | "completed" | "failed" | "cancelled";

export type CommandSnapshot = {
  activityId: string;
  command: string;
  commandId: string;
  elapsedMs: number;
  exitCode?: number;
  output: string;
  outputDelta: string;
  outputTruncated: boolean;
  projectRoot: string;
  runId: string;
  sessionId: string;
  state: ManagedCommandState;
};

type CommandCallbacks = {
  onOutput?: (text: string) => void;
  onSettled?: (snapshot: CommandSnapshot) => void;
};

type CommandEntry = CommandCallbacks & {
  abort?: () => void;
  activityId: string;
  backgrounded: boolean;
  child: ChildProcessWithoutNullStreams;
  command: string;
  commandId: string;
  done: Promise<void>;
  elapsedMs?: number;
  emittedBytes: number;
  exitCode?: number;
  finishDone: () => void;
  finishTimer?: ReturnType<typeof setTimeout>;
  forceKillTimer?: ReturnType<typeof setTimeout>;
  head: Buffer;
  outputBytes: number;
  outputTruncated: boolean;
  pendingOutput: string;
  projectRoot: string;
  runId: string;
  sessionId: string;
  signal?: AbortSignal;
  startedAt: number;
  state: ManagedCommandState;
  stopPromise?: Promise<CommandSnapshot>;
  stopRequested: boolean;
  tail: Buffer;
  waiting: boolean;
};

function redact(text: string): string {
  let result = text.replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]");
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 12 || !/(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) continue;
    result = result.split(value).join(`[REDACTED_${name}]`);
  }
  return result;
}

function sliceUtf8(buffer: Buffer, maxBytes: number, fromEnd = false): Buffer {
  if (buffer.length <= maxBytes) return buffer;
  return fromEnd ? buffer.subarray(buffer.length - maxBytes) : buffer.subarray(0, maxBytes);
}

function retainedOutput(entry: CommandEntry): string {
  if (!entry.outputTruncated) return entry.head.toString("utf8");
  const omitted = Math.max(0, entry.outputBytes - entry.head.length - entry.tail.length);
  return `${entry.head.toString("utf8")}\n\n[...Runtime 省略了 ${omitted} 字节命令输出...]\n\n${entry.tail.toString("utf8")}`;
}

function appendOutput(entry: CommandEntry, raw: Buffer): void {
  const text = redact(raw.toString());
  const chunk = Buffer.from(text);
  entry.outputBytes += chunk.length;
  entry.pendingOutput = `${entry.pendingOutput}${text}`.slice(-MODEL_OUTPUT_MAX_CHARS);

  if (!entry.outputTruncated && entry.head.length + chunk.length <= COMMAND_OUTPUT_MAX_BYTES) {
    entry.head = Buffer.concat([entry.head, chunk]);
  } else {
    const half = Math.floor(COMMAND_OUTPUT_MAX_BYTES / 2);
    if (!entry.outputTruncated) {
      const combined = Buffer.concat([entry.head, chunk]);
      entry.head = sliceUtf8(combined, half);
      entry.tail = sliceUtf8(combined, COMMAND_OUTPUT_MAX_BYTES - half, true);
      entry.outputTruncated = true;
    } else {
      entry.tail = sliceUtf8(Buffer.concat([entry.tail, chunk]), COMMAND_OUTPUT_MAX_BYTES - half, true);
    }
  }

  if (entry.emittedBytes >= COMMAND_OUTPUT_MAX_BYTES) return;
  const remaining = COMMAND_OUTPUT_MAX_BYTES - entry.emittedBytes;
  const emitted = sliceUtf8(chunk, remaining).toString("utf8");
  entry.emittedBytes += Buffer.byteLength(emitted);
  if (emitted) entry.onOutput?.(emitted);
}

export class CommandManager {
  private readonly commands = new Map<string, CommandEntry>();

  async start(input: {
    activityId: string;
    command: string;
    projectRoot: string;
    runId: string;
    sessionId: string;
    signal?: AbortSignal;
  } & CommandCallbacks, checkpointMs = COMMAND_CHECKPOINT_MS): Promise<CommandSnapshot> {
    this.prune();
    if ([...this.commands.values()].filter((entry) => entry.state === "running").length >= MAX_MANAGED_COMMANDS) {
      throw new Error(`同时运行的命令不能超过 ${MAX_MANAGED_COMMANDS} 个。`);
    }

    const shell = resolveRuntimeShell();
    const child = spawn(shell.executable, shell.argsFor(input.command), {
      cwd: input.projectRoot,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let finishDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { finishDone = resolve; });
    const entry: CommandEntry = {
      ...input,
      backgrounded: false,
      child,
      commandId: `command_${randomUUID()}`,
      done,
      emittedBytes: 0,
      finishDone,
      head: Buffer.alloc(0),
      outputBytes: 0,
      outputTruncated: false,
      pendingOutput: "",
      startedAt: Date.now(),
      state: "running",
      stopRequested: false,
      tail: Buffer.alloc(0),
      waiting: false
    };
    this.commands.set(entry.commandId, entry);

    entry.abort = () => { void this.stop(entry.commandId); };
    input.signal?.addEventListener("abort", entry.abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => appendOutput(entry, chunk));
    child.stderr.on("data", (chunk: Buffer) => appendOutput(entry, chunk));
    child.once("error", (error) => {
      appendOutput(entry, Buffer.from(`\n命令启动失败：${error.message}\n`));
      this.settle(entry, 1, "failed");
    });
    child.once("exit", (code) => {
      entry.finishTimer = setTimeout(() => this.settleFromExit(entry, code ?? 1), COMMAND_EXIT_DRAIN_MS);
    });
    child.once("close", (code) => this.settleFromExit(entry, code ?? child.exitCode ?? 1));

    const snapshot = await this.wait(entry.commandId, checkpointMs);
    if (snapshot.state === "running") {
      entry.backgrounded = true;
      if (entry.state !== "running") {
        const settled = this.snapshot(entry, true);
        entry.onSettled?.(settled);
        return settled;
      }
    }
    return snapshot;
  }

  async wait(
    commandId: string,
    checkpointMs = COMMAND_CHECKPOINT_MS,
    signal?: AbortSignal
  ): Promise<CommandSnapshot> {
    const entry = this.require(commandId);
    if (entry.state !== "running") return this.snapshot(entry, true);
    if (entry.waiting) throw new Error(`命令 ${commandId} 已有一个等待操作。`);
    if (signal?.aborted) throw this.abortError();
    entry.waiting = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        entry.done,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(1, checkpointMs)); }),
        new Promise<void>((_resolve, reject) => {
          if (!signal) return;
          abort = () => reject(this.abortError());
          signal.addEventListener("abort", abort, { once: true });
        })
      ]);
      return this.snapshot(entry, true);
    } finally {
      entry.waiting = false;
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }

  async stop(commandId: string): Promise<CommandSnapshot | undefined> {
    const entry = this.commands.get(commandId);
    if (!entry) return undefined;
    if (entry.state !== "running") return this.snapshot(entry, false);
    if (entry.stopPromise) return entry.stopPromise;
    entry.stopPromise = this.stopEntry(entry);
    return entry.stopPromise;
  }

  private async stopEntry(entry: CommandEntry): Promise<CommandSnapshot> {
    entry.stopRequested = true;
    const terminated = this.terminate(entry);
    entry.finishTimer = setTimeout(() => this.settle(entry, entry.child.exitCode ?? 1, "cancelled"), COMMAND_STOP_GRACE_MS);
    await Promise.all([entry.done, terminated]);
    return this.snapshot(entry, false);
  }

  async stopRun(runId: string): Promise<void> {
    await Promise.all([...this.commands.values()]
      .filter((entry) => entry.runId === runId && entry.state === "running")
      .map((entry) => this.stop(entry.commandId)));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.commands.values()]
      .filter((entry) => entry.state === "running")
      .map((entry) => this.stop(entry.commandId)));
  }

  get(commandId: string): CommandSnapshot | undefined {
    const entry = this.commands.get(commandId);
    return entry ? this.snapshot(entry, false) : undefined;
  }

  running(runId: string): CommandSnapshot[] {
    return [...this.commands.values()]
      .filter((entry) => entry.runId === runId && entry.state === "running")
      .map((entry) => this.snapshot(entry, false));
  }

  private require(commandId: string): CommandEntry {
    const entry = this.commands.get(commandId);
    if (!entry) throw new Error(`未找到命令：${commandId}`);
    return entry;
  }

  private abortError(): Error {
    const error = new Error("等待命令已中止。");
    error.name = "AbortError";
    return error;
  }

  private settleFromExit(entry: CommandEntry, exitCode: number): void {
    this.settle(entry, exitCode, entry.stopRequested ? "cancelled" : exitCode === 0 ? "completed" : "failed");
  }

  private settle(entry: CommandEntry, exitCode: number, state: Exclude<ManagedCommandState, "running">): void {
    if (entry.state !== "running") return;
    entry.state = state;
    entry.exitCode = exitCode;
    entry.elapsedMs = Date.now() - entry.startedAt;
    if (entry.finishTimer) clearTimeout(entry.finishTimer);
    if (entry.forceKillTimer) clearTimeout(entry.forceKillTimer);
    if (entry.abort) entry.signal?.removeEventListener("abort", entry.abort);
    entry.child.stdin.destroy();
    entry.child.stdout.destroy();
    entry.child.stderr.destroy();
    entry.finishDone();
    if (entry.backgrounded) entry.onSettled?.(this.snapshot(entry, false));
  }

  private terminate(entry: CommandEntry): Promise<void> {
    if (!entry.child.pid) return Promise.resolve();
    if (process.platform === "win32") {
      return new Promise((resolve) => {
        const killer = spawn("taskkill.exe", ["/pid", String(entry.child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true
        });
        killer.once("error", () => {
          entry.child.kill();
          resolve();
        });
        killer.once("close", () => resolve());
      });
    }
    try {
      process.kill(-entry.child.pid, "SIGTERM");
    } catch {
      entry.child.kill("SIGTERM");
    }
    entry.forceKillTimer = setTimeout(() => {
      if (entry.state !== "running" || !entry.child.pid) return;
      try {
        process.kill(-entry.child.pid, "SIGKILL");
      } catch {
        entry.child.kill("SIGKILL");
      }
    }, 2_000);
    return Promise.resolve();
  }

  private snapshot(entry: CommandEntry, consumeDelta: boolean): CommandSnapshot {
    const outputDelta = entry.pendingOutput;
    if (consumeDelta) entry.pendingOutput = "";
    const retained = retainedOutput(entry).trimEnd();
    return {
      activityId: entry.activityId,
      command: entry.command,
      commandId: entry.commandId,
      elapsedMs: entry.elapsedMs ?? Date.now() - entry.startedAt,
      exitCode: entry.exitCode,
      output: retained || (entry.state === "running" ? "命令仍在运行，暂时没有新输出。" : "命令执行完成，无输出。"),
      outputDelta: outputDelta.trimEnd() || (entry.state === "running" ? "命令仍在运行，暂时没有新输出。" : retained || "命令执行完成，无输出。"),
      outputTruncated: entry.outputTruncated,
      projectRoot: entry.projectRoot,
      runId: entry.runId,
      sessionId: entry.sessionId,
      state: entry.state
    };
  }

  private prune(): void {
    if (this.commands.size < MAX_MANAGED_COMMANDS * 2) return;
    for (const [commandId, entry] of this.commands) {
      if (entry.state !== "running") this.commands.delete(commandId);
      if (this.commands.size < MAX_MANAGED_COMMANDS) break;
    }
  }
}

export const commandManager = new CommandManager();
