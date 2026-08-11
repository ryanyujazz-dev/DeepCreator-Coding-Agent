import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  encodeRuntimeWorkerControl,
  RUNTIME_WORKER_NODE_BOOTSTRAP,
  runtimeWorkerControlFromLine
} from "../shared/runtimeWorkerProtocol";

test("round-trips Runtime Worker control messages without treating logs as control data", () => {
  const ready = { port: 43123, type: "ready" as const };
  assert.deepEqual(runtimeWorkerControlFromLine(encodeRuntimeWorkerControl(ready).trimEnd()), ready);
  assert.deepEqual(runtimeWorkerControlFromLine(encodeRuntimeWorkerControl({ type: "shutdown" }).trimEnd()), { type: "shutdown" });
  assert.equal(runtimeWorkerControlFromLine("ordinary Runtime output"), undefined);
  assert.equal(runtimeWorkerControlFromLine("__DEEPCREATOR_RUNTIME_CONTROL__not-json"), undefined);
});

test("preloads SQLite before requiring the packaged Runtime Worker entry", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deepcreator-runtime-bootstrap-"));
  const entry = path.join(directory, "entry.cjs");
  try {
    writeFileSync(entry, 'process.stdout.write("DEEPCREATOR_RUNTIME_BOOTSTRAP_READY")');
    const result = spawnSync(process.execPath, ["-e", RUNTIME_WORKER_NODE_BOOTSTRAP, entry], {
      encoding: "utf8",
      timeout: 15_000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DEEPCREATOR_RUNTIME_BOOTSTRAP_READY/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
