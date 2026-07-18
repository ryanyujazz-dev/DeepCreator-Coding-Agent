import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveProjectRoot } from "../server/infra/projectRoot";

test("uses the longest existing leading directory for a new session", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepseeker-root-"));
  const project = path.join(directory, "project with spaces");
  mkdirSync(project);
  try {
    assert.equal(
      await resolveProjectRoot({
        fallbackRoot: directory,
        prompt: `${project}熟悉一下这个项目`
      }),
      project
    );
    assert.equal(
      await resolveProjectRoot({ fallbackRoot: directory, prompt: "分析当前项目" }),
      directory
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
