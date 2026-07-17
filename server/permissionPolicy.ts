import {
  PermissionCapability,
  PermissionGrantView,
  PermissionProfileKey,
  PermissionRisk
} from "../shared/runtimeTypes";

export type CommandSemantics = {
  capability: PermissionCapability;
  destructive: boolean;
  fingerprint: string;
  network: boolean;
  readOnly: boolean;
  risk: PermissionRisk;
  targetsCriticalPath: boolean;
};

export type PermissionRequestSpec = {
  capability: PermissionCapability;
  detail: string;
  risk: PermissionRisk;
  target: string;
  title: string;
};

const READ_ONLY_PROGRAMS = new Set(["cat", "diff", "du", "fd", "grep", "head", "ls", "pwd", "rg", "stat", "tail", "tree", "wc"]);
const READ_ONLY_GIT = new Set(["branch", "diff", "log", "show", "status"]);
const NETWORK_PROGRAMS = new Set(["curl", "ftp", "nc", "npx", "scp", "sftp", "ssh", "telnet", "wget"]);
const DESTRUCTIVE_PROGRAMS = new Set(["chmod", "chown", "dd", "mv", "rm", "rmdir", "truncate"]);
const LOCAL_NPX_VERIFY = new Set(["eslint", "playwright", "tsc", "vitest"]);

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === "&&" || pair === "||") {
      if (current.trim()) parts.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    if (character === ";" || character === "|" || character === "\n") {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const character of segment.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = "";
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) words.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current) words.push(current);
  return words;
}

function commandWords(segment: string): string[] {
  const words = shellWords(segment);
  while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  if (words[0] === "env") {
    words.shift();
    while (words[0] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0].startsWith("-"))) words.shift();
  }
  return words;
}

function gitVerb(words: string[]): string {
  let index = 1;
  while (index < words.length && words[index].startsWith("-")) {
    if (words[index] === "-C" || words[index] === "-c" || words[index] === "--git-dir" || words[index] === "--work-tree") index += 2;
    else index += 1;
  }
  return words[index] ?? "";
}

function programName(raw = ""): string {
  return raw.split("/").at(-1)?.toLowerCase() ?? "";
}

function segmentSemantics(segment: string) {
  const words = commandWords(segment);
  const program = programName(words[0]);
  const git = program === "git" ? gitVerb(words) : "";
  const npmVerb = ["npm", "pnpm", "yarn"].includes(program) ? (words[1] ?? "") : "";
  const npxVerb = program === "npx" ? (words[1] ?? "") : "";
  const hasWriteRedirect = /(^|[^<])>{1,2}/.test(segment);
  const verification = (
    ["npm", "pnpm", "yarn"].includes(program) &&
    (npmVerb === "test" || (npmVerb === "run" && /^(build|check|lint|test|typecheck)$/.test(words[2] ?? "")))
  ) || (
    program === "npx" && LOCAL_NPX_VERIFY.has(npxVerb)
  ) || (
    program === "pytest" ||
    (program === "cargo" && ["check", "test"].includes(words[1] ?? "")) ||
    (program === "go" && words[1] === "test")
  );
  const network = NETWORK_PROGRAMS.has(program) ||
    (program === "git" && ["clone", "fetch", "pull", "push"].includes(git)) ||
    (["npm", "pnpm", "yarn", "pip", "pip3"].includes(program) && ["add", "install", "publish"].includes(npmVerb));
  const effectiveNetwork = network && !verification;
  const destructive = DESTRUCTIVE_PROGRAMS.has(program) ||
    (program === "git" && ["clean", "checkout", "reset", "restore"].includes(git));
  const readOnly = !hasWriteRedirect && (
    READ_ONLY_PROGRAMS.has(program) ||
    (program === "find" && !words.includes("-delete") && !words.includes("-exec")) ||
    (program === "sed" && words.includes("-n") && !words.some((word) => /^-.*i/.test(word))) ||
    (program === "git" && READ_ONLY_GIT.has(git)) ||
    program === "cd" ||
    verification
  );
  return { destructive, fingerprint: program === "git" ? `git:${git}` : `${program}:${npmVerb || npxVerb}`, network: effectiveNetwork, readOnly, words };
}

export function analyzeCommand(command: string): CommandSemantics {
  const segments = splitCommand(command).map(segmentSemantics);
  const network = segments.some((segment) => segment.network);
  const destructive = segments.some((segment) => segment.destructive);
  const readOnly = segments.length > 0 && segments.every((segment) => segment.readOnly);
  const targetsCriticalPath = /(?:^|\s)(?:\/|~)(?:\s|$)/.test(command) && /\brm\b|\brmdir\b/.test(command);
  const capability: PermissionCapability = network
    ? "network_access"
    : destructive
      ? "workspace_delete"
      : "shell_execute";
  const risk: PermissionRisk = targetsCriticalPath ? "critical" : destructive ? "high" : network ? "medium" : readOnly ? "low" : "medium";
  return {
    capability,
    destructive,
    fingerprint: segments.map((segment) => segment.fingerprint).join("+") || "shell:unknown",
    network,
    readOnly,
    risk,
    targetsCriticalPath
  };
}

function hasGrant(
  grants: PermissionGrantView[],
  cycleKey: string,
  toolName: string,
  capability: PermissionCapability,
  targetPattern: string
): boolean {
  return grants.some((grant) =>
    grant.toolName === toolName &&
    grant.capability === capability &&
    grant.targetPattern === targetPattern &&
    (grant.scope === "session" || grant.cycleKey === cycleKey)
  );
}

export function permissionRequestFor(input: {
  args: Record<string, unknown>;
  cycleKey: string;
  grants: PermissionGrantView[];
  profile: PermissionProfileKey;
  toolName: string;
}): PermissionRequestSpec | undefined {
  if (input.toolName === "delete_file") {
    const target = String(input.args.path ?? "");
    if (hasGrant(input.grants, input.cycleKey, input.toolName, "workspace_delete", target)) return undefined;
    if (input.profile === "full_access") return undefined;
    return { capability: "workspace_delete", detail: `删除项目文件 ${target}`, risk: "high", target, title: "允许删除文件？" };
  }
  if (input.toolName !== "run_command") return undefined;
  const command = String(input.args.command ?? "").trim();
  const semantics = analyzeCommand(command);
  if (semantics.readOnly) return undefined;
  if (hasGrant(input.grants, input.cycleKey, input.toolName, semantics.capability, semantics.fingerprint)) return undefined;
  if (input.profile === "full_access" && !semantics.targetsCriticalPath) return undefined;
  if (input.profile === "smart_approval" && semantics.risk !== "high" && semantics.risk !== "critical") return undefined;
  return {
    capability: semantics.capability,
    detail: command,
    risk: semantics.risk,
    target: semantics.fingerprint,
    title: semantics.network ? "允许访问网络？" : semantics.destructive ? "允许执行高风险命令？" : "允许运行此命令？"
  };
}
