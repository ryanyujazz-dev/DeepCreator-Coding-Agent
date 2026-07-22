import {
  Archive,
  ChevronDown,
  CircleHelp,
  Folder,
  FolderOpen,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  Search,
  Settings,
  X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ProjectRef } from "../../shared/contracts/desktop";
import { SessionSummary } from "../../shared/contracts/runtime";
import { AnimatedFolderIcon } from "./AnimatedFolderIcon";
import { NewTaskIcon } from "./NewTaskIcon";
import { OverflowFadeText } from "./OverflowFadeText";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { SidebarConfirmationDialog } from "./SidebarConfirmationDialog";
import { FloatingSurface, IconButton, RowAction } from "./ui/ControlPrimitives";

type AnchorRect = { bottom: number; left: number; right: number; top: number; width: number };
type ProjectOverlay = { project: ProjectRef; rect: AnchorRect };
type SessionOverlay = { project: ProjectRef; rect: AnchorRect; session: SessionSummary };
type SidebarConfirmation = {
  action: () => Promise<void> | void;
  confirmLabel: string;
  description: string;
  title: string;
};

function anchorRect(element: HTMLElement): AnchorRect {
  const rect = element.getBoundingClientRect();
  return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top, width: rect.width };
}

function overlayPosition(rect: AnchorRect, width: number, height: number) {
  return {
    left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(rect.top, window.innerHeight - height - 8))
  };
}

function ageLabel(timestamp: string): string {
  const elapsed = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分`;
  const days = Math.floor(minutes / 1440);
  return days > 0 ? `${days} 天` : `${Math.floor(minutes / 60)} 小时`;
}

function storedCollapsedProjects(): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem("deepseeker.collapsedProjects") ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export function SessionSidebar({
  desktopProjectsManaged = false,
  onArchiveProject,
  onArchiveSession,
  onNewSession,
  onOpenProject,
  onPinProject,
  onPinSession,
  onRemoveProject,
  onRenameProject,
  onSearch,
  onSettings,
  onSelectSession,
  onWidthChange,
  onWidthReset,
  projects = [],
  selectedSessionKey,
  sidebarWidth,
  sessions
}: {
  desktopProjectsManaged?: boolean;
  onArchiveProject?: (projectRoot: string) => Promise<void> | void;
  onArchiveSession?: (sessionId: string) => Promise<void> | void;
  onNewSession: (projectRoot?: string) => void;
  onOpenProject?: (projectRoot: string) => Promise<void> | void;
  onPinProject?: (projectRoot: string, pinned: boolean) => Promise<void> | void;
  onPinSession?: (sessionId: string, pinned: boolean) => Promise<void> | void;
  onRemoveProject?: (projectRoot: string) => Promise<void> | void;
  onRenameProject?: (projectRoot: string, name: string) => Promise<void> | void;
  onSearch: (query: string) => void;
  onSettings?: () => void;
  onSelectSession: (sessionId: string) => void;
  onWidthChange: (width: number) => void;
  onWidthReset: () => void;
  selectedSessionKey: string | null;
  sidebarWidth: number;
  sessions: SessionSummary[];
  projects?: ProjectRef[];
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState(storedCollapsedProjects);
  const [confirmation, setConfirmation] = useState<SidebarConfirmation | null>(null);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [hoveredProject, setHoveredProject] = useState<ProjectOverlay | null>(null);
  const [hoveredSession, setHoveredSession] = useState<SessionOverlay | null>(null);
  const [projectMenu, setProjectMenu] = useState<ProjectOverlay | null>(null);
  const [query, setQuery] = useState("");
  const [renamingProject, setRenamingProject] = useState<ProjectRef | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  const projectByPath = useMemo(() => new Map(projects.map((project) => [project.path, project])), [projects]);
  const projectRoots = useMemo(() => desktopProjectsManaged
    ? projects.map((project) => project.path)
    : [...new Set([...projects.map((project) => project.path), ...sessions.map((session) => session.projectRoot)])],
  [desktopProjectsManaged, projects, sessions]);
  const projectMenuSessions = projectMenu
    ? sessions.filter((session) => session.projectRoot === projectMenu.project.path)
    : [];
  const projectMenuHasActiveSessions = projectMenuSessions.some((session) => session.active);

  useEffect(() => {
    window.localStorage.setItem("deepseeker.collapsedProjects", JSON.stringify([...collapsedProjects]));
  }, [collapsedProjects]);

  useEffect(() => {
    if (!projectMenu) return;
    const close = (event: PointerEvent) => {
      if (!projectMenuRef.current?.contains(event.target as Node)) setProjectMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setProjectMenu(null); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [projectMenu]);

  const runAction = async (action: () => Promise<void> | void) => {
    setActionError(null);
    try {
      await action();
      setProjectMenu(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const requestConfirmation = (request: SidebarConfirmation) => {
    setActionError(null);
    setConfirmationError(null);
    setHoveredProject(null);
    setHoveredSession(null);
    setProjectMenu(null);
    setConfirmation(request);
  };

  const closeConfirmation = () => {
    if (confirming) return;
    setConfirmation(null);
    setConfirmationError(null);
  };

  const confirmAction = async () => {
    if (!confirmation || confirming) return;
    setConfirming(true);
    setConfirmationError(null);
    try {
      await confirmation.action();
      setConfirmation(null);
    } catch (error) {
      setConfirmationError(error instanceof Error ? error.message : String(error));
    } finally {
      setConfirming(false);
    }
  };

  const toggleProject = (projectRoot: string) => {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectRoot)) next.delete(projectRoot);
      else next.add(projectRoot);
      return next;
    });
  };

  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    if (!renamingProject || !renameValue.trim() || !onRenameProject) return;
    void runAction(async () => {
      await onRenameProject(renamingProject.path, renameValue.trim());
      setRenamingProject(null);
    });
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand-row">
        <div className="sidebar-brand-lockup"><strong className="sidebar-brand">DeepSeeker</strong><ChevronDown size={13} /></div>
        <IconButton className="icon-button" label="搜索任务" onClick={() => setSearchOpen((open) => !open)}><Search size={15} /></IconButton>
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
        <RowAction className="nav-row" onClick={() => onNewSession()}><NewTaskIcon size={17} /><span>新建任务</span></RowAction>
      </nav>
      <div className="sidebar-content">
        <section className="sidebar-section">
          <h2>项目</h2>
          {projectRoots.length === 0 && <div className="sidebar-empty">暂无会话</div>}
          {projectRoots.map((projectRoot) => {
            const project = projectByPath.get(projectRoot) ?? {
              lastOpenedAt: "",
              name: projectRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? projectRoot,
              path: projectRoot
            };
            const projectSessions = sessions.filter((session) => session.projectRoot === projectRoot);
            const collapsed = collapsedProjects.has(projectRoot);
            return (
              <div className={`project-group ${collapsed ? "is-collapsed" : ""}`} key={projectRoot}>
                <div
                  className={`project-title-shell ${projectMenu?.project.path === projectRoot ? "has-open-menu" : ""}`}
                  onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setHoveredProject(null); }}
                  onFocus={(event) => {
                    if ((event.target as HTMLElement).matches(":focus-visible")) setHoveredProject({ project, rect: anchorRect(event.currentTarget) });
                  }}
                  onMouseEnter={(event) => setHoveredProject({ project, rect: anchorRect(event.currentTarget) })}
                  onMouseLeave={() => setHoveredProject(null)}
                >
                  <RowAction
                    aria-expanded={!collapsed}
                    className="project-title"
                    onClick={() => toggleProject(projectRoot)}
                    title={collapsed ? "展开项目任务" : "收起项目任务"}
                  >
                    <AnimatedFolderIcon expanded={!collapsed} />
                    <OverflowFadeText>{project.name}</OverflowFadeText>
                  </RowAction>
                  <div className="project-row-actions">
                    {desktopProjectsManaged && (
                      <IconButton
                        label={`${project.name} 更多操作`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setHoveredProject(null);
                          setProjectMenu({ project, rect: anchorRect(event.currentTarget) });
                        }}
                      ><MoreHorizontal size={15} /></IconButton>
                    )}
                    <IconButton label={`在 ${project.name} 中新建任务`} onClick={() => onNewSession(projectRoot)}><NewTaskIcon size={16} /></IconButton>
                  </div>
                </div>
                {!collapsed && projectSessions.map((session) => (
                  <div
                    className={`thread-row-shell ${selectedSessionKey === session.sessionId ? "active-thread" : ""}`}
                    key={session.sessionId}
                    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setHoveredSession(null); }}
                    onFocus={(event) => {
                      if ((event.target as HTMLElement).matches(":focus-visible")) setHoveredSession({ project, rect: anchorRect(event.currentTarget), session });
                    }}
                    onMouseEnter={(event) => setHoveredSession({ project, rect: anchorRect(event.currentTarget), session })}
                    onMouseLeave={() => setHoveredSession(null)}
                  >
                    <RowAction className="thread-row" onClick={() => onSelectSession(session.sessionId)}>
                      <OverflowFadeText>{session.title}</OverflowFadeText>
                      {session.active && <span className="session-running" />}
                    </RowAction>
                    <div className="thread-row-actions">
                      {onPinSession && (
                        <IconButton
                          label={session.pinned ? "取消置顶任务" : "置顶任务"}
                          className={session.pinned ? "is-active" : ""}
                          onClick={() => void runAction(() => onPinSession(session.sessionId, !session.pinned))}
                        ><Pin fill={session.pinned ? "currentColor" : "none"} size={13} /></IconButton>
                      )}
                      {onArchiveSession && (
                        <IconButton
                          label="归档任务"
                          disabled={session.active}
                          onClick={() => requestConfirmation({
                            action: () => onArchiveSession(session.sessionId),
                            confirmLabel: "归档任务",
                            description: `这会将该任务从 ${project.name} 中归档。你稍后可以在已归档任务中找到它。`,
                            title: `归档“${session.title}”？`
                          })}
                          title={session.active ? "请先中止正在运行的任务" : "归档任务"}
                        ><Archive size={14} /></IconButton>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </section>
      </div>
      <div className="account-strip">
        <div className="avatar">DS</div><div><strong>本地工作区</strong></div>{onSettings ? <IconButton label="打开设置" onClick={onSettings}><Settings size={15} /></IconButton> : <CircleHelp size={16} />}
      </div>
      <PanelResizeHandle ariaLabel="调整左侧栏宽度" edge="right" max={360} min={220} onChange={onWidthChange} onReset={onWidthReset} value={sidebarWidth} />

      {hoveredProject && !projectMenu && createPortal(
        <FloatingSurface className="sidebar-hover-card project-hover-card" role="tooltip" style={overlayPosition(hoveredProject.rect, 360, 142)}>
          <header><Folder size={18} /><strong>{hoveredProject.project.name}</strong>{hoveredProject.project.pinned && <Pin fill="currentColor" size={13} />}</header>
          <div><MessageCircle size={16} /><span>{sessions.filter((session) => session.projectRoot === hoveredProject.project.path).length} 个对话串</span></div>
          <div className="sidebar-hover-card-path"><Folder size={16} /><span>{hoveredProject.project.path}</span></div>
        </FloatingSurface>,
        document.body
      )}
      {hoveredSession && createPortal(
        <FloatingSurface className="sidebar-hover-card session-hover-card" role="tooltip" style={overlayPosition(hoveredSession.rect, 338, 96)}>
          <header><strong>{hoveredSession.session.title}</strong><time>{hoveredSession.session.active ? "运行中" : ageLabel(hoveredSession.session.updatedAt)}</time></header>
          <div><Folder size={16} /><span>{hoveredSession.project.name}</span></div>
        </FloatingSurface>,
        document.body
      )}
      {projectMenu && createPortal(
        <FloatingSurface
          className="sidebar-context-menu"
          ref={projectMenuRef}
          role="menu"
          style={{ left: Math.min(projectMenu.rect.left - 12, window.innerWidth - 252), top: projectMenu.rect.bottom + 6 }}
        >
          {onPinProject && <button onClick={() => void runAction(() => onPinProject(projectMenu.project.path, !projectMenu.project.pinned))} role="menuitem" type="button"><Pin fill={projectMenu.project.pinned ? "currentColor" : "none"} size={16} /><span>{projectMenu.project.pinned ? "取消置顶项目" : "置顶项目"}</span></button>}
          {onOpenProject && <button onClick={() => void runAction(() => onOpenProject(projectMenu.project.path))} role="menuitem" type="button"><FolderOpen size={16} /><span>在资源管理器中打开</span></button>}
          {onRenameProject && <button onClick={() => { setRenameValue(projectMenu.project.name); setRenamingProject(projectMenu.project); setProjectMenu(null); }} role="menuitem" type="button"><Pencil size={16} /><span>重命名项目</span></button>}
          {onArchiveProject && (
            <button
              disabled={projectMenuSessions.length === 0 || projectMenuHasActiveSessions}
              onClick={() => requestConfirmation({
                action: () => onArchiveProject(projectMenu.project.path),
                confirmLabel: "全部归档",
                description: `这会将 ${projectMenu.project.name} 中的任务归档。你稍后可以在已归档任务中找到它们。`,
                title: `归档 ${projectMenuSessions.length} 个任务？`
              })}
              role="menuitem"
              title={projectMenuHasActiveSessions ? "请先中止项目中正在运行的任务" : projectMenuSessions.length === 0 ? "项目中没有可归档的任务" : "归档项目任务"}
              type="button"
            ><Archive size={16} /><span>归档任务</span></button>
          )}
          {onRemoveProject && (
            <button
              className="is-danger"
              disabled={projectMenuHasActiveSessions}
              onClick={() => requestConfirmation({
                action: () => onRemoveProject(projectMenu.project.path),
                confirmLabel: "移除",
                description: "这会将该项目从边栏中移除。磁盘上的文件不会被删除。",
                title: `移除 ${projectMenu.project.name}？`
              })}
              role="menuitem"
              title={projectMenuHasActiveSessions ? "请先中止项目中正在运行的任务" : "从边栏移除项目"}
              type="button"
            ><X size={16} /><span>移除</span></button>
          )}
        </FloatingSurface>,
        document.body
      )}
      {renamingProject && createPortal(
        <div className="sidebar-dialog-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setRenamingProject(null); }}>
          <form className="sidebar-rename-dialog" onSubmit={submitRename}>
            <header><div><span>重命名项目</span><strong>{renamingProject.path}</strong></div><IconButton label="关闭" onClick={() => setRenamingProject(null)}><X size={16} /></IconButton></header>
            <input autoFocus maxLength={80} onChange={(event) => setRenameValue(event.target.value)} value={renameValue} />
            <footer><button onClick={() => setRenamingProject(null)} type="button">取消</button><button className="is-primary" disabled={!renameValue.trim()} type="submit">保存</button></footer>
          </form>
        </div>,
        document.body
      )}
      {confirmation && (
        <SidebarConfirmationDialog
          busy={confirming}
          confirmLabel={confirmation.confirmLabel}
          description={confirmation.description}
          error={confirmationError}
          onCancel={closeConfirmation}
          onConfirm={() => void confirmAction()}
          title={confirmation.title}
        />
      )}
      {actionError && <div className="sidebar-action-error" role="alert">{actionError}<IconButton label="关闭错误" onClick={() => setActionError(null)}><X size={12} /></IconButton></div>}
    </aside>
  );
}
