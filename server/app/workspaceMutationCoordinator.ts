type Waiter = {
  reject: (error: unknown) => void;
  resolve: (release: () => void) => void;
  signal?: AbortSignal;
};

export class WorkspaceMutationCoordinator {
  private readonly active = new Set<string>();
  private readonly queues = new Map<string, Waiter[]>();
  private readonly commandLeases = new Map<string, () => void>();

  acquire(projectRoot: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("等待工作区写入锁时运行已取消。", "AbortError"));
    const key = projectRoot
      .replaceAll("\\", "/")
      .replace(/\/{2,}/g, "/")
      .replace(/\/$/, "") || "/";
    if (!this.active.has(key)) {
      this.active.add(key);
      return Promise.resolve(this.releaseFor(key));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { reject, resolve, signal };
      const aborted = () => {
        const queue = this.queues.get(key);
        if (queue) this.queues.set(key, queue.filter((item) => item !== waiter));
        reject(signal?.reason ?? new DOMException("等待工作区写入锁时运行已取消。", "AbortError"));
      };
      signal?.addEventListener("abort", aborted, { once: true });
      const originalResolve = waiter.resolve;
      waiter.resolve = (release) => {
        signal?.removeEventListener("abort", aborted);
        originalResolve(release);
      };
      const queue = this.queues.get(key) ?? [];
      queue.push(waiter);
      this.queues.set(key, queue);
    });
  }

  retainForCommand(commandId: string, release: () => void): void {
    this.commandLeases.get(commandId)?.();
    this.commandLeases.set(commandId, release);
  }

  releaseCommand(commandId?: string): void {
    if (!commandId) return;
    const release = this.commandLeases.get(commandId);
    this.commandLeases.delete(commandId);
    release?.();
  }

  private releaseFor(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const queue = this.queues.get(key) ?? [];
      const next = queue.shift();
      if (queue.length === 0) this.queues.delete(key);
      else this.queues.set(key, queue);
      if (next) next.resolve(this.releaseFor(key));
      else this.active.delete(key);
    };
  }
}

export const workspaceMutationCoordinator = new WorkspaceMutationCoordinator();
