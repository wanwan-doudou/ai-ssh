import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronRight, ChevronDown, Folder, FolderOpen } from 'lucide-react';
import { FileEntry } from '../../stores/sftpStore';

interface FileTreeProps {
  sessionId: string;
  currentDir: string;
  onSelectDir: (path: string) => void;
  width?: number;
  isConnected: boolean; // Add isConnected prop
}

interface TreeNodeData {
  path: string;
  name: string;
  children?: TreeNodeData[];
  isLoaded: boolean;
  isLoading: boolean;
}

export const FileTree: React.FC<FileTreeProps> = ({
  sessionId,
  currentDir,
  onSelectDir,
  width,
  isConnected,
}) => {
  const [rootNodes, setRootNodes] = useState<TreeNodeData[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(['/']));
  const [nodesData, setNodesData] = useState<Map<string, TreeNodeData[]>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());

  // 初始化加载根目录 - 仅当连接成功后执行
  useEffect(() => {
    if (isConnected) {
      loadDir('/');
    }
  }, [sessionId, isConnected]);

  // 规范化路径：去除尾部斜杠（除非是根目录），处理多余斜杠
  const normalizePath = (path: string) => {
    if (!path) return '';
    if (path === '/') return '/';
    // replace multiples slashes with one, remove trailing slash
    return path.replace(/\/+/g, '/').replace(/\/+$/, '');
  };

  // 自动滚动到选中项 (带重试机制，确保 DOM 已渲染)
  useEffect(() => {
    if (!currentDir) return;
    const targetId = `tree-node-${normalizePath(currentDir)}`;
    
    let attempts = 0;
    const maxAttempts = 5;
    
    const tryScroll = () => {
      const element = document.getElementById(targetId);
      if (element) {
        // 检查元素是否在可视区域内
        const container = element.closest('.overflow-y-auto');
        if (container) {
          const rect = element.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          // 如果不在视野内（或者接近边缘），则滚动
          if (rect.top < containerRect.top + 20 || rect.bottom > containerRect.bottom - 20) {
              element.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        }
      } else if (attempts < maxAttempts) {
        attempts++;
        setTimeout(tryScroll, 100); // 100ms 后重试
      }
    };
    
    tryScroll();
  }, [currentDir, nodesData, expandedPaths]);

  // 监听 currentDir 变化，自动展开父目录
  useEffect(() => {
    if (!currentDir || !isConnected) return;
    
    const normalizedCurrent = normalizePath(currentDir);
    // console.log('[FileTree] Syncing to:', normalizedCurrent);

    const parts = normalizedCurrent.split('/').filter(Boolean);
    let pathBuilder = '';
    
    // 使用函数式更新
    setExpandedPaths(prev => {
        const newExpanded = new Set(prev);
        let updated = false;

        // 1. 确保根目录展开
        if (!newExpanded.has('/')) {
            newExpanded.add('/');
            updated = true;
        }

        // 2. 逐级构建并展开所有父路径
        // 例如 /home/doudou/foo
        // 展开: /home, /home/doudou
        for (let i = 0; i < parts.length; i++) {
            pathBuilder += `/${parts[i]}`;
            // 不管是否存在，都标记为展开（意图）
            if (!newExpanded.has(pathBuilder)) {
                newExpanded.add(pathBuilder);
                updated = true;
                // console.log('[FileTree] Expanding:', pathBuilder);
            }
        }
        return updated ? newExpanded : prev;
    });

    // 3. 触发缺失数据的加载
    // 重置 pathBuilder 重新遍历
    pathBuilder = '';
    if (rootNodes.length === 0 && !loadingPaths.has('/')) {
        loadDir('/');
    }

    for (let i = 0; i < parts.length; i++) {
        pathBuilder += `/${parts[i]}`;
        // 对于路径上的每个节点，我们需要加载它的 children 才能显示下一级
        // 比如 /home，加载了才能看到 /home/doudou
        if (!nodesData.has(pathBuilder) && !loadingPaths.has(pathBuilder)) {
             // console.log('[FileTree] Trigger loading for:', pathBuilder);
             loadDir(pathBuilder);
        }
    }
    
  }, [currentDir, isConnected, rootNodes.length]); 

  const loadDir = async (path: string) => {
    const safePath = normalizePath(path);
    if (loadingPaths.has(safePath)) return;

    setLoadingPaths(prev => {
      const next = new Set(prev);
      next.add(safePath);
      return next;
    });

    try {
      const files = await invoke<FileEntry[]>('sftp_list_dir', {
        sessionId,
        path: safePath,
      });

      const folders = files
        .filter(f => f.is_dir)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(f => ({
          path: normalizePath(f.path), // 确保存储的路径也是规范化的
          name: f.name,
          isLoaded: false,
          isLoading: false
        }));

      setNodesData(prev => {
        const next = new Map(prev);
        next.set(safePath, folders);
        return next;
      });

      if (safePath === '/') {
        setRootNodes(folders);
      }
    } catch (err) {
      console.error(`Failed to load directory: ${safePath}`, err);
    } finally {
      setLoadingPaths(prev => {
        const next = new Set(prev);
        next.delete(safePath);
        return next;
      });
    }
  };

  const toggleExpand = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    const safePath = normalizePath(path);
    
    const newExpanded = new Set(expandedPaths);
    if (newExpanded.has(safePath)) {
      newExpanded.delete(safePath);
    } else {
      newExpanded.add(safePath);
      // 如果展开且未加载数据，则加载
      if (!nodesData.has(safePath)) {
        loadDir(safePath);
      }
    }
    setExpandedPaths(newExpanded);
  };

  const handleSelect = (path: string) => {
    onSelectDir(path);
  };

  const TreeNode = ({ node, level }: { node: TreeNodeData, level: number }) => {
    // 确保比较时也是规范化的
    const normalizedNodePath = normalizePath(node.path);
    const normalizedCurrent = normalizePath(currentDir);
    
    // 宽松比较：只要路径字符串一致即可
    const isExpanded = expandedPaths.has(normalizedNodePath);
    const isSelected = normalizedCurrent === normalizedNodePath;
    const isLoading = loadingPaths.has(normalizedNodePath);
    
    // 缩进样式
    const paddingLeft = `${level * 16 + 4}px`;

    return (
      <div className="select-none">
        <div 
          id={`tree-node-${normalizedNodePath}`}
          className={`flex items-center py-1 pr-2 hover:bg-surface-200 dark:hover:bg-surface-800 cursor-pointer text-sm whitespace-nowrap ${
            isSelected ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300' : 'text-surface-700 dark:text-surface-300'
          }`}
          style={{ paddingLeft }}
          onClick={() => handleSelect(node.path)}
        >
          {/* 展开/折叠图标 */}
          <div 
            className="p-0.5 rounded hover:bg-surface-300 dark:hover:bg-surface-700 mr-0.5"
            onClick={(e) => toggleExpand(e, node.path)} // 保持原始路径操作? 或者 normalized? 建议 normalized
          >
            {isLoading ? (
              <div className="w-3 h-3 border-2 border-surface-400 border-t-transparent rounded-full animate-spin" />
            ) : isExpanded ? (
              <ChevronDown className="w-3 h-3 text-surface-500" />
            ) : (
              <ChevronRight className="w-3 h-3 text-surface-500" />
            )}
          </div>
          
          {/* 文件夹图标 */}
          <div className="mr-1.5 text-yellow-500">
             {isExpanded ? <FolderOpen className="w-4 h-4" size={16} fill="currentColor" fillOpacity={0.2} /> : <Folder className="w-4 h-4" size={16} fill="currentColor" fillOpacity={0.2} />}
          </div>
          
          <span className="truncate">{node.name}</span>
        </div>
        
        {/* 子节点 */}
        {isExpanded && nodesData.has(node.path) && (
          <div>
            {nodesData.get(node.path)!.map(child => (
              <TreeNode key={child.path} node={child} level={level + 1} />
            ))}
            {nodesData.get(node.path)!.length === 0 && (
              <div 
                className="text-xs text-surface-400 py-1 pl-8 italic"
                style={{ paddingLeft: `${(level + 1) * 16 + 24}px` }}
              >
                (空)
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div 
      className="h-full overflow-y-auto bg-surface-50 dark:bg-surface-950/50 border-r border-surface-200 dark:border-surface-800"
      style={{ width: width ? `${width}px` : '100%' }}
    >
      <div className="py-2">
        {/* 根节点 */}
        <div 
          id="tree-node-/"
          className={`flex items-center py-1 px-2 hover:bg-surface-200 dark:hover:bg-surface-800 cursor-pointer text-sm ${
            currentDir === '/' ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300' : 'text-surface-700 dark:text-surface-300'
          }`}
          onClick={() => handleSelect('/')}
        >
           <div 
            className="p-0.5 rounded hover:bg-surface-300 dark:hover:bg-surface-700 mr-0.5"
            onClick={(e) => toggleExpand(e, '/')}
          >
            {loadingPaths.has('/') ? (
              <div className="w-3 h-3 border-2 border-surface-400 border-t-transparent rounded-full animate-spin" />
            ) : expandedPaths.has('/') ? (
              <ChevronDown className="w-3 h-3 text-surface-500" />
            ) : (
              <ChevronRight className="w-3 h-3 text-surface-500" />
            )}
          </div>
          <div className="mr-1.5 text-yellow-500">
            <FolderOpen className="w-4 h-4" size={16} fill="currentColor" fillOpacity={0.2} />
          </div>
          <span>/ (根目录)</span>
        </div>
        
        {/* 根目录的一级子节点 */}
        {expandedPaths.has('/') && rootNodes.map(node => (
          <TreeNode key={node.path} node={node} level={1} />
        ))}
      </div>
    </div>
  );
};
