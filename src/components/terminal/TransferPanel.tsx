/**
 * 传输进度面板组件
 * 
 * 显示上传/下载任务的进度和状态
 */

import React from 'react';
import { useTransferStore, TransferTask, formatSpeed, formatRemainingTime } from '../../stores/transferStore';
import { formatFileSize } from '../../stores/sftpStore';
import { useThemeStore } from '../../stores/themeStore';
import './TransferPanel.css';

/**
 * 获取状态图标
 */
const getStatusIcon = (status: TransferTask['status']): string => {
  switch (status) {
    case 'pending': return '⏳';
    case 'running': return '🔄';
    case 'success': return '✅';
    case 'error': return '❌';
    case 'cancelled': return '🚫';
    default: return '⏳';
  }
};

/**
 * 获取类型图标
 */
const getTypeIcon = (type: TransferTask['type']): string => {
  return type === 'upload' ? '📤' : '📥';
};

/**
 * 传输进度面板
 */
export const TransferPanel: React.FC = () => {
  const { theme } = useThemeStore();
  const { tasks, isPanelExpanded, togglePanel, clearCompleted, removeTask } = useTransferStore();

  // 如果没有任务，不显示面板
  if (tasks.length === 0) {
    return null;
  }

  const activeCount = tasks.filter(t => t.status === 'pending' || t.status === 'running').length;
  const completedCount = tasks.filter(t => t.status === 'success' || t.status === 'error').length;

  return (
    <div className={`transfer-panel ${theme} ${isPanelExpanded ? 'expanded' : 'collapsed'}`}>
      {/* 标题栏 */}
      <div className="transfer-panel-header" onClick={togglePanel}>
        <div className="transfer-panel-title">
          <span className="transfer-icon">📦</span>
          <span>传输任务</span>
          {activeCount > 0 && (
            <span className="transfer-badge active">{activeCount} 进行中</span>
          )}
          {completedCount > 0 && (
            <span className="transfer-badge completed">{completedCount} 已完成</span>
          )}
        </div>
        <div className="transfer-panel-actions">
          {completedCount > 0 && (
            <button 
              className="clear-btn"
              onClick={(e) => { e.stopPropagation(); clearCompleted(); }}
              title="清除已完成"
            >
              🗑️ 清除已完成
            </button>
          )}
          <span className="toggle-icon">{isPanelExpanded ? '▼' : '▲'}</span>
        </div>
      </div>

      {/* 任务列表 */}
      {isPanelExpanded && (
        <div className="transfer-panel-body">
          {tasks.map((task) => (
            <div key={task.id} className={`transfer-item status-${task.status}`}>
              {/* 文件信息 */}
              <div className="transfer-item-info">
                <span className="transfer-type-icon">{getTypeIcon(task.type)}</span>
                <span className="transfer-file-name" title={task.remotePath}>
                  {task.fileName}
                </span>
                <span className="transfer-status-icon">{getStatusIcon(task.status)}</span>
              </div>

              {/* 进度条 */}
              <div className="transfer-progress-bar">
                <div 
                  className="transfer-progress-fill"
                  style={{ width: `${task.progress}%` }}
                />
              </div>

              {/* 进度详情 */}
              <div className="transfer-item-details">
                <span className="transfer-progress-text">
                  {task.progress}% · {formatFileSize(task.transferredSize)} / {formatFileSize(task.size)}
                </span>
                {task.status === 'running' && (
                  <span className="transfer-speed">
                    {formatSpeed(task.speed)} · 剩余 {formatRemainingTime(task)}
                  </span>
                )}
                {task.status === 'error' && task.error && (
                  <span className="transfer-error" title={task.error}>
                    {task.error}
                  </span>
                )}
              </div>

              {/* 操作按钮 */}
              <button 
                className="transfer-remove-btn"
                onClick={() => removeTask(task.id)}
                title="移除"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default TransferPanel;
