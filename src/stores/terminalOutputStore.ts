import { create } from 'zustand';

// 终端输出缓冲区配置
const MAX_BUFFER_SIZE = 8000; // 最大缓冲字符数
const COMMAND_OUTPUT_TIMEOUT = 300; // 初始等待时间（毫秒）- 缩短以便更快开始轮询
const POLLING_INTERVAL = 300; // 轮询间隔（毫秒）- 更频繁检测
const MAX_WAIT_TIME = 300000; // 最大等待时间 5 分钟
const IDLE_THRESHOLD = 3000; // 输出静止阈值（毫秒）- 快速命令的基础等待时间
const LONG_IDLE_THRESHOLD = 3000; // 长命令静止阈值（毫秒）- 没检测到提示符时的后备等待时间
const MIN_EXECUTION_TIME = 500; // 最小执行时间（毫秒）- 确保命令有足够执行时间
const QUICK_COMPLETE_THRESHOLD = 500; // 快速完成阈值（毫秒）- 检测到提示符后等待这么久确认稳定

// 常见的 Shell 提示符模式（用于检测命令完成）
// 使用更严格的模式匹配，要求有明确的用户名@主机名结构
const SHELL_PROMPT_PATTERNS = [
  /^[\w.-]+@[\w.-]+:.*[$#]\s*$/,          // user@host:path$ 格式（必须有@和:）
  /^\[[^\]]+@[^\]]+\][$#]\s*$/,           // [user@host dir]$ 完整行
  /^root@[\w.-]+:.*#\s*$/,                // root 提示符
  /^\w+@[\w.-]+\s*~.*[$#]\s*$/,           // user@host ~ $ 格式
  /^PS\s+[A-Z]:\\.*>\s*$/i,               // PowerShell: PS C:\path>
  /^[\w]+@[\w-]+\s*[$#]\s*$/,             // 简单格式：user@host $
];

// 命令输出特征模式 - 匹配这些模式的行应被排除，不应被视为提示符
const COMMAND_OUTPUT_PATTERNS = [
  /^\+\s/,                    // Shell trace 输出 (set -x): + command
  /^\+ /,                     // Shell trace 输出变体
  /^Processing triggers/i,    // dpkg 处理触发器
  /^Setting up/i,             // apt 安装进度
  /^Selecting previously/i,   // apt 选择软件包
  /^Unpacking/i,              // apt 解压
  /^Preparing to unpack/i,    // apt 准备解压
  /^Reading package lists/i,  // apt 读取包列表
  /^Building dependency/i,    // apt 构建依赖
  /^Get:\d+/,                 // apt 下载进度
  /^\s*\d+%/,                 // 进度百分比
  /Executing:/i,              // Docker 安装脚本
  /^#\s+Executing/i,          // Docker 安装脚本注释
  /installing/i,              // 安装中提示
  /downloading/i,             // 下载中提示
  /^\s*sh\s+-c\s+/,           // sh -c 命令
  /^Hit:/,                    // apt Hit 缓存
  /^Fetched/,                 // apt Fetched
  /^E:/,                      // apt 错误
  /^W:/,                      // apt 警告
];

// 交互式程序特征模式（less, more, vim, nano 等）
const INTERACTIVE_PROGRAM_PATTERNS = [
  { pattern: /\(END\)\s*$/i, exitKey: 'q' },                    // less: (END)
  { pattern: /--More--/i, exitKey: ' ' },                       // more: --More--
  { pattern: /lines?\s+\d+-\d+\/\d+/i, exitKey: 'q' },         // less: lines 1-4/4
  { pattern: /:\s*$/, exitKey: 'q', requiresCheck: true },      // less/man 可能显示 :
  { pattern: /~\s*\n.*~\s*\n/m, exitKey: '\x1b:q!\n' },        // vim: 多行 ~
  { pattern: /\[ nano /i, exitKey: '\x18' },                    // nano: Ctrl+X
  { pattern: /help.*quit/i, exitKey: 'q' },                     // 帮助页面
  { pattern: /Press.*continue|any key/i, exitKey: '\n' },       // 按任意键继续
];

interface TerminalOutputStore {
  // 每个会话的终端输出缓冲区
  outputBuffers: Map<string, string>;
  // 每个会话正在等待的命令
  pendingCommands: Map<string, { command: string; startTime: number }>;
  
  // 追加终端输出到缓冲区
  appendOutput: (sessionId: string, output: string) => void;
  // 获取并清空缓冲区
  consumeOutput: (sessionId: string) => string;
  // 获取当前缓冲区内容（不清空）
  getOutput: (sessionId: string) => string;
  // 清空缓冲区
  clearOutput: (sessionId: string) => void;
  // 设置等待中的命令
  setPendingCommand: (sessionId: string, command: string) => void;
  // 获取等待中的命令
  getPendingCommand: (sessionId: string) => { command: string; startTime: number } | undefined;
  // 清除等待中的命令
  clearPendingCommand: (sessionId: string) => void;
}

// 清理 ANSI 转义序列，使输出更干净
function stripAnsiCodes(text: string): string {
  // 移除常见的 ANSI 转义序列
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
             .replace(/\x1b\][^\x07]*\x07/g, '') // OSC sequences
             .replace(/\r/g, ''); // 移除回车符
}

export const useTerminalOutputStore = create<TerminalOutputStore>()((set, get) => ({
  outputBuffers: new Map(),
  pendingCommands: new Map(),
  
  appendOutput: (sessionId: string, output: string) => {
    set((state) => {
      const buffers = new Map(state.outputBuffers);
      const currentBuffer = buffers.get(sessionId) || '';
      
      // 追加新输出，清理 ANSI 代码
      let newBuffer = currentBuffer + stripAnsiCodes(output);
      
      // 如果超过最大长度，只保留最后部分
      if (newBuffer.length > MAX_BUFFER_SIZE) {
        newBuffer = newBuffer.slice(-MAX_BUFFER_SIZE);
      }
      
      buffers.set(sessionId, newBuffer);
      return { outputBuffers: buffers };
    });
  },
  
  consumeOutput: (sessionId: string) => {
    const buffer = get().outputBuffers.get(sessionId) || '';
    // 清空缓冲区
    set((state) => {
      const buffers = new Map(state.outputBuffers);
      buffers.delete(sessionId);
      return { outputBuffers: buffers };
    });
    return buffer;
  },
  
  getOutput: (sessionId: string) => {
    return get().outputBuffers.get(sessionId) || '';
  },
  
  clearOutput: (sessionId: string) => {
    set((state) => {
      const buffers = new Map(state.outputBuffers);
      buffers.delete(sessionId);
      return { outputBuffers: buffers };
    });
  },
  
  setPendingCommand: (sessionId: string, command: string) => {
    set((state) => {
      const pending = new Map(state.pendingCommands);
      pending.set(sessionId, { command, startTime: Date.now() });
      return { pendingCommands: pending };
    });
  },
  
  getPendingCommand: (sessionId: string) => {
    return get().pendingCommands.get(sessionId);
  },
  
  clearPendingCommand: (sessionId: string) => {
    set((state) => {
      const pending = new Map(state.pendingCommands);
      pending.delete(sessionId);
      return { pendingCommands: pending };
    });
  },
}));

// 检测输出是否包含 Shell 提示符（表示命令已完成）
export function detectCommandComplete(output: string): boolean {
  // 获取最后几行进行精确检查
  const lines = output.split('\n').filter(l => l.trim());
  if (lines.length === 0) return false;
  
  const lastLine = lines[lines.length - 1].trim();
  
  // 先排除命令输出特征行（如 + sh -c ... 等安装脚本输出）
  if (COMMAND_OUTPUT_PATTERNS.some(p => p.test(lastLine))) {
    return false;
  }
  
  // 检查是否匹配提示符模式
  return SHELL_PROMPT_PATTERNS.some(pattern => pattern.test(lastLine));
}

// 检测命令是否已被终端回显（表示命令已发送到服务器）
export function isCommandEchoed(output: string, command: string): boolean {
  // 命令可能被分行或包含转义序列，使用模糊匹配
  // 规范化空白字符进行比较
  const normalizedOutput = output.replace(/\s+/g, ' ').trim();
  const normalizedCommand = command.replace(/\s+/g, ' ').trim();
  return normalizedOutput.includes(normalizedCommand);
}

// 检测输出末尾是否有新的提示符行（更可靠的完成检测）
export function detectNewPromptLine(output: string): boolean {
  // 获取最后几行（过滤空行）
  const lines = output.split('\n').filter(l => l.trim());
  if (lines.length === 0) return false;
  
  const lastLine = lines[lines.length - 1].trim();
  
  // 先排除命令输出特征行
  if (COMMAND_OUTPUT_PATTERNS.some(p => p.test(lastLine))) {
    return false;
  }
  
  // 提示符特征：较短、匹配提示符模式、不包含常见错误信息
  const isPromptLike = 
    lastLine.length < 120 && // 提示符通常较短
    lastLine.length > 0 &&   // 非空
    SHELL_PROMPT_PATTERNS.some(p => p.test(lastLine)) &&
    !lastLine.includes('find:') && // 排除 find 命令的错误输出
    !lastLine.includes('Permission denied') && // 排除权限错误
    !lastLine.includes('No such file') && // 排除文件不存在错误
    !lastLine.includes('cannot access') && // 排除访问错误
    !lastLine.includes('Error:') && // 排除错误信息
    !lastLine.includes('Warning:'); // 排除警告信息
    
  return isPromptLike;
}

// 检测是否处于交互式程序中（如 less, more, vim 等）
// 返回退出所需的按键，如果不在交互式程序中返回 null
export function detectInteractiveProgram(output: string): string | null {
  // 取最后 500 个字符检查
  const tail = output.slice(-500);
  
  for (const { pattern, exitKey, requiresCheck } of INTERACTIVE_PROGRAM_PATTERNS) {
    if (pattern.test(tail)) {
      // 对于需要额外检查的模式（如单独的 :），确保不是普通 shell 提示符
      if (requiresCheck) {
        // 如果同时匹配 shell 提示符，则不是交互式程序
        if (SHELL_PROMPT_PATTERNS.some(p => p.test(tail))) {
          continue;
        }
      }
      return exitKey;
    }
  }
  
  return null;
}

// 导出常量供其他模块使用
export { 
  COMMAND_OUTPUT_TIMEOUT, 
  POLLING_INTERVAL, 
  MAX_WAIT_TIME, 
  IDLE_THRESHOLD,
  LONG_IDLE_THRESHOLD,
  QUICK_COMPLETE_THRESHOLD,
  MIN_EXECUTION_TIME 
};
