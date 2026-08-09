import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeCommand, approvalFor } from "../server/domain/accessPolicy";
import { resolveRuntimeShell } from "../server/infra/shell";
import {
  activityKindForTool,
  createToolState,
  executeTool,
  toolSpecs
} from "../server/infra/tools";

function semantic(name: string, args: Record<string, unknown>) {
  return createToolState({
    args,
    callId: `call_${name}`,
    modelStepId: "step_test",
    name,
    projectRoot: "/tmp/project"
  });
}

function modelVisibleDescriptions(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key === "description" && typeof child === "string" ? [child] : []),
    ...modelVisibleDescriptions(child)
  ]);
}

test("classifies registered tools without leaking presentation metadata to the provider", () => {
  assert.ok(toolSpecs.every((definition) => Object.keys(definition).sort().join(",") === "description,inputSchema,name"));
  const read = semantic("read_file", { path: "/tmp/project/src/App.tsx" });
  assert.equal(read.normalizedTarget, "src/App.tsx");
  assert.equal(read.action, "inspect");
  assert.equal(activityKindForTool(read), "tool");

  const edit = semantic("edit_file", { path: "src/App.tsx" });
  assert.equal(edit.effect, "workspace_write");
  assert.equal(edit.groupMode, "workspace_delta");
  assert.equal(activityKindForTool(edit), "file_mutation");
});

test("keeps every model-visible tool description in Chinese", () => {
  const descriptions = modelVisibleDescriptions(toolSpecs);
  assert.ok(descriptions.length > toolSpecs.length);
  assert.ok(descriptions.every((description) => /[\u3400-\u9fff]/.test(description)));
});

test("classifies command semantics through the tool registration", () => {
  const search = semantic("run_command", { command: "rg Activity src" });
  assert.equal(search.action, "search");
  assert.equal(search.groupMode, "consecutive");
  assert.equal(activityKindForTool(search), "tool");

  const verification = semantic("run_command", { command: "npm run build" });
  assert.equal(verification.action, "verify");
  assert.equal(activityKindForTool(verification), "command");

  const install = semantic("run_command", { command: "npm install" });
  assert.equal(install.action, "execute");
  assert.equal(install.groupMode, "standalone");
});

test("classifies command permission and mutation semantics from parsed arguments", async () => {
  const gitStatus = analyzeCommand("git -C /tmp/project status --short");
  assert.equal(gitStatus.readOnly, true);
  assert.equal(gitStatus.risk, "low");
  assert.equal(
    approvalFor({
      args: { command: "git -C /tmp/project status --short" },
      runId: "run_1",
      grants: [],
      profile: "request_approval",
      toolName: "run_command"
    }),
    undefined
  );

  const localNpx = analyzeCommand("npx tsc --noEmit");
  assert.equal(localNpx.network, false);
  assert.equal(localNpx.readOnly, true);

  const projectRoot = mkdtempSync(path.join(tmpdir(), "deepcreator-command-"));
  try {
    const readOnlyResult = await executeTool({
      activityId: "activity_pwd",
      args: { command: "pwd" },
      name: "run_command",
      projectRoot,
      runId: "run_pwd",
      sessionId: "session_pwd"
    });
    assert.equal(readOnlyResult.exitCode, 0);
    assert.equal(readOnlyResult.mutatedWorkspace, false);
  } finally {
    rmSync(projectRoot, { force: true, recursive: true });
  }

  const destructive = approvalFor({
    args: { command: "rm -rf dist" },
    runId: "run_1",
    grants: [],
    profile: "smart_approval",
    toolName: "run_command"
  });
  assert.equal(destructive?.risk, "high");

  const skillScript = approvalFor({
    args: { capabilityId: "skill:create-skill:abc123", scriptId: "pack-skill" },
    runId: "run_1",
    grants: [],
    profile: "smart_approval",
    toolName: "run_skill_script"
  });
  assert.equal(skillScript?.capability, "shell_execute");
  assert.equal(skillScript?.risk, "high");
});

test("yields long commands for follow-up control and preserves nonzero exits", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "deepcreator-command-"));
  const family = resolveRuntimeShell().family;
  const timeoutCommand = family === "cmd"
    ? "ping -n 3 127.0.0.1 >NUL"
    : family === "powershell" ? "Start-Sleep -Seconds 1" : "sleep 1";
  const failureCommand = family === "cmd"
    ? "exit /b 7"
    : family === "powershell" ? "exit 7" : "sh -c 'exit 7' | tail -1";
  try {
    const running = await executeTool({
      activityId: "activity_long",
      args: { command: timeoutCommand },
      commandCheckpointMs: 25,
      name: "run_command",
      projectRoot,
      runId: "run_long",
      sessionId: "session_long"
    });
    assert.equal(running.commandState, "running");
    assert.ok(running.commandId);
    const stopped = await executeTool({
      args: { commandId: running.commandId },
      name: "stop_command",
      projectRoot
    });
    assert.equal(stopped.commandState, "cancelled");

    const failed = await executeTool({
      activityId: "activity_failure",
      args: { command: failureCommand },
      name: "run_command",
      projectRoot,
      runId: "run_failure",
      sessionId: "session_failure"
    });
    assert.equal(failed.exitCode, 7);
  } finally {
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

test("settles after a shell exits with inherited pipes", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "deepcreator-command-lifecycle-"));
  writeFileSync(path.join(projectRoot, "background-parent.cjs"), [
    "const { spawn } = require('node:child_process');",
    "const { tmpdir } = require('node:os');",
    "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {",
    "  cwd: tmpdir(),",
    "  detached: true,",
    "  stdio: ['ignore', 'inherit', 'inherit'],",
    "  windowsHide: true",
    "}).unref();"
  ].join("\n"));

  try {
    const startedAt = Date.now();
    const result = await executeTool({
      activityId: "activity_inherited",
      args: { command: "node background-parent.cjs" },
      name: "run_command",
      projectRoot,
      runId: "run_inherited",
      sessionId: "session_inherited"
    });
    assert.equal(result.exitCode, 0);
    assert.ok(Date.now() - startedAt < 2_000, "command waited for a detached descendant's output pipe");
  } finally {
    rmSync(projectRoot, { force: true, recursive: true });
  }
});
