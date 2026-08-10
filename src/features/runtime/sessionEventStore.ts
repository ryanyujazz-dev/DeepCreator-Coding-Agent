import { Event, Session } from "../../../shared/contracts/runtime";
import { reduceEvents } from "../../../shared/domain/reducer";

export type SessionUpdater = Session | null | ((current: Session | null) => Session | null);

/**
 * 可注入的帧调度器,便于测试可控推进。生产默认:浏览器/renderer 用 requestAnimationFrame(对齐画帧),
 * Node 测试环境无 rAF 时回退 setTimeout(0)。
 */
export type FrameScheduler = (callback: () => void) => void;

const defaultScheduler: FrameScheduler =
  typeof requestAnimationFrame === "function"
    ? (callback) => requestAnimationFrame(callback)
    : (callback) => setTimeout(callback, 0);

/**
 * The authoritative client-side Session projection. REST snapshots replace state,
 * while SSE messages can only advance it through the shared Event reducer.
 *
 * 渲染合并(notify coalescing):session 状态在 update 时同步写入(getSnapshot 立即可见最新值),
 * 但对订阅者的通知(emit)合并到每帧最多一次。SSE 流按 chunk 读取,一个 chunk 往往含多条 message,
 * runtimeApi 的读取循环会背靠背调用 applyEvents —— 若每次都同步 emit,React 会被串成多次同步重渲、
 * 饿死画帧(流式「卡一下再一起弹」的成因之一)。改成「标记脏 + 下一帧 emit 一次」后,可见窗口内
 * 突发期间每帧只渲染一次最终态,主线程能在帧间让出,内容平滑递增。
 *
 * useSyncExternalStore 契约:getSnapshot 在两次变更之间返回同一引用(只在 update 时换新引用),
 * 每次让引用变化的变更最终都会通知。延迟通知仍是通知 —— 可见窗口内延迟上限为一帧;但窗口隐藏/
 * 最小化/后台(见 attachVisibilityFlush)rAF 会被浏览器暂停,此时由 visibilitychange 在复可见时
 * 立即 flushPending 把积压通知一次交付,故隐藏期间 UI 冻结、复可见即追平(数据不丢:getSnapshot
 * 始终最新 + SSE 按 afterOffset 断点续传)。
 */
export class SessionEventStore {
  private session: Session | null = null;
  private readonly listeners = new Set<() => void>();
  private notifyScheduled = false;
  private readonly scheduler: FrameScheduler;
  private visibilityHandler: (() => void) | null = null;

  constructor(scheduler: FrameScheduler = defaultScheduler) {
    this.scheduler = scheduler;
  }

  getSnapshot = (): Session | null => this.session;

  subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size === 0) this.attachVisibilityFlush();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.detachVisibilityFlush();
    };
  };

  update(next: SessionUpdater): void {
    const value = typeof next === "function" ? next(this.session) : next;
    if (Object.is(value, this.session)) return;
    this.session = value;
    this.scheduleEmit();
  }

  replaceSnapshot(snapshot: Session): void {
    this.update((current) => {
      if (current?.sessionId !== snapshot.sessionId) return snapshot;
      return snapshot.lastOffset >= current.lastOffset ? snapshot : current;
    });
  }

  applyEvents(sessionId: string, events: Event[]): void {
    if (events.length === 0) return;
    this.update((current) => current?.sessionId === sessionId ? reduceEvents(current, events) : current);
  }

  /** 立即发出任何 pending 通知。供 visibilitychange 复可见、以及测试同步推进时调用。 */
  flushPending(): void {
    if (!this.notifyScheduled) return;
    this.notifyScheduled = false;
    this.emit();
  }

  private scheduleEmit(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    this.scheduler(() => {
      // flushPending(复可见)可能已先发并清标志 → 此回调变 no-op,避免重复 emit。
      if (!this.notifyScheduled) return;
      this.notifyScheduled = false;
      this.emit();
    });
  }

  private emit(): void {
    // 单个 listener 抛错不得中断同帧其他 listener(否则本次合并的通知对它们永久丢失);
    // 异常延迟到 macrotask 重抛,保留全局可见性。
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        setTimeout(() => { throw error; }, 0);
      }
    }
  }

  // 后台/隐藏窗口(最小化、后台标签页、Electron hide())会暂停 requestAnimationFrame,而 SSE 读取
  // 循环是异步网络 I/O 不受影响 —— this.session 持续更新但 rAF 回调不触发,emit 会一直挂起,UI 停在
  // 旧 session 引用上直到窗口复可见。监听 visibilitychange:复可见时立即 flushPending,把积压通知一次
  // 交付(useStreamText.ts 已为另一条 rAF 路径用同款兜底)。仅在有人订阅时挂监听,随最后一个订阅取消
  // 而摘除 —— 自然跟随 React mount/unmount 生命周期,无泄漏,无需消费者改动。
  private attachVisibilityFlush(): void {
    if (this.visibilityHandler) return;
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    const handler = (): void => {
      if (document.visibilityState === "visible") this.flushPending();
    };
    this.visibilityHandler = handler;
    document.addEventListener("visibilitychange", handler);
  }

  private detachVisibilityFlush(): void {
    if (!this.visibilityHandler) return;
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
    }
    this.visibilityHandler = null;
  }
}
