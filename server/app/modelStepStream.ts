import { ModelDelta } from "../../shared/contracts/provider";

export type ModelStepStreamCallbacks = {
  appendAnswer: (text: string, firstFragment: boolean, source?: { itemId?: string; outputIndex?: number }) => void;
  appendReasoning: (text: string) => void;
  appendThinking: (text: string) => void;
  endThinking: () => void;
  startVisibleStage: () => void;
};

// flush 阈值/间隔。实测(modelStepStream 突发流探针)确认:原 48字/40ms 下,当模型在工具调用前只吐
// 一句短 preamble(< 48 字、无换行 —— DeepSeek 在 edit_file/计划工具前的典型形态),content 既够不到
// 48 字阈值又没换行,只能靠 40ms 定时器;而定时器在突发流/fsync 期间易被饿死、或 tool_call 在 40ms 内
// 就到,于是整段 content 攒在 answerBuffer 直到 tool_call fragment 触发同步 flush —— 而 tool_call flush 与
// tool.started 事件在服务端同一 tick(runner.ts finish→finishActivity→executeToolStep 间无 await),content
// bodyDelta 与 tool.started 一起到前端 → 用户看到「1-2 字先出,工具一开始执行 content 才一口气出来」。
// 降到 8 字:阈值 flush 是【同步】的(不依赖定时器、不等 tool_call),content 在攒满 8 字时立即 flush,
// 把 content 流式与工具执行彻底解耦。配合 database synchronous=NORMAL,高频 flush 不再 per-event fsync。
const FLUSH_CHARS = 8;
const FLUSH_DELAY_MS = 16;

/** Converts provider fragments into bounded UI/Event write batches for one model step. */
export class ModelStepStream {
  private answerBuffer = "";
  private answerStarted = false;
  private answerTimer?: ReturnType<typeof setTimeout>;
  private reasoningBuffer = "";
  private reasoningTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly callbacks: ModelStepStreamCallbacks) {}

  push(fragment: ModelDelta): void {
    if (fragment.kind === "thinking") {
      this.callbacks.appendThinking(fragment.text);
      this.bufferReasoning(fragment.text);
      return;
    }
    if (fragment.kind === "answer") {
      this.callbacks.endThinking();
      this.callbacks.startVisibleStage();
      this.flushReasoning();
      if (!this.answerStarted) {
        this.answerStarted = true;
        this.callbacks.appendAnswer(fragment.text, true, { itemId: fragment.itemId, outputIndex: fragment.outputIndex });
      } else {
        this.bufferAnswer(fragment.text);
      }
      return;
    }
    if (fragment.kind === "tool_call") {
      this.callbacks.endThinking();
      this.callbacks.startVisibleStage();
      this.flush();
    }
  }

  flush(): void {
    this.flushReasoning();
    this.flushAnswer();
  }

  finish(): void {
    this.callbacks.endThinking();
    this.flush();
  }

  private bufferReasoning(text: string): void {
    if (!text) return;
    this.reasoningBuffer += text;
    if (this.reasoningBuffer.length >= FLUSH_CHARS || this.reasoningBuffer.includes("\n")) {
      this.flushReasoning();
      return;
    }
    this.reasoningTimer ??= setTimeout(() => this.flushReasoning(), FLUSH_DELAY_MS);
  }

  private bufferAnswer(text: string): void {
    if (!text) return;
    this.answerBuffer += text;
    if (this.answerBuffer.length >= FLUSH_CHARS || this.answerBuffer.includes("\n")) {
      this.flushAnswer();
      return;
    }
    this.answerTimer ??= setTimeout(() => this.flushAnswer(), FLUSH_DELAY_MS);
  }

  private flushReasoning(): void {
    if (this.reasoningTimer) clearTimeout(this.reasoningTimer);
    this.reasoningTimer = undefined;
    if (!this.reasoningBuffer) return;
    const text = this.reasoningBuffer;
    this.reasoningBuffer = "";
    this.callbacks.appendReasoning(text);
  }

  private flushAnswer(): void {
    if (this.answerTimer) clearTimeout(this.answerTimer);
    this.answerTimer = undefined;
    if (!this.answerBuffer) return;
    const text = this.answerBuffer;
    this.answerBuffer = "";
    this.callbacks.appendAnswer(text, false);
  }
}
