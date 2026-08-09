export function AppTopbar() {
  return (
    <header className="app-menubar">
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
