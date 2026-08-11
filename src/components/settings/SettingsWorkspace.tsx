import {
  ArrowLeft,
  Beaker,
  Bot,
  Blocks,
  KeyRound,
  Search,
  Settings,
  SlidersHorizontal,
  SunMoon,
  UserRound
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { WorkspaceKind } from "../../../shared/contracts/runtime";
import { PanelResizeHandle } from "../PanelResizeHandle";
import { AppearanceSettings } from "./AppearanceSettings";
import { ModelSettings } from "./ModelSettings";
import { SkillsSettings } from "./SkillsSettings";
import { AccountSettings } from "./AccountSettings";
import { AuthState } from "../../../shared/contracts/auth";
import { desktopBridge } from "../../platform/desktop";

type SettingsSection = "account" | "general" | "appearance" | "models" | "skills" | "evals";

type SettingsSectionDefinition = {
  icon: typeof Settings;
  id: SettingsSection;
  keywords: string[];
  label: string;
};

const sections: SettingsSectionDefinition[] = [
  {
    icon: UserRound,
    id: "account",
    keywords: ["profile", "本地", "身份", "账号", "登录", "github", "退出", "注销", "离线"],
    label: "Profile"
  },
  {
    icon: Settings,
    id: "general",
    keywords: ["常规", "关于", "版本", "设置", "应用", "数据范围", "本地"],
    label: "常规"
  },
  {
    icon: SunMoon,
    id: "appearance",
    keywords: [
      "外观", "主题", "系统", "颜色", "字体", "深色", "浅色", "强调色", "背景", "前景",
      "半透明侧边栏", "对比度", "diff", "代码", "语法", "导入", "导出"
    ],
    label: "外观"
  },
  {
    icon: KeyRound,
    id: "models",
    keywords: ["模型", "默认模型", "api", "key", "deepseek", "智谱", "凭据"],
    label: "模型与 API"
  },
  {
    icon: Blocks,
    id: "skills",
    keywords: ["skill", "skills", "能力", "安装", "权限", "脚本", "更新", "内置", "项目"],
    label: "技能"
  },
  ...(import.meta.env.DEV ? [{
    icon: Beaker,
    id: "evals" as const,
    keywords: ["评测", "eval", "case", "模型", "judge", "开发者"],
    label: "评测中心"
  }] : [])
];

function GeneralSettings() {
  const [version, setVersion] = useState("—");
  useEffect(() => {
    let active = true;
    void desktopBridge()?.updates.getState().then((state) => {
      if (active) setVersion(state.currentVersion);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  return (
    <section className="settings-page">
      <header className="settings-page-header">
        <h1>常规</h1>
        <p>管理 DeepCreator 的本地桌面体验。</p>
      </header>
      <div className="settings-preference-section">
        <h2>应用</h2>
        <div className="settings-preference-row">
          <div><strong>DeepCreator CodeAgent</strong><span>本地 Agent Runtime 与桌面工作区</span></div>
          <span className="settings-readonly-value">{version}</span>
        </div>
        <div className="settings-preference-row">
          <div><strong>数据范围</strong><span>主题和桌面偏好保存在本机，不进入模型上下文。</span></div>
          <span className="settings-readonly-value">仅本机</span>
        </div>
      </div>
    </section>
  );
}

export function SettingsWorkspace({
  authState,
  currentProjectRoot,
  currentWorkspaceKind,
  onClose,
  onOpenEvals,
  onWidthChange,
  onWidthReset,
  sidebarWidth,
  showEvals = false,
  visible = true
}: {
  authState?: AuthState;
  currentProjectRoot?: string;
  currentWorkspaceKind?: WorkspaceKind;
  onClose: () => void;
  onOpenEvals?: () => void;
  onWidthChange: (width: number) => void;
  onWidthReset: () => void;
  sidebarWidth: number;
  showEvals?: boolean;
  visible?: boolean;
}) {
  const [active, setActive] = useState<SettingsSection>("appearance");
  const [query, setQuery] = useState("");
  const visibleSections = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const available = sections.filter((section) => section.id !== "evals" || showEvals);
    if (!normalized) return available;
    return available.filter((section) => section.keywords.some((keyword) => keyword.toLocaleLowerCase().includes(normalized)));
  }, [query, showEvals]);
  useEffect(() => {
    if (query.trim() && visibleSections.length > 0 && !visibleSections.some((section) => section.id === active)) {
      setActive(visibleSections[0].id);
    }
  }, [active, query, visibleSections]);

  return (
    <>
      <aside className="settings-sidebar">
        <button className="settings-back-button" onClick={onClose} type="button"><ArrowLeft size={15} /><span>返回应用</span></button>
        <label className="settings-search">
          <Search size={14} />
          <input aria-label="搜索设置" onChange={(event) => setQuery(event.target.value)} placeholder="搜索设置..." value={query} />
        </label>
        <nav aria-label="设置导航" className="settings-navigation">
          <h2>个人</h2>
          {visibleSections.map((section) => {
            const Icon = section.icon;
            return (
              <button
                aria-current={active === section.id ? "page" : undefined}
                className={active === section.id ? "is-active" : ""}
                key={section.id}
                onClick={() => section.id === "evals" && onOpenEvals ? onOpenEvals() : setActive(section.id)}
                type="button"
              >
                <Icon size={16} />
                <span>{section.label}</span>
              </button>
            );
          })}
          {visibleSections.length === 0 && <div className="settings-search-empty">没有匹配的设置</div>}
        </nav>
        <div className="settings-sidebar-footer"><Bot size={16} /><span>DeepCreator</span></div>
        <PanelResizeHandle ariaLabel="调整设置侧栏宽度" edge="right" max={360} min={220} onChange={onWidthChange} onReset={onWidthReset} value={sidebarWidth} />
      </aside>
      <main className="settings-main">
        <div className="settings-mobile-navigation">
          <button onClick={onClose} type="button"><ArrowLeft size={15} />返回</button>
          <select aria-label="设置页面" onChange={(event) => {
            const next = event.target.value as SettingsSection;
            if (next === "evals" && onOpenEvals) onOpenEvals();
            else setActive(next);
          }} value={active}>
            {sections.filter((section) => section.id !== "evals" || showEvals).map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}
          </select>
          <SlidersHorizontal size={15} />
        </div>
        <div className="settings-content">
          {active === "account" && <AccountSettings authState={authState} />}
          {active === "general" && <GeneralSettings />}
          {active === "appearance" && <AppearanceSettings />}
          {active === "models" && <ModelSettings />}
          {active === "skills" && <SkillsSettings active={visible} projectRoot={currentProjectRoot} workspaceKind={currentWorkspaceKind} />}
        </div>
      </main>
    </>
  );
}
