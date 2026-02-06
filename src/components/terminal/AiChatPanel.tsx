import { useState, useRef, useEffect } from 'react';
import { Send, Play, X, Sparkles, Zap, Loader2, Bot, StopCircle, Plus } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChatStore } from '@/stores/chatStore';
import { useProviderStore } from '@/stores/providerStore';
import { 
  useTerminalOutputStore, 
  COMMAND_OUTPUT_TIMEOUT,
  isCommandEchoed,
  detectNewPromptLine,
  QUICK_COMPLETE_THRESHOLD,
  LONG_IDLE_THRESHOLD 
} from '@/stores/terminalOutputStore';
import type { ChatMessage } from '@/types';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useThemeStore } from '@/stores/themeStore';

// 流式事件数据结构
interface StreamEvent {
  chunk?: string;
  done: boolean;
  error?: string;
  command?: string;
}

interface AiChatPanelProps {
  sessionId: string;
  // 执行命令到终端的回调
  onExecuteCommand: (command: string) => void;
}

const MAX_INPUT_LINES = 5;

export function AiChatPanel({ sessionId, onExecuteCommand }: AiChatPanelProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 用于中断当前 AI 请求的事件监听器引用
  const unlistenRef = useRef<UnlistenFn | null>(null);
  
  const { 
    getMessages, 
    addMessage, 
    updateMessage,
    setLoading,
    setWaitingForOutput,
    operationMode, 
    toggleOperationMode 
  } = useChatStore();
  
  const { getActiveProvider, fetchProviders } = useProviderStore();
  // 订阅主题变更，确保组件重渲染（虽然主要依赖 CSS，但这样更稳健）
  const { theme } = useThemeStore();
  
  useEffect(() => {
    console.log('[AiChatPanel] Theme updated:', theme);
  }, [theme]);
  
  // 终端输出管理
  const { 
    getOutput, 
    clearOutput, 
    setPendingCommand, 
    clearPendingCommand 
  } = useTerminalOutputStore();
  
  const messages = getMessages(sessionId);
  const isLoading = useChatStore((state) => 
    state.sessions.get(sessionId)?.isLoading || false
  );
  const isWaitingForOutput = useChatStore((state) => 
    state.sessions.get(sessionId)?.waitingForOutput || false
  );

  const resizeInputTextarea = (textarea?: HTMLTextAreaElement | null) => {
    const el = textarea ?? inputRef.current;
    if (!el) return;

    // 先重置为 auto，才能正确读取 scrollHeight
    el.style.height = 'auto';

    const style = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(style.lineHeight || '20') || 20;
    const paddingTop = Number.parseFloat(style.paddingTop || '0') || 0;
    const paddingBottom = Number.parseFloat(style.paddingBottom || '0') || 0;
    const maxHeight = Math.ceil(lineHeight * MAX_INPUT_LINES + paddingTop + paddingBottom);
    const nextHeight = Math.min(el.scrollHeight, maxHeight);

    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  };

  const ensureActiveProvider = async () => {
    let provider = getActiveProvider();
    if (provider) return provider;

    try {
      await fetchProviders();
    } catch (err) {
      console.error('[AiChatPanel] 加载 Provider 失败:', err);
    }

    provider = useProviderStore.getState().getActiveProvider();
    return provider;
  };

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 输入框随内容自动增高，最多 5 行
  useEffect(() => {
    resizeInputTextarea();
  }, [input]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    resizeInputTextarea(e.target);
  };

  // 发送消息到 AI（流式）
  const handleSendMessage = async () => {
    const trimmedInput = input.trim();
    if (!trimmedInput || isLoading) return;

    const activeProvider = await ensureActiveProvider();
    if (!activeProvider) {
      addMessage(sessionId, {
        role: 'system',
        content: '❌ 请先在「AI提供商」页面配置并激活一个 AI Provider',
      });
      return;
    }

    // 添加用户消息
    addMessage(sessionId, {
      role: 'user',
      content: trimmedInput,
    });
    setInput('');
    setLoading(sessionId, true);

    // 先添加一条空的 assistant 消息，用于流式更新
    addMessage(sessionId, {
      role: 'assistant',
      content: '',
    });

    // 获取刚添加的消息 ID
    const allMessages = getMessages(sessionId);
    const assistantMessageId = allMessages[allMessages.length - 1].id;
    let fullContent = '';

    try {
      // 获取历史消息（排除刚添加的空消息）
      const history = allMessages.slice(0, -1).map(m => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content
      }));

      // 设置事件监听
      const unlisten = await listen<StreamEvent>(`ai-stream-${sessionId}`, (event) => {
        const data = event.payload;
        
        if (data.error) {
          // 收到错误
          updateMessage(sessionId, assistantMessageId, {
            content: `❌ ${data.error}`,
          });
          setLoading(sessionId, false);
          return;
        }
        
        if (data.chunk) {
          // 追加内容
          fullContent += data.chunk;
          updateMessage(sessionId, assistantMessageId, {
            content: fullContent,
          });
        }
        
        if (data.done) {
          // 流结束，处理命令
          updateMessage(sessionId, assistantMessageId, {
            content: fullContent,
            command: data.command,
            commandStatus: data.command ? 'pending' : undefined,
          });
          setLoading(sessionId, false);
          
          // 自动模式下执行命令
          if (data.command && operationMode === 'auto') {
            executeCommandAndWaitForOutput(data.command);
          }
        }
      });

      // 保存 unlisten 引用，用于停止时取消
      unlistenRef.current = unlisten;

      // 调用流式 API
      await invoke('ai_chat_stream', {
        providerId: activeProvider.id,
        message: trimmedInput,
        sessionId,
        history,
      });

    } catch (err: any) {
      updateMessage(sessionId, assistantMessageId, {
        content: `❌ AI 请求失败: ${err.toString()}`,
      });
      setLoading(sessionId, false);
    } finally {
      // 清理事件监听（延迟一下确保最后的事件被处理）
      setTimeout(() => {
        if (unlistenRef.current) {
          unlistenRef.current();
          unlistenRef.current = null;
        }
      }, 1000);
    }
  };

  // 执行命令并持续监听输出，直到命令完成
  const executeCommandAndWaitForOutput = async (command: string) => {
    // 导入持续监听相关的配置
    const { 
      detectCommandComplete, 
      detectInteractiveProgram,
      POLLING_INTERVAL, 
      MAX_WAIT_TIME, 
      MIN_EXECUTION_TIME 
    } = await import('@/stores/terminalOutputStore');
    
    // 检测是否处于交互式程序中（如 less, more, vim 等）
    const currentOutput = getOutput(sessionId);
    const exitKey = detectInteractiveProgram(currentOutput);
    
    if (exitKey) {
      console.log('[AI] 检测到交互式程序，发送退出按键:', JSON.stringify(exitKey));
      // 先发送退出按键
      onExecuteCommand(exitKey);
      // 等待程序退出
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // 清空之前的输出缓冲区
    clearOutput(sessionId);
    
    // 记录等待的命令
    setPendingCommand(sessionId, command);
    
    console.log('[AI] 执行命令:', command);
    
    // 执行命令
    onExecuteCommand(command);
    
    // 立即设置等待输出状态，给用户即时反馈
    setWaitingForOutput(sessionId, true);
    
    // 更新命令状态
    const updatedMessages = getMessages(sessionId);
    const lastMessage = updatedMessages[updatedMessages.length - 1];
    if (lastMessage) {
      updateMessage(sessionId, lastMessage.id, { commandStatus: 'executed' });
    }
    
    // 持续监听输出，直到命令完成
    const startTime = Date.now();
    let lastOutputLength = 0;
    let lastOutputTime = Date.now();
    let output = '';
    let echoDetected = false;
    let echoTime = 0;
    
    // 首先等待初始输出
    await new Promise(resolve => setTimeout(resolve, COMMAND_OUTPUT_TIMEOUT));
    
    // 轮询检查命令是否完成
    while (Date.now() - startTime < MAX_WAIT_TIME) {
      output = getOutput(sessionId);
      const currentLength = output.length;
      
      // 检测是否有新输出
      if (currentLength > lastOutputLength) {
        lastOutputLength = currentLength;
        lastOutputTime = Date.now();
      }
      
      // 步骤 1: 先等待命令回显（确认命令已发送到服务器）
      if (!echoDetected) {
        if (isCommandEchoed(output, command)) {
          echoDetected = true;
          echoTime = Date.now();
          console.log('[AI] 检测到命令回显，开始等待执行完成');
        } else {
          // 命令回显超时检测（5秒）
          if (Date.now() - startTime > 5000) {
            console.log('[AI] 命令回显超时，但继续等待输出');
            echoDetected = true;
            echoTime = Date.now();
          }
          await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));
          continue;
        }
      }
      
      // 步骤 2: 确保至少经过 MIN_EXECUTION_TIME
      const elapsedSinceEcho = Date.now() - echoTime;
      if (elapsedSinceEcho < MIN_EXECUTION_TIME) {
        await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));
        continue;
      }
      
      // 步骤 3: 检查命令是否完成 - 区分快速命令和长命令
      const timeSinceLastOutput = Date.now() - lastOutputTime;
      const hasNewPrompt = detectNewPromptLine(output);
      const hasTraditionalPrompt = detectCommandComplete(output);
      const hasPrompt = hasNewPrompt || hasTraditionalPrompt;
      
      // 策略1: 快速命令 - 检测到提示符且短暂静止即可完成
      if (hasPrompt && timeSinceLastOutput > QUICK_COMPLETE_THRESHOLD && currentLength > 0) {
        console.log('[AI] 快速命令完成检测:', { 
          hasNewPrompt, 
          hasTraditionalPrompt,
          outputLength: currentLength,
          idleTime: timeSinceLastOutput,
          totalTime: Date.now() - startTime
        });
        break;
      }
      
      // 策略2: 长命令 - 输出长时间静止但没有检测到提示符
      if (!hasPrompt && timeSinceLastOutput > LONG_IDLE_THRESHOLD && currentLength > 0) {
        const lines = output.split('\n').filter(l => l.trim());
        const lastLine = lines[lines.length - 1] || '';
        console.log('[AI] 长命令静止完成 (提示符未检测到):', {
          outputLength: currentLength,
          idleTime: timeSinceLastOutput,
          lastLine: lastLine.substring(0, 100)
        });
        break;
      }
      
      // 等待一段时间后继续检查
      await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));
    }
    
    // 获取最终输出
    output = getOutput(sessionId);
    clearPendingCommand(sessionId);
    
    // 关闭等待输出状态
    setWaitingForOutput(sessionId, false);
    
    console.log('[AI] 命令执行完成，输出长度:', output.length, '耗时:', Date.now() - startTime, 'ms');
    
    // 如果有输出，发送给 AI 分析
    if (output && output.trim().length > 50) {
      await sendOutputToAI(command, output);
    }
  };

  
  // 发送命令输出给 AI 分析（流式）
  const sendOutputToAI = async (command: string, output: string) => {
    const activeProvider = await ensureActiveProvider();
    if (!activeProvider) return;

    setLoading(sessionId, true);

    // 截取输出，避免过长
    const truncatedOutput = output.length > 4000 
      ? output.slice(-4000) + '\n... (输出过长已截断)' 
      : output;

    // 先添加空消息
    addMessage(sessionId, {
      role: 'assistant',
      content: '',
    });

    const allMessages = getMessages(sessionId);
    const assistantMessageId = allMessages[allMessages.length - 1].id;
    let fullContent = '';
    let unlisten: UnlistenFn | null = null;

    try {
      // 获取历史消息（排除刚添加的空消息）
      const history = allMessages.slice(0, -1).map(m => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content
      }));

      // 设置事件监听
      unlisten = await listen<StreamEvent>(`ai-stream-${sessionId}`, (event) => {
        const data = event.payload;
        
        if (data.error) {
          updateMessage(sessionId, assistantMessageId, {
            content: `❌ ${data.error}`,
          });
          setLoading(sessionId, false);
          return;
        }

        if (data.chunk) {
          fullContent += data.chunk;
          updateMessage(sessionId, assistantMessageId, {
            content: fullContent,
          });
        }

        if (data.done) {
          updateMessage(sessionId, assistantMessageId, {
            content: fullContent,
            command: data.command,
            commandStatus: data.command ? 'pending' : undefined,
          });
          setLoading(sessionId, false);

          // 自动执行新命令
          if (data.command && operationMode === 'auto') {
            executeCommandAndWaitForOutput(data.command);
          }
        }
      });

      // 调用流式 API
      await invoke('ai_chat_stream', {
        providerId: activeProvider.id,
        message: `命令 "${command}" 的执行结果如下，请分析并告诉我关键信息：\n\n\`\`\`\n${truncatedOutput}\n\`\`\``,
        sessionId,
        history,
      });

    } catch (err: any) {
      updateMessage(sessionId, assistantMessageId, {
        content: `❌ AI 分析失败: ${err.toString()}`,
      });
      setLoading(sessionId, false);
    } finally {
      setTimeout(() => {
        unlisten?.();
      }, 1000);
    }
  };

  // 处理命令执行（确认模式）
  const handleExecuteCommand = async (message: ChatMessage) => {
    if (!message.command) return;
    await executeCommandAndWaitForOutput(message.command);
  };

  // 拒绝命令
  const handleRejectCommand = (message: ChatMessage) => {
    updateMessage(sessionId, message.id, { commandStatus: 'rejected' });
  };

  // 处理键盘事件
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // 停止当前对话（中断 AI 请求）
  const stopCurrentChat = () => {
    // 取消事件监听
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    // 重置加载状态
    setLoading(sessionId, false);
    setWaitingForOutput(sessionId, false);
    // 清除待执行的命令
    clearPendingCommand(sessionId);
    console.log('[AI] 用户停止了当前对话');
  };

  // 新建对话（停止当前 + 清空历史）
  const handleNewChat = () => {
    stopCurrentChat();
    useChatStore.getState().clearSession(sessionId);
    console.log('[AI] 新建对话');
  };

  return (
    <div className="h-full flex flex-col bg-surface-50 dark:bg-surface-900 transition-colors duration-300">
      {/* 头部 */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-surface-200 dark:border-surface-800 flex-shrink-0 transition-colors duration-300">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-primary-600 dark:text-primary-400" />
          <span className="text-sm font-medium text-surface-700 dark:text-surface-200">AI 助手</span>
        </div>
        
        <div className="flex items-center gap-2">
          {/* 操作模式切换 */}
          <button
            onClick={toggleOperationMode}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
              operationMode === 'auto'
                ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400 hover:bg-amber-500/30'
                : 'bg-surface-200 dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:bg-surface-300 dark:hover:bg-surface-700 hover:text-surface-900 dark:hover:text-surface-200'
            }`}
            title={operationMode === 'auto' ? '自动执行模式' : '确认执行模式'}
          >
            {operationMode === 'auto' ? (
              <>
                <Zap className="w-3 h-3" />
                自动
              </>
            ) : (
              <>
                <Sparkles className="w-3 h-3" />
                确认
              </>
            )}
          </button>
          
          {/* 新建对话按钮 */}
          <button
            onClick={handleNewChat}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium
                       bg-surface-200 dark:bg-surface-800 text-surface-600 dark:text-surface-400 
                       hover:bg-surface-300 dark:hover:bg-surface-700 hover:text-surface-900 dark:hover:text-surface-200 transition-colors"
            title="新建对话（停止当前并清空）"
          >
            <Plus className="w-3.5 h-3.5" />
            新对话
          </button>

          {/* 停止按钮 - 仅在加载或等待输出时显示 */}
          {(isLoading || isWaitingForOutput) && (
            <button
              onClick={stopCurrentChat}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium
                         bg-red-500/10 text-red-600 dark:text-red-400 
                         hover:bg-red-500/20 transition-colors"
              title="停止当前操作"
            >
              <StopCircle className="w-3.5 h-3.5" />
              停止
            </button>
          )}
        </div>
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 no-scrollbar">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-surface-400 dark:text-surface-500">
            <Sparkles className="w-10 h-10 mb-4 opacity-40" />
            <p className="text-sm text-center">
              输入问题或指令
              <br />
              AI 将帮助你操作终端
            </p>
          </div>
        ) : (
          messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              operationMode={operationMode}
              onExecute={() => handleExecuteCommand(message)}
              onReject={() => handleRejectCommand(message)}
            />
          ))
        )}
        
        {/* 等待输出状态 */}
        {isWaitingForOutput && (
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">⏳ 正在等待命令执行完成...</span>
          </div>
        )}
        
        {/* AI 思考状态 */}
        {isLoading && (
          <div className="flex items-center gap-2 text-surface-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">AI 正在思考...</span>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      {/* 输入区域 */}
      <div className="p-2 border-t border-surface-200 dark:border-surface-800 flex-shrink-0 transition-colors duration-300">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="输入指令或问题... (Shift+Enter 换行, Enter 发送)"
            className="flex-1 min-h-10 bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg px-3 py-2
                       text-sm text-surface-900 dark:text-surface-100 placeholder-surface-400 dark:placeholder-surface-500 resize-none
                       focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500
                       transition-colors"
            rows={1}
            disabled={isLoading}
          />
          <button
            onClick={handleSendMessage}
            disabled={!input.trim() || isLoading}
            className="px-4 bg-primary-600 hover:bg-primary-500 disabled:bg-surface-200 dark:disabled:bg-surface-700 
                        disabled:text-surface-400 dark:disabled:text-surface-500 text-white rounded-lg transition-colors
                        h-10 flex items-center justify-center"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// 消息气泡组件
interface MessageBubbleProps {
  message: ChatMessage;
  operationMode: 'confirm' | 'auto';
  onExecute: () => void;
  onReject: () => void;
}

function MessageBubble({ message, operationMode, onExecute, onReject }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  
  // 简单的消息内容格式化
  const formatContent = (content: string) => {
    // 移除末尾的 bash 代码块（因为命令已经单独显示）
    let cleaned = content.replace(/```(?:bash|shell|sh)\n[\s\S]*?```\s*$/i, '').trim();
    // 移除末尾的 json 代码块
    cleaned = cleaned.replace(/```(?:json|JSON)\n[\s\S]*?```\s*$/i, '').trim();
    return cleaned;
  };

  const displayContent = formatContent(message.content);
  
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-full rounded-lg px-3 py-2 ${
          isUser
            ? 'bg-primary-100 text-primary-900 dark:bg-primary-500/20 dark:text-primary-100'
            : isSystem
            ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300 text-sm'
            : 'bg-white text-surface-800 shadow-sm border border-surface-200 dark:bg-surface-800 dark:text-surface-200 dark:border-transparent dark:shadow-none'
        }`}
      >
        {/* 消息内容 */}
        <div className="text-sm leading-relaxed overflow-hidden">
          <ReactMarkdown 
            remarkPlugins={[remarkGfm]}
            components={{
              // 链接
              a: ({node, ...props}: any) => (
                <a {...props} className="text-primary-600 dark:text-primary-400 hover:text-primary-500 dark:hover:text-primary-300 underline underline-offset-2" target="_blank" rel="noopener noreferrer" />
              ),
              // 段落
              p: ({node, ...props}: any) => <p {...props} className="mb-2 last:mb-0" />,
              // 列表
              ul: ({node, ...props}: any) => <ul {...props} className="list-disc list-inside mb-2 space-y-1" />,
              ol: ({node, ...props}: any) => <ol {...props} className="list-decimal list-inside mb-2 space-y-1" />,
              li: ({node, ...props}: any) => <li {...props} className="ml-1" />,
              // 标题
              h1: ({node, ...props}: any) => <h1 {...props} className="text-lg font-bold mb-2 mt-4 first:mt-0" />,
              h2: ({node, ...props}: any) => <h2 {...props} className="text-base font-bold mb-2 mt-3 first:mt-0" />,
              h3: ({node, ...props}: any) => <h3 {...props} className="text-sm font-bold mb-1 mt-2 first:mt-0" />,
              // 代码块
              code: ({node, className, children, ...props}: any) => {
                const match = /language-(\w+)/.exec(className || '');
                const isInline = !match && !String(children).includes('\n');
                return isInline ? (
                  <code {...props} className="bg-surface-100 dark:bg-black/20 px-1.5 py-0.5 rounded text-xs font-mono text-primary-700 dark:text-primary-200 border border-surface-200 dark:border-transparent break-all">
                    {children}
                  </code>
                ) : (
                  <div className="relative group my-2">
                    <pre {...props} className="bg-surface-50 dark:bg-black/30 p-3 rounded-lg overflow-x-auto text-xs font-mono text-surface-800 dark:text-surface-200 border border-surface-200 dark:border-surface-700/50">
                      <code className={className || ''}>
                        {children}
                      </code>
                    </pre>
                  </div>
                );
              },
              // 引用
              blockquote: ({node, ...props}: any) => (
                <blockquote {...props} className="border-l-2 border-primary-500/50 pl-3 italic text-surface-500 dark:text-surface-400 my-2" />
              ),
              // 表格
              table: ({node, ...props}: any) => (
                <div className="overflow-x-auto my-2 border border-surface-200 dark:border-surface-700/50 rounded-lg">
                  <table {...props} className="w-full text-left text-xs" />
                </div>
              ),
              thead: ({node, ...props}: any) => <thead {...props} className="bg-surface-100 dark:bg-surface-900/50 text-surface-600 dark:text-surface-300" />,
              tbody: ({node, ...props}: any) => <tbody {...props} className="divide-y divide-surface-200 dark:divide-surface-700/30" />,
              tr: ({node, ...props}: any) => <tr {...props} className="hover:bg-surface-50 dark:hover:bg-surface-700/10 transition-colors" />,
              th: ({node, ...props}: any) => <th {...props} className="p-2 font-medium whitespace-nowrap" />,
              td: ({node, ...props}: any) => <td {...props} className="p-2 whitespace-nowrap" />,
            }}
          >
            {displayContent}
          </ReactMarkdown>
        </div>
        
        {/* 命令显示 */}
        {message.command && (
          <div className="mt-2 pt-2 border-t border-surface-200 dark:border-surface-700/50">
            <div className="flex items-center gap-2 mb-2">
              <code className="flex-1 bg-surface-100 dark:bg-surface-950/50 px-2 py-1 rounded text-xs text-green-600 dark:text-green-400 font-mono border border-surface-200 dark:border-transparent whitespace-pre-wrap break-all">
                $ {message.command}
              </code>
              
              {/* 命令状态 */}
              {message.commandStatus === 'executed' && (
                <span className="text-xs text-green-600 dark:text-green-400 flex-shrink-0">✓ 已执行</span>
              )}
              {message.commandStatus === 'rejected' && (
                <span className="text-xs text-red-600 dark:text-red-400 flex-shrink-0">✗ 已拒绝</span>
              )}
            </div>
            
            {/* 确认模式下显示操作按钮 */}
            {message.commandStatus === 'pending' && operationMode === 'confirm' && (
              <div className="flex gap-2">
                <button
                  onClick={onExecute}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1 
                             bg-green-500/10 hover:bg-green-500/20 text-green-600 dark:text-green-400 
                             rounded text-xs transition-colors"
                >
                  <Play className="w-3 h-3" />
                  执行
                </button>
                <button
                  onClick={onReject}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1 
                             bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 
                             rounded text-xs transition-colors"
                >
                  <X className="w-3 h-3" />
                  取消
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
