import { create } from 'zustand';
import { TerminalSession } from '@/types';

interface ExtendedTerminalSession extends TerminalSession {
  buffer?: string; // Cache for terminal output
  bufferRestored?: boolean; // 标记 buffer 是否已在终端中恢复过
}

interface TerminalStore {
  sessions: ExtendedTerminalSession[];
  activeSessionId: string | null;
  
  // Actions
  addSession: (session: ExtendedTerminalSession) => void;
  removeSession: (sessionId: string) => void;
  updateSession: (sessionId: string, updates: Partial<ExtendedTerminalSession>) => void;
  setActiveSessionId: (sessionId: string | null) => void;
  appendSessionOutput: (sessionId: string, output: string) => void;
  setSessionConnected: (sessionId: string, isConnected: boolean) => void;
  setBufferRestored: (sessionId: string, restored: boolean) => void;
}

// Helper to strip ANSI codes if we want to save space, but for restoration we usually WANT ANSI codes.
// So we will keep raw output for the terminal to replay.
const MAX_BUFFER_LENGTH = 100000; // Limit buffer size to prevent memory issues

export const useTerminalStore = create<TerminalStore>((set) => ({
  sessions: [],
  activeSessionId: null,

  addSession: (session) => set((state) => ({
    sessions: [...state.sessions, { ...session, buffer: '' }],
    activeSessionId: session.id
  })),

  removeSession: (sessionId) => set((state) => {
    const newSessions = state.sessions.filter(s => s.id !== sessionId);
    // If active session is removed, switch to another one or null
    let newActiveId = state.activeSessionId;
    if (state.activeSessionId === sessionId) {
      newActiveId = newSessions.length > 0 ? newSessions[newSessions.length - 1].id : null;
    }
    return {
      sessions: newSessions,
      activeSessionId: newActiveId
    };
  }),

  updateSession: (sessionId, updates) => set((state) => ({
    sessions: state.sessions.map(s => 
      s.id === sessionId ? { ...s, ...updates } : s
    )
  })),

  setActiveSessionId: (sessionId) => set({ activeSessionId: sessionId }),

  appendSessionOutput: (sessionId, output) => set((state) => ({
    sessions: state.sessions.map(s => {
      if (s.id !== sessionId) return s;
      
      const newBuffer = (s.buffer || '') + output;
      // Truncate if too long, keeping the end
      const truncatedBuffer = newBuffer.length > MAX_BUFFER_LENGTH 
        ? newBuffer.slice(newBuffer.length - MAX_BUFFER_LENGTH) 
        : newBuffer;
        
      return { ...s, buffer: truncatedBuffer };
    })
  })),

  setSessionConnected: (sessionId, isConnected) => set((state) => ({
    sessions: state.sessions.map(s => 
      s.id === sessionId ? { ...s, isConnected } : s
    )
  })),

  setBufferRestored: (sessionId, restored) => set((state) => ({
    sessions: state.sessions.map(s => 
      s.id === sessionId ? { ...s, bufferRestored: restored } : s
    )
  })),
}));
