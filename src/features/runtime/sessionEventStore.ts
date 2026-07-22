import { Event, Session } from "../../../shared/contracts/runtime";
import { reduceEvents } from "../../../shared/domain/reducer";

export type SessionUpdater = Session | null | ((current: Session | null) => Session | null);

/**
 * The authoritative client-side Session projection. REST snapshots replace state,
 * while SSE messages can only advance it through the shared Event reducer.
 */
export class SessionEventStore {
  private session: Session | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): Session | null => this.session;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(next: SessionUpdater): void {
    const value = typeof next === "function" ? next(this.session) : next;
    if (Object.is(value, this.session)) return;
    this.session = value;
    this.emit();
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

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}
