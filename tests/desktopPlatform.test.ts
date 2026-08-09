import assert from "node:assert/strict";
import test from "node:test";
import { desktopErrorMessage } from "../src/platform/desktop";

test("removes Electron IPC boilerplate from desktop errors", () => {
  const error = new Error("Error invoking remote method 'desktop:settings:save': Error: Runtime 启动超时。");

  assert.equal(desktopErrorMessage(error), "Runtime 启动超时。");
});

test("preserves ordinary desktop errors", () => {
  assert.equal(desktopErrorMessage(new Error("保存失败。")), "保存失败。");
});
