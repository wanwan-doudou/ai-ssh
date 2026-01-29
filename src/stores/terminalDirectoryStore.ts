/**
 * 终端目录状态管理
 * 
 * 用于追踪终端当前工作目录，实现终端与 SFTP 文件浏览器的联动
 * 通过解析终端输出中的 Shell 提示符来检测目录变化
 */

import { create } from 'zustand';

/**
 * 清理 ANSI 转义序列，方便解析
 */
function stripAnsiCodes(text: string): string {
  // 移除所有 ANSI 转义序列：颜色、光标控制、终端控制等
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
             .replace(/\x1b\][^\x07]*\x07/g, '')  // OSC 序列
             .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '') // DCS/APC/PM/SOS/PuTTY 序列
             .replace(/\r/g, '');  // 移除回车符
}

/**
 * Shell 提示符目录匹配模式
 * 覆盖常见的 Linux/Unix Shell 提示符格式
 */
const PROMPT_DIR_PATTERNS: RegExp[] = [
  // user@host:path# 或 user@host:path$ (常见格式，如 root@server:/home#)
  /[\w.-]+@[\w.-]+:([\S]+)[#$]\s*$/,
  
  // user@host path# 或 user@host path$ (无冒号格式)
  /[\w.-]+@[\w.-]+\s+(\/[\S]*)[#$]\s*$/,
  
  // [user@host path]$ 或 [user@host path]# (方括号格式)
  /\[[\w.-]+@[\w.-]+\s+([\S]+)\][#$]\s*$/,
  
  // 纯路径提示符 /path/to/dir# 或 /path/to/dir$
  /^(\/[\S]*)[#$]\s*$/,
  
  // user@host:~# 或 user@host:~/subdir# (波浪号表示用户主目录)
  /[\w.-]+@[\w.-]+:(~[\S]*)[#$]\s*$/,
];

/**
 * 从 OSC 转义序列中解析目录
 * 支持 OSC 0/2 (窗口标题) 和 OSC 7 (文件 URI)
 */
function parseDirectoryFromOsc(output: string): string | null {
  // 1. OSC 7: \x1b]7;file://hostname/path\x07 或 ST 结束
  // 格式: \x1b]7;file://<hostname>/<path>\x07
  const osc7Match = output.match(/\x1b\]7;file:\/\/[^\/]*(\/[^\x07\x1b]*)/);
  if (osc7Match && osc7Match[1]) {
    return osc7Match[1];
  }

  // 2. OSC 0/2: \x1b]0;title\x07 或 \x1b]2;title\x07
  // 常见 Title 格式: user@host:path
  // 注意：output 可能包含多个 OSC 序列，我们取最后一个有效的
  const oscTitleRegex = /\x1b\][02];([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
  let match;
  let lastValidPath: string | null = null;
  
  while ((match = oscTitleRegex.exec(output)) !== null) {
    const title = match[1];
    // 尝试提取 user@host:path 中的 path
    const pathMatch = title.match(/[\w.-]+@[\w.-]+:(\/[\S]*)/);
    if (pathMatch && pathMatch[1]) {
       lastValidPath = pathMatch[1];
    } else if (title.match(/^\/[\S]*$/)) {
       // 也就是整个 title 就是一个绝对路径
       lastValidPath = title;
    }
  }

  return lastValidPath;
}

/**
 * 从终端输出行中解析目录路径
 */
function parseDirectoryFromPrompt(line: string): string | null {
  const cleanLine = stripAnsiCodes(line).trim();
  
  for (const pattern of PROMPT_DIR_PATTERNS) {
    const match = cleanLine.match(pattern);
    if (match && match[1]) {
      const dir = match[1];
      // 处理波浪号路径（保持原样，SFTP 会自动解析）
      // 但需要确保是有效路径格式
      if (dir.startsWith('/') || dir.startsWith('~')) {
        return dir;
      }
    }
  }
  
  return null;
}

/**
 * 终端目录 Store 接口
 */
interface TerminalDirectoryState {
  /** 会话 ID -> 当前目录路径 */
  directories: Record<string, string>;
  
  /** 更新指定会话的目录 */
  updateDirectory: (sessionId: string, dir: string) => void;
  
  /**
   * 从终端输出解析并更新目录
   * @returns 解析到的新目录路径，如果未检测到变化则返回 null
   */
  parseAndUpdateFromOutput: (sessionId: string, output: string) => string | null;
  
  /** 获取指定会话的当前目录 */
  getDirectory: (sessionId: string) => string | undefined;
  
  /** 清除指定会话的目录记录 */
  clearDirectory: (sessionId: string) => void;
}

/**
 * 终端目录 Store
 * 
 * 负责追踪每个终端会话的当前工作目录
 */
export const useTerminalDirectoryStore = create<TerminalDirectoryState>()((set, get) => ({
  directories: {},

  updateDirectory: (sessionId: string, dir: string) => {
    set((state) => ({
      directories: {
        ...state.directories,
        [sessionId]: dir,
      },
    }));
  },

  parseAndUpdateFromOutput: (sessionId: string, output: string) => {
    let detectedDir: string | null = null;

    // 1. 优先尝试从 OSC 序列中解析 (OSC 0/2 标题或 OSC 7 文件路径)
    // 这通常包含完整路径，比 Shell 提示符更可靠（即使提示符只显示相对路径）
    const oscDir = parseDirectoryFromOsc(output);
    if (oscDir) {
      detectedDir = oscDir;
    } else {
      // 2. 降级方案：解析最后的 Shell 提示符
      // 获取输出的最后几行进行分析
      const lines = output.split('\n');
      const recentLines = lines.slice(-5); // 只检查最后 5 行
      
      // 从后往前查找，找到第一个匹配的提示符
      for (let i = recentLines.length - 1; i >= 0; i--) {
        const line = recentLines[i];
        const dir = parseDirectoryFromPrompt(line);
        if (dir) {
          detectedDir = dir;
          break;
        }
      }
    }
    
    if (detectedDir) {
      const currentDir = get().directories[sessionId];
      
      // 只有目录发生变化时才更新
      if (currentDir !== detectedDir) {
        console.log(`[TerminalDirectory] 检测到目录变化: ${currentDir} -> ${detectedDir}`);
        
        set((state) => ({
          directories: {
            ...state.directories,
            [sessionId]: detectedDir!,
          },
        }));
        
        return detectedDir;
      }
    }
    
    return null;
  },

  getDirectory: (sessionId: string) => {
    return get().directories[sessionId];
  },

  clearDirectory: (sessionId: string) => {
    set((state) => {
      const { [sessionId]: _, ...rest } = state.directories;
      return { directories: rest };
    });
  },
}));

// 导出解析函数供测试使用
export { parseDirectoryFromPrompt, parseDirectoryFromOsc, stripAnsiCodes };
