# OhMyVibe

这是一个 `VibeCoding` 控制台：

- `daemon + standalone web` 架构
- 每个会话独立启动一个 `codex app-server` 子进程
- daemon 统一管理多会话、消息发送、中断、状态同步
- 额外提供一个标准 `ACP` bridge 入口，方便后续给编辑器或其他 ACP client 接入
- 应用侧 session 本地持久化到 `data/sessions.json`
- 支持从 Codex 历史 `~/.codex/sessions` 恢复会话，并绑定到原始 Codex thread
- Web 控制台为独立 React + shadcn 风格项目，可连接远程 daemon

## 为什么这样做

当前官方能力里，`Codex CLI` 暴露的是 `app-server` 自动化接口，而不是原生 `ACP agent`。因此这个 MVP 采用两层桥接：

1. 南向：daemon 通过 `codex app-server --listen stdio://` 控制 Codex
2. 北向：daemon 自己暴露 `ACP` 兼容 agent，供外部 ACP client 使用

这能保证现在就能正确接入 Codex，同时不把上层协议绑死在 Codex 私有接口上。

## 运行

要求：

- Node.js 22+
- 本机已安装并可运行 `codex`
- `codex` 已完成登录

启动 daemon：

```bash
npm install
npm run daemon
```

启动独立 Web 控制台：

```bash
cd web
npm install
npm run dev
```

默认前端会连接 `window.location.origin`，也可以在 Web 顶栏直接输入远程 daemon 地址，或通过环境变量指定：

```bash
VITE_DAEMON_URL=http://your-daemon-host:3210 npm run dev
```

daemon 默认已允许跨域访问；如需限制来源，可设置：

```bash
ALLOW_ORIGIN=http://your-web-host:5173 npm run daemon
```

启动 ACP bridge：

```bash
npm run acp
```

## 现在支持的能力

- 创建多个独立 Codex 会话
- daemon 重启后恢复应用内 session 列表与 transcript
- 给指定会话发送消息
- 流式接收 assistant 文本增量
- 用 `item/*` 与 `turn/*` 事件维护实时 transcript
- 中断运行中的 turn
- 关闭会话
- 从 Codex 历史会话列表恢复，并继续在同一 `threadId` 上对话
- 使用独立前端从其他设备远程管理 daemon

## 后续建议

- 把 `turn/interrupt`、审批、文件 diff、命令执行输出做成更细粒度 UI
- 将 ACP session 和 web session 统一到同一后端存储
- 为 `codex app-server` 请求/通知补完整类型约束

## 参考文档

- OpenAI Codex App Server: https://developers.openai.com/codex/app-server
- OpenAI Codex CLI repo: https://github.com/openai/codex
- ACP 协议主页: https://agentclientprotocol.com
- ACP TypeScript SDK: https://www.npmjs.com/package/@agentclientprotocol/sdk
