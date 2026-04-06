# OhMyVibe

这是一个 `VibeCoding` 控制台：

- `daemon -> control server <- browser` 架构（daemon 主动连接管理端）
- 每个会话独立启动一个 `codex app-server` 子进程
- daemon 统一管理多会话、消息发送、中断、状态同步
- 额外提供一个标准 `ACP` bridge 入口，方便后续给编辑器或其他 ACP client 接入
- 应用侧 session 本地持久化到 `data/sessions.json`
- 支持从 Codex 历史 `~/.codex/sessions` 恢复会话，并绑定到原始 Codex thread
- Web 控制台为独立 React + shadcn 风格项目，浏览器只连接管理端

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

1. 启动 Web 管理端（API + 页面）：

```bash
npm install
npm --prefix web install
npm --prefix web run build
npm run web:server
```

默认监听 `http://localhost:3310`

2. 在被控机器启动 daemon，并主动连接管理端：

```bash
MANAGEMENT_SERVER_URL=http://your-control-host:3310 npm run daemon
```

可选环境变量：

- `DAEMON_ID`：固定 daemon 标识
- `DAEMON_NAME`：展示名称
- `PORT`：daemon 本地 API 端口（默认 `3210`）

3. 浏览器访问管理端页面：

```bash
http://your-control-host:3310
```

开发模式（前端热更新）：

```bash
npm run web:dev
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
- daemon 主动连接管理端，浏览器不需要直连 daemon

## 后续建议

- 把 `turn/interrupt`、审批、文件 diff、命令执行输出做成更细粒度 UI
- 将 ACP session 和 web session 统一到同一后端存储
- 为 `codex app-server` 请求/通知补完整类型约束

## 参考文档

- OpenAI Codex App Server: https://developers.openai.com/codex/app-server
- OpenAI Codex CLI repo: https://github.com/openai/codex
- ACP 协议主页: https://agentclientprotocol.com
- ACP TypeScript SDK: https://www.npmjs.com/package/@agentclientprotocol/sdk
