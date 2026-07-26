import { Provider } from "../../shared/contracts/provider";

export type ProviderRetryNotice = {
  attempt: number;
  maxAttempts: number;
};

export type ProviderRetryPolicy = {
  baseDelayMs: number;
  maxAttempts: number;
};

const defaultRetryPolicy: ProviderRetryPolicy = {
  baseDelayMs: 400,
  maxAttempts: 3
};

function isTransientProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|\b5\d\d\b|fetch failed|network|socket|timeout/i.test(message);
}

function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("运行已取消。", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("运行已取消。", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function streamProviderWithRecovery(input: {
  onRetry?: (notice: ProviderRetryNotice) => void;
  policy?: ProviderRetryPolicy;
  provider: Provider;
  request: Parameters<Provider["stream"]>[0];
  signal?: AbortSignal;
}): Promise<Awaited<ReturnType<Provider["stream"]>>> {
  const policy = input.policy ?? defaultRetryPolicy;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    let receivedFragment = false;
    try {
      return await input.provider.stream({
        ...input.request,
        onFragment: (fragment) => {
          receivedFragment = true;
          input.request.onFragment?.(fragment);
        }
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const canRetry = isTransientProviderError(error)
        && !receivedFragment
        && attempt < policy.maxAttempts;
      if (!canRetry) throw error;
      input.onRetry?.({ attempt: attempt + 1, maxAttempts: policy.maxAttempts });
      await waitForRetry(policy.baseDelayMs * 2 ** (attempt - 1), input.signal);
    }
  }
  throw new Error("Provider 重试已耗尽。");
}
