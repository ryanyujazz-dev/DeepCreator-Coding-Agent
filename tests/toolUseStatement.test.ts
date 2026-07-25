import assert from "node:assert/strict";
import test from "node:test";
import { ToolCall } from "../shared/contracts/provider";
import { resolveToolUseStatement } from "../server/app/toolUseStatement";

function call(
  callId: string,
  name: string,
  argumentsText: string,
  index = 0
): ToolCall {
  return { argumentsText, callId, index, name };
}

test("arms a standalone declaration and consumes it on the next ordinary batch", () => {
  const declared = resolveToolUseStatement({
    calls: [call("statement_1", "tools_use_statement", JSON.stringify({ mode: "new", title: "分析项目架构" }))],
    contentBoundary: false,
    modelStepId: "step_1"
  });
  const tools = resolveToolUseStatement({
    active: declared.active,
    armed: declared.armed,
    calls: [
      call("read_1", "read_file", JSON.stringify({ path: "src/App.tsx" }), 0),
      call("read_2", "read_file", JSON.stringify({ path: "src/main.tsx" }), 1)
    ],
    contentBoundary: false,
    modelStepId: "step_2"
  });

  assert.equal(declared.kind, "declaration");
  assert.equal(declared.armed?.title, "分析项目架构");
  assert.equal(tools.kind, "tools");
  assert.equal(tools.armed, undefined);
  assert.equal(tools.statementByCallId.get("read_1")?.title, "分析项目架构");
  assert.equal(tools.statementByCallId.get("read_2")?.groupId, declared.active?.groupId);
});

test("continues an active group through another standalone declaration", () => {
  const first = resolveToolUseStatement({
    calls: [call("statement_1", "tools_use_statement", JSON.stringify({ mode: "new", title: "分析项目架构" }))],
    contentBoundary: false,
    modelStepId: "step_1"
  });
  const firstTools = resolveToolUseStatement({
    active: first.active,
    armed: first.armed,
    calls: [call("read_1", "read_file", "{}")],
    contentBoundary: false,
    modelStepId: "step_2"
  });
  const continued = resolveToolUseStatement({
    active: firstTools.active,
    calls: [call("statement_2", "tools_use_statement", JSON.stringify({ mode: "continue" }))],
    contentBoundary: false,
    modelStepId: "step_3"
  });

  assert.equal(continued.kind, "declaration");
  assert.equal(continued.armed?.mode, "continue");
  assert.equal(continued.armed?.groupId, first.active?.groupId);
  assert.equal(continued.armed?.title, "分析项目架构");
});

test("normalizes a repeated new title into the active uninterrupted group", () => {
  const active = {
    groupId: "tool_group:statement_1",
    mode: "new" as const,
    statementId: "statement:statement_1",
    title: "审查项目结构与现状"
  };
  const repeated = resolveToolUseStatement({
    active,
    calls: [
      call(
        "statement_2",
        "tools_use_statement",
        JSON.stringify({ mode: "new", title: "审查项目结构与现状" })
      )
    ],
    contentBoundary: false,
    modelStepId: "step_2"
  });

  assert.equal(repeated.kind, "declaration");
  assert.equal(repeated.armed?.groupId, active.groupId);
  assert.equal(repeated.armed?.mode, "continue");
  assert.equal(repeated.armed?.normalized, true);
});

test("keeps a repeated title separate after assistant content", () => {
  const active = {
    groupId: "tool_group:statement_1",
    mode: "new" as const,
    statementId: "statement:statement_1",
    title: "审查项目结构与现状"
  };
  const repeated = resolveToolUseStatement({
    active,
    calls: [
      call(
        "statement_2",
        "tools_use_statement",
        JSON.stringify({ mode: "new", title: "审查项目结构与现状" })
      )
    ],
    contentBoundary: true,
    modelStepId: "step_2"
  });

  assert.equal(repeated.kind, "declaration");
  assert.notEqual(repeated.armed?.groupId, active.groupId);
  assert.equal(repeated.armed?.mode, "new");
  assert.equal(repeated.armed?.normalized, undefined);
});

test("rejects ordinary tools without an immediately preceding declaration", () => {
  const resolution = resolveToolUseStatement({
    calls: [call("read_1", "read_file", "{}")],
    contentBoundary: false,
    modelStepId: "step_1"
  });

  assert.equal(resolution.kind, "rejected");
  assert.match(resolution.error ?? "", /缺少有效且独立的 tools_use_statement/);
  assert.equal(resolution.statementByCallId.size, 0);
});

test("rejects a declaration mixed with ordinary tools", () => {
  const resolution = resolveToolUseStatement({
    calls: [
      call("statement_1", "tools_use_statement", JSON.stringify({ mode: "new", title: "分析项目" }), 0),
      call("read_1", "read_file", "{}", 1)
    ],
    contentBoundary: false,
    modelStepId: "step_1"
  });

  assert.equal(resolution.kind, "rejected");
  assert.match(resolution.error ?? "", /唯一工具调用/);
});

test("requires a new declaration after assistant content", () => {
  const resolution = resolveToolUseStatement({
    active: {
      groupId: "tool_group:old",
      mode: "new",
      statementId: "statement:old",
      title: "分析项目"
    },
    calls: [call("statement_2", "tools_use_statement", JSON.stringify({ mode: "continue" }))],
    contentBoundary: true,
    modelStepId: "step_2"
  });

  assert.equal(resolution.kind, "rejected");
  assert.match(resolution.error ?? "", /mode="continue"/);
  assert.equal(resolution.active, undefined);
});
