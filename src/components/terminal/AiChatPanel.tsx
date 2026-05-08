import { useState, useRef, useEffect } from 'react';
import { Send, Play, X, Sparkles, Zap, Loader2, Bot, StopCircle, Plus } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChatStore } from '@/stores/chatStore';
import { useProviderStore } from '@/stores/providerStore';
import { 
  useTerminalOutputStore, 
  POLLING_INTERVAL,
  MAX_WAIT_TIME,
  LONG_IDLE_THRESHOLD,
  MIN_EXECUTION_TIME,
  buildInstrumentedCommand,
  createCommandMarkerId,
  detectNewPromptLine,
  detectNetworkPromptLine,
  detectInteractiveProgram,
  parseInstrumentedCommandOutput,
  stripPlainCommandOutput,
} from '@/stores/terminalOutputStore';
import type { AiFileWrite, AiFileWriteMode, ChatMessage, DeviceProfile } from '@/types';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useThemeStore } from '@/stores/themeStore';

// 流式事件数据结构
interface StreamEvent {
  chunk?: string;
  done: boolean;
  error?: string;
  command?: string;
  fileWrite?: AiFileWrite;
}

interface AiChatPanelProps {
  sessionId: string;
  deviceType?: 'linux' | 'network';
  deviceProfile?: DeviceProfile;
  // 执行命令到终端的回调
  onExecuteCommand: (command: string, options?: { appendNewline?: boolean }) => void;
}

const MAX_INPUT_LINES = 5;
const TERMINAL_CONTEXT_TAIL_LENGTH = 3000;
const PROMPT_COMPLETION_GRACE_MS = 1000;
const MAX_AUTO_CHAIN_COMMANDS = 100;
const MAX_AUTO_FORMAT_REPAIR_ATTEMPTS = 1;
const TASK_SUMMARY_COMPRESS_THRESHOLD = 16000;
const TASK_SUMMARY_TARGET_LENGTH = 6000;
const TASK_SUMMARY_EMERGENCY_LIMIT = 80000;
const COMMAND_OUTPUT_SUMMARY_TAIL_LENGTH = 1600;
const COMMAND_OUTPUT_CONTEXT_LIMIT = 600000;
const NETWORK_PROMPT_FALLBACK_IDLE_MS = Math.max(30000, LONG_IDLE_THRESHOLD);
const NETWORK_PAGER_ADVANCE_INTERVAL_MS = 800;

interface AiChatResponse {
  content: string;
  command?: string;
  fileWrite?: AiFileWrite;
}

interface AutoCommandChain {
  commands: string[];
  count: number;
}

const getFileWriteMode = (fileWrite: AiFileWrite): AiFileWriteMode => {
  return fileWrite.mode || 'overwrite';
};

const getFileWriteOperationLabel = (fileWrite: AiFileWrite) => {
  switch (getFileWriteMode(fileWrite)) {
    case 'append':
      return '追加';
    case 'replace':
      return '替换';
    case 'insert_after':
      return '后插入';
    case 'insert_before':
      return '前插入';
    case 'overwrite':
    default:
      return '覆盖写入';
  }
};

const getFileWriteButtonLabel = (fileWrite: AiFileWrite) => {
  switch (getFileWriteMode(fileWrite)) {
    case 'append':
      return '追加文件';
    case 'replace':
    case 'insert_after':
    case 'insert_before':
      return '更新文件';
    case 'overwrite':
    default:
      return '写入文件';
  }
};

const buildInsertedContent = (current: string, position: number, insertion: string) => {
  const before = current.slice(0, position);
  const after = current.slice(position);
  let normalizedInsertion = insertion;

  if (before && normalizedInsertion && !before.endsWith('\n') && !normalizedInsertion.startsWith('\n')) {
    normalizedInsertion = `\n${normalizedInsertion}`;
  }
  if (after && normalizedInsertion && !normalizedInsertion.endsWith('\n') && !after.startsWith('\n')) {
    normalizedInsertion = `${normalizedInsertion}\n`;
  }

  return `${before}${normalizedInsertion}${after}`;
};

const applyFileUpdate = (current: string, fileWrite: AiFileWrite) => {
  const mode = getFileWriteMode(fileWrite);

  if (mode === 'replace') {
    const oldContent = fileWrite.oldContent;
    if (!oldContent) {
      throw new Error('replace 更新缺少 oldContent，无法定位要替换的内容');
    }

    const index = current.indexOf(oldContent);
    if (index < 0) {
      throw new Error('没有在远程文件中找到 oldContent，已停止更新以避免误改');
    }

    return `${current.slice(0, index)}${fileWrite.content}${current.slice(index + oldContent.length)}`;
  }

  if (mode === 'insert_after' || mode === 'insert_before') {
    const anchor = fileWrite.anchor;
    if (!anchor) {
      throw new Error(`${mode} 更新缺少 anchor，无法定位插入位置`);
    }

    const anchorIndex = current.indexOf(anchor);
    if (anchorIndex < 0) {
      throw new Error('没有在远程文件中找到 anchor，已停止更新以避免误改');
    }

    const insertPosition = mode === 'insert_after' ? anchorIndex + anchor.length : anchorIndex;
    return buildInsertedContent(current, insertPosition, fileWrite.content);
  }

  return fileWrite.content;
};

const formatFileWritePreview = (fileWrite: AiFileWrite) => {
  const mode = getFileWriteMode(fileWrite);

  if (mode === 'replace') {
    return [
      '[替换目标]',
      fileWrite.oldContent || '(未提供 oldContent)',
      '',
      '[替换为]',
      fileWrite.content || '(空内容)',
    ].join('\n');
  }

  if (mode === 'insert_after' || mode === 'insert_before') {
    return [
      mode === 'insert_after' ? '[插入到此内容之后]' : '[插入到此内容之前]',
      fileWrite.anchor || '(未提供 anchor)',
      '',
      '[新增内容]',
      fileWrite.content || '(空内容)',
    ].join('\n');
  }

  if (mode === 'append') {
    return ['[追加内容]', fileWrite.content || '(空内容)'].join('\n');
  }

  return fileWrite.content || '(空文件)';
};

const isMissingRemoteFileError = (err: unknown) => {
  return /no such file|not found|does not exist|不存在|NoSuchFile|SSH_FX_NO_SUCH_FILE/i.test(
    String(err)
  );
};

const NETWORK_FILE_WRITE_UNSUPPORTED_MESSAGE =
  '网络设备不支持通过 SFTP 创建或修改文件，请改用设备 CLI 命令完成配置。';

function buildCommandOutputContext(output: string) {
  if (output.length <= COMMAND_OUTPUT_CONTEXT_LIMIT) {
    return {
      text: output,
      truncated: false,
    };
  }

  const headLength = Math.floor(COMMAND_OUTPUT_CONTEXT_LIMIT * 0.25);
  const tailLength = COMMAND_OUTPUT_CONTEXT_LIMIT - headLength;
  const omittedLength = output.length - headLength - tailLength;

  return {
    text: [
      `[输出过长，以下只包含开头 ${headLength} 字符和结尾 ${tailLength} 字符，中间 ${omittedLength} 字符已省略。不要把省略部分当成无异常，也不要声称已经完整检查所有对象。]`,
      '',
      '[输出开头]',
      output.slice(0, headLength),
      '',
      `[中间省略 ${omittedLength} 字符]`,
      '',
      '[输出结尾]',
      output.slice(-tailLength),
    ].join('\n'),
    truncated: true,
  };
}

export function AiChatPanel({
  sessionId,
  deviceType = 'linux',
  deviceProfile = 'auto',
  onExecuteCommand,
}: AiChatPanelProps) {
  const [input, setInput] = useState('');
  const [elapsedTick, setElapsedTick] = useState(Date.now());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 用于中断当前 AI 请求的事件监听器引用
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const activeCommandRef = useRef<{
    markerId: string;
    command: string;
    messageId?: string;
    cancelled: boolean;
  } | null>(null);
  const autoCommandChainRef = useRef<AutoCommandChain>({
    commands: [],
    count: 0,
  });
  const autoFormatRepairAttemptsRef = useRef(0);
  const activeTaskGoalRef = useRef<string | null>(null);
  const activeTaskSummaryRef = useRef('');
  const summaryCompressionInFlightRef = useRef(false);
  
  const { 
    getMessages, 
    addMessage, 
    updateMessage,
    setLoading,
    setWaitingForOutput,
    getTaskMemory,
    setTaskMemory,
    operationMode, 
    toggleOperationMode 
  } = useChatStore();
  
  const { getActiveProvider, fetchProviders } = useProviderStore();
  // 订阅主题变更，确保组件重渲染（虽然主要依赖 CSS，但这样更稳健）
  const { theme } = useThemeStore();
  const fileWriteSupported = deviceType !== 'network';
  const initialFileStatusFor = (fileWrite?: AiFileWrite): ChatMessage['fileStatus'] => {
    if (!fileWrite) return undefined;
    return fileWriteSupported ? 'pending' : 'unsupported';
  };
  
  useEffect(() => {
    console.log('[AiChatPanel] Theme updated:', theme);
  }, [theme]);

  useEffect(() => {
    const memory = getTaskMemory(sessionId);
    activeTaskGoalRef.current = memory.goal;
    activeTaskSummaryRef.current = memory.summary;
  }, [sessionId, getTaskMemory]);

  const closeActiveStreamListener = () => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
  };

  const normalizeCommandForLoopGuard = (command: string) => {
    return command.replace(/\s+/g, ' ').trim();
  };

  const resetAutoCommandChain = () => {
    autoCommandChainRef.current = {
      commands: [],
      count: 0,
    };
    autoFormatRepairAttemptsRef.current = 0;
  };

  const resetTaskMemory = (goal: string | null = null) => {
    activeTaskGoalRef.current = goal;
    const summary = goal ? `当前任务目标：${goal}` : '';
    activeTaskSummaryRef.current = summary;
    setTaskMemory(sessionId, { goal, summary });
  };

  const initializeTaskMemoryIfEmpty = (goal: string | null = null) => {
    const nextGoal = activeTaskGoalRef.current || goal?.trim() || null;
    if (!nextGoal) return;

    activeTaskGoalRef.current = nextGoal;
    if (!activeTaskSummaryRef.current.trim()) {
      activeTaskSummaryRef.current = `当前任务目标：${nextGoal}`;
    }

    setTaskMemory(sessionId, {
      goal: activeTaskGoalRef.current,
      summary: activeTaskSummaryRef.current,
    });
  };

  const getLatestUserGoalBeforeMessage = (messageId?: string) => {
    const sessionMessages = getMessages(sessionId);
    const endIndex = messageId
      ? sessionMessages.findIndex((message) => message.id === messageId)
      : sessionMessages.length;
    const searchEndIndex = endIndex >= 0 ? endIndex : sessionMessages.length;

    for (let index = searchEndIndex - 1; index >= 0; index -= 1) {
      const message = sessionMessages[index];
      if (message.role === 'user' && message.content.trim()) {
        return message.content.trim();
      }
    }

    return null;
  };

  const registerAutoCommand = (command: string) => {
    const normalizedCommand = normalizeCommandForLoopGuard(command);
    const chain = autoCommandChainRef.current;

    if (chain.commands.includes(normalizedCommand)) {
      return {
        allowed: false,
        reason: `检测到 AI 重复建议同一条命令，已停止自动执行以避免循环：${command}`,
      };
    }

    if (chain.count >= MAX_AUTO_CHAIN_COMMANDS) {
      return {
        allowed: false,
        reason: `本轮任务已连续自动执行 ${MAX_AUTO_CHAIN_COMMANDS} 条命令，已暂停以避免循环。`,
      };
    }

    chain.commands.push(normalizedCommand);
    chain.count += 1;
    return { allowed: true };
  };

  const persistTaskMemory = () => {
    setTaskMemory(sessionId, {
      goal: activeTaskGoalRef.current,
      summary: activeTaskSummaryRef.current,
    });
  };

  const compressTaskSummaryIfNeeded = async () => {
    const summarySnapshot = activeTaskSummaryRef.current.trim();
    if (
      summaryCompressionInFlightRef.current ||
      summarySnapshot.length <= TASK_SUMMARY_COMPRESS_THRESHOLD
    ) {
      return;
    }

    const activeProvider = await ensureActiveProvider();
    if (!activeProvider) return;

    summaryCompressionInFlightRef.current = true;

    try {
      const result = await invoke<AiChatResponse>('ai_chat', {
        providerId: activeProvider.id,
        sessionId,
        history: [],
        deviceType,
        deviceProfile,
        message: [
          '请将下面的 AI 终端任务记忆压缩成结构化摘要，供后续多轮 SSH 排查继续使用。',
          `目标长度：${TASK_SUMMARY_TARGET_LENGTH} 字以内；如果确实有必要，可以略微超过，但不要丢失关键事实。`,
          '必须保留：用户原始目标、已经确认的事实、账号/密码/路径/服务名、成功命令、失败命令和原因、下一步待办。',
          '必须合并：重复命令、重复输出、同一服务的多次检查结果。',
          '删除：无关日志、冗余解释、完整长输出，只保留结论和必要片段。',
          '请按以下结构输出：',
          '## 任务目标',
          '## 已确认事实',
          '## 已获取的关键信息',
          '## 已执行命令与结果',
          '## 失败或无效尝试',
          '## 下一步',
          '只输出摘要正文，不要输出 JSON command，不要建议新命令。',
          '',
          '待压缩任务记忆：',
          '```',
          summarySnapshot,
          '```',
        ].join('\n'),
      });

      const compressedSummary = result.content.trim();
      if (!compressedSummary) return;

      const currentSummary = activeTaskSummaryRef.current;
      if (currentSummary === summarySnapshot) {
        activeTaskSummaryRef.current = compressedSummary;
      } else if (currentSummary.startsWith(summarySnapshot)) {
        const delta = currentSummary.slice(summarySnapshot.length).trim();
        activeTaskSummaryRef.current = delta
          ? `${compressedSummary}\n\n${delta}`
          : compressedSummary;
      } else {
        activeTaskSummaryRef.current = compressedSummary;
      }

      persistTaskMemory();
    } catch (err) {
      console.warn('[AiChatPanel] 压缩任务摘要失败，保留未压缩摘要:', err);
      if (activeTaskSummaryRef.current.length > TASK_SUMMARY_EMERGENCY_LIMIT) {
        activeTaskSummaryRef.current = [
          '## 摘要压缩暂时失败',
          '下面是最近的任务记忆片段。再次收到命令结果后会继续尝试 AI 压缩。',
          '',
          activeTaskSummaryRef.current.slice(-TASK_SUMMARY_EMERGENCY_LIMIT),
        ].join('\n');
        persistTaskMemory();
      }
    } finally {
      summaryCompressionInFlightRef.current = false;
    }
  };

  const appendTaskSummary = (entry: string) => {
    const normalizedEntry = entry.replace(/\n{3,}/g, '\n\n').trim();
    if (!normalizedEntry) return;

    const currentSummary = activeTaskSummaryRef.current.trim();
    const nextSummary = currentSummary
      ? `${currentSummary}\n\n${normalizedEntry}`
      : normalizedEntry;

    activeTaskSummaryRef.current = nextSummary;
    persistTaskMemory();
    void compressTaskSummaryIfNeeded();
  };

  const executeAutoCommand = (command: string, messageId: string) => {
    const result = registerAutoCommand(command);

    if (!result.allowed) {
      addMessage(sessionId, {
        role: 'system',
        content: result.reason || '已暂停自动执行。',
      });
      return;
    }

    executeCommandAndWaitForOutput(command, messageId);
  };

  const executeFileWrite = async (fileWrite: AiFileWrite, messageId: string) => {
    const mode = getFileWriteMode(fileWrite);
    const operationLabel = getFileWriteOperationLabel(fileWrite);

    if (!fileWriteSupported) {
      updateMessage(sessionId, messageId, { fileStatus: 'unsupported' });
      addMessage(sessionId, {
        role: 'system',
        content: `${NETWORK_FILE_WRITE_UNSUPPORTED_MESSAGE}\n目标路径：${fileWrite.path}`,
      });
      appendTaskSummary([
        `文件${operationLabel}：${fileWrite.path}`,
        '结果：已阻止',
        NETWORK_FILE_WRITE_UNSUPPORTED_MESSAGE,
      ].join('\n'));
      return;
    }

    updateMessage(sessionId, messageId, { fileStatus: 'writing' });

    try {
      if (mode === 'append') {
        await invoke('sftp_append_file', {
          sessionId,
          path: fileWrite.path,
          content: fileWrite.content,
          ensureNewline: fileWrite.ensureNewline ?? !fileWrite.content.startsWith('\n'),
        });
      } else if (mode === 'overwrite') {
        await invoke('sftp_write_file', {
          sessionId,
          path: fileWrite.path,
          content: fileWrite.content,
        });
      } else {
        let currentContent = '';
        let creatingMissingFile = false;

        try {
          currentContent = await invoke<string>('sftp_read_file', {
            sessionId,
            path: fileWrite.path,
          });
        } catch (err) {
          if (!fileWrite.createIfMissing || !isMissingRemoteFileError(err)) {
            throw err;
          }
          creatingMissingFile = true;
        }

        const nextContent = creatingMissingFile
          ? fileWrite.content
          : applyFileUpdate(currentContent, fileWrite);

        await invoke('sftp_write_file', {
          sessionId,
          path: fileWrite.path,
          content: nextContent,
        });
      }
    } catch (err: any) {
      updateMessage(sessionId, messageId, { fileStatus: 'failed' });
      addMessage(sessionId, {
        role: 'system',
        content: `${operationLabel}文件失败：${fileWrite.path}\n${err.toString()}`,
      });
      return;
    }

    updateMessage(sessionId, messageId, { fileStatus: 'completed' });
    addMessage(sessionId, {
      role: 'system',
      content: `已${operationLabel}文件：${fileWrite.path}`,
    });
    appendTaskSummary([
      `文件${operationLabel}：${fileWrite.path}`,
      '结果：成功',
      `片段长度：${fileWrite.content.length} 字符`,
    ].join('\n'));
    await sendOutputToAI(
      `${mode}_file ${fileWrite.path}`,
      [
        `文件已${operationLabel}：${fileWrite.path}`,
        `更新片段长度：${fileWrite.content.length} 字符`,
      ].join('\n'),
      0
    );
  };
  
  // 终端输出管理
  const { 
    getOutput, 
    clearOutput, 
    setPendingCommand, 
    getPendingCommand,
    clearPendingCommand 
  } = useTerminalOutputStore();
  
  const messages = getMessages(sessionId);
  const isLoading = useChatStore((state) => 
    state.sessions.get(sessionId)?.isLoading || false
  );
  const isWaitingForOutput = useChatStore((state) => 
    state.sessions.get(sessionId)?.waitingForOutput || false
  );
  const pendingCommand = useTerminalOutputStore((state) =>
    state.pendingCommands.get(sessionId)
  );

  useEffect(() => {
    if (!isWaitingForOutput) return;

    setElapsedTick(Date.now());
    const timer = window.setInterval(() => setElapsedTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isWaitingForOutput]);

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

  const formatElapsed = (ms: number) => {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes <= 0) return `${seconds}s`;
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  };

  const shouldAttachTerminalContext = (userMessage: string) => {
    return /结果|输出|报错|错误|失败|没反应|没有反应|卡住|卡了|运行|执行|命令|进度|日志|terminal|shell|command|output|error/i.test(userMessage);
  };

  const buildMessageWithTerminalContext = (userMessage: string) => {
    const pending = getPendingCommand(sessionId);
    const outputTail = getOutput(sessionId).slice(-TERMINAL_CONTEXT_TAIL_LENGTH).trim();

    if (!pending && (!outputTail || !shouldAttachTerminalContext(userMessage))) {
      return userMessage;
    }

    const contextLines = ['[终端上下文]'];

    if (pending) {
      const elapsed = formatElapsed(Date.now() - pending.startTime);
      const completionSignal = pending.markerId ? '完成标记' : '设备提示符';
      contextLines.push(
        `当前命令仍在执行，尚未看到${completionSignal}。命令：${pending.command}`,
        `已运行：${elapsed}`,
        '如果用户询问结果或进度，请明确说明命令还没有结束，不要把暂无输出判断为执行完成。'
      );
    } else {
      contextLines.push(
        '下面是最近终端输出。若最后只有命令回显、没有新的 shell 提示符，可能表示命令仍在运行。'
      );
    }

    if (outputTail) {
      contextLines.push(`最近终端输出：\n\`\`\`\n${outputTail}\n\`\`\``);
    }

    return `${contextLines.join('\n')}\n\n用户问题：${userMessage}`;
  };

  const isThinkOnlyOrEmptyResponse = (content: string) => {
    const withoutThinkBlocks = content
      .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
      .replace(/<\/?think\b[^>]*>/gi, '')
      .trim();

    return withoutThinkBlocks.length === 0;
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
    resetAutoCommandChain();
    initializeTaskMemoryIfEmpty(trimmedInput);
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
      // 获取历史消息（排除刚添加的用户消息和空 assistant 占位，当前用户消息通过 message 单独发送）
      const history = allMessages.slice(0, -2).map(m => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content
      }));

      closeActiveStreamListener();

      let localUnlisten: UnlistenFn | null = null;
      const closeLocalStreamListener = () => {
        if (localUnlisten) {
          localUnlisten();
          if (unlistenRef.current === localUnlisten) {
            unlistenRef.current = null;
          }
          localUnlisten = null;
        }
      };

      // 设置事件监听
      localUnlisten = await listen<StreamEvent>(`ai-stream-${sessionId}`, (event) => {
        const data = event.payload;
        
        if (data.error) {
          // 收到错误
          updateMessage(sessionId, assistantMessageId, {
            content: `❌ ${data.error}`,
          });
          setLoading(sessionId, false);
          closeLocalStreamListener();
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
          closeLocalStreamListener();
          // 流结束，处理命令
          updateMessage(sessionId, assistantMessageId, {
            content: fullContent,
            command: data.command,
            commandStatus: data.command ? 'pending' : undefined,
            fileWrite: data.fileWrite,
            fileStatus: initialFileStatusFor(data.fileWrite),
          });
          setLoading(sessionId, false);
          
          // 自动模式下执行命令
          if (data.command && operationMode === 'auto') {
            autoFormatRepairAttemptsRef.current = 0;
            executeAutoCommand(data.command, assistantMessageId);
          }
          if (data.fileWrite && !fileWriteSupported) {
            addMessage(sessionId, {
              role: 'system',
              content: `${NETWORK_FILE_WRITE_UNSUPPORTED_MESSAGE}\n目标路径：${data.fileWrite.path}`,
            });
          }
          if (data.fileWrite && operationMode === 'auto' && fileWriteSupported) {
            void executeFileWrite(data.fileWrite, assistantMessageId);
          }
        }
      });

      // 保存 unlisten 引用，用于停止时取消
      unlistenRef.current = localUnlisten;

      // 调用流式 API
      await invoke('ai_chat_stream', {
        providerId: activeProvider.id,
        message: buildMessageWithTerminalContext(trimmedInput),
        sessionId,
        history,
        deviceType,
        deviceProfile,
      });

    } catch (err: any) {
      updateMessage(sessionId, assistantMessageId, {
        content: `❌ AI 请求失败: ${err.toString()}`,
      });
      setLoading(sessionId, false);
    } finally {
      closeActiveStreamListener();
    }
  };

  // 执行命令并持续监听输出，直到命令完成
  const executeCommandAndWaitForOutput = async (command: string, messageId?: string) => {
    const shouldInstrumentCommand = deviceType !== 'network';
    const markerId = shouldInstrumentCommand ? createCommandMarkerId() : '';
    const commandRun = {
      markerId,
      command,
      messageId,
      cancelled: false,
    };
    activeCommandRef.current = commandRun;

    // 检测是否处于交互式程序中（如 less, more, vim 等）
    const currentOutput = getOutput(sessionId);
    const exitKey = detectInteractiveProgram(currentOutput);
    
    if (exitKey) {
      console.log('[AI] 检测到交互式程序，发送退出按键:', JSON.stringify(exitKey));
      // 先发送退出按键
      onExecuteCommand(exitKey, { appendNewline: false });
      // 等待程序退出
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // 清空之前的输出缓冲区
    clearOutput(sessionId);
    
    // 记录等待的命令
    setPendingCommand(sessionId, command, shouldInstrumentCommand ? markerId : undefined);
    
    console.log('[AI] 执行命令:', command);
    
    // Linux shell 用完成标记拿退出码；网络设备 CLI 不支持 printf/$?，只能发原始命令并等提示符返回。
    onExecuteCommand(
      shouldInstrumentCommand ? buildInstrumentedCommand(command, markerId) : command
    );
    
    // 立即设置等待输出状态，给用户即时反馈
    setWaitingForOutput(sessionId, true);
    
    // 更新命令状态
    const targetMessageId = messageId || getMessages(sessionId).slice(-1)[0]?.id;
    if (targetMessageId) {
      updateMessage(sessionId, targetMessageId, { commandStatus: 'running' });
    }
    
    const startTime = Date.now();
    let lastOutputLength = 0;
    let lastOutputAt = startTime;
    let lastPagerAdvanceAt = 0;
    let output = '';
    let parsed = shouldInstrumentCommand
      ? parseInstrumentedCommandOutput('', markerId, command)
      : {
          started: true,
          completed: false,
          exitCode: undefined,
          output: '',
        };
    let timedOut = false;

    await new Promise(resolve => setTimeout(resolve, MIN_EXECUTION_TIME));

    try {
      while (Date.now() - startTime < MAX_WAIT_TIME) {
        if (commandRun.cancelled) {
          console.log('[AI] 命令等待被取消:', command);
          return;
        }

        output = getOutput(sessionId);
        if (output.length !== lastOutputLength) {
          lastOutputLength = output.length;
          lastOutputAt = Date.now();
        }

        parsed = shouldInstrumentCommand
          ? parseInstrumentedCommandOutput(output, markerId, command)
          : {
              started: true,
              completed: false,
              exitCode: undefined,
              output: stripPlainCommandOutput(output, command),
            };

        if (!shouldInstrumentCommand) {
          const interactiveKey = detectInteractiveProgram(output);
          if (
            interactiveKey === ' ' &&
            Date.now() - lastPagerAdvanceAt >= NETWORK_PAGER_ADVANCE_INTERVAL_MS
          ) {
            lastPagerAdvanceAt = Date.now();
            onExecuteCommand(interactiveKey, { appendNewline: false });
          }
        }

        const promptCompleted = shouldInstrumentCommand
          ? detectNewPromptLine(output)
          : detectNetworkPromptLine(output) || detectNewPromptLine(output);

        if (!parsed.completed && Date.now() - startTime >= PROMPT_COMPLETION_GRACE_MS && promptCompleted) {
          parsed = {
            ...parsed,
            completed: true,
          };
          console.warn('[AI] 终端已回到提示符，按完成处理:', command);
        }

        if (
          !shouldInstrumentCommand &&
          !parsed.completed &&
          parsed.output.trim() &&
          Date.now() - lastOutputAt >= NETWORK_PROMPT_FALLBACK_IDLE_MS &&
          !detectInteractiveProgram(output)
        ) {
          parsed = {
            ...parsed,
            completed: true,
          };
          console.warn('[AI] 网络设备命令未检测到提示符，但输出已稳定，按完成处理:', command);
        }

        if (parsed.completed) {
          console.log('[AI] 检测到命令完成标记:', {
            command,
            exitCode: parsed.exitCode,
            outputLength: parsed.output.length,
            totalTime: Date.now() - startTime,
          });
          break;
        }

        await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));
      }

      if (!parsed.completed) {
        timedOut = true;
      }
    } finally {
      if (activeCommandRef.current === commandRun) {
        activeCommandRef.current = null;
      }
      clearPendingCommand(sessionId);
      setWaitingForOutput(sessionId, false);
    }

    if (commandRun.cancelled) {
      if (targetMessageId) {
        updateMessage(sessionId, targetMessageId, { commandStatus: 'cancelled' });
      }
      return;
    }

    if (timedOut) {
      if (targetMessageId) {
        updateMessage(sessionId, targetMessageId, { commandStatus: 'timeout' });
      }
      addMessage(sessionId, {
        role: 'system',
        content: `命令仍未结束，已停止自动等待：${command}`,
      });
      return;
    }

    const commandStatus = parsed.exitCode === undefined || parsed.exitCode === 0 ? 'completed' : 'failed';
    if (targetMessageId) {
      updateMessage(sessionId, targetMessageId, { commandStatus });
    }

    console.log('[AI] 命令执行完成，输出长度:', parsed.output.length, '耗时:', Date.now() - startTime, 'ms');

    if (parsed.output.trim() || parsed.exitCode !== 0 || operationMode === 'auto') {
      await sendOutputToAI(command, parsed.output, parsed.exitCode);
    }
  };

  
  // 发送命令输出给 AI 分析（流式）
  const sendOutputToAI = async (
    command: string,
    output: string,
    exitCode?: number,
    repairAttempt = 0
  ) => {
    const activeProvider = await ensureActiveProvider();
    if (!activeProvider) return;

    initializeTaskMemoryIfEmpty(getLatestUserGoalBeforeMessage());
    const taskGoal = activeTaskGoalRef.current || getLatestUserGoalBeforeMessage();
    const taskSummary = activeTaskSummaryRef.current.trim();

    setLoading(sessionId, true);

    const commandOutputContext = buildCommandOutputContext(output);

    // 先添加空消息
    addMessage(sessionId, {
      role: 'assistant',
      content: '',
    });

    const allMessages = getMessages(sessionId);
    const assistantMessageId = allMessages[allMessages.length - 1].id;
    let fullContent = '';
    let localUnlisten: UnlistenFn | null = null;
    const closeLocalStreamListener = () => {
      if (localUnlisten) {
        localUnlisten();
        if (unlistenRef.current === localUnlisten) {
          unlistenRef.current = null;
        }
        localUnlisten = null;
      }
    };

    try {
      // 获取历史消息（排除刚添加的空消息）
      const history = allMessages.slice(0, -1).map(m => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content
      }));

      closeActiveStreamListener();

      // 设置事件监听
      localUnlisten = await listen<StreamEvent>(`ai-stream-${sessionId}`, (event) => {
        const data = event.payload;
        
        if (data.error) {
          updateMessage(sessionId, assistantMessageId, {
            content: `❌ ${data.error}`,
          });
          setLoading(sessionId, false);
          closeLocalStreamListener();
          return;
        }

        if (data.chunk) {
          fullContent += data.chunk;
          updateMessage(sessionId, assistantMessageId, {
            content: fullContent,
          });
        }

        if (data.done) {
          closeLocalStreamListener();
          if (
            !data.command &&
            !data.fileWrite &&
            operationMode === 'auto' &&
            repairAttempt < MAX_AUTO_FORMAT_REPAIR_ATTEMPTS &&
            isThinkOnlyOrEmptyResponse(fullContent)
          ) {
            autoFormatRepairAttemptsRef.current += 1;
            updateMessage(sessionId, assistantMessageId, {
              content: '模型只返回了空白或 think 标签残片，正在重试获取下一步命令...',
            });
            setLoading(sessionId, false);
            void sendOutputToAI(command, output, exitCode, repairAttempt + 1);
            return;
          }

          const outputSummary = output.trim()
            ? output.slice(-COMMAND_OUTPUT_SUMMARY_TAIL_LENGTH)
            : '(命令无输出)';
          appendTaskSummary([
            `命令：${command}`,
            `退出码：${exitCode ?? '未知'}`,
            `关键输出：${outputSummary}`,
            `AI 分析：${fullContent.trim() || '(无分析)'}`,
          ].join('\n'));

          updateMessage(sessionId, assistantMessageId, {
            content: fullContent,
            command: data.command,
            commandStatus: data.command ? 'pending' : undefined,
            fileWrite: data.fileWrite,
            fileStatus: initialFileStatusFor(data.fileWrite),
          });
          setLoading(sessionId, false);

          if (data.command && operationMode === 'auto') {
            autoFormatRepairAttemptsRef.current = 0;
            executeAutoCommand(data.command, assistantMessageId);
          }
          if (data.fileWrite && !fileWriteSupported) {
            addMessage(sessionId, {
              role: 'system',
              content: `${NETWORK_FILE_WRITE_UNSUPPORTED_MESSAGE}\n目标路径：${data.fileWrite.path}`,
            });
          }
          if (data.fileWrite && operationMode === 'auto' && fileWriteSupported) {
            void executeFileWrite(data.fileWrite, assistantMessageId);
          }
        }
      });

      unlistenRef.current = localUnlisten;

      const truncatedOutputWarning = commandOutputContext.truncated
        ? '注意：命令输出已因长度限制被省略中间部分。请明确说明只能基于可见片段分析；如果任务需要全量判断，不要直接下最终结论，应给出更精确的过滤命令或说明需要继续查看缺失部分。'
        : '';

      const analysisPrompt = repairAttempt > 0
        ? [
            '上一次模型响应只包含空白或 think 标签残片，没有返回可执行的 JSON command，导致自动模式无法继续。',
            '请重新基于下面的任务目标、滚动摘要和命令结果判断下一步。',
            '如果任务未完成，必须只在回复末尾给一个 JSON 代码块：',
            '```json',
            '{"command":"下一条只读排查命令"}',
            '```',
            '如果任务已经完成，请明确总结最终结论，不要输出 command。',
            '',
            `当前任务目标：${taskGoal || '未明确'}`,
            '',
            `当前任务滚动摘要：\n${taskSummary || '(暂无)'}`,
            '',
            truncatedOutputWarning,
            '',
            `命令 "${command}" 已完成，退出码：${exitCode ?? '未知'}。执行结果如下：`,
            '```',
            commandOutputContext.text || '(命令无输出)',
            '```',
          ].filter(Boolean).join('\n')
        : `当前任务目标：${taskGoal || '未明确'}\n\n当前任务滚动摘要：\n${taskSummary || '(暂无)'}\n\n${truncatedOutputWarning ? `${truncatedOutputWarning}\n\n` : ''}命令 "${command}" 已完成，退出码：${exitCode ?? '未知'}。执行结果如下。请围绕当前任务目标和滚动摘要分析结果；如果还没有完成该目标，请按系统规则给下一条最相关的 JSON command；如果已经能完成该目标，请直接总结最终结果，不要给 command。\n\n\`\`\`\n${commandOutputContext.text || '(命令无输出)'}\n\`\`\``;

      // 调用流式 API
      await invoke('ai_chat_stream', {
        providerId: activeProvider.id,
        message: analysisPrompt,
        sessionId,
        history,
        deviceType,
        deviceProfile,
      });

    } catch (err: any) {
      updateMessage(sessionId, assistantMessageId, {
        content: `❌ AI 分析失败: ${err.toString()}`,
      });
      setLoading(sessionId, false);
    } finally {
      closeLocalStreamListener();
    }
  };

  // 处理命令执行（确认模式）
  const handleExecuteCommand = async (message: ChatMessage) => {
    if (!message.command) return;
    resetAutoCommandChain();
    initializeTaskMemoryIfEmpty(getLatestUserGoalBeforeMessage(message.id));
    await executeCommandAndWaitForOutput(message.command, message.id);
  };

  // 拒绝命令
  const handleRejectCommand = (message: ChatMessage) => {
    updateMessage(sessionId, message.id, { commandStatus: 'rejected' });
  };

  const handleWriteFile = async (message: ChatMessage) => {
    if (!message.fileWrite) return;
    resetAutoCommandChain();
    initializeTaskMemoryIfEmpty(getLatestUserGoalBeforeMessage(message.id));
    await executeFileWrite(message.fileWrite, message.id);
  };

  const handleRejectFileWrite = (message: ChatMessage) => {
    updateMessage(sessionId, message.id, { fileStatus: 'rejected' });
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
    if (activeCommandRef.current) {
      activeCommandRef.current.cancelled = true;
      if (activeCommandRef.current.messageId) {
        updateMessage(sessionId, activeCommandRef.current.messageId, { commandStatus: 'cancelled' });
      }
      onExecuteCommand('\x03', { appendNewline: false });
      activeCommandRef.current = null;
    }

    // 取消事件监听
    closeActiveStreamListener();
    // 重置加载状态
    setLoading(sessionId, false);
    setWaitingForOutput(sessionId, false);
    // 清除待执行的命令
    clearPendingCommand(sessionId);
    resetAutoCommandChain();
    resetTaskMemory(null);
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
              onExecute={() => handleExecuteCommand(message)}
              onReject={() => handleRejectCommand(message)}
              onWriteFile={() => handleWriteFile(message)}
              onRejectFileWrite={() => handleRejectFileWrite(message)}
              fileWriteSupported={fileWriteSupported}
            />
          ))
        )}
        
        {/* 等待输出状态 */}
        {isWaitingForOutput && (
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">
              {pendingCommand
                ? `正在执行：${pendingCommand.command} · ${formatElapsed(elapsedTick - pendingCommand.startTime)}`
                : '正在等待命令执行完成...'}
            </span>
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
  onExecute: () => void;
  onReject: () => void;
  onWriteFile: () => void;
  onRejectFileWrite: () => void;
  fileWriteSupported: boolean;
}

function MessageBubble({
  message,
  onExecute,
  onReject,
  onWriteFile,
  onRejectFileWrite,
  fileWriteSupported,
}: MessageBubbleProps) {
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
              {message.commandStatus === 'running' && (
                <span className="text-xs text-amber-600 dark:text-amber-400 flex-shrink-0">执行中</span>
              )}
              {message.commandStatus === 'completed' && (
                <span className="text-xs text-green-600 dark:text-green-400 flex-shrink-0">已完成</span>
              )}
              {message.commandStatus === 'failed' && (
                <span className="text-xs text-red-600 dark:text-red-400 flex-shrink-0">执行失败</span>
              )}
              {message.commandStatus === 'cancelled' && (
                <span className="text-xs text-red-600 dark:text-red-400 flex-shrink-0">已停止</span>
              )}
              {message.commandStatus === 'timeout' && (
                <span className="text-xs text-amber-600 dark:text-amber-400 flex-shrink-0">等待超时</span>
              )}
              {message.commandStatus === 'rejected' && (
                <span className="text-xs text-red-600 dark:text-red-400 flex-shrink-0">✗ 已拒绝</span>
              )}
            </div>
            
            {/* 确认模式下显示操作按钮 */}
            {message.commandStatus === 'pending' && (
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

        {message.fileWrite && (
          <div className="mt-2 pt-2 border-t border-surface-200 dark:border-surface-700/50">
            <div className="flex items-center gap-2 mb-2">
              <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-300 text-xs flex-shrink-0">
                {getFileWriteOperationLabel(message.fileWrite)}
              </span>
              <code className="flex-1 bg-surface-100 dark:bg-surface-950/50 px-2 py-1 rounded text-xs text-blue-600 dark:text-blue-400 font-mono border border-surface-200 dark:border-transparent whitespace-pre-wrap break-all">
                {message.fileWrite.path}
              </code>

              {message.fileStatus === 'writing' && (
                <span className="text-xs text-amber-600 dark:text-amber-400 flex-shrink-0">更新中</span>
              )}
              {message.fileStatus === 'completed' && (
                <span className="text-xs text-green-600 dark:text-green-400 flex-shrink-0">已完成</span>
              )}
              {message.fileStatus === 'failed' && (
                <span className="text-xs text-red-600 dark:text-red-400 flex-shrink-0">更新失败</span>
              )}
              {message.fileStatus === 'rejected' && (
                <span className="text-xs text-red-600 dark:text-red-400 flex-shrink-0">已取消</span>
              )}
              {message.fileStatus === 'unsupported' && (
                <span className="text-xs text-amber-600 dark:text-amber-400 flex-shrink-0">不支持</span>
              )}
            </div>

            <pre className="max-h-40 overflow-auto bg-surface-50 dark:bg-black/30 p-3 rounded-lg text-xs font-mono text-surface-800 dark:text-surface-200 border border-surface-200 dark:border-surface-700/50 whitespace-pre-wrap break-words">
              {formatFileWritePreview(message.fileWrite)}
            </pre>

            {message.fileStatus === 'unsupported' && (
              <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                {NETWORK_FILE_WRITE_UNSUPPORTED_MESSAGE}
              </p>
            )}

            {message.fileStatus === 'pending' && fileWriteSupported && (
              <div className="flex gap-2 mt-2">
                <button
                  onClick={onWriteFile}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1 
                             bg-green-500/10 hover:bg-green-500/20 text-green-600 dark:text-green-400 
                             rounded text-xs transition-colors"
                >
                  <Play className="w-3 h-3" />
                  {getFileWriteButtonLabel(message.fileWrite)}
                </button>
                <button
                  onClick={onRejectFileWrite}
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
