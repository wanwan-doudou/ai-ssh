/**
 * SFTP 文件浏览器组件
 * 
 * 显示远程服务器的文件系统，支持浏览、上传、下载等操作
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useSftpStore, FileEntry, formatFileSize, formatDateTime, getFileIcon } from '../../stores/sftpStore';
import { useTransferStore } from '../../stores/transferStore';
import { useThemeStore } from '../../stores/themeStore';
import { save } from '@tauri-apps/plugin-dialog';
// import { tempDir, join } from '@tauri-apps/api/path';
// import { writeFile, remove as removeTempFile } from '@tauri-apps/plugin-fs';
import { listen, UnlistenFn } from '@tauri-apps/api/event'; // 用于进度监听
import './FileExplorer.css';
import { FileTree } from './FileTree';
import { 
  ArrowUp, RefreshCw, FolderPlus, FilePlus, Folder, FileText, 
  Download, Pencil, Trash2, XCircle, Inbox, Shield 
} from 'lucide-react';
import { ChmodModal } from './ChmodModal';

interface FileExplorerProps {
  /** 会话 ID */
  sessionId: string;
  /** 服务器 ID */
  serverId: string;
  /** 高度 */
  height?: number;
  /** 待同步的目录（来自终端 cd 命令） */
  syncDirectory?: string | null;
  /** 同步完成回调 */
  onSyncComplete?: () => void;
  /** SSH 是否已连接 - 只有 SSH 连接成功后才能建立 SFTP */
  isSSHConnected?: boolean;
}

/**
 * 文件浏览器组件
 */
export const FileExplorer: React.FC<FileExplorerProps> = ({
  sessionId,
  serverId,
  height = 300,
  syncDirectory,
  onSyncComplete,
  isSSHConnected = false,
}) => {
  const { theme } = useThemeStore();
  const { addTask, updateProgress, setTaskStatus, setTaskSpeed, setTaskToken } = useTransferStore();
  const {
    sessions,
    connect,
    // disconnect, // 暂未使用
    refreshFiles,
    changeDir,
    mkdir,
    createFile,
    remove,
    rename,
    chmod,
    downloadToFile,
    uploadFromFile, // 高性能上传（Tauri 原生拖放事件）
    // getSession, // 暂未使用
    clearError,
  } = useSftpStore();

  const session = sessions[sessionId];
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file?: FileEntry } | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [treeWidth, setTreeWidth] = useState(250);
  const [pathInput, setPathInput] = useState('');
  const [chmodTarget, setChmodTarget] = useState<FileEntry | null>(null);
  
  // 移除内部编辑器状态
  // const [editingFile, setEditingFile] = useState<{ path: string; content: string } | null>(null);
  // const [isSaving, setIsSaving] = useState(false);
  // const [isLoadingFile, setIsLoadingFile] = useState(false);

  // 同步当前目录到输入框
  useEffect(() => {
    if (session?.currentDir) {
      setPathInput(session.currentDir);
    }
  }, [session?.currentDir]);

  // 处理路径输入框回车
  const handlePathInputKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const targetPath = pathInput.trim();
      if (!targetPath) return;
      
      try {
        await changeDir(sessionId, targetPath);
      } catch (error) {
        console.error('跳转路径失败:', error);
        // 如果失败，恢复原来的路径
        setPathInput(session.currentDir);
      }
    }
  };

  // 自动连接 - 必须等待 SSH 连接成功后才能建立 SFTP
  useEffect(() => {
    // 只有当 SSH 已连接、SFTP 会话不存在时才尝试连接
    if (isSSHConnected && !session && serverId) {
      console.log('[FileExplorer] SSH 已连接，开始建立 SFTP 连接');
      connect(sessionId, serverId).catch(console.error);
    }

    return () => {
      // 组件卸载时不自动断开，保持连接
    };
  }, [sessionId, serverId, isSSHConnected, session, connect]);

  // 监听终端目录变化，自动同步 SFTP 目录
  useEffect(() => {
    if (syncDirectory && session?.connected) {
      console.log('[FileExplorer] 同步终端目录:', syncDirectory);
      
      // 处理波浪号路径
      // 如果 syncDirectory 是 ~ 且 SFTP 当前目录已经是用户主目录，跳过同步
      // 因为 SFTP connect 时已经自动定位到 home 目录了
      if (syncDirectory === '~' && session.currentDir && session.currentDir !== '/') {
        console.log('[FileExplorer] 目录已是 home，跳过同步');
        onSyncComplete?.();
        return;
      }
      
      // 将 ~ 替换为 . (当前目录)，避免后端解析问题
      const targetDir = syncDirectory === '~' ? '.' : syncDirectory;
      
      // 调用 changeDir 切换目录
      changeDir(sessionId, targetDir)
        .then(() => {
          console.log('[FileExplorer] 目录同步成功:', targetDir);
          onSyncComplete?.();
        })
        .catch((err) => {
          console.error('[FileExplorer] 目录同步失败:', err);
          onSyncComplete?.();
        });
    }
  }, [syncDirectory, session?.connected, session?.currentDir, sessionId, changeDir, onSyncComplete]);

  // 监听 Tauri 原生文件拖放事件 - 高性能上传（后端直接读取本地文件）
  useEffect(() => {
    let unlistenDrop: UnlistenFn | undefined;

    async function setupTauriDropListener() {
      // 监听 Tauri 原生拖放事件 - 直接获取文件路径
      unlistenDrop = await listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
        console.log('[FileExplorer] Tauri drag-drop event:', event.payload);
        
        if (!session?.connected || !session?.currentDir) {
          console.log('[FileExplorer] SFTP 未连接，忽略拖放');
          return;
        }
        
        const filePaths = event.payload.paths;
        if (!filePaths || filePaths.length === 0) return;
        
        console.log('[FileExplorer] 高性能上传, 文件数:', filePaths.length);
        
        // 逐个上传文件
        for (const localPath of filePaths) {
          const fileName = localPath.split(/[\\/]/).pop() || 'unknown';
          const remotePath = `${session.currentDir}/${fileName}`;
          
          // 获取文件大小
          let fileSize = 0;
          try {
            const { stat } = await import('@tauri-apps/plugin-fs');
            fileSize = (await stat(localPath)).size;
          } catch (e) {
            console.warn('[FileExplorer] 无法获取文件大小:', e);
          }
          
          // 创建传输任务
          const taskId = addTask({
            type: 'upload',
            fileName,
            remotePath,
            localPath,
            size: fileSize,
          });
          
          // 保存 sessionId 以便取消时使用（高性能上传使用 taskId 作为取消标识）
          setTaskToken(taskId, taskId, sessionId);
          
          let unlisten: UnlistenFn | null = null;
          
          try {
            // 监听进度事件
            unlisten = await listen<{ taskId: string; transferred: number; total: number; speed: number }>(
              `sftp-progress-${taskId}`,
              (progressEvent) => {
                updateProgress(taskId, progressEvent.payload.transferred);
                setTaskSpeed(taskId, progressEvent.payload.speed);
              }
            );
            
            setTaskStatus(taskId, 'running');
            
            // 调用高性能上传（后端直接读取本地文件）
            await uploadFromFile(sessionId, localPath, remotePath, taskId);
            
            setTaskStatus(taskId, 'success');
            console.log('[FileExplorer] 上传成功:', fileName);
          } catch (error: any) {
            console.error('[FileExplorer] 上传失败:', fileName, error);
            const errorMsg = typeof error === 'string' ? error : (error.message || JSON.stringify(error));
            setTaskStatus(taskId, 'error', `上传失败: ${errorMsg}`);
          } finally {
            if (unlisten) unlisten();
          }
        }
        
        setIsDragOver(false);
        refreshFiles(sessionId);
      });
    }

    setupTauriDropListener();
    return () => { unlistenDrop?.(); };
  }, [sessionId, session?.connected, session?.currentDir, addTask, updateProgress, setTaskStatus, setTaskSpeed, uploadFromFile, refreshFiles]);


  // 处理双击
  const handleDoubleClick = useCallback(async (file: FileEntry) => {
    if (file.is_dir) {
      changeDir(sessionId, file.path);
    } else {
      // 打开新窗口进行编辑
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      
      const fileName = file.name;
      const windowLabel = `editor-${sessionId}-${Date.now()}`;
      
      // 构建 URL
      const url = `index.html?mode=editor&sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(file.path)}`;
      
      const editorWindow = new WebviewWindow(windowLabel, {
        url,
        title: `${fileName} - 编辑器`,
        width: 800,
        height: 600,
        center: true,
      });
      
      // 监听窗口创建事件
      editorWindow.once('tauri://created', () => {
        console.log('编辑器窗口创建成功:', windowLabel);
      });
      
      // 监听窗口创建错误
      editorWindow.once('tauri://error', (e) => {
        console.error('编辑器窗口创建失败:', windowLabel, e);
        alert(`无法打开编辑器窗口: ${e.payload || '未知错误'}`);
      });
      
      console.log('打开编辑器窗口:', windowLabel, url);
    }
  }, [sessionId, changeDir]);

  // 移除旧的保存和关闭方法


  // 返回上一级目录
  const handleGoUp = useCallback(() => {
    if (!session) return;
    const parentPath = session.currentDir.split('/').slice(0, -1).join('/') || '/';
    changeDir(sessionId, parentPath);
  }, [sessionId, session, changeDir]);

  // 刷新当前目录
  const handleRefresh = useCallback(() => {
    refreshFiles(sessionId);
  }, [sessionId, refreshFiles]);

  // 右键菜单
  const handleContextMenu = useCallback((e: React.MouseEvent, file?: FileEntry) => {
    e.preventDefault();
    console.log('[FileExplorer] 右键菜单触发, file:', file?.name, 'position:', { x: e.clientX, y: e.clientY });
    setContextMenu({ x: e.clientX, y: e.clientY, file });
  }, []);

  // 关闭右键菜单
  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // 删除文件
  const handleDelete = useCallback(async () => {
    if (!contextMenu?.file) return;
    const file = contextMenu.file;
    closeContextMenu();

    if (confirm(`确定要删除 "${file.name}" 吗？`)) {
      try {
        await remove(sessionId, file.path, file.is_dir);
      } catch (error) {
        alert(`删除失败: ${error}`);
      }
    }
  }, [sessionId, contextMenu, remove, closeContextMenu]);

  // 开始重命名
  const handleStartRename = useCallback(() => {
    if (!contextMenu?.file) return;
    setRenameTarget(contextMenu.file.path);
    setNewName(contextMenu.file.name);
    closeContextMenu();
  }, [contextMenu, closeContextMenu]);

  // 确认重命名
  const handleConfirmRename = useCallback(async () => {
    if (!renameTarget || !newName) return;

    const parentPath = renameTarget.split('/').slice(0, -1).join('/');
    const newPath = parentPath ? `${parentPath}/${newName}` : `/${newName}`;

    try {
      await rename(sessionId, renameTarget, newPath);
    } catch (error) {
      alert(`重命名失败: ${error}`);
    }

    setRenameTarget(null);
    setNewName('');
  }, [sessionId, renameTarget, newName, rename]);

  // 创建新文件夹
  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName || !session) return;

    const newPath = `${session.currentDir}/${newFolderName}`;
    try {
      await mkdir(sessionId, newPath);
      setShowNewFolder(false);
      setNewFolderName('');
    } catch (error) {
      alert(`创建文件夹失败: ${error}`);
    }
  }, [sessionId, session, newFolderName, mkdir]);
  
  // 创建新文件
  const handleCreateFile = useCallback(async () => {
    if (!newFileName || !session) return;

    const newPath = `${session.currentDir}/${newFileName}`;
    try {
      await createFile(sessionId, newPath);
      setShowNewFile(false);
      setNewFileName('');
    } catch (error) {
      alert(`创建文件失败: ${error}`);
    }
  }, [sessionId, session, newFileName, createFile]);

  // 下载文件（使用保存对话框和传输进度）
  
  const handleDownload = useCallback(async () => {
    console.log('[FileExplorer] handleDownload 触发, contextMenu:', contextMenu);
    if (!contextMenu?.file || contextMenu.file.is_dir) {
      console.log('[FileExplorer] 下载跳过: 无文件或是目录');
      return;
    }
    const file = contextMenu.file;
    closeContextMenu();

    // 弹出保存对话框
    const savePath = await save({
      defaultPath: file.name,
      title: '保存文件',
    });
    
    if (!savePath) {
      console.log('[FileExplorer] 用户取消保存');
      return;
    }

    // 创建传输任务
    const taskId = addTask({
      type: 'download',
      fileName: file.name,
      remotePath: file.path,
      localPath: savePath,
      size: file.size,
    });

    // 监听后端进度事件
    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<{ taskId: string; transferred: number; total: number; speed: number }>(
        `sftp-progress-${taskId}`,
        (event) => {
          updateProgress(taskId, event.payload.transferred);
          setTaskSpeed(taskId, event.payload.speed);
        }
      );

      console.log('[FileExplorer] 开始下载文件:', file.path, '->', savePath);
      setTaskStatus(taskId, 'running');
      
      // 调用后端直接下载到本地文件（高性能）
      await downloadToFile(sessionId, file.path, savePath, taskId);
      
      setTaskStatus(taskId, 'success');
      console.log('[FileExplorer] 文件下载成功:', savePath);
    } catch (error) {
      console.error('[FileExplorer] 下载失败:', error);
      setTaskStatus(taskId, 'error', String(error));
    } finally {
      if (unlisten) unlisten();
    }
  }, [sessionId, contextMenu, downloadToFile, closeContextMenu, addTask, updateProgress, setTaskStatus, setTaskSpeed]);

  // 处理拖拽进入 (HTML5)
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('[FileExplorer] HTML5 Drag Enter');
    setIsDragOver(true);
  }, []);

  // 处理拖拽悬停 (HTML5)
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragOver) {
      setIsDragOver(true);
    }
  }, [isDragOver]);

  // 处理拖拽离开 (HTML5)
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 如果是进入了子元素，不取消状态
    if (e.currentTarget.contains(e.relatedTarget as Node)) {
      return;
    }
    
    console.log('[FileExplorer] HTML5 Drag Leave');
    setIsDragOver(false);
  }, []);

  // 处理 HTML5 文件拖放 - 已废弃旧版分块上传，仅阻止默认行为以兼容拖拽交互
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    console.log('[FileExplorer] HTML5 Drop ignored (Legacy). use native drag and drop instead.');
  }, []);

  // 选择文件
  const handleSelect = useCallback((file: FileEntry, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // 多选
      setSelectedFiles((prev) => {
        const next = new Set(prev);
        if (next.has(file.path)) {
          next.delete(file.path);
        } else {
          next.add(file.path);
        }
        return next;
      });
    } else {
      // 单选
      setSelectedFiles(new Set([file.path]));
    }
  }, []);

  // 渲染文件图标
  const renderIcon = (file: FileEntry) => {
    const iconName = getFileIcon(file.name, file.is_dir);
    return (
      <span className={`file-icon icon-${iconName}`}>
        {file.is_dir 
          ? <Folder className="w-4 h-4 text-amber-500" /> 
          : <FileText className="w-4 h-4 text-surface-500" />}
      </span>
    );
  };

  // 加载中状态
  if (!session) {
    return (
      <div className={`file-explorer ${theme}`} style={{ height }}>
        <div className="file-explorer-loading">
          <span className="spinner"></span>
          <span>正在连接 SFTP...</span>
        </div>
      </div>
    );
  }

  // 移除加载遮罩


  // 错误状态不再阻塞整个视图
  // if (session.error) { ... }

  // 格式化错误信息，使其更友好
  const getFriendlyErrorMessage = (error: string) => {
    if (!error) return '';
    if (error.includes('NoSuchFile') || error.includes('No such file')) {
      return '该路径不存在，请检查后重试';
    }
    if (error.includes('PermissionDenied') || error.includes('Permission denied')) {
      return '没有权限访问该路径';
    }
    if (error.includes('ConnectionLost') || error.includes('broken pipe')) {
      return '连接已断开，请尝试刷新或重新连接';
    }
    // 移除过于技术性的前缀，只保留核心信息
    return error.replace('获取路径信息失败: Status', '')
                .replace('Status {', '')
                .replace('}', '')
                .trim() || '未知错误';
  };

  return (
    <div 
      className={`file-explorer ${theme}`} 
      style={{ height, flexDirection: 'row' }} // 设置为横向布局
      onClick={closeContextMenu}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 左侧：文件树 */}
      <FileTree 
        sessionId={sessionId}
        currentDir={session.currentDir}
        onSelectDir={(path) => changeDir(sessionId, path)}
        width={treeWidth}
        isConnected={session.connected}
      />

      {/* 分隔条 */}
      <div
        className="w-1 hover:bg-primary-500 cursor-col-resize flex-shrink-0 bg-surface-200 dark:bg-surface-700 transition-colors"
        onMouseDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startWidth = treeWidth;
          
          const handleMouseMove = (moveEvent: MouseEvent) => {
            const newWidth = Math.max(150, Math.min(600, startWidth + moveEvent.clientX - startX));
            setTreeWidth(newWidth);
          };
          
          const handleMouseUp = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
          };
          
          document.addEventListener('mousemove', handleMouseMove);
          document.addEventListener('mouseup', handleMouseUp);
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }}
      />

      {/* 右侧：原有内容 (包裹在 flex-col 容器中) */}
      <div className="relative flex-1 flex flex-col min-w-0 bg-surface-50 dark:bg-surface-900/30">
        {/* 工具栏 */}
        <div className="file-explorer-toolbar">
          <button onClick={handleGoUp} title="返回上级目录" disabled={session.currentDir === '/'}>
            <ArrowUp className="w-3.5 h-3.5" /> 上级
          </button>
          <button onClick={handleRefresh} title="刷新" disabled={session.loading}>
            <RefreshCw className="w-3.5 h-3.5" /> 刷新
          </button>
          <button onClick={() => setShowNewFolder(true)} title="新建文件夹">
            <FolderPlus className="w-3.5 h-3.5" /> 文件夹
          </button>
          <button onClick={() => setShowNewFile(true)} title="新建文件">
            <FilePlus className="w-3.5 h-3.5" /> 文件
          </button>
          <div className="flex-1 ml-3 relative group">
            <input 
              type="text" 
              className="w-full bg-surface-200 dark:bg-surface-800 border border-transparent focus:border-primary-500 rounded px-2 py-1 text-xs text-surface-700 dark:text-surface-300 font-mono transition-colors outline-none"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={handlePathInputKeyDown}
              onBlur={() => setPathInput(session.currentDir)} // 失焦时恢复有效路径
              title="按 Enter 跳转"
            />
          </div>
        </div>

        {/* 错误提示 Banner */}
        {session.error && (
          <div className="bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 px-3 py-2 flex items-center justify-between transition-all">
            <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400 overflow-hidden">
               <XCircle className="w-4 h-4 flex-shrink-0" />
               <span className="truncate" title={session.error}>{getFriendlyErrorMessage(session.error)}</span>
            </div>
            <button 
              onClick={() => clearError(sessionId)}
              className="ml-2 text-xs text-red-500 hover:text-red-700 dark:hover:text-red-300 whitespace-nowrap px-2 py-0.5 rounded hover:bg-red-100 dark:hover:bg-red-800/40"
            >
              关闭
            </button>
          </div>
        )}

        {/* 新建文件夹对话框 */}
        {showNewFolder && (
          <div className="new-folder-dialog">
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="文件夹名称"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFolder();
                if (e.key === 'Escape') {
                  setShowNewFolder(false);
                  setNewFolderName('');
                }
              }}
            />
            <button onClick={handleCreateFolder}>确定</button>
            <button onClick={() => { setShowNewFolder(false); setNewFolderName(''); }}>取消</button>
          </div>
        )}

        {/* 新建文件对话框 */}
        {showNewFile && (
          <div className="new-folder-dialog">
            <input
              type="text"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="文件名 (例如: test.txt)"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFile();
                if (e.key === 'Escape') {
                  setShowNewFile(false);
                  setNewFileName('');
                }
              }}
            />
            <button onClick={handleCreateFile}>确定</button>
            <button onClick={() => { setShowNewFile(false); setNewFileName(''); }}>取消</button>
          </div>
        )}

        {/* 文件列表 */}
        {/* 文件列表（支持拖拽上传） */}
        <div 
          className={`file-list ${isDragOver ? 'drag-over' : ''}`}
        >
          {session.loading && (
            <div className="file-list-loading">
              <span className="spinner"></span>
            </div>
          )}
          
          {/* 表头 */}
          <div className="file-list-header">
            <span className="col-name">名称</span>
            <span className="col-size">大小</span>
            <span className="col-modified">修改时间</span>
            <span className="col-permissions">权限</span>
          </div>

          {/* 文件条目 */}
          {session.files.map((file) => (
            <div
              key={file.path}
              className={`file-item ${selectedFiles.has(file.path) ? 'selected' : ''} ${file.is_dir ? 'is-dir' : ''}`}
              onClick={(e) => handleSelect(file, e)}
              onDoubleClick={() => handleDoubleClick(file)}
              onContextMenu={(e) => handleContextMenu(e, file)}
            >
              {renameTarget === file.path ? (
                <div className="rename-input">
                  {renderIcon(file)}
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    autoFocus
                    onBlur={handleConfirmRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleConfirmRename();
                      if (e.key === 'Escape') {
                        setRenameTarget(null);
                        setNewName('');
                      }
                    }}
                  />
                </div>
              ) : (
                <>
                  <span className="col-name">
                    {renderIcon(file)}
                    <span className="file-name">{file.name}</span>
                  </span>
                  <span className="col-size">{file.is_dir ? '-' : formatFileSize(file.size)}</span>
                  <span className="col-modified">{formatDateTime(file.modified)}</span>
                  <span className="col-permissions">{file.permissions}</span>
                </>
              )}
            </div>
          ))}

          {session.files.length === 0 && !session.loading && (
            <div className="file-list-empty">
              <Inbox className="w-6 h-6 text-surface-400 mb-1" />
              <span>空目录</span>
            </div>
          )}
        </div>

        {/* 右键菜单 */}
        {contextMenu && (
          <div
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {contextMenu.file ? (
              <>
                {!contextMenu.file.is_dir && (
                  <div className="context-menu-item" onClick={handleDownload}>
                    <Download className="w-4 h-4" /> 下载
                  </div>
                )}
                <div className="context-menu-item" onClick={handleStartRename}>
                  <Pencil className="w-4 h-4" /> 重命名
                </div>
                <div className="context-menu-item" onClick={() => { setChmodTarget(contextMenu.file!); closeContextMenu(); }}>
                  <Shield className="w-4 h-4" /> 更改权限
                </div>
                <div className="context-menu-item danger" onClick={handleDelete}>
                  <Trash2 className="w-4 h-4" /> 删除
                </div>
              </>
            ) : (
              <>
                <div className="context-menu-item" onClick={handleRefresh}>
                  <RefreshCw className="w-4 h-4" /> 刷新
                </div>
                <div className="context-menu-item" onClick={() => { setShowNewFolder(true); closeContextMenu(); }}>
                  <FolderPlus className="w-4 h-4" /> 新建文件夹
                </div>
                <div className="context-menu-item" onClick={() => { setShowNewFile(true); closeContextMenu(); }}>
                  <FilePlus className="w-4 h-4" /> 新建文件
                </div>
              </>
            )}
          </div>
        )}

        {/* 状态栏 */}
        <div className="file-explorer-status">
          <span>{session.files.length} 项</span>
          <span>|</span>
          <span>{selectedFiles.size} 已选择</span>
        </div>

        {/* 移除文件编辑器覆盖层 */}
      </div>

      {/* 权限修改弹窗 */}
      <ChmodModal
        isOpen={chmodTarget !== null}
        onClose={() => setChmodTarget(null)}
        onConfirm={async (mode) => {
          if (chmodTarget) {
            await chmod(sessionId, chmodTarget.path, mode);
          }
        }}
        fileName={chmodTarget?.name ?? ''}
        currentPermissions={chmodTarget?.permissions ?? '---------'}
        isDir={chmodTarget?.is_dir ?? false}
      />
    </div>
  );
};

export default FileExplorer;
