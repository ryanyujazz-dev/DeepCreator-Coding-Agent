import { ArrowLeft, ArrowRight, PanelLeft } from "lucide-react";

export function AppTopbar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  return (
    <header className="app-menubar">
      <div className="app-menubar-navigation">
        <button aria-label="切换侧边栏" onClick={onToggleSidebar} title="切换侧边栏" type="button">
          <PanelLeft size={15} />
        </button>
        <button aria-label="返回" className="is-muted" onClick={() => window.history.back()} title="返回" type="button">
          <ArrowLeft size={16} />
        </button>
        <button aria-label="前进" className="is-muted" onClick={() => window.history.forward()} title="前进" type="button">
          <ArrowRight size={16} />
        </button>
      </div>
      <nav aria-label="应用菜单" className="app-menu-items">
        <span>文件</span>
        <span>编辑</span>
        <span>视图</span>
        <span>帮助</span>
      </nav>
      <div aria-hidden="true" className="app-menubar-drag-region" />
    </header>
  );
}
