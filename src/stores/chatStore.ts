import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ChatMessage, AiOperationMode } from '@/types';

interface ChatSession {
  messages: ChatMessage[];
  isLoading: boolean;
  // 等待命令输出状态（区分于 AI 思考状态）
  waitingForOutput: boolean;
  taskGoal?: string | null;
  taskSummary?: string;
}

interface ChatStore {
  // 每个终端会话的聊天记录
  sessions: Map<string, ChatSession>;
  // 当前操作模式
  operationMode: AiOperationMode;
  // 面板宽度比例（右侧面板占比，如 0.3 表示 30%）
  panelRatio: number;
  
  // 获取会话消息
  getMessages: (sessionId: string) => ChatMessage[];
  // 添加消息
  addMessage: (sessionId: string, message: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
  // 更新消息（如更新命令状态）
  updateMessage: (sessionId: string, messageId: string, updates: Partial<ChatMessage>) => void;
  // 设置加载状态
  setLoading: (sessionId: string, loading: boolean) => void;
  // 设置等待输出状态
  setWaitingForOutput: (sessionId: string, waiting: boolean) => void;
  // 获取任务记忆
  getTaskMemory: (sessionId: string) => { goal: string | null; summary: string };
  // 设置任务记忆
  setTaskMemory: (sessionId: string, memory: { goal?: string | null; summary?: string }) => void;
  // 切换操作模式
  toggleOperationMode: () => void;
  // 设置操作模式
  setOperationMode: (mode: AiOperationMode) => void;
  // 设置面板宽度比例
  setPanelRatio: (ratio: number) => void;
  // 清空会话消息
  clearSession: (sessionId: string) => void;
}

// 生成唯一消息 ID
const generateMessageId = () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
      sessions: new Map(),
      operationMode: 'confirm',
      panelRatio: 0.35,
      
      getMessages: (sessionId: string) => {
        const session = get().sessions.get(sessionId);
        return session?.messages || [];
      },

      getTaskMemory: (sessionId: string) => {
        const session = get().sessions.get(sessionId);
        return {
          goal: session?.taskGoal ?? null,
          summary: session?.taskSummary ?? '',
        };
      },
      
      addMessage: (sessionId: string, message) => {
        set((state) => {
          const sessions = new Map(state.sessions);
          const session = sessions.get(sessionId) || { messages: [], isLoading: false, waitingForOutput: false, taskGoal: null, taskSummary: '' };
          
          const newMessage: ChatMessage = {
            ...message,
            id: generateMessageId(),
            timestamp: Date.now(),
          };
          
          sessions.set(sessionId, {
            ...session,
            messages: [...session.messages, newMessage],
          });
          
          return { sessions };
        });
      },
      
      updateMessage: (sessionId: string, messageId: string, updates) => {
        set((state) => {
          const sessions = new Map(state.sessions);
          const session = sessions.get(sessionId);
          
          if (session) {
            sessions.set(sessionId, {
              ...session,
              messages: session.messages.map((msg) =>
                msg.id === messageId ? { ...msg, ...updates } : msg
              ),
            });
          }
          
          return { sessions };
        });
      },
      
      setLoading: (sessionId: string, loading: boolean) => {
        set((state) => {
          const sessions = new Map(state.sessions);
          const session = sessions.get(sessionId) || { messages: [], isLoading: false, waitingForOutput: false, taskGoal: null, taskSummary: '' };
          sessions.set(sessionId, { ...session, isLoading: loading });
          return { sessions };
        });
      },
      
      setWaitingForOutput: (sessionId: string, waiting: boolean) => {
        set((state) => {
          const sessions = new Map(state.sessions);
          const session = sessions.get(sessionId) || { messages: [], isLoading: false, waitingForOutput: false, taskGoal: null, taskSummary: '' };
          sessions.set(sessionId, { ...session, waitingForOutput: waiting });
          return { sessions };
        });
      },

      setTaskMemory: (sessionId, memory) => {
        set((state) => {
          const sessions = new Map(state.sessions);
          const session = sessions.get(sessionId) || { messages: [], isLoading: false, waitingForOutput: false, taskGoal: null, taskSummary: '' };
          sessions.set(sessionId, {
            ...session,
            taskGoal: memory.goal !== undefined ? memory.goal : session.taskGoal ?? null,
            taskSummary: memory.summary !== undefined ? memory.summary : session.taskSummary ?? '',
          });
          return { sessions };
        });
      },
      
      toggleOperationMode: () => {
        set((state) => ({
          operationMode: state.operationMode === 'confirm' ? 'auto' : 'confirm',
        }));
      },
      
      setOperationMode: (mode: AiOperationMode) => {
        set({ operationMode: mode });
      },
      
      setPanelRatio: (ratio: number) => {
        // 限制在 0.2 到 0.6 之间
        const clampedRatio = Math.max(0.2, Math.min(0.6, ratio));
        set({ panelRatio: clampedRatio });
      },
      
      clearSession: (sessionId: string) => {
        set((state) => {
          const sessions = new Map(state.sessions);
          sessions.delete(sessionId);
          return { sessions };
        });
      },
    }),
    {
      name: 'ai-ssh-chat',
      // 自定义序列化以支持 Map
      storage: {
        getItem: (name) => {
          const str = localStorage.getItem(name);
          if (!str) return null;
          const parsed = JSON.parse(str);
          // 将序列化的数组转回 Map
          if (parsed.state?.sessions) {
            parsed.state.sessions = new Map(parsed.state.sessions);
          }
          return parsed;
        },
        setItem: (name, value) => {
          // 将 Map 转为数组以便序列化
          const toStore = {
            ...value,
            state: {
              ...value.state,
              sessions: Array.from(value.state.sessions.entries()),
            },
          };
          localStorage.setItem(name, JSON.stringify(toStore));
        },
        removeItem: (name) => localStorage.removeItem(name),
      },
    }
  )
);
