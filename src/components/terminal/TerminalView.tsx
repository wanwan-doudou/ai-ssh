import { useEffect, useRef, useState, useCallback, memo } from "react";
import { useStoreWithEqualityFn } from 'zustand/traditional';
import {
  Terminal as TerminalIcon,
  Plus,
  X,
  Server,
  Bot,
  FolderOpen,
  ChevronDown,
  ChevronUp,
  Activity,
  Clock3,
  Cpu,
  HardDrive,
  Network,
  RefreshCw,
  ChevronLeft,
  ChevronRight
} from "lucide-react";
import { useServerStore } from "@/stores/serverStore";
import { useChatStore } from "@/stores/chatStore";
import {
  stripInternalCommandControlLines,
  useTerminalOutputStore
} from "@/stores/terminalOutputStore";
import { AiChatPanel } from "./AiChatPanel";
import { ResizableDivider } from "./ResizableDivider";
import { FileExplorer } from "./FileExplorer";
import { HorizontalDivider } from "./HorizontalDivider";
// TerminalSession type 暂未使用，session 类型为 any
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useTerminalStore } from "@/stores/terminalStore";
import { useThemeStore } from "@/stores/themeStore";
import { useTerminalDirectoryStore } from "@/stores/terminalDirectoryStore";
import type {
  ServerRuntimeInfo,
  ServerProcessInfo,
  ServerNetworkConnection,
  ServerFilesystemInfo
} from "@/types";
import { useShallow } from 'zustand/react/shallow';

const darkTheme = {
  background: "#0f172a",
  foreground: "#e2e8f0",
  cursor: "#14b8a6",
  cursorAccent: "#0f172a",
  selectionBackground: "#334155",
  black: "#0f172a",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e2e8f0",
  brightBlack: "#475569",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
};

// 浅色主题：使用更深的 ANSI 颜色确保在白色背景上可读
const lightTheme = {
  background: "#ffffff",
  foreground: "#1e293b",  // 深灰色作为主要文字颜色
  cursor: "#0d9488",
  cursorAccent: "#ffffff",
  selectionBackground: "#dbeafe",  // 淡蓝色选中背景
  black: "#1e293b",       // 深灰黑色
  red: "#dc2626",         // 深红色 (red-600)
  green: "#15803d",       // 深绿色 (green-700) - 确保在白底上清晰可读
  yellow: "#a16207",      // 深黄/棕色 (yellow-700) - 避免浅黄难以辨认
  blue: "#1d4ed8",        // 深蓝色 (blue-700)
  magenta: "#7e22ce",     // 深紫色 (purple-700)
  cyan: "#0e7490",        // 深青色 (cyan-700)
  white: "#475569",       // 中灰色 (slate-600) - 用于普通文本
  brightBlack: "#64748b", // 中灰色 (slate-500)
  brightRed: "#b91c1c",   // 暗红色 (red-700)
  brightGreen: "#166534", // 暗绿色 (green-800)
  brightYellow: "#854d0e",// 暗棕色 (yellow-800)
  brightBlue: "#1e40af",  // 暗蓝色 (blue-800)
  brightMagenta: "#6b21a8",// 暗紫色 (purple-800)
  brightCyan: "#155e75",  // 暗青色 (cyan-800)
  brightWhite: "#1e293b", // 深灰色 (slate-800)
};

type ThemeMode = 'light' | 'dark';

const getTerminalTheme = (themeMode: ThemeMode) => (
  themeMode === 'dark' ? { ...darkTheme } : { ...lightTheme }
);

const applyTerminalTheme = (term: any, container: HTMLDivElement, themeMode: ThemeMode) => {
  const nextTheme = getTerminalTheme(themeMode);
  const bgColor = nextTheme.background || '#000000';
  const fgColor = nextTheme.foreground || '#ffffff';

  // 不要整体替换 options（会把 cols/rows 带回去并触发 xterm 报错）
  try {
    term.options.theme = nextTheme;
    term.options.minimumContrastRatio = themeMode === 'light' ? 4.5 : 1;
  } catch (e) {
    console.warn('[TerminalView] Failed to update terminal theme options:', e);
  }

  container.style.setProperty('background-color', bgColor, 'important');
  container.style.setProperty('color', fgColor, 'important');

  const xtermElements = container.querySelectorAll('.xterm, .xterm-viewport, .xterm-screen, .xterm-rows');
  xtermElements.forEach((el) => {
    const element = el as HTMLElement;
    element.style.setProperty('background-color', bgColor, 'important');
    element.style.setProperty('color', fgColor, 'important');
  });

  if (typeof term.clearTextureAtlas === 'function') {
    term.clearTextureAtlas();
  }

  if (typeof term.refresh === 'function' && term.rows > 0) {
    term.refresh(0, term.rows - 1);
    requestAnimationFrame(() => {
      try {
        if (typeof term.clearTextureAtlas === 'function') {
          term.clearTextureAtlas();
        }
        if (typeof term.refresh === 'function' && term.rows > 0) {
          term.refresh(0, term.rows - 1);
        }
      } catch (e) {
        console.warn('[TerminalView] Theme repaint skipped:', e);
      }
    });
  }
};

// 自定义相等性检查函数：忽略 buffer 字段的变化
// 只有当 id, serverId, serverName, isConnected 发生变化时才触发更新
const sessionsEquality = (prev: any[], next: any[]) => {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  return prev.every((p, i) => {
    const n = next[i];
    return p.id === n.id && 
           p.serverId === n.serverId && 
           p.serverName === n.serverName && 
           p.isConnected === n.isConnected;
  });
};

const bytesFromKb = (valueKb: number) => Math.max(valueKb, 0) * 1024;

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
};

const formatPercent = (value: number) => {
  if (!Number.isFinite(value) || value < 0) return "0%";
  return `${Math.min(value, 100).toFixed(1)}%`;
};

const RUNTIME_REFRESH_MS = 3000;
const DETAIL_REFRESH_MS = 2000;
const FILESYSTEM_REFRESH_MS = 8000;

type ServerDetailKind = "overview" | "processes" | "network" | "memory" | "disk";

interface ServerDetailTab {
  id: string;
  sessionId: string;
  kind: ServerDetailKind;
}

const SERVER_DETAIL_LABELS: Record<ServerDetailKind, string> = {
  overview: "系统信息",
  processes: "进程",
  network: "网络",
  memory: "内存",
  disk: "磁盘",
};

export function TerminalView() {
  const { servers, fetchServers } = useServerStore();
  
  // 直接获取 sessions，并使用自定义相等性检查
  // 使用 useStoreWithEqualityFn 显式调用以支持 equalityFn 参数 (Zustand v5)
  const sessions = useStoreWithEqualityFn(useTerminalStore, state => state.sessions, sessionsEquality);
  
  const { 
    activeSessionId, 
    addSession, 
    removeSession, 
    setActiveSessionId,
    setSessionConnected
  } = useTerminalStore(useShallow(state => ({
    activeSessionId: state.activeSessionId,
    addSession: state.addSession,
    removeSession: state.removeSession,
    setActiveSessionId: state.setActiveSessionId,
    setSessionConnected: state.setSessionConnected
  })));
  const [showServerSelector, setShowServerSelector] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  // SFTP 面板状态
  const [sftpPanelHeight, setSftpPanelHeight] = useState(350);
  const [showSftpPanel, setShowSftpPanel] = useState(false);
  // 待同步的 SFTP 目录（终端 cd 命令触发）
  const [pendingSftpDir, setPendingSftpDir] = useState<string | null>(null);
  const [showServerInfoPanel, setShowServerInfoPanel] = useState(true);
  const [serverInfo, setServerInfo] = useState<ServerRuntimeInfo | null>(null);
  const [serverInfoError, setServerInfoError] = useState<string | null>(null);
  const [isServerInfoLoading, setIsServerInfoLoading] = useState(false);
  const [processList, setProcessList] = useState<ServerProcessInfo[]>([]);
  const [processError, setProcessError] = useState<string | null>(null);
  const [isProcessLoading, setIsProcessLoading] = useState(false);
  const [networkConnections, setNetworkConnections] = useState<ServerNetworkConnection[]>([]);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [isNetworkLoading, setIsNetworkLoading] = useState(false);
  const [filesystems, setFilesystems] = useState<ServerFilesystemInfo[]>([]);
  const [filesystemError, setFilesystemError] = useState<string | null>(null);
  const [isFilesystemLoading, setIsFilesystemLoading] = useState(false);
  const [detailTabs, setDetailTabs] = useState<ServerDetailTab[]>([]);
  const [activeDetailTabId, setActiveDetailTabId] = useState<string | null>(null);
  const refreshingSessionRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  const detailTabsRef = useRef<ServerDetailTab[]>([]);

  // 组件挂载时从后端加载服务器列表
  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  const handleConnect = async (serverId: string) => {
    console.log('[TerminalView] handleConnect 被调用, serverId=', serverId);
    const server = servers.find(s => s.id === serverId);
    if (!server) {
      console.error('[TerminalView] 未找到服务器!');
      return;
    }

    const sessionId = `session_${Date.now()}`;
    console.log('[TerminalView] 创建会话, sessionId=', sessionId);
    
    addSession({
      id: sessionId,
      serverId: server.id,
      serverName: server.name,
      isConnected: false,
      createdAt: Date.now(),
      buffer: '',
    });
    
    setShowServerSelector(false);
    setActiveDetailTabId(null);
  };

  const handleSessionConnected = useCallback((sessionId: string) => {
    setSessionConnected(sessionId, true);
  }, [setSessionConnected]);

  const handleSessionDisconnected = useCallback((sessionId: string) => {
    setSessionConnected(sessionId, false);
  }, [setSessionConnected]);

  // 处理终端目录变化，同步到 SFTP 文件浏览器
  const handleDirectoryChange = useCallback((directory: string) => {
    console.log('[TerminalView] 检测到目录变化:', directory);
    // 设置待同步目录
    setPendingSftpDir(directory);
    // 自动展开 SFTP 面板
    if (!showSftpPanel) {
      setShowSftpPanel(true);
    }
  }, [showSftpPanel]);

  const handleCloseSession = async (sessionId: string) => {
    // 调用后端断开连接
    try {
      await invoke("disconnect_ssh", { sessionId });
    } catch (err) {
      console.error("断开连接失败:", err);
    }
    
    setDetailTabs((prev) => prev.filter((tab) => tab.sessionId !== sessionId));
    setActiveDetailTabId((current) => {
      if (!current) return null;
      const activeTab = detailTabsRef.current.find((tab) => tab.id === current);
      return activeTab?.sessionId === sessionId ? null : current;
    });
    removeSession(sessionId);
  };

  // 引用 Chat Store
  const { panelRatio, setPanelRatio, operationMode: _opMode } = useChatStore();
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // 监听容器宽度变化
  useEffect(() => {
    if (!containerRef.current) return;
    
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    detailTabsRef.current = detailTabs;
  }, [detailTabs]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const activeDetailTab = detailTabs.find((tab) => tab.id === activeDetailTabId) ?? null;

  const fetchServerInfo = useCallback(async (sessionId: string, silent = false) => {
    if (refreshingSessionRef.current === sessionId) {
      return;
    }

    refreshingSessionRef.current = sessionId;
    if (!silent) {
      setIsServerInfoLoading(true);
    }

    try {
      const info = await invoke<ServerRuntimeInfo>("get_server_runtime_info", { sessionId });
      if (activeSessionIdRef.current === sessionId) {
        setServerInfo(info);
        setServerInfoError(null);
      }
    } catch (error) {
      if (activeSessionIdRef.current === sessionId) {
        setServerInfoError(String(error));
      }
    } finally {
      if (refreshingSessionRef.current === sessionId) {
        refreshingSessionRef.current = null;
      }
      if (!silent && activeSessionIdRef.current === sessionId) {
        setIsServerInfoLoading(false);
      }
    }
  }, []);

  const fetchProcessList = useCallback(async (sessionId: string, silent = false) => {
    if (!silent) {
      setIsProcessLoading(true);
    }

    try {
      const items = await invoke<ServerProcessInfo[]>("get_server_process_list", { sessionId, limit: 80 });
      if (activeSessionIdRef.current === sessionId) {
        setProcessList(items);
        setProcessError(null);
      }
    } catch (error) {
      if (activeSessionIdRef.current === sessionId) {
        setProcessError(String(error));
      }
    } finally {
      if (!silent && activeSessionIdRef.current === sessionId) {
        setIsProcessLoading(false);
      }
    }
  }, []);

  const fetchNetworkConnections = useCallback(async (sessionId: string, silent = false) => {
    if (!silent) {
      setIsNetworkLoading(true);
    }

    try {
      const items = await invoke<ServerNetworkConnection[]>("get_server_network_connections", { sessionId, limit: 120 });
      if (activeSessionIdRef.current === sessionId) {
        setNetworkConnections(items);
        setNetworkError(null);
      }
    } catch (error) {
      if (activeSessionIdRef.current === sessionId) {
        setNetworkError(String(error));
      }
    } finally {
      if (!silent && activeSessionIdRef.current === sessionId) {
        setIsNetworkLoading(false);
      }
    }
  }, []);

  const fetchFilesystems = useCallback(async (sessionId: string, silent = false) => {
    if (!silent) {
      setIsFilesystemLoading(true);
    }

    try {
      const items = await invoke<ServerFilesystemInfo[]>("get_server_filesystems", { sessionId, limit: 120 });
      if (activeSessionIdRef.current === sessionId) {
        setFilesystems(items);
        setFilesystemError(null);
      }
    } catch (error) {
      if (activeSessionIdRef.current === sessionId) {
        setFilesystemError(String(error));
      }
    } finally {
      if (!silent && activeSessionIdRef.current === sessionId) {
        setIsFilesystemLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!activeSessionId || !activeSession?.isConnected) {
      setServerInfo(null);
      setServerInfoError(null);
      setIsServerInfoLoading(false);
      setProcessList([]);
      setProcessError(null);
      setIsProcessLoading(false);
      setNetworkConnections([]);
      setNetworkError(null);
      setIsNetworkLoading(false);
      setFilesystems([]);
      setFilesystemError(null);
      setIsFilesystemLoading(false);
      return;
    }

    setServerInfo(null);
    setServerInfoError(null);
    fetchServerInfo(activeSessionId, false);

    const timer = window.setInterval(() => {
      fetchServerInfo(activeSessionId, true);
    }, RUNTIME_REFRESH_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [activeSessionId, activeSession?.isConnected, fetchServerInfo]);

  useEffect(() => {
    if (!activeSessionId || !activeSession?.isConnected || (activeDetailTab?.kind !== "overview" && activeDetailTab?.kind !== "disk")) {
      return;
    }

    setFilesystems([]);
    setFilesystemError(null);
    fetchFilesystems(activeSessionId, false);

    const timer = window.setInterval(() => {
      fetchFilesystems(activeSessionId, true);
    }, FILESYSTEM_REFRESH_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [activeSessionId, activeSession?.isConnected, activeDetailTab?.kind, fetchFilesystems]);

  useEffect(() => {
    if (!activeSessionId || !activeSession?.isConnected || activeDetailTab?.kind !== "processes") {
      return;
    }

    setProcessList([]);
    setProcessError(null);
    fetchProcessList(activeSessionId, false);

    const timer = window.setInterval(() => {
      fetchProcessList(activeSessionId, true);
    }, DETAIL_REFRESH_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [activeSessionId, activeSession?.isConnected, activeDetailTab?.kind, fetchProcessList]);

  useEffect(() => {
    if (!activeSessionId || !activeSession?.isConnected || activeDetailTab?.kind !== "network") {
      return;
    }

    setNetworkConnections([]);
    setNetworkError(null);
    fetchNetworkConnections(activeSessionId, false);

    const timer = window.setInterval(() => {
      fetchNetworkConnections(activeSessionId, true);
    }, DETAIL_REFRESH_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [activeSessionId, activeSession?.isConnected, activeDetailTab?.kind, fetchNetworkConnections]);

  const handleExecuteCommand = (command: string, options?: { appendNewline?: boolean }) => {
    if (!activeSessionId) return;
    
    const data = options?.appendNewline === false ? command : `${command}\n`;

    // 调用后端执行命令
    invoke("write_ssh", {
      sessionId: activeSessionId,
      data,
    }).catch(console.error);
  };

  const handleOpenServerDetail = useCallback((kind: ServerDetailKind) => {
    if (!activeSessionId) return;
    const tabId = `detail-${activeSessionId}-${kind}`;

    setDetailTabs((prev) => {
      if (prev.some((tab) => tab.id === tabId)) {
        return prev;
      }
      return [...prev, { id: tabId, sessionId: activeSessionId, kind }];
    });

    setActiveSessionId(activeSessionId);
    setActiveDetailTabId(tabId);
  }, [activeSessionId, setActiveSessionId]);

  const handleCloseDetailTab = useCallback((tabId: string) => {
    setDetailTabs((prev) => prev.filter((tab) => tab.id !== tabId));
    setActiveDetailTabId((current) => (current === tabId ? null : current));
  }, []);

  const handleRefreshDetail = useCallback(() => {
    if (!activeSession) return;

    if (activeDetailTab?.kind === "overview") {
      fetchServerInfo(activeSession.id, false);
      fetchFilesystems(activeSession.id, false);
      return;
    }

    if (activeDetailTab?.kind === "memory") {
      fetchServerInfo(activeSession.id, false);
      return;
    }

    if (activeDetailTab?.kind === "disk") {
      fetchServerInfo(activeSession.id, false);
      fetchFilesystems(activeSession.id, false);
      return;
    }

    if (activeDetailTab?.kind === "processes") {
      fetchProcessList(activeSession.id, false);
      return;
    }

    if (activeDetailTab?.kind === "network") {
      fetchNetworkConnections(activeSession.id, false);
      return;
    }
  }, [
    activeSession,
    activeDetailTab?.kind,
    fetchFilesystems,
    fetchNetworkConnections,
    fetchProcessList,
    fetchServerInfo
  ]);

  return (
    <div className="h-full flex flex-col bg-surface-50 dark:bg-surface-950 transition-colors duration-300">
      {/* 标签页栏 */}
      <div className="h-12 flex items-center bg-surface-100 dark:bg-surface-950 border-b border-surface-200 dark:border-surface-800 px-2 flex-shrink-0 transition-colors duration-300">
        <div className="flex items-center gap-1 flex-1 overflow-x-auto">
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => {
                setActiveSessionId(session.id);
                setActiveDetailTabId(null);
              }}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer group transition-all ${
                activeSessionId === session.id && !activeDetailTabId
                  ? "bg-white dark:bg-surface-800 text-surface-900 dark:text-white shadow-sm border border-surface-200 dark:border-transparent"
                  : "text-surface-600 dark:text-surface-400 hover:bg-surface-200 dark:hover:bg-surface-800 hover:text-surface-900 dark:hover:text-surface-200"
              }`}
            >
              <div className={`w-2 h-2 rounded-full ${
                session.isConnected ? "bg-green-500" : "bg-yellow-500 animate-pulse"
              }`} />
              <span className="text-sm font-medium truncate max-w-32">{session.serverName}</span>
              <button
                onClick={(e) => { e.stopPropagation(); handleCloseSession(session.id); }}
                className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-surface-300 dark:hover:bg-surface-600 transition-opacity"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}

          {detailTabs.map((tab) => {
            const detailSession = sessions.find((session) => session.id === tab.sessionId);
            if (!detailSession) return null;

            return (
              <div
                key={tab.id}
                onClick={() => {
                  setActiveSessionId(tab.sessionId);
                  setActiveDetailTabId(tab.id);
                }}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer group transition-all ${
                  activeDetailTabId === tab.id
                    ? "bg-white dark:bg-surface-800 text-surface-900 dark:text-white shadow-sm border border-surface-200 dark:border-transparent"
                    : "text-surface-600 dark:text-surface-400 hover:bg-surface-200 dark:hover:bg-surface-800 hover:text-surface-900 dark:hover:text-surface-200"
                }`}
                title={`${detailSession.serverName} ${SERVER_DETAIL_LABELS[tab.kind]}`}
              >
                <div className="w-2 h-2 rounded-sm bg-primary-500/80" />
                <span className="text-sm font-medium truncate max-w-52">
                  {detailSession.serverName} · {SERVER_DETAIL_LABELS[tab.kind]}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseDetailTab(tab.id);
                  }}
                  className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-surface-300 dark:hover:bg-surface-600 transition-opacity"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>

        {/* 新建连接按钮 */}
        <div className="relative">
          <button
            onClick={() => setShowServerSelector(!showServerSelector)}
            className="p-2 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-800 text-surface-600 dark:text-surface-400 hover:text-surface-900 dark:hover:text-white transition-colors"
          >
            <Plus className="w-4 h-4" />
          </button>

          {/* 服务器选择下拉 */}
          {showServerSelector && (
            <div className="absolute right-0 top-full mt-2 w-64 bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg shadow-xl z-20">
              <div className="p-2 border-b border-surface-200 dark:border-surface-700">
                <span className="text-xs text-surface-500 font-medium">选择服务器</span>
              </div>
              {servers.length === 0 ? (
                <div className="p-4 text-center text-surface-500">
                  <Server className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">暂无服务器</p>
                  <p className="text-xs mt-1">请先在服务器管理中添加</p>
                </div>
              ) : (
                <div className="max-h-64 overflow-y-auto">
                  {servers.map((server) => (
                    <button
                      key={server.id}
                      onClick={() => handleConnect(server.id)}
                      className="w-full px-3 py-2.5 flex items-center gap-3 hover:bg-surface-100 dark:hover:bg-surface-700 transition-colors text-left"
                    >
                      <Server className="w-4 h-4 text-primary-600 dark:text-primary-400" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-surface-900 dark:text-white truncate">{server.name}</p>
                        <p className="text-xs text-surface-500 truncate">{server.host}:{server.port}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 內容区 Flex 容器 */}
      <div 
        ref={containerRef}
        className="flex-1 flex overflow-hidden bg-surface-50 dark:bg-surface-950 relative transition-colors duration-300"
      >
        {/* 左侧：终端区域 + SFTP 浏览器 */}
        <div 
          className={`h-full min-w-0 flex ${isResizing ? 'transition-none' : 'transition-[width] duration-75'}`}
          style={{ width: `${(1 - panelRatio) * 100}%` }}
        >
          {sessions.length === 0 ? (
            <EmptyTerminal onNewConnection={() => setShowServerSelector(true)} />
          ) : (
            <>
              <ServerInfoPanel
                visible={showServerInfoPanel}
                onToggle={() => setShowServerInfoPanel((prev) => !prev)}
                session={activeSession}
                info={serverInfo}
                isLoading={isServerInfoLoading}
                error={serverInfoError}
                onRefresh={() => activeSession && fetchServerInfo(activeSession.id, false)}
                onOpenDetail={handleOpenServerDetail}
              />

              <div className="flex-1 min-w-0 flex flex-col">
                {activeDetailTab ? (
                  <ServerDetailView
                    tab={activeDetailTab}
                    session={activeSession}
                    info={serverInfo}
                    infoError={serverInfoError}
                    filesystems={filesystems}
                    filesystemError={filesystemError}
                    processList={processList}
                    processError={processError}
                    networkConnections={networkConnections}
                    networkError={networkError}
                    isLoading={
                      activeDetailTab.kind === "overview" || activeDetailTab.kind === "disk"
                        ? (isServerInfoLoading || isFilesystemLoading)
                        : activeDetailTab.kind === "memory"
                          ? isServerInfoLoading
                        : activeDetailTab.kind === "processes"
                          ? isProcessLoading
                          : isNetworkLoading
                    }
                    onRefresh={handleRefreshDetail}
                    onBackToTerminal={() => setActiveDetailTabId(null)}
                  />
                ) : (
                  <>
                    {/* 终端区域 */}
                    <div
                      className="relative font-mono min-h-0"
                      style={{ flex: showSftpPanel ? `1 1 calc(100% - ${sftpPanelHeight}px - 38px)` : '1 1 calc(100% - 32px)' }}
                    >
                      {sessions.map((session) => (
                        <div
                          key={session.id}
                          className={`h-full absolute inset-0 ${activeSessionId === session.id ? "z-10 block" : "z-0 hidden"}`}
                        >
                          <TerminalInstance
                            session={session}
                            onConnected={() => handleSessionConnected(session.id)}
                            onDisconnected={() => handleSessionDisconnected(session.id)}
                            onDirectoryChange={handleDirectoryChange}
                          />
                        </div>
                      ))}
                    </div>

                    {/* SFTP 面板切换按钮 */}
                    <div className="flex-shrink-0 h-8 flex items-center justify-between px-3 bg-surface-100 dark:bg-surface-900 border-t border-surface-200 dark:border-surface-800">
                      <button
                        onClick={() => setShowSftpPanel(!showSftpPanel)}
                        className="flex items-center gap-2 text-xs text-surface-600 dark:text-surface-400 hover:text-surface-900 dark:hover:text-white transition-colors"
                      >
                        <FolderOpen className="w-4 h-4" />
                        <span>文件浏览器</span>
                        {showSftpPanel ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
                      </button>
                      {showSftpPanel && activeSessionId && (
                        <span className="text-xs text-surface-500">使用 SFTP 浏览远程文件</span>
                      )}
                    </div>

                    {/* SFTP 文件浏览器面板 */}
                    {showSftpPanel && activeSessionId && (
                      <>
                        <HorizontalDivider
                          position={sftpPanelHeight}
                          onPositionChange={setSftpPanelHeight}
                          minHeight={150}
                          maxHeight={500}
                        />
                        <div style={{ height: sftpPanelHeight }} className="flex-shrink-0">
                          <FileExplorer
                            sessionId={activeSessionId}
                            serverId={sessions.find(s => s.id === activeSessionId)?.serverId || ''}
                            height={sftpPanelHeight}
                            syncDirectory={pendingSftpDir}
                            onSyncComplete={() => setPendingSftpDir(null)}
                            isSSHConnected={sessions.find(s => s.id === activeSessionId)?.isConnected || false}
                          />
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* 分隔条 */}
        <ResizableDivider 
          ratio={panelRatio} 
          onRatioChange={setPanelRatio} 
          containerWidth={containerWidth}
          minLeftWidth={350}
          onDragStart={() => setIsResizing(true)}
          onDragEnd={() => setIsResizing(false)} 
        />

        {/* 右侧：AI 对话面板 */}
        {/* 右侧：AI 对话面板 */}
        <div 
          className={`h-full border-l border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900 transition-colors duration-300 ${
            isResizing ? 'transition-none' : 'transition-[width] duration-300'
          }`}
          style={{ width: `${panelRatio * 100}%` }}
        >
          {activeSessionId ? (
            <AiChatPanel 
              sessionId={activeSessionId}
              onExecuteCommand={handleExecuteCommand}
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-surface-500 p-4 text-center">
              <div className="w-12 h-12 rounded-xl bg-surface-200 dark:bg-surface-800/50 flex items-center justify-center mb-4 text-primary-600 dark:text-primary-400">
                <Bot className="w-6 h-6 opacity-60" />
              </div>
              <p className="text-sm">选择或创建一个终端会话<br/>以开始使用 AI 助手</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface ServerInfoPanelProps {
  visible: boolean;
  onToggle: () => void;
  session: any | null;
  info: ServerRuntimeInfo | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  onOpenDetail: (kind: ServerDetailKind) => void;
}

function ServerInfoPanel({ visible, onToggle, session, info, isLoading, error, onRefresh, onOpenDetail }: ServerInfoPanelProps) {
  const isConnected = Boolean(session?.isConnected);
  const memoryPercent = info && info.memoryTotalKb > 0
    ? (info.memoryUsedKb / info.memoryTotalKb) * 100
    : 0;
  const diskPercent = info
    ? (info.diskUsePercent > 0
      ? info.diskUsePercent
      : (info.diskTotalKb > 0 ? (info.diskUsedKb / info.diskTotalKb) * 100 : 0))
    : 0;
  const detailCardClass = "w-full rounded-lg border border-surface-200 dark:border-surface-800 bg-white/80 dark:bg-surface-950/50 p-3 space-y-2 text-left transition-colors hover:border-primary-300 dark:hover:border-primary-700";

  if (!visible) {
    return (
      <div className="w-8 h-full border-r border-surface-200 dark:border-surface-800 bg-surface-100 dark:bg-surface-900 flex-shrink-0 flex items-start justify-center pt-3">
        <button
          onClick={onToggle}
          className="w-6 h-6 rounded-md bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 text-surface-500 dark:text-surface-300 hover:text-primary-600 dark:hover:text-primary-400 transition-colors flex items-center justify-center"
          title="展开服务器信息"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="w-72 h-full flex-shrink-0 border-r border-surface-200 dark:border-surface-800 bg-surface-100/70 dark:bg-surface-900/70 flex flex-col">
      <div className="h-10 px-3 border-b border-surface-200 dark:border-surface-800 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <Activity className="w-4 h-4 text-primary-600 dark:text-primary-400" />
          <span className="text-xs font-semibold text-surface-700 dark:text-surface-200 truncate">服务器信息</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onRefresh}
            disabled={!isConnected || isLoading}
            className="w-6 h-6 rounded-md hover:bg-surface-200 dark:hover:bg-surface-800 text-surface-500 dark:text-surface-400 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
            title="刷新"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={onToggle}
            className="w-6 h-6 rounded-md hover:bg-surface-200 dark:hover:bg-surface-800 text-surface-500 dark:text-surface-400 flex items-center justify-center"
            title="收起服务器信息"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <div className="rounded-lg border border-surface-200 dark:border-surface-800 bg-white/80 dark:bg-surface-950/50 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-surface-800 dark:text-surface-100 truncate">{session?.serverName || "未选择会话"}</p>
            <span className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-500" : "bg-yellow-500 animate-pulse"}`} />
          </div>
          <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
            {isConnected ? "已连接" : "连接中"}
          </p>
        </div>

        {!session && (
          <div className="text-xs text-surface-500 dark:text-surface-400">请选择一个会话查看服务器信息。</div>
        )}

        {session && !isConnected && (
          <div className="text-xs text-surface-500 dark:text-surface-400">连接成功后将自动展示主机运行信息。</div>
        )}

        {session && isConnected && error && !info && (
          <div className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 p-3 text-xs text-red-600 dark:text-red-300 break-words">
            获取服务器信息失败: {error}
          </div>
        )}

        {session && isConnected && info && (
          <>
            <button
              type="button"
              onClick={() => onOpenDetail("overview")}
              className={detailCardClass}
              title="查看系统信息详情"
            >
              <div className="flex items-center gap-2 text-surface-700 dark:text-surface-200">
                <Clock3 className="w-3.5 h-3.5" />
                <span className="text-xs font-medium">系统信息</span>
              </div>
              <p className="text-xs text-surface-600 dark:text-surface-300 break-words">{info.os}</p>
              <p className="text-xs text-surface-500 dark:text-surface-400 break-words">
                {info.kernelName} {info.kernelVersion} ({info.architecture})
              </p>
              <p className="text-xs text-surface-500 dark:text-surface-400 break-words">运行时间: {info.uptime}</p>
              <p className="text-xs text-surface-500 dark:text-surface-400 break-all">{info.host} / {info.ipAddress}</p>
              <p className="text-[11px] text-primary-600 dark:text-primary-400">点击打开系统信息标签（约 3 秒刷新）</p>
            </button>

            <button
              type="button"
              onClick={() => onOpenDetail("processes")}
              className={detailCardClass}
              title="查看进程详情"
            >
              <div className="flex items-center gap-2 text-surface-700 dark:text-surface-200">
                <Cpu className="w-3.5 h-3.5" />
                <span className="text-xs font-medium">进程</span>
              </div>
              <p className="text-xs text-surface-600 dark:text-surface-300 break-words">{info.cpuModel}</p>
              <p className="text-xs text-surface-500 dark:text-surface-400">核心数: {info.cpuCores || "-"}</p>
              <p className="text-xs text-surface-500 dark:text-surface-400">负载: {info.loadAvg}</p>
              <p className="text-xs text-surface-500 dark:text-surface-400">占用: {formatPercent(Math.max(0, 100 - Math.min(info.cpuIdlePercent, 100)))}</p>
              <p className="text-[11px] text-primary-600 dark:text-primary-400">点击打开进程标签（约 2 秒刷新）</p>
            </button>

            <button
              type="button"
              onClick={() => onOpenDetail("memory")}
              className={detailCardClass}
              title="查看内存详情"
            >
              <div className="flex items-center justify-between text-xs text-surface-700 dark:text-surface-200">
                <div className="flex items-center gap-2">
                  <Activity className="w-3.5 h-3.5" />
                  <span className="font-medium">内存</span>
                </div>
                <span>{formatPercent(memoryPercent)}</span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-surface-200 dark:bg-surface-800 overflow-hidden">
                <div className="h-full bg-primary-500 rounded-full" style={{ width: `${Math.min(memoryPercent, 100)}%` }} />
              </div>
              <p className="text-xs text-surface-500 dark:text-surface-400">
                {formatBytes(bytesFromKb(info.memoryUsedKb))} / {formatBytes(bytesFromKb(info.memoryTotalKb))}
              </p>
              <p className="text-xs text-surface-500 dark:text-surface-400">
                Swap: {info.swapTotalKb > 0 ? `${formatBytes(bytesFromKb(info.swapUsedKb))} / ${formatBytes(bytesFromKb(info.swapTotalKb))}` : "未启用"}
              </p>
              <p className="text-[11px] text-primary-600 dark:text-primary-400">点击打开内存标签（约 3 秒刷新）</p>
            </button>

            <button
              type="button"
              onClick={() => onOpenDetail("disk")}
              className={detailCardClass}
              title="查看磁盘详情"
            >
              <div className="flex items-center justify-between text-xs text-surface-700 dark:text-surface-200">
                <div className="flex items-center gap-2">
                  <HardDrive className="w-3.5 h-3.5" />
                  <span className="font-medium">磁盘 /</span>
                </div>
                <span>{formatPercent(diskPercent)}</span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-surface-200 dark:bg-surface-800 overflow-hidden">
                <div className="h-full bg-teal-500 rounded-full" style={{ width: `${Math.min(diskPercent, 100)}%` }} />
              </div>
              <p className="text-xs text-surface-500 dark:text-surface-400">
                {formatBytes(bytesFromKb(info.diskUsedKb))} / {formatBytes(bytesFromKb(info.diskTotalKb))}
              </p>
              <p className="text-[11px] text-primary-600 dark:text-primary-400">点击打开磁盘标签（约 3 秒刷新）</p>
            </button>

            <button
              type="button"
              onClick={() => onOpenDetail("network")}
              className={detailCardClass}
              title="查看网络详情"
            >
              <div className="flex items-center gap-2 text-surface-700 dark:text-surface-200">
                <Network className="w-3.5 h-3.5" />
                <span className="text-xs font-medium">网络</span>
              </div>
              <p className="text-xs text-surface-500 dark:text-surface-400">接收: {formatBytes(info.netRxBytes)}</p>
              <p className="text-xs text-surface-500 dark:text-surface-400">发送: {formatBytes(info.netTxBytes)}</p>
              <p className="text-[11px] text-primary-600 dark:text-primary-400">点击打开网络标签（约 2 秒刷新）</p>
            </button>

            <p className="text-[11px] text-surface-400 dark:text-surface-500">
              最后刷新: {new Date(info.collectedAt).toLocaleTimeString()}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

interface ServerDetailViewProps {
  tab: ServerDetailTab;
  session: any | null;
  info: ServerRuntimeInfo | null;
  infoError: string | null;
  filesystems: ServerFilesystemInfo[];
  filesystemError: string | null;
  processList: ServerProcessInfo[];
  processError: string | null;
  networkConnections: ServerNetworkConnection[];
  networkError: string | null;
  isLoading: boolean;
  onRefresh: () => void;
  onBackToTerminal: () => void;
}

function ServerDetailView({
  tab,
  session,
  info,
  infoError,
  filesystems,
  filesystemError,
  processList,
  processError,
  networkConnections,
  networkError,
  isLoading,
  onRefresh,
  onBackToTerminal
}: ServerDetailViewProps) {
  const isConnected = Boolean(session?.isConnected);
  const memoryPercent = info && info.memoryTotalKb > 0
    ? (info.memoryUsedKb / info.memoryTotalKb) * 100
    : 0;
  const swapPercent = info && info.swapTotalKb > 0
    ? (info.swapUsedKb / info.swapTotalKb) * 100
    : 0;
  const diskPercent = info
    ? (info.diskUsePercent > 0
      ? info.diskUsePercent
      : (info.diskTotalKb > 0 ? (info.diskUsedKb / info.diskTotalKb) * 100 : 0))
    : 0;
  const memoryAvailableBytes = info
    ? bytesFromKb(info.memoryAvailableKb > 0 ? info.memoryAvailableKb : Math.max(info.memoryTotalKb - info.memoryUsedKb, 0))
    : 0;
  const swapAvailableBytes = info
    ? Math.max(bytesFromKb(info.swapTotalKb) - bytesFromKb(info.swapUsedKb), 0)
    : 0;
  const cpuBusyPercent = info
    ? Math.max(
      0,
      Math.min(
        info.cpuUserPercent
          + info.cpuNicePercent
          + info.cpuSystemPercent
          + info.cpuIowaitPercent
          + info.cpuIrqPercent
          + info.cpuSoftirqPercent
          + info.cpuStealPercent,
        100
      )
    )
    : 0;
  const sectionClass = "rounded-xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-4";
  const valueClass = "text-sm text-surface-700 dark:text-surface-200";

  const renderRuntimeSnapshotSection = () => {
    if (!info) return null;

    return (
      <div className={sectionClass}>
        <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-3">资源快照</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <div className="rounded-lg bg-surface-100 dark:bg-surface-800/60 p-3">
            <div className="flex items-center justify-between text-xs text-surface-600 dark:text-surface-300">
              <span>CPU 占用</span>
              <span>{formatPercent(cpuBusyPercent)}</span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-surface-200 dark:bg-surface-700 overflow-hidden mt-1.5">
              <div className="h-full bg-amber-500 rounded-full" style={{ width: `${Math.min(cpuBusyPercent, 100)}%` }} />
            </div>
            <p className="mt-2 text-xs text-surface-600 dark:text-surface-300">负载: {info.loadAvg}</p>
          </div>

          <div className="rounded-lg bg-surface-100 dark:bg-surface-800/60 p-3">
            <div className="flex items-center justify-between text-xs text-surface-600 dark:text-surface-300">
              <span>内存</span>
              <span>{formatPercent(memoryPercent)}</span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-surface-200 dark:bg-surface-700 overflow-hidden mt-1.5">
              <div className="h-full bg-primary-500 rounded-full" style={{ width: `${Math.min(memoryPercent, 100)}%` }} />
            </div>
            <p className="mt-2 text-xs text-surface-600 dark:text-surface-300">
              {formatBytes(bytesFromKb(info.memoryUsedKb))} / {formatBytes(bytesFromKb(info.memoryTotalKb))}
            </p>
          </div>

          <div className="rounded-lg bg-surface-100 dark:bg-surface-800/60 p-3">
            <div className="flex items-center justify-between text-xs text-surface-600 dark:text-surface-300">
              <span>交换</span>
              <span>{info.swapTotalKb > 0 ? formatPercent(swapPercent) : "未启用"}</span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-surface-200 dark:bg-surface-700 overflow-hidden mt-1.5">
              <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${Math.min(swapPercent, 100)}%` }} />
            </div>
            <p className="mt-2 text-xs text-surface-600 dark:text-surface-300">
              {info.swapTotalKb > 0
                ? `${formatBytes(bytesFromKb(info.swapUsedKb))} / ${formatBytes(bytesFromKb(info.swapTotalKb))}`
                : "服务器未开启 Swap"}
            </p>
          </div>
        </div>

        <div className="overflow-auto mt-3">
          <table className="w-full text-xs text-left">
            <thead>
              <tr className="text-surface-500 dark:text-surface-400 border-b border-surface-200 dark:border-surface-800">
                <th className="py-2 pr-2 font-medium">用户</th>
                <th className="py-2 pr-2 font-medium">系统</th>
                <th className="py-2 pr-2 font-medium">Nice</th>
                <th className="py-2 pr-2 font-medium">空闲</th>
                <th className="py-2 pr-2 font-medium">IO 等待</th>
                <th className="py-2 pr-2 font-medium">硬中断</th>
                <th className="py-2 pr-2 font-medium">软中断</th>
                <th className="py-2 font-medium">实时</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-surface-100 dark:border-surface-800/60">
                <td className="py-2 pr-2 text-surface-700 dark:text-surface-200">{formatPercent(info.cpuUserPercent)}</td>
                <td className="py-2 pr-2 text-surface-700 dark:text-surface-200">{formatPercent(info.cpuSystemPercent)}</td>
                <td className="py-2 pr-2 text-surface-700 dark:text-surface-200">{formatPercent(info.cpuNicePercent)}</td>
                <td className="py-2 pr-2 text-surface-700 dark:text-surface-200">{formatPercent(info.cpuIdlePercent)}</td>
                <td className="py-2 pr-2 text-surface-700 dark:text-surface-200">{formatPercent(info.cpuIowaitPercent)}</td>
                <td className="py-2 pr-2 text-surface-700 dark:text-surface-200">{formatPercent(info.cpuIrqPercent)}</td>
                <td className="py-2 pr-2 text-surface-700 dark:text-surface-200">{formatPercent(info.cpuSoftirqPercent)}</td>
                <td className="py-2 text-surface-700 dark:text-surface-200">{formatPercent(info.cpuStealPercent)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3 text-xs text-surface-500 dark:text-surface-400">
          <p>可用内存: {formatBytes(memoryAvailableBytes)}</p>
          <p>可用交换: {formatBytes(swapAvailableBytes)}</p>
          <p>网络累计接收: {formatBytes(info.netRxBytes)}</p>
          <p>网络累计发送: {formatBytes(info.netTxBytes)}</p>
        </div>
      </div>
    );
  };

  const renderDetailContent = () => {
    switch (tab.kind) {
      case "overview":
        if (!info) return null;
        return (
          <>
            <div className={sectionClass}>
              <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-3">系统概览</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <p className={valueClass}>主机名: {info.host}</p>
                  <p className={valueClass}>IP: {info.ipAddress}</p>
                  <p className={valueClass}>操作系统: {info.os}</p>
                  <p className={valueClass}>内核: {info.kernelName}</p>
                  <p className={valueClass}>核心数: {info.cpuCores || "-"}</p>
                </div>
                <div className="space-y-2">
                  <p className={valueClass}>内核版本: {info.kernelVersion}</p>
                  <p className={valueClass}>架构: {info.architecture}</p>
                  <p className={valueClass}>运行时间: {info.uptime}</p>
                  <p className={valueClass}>CPU: {info.cpuModel}</p>
                  <p className={valueClass}>负载: {info.loadAvg}</p>
                </div>
              </div>
            </div>

            {renderRuntimeSnapshotSection()}

            <div className={sectionClass}>
              <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-3">文件系统</h3>
              {filesystemError && filesystems.length === 0 && (
                <div className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 p-3 text-sm text-red-600 dark:text-red-300 break-words">
                  获取文件系统失败: {filesystemError}
                </div>
              )}
              {!filesystemError && filesystems.length === 0 && (
                <div className="text-sm text-surface-500 dark:text-surface-400">暂无文件系统数据</div>
              )}
              {filesystems.length > 0 && (
                <div className="overflow-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="text-surface-500 dark:text-surface-400 border-b border-surface-200 dark:border-surface-800">
                        <th className="py-2 pr-2 font-medium">文件系统</th>
                        <th className="py-2 pr-2 font-medium">类型</th>
                        <th className="py-2 pr-2 font-medium">已用</th>
                        <th className="py-2 pr-2 font-medium whitespace-nowrap">可用</th>
                        <th className="py-2 pr-2 font-medium">使用率</th>
                        <th className="py-2 font-medium">挂载点</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filesystems.map((item) => (
                        <tr key={`${item.fileSystem}-${item.mountPoint}`} className="border-b border-surface-100 dark:border-surface-800/60">
                          <td className="py-2 pr-2 text-surface-700 dark:text-surface-200">{item.fileSystem}</td>
                          <td className="py-2 pr-2 text-surface-600 dark:text-surface-300">{item.fsType}</td>
                          <td className="py-2 pr-2 text-surface-600 dark:text-surface-300">
                            {formatBytes(bytesFromKb(item.usedKb))} / {formatBytes(bytesFromKb(item.sizeKb))}
                          </td>
                          <td className="py-2 pr-2 text-surface-600 dark:text-surface-300 whitespace-nowrap">{formatBytes(bytesFromKb(item.availKb))}</td>
                          <td className="py-2 pr-2 text-surface-600 dark:text-surface-300">{formatPercent(item.usePercent)}</td>
                          <td className="py-2 text-surface-600 dark:text-surface-300 whitespace-normal break-all">{item.mountPoint}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        );
      case "memory":
        if (!info) return null;
        return (
          <div className={sectionClass}>
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-3">内存详情</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm text-surface-700 dark:text-surface-200">
                <span>内存使用率</span>
                <span>{formatPercent(memoryPercent)}</span>
              </div>
              <div className="w-full h-2 rounded-full bg-surface-200 dark:bg-surface-800 overflow-hidden">
                <div className="h-full bg-primary-500 rounded-full" style={{ width: `${Math.min(memoryPercent, 100)}%` }} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                <div className="rounded-lg bg-surface-100 dark:bg-surface-800/60 p-3">
                  <p className="text-surface-500 dark:text-surface-400 text-xs">总内存</p>
                  <p className="mt-1 text-surface-800 dark:text-surface-100">{formatBytes(bytesFromKb(info.memoryTotalKb))}</p>
                </div>
                <div className="rounded-lg bg-surface-100 dark:bg-surface-800/60 p-3">
                  <p className="text-surface-500 dark:text-surface-400 text-xs">已使用</p>
                  <p className="mt-1 text-surface-800 dark:text-surface-100">{formatBytes(bytesFromKb(info.memoryUsedKb))}</p>
                </div>
                <div className="rounded-lg bg-surface-100 dark:bg-surface-800/60 p-3">
                  <p className="text-surface-500 dark:text-surface-400 text-xs">可用</p>
                  <p className="mt-1 text-surface-800 dark:text-surface-100">
                    {formatBytes(memoryAvailableBytes)}
                  </p>
                </div>
              </div>
              <div className="rounded-lg bg-surface-100 dark:bg-surface-800/60 p-3 text-sm">
                <div className="flex items-center justify-between text-xs text-surface-500 dark:text-surface-400">
                  <span>交换空间</span>
                  <span>{info.swapTotalKb > 0 ? formatPercent(swapPercent) : "未启用"}</span>
                </div>
                {info.swapTotalKb > 0 ? (
                  <>
                    <div className="w-full h-1.5 rounded-full bg-surface-200 dark:bg-surface-700 overflow-hidden mt-1.5">
                      <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${Math.min(swapPercent, 100)}%` }} />
                    </div>
                    <p className="mt-2 text-surface-800 dark:text-surface-100">
                      {formatBytes(bytesFromKb(info.swapUsedKb))} / {formatBytes(bytesFromKb(info.swapTotalKb))}
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-surface-600 dark:text-surface-300">服务器未开启 Swap。</p>
                )}
              </div>
              <p className="text-xs text-surface-500 dark:text-surface-400">
                采集时间: {new Date(info.collectedAt).toLocaleString()}
              </p>
            </div>
          </div>
        );
      case "disk":
        if (!info) return null;
        return (
          <>
            <div className={sectionClass}>
              <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-3">磁盘详情</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm text-surface-700 dark:text-surface-200">
                  <span>根分区使用率 (/)</span>
                  <span>{formatPercent(diskPercent)}</span>
                </div>
                <div className="w-full h-2 rounded-full bg-surface-200 dark:bg-surface-800 overflow-hidden">
                  <div className="h-full bg-teal-500 rounded-full" style={{ width: `${Math.min(diskPercent, 100)}%` }} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                  <div className="rounded-lg bg-surface-100 dark:bg-surface-800/60 p-3">
                    <p className="text-surface-500 dark:text-surface-400 text-xs">总容量</p>
                    <p className="mt-1 text-surface-800 dark:text-surface-100">{formatBytes(bytesFromKb(info.diskTotalKb))}</p>
                  </div>
                  <div className="rounded-lg bg-surface-100 dark:bg-surface-800/60 p-3">
                    <p className="text-surface-500 dark:text-surface-400 text-xs">已使用</p>
                    <p className="mt-1 text-surface-800 dark:text-surface-100">{formatBytes(bytesFromKb(info.diskUsedKb))}</p>
                  </div>
                  <div className="rounded-lg bg-surface-100 dark:bg-surface-800/60 p-3">
                    <p className="text-surface-500 dark:text-surface-400 text-xs">可用</p>
                    <p className="mt-1 text-surface-800 dark:text-surface-100">
                      {formatBytes(Math.max(bytesFromKb(info.diskTotalKb) - bytesFromKb(info.diskUsedKb), 0))}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {renderRuntimeSnapshotSection()}

            <div className={sectionClass}>
              <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-3">文件系统</h3>
              {filesystemError && filesystems.length === 0 && (
                <div className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 p-3 text-sm text-red-600 dark:text-red-300 break-words">
                  获取文件系统失败: {filesystemError}
                </div>
              )}
              {!filesystemError && filesystems.length === 0 && (
                <div className="text-sm text-surface-500 dark:text-surface-400">暂无文件系统数据</div>
              )}
              {filesystems.length > 0 && (
                <div className="overflow-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="text-surface-500 dark:text-surface-400 border-b border-surface-200 dark:border-surface-800">
                        <th className="py-2 pr-2 font-medium">文件系统</th>
                        <th className="py-2 pr-2 font-medium">类型</th>
                        <th className="py-2 pr-2 font-medium">已用</th>
                        <th className="py-2 pr-2 font-medium whitespace-nowrap">可用</th>
                        <th className="py-2 pr-2 font-medium">使用率</th>
                        <th className="py-2 font-medium">挂载点</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filesystems.map((item) => (
                        <tr key={`${item.fileSystem}-${item.mountPoint}`} className="border-b border-surface-100 dark:border-surface-800/60">
                          <td className="py-2 pr-2 text-surface-700 dark:text-surface-200">{item.fileSystem}</td>
                          <td className="py-2 pr-2 text-surface-600 dark:text-surface-300">{item.fsType}</td>
                          <td className="py-2 pr-2 text-surface-600 dark:text-surface-300">
                            {formatBytes(bytesFromKb(item.usedKb))} / {formatBytes(bytesFromKb(item.sizeKb))}
                          </td>
                          <td className="py-2 pr-2 text-surface-600 dark:text-surface-300 whitespace-nowrap">{formatBytes(bytesFromKb(item.availKb))}</td>
                          <td className="py-2 pr-2 text-surface-600 dark:text-surface-300">{formatPercent(item.usePercent)}</td>
                          <td className="py-2 text-surface-600 dark:text-surface-300 whitespace-normal break-all">{item.mountPoint}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        );
      case "processes":
        return (
          <div className={sectionClass}>
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-3">进程列表</h3>
            {processError && processList.length === 0 && (
              <div className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 p-3 text-sm text-red-600 dark:text-red-300 break-words mb-3">
                获取进程信息失败: {processError}
              </div>
            )}
            {processList.length === 0 ? (
              <div className="text-sm text-surface-500 dark:text-surface-400">暂无进程数据</div>
            ) : (
              <div className="overflow-auto">
                <table className="w-full text-xs text-left">
                  <thead>
                    <tr className="text-surface-500 dark:text-surface-400 border-b border-surface-200 dark:border-surface-800">
                      <th className="py-2 pr-2 font-medium">PID</th>
                      <th className="py-2 pr-2 font-medium">用户</th>
                      <th className="py-2 pr-2 font-medium">内存</th>
                      <th className="py-2 pr-2 font-medium">CPU%</th>
                      <th className="py-2 pr-2 font-medium">名称</th>
                      <th className="py-2 font-medium">命令</th>
                    </tr>
                  </thead>
                  <tbody>
                    {processList.map((item) => (
                      <tr key={`${item.pid}-${item.name}-${item.cpuPercent}`} className="border-b border-surface-100 dark:border-surface-800/60">
                        <td className="py-2 pr-2 text-surface-700 dark:text-surface-200">{item.pid}</td>
                        <td className="py-2 pr-2 text-surface-600 dark:text-surface-300">{item.user || "-"}</td>
                        <td className="py-2 pr-2 text-surface-600 dark:text-surface-300">{formatBytes(bytesFromKb(item.memoryKb))}</td>
                        <td className="py-2 pr-2 text-surface-600 dark:text-surface-300">{item.cpuPercent.toFixed(1)}</td>
                        <td className="py-2 pr-2 text-surface-700 dark:text-surface-200">{item.name || "-"}</td>
                        <td className="py-2 text-surface-600 dark:text-surface-300 break-all">{item.command || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      case "network":
        return (
          <div className={sectionClass}>
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-3">网络连接</h3>
            {networkError && networkConnections.length === 0 && (
              <div className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 p-3 text-sm text-red-600 dark:text-red-300 break-words mb-3">
                获取网络连接失败: {networkError}
              </div>
            )}
            {networkConnections.length === 0 ? (
              <div className="text-sm text-surface-500 dark:text-surface-400">暂无网络连接数据</div>
            ) : (
              <div className="overflow-auto">
                <table className="w-full text-xs text-left">
                  <thead>
                    <tr className="text-surface-500 dark:text-surface-400 border-b border-surface-200 dark:border-surface-800">
                      <th className="py-2 pr-2 font-medium">协议</th>
                      <th className="py-2 pr-2 font-medium">状态</th>
                      <th className="py-2 pr-2 font-medium">本地地址</th>
                      <th className="py-2 pr-2 font-medium">远端地址</th>
                      <th className="py-2 pr-2 font-medium">接收队列</th>
                      <th className="py-2 pr-2 font-medium">发送队列</th>
                      <th className="py-2 font-medium">进程</th>
                    </tr>
                  </thead>
                  <tbody>
                    {networkConnections.map((item, index) => (
                      <tr key={`${item.protocol}-${item.localAddress}-${item.peerAddress}-${index}`} className="border-b border-surface-100 dark:border-surface-800/60">
                        <td className="py-2 pr-2 text-surface-700 dark:text-surface-200">{item.protocol}</td>
                        <td className="py-2 pr-2 text-surface-600 dark:text-surface-300">{item.state}</td>
                        <td className="py-2 pr-2 text-surface-600 dark:text-surface-300">{item.localAddress}</td>
                        <td className="py-2 pr-2 text-surface-600 dark:text-surface-300">{item.peerAddress}</td>
                        <td className="py-2 pr-2 text-surface-600 dark:text-surface-300">{item.recvQ}</td>
                        <td className="py-2 pr-2 text-surface-600 dark:text-surface-300">{item.sendQ}</td>
                        <td className="py-2 text-surface-600 dark:text-surface-300 break-all">{item.process || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-surface-50 dark:bg-surface-950">
      <div className="sticky top-0 z-10 h-12 px-4 border-b border-surface-200 dark:border-surface-800 bg-surface-50/95 dark:bg-surface-950/95 backdrop-blur-sm flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-surface-900 dark:text-surface-100 truncate">
            {session?.serverName || "未选择会话"} · {SERVER_DETAIL_LABELS[tab.kind]}
          </p>
          <p className="text-xs text-surface-500 dark:text-surface-400">
            {tab.kind === "overview" ? "系统信息约 3 秒刷新" : tab.kind === "memory" ? "内存约 3 秒刷新" : tab.kind === "disk" ? "磁盘约 3 秒刷新（文件系统约 8 秒刷新）" : "高频实时视图约 2 秒刷新"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            disabled={!isConnected || isLoading}
            className="px-2.5 h-7 rounded-md border border-surface-200 dark:border-surface-700 text-xs text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isLoading ? "刷新中..." : "刷新"}
          </button>
          <button
            onClick={onBackToTerminal}
            className="px-2.5 h-7 rounded-md border border-surface-200 dark:border-surface-700 text-xs text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800"
          >
            返回终端
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {!session && (
          <div className="text-sm text-surface-500 dark:text-surface-400">请选择一个会话查看详情。</div>
        )}

        {session && !isConnected && (
          <div className="text-sm text-surface-500 dark:text-surface-400">会话连接成功后将自动加载详细信息。</div>
        )}

        {session && isConnected && (tab.kind === "overview" || tab.kind === "memory" || tab.kind === "disk") && !info && !infoError && (
          <div className="text-sm text-surface-500 dark:text-surface-400">正在加载详情...</div>
        )}

        {session && isConnected && (tab.kind === "overview" || tab.kind === "memory" || tab.kind === "disk") && infoError && !info && (
          <div className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20 p-3 text-sm text-red-600 dark:text-red-300 break-words">
            获取服务器信息失败: {infoError}
          </div>
        )}

        {session && isConnected && (
          <>
            {(tab.kind === "processes" || tab.kind === "network") && isLoading && (
              <div className="text-sm text-surface-500 dark:text-surface-400">正在刷新列表...</div>
            )}
            {renderDetailContent()}
          </>
        )}
      </div>
    </div>
  );
}

function EmptyTerminal({ onNewConnection }: { onNewConnection: () => void }) {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center text-center text-surface-400 dark:text-surface-500">
      <div className="w-20 h-20 rounded-2xl bg-surface-200 dark:bg-surface-800/50 flex items-center justify-center mb-6 text-primary-600 dark:text-primary-400">
        <TerminalIcon className="w-10 h-10 opacity-60" />
      </div>
      <h3 className="text-lg font-medium text-surface-700 dark:text-surface-300 mb-2">开始新的终端会话</h3>
      <p className="text-sm mb-6 text-surface-500">连接到您的服务器开始工作</p>
      <button onClick={onNewConnection} className="btn-primary flex items-center gap-2">
        <Plus className="w-4 h-4" />
        新建连接
      </button>
    </div>
  );
}

interface TerminalInstanceProps {
  session: any; // 这里的 session 实际上只包含 id, serverId, serverName 等基本字段
  onConnected: () => void;
  onDisconnected: () => void;
  onDirectoryChange?: (directory: string) => void;
}

// 使用 memo 避免不必要的重渲染
const TerminalInstance = memo(function TerminalInstance({ session, onConnected, onDisconnected, onDirectoryChange }: TerminalInstanceProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  // 防止重复连接的标志
  const connectionInitiatedRef = useRef<boolean>(false);
  // 跟踪 SSH 连接状态，用于控制 ResizeObserver 是否发送 resize 命令
  const sshConnectedRef = useRef<boolean>(session.isConnected || false);
  const [_connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting');
  const [_errorMessage, setErrorMessage] = useState<string | null>(null);
  
  // 获取主题
  const { theme } = useThemeStore();

  // 获取终端输出存储函数
  const appendOutput = useTerminalOutputStore((state) => state.appendOutput);
  // 获取会话持久化存储函数
  const appendSessionOutput = useTerminalStore((state) => state.appendSessionOutput);
  // 获取目录检测函数
  const parseAndUpdateFromOutput = useTerminalDirectoryStore((state) => state.parseAndUpdateFromOutput);

  // 监听主题变化更新终端主题
  useEffect(() => {
    if (terminalInstanceRef.current && terminalRef.current) {
      const term = terminalInstanceRef.current;
      const container = terminalRef.current;
      console.log('[TerminalView] Applying theme:', theme);
      applyTerminalTheme(term, container, theme);
    }
  }, [theme]);

  // 存储同步引用 - 用于将数据懒加载同步到 Zustand store
  const outputStoreBufferRef = useRef<string>('');
  const terminalStoreBufferRef = useRef<string>('');

  // 同步数据到 Store 的函数
  const syncToStore = useCallback(() => {
    if (!outputStoreBufferRef.current && !terminalStoreBufferRef.current) return;
    
    const outputDataToSync = outputStoreBufferRef.current;
    const terminalDataToSync = terminalStoreBufferRef.current;
    outputStoreBufferRef.current = '';
    terminalStoreBufferRef.current = '';
    
    // 批量更新 Store
    if (outputDataToSync) {
      appendOutput(session.id, outputDataToSync);
    }
    if (terminalDataToSync) {
      appendSessionOutput(session.id, terminalDataToSync);
    }
  }, [session.id, appendOutput, appendSessionOutput]);

  // 定时同步 Store (每 2 秒)
  useEffect(() => {
    const syncInterval = setInterval(() => {
      if (outputStoreBufferRef.current || terminalStoreBufferRef.current) {
        syncToStore();
      }
    }, 2000);
    
    return () => {
      clearInterval(syncInterval);
      // 组件卸载或会话改变时，强制同步剩余数据
      syncToStore();
    };
  }, [syncToStore]);

  useEffect(() => {
    let unlistenOutput: UnlistenFn | null = null;
    let unlistenDisconnect: UnlistenFn | null = null;
    let terminal: any = null;
    let fitAddon: any = null;
    let resizeObserver: ResizeObserver | null = null;

    const initTerminal = async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");
      
      await import("@xterm/xterm/css/xterm.css");

      if (!terminalRef.current) return;
      const currentTheme = useThemeStore.getState().theme;

      terminal = new Terminal({
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
        fontSize: 14,
        lineHeight: 1.4,
        cursorBlink: true,
        cursorStyle: "bar",
        scrollback: 10000,
        theme: getTerminalTheme(currentTheme),
        minimumContrastRatio: currentTheme === 'light' ? 4.5 : 1,
        allowTransparency: false, // 关闭透明，让 xterm.js 完全控制背景色
      });

      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new WebLinksAddon());

      terminal.open(terminalRef.current);
      
      // 临时禁用 WebGL 渲染器进行调试
      // WebGL 可能导致高频数据渲染后上下文卡死
      /*
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          console.warn('[Terminal] WebGL 上下文丢失，回退到 Canvas 渲染');
          webglAddon.dispose();
        });
        terminal.loadAddon(webglAddon);
        console.log('[Terminal] WebGL 渲染器加载成功');
      } catch (e) {
        console.warn('[Terminal] WebGL 不可用，使用默认渲染器:', e);
      }
      */
      console.log('[Terminal] 使用默认 Canvas 渲染器');
      
      fitAddon.fit();

      terminalInstanceRef.current = terminal;
      fitAddonRef.current = fitAddon;

      applyTerminalTheme(terminal, terminalRef.current, currentTheme);

      // 每次重新挂载终端实例都要恢复缓存输出，否则切页返回后会出现空白终端。
      // 从 store 获取完整的 session 数据（包含 buffer）
      const currentSessionState = useTerminalStore.getState().sessions.find(s => s.id === session.id);
      
      if (currentSessionState && currentSessionState.buffer) {
        terminal.write(currentSessionState.buffer);
      }

      // 使用 ResizeObserver 监听容器大小变化
      resizeObserver = new ResizeObserver(() => {
        if (fitAddon) {
          try {
            fitAddon.fit();
            // 只有在 SSH 已连接时才通知后端终端大小变化
            // 避免在连接建立前发送 resize 命令导致 "会话不存在" 错误
            if (sshConnectedRef.current) {
              const dims = fitAddon.proposeDimensions();
              if (dims) {
                invoke("resize_ssh", {
                  sessionId: session.id,
                  cols: dims.cols,
                  rows: dims.rows,
                }).catch(console.error);
              }
            }
          } catch (e) {
            console.error("Resize error:", e);
          }
        }
      });
      
      if (terminalRef.current) {
        resizeObserver.observe(terminalRef.current);
      }

      // 监听来自后端的 SSH 输出
      unlistenOutput = await listen<string>(`ssh-output-${session.id}`, (event) => {
        if (terminal) {
          const data = event.payload;
          const displayData = stripInternalCommandControlLines(data);
          
          // 1. 写入终端
          if (displayData) {
            terminal.write(displayData);
          }
          
          // 2. 累积到 Store 缓冲区（延迟同步）
          outputStoreBufferRef.current += data;
          terminalStoreBufferRef.current += displayData;
          
          // 3. 检测目录变化（如 cd 命令）
          const detectedDir = parseAndUpdateFromOutput(session.id, displayData);
          if (detectedDir && onDirectoryChange) {
            onDirectoryChange(detectedDir);
          }
        }
      });


      // 监听断开连接事件
      unlistenDisconnect = await listen<string>(`ssh-disconnected-${session.id}`, (event) => {
        setConnectionStatus('disconnected');
        onDisconnected();
        if (terminal) {
          terminal.writeln("");
          terminal.writeln(`\x1b[31m✗\x1b[0m 连接已断开: ${event.payload}`);
        }
      });

      // 处理用户输入 - 发送到后端
      terminal.onData((data: string) => {
        invoke("write_ssh", {
          sessionId: session.id,
          data: data,
        }).catch((err) => {
          console.error("发送数据失败:", err);
        });
      });

      // 如果已经连接过，就不需要再次连接了
      if (session.isConnected) {
        console.log('[Terminal] 会话已存在连接, 恢复显示');
        setConnectionStatus('connected');
        
        // 恢复后发送一次 resize 确保尺寸正确
        setTimeout(() => {
            const dims = fitAddon.proposeDimensions();
            if (dims) {
              invoke("resize_ssh", {
                sessionId: session.id,
                cols: dims.cols,
                rows: dims.rows,
              }).catch(console.error);
            }
        }, 100);
        
        return;
      }

      // 防止重复连接：如果已经发起过连接请求，直接返回
      if (connectionInitiatedRef.current) {
        console.log('[Terminal] 连接已在进行中, 跳过重复连接');
        return;
      }
      connectionInitiatedRef.current = true;

      // 显示连接中信息
      terminal.writeln(`\x1b[33m⏳\x1b[0m 正在连接 \x1b[1m${session.serverName}\x1b[0m ...`);

      // 发起 SSH 连接
      console.log('[Terminal] 开始调用 connect_ssh, sessionId=', session.id, 'serverId=', session.serverId);
      try {
        const result = await invoke("connect_ssh", {
          sessionId: session.id,
          serverId: session.serverId,
        });
        console.log('[Terminal] connect_ssh 返回成功:', result);
        
        // 标记 SSH 已连接，允许 ResizeObserver 发送 resize 命令
        sshConnectedRef.current = true;
        setConnectionStatus('connected');
        onConnected();
        console.log('[Terminal] 连接状态已更新为 connected');
        
        // 发送初始终端大小
        const dims = fitAddon.proposeDimensions();
        if (dims) {
          console.log('[Terminal] 发送终端大小:', dims);
          await invoke("resize_ssh", {
            sessionId: session.id,
            cols: dims.cols,
            rows: dims.rows,
          });
        }
      } catch (err: any) {
        console.error('[Terminal] connect_ssh 调用失败:', err);
        setConnectionStatus('error');
        setErrorMessage(err.toString());
        terminal.writeln("");
        terminal.writeln(`\x1b[31m✗\x1b[0m 连接失败: ${err}`);
        terminal.writeln("");
        terminal.writeln("\x1b[90m请检查服务器配置和网络连接\x1b[0m");
      }

      return;
    };

    initTerminal();

    // 清理函数
    return () => {
      if (unlistenOutput) {
        unlistenOutput();
      }
      if (unlistenDisconnect) {
        unlistenDisconnect();
      }
      if (terminalInstanceRef.current) {
        terminalInstanceRef.current.dispose();
        terminalInstanceRef.current = null;
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
    };
  }, [session.id, session.serverId, session.serverName]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={terminalRef} className="terminal-container h-full" />
  );
});
