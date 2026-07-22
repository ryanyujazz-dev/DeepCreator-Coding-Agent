import { spawn } from "node:child_process";
import { ToolProgress } from "../../../shared/contracts/tool";
import { resolveRuntimeShell } from "../shell";
import { ensureInsideRoot, redactSensitiveText } from "./security";

const COMMAND_EXIT_DRAIN_MS = 100;
const COMMAND_TERMINATION_GRACE_MS = 2_500;
const INTERNAL_SHELL_TIMEOUT_MS = 120_000;

export function runShell(
  projectRoot: string,
  command: string,
  signal?: AbortSignal,
  timeoutMs = INTERNAL_SHELL_TIMEOUT_MS,
  onOutput?: (progress: ToolProgress) => void
): Promise<{ exitCode: number; output: string; timedOut?: boolean }> {
  return new Promise((resolve, reject) => {
    const shell = resolveRuntimeShell();
    const child = spawn(shell.executable, shell.argsFor(command), {
      cwd: ensureInsideRoot(projectRoot),
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: process.platform === "win32" && shell.family === "cmd"
    });
    let output = "";
    let timedOut = false;
    let settled = false;
    let settleDeadline = Number.POSITIVE_INFINITY;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (output.length > 2_000_000) output = output.slice(-2_000_000);
      onOutput?.({ text: redactSensitiveText(text) });
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (settleTimer) clearTimeout(settleTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);
      child.stdout.off("data", append);
      child.stderr.off("data", append);
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal?.aborted) {
        reject(new DOMException("运行已取消。", "AbortError"));
        return;
      }
      const cleanedOutput = output.trimEnd();
      if (timedOut) {
        const timeoutMessage = `命令执行超时（${Math.ceil(timeoutMs / 1_000)} 秒），Runtime 已停止该进程。`;
        resolve({
          exitCode: 124,
          output: redactSensitiveText(cleanedOutput ? `${cleanedOutput}\n\n${timeoutMessage}` : timeoutMessage),
          timedOut: true
        });
        return;
      }
      resolve({ exitCode: code, output: redactSensitiveText(cleanedOutput || "命令执行完成，无输出。") });
    };
    const scheduleFinish = (code: number, delayMs: number) => {
      const deadline = Date.now() + delayMs;
      if (settled || deadline >= settleDeadline) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleDeadline = deadline;
      settleTimer = setTimeout(() => finish(code), delayMs);
    };
    const terminate = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true
        });
        killer.on("error", () => child.kill());
        killer.unref();
        return;
      }
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      forceKillTimer = setTimeout(() => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 2_000);
      forceKillTimer.unref?.();
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      onOutput?.({ text: `\n命令执行超过 ${Math.ceil(timeoutMs / 1000)} 秒，正在停止。\n` });
      terminate();
      scheduleFinish(124, COMMAND_TERMINATION_GRACE_MS);
    }, timeoutMs);
    timeoutTimer.unref?.();
    const abort = () => {
      terminate();
      scheduleFinish(1, COMMAND_TERMINATION_GRACE_MS);
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("exit", (code) => scheduleFinish(code ?? 1, COMMAND_EXIT_DRAIN_MS));
    child.once("close", (code) => finish(code ?? child.exitCode ?? 1));
  });
}
