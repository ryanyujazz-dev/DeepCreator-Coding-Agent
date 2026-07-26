import { ModelMessage, Provider } from "../../shared/contracts/provider";
import { prompts } from "./prompts";

export const THINKING_SUMMARY_LIMITS = {
  firstHardChars: 700,
  firstMaxWaitMs: 5_000,
  firstNaturalMinChars: 300,
  firstTimedMinChars: 120,
  historyChars: 32_000,
  maxStepChars: 32_000
} as const;

type ThinkingSummaryLoopInput = {
  initialThinking?: string;
  initialTitle?: string;
  model: string;
  onTitle: (title: string) => void;
  provider: Provider;
  signal?: AbortSignal;
};

type SummaryJob = {
  kind: "first_early" | "first_final" | "first_retry" | "step";
  thinking: string;
};

const TITLE_MAX_CHARS = 60;
const TITLE_MAX_CHINESE_CHARS = 18;
const TITLE_MIN_CHINESE_CHARS = 6;
const TITLE_MAX_WORDS = 10;
const TITLE_MIN_WORDS = 3;

function hasNaturalParagraph(text: string): boolean {
  for (const match of text.matchAll(/\n\s*\n|\n/gu)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end >= THINKING_SUMMARY_LIMITS.firstNaturalMinChars) return true;
  }
  return false;
}

export function shouldStartFirstSummary(text: string, elapsedMs: number): boolean {
  if (text.length >= THINKING_SUMMARY_LIMITS.firstHardChars) return true;
  if (text.length >= THINKING_SUMMARY_LIMITS.firstNaturalMinChars && hasNaturalParagraph(text)) return true;
  return elapsedMs >= THINKING_SUMMARY_LIMITS.firstMaxWaitMs
    && text.length >= THINKING_SUMMARY_LIMITS.firstTimedMinChars;
}

export function parseThinkingTitle(output: string): string | undefined {
  const objects = output.match(/\{[\s\S]*?\}/gu);
  if (!objects || objects.length !== 1) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(objects[0]);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.title !== "string") return undefined;
  const title = record.title.trim();
  const chars = Array.from(title);
  if (!title || chars.length > TITLE_MAX_CHARS || /[\r\n]/u.test(title)) return undefined;
  if (/[#*_`~]/u.test(title) || /[。！？.!?；;，,：:]$/u.test(title)) return undefined;
  if (/^(?:已)?完成/u.test(title) || /已(?:修复|确认|发现)|成功|完成了/u.test(title)) return undefined;
  if (/\b(?:finished|completed|fixed|confirmed|found)\b/iu.test(title)) return undefined;
  if (/\p{Script=Han}/u.test(title)) {
    if (chars.length < TITLE_MIN_CHINESE_CHARS || chars.length > TITLE_MAX_CHINESE_CHARS) return undefined;
  } else {
    const words = title.split(/\s+/u).filter(Boolean);
    if (words.length < TITLE_MIN_WORDS || words.length > TITLE_MAX_WORDS) return undefined;
  }
  return title;
}

export class ThinkingSummaryLoop {
  private readonly abortController = new AbortController();
  private readonly history: ModelMessage[] = [];
  private readonly parentAbort = () => this.cancel();
  private accepting = true;
  private activeJob?: SummaryJob;
  private closed = false;
  private currentTitle?: string;
  private firstEarlyStatus: "not_started" | "in_flight" | "succeeded" | "failed" = "not_started";
  private firstStepEndedText?: string;
  private firstThinkingStartedAt?: number;
  private firstThinkingStepDone = false;
  private firstTimer?: ReturnType<typeof setTimeout>;
  private initialTitle?: string;
  private pendingJob?: SummaryJob;
  private retryQueued = false;
  private settleWaiters: Array<() => void> = [];
  private stepBuffer = "";

  constructor(private readonly input: ThinkingSummaryLoopInput) {
    this.currentTitle = input.initialTitle;
    if (input.initialTitle && input.initialThinking) {
      this.history.push(
        { role: "user", text: JSON.stringify({ thinking: input.initialThinking.slice(-THINKING_SUMMARY_LIMITS.maxStepChars) }) },
        { role: "assistant", text: JSON.stringify({ title: input.initialTitle }) }
      );
    } else {
      this.initialTitle = input.initialTitle;
    }
    if (input.signal?.aborted) this.cancel();
    else input.signal?.addEventListener("abort", this.parentAbort, { once: true });
  }

  append(text: string): void {
    if (!this.accepting || !text) return;
    if (!this.stepBuffer && !this.firstThinkingStepDone && this.firstThinkingStartedAt === undefined) {
      this.firstThinkingStartedAt = Date.now();
      this.firstTimer = setTimeout(() => this.maybeStartFirstSummary(), THINKING_SUMMARY_LIMITS.firstMaxWaitMs);
    }
    this.stepBuffer = `${this.stepBuffer}${text}`.slice(-THINKING_SUMMARY_LIMITS.maxStepChars);
    this.maybeStartFirstSummary();
  }

  endModelStep(): void {
    if (this.closed) return;
    this.clearFirstTimer();
    const thinking = this.takeStepBuffer();
    this.firstThinkingStartedAt = undefined;
    if (!thinking) return;

    if (!this.firstThinkingStepDone) {
      this.firstThinkingStepDone = true;
      this.firstStepEndedText = thinking;
      if (this.firstEarlyStatus === "not_started") {
        this.enqueue({ kind: "first_final", thinking });
      } else if (this.firstEarlyStatus === "failed") {
        this.queueFirstRetry();
      }
      return;
    }

    this.enqueue({ kind: "step", thinking });
  }

  async finish(timeoutMs = 2_000): Promise<void> {
    if (this.closed) return;
    this.endModelStep();
    this.accepting = false;
    if (!this.activeJob && !this.pendingJob) {
      this.closeCleanly();
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((resolve) => this.settleWaiters.push(resolve)),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      })
    ]);
    if (timeout) clearTimeout(timeout);
    if (this.activeJob || this.pendingJob) {
      this.pendingJob = undefined;
      this.abortController.abort();
    }
    this.closeCleanly();
  }

  cancel(): void {
    if (this.closed) return;
    this.accepting = false;
    this.closed = true;
    this.clearFirstTimer();
    this.stepBuffer = "";
    this.pendingJob = undefined;
    this.abortController.abort();
    this.detachParentSignal();
    this.resolveWaiters();
  }

  private maybeStartFirstSummary(): void {
    if (this.firstThinkingStepDone || this.firstEarlyStatus !== "not_started" || !this.stepBuffer) return;
    const elapsedMs = Date.now() - (this.firstThinkingStartedAt ?? Date.now());
    if (!shouldStartFirstSummary(this.stepBuffer, elapsedMs)) return;
    this.firstEarlyStatus = "in_flight";
    this.clearFirstTimer();
    this.enqueue({ kind: "first_early", thinking: this.stepBuffer });
  }

  private takeStepBuffer(): string {
    const thinking = this.stepBuffer.trim();
    this.stepBuffer = "";
    return thinking;
  }

  private clearFirstTimer(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.firstTimer = undefined;
  }

  private queueFirstRetry(): void {
    if (this.retryQueued || !this.firstStepEndedText) return;
    this.retryQueued = true;
    this.enqueue({ kind: "first_retry", thinking: this.firstStepEndedText });
  }

  private enqueue(job: SummaryJob): void {
    if (this.closed) return;
    if (!this.activeJob) {
      this.startRequest(job);
      return;
    }
    // A slow summary must not make old step titles replay after newer steps seal.
    this.pendingJob = job;
  }

  private startRequest(job: SummaryJob): void {
    if (this.closed || this.abortController.signal.aborted) return;
    this.activeJob = job;
    const userMessage: ModelMessage = { role: "user", text: JSON.stringify({ thinking: job.thinking }) };
    const messages: ModelMessage[] = [
      { role: "system", text: prompts.get("reasoning_summary", this.input.model).text },
      ...(this.history.length === 0 && this.initialTitle
        ? [{ role: "assistant" as const, text: JSON.stringify({ title: this.initialTitle }) }]
        : []),
      ...this.history,
      userMessage
    ];
    void this.input.provider.stream({
      maxOutputTokens: 96,
      messages,
      model: this.input.model,
      signal: this.abortController.signal,
      thinkingMode: "disabled",
      tools: []
    }).then((response) => {
      const title = parseThinkingTitle(response.answer);
      if (!title) {
        this.handleFailure(job);
        return;
      }
      if (job.kind === "first_early") this.firstEarlyStatus = "succeeded";
      this.history.push(userMessage, { role: "assistant", text: JSON.stringify({ title }) });
      this.initialTitle = undefined;
      this.trimHistory();
      const stale = Boolean(this.pendingJob);
      if ((!stale || !this.currentTitle) && !this.closed && title !== this.currentTitle) {
        this.currentTitle = title;
        try {
          this.input.onTitle(title);
        } catch {
          // A presentation-only summary must never fail the main Run.
        }
      }
    }).catch(() => this.handleFailure(job)).finally(() => {
      this.activeJob = undefined;
      if (this.pendingJob && !this.closed && !this.abortController.signal.aborted) {
        const next = this.pendingJob;
        this.pendingJob = undefined;
        this.startRequest(next);
        return;
      }
      this.resolveWaiters();
    });
  }

  private handleFailure(job: SummaryJob): void {
    if (job.kind === "first_early") this.firstEarlyStatus = "failed";
    if ((job.kind === "first_early" && this.firstStepEndedText) || job.kind === "first_final") {
      this.queueFirstRetry();
    }
  }

  private trimHistory(): void {
    const size = () => this.history.reduce((total, message) => total + (message.text?.length ?? 0), 0);
    while (this.history.length > 2 && size() > THINKING_SUMMARY_LIMITS.historyChars) {
      this.history.splice(0, 2);
    }
  }

  private closeCleanly(): void {
    this.closed = true;
    this.clearFirstTimer();
    this.detachParentSignal();
    this.resolveWaiters();
  }

  private detachParentSignal(): void {
    this.input.signal?.removeEventListener("abort", this.parentAbort);
  }

  private resolveWaiters(): void {
    if (this.activeJob || this.pendingJob) return;
    for (const resolve of this.settleWaiters.splice(0)) resolve();
  }
}
