import { useEffect, useRef, useState, useCallback, memo } from "react";
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { Terminal as TerminalIcon, Plus, X, Server, Bot, FolderOpen, ChevronDown, ChevronUp } from "lucide-react";
import { useServerStore } from "@/stores/serverStore";
import { useChatStore } from "@/stores/chatStore";
import { useTerminalOutputStore } from "@/stores/terminalOutputStore";
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

  const handleExecuteCommand = (command: string) => {
    if (!activeSessionId) return;
    
    // 调用后端执行命令
    invoke("write_ssh", {
      sessionId: activeSessionId,
      data: command + "\n", // 自动添加换行符执行
    }).catch(console.error);
  };

  return (
    <div className="h-full flex flex-col bg-surface-50 dark:bg-surface-950 transition-colors duration-300">
      {/* 标签页栏 */}
      <div className="h-12 flex items-center bg-surface-100 dark:bg-surface-950 border-b border-surface-200 dark:border-surface-800 px-2 flex-shrink-0 transition-colors duration-300">
        <div className="flex items-center gap-1 flex-1 overflow-x-auto">
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => setActiveSessionId(session.id)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer group transition-all ${
                activeSessionId === session.id
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
          className={`h-full min-w-0 flex flex-col ${isResizing ? 'transition-none' : 'transition-[width] duration-75'}`}
          style={{ width: `${(1 - panelRatio) * 100}%` }}
        >
          {sessions.length === 0 ? (
            <EmptyTerminal onNewConnection={() => setShowServerSelector(true)} />
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
            <div className="h-full flex flex-col items-center justify-center text-surface-500 p-4 text-center">
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

function EmptyTerminal({ onNewConnection }: { onNewConnection: () => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-surface-400 dark:text-surface-500">
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
  const storeBufferRef = useRef<string>('');
  const lastSyncTimeRef = useRef<number>(Date.now());

  // 同步数据到 Store 的函数
  const syncToStore = useCallback(() => {
    if (!storeBufferRef.current) return;
    
    const dataToSync = storeBufferRef.current;
    storeBufferRef.current = '';
    lastSyncTimeRef.current = Date.now();
    
    // 批量更新 Store
    appendOutput(session.id, dataToSync);
    appendSessionOutput(session.id, dataToSync);
  }, [session.id, appendOutput, appendSessionOutput]);

  // 定时同步 Store (每 2 秒)
  useEffect(() => {
    const syncInterval = setInterval(() => {
      if (storeBufferRef.current) {
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
          
          // 1. 写入终端
          terminal.write(data);
          
          // 2. 累积到 Store 缓冲区（延迟同步）
          storeBufferRef.current += data;
          
          // 3. 检测目录变化（如 cd 命令）
          const detectedDir = parseAndUpdateFromOutput(session.id, data);
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
