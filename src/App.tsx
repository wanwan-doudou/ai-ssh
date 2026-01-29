import { useState, useEffect } from "react";
import { Sidebar } from "./components/layout/Sidebar";
import { MainContent } from "./components/layout/MainContent";
import { useThemeStore } from "./stores/themeStore";

function App() {
  const [activeView, setActiveView] = useState<"servers" | "providers" | "terminal">("servers");
  const { theme } = useThemeStore();

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

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
