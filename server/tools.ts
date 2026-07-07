import { exec as execCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DiffSummary, emptyDiffSummary } from "../shared/agentTypes";

const exec = promisify(execCallback);

const COMMAND_ALLOWLIST = new Set([
  "git status",
  "node --version",
  "npm --version",
  "npm audit",
  "npm audit --audit-level=moderate",
  "npm install",
  "npm run build"
]);

function ensureInsideRoot(projectRoot: string, targetPath = "."): string {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, targetPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("路径必须位于项目根目录内。");
  }
  return resolved;
}

async function listFiles(projectRoot: string, input: { maxFiles?: number }): Promise<string> {
  const root = ensureInsideRoot(projectRoot);
  const maxFiles = input.maxFiles ?? 120;
  const output: string[] = [];

  async function walk(current: string): Promise<void> {
    if (output.length >= maxFiles) return;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (output.length >= maxFiles) return;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(root, fullPath);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        output.push(relativePath);
      }
    }
  }

  await walk(root);
  return output.length > 0 ? output.join("\n") : "项目目录中没有可列出的文件。";
}

async function readFile(projectRoot: string, input: { path: string; maxChars?: number }): Promise<string> {
  const filePath = ensureInsideRoot(projectRoot, input.path);
  const contents = await fs.readFile(filePath, "utf8");
  return contents.slice(0, input.maxChars ?? 20000);
}

async function runCommand(projectRoot: string, input: { command: string }): Promise<string> {
  const command = input.command.trim();
  if (!COMMAND_ALLOWLIST.has(command)) {
    throw new Error(`命令不在当前阶段白名单中：${command}`);
  }

  const { stderr, stdout } = await exec(command, {
    cwd: ensureInsideRoot(projectRoot),
    maxBuffer: 1024 * 1024,
    timeout: 120000
  });

  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || "命令执行成功，无输出。";
}

async function gitStatus(projectRoot: string): Promise<string> {
  const root = ensureInsideRoot(projectRoot);
  const [{ stdout: status }, { stdout: diff }] = await Promise.all([
    exec("git status --short", { cwd: root }),
    exec("git diff --numstat", { cwd: root })
  ]);
  return [`git status --short:\n${status.trim() || "(clean)"}`, `git diff --numstat:\n${diff.trim() || "(none)"}`].join(
    "\n\n"
  );
}

export async function collectDiffSummary(projectRoot: string): Promise<DiffSummary> {
  try {
    const root = ensureInsideRoot(projectRoot);
    const [{ stdout: numstat }, { stdout: status }] = await Promise.all([
      exec("git diff --numstat", { cwd: root }),
      exec("git status --short", { cwd: root })
    ]);

    const files = numstat
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [additionsRaw, deletionsRaw, filePath] = line.split(/\s+/);
        return {
          additions: Number(additionsRaw) || 0,
          deletions: Number(deletionsRaw) || 0,
          path: filePath
        };
      });

    const statusFiles = status
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter((filePath) => filePath && !files.some((file) => file.path === filePath));

    const allFiles = [
      ...files,
      ...statusFiles.map((filePath) => ({
        additions: 0,
        deletions: 0,
        path: filePath
      }))
    ];

    return {
      additions: allFiles.reduce((sum, file) => sum + file.additions, 0),
      changedFiles: allFiles.length,
      deletions: allFiles.reduce((sum, file) => sum + file.deletions, 0),
      files: allFiles
    };
  } catch {
    return emptyDiffSummary();
  }
}

export async function executeRuntimeTool(
  projectRoot: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "list_files":
      return listFiles(projectRoot, args as { maxFiles?: number });
    case "read_file":
      return readFile(projectRoot, args as { path: string; maxChars?: number });
    case "git_status":
      return gitStatus(projectRoot);
    case "run_command":
      return runCommand(projectRoot, args as { command: string });
    default:
      throw new Error(`未知工具：${name}`);
  }
}

export const runtimeToolSchemas = [
  {
    function: {
      description: "列出项目根目录中的文件，自动忽略 node_modules、.git、dist。",
      name: "list_files",
      parameters: {
        additionalProperties: false,
        properties: {
          maxFiles: {
            default: 120,
            type: "number"
          }
        },
        type: "object"
      }
    },
    type: "function"
  },
  {
    function: {
      description: "读取项目根目录内的文本文件。",
      name: "read_file",
      parameters: {
        additionalProperties: false,
        properties: {
          maxChars: {
            default: 20000,
            type: "number"
          },
          path: {
            type: "string"
          }
        },
        required: ["path"],
        type: "object"
      }
    },
    type: "function"
  },
  {
    function: {
      description: "获取 git status 和 git diff --numstat。",
      name: "git_status",
      parameters: {
        additionalProperties: false,
        properties: {},
        type: "object"
      }
    },
    type: "function"
  },
  {
    function: {
      description: "运行当前阶段允许的白名单命令，例如 npm run build、npm audit --audit-level=moderate、git status。",
      name: "run_command",
      parameters: {
        additionalProperties: false,
        properties: {
          command: {
            type: "string"
          }
        },
        required: ["command"],
        type: "object"
      }
    },
    type: "function"
  },
  {
    function: {
      description: "维护 agent 的任务意图层。runtime 会单独维护验证事实层。",
      name: "update_task",
      parameters: {
        additionalProperties: false,
        properties: {
          agentStatus: {
            enum: ["planned", "in_progress", "claimed_done", "blocked"],
            type: "string"
          },
          id: {
            type: "string"
          },
          title: {
            type: "string"
          },
          verification: {
            additionalProperties: false,
            description: "可选的客观验证规则。runtime 只会机械匹配这些规则，不理解任务语义。",
            properties: {
              commandPattern: {
                type: "string"
              },
              kind: {
                enum: ["command_exit_zero", "file_changed"],
                type: "string"
              },
              pathPattern: {
                type: "string"
              }
            },
            required: ["kind"],
            type: "object"
          }
        },
        required: ["id", "title", "agentStatus"],
        type: "object"
      }
    },
    type: "function"
  }
] as const;
