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
  return mkdtempSync(path.join(tmpdir(), "deepseeker-managed-command-"));
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
    assert.match(running.commandId, /^command_/);

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
    }, 30);
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
