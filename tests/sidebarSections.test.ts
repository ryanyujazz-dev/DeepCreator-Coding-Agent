import assert from "node:assert/strict";
import test from "node:test";
import { ProjectRef } from "../shared/contracts/desktop";
import { SessionSummary } from "../shared/contracts/runtime";
import { partitionSidebarItems } from "../src/components/SessionSidebar";

function project(path: string, pinned = false): ProjectRef {
  return { lastOpenedAt: "2026-07-22T00:00:00.000Z", name: path, path, pinned };
}

function session(sessionId: string, projectRoot: string, pinned = false, workspaceKind: SessionSummary["workspaceKind"] = "project"): SessionSummary {
  return {
    active: false,
    createdAt: "2026-07-22T00:00:00.000Z",
    model: "deepseek-v4-flash",
    pinned,
    projectRoot,
    runCount: 1,
    sessionId,
    title: sessionId,
    updatedAt: "2026-07-22T00:00:00.000Z",
    workspaceKind
  };
}

test("separates pinned projects and tasks from the regular project area", () => {
  const sections = partitionSidebarItems(
    ["alpha", "beta"],
    [project("alpha", true), project("beta")],
    [session("alpha-task", "alpha"), session("pinned-task", "beta", true), session("regular-task", "beta")]
  );

  assert.equal(sections.hasPinnedItems, true);
  assert.deepEqual(sections.pinnedProjectRoots, ["alpha"]);
  assert.deepEqual(sections.pinnedSessions.map((item) => item.sessionId), ["pinned-task"]);
  assert.deepEqual(sections.regularProjectRoots, ["beta"]);
  assert.deepEqual(sections.regularScratchSessions, []);
});

test("keeps scratch tasks in their own section and removes pinned duplicates", () => {
  const sections = partitionSidebarItems(
    ["alpha"],
    [project("alpha")],
    [session("scratch", "hidden-hash", false, "scratch"), session("pinned-scratch", "hidden-hash-2", true, "scratch")]
  );

  assert.deepEqual(sections.regularScratchSessions.map((item) => item.sessionId), ["scratch"]);
  assert.deepEqual(sections.pinnedSessions.map((item) => item.sessionId), ["pinned-scratch"]);
  assert.deepEqual(sections.regularProjectRoots, []);
});

test("removes a project group after its final project task is deleted", () => {
  const sections = partitionSidebarItems(
    ["empty", "occupied"],
    [project("empty"), project("occupied")],
    [session("remaining-task", "occupied")]
  );

  assert.deepEqual(sections.regularProjectRoots, ["occupied"]);
});

test("omits the pinned area when no project or task is pinned", () => {
  const sections = partitionSidebarItems(
    ["alpha"],
    [project("alpha")],
    [session("regular-task", "alpha")]
  );

  assert.equal(sections.hasPinnedItems, false);
  assert.deepEqual(sections.pinnedProjectRoots, []);
  assert.deepEqual(sections.pinnedSessions, []);
});
