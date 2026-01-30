/**
 * SFTP 状态管理
 * 
 * 管理 SFTP 会话、文件列表、当前目录等状态
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

/**
 * 文件条目类型
 */
export interface FileEntry {
  /** 文件名 */
  name: string;
  /** 完整路径 */
  path: string;
  /** 是否为目录 */
  is_dir: boolean;
  /** 文件大小（字节） */
  size: number;
  /** 修改时间（Unix 时间戳） */
  modified: number;
  /** 权限字符串 */
  permissions: string;
  /** 所有者 */
  owner: string;
  /** 所属组 */
  group: string;
}

/**
 * SFTP 会话状态
 */
interface SftpSession {
  /** 会话 ID */
  sessionId: string;
  /** 服务器 ID */
  serverId: string;
  /** 当前目录 */
  currentDir: string;
  /** 文件列表 */
  files: FileEntry[];
  /** 是否正在加载 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 是否已连接 */
  connected: boolean;
}

/**
 * SFTP Store 状态接口
 */
interface SftpState {
  /** SFTP 会话映射 */
  sessions: Record<string, SftpSession>;
  
  /** 连接 SFTP */
  connect: (sessionId: string, serverId: string) => Promise<void>;
  
  /** 断开 SFTP */
  disconnect: (sessionId: string) => Promise<void>;
  
  /** 刷新文件列表 */
  refreshFiles: (sessionId: string, path?: string) => Promise<void>;
  
  /** 更改目录 */
  changeDir: (sessionId: string, path: string) => Promise<void>;
  
  /** 创建目录 */
  mkdir: (sessionId: string, path: string) => Promise<void>;
  
  /** 创建文件 */
  createFile: (sessionId: string, path: string) => Promise<void>;
  
  /** 删除文件或目录 */
  remove: (sessionId: string, path: string, isDir: boolean) => Promise<void>;
  
  /** 重命名 */
  rename: (sessionId: string, oldPath: string, newPath: string) => Promise<void>;
  
  /** 下载文件到本地路径（高性能） */
  downloadToFile: (sessionId: string, remotePath: string, localPath: string, taskId?: string) => Promise<void>;
  
  /** 从本地文件上传到远程（高性能，直接读取本地文件） */
  uploadFromFile: (sessionId: string, localPath: string, remotePath: string, taskId?: string) => Promise<void>;
  
  /** 读取文件内容 */
  readFile: (sessionId: string, path: string) => Promise<string>;
  
  /** 写入文件内容 */
  writeFile: (sessionId: string, path: string, content: string) => Promise<void>;
  
  /** 分块上传控制 */
  cancelUpload: (sessionId: string, token: string) => Promise<void>;
  
  /** 获取会话 */
  getSession: (sessionId: string) => SftpSession | undefined;
  
  /** 清除错误 */
  clearError: (sessionId: string) => void;
}

/**
 * 创建空会话
 */
const createEmptySession = (sessionId: string, serverId: string): SftpSession => ({
  sessionId,
  serverId,
  currentDir: '/',
  files: [],
  loading: false,
  error: null,
  connected: false,
});

/**
 * SFTP Store
 */
export const useSftpStore = create<SftpState>((set, get) => ({
  sessions: {},

  connect: async (sessionId: string, serverId: string) => {
    // 防止重复连接：如果会话正在连接中或已连接，直接返回
    const existingSession = get().sessions[sessionId];
    if (existingSession?.loading || existingSession?.connected) {
      console.log('[SFTP] 会话已存在或正在连接中，跳过重复连接:', sessionId);
      return;
    }

    // 初始化会话状态
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...createEmptySession(sessionId, serverId),
          loading: true,
        },
      },
    }));

    try {
      // 调用后端连接
      const currentDir = await invoke<string>('sftp_connect', {
        sessionId,
        serverId,
      });

      // 先更新 currentDir 和 loading 状态，但暂不设置 connected
      // 确保首次刷新完成后才标记为已连接，避免时序竞争
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            currentDir,
            loading: false,
          },
        },
      }));

      // 刷新文件列表（内部会自动跳过，因为 connected 还是 false）
      // 所以这里手动调用后端获取文件列表
      const files = await invoke<FileEntry[]>('sftp_list_dir', {
        sessionId,
        path: currentDir,
      });

      // 更新文件列表并标记为已连接
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            files,
            connected: true,
          },
        },
      }));
    } catch (error) {
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            loading: false,
            error: String(error),
          },
        },
      }));
      throw error;
    }
  },

  disconnect: async (sessionId: string) => {
    try {
      await invoke('sftp_disconnect', { sessionId });
    } catch (error) {
      console.error('[SFTP] 断开连接失败:', error);
    }

    // 移除会话
    set((state) => {
      const { [sessionId]: _, ...rest } = state.sessions;
      return { sessions: rest };
    });
  },

  refreshFiles: async (sessionId: string, path?: string) => {
    const session = get().sessions[sessionId];
    if (!session?.connected) return;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          loading: true,
          error: null,
        },
      },
    }));

    try {
      const targetPath = path ?? session.currentDir;
      const files = await invoke<FileEntry[]>('sftp_list_dir', {
        sessionId,
        path: targetPath,
      });

      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            files,
            loading: false,
          },
        },
      }));
    } catch (error) {
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            loading: false,
            error: String(error),
          },
        },
      }));
    }
  },

  changeDir: async (sessionId: string, path: string) => {
    // 开始切换目录时，清除之前的错误
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          loading: true,
          error: null,  // 清除之前的错误
        },
      },
    }));

    try {
      const newDir = await invoke<string>('sftp_change_dir', {
        sessionId,
        path,
      });

      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            currentDir: newDir,
            loading: false,  // 确保清除 loading
            error: null,     // 确保清除错误
          },
        },
      }));

      await get().refreshFiles(sessionId, newDir);
    } catch (error) {
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            loading: false,
            error: String(error),
          },
        },
      }));
    }
  },

  mkdir: async (sessionId: string, path: string) => {
    await invoke('sftp_mkdir', { sessionId, path });
    await get().refreshFiles(sessionId);
  },

  createFile: async (sessionId: string, path: string) => {
    await invoke('sftp_create_file', { sessionId, path });
    await get().refreshFiles(sessionId);
  },

  remove: async (sessionId: string, path: string, isDir: boolean) => {
    await invoke('sftp_remove', { sessionId, path, isDir });
    await get().refreshFiles(sessionId);
  },

  rename: async (sessionId: string, oldPath: string, newPath: string) => {
    await invoke('sftp_rename', { sessionId, oldPath, newPath });
    await get().refreshFiles(sessionId);
  },

  downloadToFile: async (sessionId: string, remotePath: string, localPath: string, taskId?: string) => {
    await invoke('sftp_download_to_file', {
      sessionId,
      remotePath,
      localPath,
      taskId: taskId ?? null,
    });
  },

  uploadFromFile: async (sessionId: string, localPath: string, remotePath: string, taskId?: string) => {
    await invoke('sftp_upload_from_file', {
      sessionId,
      localPath,
      remotePath,
      taskId: taskId ?? null,
    });
    await get().refreshFiles(sessionId);
  },

  readFile: async (sessionId: string, path: string) => {
    return await invoke<string>('sftp_read_file', { sessionId, path });
  },

  writeFile: async (sessionId: string, path: string, content: string) => {
    await invoke('sftp_write_file', { sessionId, path, content });
    await get().refreshFiles(sessionId);
  },



  cancelUpload: async (sessionId: string, token: string) => {
    await invoke('sftp_cancel_upload', { sessionId, token });
  },

  getSession: (sessionId: string) => {
    return get().sessions[sessionId];
  },

  clearError: (sessionId: string) => {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          error: null,
        },
      },
    }));
  },
}));

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * 格式化日期时间
 */
export function formatDateTime(timestamp: number): string {
  if (!timestamp) return '-';
  const date = new Date(timestamp * 1000);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 根据文件扩展名获取图标名称
 */
export function getFileIcon(name: string, isDir: boolean): string {
  if (isDir) return 'folder';
  
  const ext = name.split('.').pop()?.toLowerCase() || '';
  
  const iconMap: Record<string, string> = {
    // 文档
    txt: 'file-text',
    md: 'file-text',
    doc: 'file-text',
    docx: 'file-text',
    pdf: 'file-text',
    // 代码
    js: 'file-code',
    ts: 'file-code',
    tsx: 'file-code',
    jsx: 'file-code',
    py: 'file-code',
    rs: 'file-code',
    go: 'file-code',
    java: 'file-code',
    c: 'file-code',
    cpp: 'file-code',
    h: 'file-code',
    css: 'file-code',
    scss: 'file-code',
    html: 'file-code',
    xml: 'file-code',
    json: 'file-code',
    yaml: 'file-code',
    yml: 'file-code',
    toml: 'file-code',
    // 图片
    png: 'file-image',
    jpg: 'file-image',
    jpeg: 'file-image',
    gif: 'file-image',
    svg: 'file-image',
    webp: 'file-image',
    ico: 'file-image',
    // 压缩包
    zip: 'file-archive',
    tar: 'file-archive',
    gz: 'file-archive',
    rar: 'file-archive',
    '7z': 'file-archive',
    // 视频
    mp4: 'file-video',
    avi: 'file-video',
    mkv: 'file-video',
    mov: 'file-video',
    // 音频
    mp3: 'file-audio',
    wav: 'file-audio',
    flac: 'file-audio',
    // 可执行
    sh: 'file-terminal',
    bash: 'file-terminal',
    exe: 'file-cog',
  };
  
  return iconMap[ext] || 'file';
}
