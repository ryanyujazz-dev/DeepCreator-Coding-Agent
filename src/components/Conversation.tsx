import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Changes, Session } from "../../shared/contracts/runtime";
import { RunTimeline } from "./RunTimeline";

export function Conversation({
  onOpenFile,
  onOpenReview,
  session
}: {
  onOpenFile: (path: string) => void;
  onOpenReview: (delta: Changes) => void;
  session: Session | null;
}) {
  const scrollRef = useRef<HTMLElement>(null);
  const stickToBottom = useRef(true);
  const scrollFrame = useRef<number | undefined>(undefined);

  const scheduleFollow = useCallback(() => {
    if (!stickToBottom.current || scrollFrame.current !== undefined) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = undefined;
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, []);

  useLayoutEffect(() => {
    scheduleFollow();
  }, [scheduleFollow, session?.lastOffset, session?.sessionId]);

  useEffect(() => () => {
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
  }, []);

  return (
    <section
      className="conversation-scroll"
      onScroll={(event) => {
        const element = event.currentTarget;
        stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
      }}
      ref={scrollRef}
    >
      {session && session.runs.length > 0 ? (
        <div className="conversation-column">
          {session.runs.map((run) => (
            <div className="conversation-turn" key={run.runId}>
              <section className="user-turn"><p>{run.prompt}</p></section>
              <RunTimeline
                run={run}
                onOpenFile={onOpenFile}
                onOpenReview={onOpenReview}
                onTextFrame={scheduleFollow}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="conversation-empty-state"><h1>我们该构建什么？</h1></div>
      )}
    </section>
  );
}
