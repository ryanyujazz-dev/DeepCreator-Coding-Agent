import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CommandManager,
  COMMAND_OUTPUT_MAX_BYTES
} from "../server/infra/commandManager";

function fixture(): string {
  return mkdtempSync(path.join(tmpdir(), "deepcreator-managed-command-"));
}

test("yields a live command and settles it exactly once when stopped", async () => {
  const directory = fixture();
  const manager = new CommandManager();
  let settlements = 0;
  writeFileSync(path.join(directory, "long.cjs"), "setInterval(() => process.stdout.write('tick\\n'), 20);\n");
  try {
    const running = await manager.start({
      activityId: "activity_long",
      command: "node long.cjs",
      onSettled: () => { settlements += 1; },
      projectRoot: directory,
      runId: "run_long",
      sessionId: "session_long"
    }, 30);
    assert.equal(running.state, "running");
    assert.match(running.commandId, /^cmd_[a-z0-9_-]{8}$/);

    const waiting = await manager.wait(running.commandId, 30);
    assert.equal(waiting.state, "running");
    const stopped = await manager.stop(running.commandId);
    assert.equal(stopped?.state, "cancelled");
    assert.equal((await manager.stop(running.commandId))?.state, "cancelled");
    assert.equal(settlements, 1);
  } finally {
    await manager.stopAll();
    try {
      rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  }
});

test("returns short command failures without promoting them to background", async () => {
  const directory = fixture();
  const manager = new CommandManager();
  let settlements = 0;
  writeFileSync(path.join(directory, "fail.cjs"), "process.exit(7);\n");
  try {
    const failed = await manager.start({
      activityId: "activity_fail",
      command: "node fail.cjs",
      onSettled: () => { settlements += 1; },
      projectRoot: directory,
      runId: "run_fail",
      sessionId: "session_fail"
    }, 2_000);
    assert.equal(failed.state, "failed");
    assert.equal(failed.exitCode, 7);
    assert.equal(settlements, 0);
  } finally {
    await manager.stopAll();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("cancelling a wait does not stop the managed command", async () => {
  const directory = fixture();
  const manager = new CommandManager();
  writeFileSync(path.join(directory, "long.cjs"), "setInterval(() => undefined, 20);\n");
  try {
    const running = await manager.start({
      activityId: "activity_wait_abort",
      command: "node long.cjs",
      projectRoot: directory,
      runId: "run_original",
      sessionId: "session_wait_abort"
    }, 200);
    const controller = new AbortController();
    const waiting = manager.wait(running.commandId, 5_000, controller.signal);
    controller.abort();

    await assert.rejects(waiting, { name: "AbortError" });
    assert.equal(manager.get(running.commandId)?.state, "running");
    assert.equal((await manager.stop(running.commandId))?.state, "cancelled");
  } finally {
    await manager.stopAll();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("bounds retained command output and reports truncation", async () => {
  const directory = fixture();
  const manager = new CommandManager();
  writeFileSync(path.join(directory, "output.cjs"), `process.stdout.write('x'.repeat(${COMMAND_OUTPUT_MAX_BYTES + 4096}));\n`);
  try {
    const completed = await manager.start({
      activityId: "activity_output",
      command: "node output.cjs",
      projectRoot: directory,
      runId: "run_output",
      sessionId: "session_output"
    }, 5_000);
    assert.equal(completed.state, "completed");
    assert.equal(completed.outputTruncated, true);
    assert.match(completed.output, /Runtime 省略了/);
    assert.ok(Buffer.byteLength(completed.output) < COMMAND_OUTPUT_MAX_BYTES + 1_000);
  } finally {
    await manager.stopAll();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("concurrent waiters all receive the settled snapshot instead of one rejecting", async () => {
  const directory = fixture();
  const manager = new CommandManager();
  writeFileSync(path.join(directory, "long.cjs"), "setTimeout(() => process.exit(0), 150);\n");
  try {
    const running = await manager.start({
      activityId: "activity_concurrent",
      command: "node long.cjs",
      projectRoot: directory,
      runId: "run_concurrent",
      sessionId: "session_concurrent"
    }, 30);
    assert.equal(running.state, "running");
    // 模型在同一轮 tool_calls 里并发 wait 同一条命令是正常用法:
    // 两个 waiter 都应在命令结束后拿到终态,而不是后者抛"已有一个等待操作"。
    const [first, second] = await Promise.all([
      manager.wait(running.commandId, 5_000),
      manager.wait(running.commandId, 5_000)
    ]);
    assert.equal(first.state, "completed");
    assert.equal(second.state, "completed");
    assert.equal(first.commandId, second.commandId);
  } finally {
    await manager.stopAll();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("waitForSettled resolves with each settled background snapshot exactly once", async () => {
  const directory = fixture();
  const manager = new CommandManager();
  // 一条 150ms 后自然退出(后台化)+ 一条常驻(永不退出,验证只有全部终态才唤醒)。
  writeFileSync(path.join(directory, "exits.cjs"), "setTimeout(() => process.exit(0), 150);\n");
  writeFileSync(path.join(directory, "stays.cjs"), "setInterval(() => undefined, 20);\n");
  try {
    const exits = await manager.start({
      activityId: "activity_exits",
      command: "node exits.cjs",
      projectRoot: directory,
      runId: "run_settled",
      sessionId: "session_settled"
    }, 30);
    const stays = await manager.start({
      activityId: "activity_stays",
      command: "node stays.cjs",
      projectRoot: directory,
      runId: "run_settled",
      sessionId: "session_settled"
    }, 30);
    assert.equal(exits.state, "running");
    assert.equal(stays.state, "running");

    const waiting = manager.waitForSettled("run_settled");
    // 命令尚未全部 settle → promise 不得提前 resolve
    const early = await Promise.race([waiting.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))]);
    assert.equal(early, false);

    await manager.stop(stays.commandId);
    const settled = await waiting;
    assert.equal(settled.length, 2); // exits 自然结束 + stays 被 stop → 都进 newlySettled
    assert.ok(settled.every((snapshot) => ["completed", "cancelled", "failed"].includes(snapshot.state)));
    // 消费一次即清空:再次取为空,不会重复注入
    assert.equal(manager.takeSettled("run_settled").length, 0);
    // 全部终态后新调用立即空 resolve
    assert.equal((await manager.waitForSettled("run_settled")).length, 0);
  } finally {
    await manager.stopAll();
    rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});
