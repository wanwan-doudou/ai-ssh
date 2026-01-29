# AI-SSH Terminal

智能 SSH 终端桌面应用，集成 AI 辅助功能。通过自然语言与 AI 交互，AI 会理解用户意图并生成相应的 Shell 命令，降低服务器运维门槛。

## 功能特性

### SSH 服务器管理
- 添加、编辑、删除 SSH 服务器配置
- 支持 **密码认证** 和 **私钥认证** 两种方式
- 服务器分组管理
- 数据持久化到 SQLite 数据库

### AI Provider 配置
- 支持多种 AI 服务商：Claude、OpenAI、Codex、Gemini、Custom
- 可配置 API Key、Base URL、模型名称
- 连接测试功能
- 可设置活跃的 Provider

### 内嵌终端
- 基于 xterm.js 的终端模拟器
- 多标签页支持（多会话）
- 通过 russh 实现真正的 SSH 连接
- PTY 伪终端，完整的交互式 Shell 体验
- 终端大小自适应调整
- 明暗主题切换

### AI 辅助功能
- 右侧 AI 对话面板，与 AI 助手交互
- AI 分析终端输出并建议命令
- 两种操作模式：
  - **确认模式**：AI 建议命令后需用户确认才执行
  - **自动模式**：AI 直接执行命令到终端
- 流式响应（实时显示 AI 回复）
- AI 自动分析命令执行结果并给出反馈

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 18 + TypeScript |
| 样式 | Tailwind CSS 3.4 |
| 状态管理 | Zustand 5 |
| 终端模拟 | xterm.js 5.5 |
| Markdown 渲染 | react-markdown + remark-gfm |
| 图标 | lucide-react |
| 桌面框架 | Tauri v2 (Rust) |
| SSH 库 | russh 0.44 |
| 数据库 | rusqlite (SQLite) |
| HTTP 客户端 | reqwest |
| 加密 | aes-gcm + base64 |
| 构建工具 | Vite 6 |

## 快速开始

### 环境要求

- Node.js 18+
- pnpm
- Rust (安装 rustup)

### 安装依赖

```bash
pnpm install
```

### 开发模式

```bash
pnpm tauri dev
```

### 构建

```bash
pnpm tauri build
```

## 项目结构

```
ai-ssh/
├── src/                          # React 前端源码
│   ├── main.tsx                  # 应用入口
│   ├── App.tsx                   # 主应用组件
│   ├── components/               # UI 组件
│   │   ├── layout/               # 布局组件
│   │   │   ├── Sidebar.tsx       # 侧边栏导航
│   │   │   └── MainContent.tsx   # 主内容区
│   │   ├── servers/              # 服务器管理
│   │   │   ├── ServerList.tsx    # 服务器列表
│   │   │   └── ServerForm.tsx    # 服务器表单
│   │   ├── providers/            # AI Provider 管理
│   │   │   ├── ProviderList.tsx  # Provider 列表
│   │   │   └── ProviderForm.tsx  # Provider 表单
│   │   └── terminal/             # 终端相关
│   │       ├── TerminalView.tsx  # 终端视图 (多标签页)
│   │       └── AiChatPanel.tsx   # AI 对话面板
│   ├── stores/                   # Zustand 状态管理
│   │   ├── serverStore.ts        # 服务器状态
│   │   ├── providerStore.ts      # AI Provider 状态
│   │   ├── terminalStore.ts      # 终端会话状态
│   │   ├── chatStore.ts          # AI 对话状态
│   │   └── themeStore.ts         # 主题状态
│   ├── types/                    # TypeScript 类型定义
│   └── lib/                      # 工具函数
│
├── src-tauri/                    # Rust 后端 (Tauri)
│   ├── Cargo.toml                # Rust 依赖配置
│   ├── tauri.conf.json           # Tauri 应用配置
│   └── src/
│       ├── main.rs               # Rust 入口
│       ├── lib.rs                # 库入口，注册 Tauri 命令
│       ├── models.rs             # 数据模型
│       ├── db.rs                 # SQLite 数据库初始化
│       ├── ssh.rs                # SSH 连接管理 (SshManager)
│       ├── commands/             # Tauri 命令
│       │   ├── server.rs         # 服务器 CRUD
│       │   ├── provider.rs       # Provider CRUD + 连接测试
│       │   ├── ssh.rs            # SSH 连接/断开/写入
│       │   └── ai_chat.rs        # AI 对话 (流式响应)
│       └── services/             # 业务逻辑服务
│
└── package.json
```

## 许可证

MIT
