import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { DesktopPlatform, ProjectOpenTarget } from "../shared/contracts/desktop";

type EditorTarget = Exclude<ProjectOpenTarget, "system">;

export type ProjectEditorLaunch = {
  args: string[];
  command: string;
};

function editorLabel(target: EditorTarget): string {
  return target === "cursor" ? "Cursor" : "Visual Studio Code";
}

export function resolveProjectEditorLaunch(
  projectPath: string,
  target: EditorTarget,
  platform: DesktopPlatform,
  environment: NodeJS.ProcessEnv = process.env,
  pathExists: (candidate: string) => boolean = existsSync
): ProjectEditorLaunch {
  if (platform === "darwin") {
    return { args: ["-a", editorLabel(target), projectPath], command: "/usr/bin/open" };
  }
  if (platform === "linux") {
    return { args: [projectPath], command: target === "cursor" ? "cursor" : "code" };
  }

  const relativeCandidates = target === "cursor"
    ? [["LOCALAPPDATA", "Programs", "cursor", "Cursor.exe"], ["PROGRAMFILES", "Cursor", "Cursor.exe"]]
    : [
        ["LOCALAPPDATA", "Programs", "Microsoft VS Code", "Code.exe"],
        ["PROGRAMFILES", "Microsoft VS Code", "Code.exe"],
        ["PROGRAMFILES(X86)", "Microsoft VS Code", "Code.exe"]
      ];
  const executable = relativeCandidates
    .map(([variable, ...segments]) => environment[variable] ? path.win32.join(environment[variable], ...segments) : "")
    .find((candidate) => candidate && pathExists(candidate));
  if (!executable) throw new Error(`未找到 ${editorLabel(target)}，请先安装后重试。`);
  return { args: [projectPath], command: executable };
}

export function launchProjectEditor(projectPath: string, target: EditorTarget): Promise<void> {
  const platform: DesktopPlatform = process.platform === "darwin" || process.platform === "win32"
    ? process.platform
    : "linux";
  const launch = resolveProjectEditorLaunch(projectPath, target, platform);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
