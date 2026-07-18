import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCommand, approvalFor } from "../server/domain/accessPolicy";
import { activityKindForTool, createToolState, executeTool, toolSpecs } from "../server/infra/tools";

function semantic(name: string, args: Record<string, unknown>) {
  return createToolState({
    args,
    callId: `call_${name}`,
    modelStepId: "step_test",
    name,
    projectRoot: "/tmp/project"
  });
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

  const readOnlyResult = await executeTool({
    args: { command: "pwd" },
    name: "run_command",
    projectRoot: "/tmp"
  });
  assert.equal(readOnlyResult.mutatedWorkspace, false);

  const destructive = approvalFor({
    args: { command: "rm -rf dist" },
    runId: "run_1",
    grants: [],
    profile: "smart_approval",
    toolName: "run_command"
  });
  assert.equal(destructive?.risk, "high");
});

test("reports command timeouts explicitly and preserves pipeline failures", async () => {
  const timedOut = await executeTool({
    args: { command: "sleep 1" },
    commandTimeoutMs: 25,
    name: "run_command",
    projectRoot: "/tmp"
  });
  assert.equal(timedOut.exitCode, 124);
  assert.equal(timedOut.timedOut, true);
  assert.match(timedOut.output, /执行超时/);

  const pipeline = await executeTool({
    args: { command: "sh -c 'exit 7' | tail -1" },
    name: "run_command",
    projectRoot: "/tmp"
  });
  assert.equal(pipeline.exitCode, 7);
});
