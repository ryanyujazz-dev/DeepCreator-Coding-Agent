import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TestRunRegistry as RunRegistry } from "./support/system";
import { RuntimeStore } from "../server/infra/runtimeStore";
import { executeTool, redactSensitiveText, summarizeToolArguments } from "../server/infra/tools";

test("blocks credential files and redacts secrets from public text", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-security-"));
  try {
    writeFileSync(path.join(directory, ".env.local"), "DEEPSEEK_API_KEY=sk-sensitive-value-123456789\n");
    writeFileSync(path.join(directory, ".env.example"), "DEEPSEEK_API_KEY=replace-me\n");
    await assert.rejects(
      executeTool({ args: { path: ".env.local" }, name: "read_file", projectRoot: directory }),
      /不允许读取/
    );
    const listed = await executeTool({ args: {}, name: "list_files", projectRoot: directory });
    assert.ok(!listed.output.includes(".env.local"));
    assert.ok(listed.output.includes(".env.example"));
    assert.equal(redactSensitiveText("token sk-sensitive-value-123456789"), "token [REDACTED_API_KEY]");
    assert.ok(!summarizeToolArguments("write_file", { path: "a.ts", content: "private source" }).includes("private source"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("cancelling during approval resolves the interaction without timeline activities", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-approval-"));
  mkdirSync(directory, { recursive: true });
  try {
    const store = new RuntimeStore(directory);
    store.createSession({ compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "mock-agent", projectRoot: directory, sessionId: "session_approval", title: "审批" });
    store.append({ runId: "run_approval", data: { model: "mock-agent", prompt: "删除文件", startedAt: new Date().toISOString() }, sessionId: "session_approval", type: "run.started" });
    const registry = new RunRegistry();
    const controller = registry.startRun("run_approval");
    const decision = registry.requestApproval({
      callId: "call_delete",
      capability: "workspace_delete",
      detail: "delete a.ts",
      risk: "high",
      runId: "run_approval",
      sessionId: "session_approval",
      signal: controller.signal,
      store,
      target: "a.ts",
      title: "允许删除？",
      toolName: "delete_file"
    });
    registry.cancelRun("run_approval");
    assert.equal(await decision, "deny");
    const run = store.getRun("run_approval")!;
    assert.equal(run.approvals[0].state, "dismissed");
    assert.equal(run.activities.length, 0);
    store.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
