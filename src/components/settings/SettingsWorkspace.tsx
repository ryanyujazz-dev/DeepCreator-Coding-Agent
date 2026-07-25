import {
  ArrowLeft,
  Bot,
  KeyRound,
  Search,
  Settings,
  SlidersHorizontal,
  SunMoon
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PanelResizeHandle } from "../PanelResizeHandle";
import { AppearanceSettings } from "./AppearanceSettings";
import { ModelSettings } from "./ModelSettings";

type SettingsSection = "general" | "appearance" | "models";

const sections: Array<{
  icon: typeof Settings;
  id: SettingsSection;
  keywords: string[];
  label: string;
}> = [
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
  }
];

function GeneralSettings() {
  return (
    <section className="settings-page">
      <header className="settings-page-header">
        <h1>常规</h1>
        <p>管理 DeepSeeker 的本地桌面体验。</p>
      </header>
      <div className="settings-preference-section">
        <h2>应用</h2>
        <div className="settings-preference-row">
          <div><strong>DeepSeeker CodeAgent</strong><span>本地 Agent Runtime 与桌面工作区</span></div>
          <span className="settings-readonly-value">0.1.0</span>
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
  onClose,
  onWidthChange,
  onWidthReset,
  sidebarWidth
}: {
  onClose: () => void;
  onWidthChange: (width: number) => void;
  onWidthReset: () => void;
  sidebarWidth: number;
}) {
  const [active, setActive] = useState<SettingsSection>("appearance");
  const [query, setQuery] = useState("");
  const visibleSections = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return sections;
    return sections.filter((section) => section.keywords.some((keyword) => keyword.toLocaleLowerCase().includes(normalized)));
  }, [query]);
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
                onClick={() => setActive(section.id)}
                type="button"
              >
                <Icon size={16} />
                <span>{section.label}</span>
              </button>
            );
          })}
          {visibleSections.length === 0 && <div className="settings-search-empty">没有匹配的设置</div>}
        </nav>
        <div className="settings-sidebar-footer"><Bot size={16} /><span>DeepSeeker</span></div>
        <PanelResizeHandle ariaLabel="调整设置侧栏宽度" edge="right" max={360} min={220} onChange={onWidthChange} onReset={onWidthReset} value={sidebarWidth} />
      </aside>
      <main className="settings-main">
        <div className="settings-mobile-navigation">
          <button onClick={onClose} type="button"><ArrowLeft size={15} />返回</button>
          <select aria-label="设置页面" onChange={(event) => setActive(event.target.value as SettingsSection)} value={active}>
            {sections.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}
          </select>
          <SlidersHorizontal size={15} />
        </div>
        <div className="settings-content">
          {active === "general" && <GeneralSettings />}
          {active === "appearance" && <AppearanceSettings />}
          {active === "models" && <ModelSettings />}
        </div>
      </main>
    </>
  );
}
