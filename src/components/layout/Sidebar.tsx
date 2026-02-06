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

  const navButtonBaseClass =
    "group relative mx-auto flex h-10 w-10 sm:h-11 sm:w-11 items-center justify-center rounded-2xl transition-all duration-200 hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-surface-950";
  const navButtonNormalClass =
    "text-surface-500 hover:bg-surface-100/90 hover:text-surface-900 hover:shadow-sm dark:text-surface-400 dark:hover:bg-surface-800 dark:hover:text-surface-100";
  const navButtonActiveClass =
    "bg-gradient-to-br from-primary-50 to-primary-100 text-primary-700 ring-1 ring-primary-200 shadow-[0_12px_24px_rgba(13,148,136,0.2)] dark:from-primary-500/20 dark:to-primary-500/10 dark:text-primary-300 dark:ring-primary-400/35";
  const tooltipClass =
    "pointer-events-none absolute left-full z-[90] ml-3 -translate-x-1 whitespace-nowrap rounded-lg bg-surface-900 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-lg transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100 dark:bg-surface-100 dark:text-surface-900";

  return (
    <aside className="relative z-30 w-[74px] sm:w-[88px] h-full shrink-0 overflow-visible border-r border-surface-200/90 bg-white/95 dark:border-surface-800 dark:bg-surface-950 flex flex-col items-center py-4 transition-colors duration-300">
      {/* Logo */}
      <div className="group relative mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-500 to-primary-700 shadow-lg shadow-primary-500/20">
        <Terminal className="h-5 w-5 text-white" />
        <span className={tooltipClass}>AI-SSH</span>
      </div>

      {/* 导航 */}
      <nav className="flex-1 w-full px-3 space-y-2">
        {menuItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onViewChange(item.id)}
            title={item.label}
            aria-label={item.label}
            className={`${navButtonBaseClass} w-full ${
              activeView === item.id ? navButtonActiveClass : navButtonNormalClass
            }`}
          >
            <item.icon className="w-5 h-5" />
            <span className={tooltipClass}>{item.label}</span>
          </button>
        ))}
      </nav>

      {/* 底部区域 */}
      <div className="w-full px-3 space-y-2">
        <SidebarTransferPanel compact />

        <div className="pt-2 border-t border-surface-200 dark:border-surface-800 space-y-2 transition-colors duration-300">
          <button
            onClick={toggleTheme}
            title={theme === 'dark' ? '浅色模式' : '深色模式'}
            aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
            className={`${navButtonBaseClass} w-full ${navButtonNormalClass}`}
          >
            {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            <span className={tooltipClass}>{theme === 'dark' ? '浅色模式' : '深色模式'}</span>
          </button>
          <button
            title="设置"
            aria-label="设置"
            className={`${navButtonBaseClass} w-full ${navButtonNormalClass}`}
          >
            <Settings className="w-5 h-5" />
            <span className={tooltipClass}>设置</span>
          </button>
        </div>
      </div>

    </aside>
  );
}
