import {
  Blocks,
  ChevronDown,
  Download,
  FolderOpen,
  Github,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SkillInstallPreview, SkillInstallScope, SkillOrigin, SkillPermission, SkillSummary } from "../../../shared/contracts/skill";
import { WorkspaceKind } from "../../../shared/contracts/runtime";
import { desktopBridge, desktopErrorMessage } from "../../platform/desktop";
import { FloatingSurface, IconButton, PillButton } from "../../shared-ui/ControlPrimitives";
import { ConfirmationDialog } from "../ConfirmationDialog";

const PERMISSION_LABELS: Record<SkillPermission, string> = {
  external_access: "外部操作",
  local_code_execution: "本地代码",
  network_access: "网络访问",
  shell_execute: "命令执行",
  workspace_delete: "删除文件",
  workspace_read: "读取工作区",
  workspace_write: "修改工作区"
};

const ORIGIN_LABELS: Record<Exclude<SkillOrigin, "project">, string> = {
  builtin: "内置",
  global: "全局"
};

function originLabel(origin: SkillOrigin, projectScopeLabel: string): string {
  return origin === "project" ? projectScopeLabel : ORIGIN_LABELS[origin];
}

type OriginFilter = "all" | SkillOrigin;
type Confirmation = { kind: "install" } | { kind: "remove"; skill: SkillSummary };

function attentionLabel(skill: SkillSummary): string | undefined {
  if (skill.conflict) return "已被覆盖";
  if (skill.updateState === "available") return "有更新";
  if (skill.updateState === "failed") return "检查失败";
  if (skill.legacy) return "Legacy";
  if (!skill.trusted) return "需重新信任";
  return undefined;
}

function skillErrorMessage(error: unknown): string {
  const message = desktopErrorMessage(error);
  if (/No handler registered for 'desktop:skills:/i.test(message)) {
    return "Skills 服务尚未载入。请完全退出并重新启动 DeepCreator。";
  }
  return message;
}

function SkillRow({
  busy,
  expanded,
  onEnabledToggle,
  onRemove,
  onDisclosure,
  onUpdate,
  projectScopeLabel,
  skill
}: {
  busy: boolean;
  expanded: boolean;
  onEnabledToggle: () => void;
  onRemove: () => void;
  onDisclosure: () => void;
  onUpdate: () => void;
  projectScopeLabel: string;
  skill: SkillSummary;
}) {
  const attention = attentionLabel(skill);
  return (
    <article className={`skill-row${expanded ? " is-expanded" : ""}${skill.conflict ? " has-conflict" : ""}`}>
      <div className="skill-row-main">
        <button aria-expanded={expanded} className="skill-row-disclosure" onClick={onDisclosure} type="button">
          <span className="skill-row-icon"><Blocks aria-hidden="true" size={16} /></span>
          <span className="skill-row-copy">
            <span className="skill-row-title">
              <strong>{skill.displayName}</strong>
              <code>v{skill.version}</code>
            </span>
            <span className="skill-row-description">{skill.description}</span>
          </span>
          {attention && <span className={`skill-attention is-${skill.updateState}`}>{attention}</span>}
          <span className="skill-origin">{originLabel(skill.origin, projectScopeLabel)}</span>
          <ChevronDown aria-hidden="true" className="skill-row-chevron" size={15} />
        </button>
        <label className="skill-switch">
          <input
            aria-label={`${skill.enabled ? "停用" : "启用"}${skill.displayName}`}
            checked={skill.enabled}
            disabled={busy}
            onChange={onEnabledToggle}
            type="checkbox"
          />
          <span aria-hidden="true" />
        </label>
      </div>
      {expanded && (
        <div className="skill-row-detail">
          {skill.conflict && <div className="skill-inline-warning">{skill.conflict}</div>}
          <dl>
            <div><dt>发布者</dt><dd>{skill.publisher}</dd></div>
            <div><dt>来源</dt><dd><code title={skill.source}>{skill.source}</code></dd></div>
            <div><dt>内容哈希</dt><dd><code title={skill.revisionHash}>{skill.revisionHash}</code></dd></div>
            <div><dt>权限</dt><dd className="skill-permission-list">{skill.permissions.map((permission) => <span key={permission}>{PERMISSION_LABELS[permission]}</span>)}</dd></div>
          </dl>
          <div className="skill-row-actions">
            {skill.updateState === "available" && <PillButton disabled={busy} onClick={onUpdate}><RefreshCw size={14} />查看更新</PillButton>}
            {!skill.locked && <PillButton className="is-danger" disabled={busy} onClick={onRemove}><Trash2 size={14} />移到废纸篓</PillButton>}
            {skill.locked && <span><ShieldCheck size={14} />随 DeepCreator 更新</span>}
          </div>
        </div>
      )}
    </article>
  );
}

export function SkillsSettings({
  active = true,
  projectRoot,
  workspaceKind
}: {
  active?: boolean;
  projectRoot?: string;
  workspaceKind?: WorkspaceKind;
}) {
  const desktop = desktopBridge();
  const installMenuRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<OriginFilter>("all");
  const [githubUrl, setGithubUrl] = useState("");
  const [installMenuOpen, setInstallMenuOpen] = useState(false);
  const [preview, setPreview] = useState<SkillInstallPreview | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SkillInstallScope>(projectRoot ? "project" : "global");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [trusted, setTrusted] = useState(false);
  const projectScopeLabel = workspaceKind === "scratch" ? "当前临时任务" : "当前项目";

  const load = useCallback(async () => {
    if (!desktop) return;
    setBusy(true);
    setError(null);
    try {
      setSkills(await desktop.skills.list(projectRoot));
    } catch (cause) {
      setError(skillErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [desktop, projectRoot]);

  useEffect(() => { if (active) void load(); }, [active, load]);
  useEffect(() => { if (!projectRoot && scope === "project") setScope("global"); }, [projectRoot, scope]);
  useEffect(() => {
    if (!installMenuOpen) return undefined;
    const close = (event: PointerEvent) => {
      if (!installMenuRef.current?.contains(event.target as Node)) setInstallMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setInstallMenuOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [installMenuOpen]);

  const counts = useMemo(() => ({
    all: skills.length,
    builtin: skills.filter((skill) => skill.origin === "builtin").length,
    global: skills.filter((skill) => skill.origin === "global").length,
    project: skills.filter((skill) => skill.origin === "project").length
  }), [skills]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return skills.filter((skill) => (filter === "all" || skill.origin === filter) && (!normalized || [
      skill.name, skill.displayName, skill.description, skill.publisher
    ].some((value) => value.toLocaleLowerCase().includes(normalized))));
  }, [filter, query, skills]);

  const perform = async (action: () => Promise<SkillSummary[]>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      setSkills(await action());
      return true;
    } catch (cause) {
      setError(skillErrorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const showPreview = (next: SkillInstallPreview, preferredScope?: SkillInstallScope) => {
    setPreview(next);
    setScope(preferredScope ?? (projectRoot ? "project" : "global"));
    setTrusted(false);
    setError(null);
    setInstallMenuOpen(false);
  };

  const previewLocal = async () => {
    if (!desktop) return;
    setBusy(true);
    setError(null);
    try {
      const next = await desktop.skills.previewLocal();
      if (next) showPreview(next);
    } catch (cause) {
      setError(skillErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const previewGitHub = async () => {
    if (!desktop || !githubUrl.trim()) return;
    setBusy(true);
    setError(null);
    try {
      showPreview(await desktop.skills.previewGitHub(githubUrl.trim()));
    } catch (cause) {
      setError(skillErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (!desktop || !preview) return;
    setConfirmation(null);
    if (await perform(() => desktop.skills.install({ previewId: preview.previewId, projectRoot, scope, trusted }))) setPreview(null);
  };

  const update = async (skill: SkillSummary) => {
    if (!desktop) return;
    setBusy(true);
    setError(null);
    try {
      showPreview(await desktop.skills.update({ name: skill.name, projectRoot, scope: skill.origin }), skill.origin as SkillInstallScope);
    } catch (cause) {
      setError(skillErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggleExpanded = (skill: SkillSummary) => setExpanded((current) => {
    const next = new Set(current);
    const key = `${skill.origin}:${skill.name}`;
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const tabs: Array<{ id: OriginFilter; label: string }> = [
    { id: "all", label: "全部" },
    { id: "builtin", label: "内置" },
    { id: "global", label: "全局" },
    { id: "project", label: projectScopeLabel }
  ];

  return (
    <section className="settings-page skills-settings-page">
      <header className="skills-page-header">
        <div className="skills-page-heading">
          <h1>技能</h1>
          <p>管理 DeepCreator 的工作流、参考资料和可信脚本。</p>
        </div>
        <div className="skills-page-actions" ref={installMenuRef}>
          <PillButton disabled={busy || !desktop} onClick={() => desktop && void perform(() => desktop.skills.checkUpdates(projectRoot))}>
            <RefreshCw className={busy ? "is-spinning" : ""} size={14} />检查更新
          </PillButton>
          <button
            aria-expanded={installMenuOpen}
            className="skill-install-trigger"
            disabled={busy || !desktop}
            onClick={() => setInstallMenuOpen((open) => !open)}
            type="button"
          >
            <Download size={14} />安装技能<ChevronDown size={14} />
          </button>
          {installMenuOpen && (
            <FloatingSurface className="skill-install-menu">
              <header><div><strong>安装第三方技能</strong><span>安装前会先展示文件、权限和脚本。</span></div><IconButton label="关闭安装菜单" onClick={() => setInstallMenuOpen(false)}><X size={15} /></IconButton></header>
              <button className="skill-local-source" onClick={() => void previewLocal()} type="button">
                <FolderOpen size={17} /><span><strong>从本地选择</strong><small>文件夹、.deepcreator-skill 或 ZIP</small></span>
              </button>
              <form onSubmit={(event) => { event.preventDefault(); void previewGitHub(); }}>
                <label htmlFor="skill-github-url"><Github size={16} /><span>公开 GitHub 仓库或 Release</span></label>
                <div><input id="skill-github-url" onChange={(event) => setGithubUrl(event.target.value)} placeholder="https://github.com/owner/repository" value={githubUrl} /><button disabled={!githubUrl.trim()} type="submit">预览</button></div>
              </form>
            </FloatingSurface>
          )}
        </div>
      </header>

      {!desktop && <div className="skill-message">技能管理只在 DeepCreator 桌面应用中可用。</div>}
      {workspaceKind === "scratch" && <div className="skill-message">这里的任务级技能只在当前临时任务中生效；选择“所有项目”可供当前用户长期使用。</div>}
      {error && <div className="skill-message is-error" role="alert"><span>{error}</span><button disabled={busy} onClick={() => void load()} type="button">重新载入</button></div>}

      {preview && (
        <section aria-label="技能安装预览" className="skill-install-preview">
          <header>
            <div><span>安全预览</span><h2>{preview.displayName} <code>v{preview.version}</code></h2><p>{preview.description}</p></div>
            <IconButton disabled={busy} label="关闭安装预览" onClick={() => setPreview(null)}><X size={17} /></IconButton>
          </header>
          <div className="skill-preview-summary"><span>发布者<strong>{preview.publisher}</strong></span><span>文件<strong>{preview.files.length} 个</strong></span><span>脚本<strong>{preview.scripts.length} 个</strong></span><span>最低版本<strong>{preview.minDeepCreatorVersion}</strong></span></div>
          <div className="skill-preview-permissions"><strong>权限</strong><div>{preview.permissions.map((permission) => <span key={permission}>{PERMISSION_LABELS[permission]}</span>)}</div></div>
          {preview.scripts.length > 0 && <div className="skill-preview-scripts"><strong>声明脚本</strong>{preview.scripts.map((script) => <div key={script.id}><code>{script.id}</code><span>{script.description}</span></div>)}</div>}
          <footer>
            <label>安装范围<select onChange={(event) => setScope(event.target.value as SkillInstallScope)} value={scope}><option value="global">所有项目</option>{projectRoot && <option value="project">{projectScopeLabel}</option>}</select></label>
            <label className="skill-trust-check"><input checked={trusted} onChange={(event) => setTrusted(event.target.checked)} type="checkbox" /><span>我信任此发布者、内容哈希、权限和脚本。内容更新后重新确认。</span></label>
            <button className="is-primary" disabled={busy || !trusted} onClick={() => preview.scripts.length > 0 ? setConfirmation({ kind: "install" }) : void install()} type="button">安装技能</button>
          </footer>
        </section>
      )}

      <div className="skill-catalog-toolbar">
        <div aria-label="技能来源" className="skill-source-tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              aria-selected={filter === tab.id}
              className={filter === tab.id ? "is-active" : ""}
              disabled={tab.id === "project" && !projectRoot}
              key={tab.id}
              onClick={() => setFilter(tab.id)}
              role="tab"
              type="button"
            >
              {tab.label}<span>{counts[tab.id]}</span>
            </button>
          ))}
        </div>
        <label className="skill-search"><Search size={15} /><input aria-label="搜索技能" onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能" value={query} /></label>
      </div>

      <div aria-busy={busy} className="skill-catalog-list">
        {visible.map((skill) => (
          <SkillRow
            busy={busy}
            expanded={expanded.has(`${skill.origin}:${skill.name}`)}
            key={`${skill.origin}:${skill.name}`}
            onDisclosure={() => toggleExpanded(skill)}
            onEnabledToggle={() => void perform(() => desktop!.skills.setEnabled({ enabled: !skill.enabled, name: skill.name, projectRoot, scope: skill.origin }))}
            onRemove={() => setConfirmation({ kind: "remove", skill })}
            onUpdate={() => void update(skill)}
            projectScopeLabel={projectScopeLabel}
            skill={skill}
          />
        ))}
        {visible.length === 0 && !error && <div className="skill-empty">{busy ? "正在读取技能…" : query ? "没有匹配的技能" : "这里还没有技能"}</div>}
      </div>

      {confirmation?.kind === "install" && (
        <ConfirmationDialog
          busy={busy}
          confirmLabel="信任并安装"
          danger
          description="此技能含可执行脚本。安装信任允许脚本以当前系统用户权限运行；DeepCreator 会隔离模型与服务令牌，但这不是完整的操作系统沙箱。"
          onCancel={() => setConfirmation(null)}
          onConfirm={() => void install()}
          title="确认信任技能脚本"
        />
      )}
      {confirmation?.kind === "remove" && (
        <ConfirmationDialog
          busy={busy}
          confirmLabel="移到废纸篓"
          danger
          description={`将 ${confirmation.skill.displayName} 从${originLabel(confirmation.skill.origin, projectScopeLabel)}移到系统废纸篓。`}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            const skill = confirmation.skill;
            setConfirmation(null);
            void perform(() => desktop!.skills.remove({ name: skill.name, projectRoot, scope: skill.origin }));
          }}
          title="卸载技能"
        />
      )}
    </section>
  );
}
