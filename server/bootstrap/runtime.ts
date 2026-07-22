import path from "node:path";
import { RunRegistry } from "../app/runRegistry";
import { Runner } from "../app/runner";
import { capabilitySource } from "../infra/capabilities";
import { contextConfig } from "../infra/contextConfig";
import { DeepSeekProvider } from "../infra/deepseek";
import { MockProvider } from "../infra/mock";
import { resolveProjectRoot } from "../infra/projectRoot";
import { ruleSource } from "../infra/rules";
import { RuntimeStore } from "../infra/runtimeStore";
import { toolHost } from "../infra/tools";
import { commandManager } from "../infra/commandManager";
import { describeWorkspace } from "../infra/workspace";
import { createHttp } from "../transport/http";

export type RuntimeOptions = {
  apiKey?: string;
  authToken?: string;
  dataDirectory: string;
  defaultModel?: string;
  frontendUrl?: string;
  host?: string;
  migrationDirectory?: string;
  port?: number;
  runtimeMode?: string;
  workspaceRoot: string;
};

export type RunningRuntime = {
  close: () => Promise<void>;
  host: string;
  port: number;
};

export async function startRuntime(options: RuntimeOptions): Promise<RunningRuntime> {
  const host = options.host ?? "127.0.0.1";
  const defaultModel = options.defaultModel ?? "deepseek-v4-flash";
  const apiKey = options.apiKey ?? "";
  const context = contextConfig();
  const store = new RuntimeStore(path.resolve(options.dataDirectory), options.migrationDirectory);
  for (const summary of store.listSessions()) {
    const session = store.getSession(summary.sessionId);
    for (const run of session?.runs ?? []) {
      for (const activity of run.activities.filter((item) => item.status === "running" && item.command?.commandId)) {
        store.append({
          activityId: activity.activityId,
          data: {
            body: activity.body || "Runtime 已重启，无法恢复此前托管的命令。",
            command: { ...activity.command, state: "cancelled" as const },
            error: "Runtime 已重启，命令状态不可恢复。",
            finishedAt: new Date().toISOString(),
            status: "cancelled" as const
          },
          runId: run.runId,
          sessionId: session!.sessionId,
          type: "activity.finished"
        });
      }
    }
  }
  const registry = new RunRegistry();
  const runner = new Runner(toolHost, ruleSource, capabilitySource, context);
  const app = createHttp({
    capabilities: capabilitySource,
    commands: commandManager,
    config: {
      authToken: options.authToken,
      context,
      dataDirectory: path.resolve(options.dataDirectory),
      defaultModel,
      frontendUrl: options.frontendUrl ?? "http://127.0.0.1:5173/",
      hasApiKey: Boolean(apiKey),
      workspaceRoot: path.resolve(options.workspaceRoot)
    },
    providerFor(model) {
      const mock = model === "mock-agent" || options.runtimeMode === "mock" || !apiKey;
      return mock
        ? { model: "mock-agent", provider: new MockProvider() }
        : { model, provider: new DeepSeekProvider(apiKey) };
    },
    registry,
    resolveProjectRoot,
    rules: ruleSource,
    run: (input) => runner.run(input),
    store,
    tools: toolHost.specs,
    workspaceInfo: describeWorkspace
  });

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    app.server.closeAllConnections();
    await registry.cancelAllAndWait();
    await commandManager.stopAll();
    await app.close().catch(() => undefined);
    store.close();
  };

  try {
    const address = await app.listen({ host, port: options.port ?? 0 });
    const parsed = new URL(address);
    return { close, host, port: Number(parsed.port) };
  } catch (error) {
    await close();
    throw error;
  }
}
