/**
 * Sidebar 传输任务列表组件
 * 
 * 在侧边栏底部显示传输任务
 */

import React from 'react';
import { useTransferStore, TransferTask, formatSpeed } from '../../stores/transferStore';
import { formatFileSize, useSftpStore } from '../../stores/sftpStore';
import { Upload, Download, X, CheckCircle2, AlertCircle, Loader2, Trash2 } from 'lucide-react';

/**
 * 获取状态图标组件
 */
const StatusIcon: React.FC<{ status: TransferTask['status'] }> = ({ status }) => {
  switch (status) {
    case 'pending':
      return <Loader2 className="w-3 h-3 text-surface-400 animate-spin" />;
    case 'running':
      return <Loader2 className="w-3 h-3 text-primary-500 animate-spin" />;
    case 'success':
      return <CheckCircle2 className="w-3 h-3 text-green-500" />;
    case 'error':
      return <AlertCircle className="w-3 h-3 text-red-500" />;
    default:
      return <Loader2 className="w-3 h-3 text-surface-400" />;
  }
};

/**
 * Sidebar 传输面板
 */
export const SidebarTransferPanel: React.FC = () => {
  const { tasks, isPanelExpanded, togglePanel, clearCompleted, removeTask } = useTransferStore();
  const { cancelUpload } = useSftpStore();

  const activeCount = tasks.filter(t => t.status === 'pending' || t.status === 'running').length;
  const completedCount = tasks.filter(t => t.status === 'success' || t.status === 'error').length;

  // 处理删除任务 - 如果正在上传则取消
  const handleRemoveTask = async (taskId: string) => {
    const task = removeTask(taskId);
    // 如果任务正在运行，调用取消上传
    if (task && (task.status === 'running' || task.status === 'pending') && task.sessionId) {
      try {
        // 使用 token（分块上传）或 taskId（高性能上传）作为取消标识
        const cancelKey = task.token || task.id;
        await cancelUpload(task.sessionId, cancelKey);
        console.log('[SidebarTransferPanel] 已取消上传:', task.fileName);
      } catch (e) {
        console.error('[SidebarTransferPanel] 取消上传失败:', e);
      }
    }
  };

  // 如果没有任务，不显示面板
  if (tasks.length === 0) {
    return null;
  }

  return (
    <div className={`border-t border-surface-200 dark:border-surface-800 transition-colors duration-300`}>
      {/* 标题栏 */}
      <button
        onClick={togglePanel}
        className="w-full px-3 py-2 flex items-center justify-between hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-surface-700 dark:text-surface-300">传输任务</span>
          {activeCount > 0 && (
            <span className="px-1.5 py-0.5 text-xs bg-primary-500 text-white rounded-full">
              {activeCount}
            </span>
          )}
        </div>
        <span className="text-xs text-surface-400">
          {isPanelExpanded ? '▼' : '▲'}
        </span>
      </button>

      {/* 任务列表 */}
      {isPanelExpanded && (
        <div className="max-h-48 overflow-y-auto">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="px-3 py-2 hover:bg-surface-50 dark:hover:bg-surface-800/50 group transition-colors"
            >
              {/* 文件信息行 */}
              <div className="flex items-center gap-2 mb-1">
                {task.type === 'upload' ? (
                  <Upload className="w-3 h-3 text-primary-500 flex-shrink-0" />
                ) : (
                  <Download className="w-3 h-3 text-green-500 flex-shrink-0" />
                )}
                <span
                  className="text-xs text-surface-700 dark:text-surface-300 truncate flex-1"
                  title={task.remotePath}
                >
                  {task.fileName}
                </span>
                <StatusIcon status={task.status} />
                <button
                  onClick={() => handleRemoveTask(task.id)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-surface-200 dark:hover:bg-surface-700 rounded transition-opacity"
                >
                  <X className="w-3 h-3 text-surface-400" />
                </button>
              </div>

              {/* 进度条 */}
              <div className="h-1 bg-surface-200 dark:bg-surface-700 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    task.status === 'error' ? 'bg-red-500' :
                    task.status === 'success' ? 'bg-green-500' : 'bg-primary-500'
                  }`}
                  style={{ width: `${task.progress}%` }}
                />
              </div>

              {/* 进度信息 */}
              <div className="flex items-center justify-between mt-1">
                <span className="text-xs text-surface-500">
                  {task.progress}% · {formatFileSize(task.transferredSize)} / {formatFileSize(task.size)}
                </span>
                {task.status === 'running' && task.speed > 0 && (
                  <span className="text-xs text-primary-500">
                    {formatSpeed(task.speed)}
                  </span>
                )}
                {task.status === 'error' && task.error && (
                  <span className="text-xs text-red-500 truncate max-w-20" title={task.error}>
                    失败
                  </span>
                )}
              </div>
            </div>
          ))}

          {/* 清除按钮 */}
          {completedCount > 0 && (
            <button
              onClick={clearCompleted}
              className="w-full px-3 py-2 flex items-center justify-center gap-1 text-xs text-surface-500 hover:text-surface-700 dark:hover:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              清除已完成 ({completedCount})
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default SidebarTransferPanel;
