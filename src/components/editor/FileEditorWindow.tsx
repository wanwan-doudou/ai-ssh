
import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useThemeStore } from '../../stores/themeStore';
import { FileText, Save, Loader2, RefreshCw, XCircle } from 'lucide-react';

interface EditorParams {
  sessionId: string;
  path: string;
}

export const FileEditorWindow: React.FC = () => {
  const { theme } = useThemeStore();
  const [params, setParams] = useState<EditorParams | null>(null);
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 初始化：解析 URL 参数并加载文件
  useEffect(() => {
    // 解析查询参数
    const searchParams = new URLSearchParams(window.location.search);
    const sessionId = searchParams.get('sessionId');
    const path = searchParams.get('path');

    if (!sessionId || !path) {
      setError('缺少必要参数: sessionId 或 path');
      setIsLoading(false);
      return;
    }

    setParams({ sessionId, path });
    loadContent(sessionId, path);
    
    // 设置窗口标题
    const fileName = path.split('/').pop() || path;
    getCurrentWindow().setTitle(`${fileName} - 编辑器`);
  }, []);

  // 加载文件内容
  const loadContent = async (sessionId: string, path: string) => {
    setIsLoading(true);
    setError(null);
    try {
      // 直接调用 Rust 命令，避免依赖 Store (新窗口 Store 为空)
      const data = await invoke<string>('sftp_read_file', { sessionId, path });
      setContent(data);
      setOriginalContent(data);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsLoading(false);
    }
  };

  // 保存文件
  const handleSave = async () => {
    if (!params) return;
    setIsSaving(true);
    try {
      await invoke('sftp_write_file', { 
        sessionId: params.sessionId, 
        path: params.path, 
        content 
      });
      setOriginalContent(content);
      // alert('保存成功');
    } catch (err) {
      alert(`保存失败: ${err}`);
    } finally {
      setIsSaving(false);
    }
  };

  // 快捷键处理
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      handleSave();
    }
    if (e.key === 'Escape') {
        // 可选：关闭窗口
        // getCurrentWindow().close();
    }
  };

  const isDirty = content !== originalContent;

  if (isLoading) {
    return (
      <div className={`h-screen flex flex-col items-center justify-center bg-surface-50 dark:bg-surface-950 text-surface-900 dark:text-surface-100 ${theme}`}>
        <Loader2 className="w-8 h-8 animate-spin text-primary-500 mb-3" />
        <div className="text-surface-600 dark:text-surface-400">正在加载文件...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`h-screen flex flex-col items-center justify-center bg-surface-50 dark:bg-surface-950 text-surface-900 dark:text-surface-100 ${theme} p-4`}>
        <XCircle className="w-14 h-14 text-red-400 mb-4" strokeWidth={1.5} />
        <div className="text-red-500 text-lg font-medium mb-2">加载失败</div>
        <div className="text-surface-600 dark:text-surface-400 mb-4 text-center max-w-md">{error}</div>
        <button 
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-primary-500 text-white rounded-lg hover:bg-primary-600 transition-colors flex items-center gap-2"
        >
          <RefreshCw className="w-4 h-4" />
          重试
        </button>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-screen bg-surface-50 dark:bg-surface-950 text-surface-900 dark:text-surface-100 ${theme}`}>
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-surface-200 dark:border-surface-800 bg-surface-100 dark:bg-surface-900">
        <div className="flex items-center gap-3 overflow-hidden">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary-500 to-primary-600 flex items-center justify-center shadow-sm">
            <FileText className="w-5 h-5 text-white" />
          </div>
          <div className="flex flex-col">
              <span className="font-medium truncate text-sm" title={params?.path}>
                {params?.path.split('/').pop()}
              </span>
              <span className="text-xs text-surface-500 truncate" title={params?.path}>
                {params?.path}
              </span>
          </div>
          {isDirty && <span className="text-xs text-amber-500 font-bold ml-2">● 未保存</span>}
        </div>
        
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={isSaving || !isDirty}
            className={`px-3 py-1.5 rounded text-sm flex items-center gap-1 transition-colors
              ${isSaving || !isDirty 
                ? 'bg-surface-200 dark:bg-surface-800 text-surface-400 cursor-not-allowed' 
                : 'bg-primary-500 hover:bg-primary-600 text-white shadow-sm'
              }`}
          >
            {isSaving ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> 保存中...</>
            ) : (
              <><Save className="w-4 h-4" /> 保存</>
            )}
          </button>
        </div>
      </div>

      {/* 编辑区域 */}
      <div className="flex-1 relative">
        <textarea
          className="absolute inset-0 w-full h-full p-4 font-mono text-sm bg-transparent border-none resize-none outline-none leading-relaxed" // text-surface-900 dark:text-surface-100 inherited
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoFocus
        />
      </div>
    </div>
  );
};
