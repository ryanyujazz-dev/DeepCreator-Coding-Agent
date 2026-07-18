import { ArrowLeft, ArrowRight, CircleHelp, Folder, MoreHorizontal, PanelLeft, PencilLine, Search } from "lucide-react";
import { SessionListEntry } from "../../shared/runtimeTypes";
import { useState } from "react";
import { PanelResizeHandle } from "./PanelResizeHandle";

function ageLabel(timestamp: string): string {
  const elapsed = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const days = Math.floor(minutes / 1440);
  return days > 0 ? `${days} 天` : `${Math.floor(minutes / 60)} 小时`;
}

export function SessionSidebar({
  onNewSession,
  onSearch,
  onSelectSession,
  onWidthChange,
  onWidthReset,
  selectedSessionKey,
  sidebarWidth,
  sessions
}: {
  onNewSession: () => void;
  onSearch: (query: string) => void;
  onSelectSession: (sessionKey: string) => void;
  onWidthChange: (width: number) => void;
  onWidthReset: () => void;
  selectedSessionKey: string | null;
  sidebarWidth: number;
  sessions: SessionListEntry[];
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  return (
    <aside className="sidebar">
      <div className="sidebar-toolbar">
        <button className="icon-button" aria-label="切换侧边栏"><PanelLeft size={14} /></button>
        <div className="history-buttons">
          <button className="icon-button" aria-label="返回"><ArrowLeft size={14} /></button>
          <button className="icon-button faded" aria-label="前进"><ArrowRight size={14} /></button>
        </div>
      </div>
      <div className="sidebar-brand-row">
        <strong className="sidebar-brand">DeepSeeker</strong>
        <button className="icon-button" aria-label="搜索任务" onClick={() => setSearchOpen((open) => !open)}><Search size={15} /></button>
      </div>
      {searchOpen && (
        <div className="session-search">
          <Search size={13} />
          <input
            aria-label="搜索会话"
            autoFocus
            onChange={(event) => {
              setQuery(event.target.value);
              onSearch(event.target.value);
            }}
            placeholder="搜索会话或文件"
            value={query}
          />
        </div>
      )}
      <nav className="primary-nav">
        <button className="nav-row" onClick={onNewSession} type="button"><PencilLine size={16} /><span>新建任务</span></button>
      </nav>
      <div className="sidebar-content">
        <section className="sidebar-section">
          <h2>工作会话</h2>
          <div className="project-title"><Folder size={15} /><span>DeepSeeker CodeAgent</span></div>
          {sessions.length === 0 && <div className="sidebar-empty">暂无会话</div>}
          {sessions.map((session) => (
            <button
              className={`thread-row ${selectedSessionKey === session.sessionKey ? "active-thread" : ""}`}
              key={session.sessionKey}
              onClick={() => onSelectSession(session.sessionKey)}
              type="button"
            >
              <span>{session.title}</span>
              {session.active ? <span className="session-running" /> : <time>{ageLabel(session.updatedAt)}</time>}
              <MoreHorizontal size={13} />
            </button>
          ))}
        </section>
      </div>
      <div className="account-strip">
        <div className="avatar">DS</div><div><strong>本地工作区</strong></div><CircleHelp size={16} />
      </div>
      <PanelResizeHandle
        ariaLabel="调整左侧栏宽度"
        edge="right"
        max={360}
        min={164}
        onChange={onWidthChange}
        onReset={onWidthReset}
        value={sidebarWidth}
      />
    </aside>
  );
}
