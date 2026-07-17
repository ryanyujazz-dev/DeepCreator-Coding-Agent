import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LiveRegistry } from "../server/liveRegistry";
import { SignalStore } from "../server/signalStore";
import { executeRuntimeTool, redactSensitiveText, summarizeToolArguments } from "../server/tools";

test("blocks credential files and redacts secrets from public text", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-security-"));
  try {
    writeFileSync(path.join(directory, ".env.local"), "DEEPSEEK_API_KEY=sk-sensitive-value-123456789\n");
    writeFileSync(path.join(directory, ".env.example"), "DEEPSEEK_API_KEY=replace-me\n");
    await assert.rejects(
      executeRuntimeTool({ args: { path: ".env.local" }, name: "read_file", projectRoot: directory }),
      /不允许读取/
    );
    const listed = await executeRuntimeTool({ args: {}, name: "list_files", projectRoot: directory });
    assert.ok(!listed.output.includes(".env.local"));
    assert.ok(listed.output.includes(".env.example"));
    assert.equal(redactSensitiveText("token sk-sensitive-value-123456789"), "token [REDACTED_API_KEY]");
    assert.ok(!summarizeToolArguments("write_file", { path: "a.ts", content: "private source" }).includes("private source"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("cancelling during approval resolves the interaction without timeline units", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-approval-"));
  mkdirSync(directory, { recursive: true });
  try {
    const store = new SignalStore(directory);
    store.registerSession({ compactThresholdTokens: 850_000, contextWindowTokens: 1_000_000, model: "mock-agent", projectRoot: directory, sessionKey: "session_approval", title: "审批" });
    store.append({ cycleKey: "cycle_approval", payload: { model: "mock-agent", prompt: "删除文件", startedAt: new Date().toISOString() }, sessionKey: "session_approval", topic: "cycle.accepted" });
    store.append({ cycleKey: "cycle_approval", payload: {}, sessionKey: "session_approval", topic: "cycle.executing" });
    const registry = new LiveRegistry();
    const controller = registry.startCycle("cycle_approval");
    const decision = registry.requestApproval({ cycleKey: "cycle_approval", detail: "delete a.ts", sessionKey: "session_approval", signal: controller.signal, store, title: "允许删除？" });
    registry.cancelCycle("cycle_approval");
    assert.equal(await decision, "deny");
    const cycle = store.getCycle("cycle_approval")!;
    assert.equal(cycle.approvals[0].state, "dismissed");
    assert.equal(cycle.units.some((unit) => unit.kind === "approval"), false);
    store.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
