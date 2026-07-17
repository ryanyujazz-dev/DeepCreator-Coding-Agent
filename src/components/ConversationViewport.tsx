import { useLayoutEffect, useRef } from "react";
import { WorkspaceSessionView } from "../../shared/runtimeTypes";
import { WorkCycleTimeline } from "./WorkCycleTimeline";

export function ConversationViewport({
  onOpenFile,
  session
}: {
  onOpenFile: (path: string, file?: import("../../shared/runtimeTypes").FileDeltaView) => void;
  session: WorkspaceSessionView | null;
}) {
  const scrollRef = useRef<HTMLElement>(null);
  const stickToBottom = useRef(true);

  useLayoutEffect(() => {
    if (!stickToBottom.current || !scrollRef.current) return;
    const frame = requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [session?.lastOffset, session?.sessionKey]);

  return (
    <section
      className="conversation-scroll"
      onScroll={(event) => {
        const element = event.currentTarget;
        stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
      }}
      ref={scrollRef}
    >
      {session && session.cycles.length > 0 ? (
        <div className="conversation-column">
          {session.cycles.map((cycle) => (
            <div className="conversation-turn" key={cycle.cycleKey}>
              <section className="user-turn"><p>{cycle.prompt}</p></section>
              <WorkCycleTimeline cycle={cycle} onOpenFile={onOpenFile} />
            </div>
          ))}
        </div>
      ) : (
        <div className="conversation-empty-state"><h1>我们该构建什么？</h1></div>
      )}
    </section>
  );
}
