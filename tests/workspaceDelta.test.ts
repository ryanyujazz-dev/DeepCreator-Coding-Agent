import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureWorkspaceBaseline,
  checkpointWorkspaceTarget,
  collectWorkspaceDelta,
  releaseWorkspaceBaseline
} from "../server/tools";

function git(directory: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: directory, stdio: "ignore" });
}

test("reports only changes made after the work-cycle baseline", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-delta-"));
  try {
    git(directory, "init");
    git(directory, "config", "user.email", "runtime@test.local");
    git(directory, "config", "user.name", "Runtime Test");
    writeFileSync(path.join(directory, "already-dirty.ts"), "export const dirty = 1;\n");
    writeFileSync(path.join(directory, "untouched-dirty.ts"), "export const untouched = 1;\n");
    writeFileSync(path.join(directory, "clean-target.ts"), "export const target = 1;\n");
    git(directory, "add", ".");
    git(directory, "commit", "-m", "initial");

    writeFileSync(path.join(directory, "already-dirty.ts"), "export const dirty = 2;\n");
    writeFileSync(path.join(directory, "untouched-dirty.ts"), "export const untouched = 2;\n");
    const baseline = await captureWorkspaceBaseline(directory);
    try {
      const unchanged = await collectWorkspaceDelta(directory, baseline);
      assert.equal(unchanged.fileCount, 0, "pre-existing dirty files are not cycle changes");

      writeFileSync(path.join(directory, "already-dirty.ts"), "export const dirty = 3;\n");
      writeFileSync(path.join(directory, "clean-target.ts"), "export const target = 2;\n");
      writeFileSync(path.join(directory, "created-during-cycle.ts"), "export const created = true;\n");
      const delta = await collectWorkspaceDelta(directory, baseline);

      assert.equal(delta.comparisonBase, "cycle_start");
      assert.deepEqual(
        delta.files.map((file) => file.path).sort(),
        ["already-dirty.ts", "clean-target.ts", "created-during-cycle.ts"]
      );
      assert.ok(!delta.files.some((file) => file.path === "untouched-dirty.ts"));
      assert.equal(delta.fileCount, 3);
    } finally {
      const snapshotDirectory = baseline.snapshotDirectory;
      await releaseWorkspaceBaseline(baseline);
      assert.equal(existsSync(snapshotDirectory), false);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("checkpoints clean direct file targets before mutation", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-checkpoint-"));
  try {
    git(directory, "init");
    git(directory, "config", "user.email", "runtime@test.local");
    git(directory, "config", "user.name", "Runtime Test");
    writeFileSync(path.join(directory, "clean.ts"), "export const value = 1;\n");
    git(directory, "add", ".");
    git(directory, "commit", "-m", "initial");

    const baseline = await captureWorkspaceBaseline(directory);
    try {
      await checkpointWorkspaceTarget(directory, baseline, "clean.ts");
      writeFileSync(path.join(directory, "clean.ts"), "export const value = 2;\n");
      const delta = await collectWorkspaceDelta(directory, baseline);
      assert.deepEqual(delta.files.map((file) => file.path), ["clean.ts"]);
      assert.equal(delta.files[0].operation, "edited");
      assert.ok(delta.files[0].patch?.includes("export const value = 1"));
      assert.ok(delta.files[0].patch?.includes("export const value = 2"));
    } finally {
      await releaseWorkspaceBaseline(baseline);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
