import assert from "node:assert/strict";
import test from "node:test";
import { resolveProjectEditorLaunch } from "../desktop/projectLauncher";

test("uses macOS Launch Services without requiring editor shell commands", () => {
  assert.deepEqual(resolveProjectEditorLaunch("/Users/demo/project", "cursor", "darwin"), {
    args: ["-a", "Cursor", "/Users/demo/project"],
    command: "/usr/bin/open"
  });
  assert.deepEqual(resolveProjectEditorLaunch("/Users/demo/project", "vscode", "darwin"), {
    args: ["-a", "Visual Studio Code", "/Users/demo/project"],
    command: "/usr/bin/open"
  });
});

test("resolves allowlisted Windows editor installation paths", () => {
  const environment = { LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local", PROGRAMFILES: "C:\\Program Files" };
  const existing = new Set(["C:\\Users\\demo\\AppData\\Local\\Programs\\cursor\\Cursor.exe"]);
  assert.deepEqual(
    resolveProjectEditorLaunch("C:\\work\\project", "cursor", "win32", environment, (candidate) => existing.has(candidate)),
    {
      args: ["C:\\work\\project"],
      command: "C:\\Users\\demo\\AppData\\Local\\Programs\\cursor\\Cursor.exe"
    }
  );
});

test("reports a recoverable error when a Windows editor is not installed", () => {
  assert.throws(
    () => resolveProjectEditorLaunch("C:\\work\\project", "vscode", "win32", {}, () => false),
    /未找到 Visual Studio Code/
  );
});

test("uses the installed editor command on Linux", () => {
  assert.deepEqual(resolveProjectEditorLaunch("/home/demo/project", "vscode", "linux"), {
    args: ["/home/demo/project"],
    command: "code"
  });
});
