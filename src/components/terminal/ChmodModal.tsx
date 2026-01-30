/**
 * 权限修改弹窗组件
 * 
 * 提供可视化的 Unix 权限编辑界面，支持复选框矩阵编辑 rwx 权限
 */

import React, { useState, useEffect, useMemo } from 'react';
import { X, Shield } from 'lucide-react';

interface ChmodModalProps {
  /** 是否显示弹窗 */
  isOpen: boolean;
  /** 关闭弹窗 */
  onClose: () => void;
  /** 确认修改 */
  onConfirm: (mode: number) => void;
  /** 文件名 */
  fileName: string;
  /** 当前权限字符串 (如 "rwxr-xr-x") */
  currentPermissions: string;
  /** 是否为目录 */
  isDir: boolean;
}

/**
 * 将权限字符串转换为八进制数值
 * @param perms 权限字符串 (如 "rwxr-xr-x" 或 "drwxr-xr-x")
 */
function permissionsToMode(perms: string): number {
  // 如果权限字符串包含文件类型前缀 (d/l/-), 去掉它
  const rwx = perms.length === 10 ? perms.slice(1) : perms;
  
  let mode = 0;
  
  // Owner
  if (rwx[0] === 'r') mode |= 0o400;
  if (rwx[1] === 'w') mode |= 0o200;
  if (rwx[2] === 'x' || rwx[2] === 's') mode |= 0o100;
  if (rwx[2] === 's' || rwx[2] === 'S') mode |= 0o4000; // setuid
  
  // Group
  if (rwx[3] === 'r') mode |= 0o040;
  if (rwx[4] === 'w') mode |= 0o020;
  if (rwx[5] === 'x' || rwx[5] === 's') mode |= 0o010;
  if (rwx[5] === 's' || rwx[5] === 'S') mode |= 0o2000; // setgid
  
  // Others
  if (rwx[6] === 'r') mode |= 0o004;
  if (rwx[7] === 'w') mode |= 0o002;
  if (rwx[8] === 'x' || rwx[8] === 't') mode |= 0o001;
  if (rwx[8] === 't' || rwx[8] === 'T') mode |= 0o1000; // sticky
  
  return mode;
}

/**
 * 将八进制数值转换为权限字符串
 */
function modeToPermissions(mode: number): string {
  const chars = [];
  
  // Owner
  chars.push((mode & 0o400) ? 'r' : '-');
  chars.push((mode & 0o200) ? 'w' : '-');
  chars.push((mode & 0o100) ? 'x' : '-');
  
  // Group
  chars.push((mode & 0o040) ? 'r' : '-');
  chars.push((mode & 0o020) ? 'w' : '-');
  chars.push((mode & 0o010) ? 'x' : '-');
  
  // Others
  chars.push((mode & 0o004) ? 'r' : '-');
  chars.push((mode & 0o002) ? 'w' : '-');
  chars.push((mode & 0o001) ? 'x' : '-');
  
  return chars.join('');
}

/**
 * 将八进制数值转换为三位数字字符串 (如 "755")
 */
function modeToOctal(mode: number): string {
  // 只取低 9 位 (不包含 setuid/setgid/sticky)
  const owner = (mode >> 6) & 0o7;
  const group = (mode >> 3) & 0o7;
  const other = mode & 0o7;
  return `${owner}${group}${other}`;
}

export const ChmodModal: React.FC<ChmodModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  fileName,
  currentPermissions,
  isDir,
}) => {
  // 从当前权限字符串解析出初始 mode
  const initialMode = useMemo(() => permissionsToMode(currentPermissions), [currentPermissions]);
  
  const [mode, setMode] = useState(initialMode);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // 当弹窗打开时重置状态
  useEffect(() => {
    if (isOpen) {
      setMode(permissionsToMode(currentPermissions));
      setIsSubmitting(false);
      setError(null);
    }
  }, [isOpen, currentPermissions]);
  
  // 权限复选框状态
  const permissions = useMemo(() => ({
    owner: {
      read: (mode & 0o400) !== 0,
      write: (mode & 0o200) !== 0,
      execute: (mode & 0o100) !== 0,
    },
    group: {
      read: (mode & 0o040) !== 0,
      write: (mode & 0o020) !== 0,
      execute: (mode & 0o010) !== 0,
    },
    others: {
      read: (mode & 0o004) !== 0,
      write: (mode & 0o002) !== 0,
      execute: (mode & 0o001) !== 0,
    },
  }), [mode]);
  
  // 切换权限位
  const togglePermission = (target: 'owner' | 'group' | 'others', perm: 'read' | 'write' | 'execute') => {
    const bits: Record<string, Record<string, number>> = {
      owner: { read: 0o400, write: 0o200, execute: 0o100 },
      group: { read: 0o040, write: 0o020, execute: 0o010 },
      others: { read: 0o004, write: 0o002, execute: 0o001 },
    };
    
    const bit = bits[target][perm];
    setMode((prev) => prev ^ bit);
  };
  
  // 处理确认
  const handleConfirm = async () => {
    setIsSubmitting(true);
    setError(null);
    
    try {
      await onConfirm(mode);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setIsSubmitting(false);
    }
  };
  
  if (!isOpen) return null;
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-surface-100 dark:bg-surface-800 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden border border-surface-200 dark:border-surface-700">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 bg-surface-200/50 dark:bg-surface-700/50 border-b border-surface-200 dark:border-surface-700">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary-500" />
            <span className="font-medium text-surface-800 dark:text-surface-200">更改权限</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-surface-300 dark:hover:bg-surface-600 transition-colors"
          >
            <X className="w-5 h-5 text-surface-500" />
          </button>
        </div>
        
        {/* 内容 */}
        <div className="p-4 space-y-4">
          {/* 文件名 */}
          <div className="text-sm text-surface-600 dark:text-surface-400">
            <span className="font-medium">{isDir ? '目录' : '文件'}:</span>{' '}
            <span className="font-mono text-surface-800 dark:text-surface-200">{fileName}</span>
          </div>
          
          {/* 权限显示 */}
          <div className="flex items-center justify-between bg-surface-200/50 dark:bg-surface-700/30 rounded-lg px-3 py-2">
            <span className="text-sm text-surface-600 dark:text-surface-400">权限:</span>
            <div className="flex items-center gap-3">
              <span className="font-mono text-surface-800 dark:text-surface-200">
                {modeToPermissions(mode)}
              </span>
              <span className="font-mono text-primary-500 font-medium">
                ({modeToOctal(mode)})
              </span>
            </div>
          </div>
          
          {/* 权限矩阵 */}
          <div className="overflow-hidden rounded-lg border border-surface-200 dark:border-surface-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-200/50 dark:bg-surface-700/50">
                  <th className="px-3 py-2 text-left font-medium text-surface-600 dark:text-surface-400"></th>
                  <th className="px-3 py-2 text-center font-medium text-surface-600 dark:text-surface-400">读取</th>
                  <th className="px-3 py-2 text-center font-medium text-surface-600 dark:text-surface-400">写入</th>
                  <th className="px-3 py-2 text-center font-medium text-surface-600 dark:text-surface-400">执行</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200 dark:divide-surface-700">
                {(['owner', 'group', 'others'] as const).map((target) => (
                  <tr key={target} className="hover:bg-surface-100 dark:hover:bg-surface-700/30">
                    <td className="px-3 py-2 font-medium text-surface-700 dark:text-surface-300">
                      {target === 'owner' ? '所有者' : target === 'group' ? '用户组' : '其他人'}
                    </td>
                    {(['read', 'write', 'execute'] as const).map((perm) => (
                      <td key={perm} className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={permissions[target][perm]}
                          onChange={() => togglePermission(target, perm)}
                          className="w-5 h-5 rounded border-surface-300 dark:border-surface-600 
                                     text-primary-500 focus:ring-primary-500 focus:ring-offset-0
                                     bg-surface-100 dark:bg-surface-700 cursor-pointer"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          
          {/* 错误提示 */}
          {error && (
            <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>
        
        {/* 按钮 */}
        <div className="flex justify-end gap-2 px-4 py-3 bg-surface-200/30 dark:bg-surface-700/30 border-t border-surface-200 dark:border-surface-700">
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-medium text-surface-600 dark:text-surface-400 
                       hover:bg-surface-200 dark:hover:bg-surface-700 rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-medium text-white bg-primary-500 
                       hover:bg-primary-600 rounded-lg transition-colors disabled:opacity-50"
          >
            {isSubmitting ? '保存中...' : '确定'}
          </button>
        </div>
      </div>
    </div>
  );
};
