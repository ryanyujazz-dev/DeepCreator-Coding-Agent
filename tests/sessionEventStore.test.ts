import assert from "node:assert/strict";
import test from "node:test";
import { FrameScheduler, SessionEventStore } from "../src/features/runtime/sessionEventStore";
import { EVENT_VERSION, Event, Session, SessionInput } from "../shared/contracts/runtime";
import { createSession } from "../shared/domain/reducer";

const input: SessionInput = {
  accessMode: "request_approval",
  compactThresholdTokens: 80_000,
  contextWindowTokens: 100_000,
  createdAt: "2026-07-22T00:00:00.000Z",
  model: "mock-agent",
  projectRoot: "/workspace",
  sessionId: "session_store",
  title: "Store"
};

// store 内部调度器在浏览器/renderer 用 requestAnimationFrame,在 Node(可能无 rAF)回退 setTimeout(0)。
// 本 flush 先等一帧、再兜一个 setTimeout(16),无论走哪条调度都能保证 store 排队的 emit 先于 resolve
// 触发,使测试不依赖具体调度实现。
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    const settle = (): void => resolve();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(settle);
    setTimeout(settle, 16);
  });
}

// 纯 store 行为测试用的最小 session 桩:store 只读取 sessionId/lastOffset,其余字段对 store 不可见,
// 故无需构造完整合法 Session;cast 隔离"store 行为"与"Session 契约"两条关注点。
function stubSession(sessionId: string, lastOffset: number): Session {
  return { sessionId, lastOffset } as unknown as Session;
}

test("快照与事件归约共用同一客户端权威源,并防止旧 REST 快照回滚事件状态", async () => {
  const store = new SessionEventStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });

  store.replaceSnapshot(createSession(input));
  const started: Event<"run.started"> = {
    at: "2026-07-22T00:00:01.000Z",
    data: { mode: "work", model: "mock-agent", prompt: "go", startedAt: "2026-07-22T00:00:01.000Z" },
    eventId: "event_1",
    offset: 1,
    scope: { runId: "run_1", sessionId: input.sessionId },
    type: "run.started",
    version: EVENT_VERSION
  };
  store.applyEvents(input.sessionId, [started]);

  // 快照与事件归约在同一同步突发内:渲染合并后只发一次通知(而非旧行为的两次)。
  assert.equal(notifications, 0, "通知被延迟到下一帧,同步期内尚未发出");
  assert.equal(store.getSnapshot()?.runs.at(-1)?.runId, "run_1");
  assert.equal(store.getSnapshot()?.lastOffset, 1, "状态已同步写入,通知虽延迟但值立即可见");

  // 旧 REST 快照(offset 回退到 0)不得覆盖事件推进出的 offset=1。
  store.replaceSnapshot(createSession(input));
  assert.equal(store.getSnapshot()?.lastOffset, 1, "a stale REST snapshot must not roll Event state back");

  await flush();
  assert.equal(notifications, 1, "一次同步突发合并为一次通知");
  unsubscribe();
});

test("getSnapshot 为 null 直到首次 update", () => {
  const store = new SessionEventStore();
  assert.equal(store.getSnapshot(), null);
});

test("同一帧内多次 update 合并为一次通知", async () => {
  const store = new SessionEventStore();
  let notifyCount = 0;
  store.subscribe(() => { notifyCount += 1; });

  store.update(stubSession("s1", 1));
  store.update(stubSession("s1", 2));
  store.update(stubSession("s1", 3));
  store.update(stubSession("s1", 4));
  store.update(stubSession("s1", 5));

  assert.equal(notifyCount, 0, "通知延迟到下一帧");
  assert.equal(store.getSnapshot()?.lastOffset, 5, "状态已同步可见最新值");

  await flush();
  assert.equal(notifyCount, 1);
});

test("状态同步写入:getSnapshot 在通知发出前即返回最新值", async () => {
  const store = new SessionEventStore();
  store.update(stubSession("s1", 7));
  assert.equal(store.getSnapshot()?.lastOffset, 7);
  await flush();
});

test("相同引用的 update 短路:既不换状态也不发通知", async () => {
  const store = new SessionEventStore();
  const same = stubSession("s1", 3);
  let notifyCount = 0;
  store.subscribe(() => { notifyCount += 1; });

  store.update(same);
  await flush();
  assert.equal(notifyCount, 1);

  store.update(same);
  await flush();
  assert.equal(notifyCount, 1, "同引用再次 update 不再通知");
  assert.equal(store.getSnapshot(), same);
});

test("函数式更新基于当前状态计算下一个值", async () => {
  const store = new SessionEventStore();
  store.update(stubSession("s1", 10));
  await flush();

  store.update((current) => stubSession(current?.sessionId ?? "s1", (current?.lastOffset ?? 0) + 5));
  assert.equal(store.getSnapshot()?.lastOffset, 15);
  await flush();
});

test("subscribe 返回的取消订阅停止后续通知", async () => {
  const store = new SessionEventStore();
  let notifyCount = 0;
  const unsubscribe = store.subscribe(() => { notifyCount += 1; });

  store.update(stubSession("s1", 1));
  await flush();
  assert.equal(notifyCount, 1);

  unsubscribe();
  store.update(stubSession("s1", 2));
  await flush();
  assert.equal(notifyCount, 1);
});

test("多个订阅者均在合并后的同一帧各收到一次通知", async () => {
  const store = new SessionEventStore();
  let a = 0;
  let b = 0;
  store.subscribe(() => { a += 1; });
  store.subscribe(() => { b += 1; });

  store.update(stubSession("s1", 1));
  store.update(stubSession("s1", 2));
  store.update(stubSession("s1", 3));
  await flush();

  assert.equal(a, 1);
  assert.equal(b, 1);
});

test("applyEvents 在 events 为空时短路不发通知", async () => {
  const store = new SessionEventStore();
  store.update(stubSession("s1", 5));
  await flush();

  let notifyCount = 0;
  store.subscribe(() => { notifyCount += 1; });

  store.applyEvents("s1", []);
  await flush();
  assert.equal(notifyCount, 0);
});

test("replaceSnapshot:同 session 更大 offset 接受、更小 offset 忽略", async () => {
  const store = new SessionEventStore();
  store.replaceSnapshot(stubSession("s1", 10));
  await flush();

  const before = store.getSnapshot();
  store.replaceSnapshot(stubSession("s1", 3));
  assert.equal(store.getSnapshot(), before, "更小 offset 不覆盖");

  store.replaceSnapshot(stubSession("s1", 20));
  assert.equal(store.getSnapshot()?.lastOffset, 20, "更大 offset 接受");
  await flush();
});

test("两轮突发各自只发一次通知(合并不跨帧累积)", async () => {
  const store = new SessionEventStore();
  let notifyCount = 0;
  store.subscribe(() => { notifyCount += 1; });

  store.update(stubSession("s1", 1));
  store.update(stubSession("s1", 2));
  await flush();
  assert.equal(notifyCount, 1);

  store.update(stubSession("s1", 3));
  store.update(stubSession("s1", 4));
  await flush();
  assert.equal(notifyCount, 2);
});

// ---- 锁定 store↔reducer 引用契约(Phase 2 reducer 结构性共享的安全网)----
// store.update 的 Object.is 短路完全依赖「真正变更时 reduceEvent 必返回新引用」。上面的合并测试用
// stubSession(每次新字面量)绕过了 reducer,无法兜住此契约。这里用真实 reduceEvents:旧 offset
// 返回同引用 → 短路不通知;新 offset 建新引用 → 通知。未来若 reducer 在「有变更」路径误返回同引用,
// 此测试会失败,从而暴露「通知被静默吞掉」的回归。
test("store↔reducer 引用契约:旧 offset 返回同引用则短路不通知,新 offset 建新引用则通知", async () => {
  const store = new SessionEventStore();
  store.replaceSnapshot(createSession(input)); // lastOffset = 0
  await flush();
  const before = store.getSnapshot();
  let notifyCount = 0;
  store.subscribe(() => { notifyCount += 1; });

  const runStarted = (offset: number): Event<"run.started"> => ({
    at: `2026-07-22T00:00:0${offset}.000Z`,
    data: { mode: "work", model: "mock-agent", prompt: "go", startedAt: `2026-07-22T00:00:0${offset}.000Z` },
    eventId: `event_${offset}`,
    offset,
    scope: { runId: "run_1", sessionId: input.sessionId },
    type: "run.started",
    version: EVENT_VERSION
  });

  // 旧/重复 offset:reduceEvent 命中 `event.offset <= current.lastOffset` 返回同引用 → Object.is 短路
  store.applyEvents(input.sessionId, [runStarted(0)]);
  await flush();
  assert.equal(notifyCount, 0, "旧 offset 不触发通知");
  assert.equal(store.getSnapshot(), before, "旧 offset 不换引用");

  // 新 offset:reduceEvent structuredClone 建新引用 → 通知
  store.applyEvents(input.sessionId, [runStarted(1)]);
  assert.equal(store.getSnapshot()?.runs.at(-1)?.runId, "run_1");
  assert.notEqual(store.getSnapshot(), before, "新 offset 换引用");
  await flush();
  assert.equal(notifyCount, 1);
});

// ---- 注入式调度器:直接覆盖生产 rAF 路径(Node 测试环境无 rAF,默认只跑 setTimeout 回退)----
test("注入式调度器:同一突发内多次 update 合并为一次 emit", () => {
  let scheduled: (() => void) | null = null;
  const controlled: FrameScheduler = (cb) => { scheduled = cb; };
  const store = new SessionEventStore(controlled);
  let notifyCount = 0;
  store.subscribe(() => { notifyCount += 1; });

  store.update(stubSession("s1", 1));
  store.update(stubSession("s1", 2));
  store.update(stubSession("s1", 3));

  assert.equal(notifyCount, 0, "调度器未推进前不发通知");
  assert.notEqual(scheduled, null, "调度器收到一次回调排队");
  // 推进该帧 → 三次 update 合并为一次 emit
  scheduled!();
  assert.equal(notifyCount, 1);
});

test("flushPending 抢先发出后,排队回调变 no-op(不重复 emit)", () => {
  let scheduled: (() => void) | null = null;
  const controlled: FrameScheduler = (cb) => { scheduled = cb; };
  const store = new SessionEventStore(controlled);
  let notifyCount = 0;
  store.subscribe(() => { notifyCount += 1; });

  store.update(stubSession("s1", 1));
  // 复可见(visibilitychange)或测试抢先 flush → 立即发出
  store.flushPending();
  assert.equal(notifyCount, 1);
  // 之前排队的回调随后触发 → notifyScheduled 已清,变 no-op,不重复 emit
  scheduled!();
  assert.equal(notifyCount, 1);
});

// 对称守卫的反序时序:排队回调先发出,随后 flushPending 必为 no-op(钉住 flushPending:76 守卫)。
test("排队回调先发出后,flushPending 变 no-op(对称守卫反序,不重复 emit)", () => {
  let scheduled: (() => void) | null = null;
  const controlled: FrameScheduler = (cb) => { scheduled = cb; };
  const store = new SessionEventStore(controlled);
  let notifyCount = 0;
  store.subscribe(() => { notifyCount += 1; });

  store.update(stubSession("s1", 1));
  scheduled!(); // rAF 先于 visibilitychange 触发 → 发出
  assert.equal(notifyCount, 1);
  store.flushPending(); // 随后复可见 flush → notifyScheduled 已清,no-op
  assert.equal(notifyCount, 1, "反序 flushPending 不重复 emit");

  // 状态未卡死:新 update 仍能正常调度
  store.update(stubSession("s1", 2));
  scheduled!();
  assert.equal(notifyCount, 2);
});

test("flushPending 在无 pending 时调用安全(空操作、不抛)", () => {
  const store = new SessionEventStore();
  let notifyCount = 0;
  store.subscribe(() => { notifyCount += 1; });
  assert.doesNotThrow(() => store.flushPending());
  assert.doesNotThrow(() => store.flushPending());
  assert.equal(notifyCount, 0);
});

// ---- visibilitychange 监听生命周期(Node 下无 document,attach/detach 默认是死代码)----
// 注入 mock document 把 attach/detach/handler 同 ref/hidden→visible 翻转 钉成可执行契约。
type MockDoc = {
  visibilityState: string;
  addEventListener: (type: string, handler: () => void) => void;
  removeEventListener: (type: string, handler: () => void) => void;
};

function installMockDocument(): {
  added: Array<{ type: string; handler: () => void }>;
  removed: Array<{ type: string; handler: () => void }>;
  setVisibility: (value: string) => void;
  dispatch: (type: string) => void;
  listenerCount: (type: string) => number;
  restore: () => void;
} {
  const added: Array<{ type: string; handler: () => void }> = [];
  const removed: Array<{ type: string; handler: () => void }> = [];
  const handlers = new Map<string, Array<() => void>>();
  let visibility = "visible";
  const doc: MockDoc = {
    get visibilityState() { return visibility; },
    addEventListener: (type, handler) => {
      added.push({ type, handler });
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    removeEventListener: (type, handler) => {
      removed.push({ type, handler });
      const list = handlers.get(type);
      if (list) {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      }
    }
  };
  const g = globalThis as unknown as { document?: unknown };
  const original = g.document;
  g.document = doc as unknown as never;
  return {
    added,
    removed,
    setVisibility: (value) => { visibility = value; },
    dispatch: (type) => { for (const handler of (handlers.get(type) ?? [])) handler(); },
    listenerCount: (type) => handlers.get(type)?.length ?? 0,
    restore: () => { g.document = original; }
  };
}

test("visibilitychange:首个 subscribe 挂载,最后一个 unsubscribe 以同一 handler 引用摘除(无泄漏)", () => {
  const doc = installMockDocument();
  try {
    const store = new SessionEventStore();
    const unsubscribe = store.subscribe(() => { });

    assert.equal(doc.added.length, 1);
    assert.equal(doc.added[0]!.type, "visibilitychange");
    assert.equal(doc.listenerCount("visibilitychange"), 1);

    unsubscribe();

    assert.equal(doc.removed.length, 1, "unsubscribe 应摘除监听");
    assert.equal(doc.removed[0]!.type, "visibilitychange");
    assert.equal(doc.removed[0]!.handler, doc.added[0]!.handler, "摘除的是同一 handler 引用");
    assert.equal(doc.listenerCount("visibilitychange"), 0);
  } finally {
    doc.restore();
  }
});

test("visibilitychange:仅 visible 翻转触发 flushPending,hidden 不触发", () => {
  const doc = installMockDocument();
  try {
    const store = new SessionEventStore();
    let notifyCount = 0;
    store.subscribe(() => { notifyCount += 1; });

    store.update(stubSession("s1", 1));
    assert.equal(notifyCount, 0, "pending 未 flush 前不发通知");

    doc.setVisibility("hidden");
    doc.dispatch("visibilitychange");
    assert.equal(notifyCount, 0, "hidden 不 flush");

    doc.setVisibility("visible");
    doc.dispatch("visibilitychange");
    assert.equal(notifyCount, 1, "复可见时 flush 积压通知");
  } finally {
    doc.restore();
  }
});

test("visibilitychange:多订阅者与 StrictMode 重订阅序列下不重复挂载、不泄漏", () => {
  const doc = installMockDocument();
  try {
    const store = new SessionEventStore();

    const a = store.subscribe(() => { });
    assert.equal(doc.listenerCount("visibilitychange"), 1);
    const b = store.subscribe(() => { });
    assert.equal(doc.listenerCount("visibilitychange"), 1, "第二订阅者不重复挂载");

    a();
    assert.equal(doc.listenerCount("visibilitychange"), 1, "仍有一订阅者时不摘除");
    b();
    assert.equal(doc.listenerCount("visibilitychange"), 0, "全部取消后摘除");

    // StrictMode 风格:subscribe → unsubscribe → 再 subscribe
    const c1 = store.subscribe(() => { });
    c1();
    const c2 = store.subscribe(() => { });
    assert.equal(doc.listenerCount("visibilitychange"), 1, "重订阅后恢复单监听");
    c2();
    assert.equal(doc.listenerCount("visibilitychange"), 0);

    assert.equal(doc.added.length, doc.removed.length, "add/remove 次数相等(无累积泄漏)");
  } finally {
    doc.restore();
  }
});
