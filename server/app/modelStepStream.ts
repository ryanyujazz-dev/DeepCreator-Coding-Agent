import { ModelDelta } from "../../shared/contracts/provider";

export type ModelStepStreamCallbacks = {
  appendAnswer: (text: string, firstFragment: boolean, source?: { itemId?: string; outputIndex?: number }) => void;
  appendReasoning: (text: string) => void;
  appendThinking: (text: string) => void;
  endThinking: () => void;
  startVisibleStage: () => void;
};

const FLUSH_CHARS = 48;
const FLUSH_DELAY_MS = 40;

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
