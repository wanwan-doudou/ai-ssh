// SSH 服务器配置
export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "privateKey";
  deviceType: "linux" | "network";
  password?: string;
  privateKeyPath?: string;
  group?: string;
  createdAt: number;
  updatedAt: number;
}

// AI Provider 配置
export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ProviderType = "claude" | "openai" | "gemini" | "deepseek" | "custom";

// 终端会话
export interface TerminalSession {
  id: string;
  serverId: string;
  serverName: string;
  isConnected: boolean;
  createdAt: number;
}

// 服务器运行时信息
export interface ServerRuntimeInfo {
  host: string;
  os: string;
  kernel: string;
  kernelName: string;
  kernelVersion: string;
  architecture: string;
  uptime: string;
  cpuModel: string;
  cpuCores: number;
  loadAvg: string;
  memoryTotalKb: number;
  memoryUsedKb: number;
  memoryAvailableKb: number;
  swapTotalKb: number;
  swapUsedKb: number;
  cpuUserPercent: number;
  cpuNicePercent: number;
  cpuSystemPercent: number;
  cpuIdlePercent: number;
  cpuIowaitPercent: number;
  cpuIrqPercent: number;
  cpuSoftirqPercent: number;
  cpuStealPercent: number;
  diskTotalKb: number;
  diskUsedKb: number;
  diskUsePercent: number;
  ipAddress: string;
  netRxBytes: number;
  netTxBytes: number;
  collectedAt: number;
}

export interface ServerProcessInfo {
  pid: number;
  user: string;
  memoryKb: number;
  cpuPercent: number;
  name: string;
  command: string;
}

export interface ServerNetworkConnection {
  protocol: string;
  state: string;
  recvQ: number;
  sendQ: number;
  localAddress: string;
  peerAddress: string;
  process: string;
}

export interface ServerFilesystemInfo {
  fileSystem: string;
  fsType: string;
  sizeKb: number;
  usedKb: number;
  availKb: number;
  usePercent: number;
  mountPoint: string;
}

// 通用响应
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// AI 对话消息
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  // AI 建议执行的命令
  command?: string;
  // 命令执行状态
  commandStatus?: 'pending' | 'approved' | 'rejected' | 'executed' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
}

// AI 操作模式
// confirm: AI 建议命令后需用户确认才执行
// auto: AI 直接执行命令到终端
export type AiOperationMode = 'confirm' | 'auto';
