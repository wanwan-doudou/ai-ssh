import { 
  Server, 
  Terminal, 
  Bot, 
  Settings,
  Sun,
  Moon,
} from "lucide-react";
import { useThemeStore } from "../../stores/themeStore";
import { SidebarTransferPanel } from "./SidebarTransferPanel";

interface SidebarProps {
  activeView: "servers" | "providers" | "terminal";
  onViewChange: (view: "servers" | "providers" | "terminal") => void;
}

export function Sidebar({ activeView, onViewChange }: SidebarProps) {
  const { theme, toggleTheme } = useThemeStore();

  const menuItems = [
    { id: "servers" as const, label: "服务器", icon: Server },
    { id: "providers" as const, label: "AI 配置", icon: Bot },
    { id: "terminal" as const, label: "终端", icon: Terminal },
  ];

  return (
    <aside className="w-64 h-full bg-white dark:bg-surface-950 border-r border-surface-200 dark:border-surface-800 flex flex-col transition-colors duration-300">
      {/* Logo 区域 */}
      <div className="h-16 flex items-center px-4 border-b border-surface-200 dark:border-surface-800 transition-colors duration-300">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center shadow-lg shadow-primary-500/20">
            <Terminal className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-surface-900 dark:text-white transition-colors duration-300">AI-SSH</h1>
            <p className="text-xs text-surface-500">智能终端</p>
          </div>
        </div>
      </div>

      {/* 导航菜单 */}
      <nav className="flex-1 p-3 space-y-1">
        {menuItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onViewChange(item.id)}
            className={`sidebar-item w-full ${activeView === item.id ? "active" : ""}`}
          >
            <item.icon className="w-5 h-5" />
            <span className="font-medium">{item.label}</span>
          </button>
        ))}
      </nav>

      {/* 传输任务面板 */}
      <SidebarTransferPanel />

      {/* 底部设置 */}
      <div className="p-3 border-t border-surface-200 dark:border-surface-800 space-y-1 transition-colors duration-300">
        <button 
          onClick={toggleTheme}
          className="sidebar-item w-full"
        >
          {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          <span className="font-medium">{theme === 'dark' ? '浅色模式' : '深色模式'}</span>
        </button>
        <button className="sidebar-item w-full">
          <Settings className="w-5 h-5" />
          <span className="font-medium">设置</span>
        </button>
      </div>
    </aside>
  );
}
