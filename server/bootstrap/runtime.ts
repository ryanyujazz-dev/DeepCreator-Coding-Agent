import path from "node:path";
import { randomUUID } from "node:crypto";
import { RunRegistry } from "../app/runRegistry";
import { RunLauncher } from "../app/runLauncher";
import { Runner } from "../app/runner";
import { CancelRun } from "../app/cancelRun";
import { ContextQueries } from "../app/contextQueries";
import { SessionService } from "../app/sessionService";
import { StartRun } from "../app/startRun";
import { WorkspaceQueries } from "../app/workspaceQueries";
import { capabilitySource } from "../infra/capabilities";
import { contextConfig } from "../infra/contextConfig";
import { DeepSeekProvider } from "../infra/deepseek";
import { ZhipuProvider } from "../infra/zhipu";
import { MockProvider } from "../infra/mock";
import { ensureProjectSetup } from "../infra/projectSetup";
import { resolveProjectRoot } from "../infra/projectRoot";
import { ruleSource } from "../infra/rules";
import { RuntimeStore } from "../infra/runtimeStore";
import { toolHost } from "../infra/tools";
import { loadUserConfig } from "../infra/userConfig";
import { commandManager } from "../infra/commandManager";
import { workspaceQueryPort } from "../infra/workspace";
import { ensureScratchWorkspace } from "../infra/sessionWorkspace";
import { createHttp } from "../transport/http";
import { ModelOption, ProviderFamily } from "../../shared/contracts/provider";

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

// ─────────────────────────────────────────────────────────────────────────────
// 模型注册表
//
// 所有可选模型的元数据。providerFor 基于此路由,前端基于此渲染选择器。
// 新增模型只需在此追加一项 + 确保 provider 支持即可。
// ─────────────────────────────────────────────────────────────────────────────

export const MODEL_REGISTRY: ModelOption[] = [
  {
    description: "DeepSeek V4 Flash — 快速、经济,适合日常编程任务",
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    provider: "deepseek"
  },
  {
    description: "DeepSeek V4 Pro — 旗舰推理模型,适合复杂分析和架构设计",
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "deepseek"
  },
  {
    description: "智谱 GLM-5.2 — 旗舰模型,深度思考与 Agent 能力强",
    id: "glm-5.2",
    label: "GLM-5.2",
    provider: "zhipu"
  },
  {
    description: "智谱 GLM-5-Turbo — 轻量快速版,高性价比",
    id: "glm-5-turbo",
    label: "GLM-5-Turbo",
    provider: "zhipu"
  },
  {
    description: "内置 Mock — 无需 API Key,用于离线测试",
    id: "mock-agent",
    label: "Mock Agent",
    provider: "mock"
  }
];

function familyOf(modelId: string): ProviderFamily {
  const entry = MODEL_REGISTRY.find((item) => item.id === modelId);
  if (entry) return entry.provider;
  // 兜底:未注册的模型按前缀推断
  if (/^glm[-.]/i.test(modelId)) return "zhipu";
  if (modelId === "mock-agent") return "mock";
  return "deepseek";
}

export async function startRuntime(options: RuntimeOptions): Promise<RunningRuntime> {
  const host = options.host ?? "127.0.0.1";
  const defaultModel = options.defaultModel ?? "deepseek-v4-flash";
  const apiKey = options.apiKey ?? "";
  const context = contextConfig();
  // ADR-009: 确保项目目录结构就绪(.deepseeker/ + AGENTS.md 模板 + file-history/)
  ensureProjectSetup(options.workspaceRoot);
  const store = new RuntimeStore(path.resolve(options.dataDirectory), options.migrationDirectory);
  for (const summary of store.listSessions()) {
    const session = store.getSession(summary.sessionId);
    for (const run of session?.runs ?? []) {
      for (const activity of run.activities.filter((item) => item.status === "running" && item.command?.commandId)) {
        store.append({
          activityId: activity.activityId,
          data: {
            body: activity.body || "Runtime 已重启，无法恢复此前托管的命令。",
            command: { command: activity.command?.command ?? "", ...activity.command, state: "cancelled" as const },
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
  // Provider 单例化:DeepSeekProvider/ZhipuProvider 无状态,缓存后避免每次 providerFor 都 new,
  // 未来也可在单例上加余额缓存/限流等有状态能力。MockProvider 同理。
  const deepseekProvider = new DeepSeekProvider(apiKey);
  // ADR-009: zhipuApiKey 直接从 ~/.deepseeker/config.json 读取,不走 env 链路。
  // DeepSeek 的 key 因为有 safeStorage 降级历史才走 env,zhipu 没有历史包袱。
  const zhipuApiKey = loadUserConfig().zhipuApiKey ?? "";
  const zhipuProvider = new ZhipuProvider(zhipuApiKey);
  const mockProvider = new MockProvider();
  // 模型路由:基于模型注册表的 provider 家族路由。
  const providerFor = (model: string) => {
    const family = familyOf(model);
    const isMock = family === "mock" || options.runtimeMode === "mock" || (!apiKey && !zhipuApiKey);
    if (isMock) return { model: "mock-agent", provider: mockProvider };
    if (family === "zhipu") {
      if (!zhipuApiKey) throw new Error(`模型 ${model} 需要智谱 API Key，但未配置。请在 ~/.deepseeker/config.json 设置 zhipuApiKey。`);
      return { model, provider: zhipuProvider };
    }
    if (family === "deepseek") {
      if (!apiKey) throw new Error(`模型 ${model} 需要 DeepSeek API Key，但未配置。`);
      return { model, provider: deepseekProvider };
    }
    return { model: "mock-agent", provider: mockProvider };
  };
  const launcher = new RunLauncher(providerFor, registry, (input) => runner.run(input), store);
  const system = {
    createId: (prefix: string) => `${prefix}_${randomUUID()}`,
    now: () => new Date().toISOString()
  };
  const startRun = new StartRun({
    context,
    defaultModel,
    launcher,
    store,
    system,
    workspace: {
      canonicalize: (targetPath) => path.resolve(targetPath),
      ensureScratch: (sessionId) => ensureScratchWorkspace(path.resolve(options.dataDirectory), sessionId),
      resolveProjectRoot
    },
    workspaceRoot: path.resolve(options.workspaceRoot)
  });
  const contextQueries = new ContextQueries({
    capabilities: capabilitySource,
    context,
    defaultModel,
    rules: ruleSource,
    store,
    system,
    tools: toolHost.specs,
    workspaceRoot: path.resolve(options.workspaceRoot)
  });
  const app = createHttp({
    cancelRun: new CancelRun(registry, commandManager),
    config: {
      authToken: options.authToken,
      context,
      dataDirectory: path.resolve(options.dataDirectory),
      defaultModel,
      frontendUrl: options.frontendUrl ?? "http://127.0.0.1:5173/",
      hasApiKey: Boolean(apiKey) || Boolean(zhipuApiKey),
      models: MODEL_REGISTRY,
      workspaceRoot: path.resolve(options.workspaceRoot)
    },
    contextQueries,
    launcher,
    providerFor,
    registry,
    sessions: new SessionService(store),
    startRun,
    store,
    workspace: new WorkspaceQueries(store, workspaceQueryPort)
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
