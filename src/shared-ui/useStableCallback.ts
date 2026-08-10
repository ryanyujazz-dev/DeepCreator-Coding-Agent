import { useMemo, useRef } from "react";

// 稳定回调(useEvent 模式):引用恒定、但每次调用都转发到最新闭包。ref.current 在 render
// 阶段重赋值;转发器调用时读 ref.current → 永远拿到最新闭包,杜绝 stale-capture;空 deps 的
// useMemo 让转发器(及对象形式返回的容器)引用在组件生命周期内恒定,使消费者的 React.memo
// 浅比较命中、整帧跳过重渲。StrictMode 双调用下 ref 重赋等价幂等,安全。
//
// 单回调形式:沿用 Conversation/RunTimeline 已验证的写法,提取为共享单一来源。
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useMemo(() => (...args: A) => ref.current(...args), []);
}

// 对象形式:一次 useMemo([]) 返回稳定容器,每个方法是转发器(调用时读 ref.current[key] 的最新闭包)。
// 键集必须在消费者生命周期内静态(App 的 handler 集即如此 —— ref 持最新闭包,但不会为新增键补转发器,
// 也不会丢弃已删键的旧转发器)。表达不了 undefined(每个键恒为函数),故 desktop ? fn : undefined
// 这类条件回调须用单回调形式 + 在 prop 位保留三元。
export function useStableCallbacks<T extends Record<string, (...args: any[]) => unknown>>(fns: T): T {
  const ref = useRef(fns);
  ref.current = fns;
  return useMemo<T>(() => {
    const stable: Record<string, (...args: unknown[]) => unknown> = {};
    for (const key of Object.keys(ref.current)) {
      stable[key] = (...args: unknown[]) => ref.current[key](...args);
    }
    return stable as T;
  }, []); // 空 deps 安全:工厂仅读 ref.current(exhaustive-deps 对 ref 访问不要求进 deps),键集生命周期内静态
}
