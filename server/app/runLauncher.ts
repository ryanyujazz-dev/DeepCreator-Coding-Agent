import { Provider } from "../../shared/contracts/provider";
import { finishRun } from "./runLifecycle";
import { RunRegistry } from "./runRegistry";
import { RunInput, RunnerPorts } from "./runner";

export type ProviderSelection = { model: string; provider: Provider; summaryModel?: string };

export type LaunchRunInput = {
  continuation?: boolean;
  model: string;
  projectRoot: string;
  prompt: string;
  runId: string;
  sessionId: string;
};

export interface RunLaunchPort {
  launch(input: LaunchRunInput): void;
}

export class RunLauncher implements RunLaunchPort {
  constructor(
    private readonly providerFor: (model: string) => ProviderSelection,
    private readonly registry: RunRegistry,
    private readonly run: (input: Omit<RunInput, "tools">) => Promise<void>,
    private readonly store: RunnerPorts
  ) {}

  launch(input: LaunchRunInput): void {
    if (this.registry.hasRun(input.runId)) {
      this.registry.afterRun(input.runId, () => this.launch(input));
      return;
    }
    const controller = this.registry.startRun(input.runId);
    const selected = this.providerFor(input.model);
    void this.run({
      continuation: input.continuation,
      model: selected.model,
      projectRoot: input.projectRoot,
      prompt: input.prompt,
      provider: selected.provider,
      summaryModel: selected.summaryModel,
      registry: this.registry,
      runId: input.runId,
      sessionId: input.sessionId,
      signal: controller.signal,
      store: this.store
    }).catch((error) => {
      const run = this.store.getRun(input.runId);
      if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return;
      const cancelled = controller.signal.aborted;
      finishRun({
        answer: cancelled ? "运行已取消。" : "本次运行未能完成。",
        error: cancelled ? "用户取消了运行。" : error instanceof Error ? error.message : String(error),
        failureType: cancelled ? "cancelled" : "runtime_error",
        projectRoot: input.projectRoot,
        runId: input.runId,
        sessionId: input.sessionId,
        status: cancelled ? "cancelled" : "failed",
        store: this.store,
        system: this.registry.system
      });
    }).finally(() => this.registry.finishRun(input.runId));
  }
}
