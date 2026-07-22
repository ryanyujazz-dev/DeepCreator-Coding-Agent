import { ArrowLeft, ArrowRight, PanelLeft } from "lucide-react";
import { IconButton } from "../shared-ui/ControlPrimitives";

export function AppTopbar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  return (
    <header className="app-menubar">
      <div className="app-menubar-navigation">
        <IconButton label="切换侧边栏" onClick={onToggleSidebar}>
          <PanelLeft size={15} />
        </IconButton>
        <IconButton className="is-muted" label="返回" onClick={() => window.history.back()}>
          <ArrowLeft size={16} />
        </IconButton>
        <IconButton className="is-muted" label="前进" onClick={() => window.history.forward()}>
          <ArrowRight size={16} />
        </IconButton>
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
