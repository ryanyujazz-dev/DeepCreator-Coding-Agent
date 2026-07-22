import { Check, ChevronRight, Folder, Plus, Search, X } from "lucide-react";
import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { ProjectRef } from "../../shared/contracts/desktop";
import { DraftWorkspace, projectDraftWorkspace } from "../workspaceSelection";
import { FloatingSurface } from "./ui/ControlPrimitives";

export function ProjectContextSelector({
  canAddProject,
  onAddProject,
  onChange,
  projects,
  selection
}: {
  canAddProject: boolean;
  onAddProject: () => Promise<ProjectRef | null>;
  onChange: (workspace: DraftWorkspace) => Promise<void> | void;
  projects: ProjectRef[];
  selection: DraftWorkspace;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedProject = selection.kind === "project"
    ? projects.find((project) => project.path === selection.projectRoot)
    : undefined;
  const label = selection.kind === "scratch"
    ? "不在项目中工作"
    : selectedProject?.name ?? selection.projectRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? selection.projectRoot;
  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return projects;
    return projects.filter((project) => `${project.name}\n${project.path}`.toLocaleLowerCase().includes(normalized));
  }, [projects, query]);

  const close = (restoreFocus = false) => {
    setOpen(false);
    setError(null);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const choose = async (workspace: DraftWorkspace) => {
    setBusy(true);
    setError(null);
    try {
      await onChange(workspace);
      setQuery("");
      close(true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const addProject = async () => {
    setBusy(true);
    setError(null);
    try {
      const project = await onAddProject();
      if (!project) return;
      await onChange(projectDraftWorkspace(project.path));
      setQuery("");
      close(true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && filteredProjects[0]) {
      event.preventDefault();
      void choose(projectDraftWorkspace(filteredProjects[0].path));
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      menuRef.current?.querySelector<HTMLButtonElement>(".project-context-option")?.focus();
    }
  };

  return (
    <div className="project-context-shelf">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="project-context-trigger"
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        title={selection.kind === "project" ? selection.projectRoot : "文件和命令将在独立的临时工作区中运行"}
        type="button"
      >
        <Folder size={16} />
        <span>{label}</span>
      </button>
      {open && (
        <FloatingSurface aria-label="选择任务工作区" className="project-context-popover" ref={menuRef} role="dialog">
          <label className="project-context-search">
            <Search size={15} />
            <input
              aria-label="搜索项目"
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="搜索项目"
              value={query}
            />
          </label>
          <div className="project-context-options">
            {filteredProjects.map((project) => {
              const selected = selection.kind === "project" && selection.projectRoot === project.path;
              return (
                <button
                  aria-current={selected ? "true" : undefined}
                  className="project-context-option"
                  disabled={busy}
                  key={project.path}
                  onClick={() => void choose(projectDraftWorkspace(project.path))}
                  title={project.path}
                  type="button"
                >
                  <Folder size={17} />
                  <span>{project.name}</span>
                  {selected && <Check size={17} />}
                </button>
              );
            })}
            {filteredProjects.length === 0 && <div className="project-context-empty">没有匹配的项目</div>}
          </div>
          <div className="project-context-actions">
            {canAddProject && (
              <button disabled={busy} onClick={() => void addProject()} type="button">
                <Plus size={17} /><span>新建项目</span><ChevronRight size={16} />
              </button>
            )}
            <button disabled={busy} onClick={() => void choose({ kind: "scratch" })} type="button">
              <X size={17} /><span>不在项目中工作</span>{selection.kind === "scratch" && <Check size={17} />}
            </button>
          </div>
          {error && <div className="project-context-error" role="alert">{error}</div>}
        </FloatingSurface>
      )}
    </div>
  );
}
