import assert from "node:assert/strict";
import test from "node:test";
import { ToolState } from "../shared/contracts/runtime";
import { dominantHeadlineKind, headlineKindForTool, headlineLabel } from "../shared/domain/toolActivitySemantics";

function tool(toolName: string, action: ToolState["action"], normalizedTarget = toolName): ToolState {
  return {
    action,
    argumentsPreview: normalizedTarget,
    callId: `call_${toolName}`,
    effect: action === "modify" ? "workspace_write" : "read_only",
    modelStepId: "step_semantics",
    normalizedTarget,
    targetKind: action === "modify" ? "file" : "workspace",
    toolName
  };
}

test("chooses one dominant headline for a complete mixed tool step", () => {
  const tools = [
    tool("glob", "inspect"),
    tool("grep", "search"),
    tool("read_file", "inspect"),
    tool("edit_file", "modify")
  ];
  assert.deepEqual(tools.map(headlineKindForTool), ["locate", "locate", "read", "modify"]);
  assert.equal(dominantHeadlineKind(tools), "modify");
  assert.equal(headlineLabel("modify"), "修改项目文件");
});

test("classifies verification commands by their actual role", () => {
  assert.equal(headlineKindForTool(tool("run_command", "execute")), "execute");
  assert.equal(headlineKindForTool(tool("run_command", "verify", "npm test")), "verify");
  assert.equal(dominantHeadlineKind([
    tool("edit_file", "modify"),
    tool("run_command", "verify", "npm test")
  ]), "modify_and_verify");
});

test("ignores supporting shell commands when a file operation carries the step", () => {
  assert.equal(dominantHeadlineKind([
    tool("read_file", "inspect", "settings.py"),
    tool("edit_file", "modify", "settings.py"),
    tool("run_command", "execute", "cd backend && echo ready && sleep 1")
  ]), "modify");
});

test("lets recognized process effects outrank incidental reads and edits", () => {
  assert.equal(dominantHeadlineKind([
    tool("read_file", "inspect", "docker-compose.yml"),
    tool("run_command", "execute", "docker compose up -d postgres")
  ]), "start_database");
  assert.equal(dominantHeadlineKind([
    tool("edit_file", "modify", ".env"),
    tool("run_command", "inspect", "docker info")
  ]), "configure_environment");
  assert.equal(dominantHeadlineKind([
    tool("run_command", "execute", "pip install -r requirements.txt"),
    tool("run_command", "execute", "python3 -m alembic upgrade head"),
    tool("run_command", "execute", "python3 seed_data.py")
  ]), "initialize_database");
  assert.equal(dominantHeadlineKind([
    tool("run_command", "execute", "python3 -c \"from app.main import app\"")
  ]), "verify_runtime");
});

test("keeps generic execution below an explicit file mutation", () => {
  assert.equal(dominantHeadlineKind([
    tool("edit_file", "modify", "src/app.ts"),
    tool("run_command", "execute", "./scripts/custom-step")
  ]), "modify");
});

test("summarizes a real environment preparation step by effect instead of command count", () => {
  const tools = [
    tool("read_file", "inspect", ".env.example"),
    tool("read_file", "inspect", "experience.py"),
    tool("read_file", "inspect", "itinerary.py"),
    tool("run_command", "execute", "cd travel_app && docker info > /dev/null 2>&1 && echo running || echo stopped"),
    tool("run_command", "inspect", "which psql && psql --version"),
    tool("run_command", "execute", "pg_isready || echo not-ready"),
    tool("run_command", "execute", "open -a Docker; echo launching"),
    tool("run_command", "inspect", "ls /Applications/Docker.app")
  ];
  assert.equal(dominantHeadlineKind(tools), "prepare_environment");
  assert.equal(headlineLabel("prepare_environment"), "准备运行环境");
});
