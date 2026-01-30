# AI-SSH Terminal 🚀

智能 SSH 终端桌面应用，深度集成 AI 辅助功能与全功能 SFTP 文件管理。通过自然语言与 AI 交互，降低运维门槛；同时提供高效的远程文件管理体验，实现终端与文件系统的无缝协同。

## ✨ 核心特性

### 📁 SFTP 文件管理系统 (New)
- **可视化文件浏览**：直观的树形目录结构，支持文件/文件夹的展开与折叠。
- **高性能传输**：优化的文件传输算法，支持大文件和批量小文件的高速上传/下载。
- **拖拽上传**：支持直接从 Windows 资源管理器拖拽文件到应用窗口进行上传。
- **任务管理**：实时的文件传输队列，显示传输进度、速度和状态。
- **终端同步**：
  - **自动跟随**：在终端执行 `cd` 命令时，文件管理器自动跳转到对应目录。
  - **分屏视图**：支持终端与文件管理器的自适应分屏显示，提升工作效率。

### 🤖 AI 智能助手
- **上下文感知**：AI 能够分析当前终端的输出内容、错误日志，提供精准的命令建议。
- **自然语言交互**：通过对话面板描述需求（如"查看 Nginx 日志"），AI 自动生成 Shell 命令。
- **双模式执行**：
  - **确认模式**：AI 建议需人工确认（安全优先）。
  - **自动模式**：AI 直接执行低风险命令（效率优先）。
- **多模型支持**：兼容 Claude, OpenAI, Gemini 等主流 AI 模型，支持自定义 API。

### 🖥️ 专业级 SSH 终端
- **全功能模拟器**：基于 xterm.js，支持真彩显示、PTY 伪终端交互。
- **会话管理**：支持多标签页、服务器分组管理。
- **多种认证**：支持密码认证和 SSH Key 私钥认证。
- **个性化**：支持明暗主题切换，终端字体大小自适应。

## 🛠️ 技术栈

| 领域 | 技术方案 |
|------|----------|
| **Core** | [Tauri v2](https://tauri.app) (Rust) |
| **Frontend** | React 18 + TypeScript |
| **UI Framework** | Tailwind CSS 3.4 + Luside Icons |
| **State Management** | Zustand 5 |
| **Terminal** | xterm.js 5.5 |
| **SSH/SFTP** | russh (Rust SSH client) |
| **Database** | SQLite (rusqlite) |
| **Build Tool** | Vite 6 |

## 🚀 快速开始

### 环境准备
- Node.js 18+
- pnpm
- Rust (建议通过 rustup 安装最新 stable 版本)

### 安装依赖
```bash
pnpm install
```

### 启动开发环境
```bash
pnpm tauri dev
```

### 构建生产包
```bash
pnpm tauri build
```

## 📂 项目结构概览

```
ai-ssh/
├── src/                          # React 前端源码
│   ├── components/               # UI 组件
│   │   ├── terminal/             # 终端核心模块
│   │   │   ├── TerminalView.tsx  # 终端主视图 (含分屏逻辑)
│   │   │   ├── FileExplorer.tsx  # SFTP 文件管理器
│   │   │   └── AiChatPanel.tsx   # AI 助手面板
│   │   ├── servers/              # 服务器管理
│   │   └── providers/            # AI 模型配置
│   ├── stores/                   # 状态管理 (Zustand)
│   │   ├── sftpStore.ts          # SFTP 文件系统状态
│   │   ├── transferStore.ts      # 文件传输任务/进度
│   │   ├── terminalStore.ts      # 终端会话核心状态
│   │   ├── terminalDirectoryStore.ts # 目录同步状态
│   │   └── chatStore.ts          # AI 上下文状态
│   └── lib/                      # 工具库
│
├── src-tauri/                    # Rust 后端核心
│   ├── src/
│   │   ├── sftp.rs               # SFTP 协议实现与高性能传输逻辑
│   │   ├── ssh.rs                # SSH 连接与会话管理
│   │   ├── db.rs                 # SQLite 持久化层
│   │   └── commands/             # 前端调用的 Tauri Commands
│   │       ├── ai_chat.rs        # AI 流式对话接口
│   │       └── ...
│   └── tauri.conf.json           # Tauri 应用配置 (权限/窗口等)
```

## 📄 许可证

MIT License
