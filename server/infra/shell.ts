import { existsSync } from "node:fs";
import path from "node:path";

export type RuntimeShell = {
  argsFor: (command: string) => string[];
  executable: string;
  family: string;
};

function shellFamily(executable: string): string {
  const name = path.basename(executable).toLowerCase().replace(/\.exe$/, "");
  if (name === "pwsh" || name === "powershell") return "powershell";
  if (name === "cmd") return "cmd";
  if (name.includes("zsh")) return "zsh";
  if (name.includes("bash")) return "bash";
  if (name === "sh") return "sh";
  return name || "unknown";
}

function argsForFamily(family: string, command: string): string[] {
  if (family === "powershell") {
    return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command];
  }
  if (family === "cmd") return ["/d", "/s", "/c", command];
  if (family === "bash" || family === "zsh") return ["-lc", `set -o pipefail\n${command}`];
  return ["-lc", command];
}

function gitBashCandidates(): string[] {
  const candidates: string[] = [];
  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (root) candidates.push(path.join(root, "Git", "bin", "bash.exe"));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  }
  for (const entry of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    if (entry.toLowerCase().includes("windowsapps")) continue;
    candidates.push(path.join(entry, "bash.exe"));
    if (path.basename(entry).toLowerCase() === "cmd") {
      candidates.push(path.join(path.dirname(entry), "bin", "bash.exe"));
    }
  }
  return candidates;
}

function createShell(executable: string): RuntimeShell {
  const family = shellFamily(executable);
  return {
    argsFor: (command) => argsForFamily(family, command),
    executable,
    family
  };
}

let cachedShell: RuntimeShell | undefined;

export function resolveRuntimeShell(): RuntimeShell {
  if (cachedShell) return cachedShell;
  const configured = process.env.DEEPSEEK_SHELL?.trim();
  if (configured) return (cachedShell = createShell(configured));

  if (process.platform === "win32") {
    const gitBash = gitBashCandidates().find((candidate) => existsSync(candidate));
    const executable = gitBash ?? process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
    return (cachedShell = createShell(executable));
  }

  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter((value): value is string => Boolean(value));
  const executable = candidates.find((candidate) => !path.isAbsolute(candidate) || existsSync(candidate)) ?? "/bin/sh";
  return (cachedShell = createShell(executable));
}

export function quoteRuntimeShellArgument(value: string): string {
  const family = resolveRuntimeShell().family;
  if (family === "cmd") return `"${value.replaceAll('"', '""')}"`;
  if (family === "powershell") return `'${value.replaceAll("'", "''")}'`;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
