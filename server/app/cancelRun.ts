import { RunRegistry } from "./runRegistry";

export interface CommandControlPort {
  stop(commandId: string): Promise<unknown | undefined>;
  stopRun(runId: string): Promise<unknown>;
}

export class CancelRun {
  constructor(
    private readonly registry: RunRegistry,
    private readonly commands: CommandControlPort
  ) {}

  async execute(runId: string): Promise<{ cancelled: boolean; settled: boolean }> {
    const drained = this.registry.waitForRun(runId);
    const cancelled = this.registry.cancelRun(runId);
    if (!cancelled) return { cancelled: false, settled: false };
    const [settled] = await Promise.all([drained, this.commands.stopRun(runId).then(() => true)]);
    return { cancelled: true, settled };
  }

  async stopCommand(commandId: string): Promise<unknown | undefined> {
    return this.commands.stop(commandId);
  }
}
