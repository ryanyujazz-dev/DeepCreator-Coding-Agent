import assert from "node:assert/strict";
import test from "node:test";
import { defaultDraftWorkspace, mostRecentProject } from "../src/workspaceSelection";

const projects = [
  { lastOpenedAt: "2026-07-20T00:00:00.000Z", name: "older", path: "/older" },
  { lastOpenedAt: "2026-07-22T00:00:00.000Z", name: "newer", path: "/newer", pinned: false },
  { lastOpenedAt: "2026-07-18T00:00:00.000Z", name: "pinned", path: "/pinned", pinned: true }
];

test("uses recency rather than sidebar pin order", () => {
  assert.equal(mostRecentProject(projects)?.path, "/newer");
});

test("resolves new task workspace from current, recent, fallback, then scratch", () => {
  assert.deepEqual(defaultDraftWorkspace({ current: { projectRoot: "/current", workspaceKind: "project" }, projects }), { kind: "project", projectRoot: "/current" });
  assert.deepEqual(defaultDraftWorkspace({ current: { projectRoot: "/current", workspaceKind: "project" }, currentExists: false, projects }), { kind: "project", projectRoot: "/newer" });
  assert.deepEqual(defaultDraftWorkspace({ fallbackProjectRoot: "/web", projects: [] }), { kind: "project", projectRoot: "/web" });
  assert.deepEqual(defaultDraftWorkspace({ projects: [] }), { kind: "scratch" });
});
