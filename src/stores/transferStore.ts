/**
 * 传输任务状态管理
 * 
 * 管理文件上传/下载任务的进度、状态等
 */

import { create } from 'zustand';

/**
 * 传输任务类型
 */
export type TransferType = 'upload' | 'download';

/**
 * 传输状态
 */
export type TransferStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled';

/**
 * 传输任务
 */
export interface TransferTask {
  /** 任务 ID */
  id: string;
  /** 传输类型 */
  type: TransferType;
  /** 文件名 */
  fileName: string;
  /** 远程路径 */
  remotePath: string;
  /** 本地路径（下载时使用） */
  localPath?: string;
  /** 进度百分比 (0-100) */
  progress: number;
  /** 状态 */
  status: TransferStatus;
  /** 文件大小（字节） */
  size: number;
  /** 已传输大小（字节） */
  transferredSize: number;
  /** 传输速度（字节/秒） */
  speed: number;
  /** 错误信息 */
  error?: string;
  /** 开始时间 */
  startTime: number;
  /** 上传 token（用于取消上传） */
  token?: string;
  /** 会话 ID（用于取消上传） */
  sessionId?: string;
}

/**
 * 传输 Store 状态接口
 */
interface TransferState {
  /** 传输任务列表 */
  tasks: TransferTask[];
  /** 面板是否展开 */
  isPanelExpanded: boolean;
  
  /** 添加任务 */
  addTask: (task: Omit<TransferTask, 'id' | 'progress' | 'status' | 'transferredSize' | 'speed' | 'startTime'>) => string;
  
  /** 更新任务进度 */
  updateProgress: (taskId: string, transferredSize: number, speed?: number, total?: number) => void;
  
  /** 设置任务状态 */
  setTaskStatus: (taskId: string, status: TransferStatus, error?: string) => void;
  
  /** 设置任务速度 */
  setTaskSpeed: (taskId: string, speed: number) => void;
  
  /** 移除任务（返回被移除的任务，可用于取消上传） */
  removeTask: (taskId: string) => TransferTask | undefined;
  
  /** 设置任务 token（用于取消上传） */
  setTaskToken: (taskId: string, token: string, sessionId: string) => void;
  
  /** 清除已完成任务 */
  clearCompleted: () => void;
  
  /** 切换面板展开状态 */
  togglePanel: () => void;
  
  /** 获取活跃任务数量 */
  getActiveCount: () => number;
}

/**
 * 生成唯一任务ID
 */
const generateTaskId = (): string => {
  return `transfer_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
};

/**
 * 传输 Store
 */
export const useTransferStore = create<TransferState>((set, get) => ({
  tasks: [],
  isPanelExpanded: true,

  addTask: (taskData) => {
    const taskId = generateTaskId();
    const task: TransferTask = {
      ...taskData,
      id: taskId,
      progress: 0,
      status: 'pending',
      transferredSize: 0,
      speed: 0,
      startTime: Date.now(),
    };

    set((state) => ({
      tasks: [...state.tasks, task],
      isPanelExpanded: true, // 添加任务时自动展开面板
    }));

    return taskId;
  },

  updateProgress: (taskId, transferredSize, speed, total) => {
    set((state) => ({
      tasks: state.tasks.map((task) => {
        if (task.id !== taskId) return task;
        
        const size = total !== undefined ? total : task.size;
        const progress = size > 0 ? Math.min(100, Math.round((transferredSize / size) * 100)) : 0;
        
        // 如果没有传入 speed，则根据已传输大小和时间计算
        const calculatedSpeed = speed ?? (
          Date.now() > task.startTime 
            ? Math.round(transferredSize / ((Date.now() - task.startTime) / 1000))
            : 0
        );

        return {
          ...task,
          size,
          transferredSize,
          progress,
          speed: calculatedSpeed,
          status: task.status === 'pending' ? 'running' : task.status,
        };
      }),
    }));
  },

  setTaskStatus: (taskId, status, error) => {
    set((state) => ({
      tasks: state.tasks.map((task) => {
        if (task.id !== taskId) return task;
        return {
          ...task,
          status,
          error,
          progress: status === 'success' ? 100 : task.progress,
          speed: status === 'success' || status === 'error' ? 0 : task.speed,
        };
      }),
    }));
  },

  removeTask: (taskId) => {
    const task = get().tasks.find(t => t.id === taskId);
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== taskId),
    }));
    return task;
  },

  setTaskToken: (taskId, token, sessionId) => {
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === taskId ? { ...task, token, sessionId } : task
      ),
    }));
  },

  setTaskSpeed: (taskId, speed) => {
    set((state) => ({
      tasks: state.tasks.map((task) => 
        task.id === taskId ? { ...task, speed } : task
      ),
    }));
  },

  clearCompleted: () => {
    set((state) => ({
      tasks: state.tasks.filter((task) => task.status !== 'success' && task.status !== 'error'),
    }));
  },

  togglePanel: () => {
    set((state) => ({
      isPanelExpanded: !state.isPanelExpanded,
    }));
  },

  getActiveCount: () => {
    return get().tasks.filter((task) => task.status === 'pending' || task.status === 'running').length;
  },
}));

/**
 * 格式化传输速度
 */
export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond === 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
  return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * 格式化剩余时间
 */
export function formatRemainingTime(task: TransferTask): string {
  if (task.speed === 0 || task.status !== 'running') return '--';
  const remaining = task.size - task.transferredSize;
  const seconds = Math.round(remaining / task.speed);
  
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}分钟`;
  return `${Math.round(seconds / 3600)}小时`;
}
