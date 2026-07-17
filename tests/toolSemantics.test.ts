import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCommand, permissionRequestFor } from "../server/permissionPolicy";
import { activityKindForTool, createToolExecutionView, executeRuntimeTool, runtimeToolDefinitions } from "../server/tools";

function semantic(name: string, args: Record<string, unknown>) {
  return createToolExecutionView({
    args,
    callKey: `call_${name}`,
    modelStepKey: "step_test",
    name,
    projectRoot: "/tmp/project"
  });
}

test("classifies registered tools without leaking presentation metadata to the provider", () => {
  assert.ok(runtimeToolDefinitions.every((definition) => Object.keys(definition).sort().join(",") === "description,inputSchema,name"));
  const read = semantic("read_file", { path: "/tmp/project/src/App.tsx" });
  assert.equal(read.normalizedTarget, "src/App.tsx");
  assert.equal(read.operationClass, "inspect");
  assert.equal(activityKindForTool(read), "tool");

  const edit = semantic("edit_file", { path: "src/App.tsx" });
  assert.equal(edit.effectKind, "workspace_write");
  assert.equal(edit.aggregationPolicy, "workspace_delta");
  assert.equal(activityKindForTool(edit), "file_mutation");
});

test("classifies command semantics through the tool registration", () => {
  const search = semantic("run_command", { command: "rg ActivityUnit src" });
  assert.equal(search.operationClass, "search");
  assert.equal(search.aggregationPolicy, "consecutive");
  assert.equal(activityKindForTool(search), "tool");

  const verification = semantic("run_command", { command: "npm run build" });
  assert.equal(verification.operationClass, "verify");
  assert.equal(activityKindForTool(verification), "command");

  const install = semantic("run_command", { command: "npm install" });
  assert.equal(install.operationClass, "execute");
  assert.equal(install.aggregationPolicy, "standalone");
});

test("classifies command permission and mutation semantics from parsed arguments", async () => {
  const gitStatus = analyzeCommand("git -C /tmp/project status --short");
  assert.equal(gitStatus.readOnly, true);
  assert.equal(gitStatus.risk, "low");
  assert.equal(
    permissionRequestFor({
      args: { command: "git -C /tmp/project status --short" },
      cycleKey: "cycle_1",
      grants: [],
      profile: "request_approval",
      toolName: "run_command"
    }),
    undefined
  );

  const localNpx = analyzeCommand("npx tsc --noEmit");
  assert.equal(localNpx.network, false);
  assert.equal(localNpx.readOnly, true);

  const readOnlyResult = await executeRuntimeTool({
    args: { command: "pwd" },
    name: "run_command",
    projectRoot: "/tmp"
  });
  assert.equal(readOnlyResult.mutatedWorkspace, false);

  const destructive = permissionRequestFor({
    args: { command: "rm -rf dist" },
    cycleKey: "cycle_1",
    grants: [],
    profile: "smart_approval",
    toolName: "run_command"
  });
  assert.equal(destructive?.risk, "high");
});

test("reports command timeouts explicitly and preserves pipeline failures", async () => {
  const timedOut = await executeRuntimeTool({
    args: { command: "sleep 1" },
    commandTimeoutMs: 25,
    name: "run_command",
    projectRoot: "/tmp"
  });
  assert.equal(timedOut.exitCode, 124);
  assert.equal(timedOut.timedOut, true);
  assert.match(timedOut.output, /执行超时/);

  const pipeline = await executeRuntimeTool({
    args: { command: "sh -c 'exit 7' | tail -1" },
    name: "run_command",
    projectRoot: "/tmp"
  });
  assert.equal(pipeline.exitCode, 7);
});
