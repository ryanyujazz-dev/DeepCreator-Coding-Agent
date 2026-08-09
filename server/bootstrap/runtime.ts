import path from "node:path";
import { RunRegistry } from "../app/runRegistry";
import { RunLauncher, RunLaunchPort } from "../app/runLauncher";
import { Runner } from "../app/runner";
import { CancelRun } from "../app/cancelRun";
import { ContextQueries } from "../app/contextQueries";
import { FollowUpService } from "../app/followUps";
import { SessionService } from "../app/sessionService";
import { StartRun } from "../app/startRun";
import { WorkspaceQueries } from "../app/workspaceQueries";
import { capabilitySource } from "../infra/capabilities";
import { contextConfig } from "../infra/contextConfig";
import { DeepSeekProvider } from "../infra/deepseek";
import { ZhipuProvider } from "../infra/zhipu";
import { MockProvider } from "../infra/mock";
import { resolveProjectRoot } from "../infra/projectRoot";
import { ruleSource } from "../infra/rules";
import { RuntimeStore } from "../infra/runtimeStore";
import { toolHost } from "../infra/tools";
import { commandManager } from "../infra/commandManager";
import { workspaceQueryPort } from "../infra/workspace";
import { ensureScratchWorkspace } from "../infra/sessionWorkspace";
import { nodeSystem } from "../infra/system";
import { createHttp } from "../transport/http";
import { ModelOption, ModelProtocol, ProviderFamily } from "../../shared/contracts/provider";
import { DelegationCoordinator } from "../app/delegationCoordinator";
import { DeveloperEvalService } from "../transport/http";
import { ContextPort, EventPort, SessionPort } from "../app/runtimeRepo";
import { SystemPort } from "../app/systemPort";

export type RuntimeOptions = {
  apiKey?: string;
  authToken?: string;
  dataDirectory: string;
  defaultModel?: string;
  evalServiceFactory?: (deps: {
    launchRun: RunLaunchPort;
    repositoryRoot: string;
    startRun: StartRun;
    store: ContextPort & EventPort & SessionPort;
    system: SystemPort;
  }) => Promise<DeveloperEvalService>;
  evalRepositoryRoot?: string;
  frontendUrl?: string;
  host?: string;
  migrationDirectory?: string;
  modelProtocols?: Record<string, ModelProtocol>;
  port?: number;
  runtimeMode?: string;
  workspaceRoot: string;
  zhipuApiKey?: string;
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
    provider: "deepseek",
    defaultProtocol: "responses",
    supportedProtocols: ["responses", "chat"]
  },
  {
    description: "DeepSeek V4 Pro — 旗舰推理模型,适合复杂分析和架构设计",
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "deepseek",
    defaultProtocol: "chat",
    supportedProtocols: ["chat"]
  },
  {
    description: "智谱 GLM-5.2 — 旗舰模型,深度思考与 Agent 能力强",
    id: "glm-5.2",
    label: "GLM-5.2",
    provider: "zhipu",
    defaultProtocol: "chat",
    supportedProtocols: ["chat"]
  },
  {
    description: "智谱 GLM-5-Turbo — 轻量快速版,高性价比",
    id: "glm-5-turbo",
    label: "GLM-5-Turbo",
    provider: "zhipu",
    defaultProtocol: "chat",
    supportedProtocols: ["chat"]
  },
  {
    description: "内置 Mock — 无需 API Key,用于离线测试",
    id: "mock-agent",
    label: "Mock Agent",
    provider: "mock",
    defaultProtocol: "chat",
    supportedProtocols: ["chat"]
  }
];

export const SUMMARY_MODEL_BY_PROVIDER: Record<ProviderFamily, string> = {
  deepseek: "deepseek-v4-flash",
  mock: "mock-agent",
  zhipu: "glm-5-turbo"
};

function familyOf(modelId: string): ProviderFamily {
  const entry = MODEL_REGISTRY.find((item) => item.id === modelId);
  if (entry) return entry.provider;
  // 兜底:未注册的模型按前缀推断
  if (/^glm[-.]/i.test(modelId)) return "zhipu";
  if (modelId === "mock-agent") return "mock";
  return "deepseek";
}

function protocolOf(modelId: string, overrides: Record<string, ModelProtocol> = {}): ModelProtocol {
  const model = MODEL_REGISTRY.find((item) => item.id === modelId);
  const selected = overrides[modelId] ?? model?.defaultProtocol ?? "chat";
  if (model?.supportedProtocols && !model.supportedProtocols.includes(selected)) {
    throw new Error(`模型 ${modelId} 不支持 ${selected === "responses" ? "Responses" : "Chat"} 协议。`);
  }
  return selected;
}

export async function startRuntime(options: RuntimeOptions): Promise<RunningRuntime> {
  const host = options.host ?? "127.0.0.1";
  const defaultModel = options.defaultModel ?? "deepseek-v4-flash";
  const apiKey = options.apiKey ?? "";
  const context = contextConfig();
  const system = nodeSystem;
  const store = new RuntimeStore(path.resolve(options.dataDirectory), options.migrationDirectory, system);
  const registry = new RunRegistry(system);
  const runner = new Runner(toolHost, ruleSource, capabilitySource, context);
  // Provider 单例化:DeepSeekProvider/ZhipuProvider 无状态,缓存后避免每次 providerFor 都 new,
  // 未来也可在单例上加余额缓存/限流等有状态能力。MockProvider 同理。
  const deepseekProvider = new DeepSeekProvider(apiKey);
  const zhipuApiKey = options.zhipuApiKey ?? "";
  const zhipuProvider = new ZhipuProvider(zhipuApiKey);
  const mockProvider = new MockProvider();
  // 模型路由:基于模型注册表的 provider 家族路由。
  const providerFor = (model: string, protocol: ModelProtocol = protocolOf(model, options.modelProtocols)) => {
    const family = familyOf(model);
    const isMock = family === "mock" || options.runtimeMode === "mock" || (!apiKey && !zhipuApiKey);
    if (isMock) return { model: "mock-agent", protocol, provider: mockProvider, summaryModel: SUMMARY_MODEL_BY_PROVIDER.mock };
    if (family === "zhipu") {
      if (!zhipuApiKey) throw new Error(`模型 ${model} 需要智谱 API Key，但未配置。请在 ~/.deepcreator/config.json 设置 zhipuApiKey。`);
      if (protocol !== "chat") throw new Error(`模型 ${model} 目前只支持 Chat 协议。`);
      return { model, protocol, provider: zhipuProvider, summaryModel: SUMMARY_MODEL_BY_PROVIDER.zhipu };
    }
    if (family === "deepseek") {
      if (!apiKey) throw new Error(`模型 ${model} 需要 DeepSeek API Key，但未配置。`);
      if (protocol === "responses" && model !== "deepseek-v4-flash") throw new Error(`模型 ${model} 目前不支持 Responses 协议。`);
      return { model, protocol, provider: deepseekProvider, summaryModel: SUMMARY_MODEL_BY_PROVIDER.deepseek };
    }
    return { model: "mock-agent", protocol: "chat" as const, provider: mockProvider, summaryModel: SUMMARY_MODEL_BY_PROVIDER.mock };
  };
  const launcher = new RunLauncher(providerFor, registry, (input) => runner.run(input), store);
  const delegations = new DelegationCoordinator(launcher, registry, store, system);
  runner.setDelegationCoordinator(delegations);
  delegations.recover();
  const startRun = new StartRun({
    context,
    defaultModel,
    launcher,
    protocolForModel: (model) => protocolOf(model, options.modelProtocols),
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
  const followUps = new FollowUpService({ registry, startRun, store, system });
  followUps.recover();
  const evals = options.evalServiceFactory ? await options.evalServiceFactory({
    launchRun: launcher,
    repositoryRoot: path.resolve(options.evalRepositoryRoot ?? options.workspaceRoot),
    startRun,
    store,
    system
  }) : undefined;
  const app = createHttp({
    cancelRun: new CancelRun(registry, commandManager),
    config: {
      authToken: options.authToken,
      context,
      dataDirectory: path.resolve(options.dataDirectory),
      defaultModel,
      evalsEnabled: Boolean(evals),
      frontendUrl: options.frontendUrl ?? "http://127.0.0.1:5173/",
      hasApiKey: Boolean(apiKey) || Boolean(zhipuApiKey),
      models: MODEL_REGISTRY,
      workspaceRoot: path.resolve(options.workspaceRoot)
    },
    contextQueries,
    evals,
    followUps,
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
    await evals?.shutdown();
    await registry.cancelAllAndWait();
    await commandManager.stopAll();
    await evals?.close();
    followUps.close();
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
