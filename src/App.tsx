import { useState, useEffect } from "react";
import { Sidebar } from "./components/layout/Sidebar";
import { MainContent } from "./components/layout/MainContent";
import { useThemeStore } from "./stores/themeStore";
import { FileEditorWindow } from "./components/editor/FileEditorWindow";

function App() {
  const [activeView, setActiveView] = useState<"servers" | "providers" | "terminal">("servers");
  const { theme } = useThemeStore();
  const [isEditorMode, setIsEditorMode] = useState(false);

  useEffect(() => {
    // 检查 URL 参数是否为编辑器模式
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'editor') {
      setIsEditorMode(true);
    }
  }, []);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  // 如果是编辑器模式，渲染独立编辑器窗口
  if (isEditorMode) {
    return <FileEditorWindow />;
  }

  // Using bg-surface-50 for light mode (clean look) and bg-surface-950 for dark mode
  return (
    <div className="flex h-full bg-surface-50 dark:bg-surface-950 text-surface-900 dark:text-surface-100 transition-colors duration-300">
      {/* 侧边栏 */}
      <Sidebar activeView={activeView} onViewChange={setActiveView} />
      
      {/* 主内容区 */}
      <MainContent activeView={activeView} onNavigate={setActiveView} />
    </div>
  );
}

export default App;
