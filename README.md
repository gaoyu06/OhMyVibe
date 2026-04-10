# OhMyVibe

这是一个 `VibeCoding` 控制台：

- `daemon -> control server <- browser` 架构（daemon 主动连接管理端）
- 每个会话独立启动一个 `codex app-server` 子进程
- daemon 统一管理多会话、消息发送、中断、状态同步
- 应用侧 session 本地持久化到 `data/sessions.json`
- 支持从 Codex 历史 `~/.codex/sessions` 恢复会话，并绑定到原始 Codex thread
- Web 控制台为独立 React + shadcn 风格项目，浏览器只连接管理端
- 浏览器端与管理端具备 websocket 心跳、自动重连与重同步

## 为什么这样做

当前官方能力里，`Codex CLI` 暴露的是 `app-server` 自动化接口，因此当前实现直接围绕 `codex app-server` 做会话管理与编排：

1. daemon 通过 `codex app-server --listen stdio://` 控制 Codex
2. control server 负责聚合 daemon、推送事件，并为浏览器提供统一入口

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
默认读取 `web/.env`

2. 在被控机器启动 daemon，并主动连接管理端：

```bash
npm run daemon
```

daemon 不再暴露本地 HTTP API，浏览器也不应直接连接 daemon。
默认读取根目录 `.env`

可选环境变量：

- `DAEMON_ID`：固定 daemon 标识
- `DAEMON_NAME`：展示名称

3. 浏览器访问管理端页面：

```bash
http://your-control-host:3310
```

开发模式（前端热更新）：

```bash
npm run web:dev
```

## 使用示例

### 示例 1：本机快速跑通

先启动控制端：

```bash
git clone https://github.com/gaoyu06/OhMyVibe.git
cd OhMyVibe
npm install
npm --prefix web install
npm --prefix web run build
npm run web:server
```

再在另一台机器或另一个终端启动 daemon：

```bash
cp .env.example .env
```

`.env`:

```env
MANAGEMENT_SERVER_URL=http://localhost:3310
DAEMON_NAME=ohmyvibe-local
```

启动：

```bash
npm run daemon
```

浏览器访问：

```text
http://localhost:3310
```

### 示例 2：通过 npm 全局安装 daemon

如果你只想安装被控端 daemon，可以直接安装 npm 包：

```bash
npm install -g ohmyvibe
```

然后直接连接到你的控制端：

```bash
ohmyvibe --management-server-url http://your-control-host:3310
```

也可以显式指定 daemon 名称或 id：

```bash
ohmyvibe daemon ^
  --management-server-url http://your-control-host:3310 ^
  --daemon-name office-win ^
  --daemon-id office-win-01
```

说明：

- 当前 npm 包主要提供 `daemon` CLI
- Web 控制服务端目前仍建议直接从仓库部署

## 服务端部署示例

### 示例 1：在 Linux 服务器部署控制端

```bash
git clone https://github.com/gaoyu06/OhMyVibe.git
cd OhMyVibe
npm install
npm --prefix web install
cp web/.env.example web/.env
npm --prefix web run build
npm run web:server
```

`web/.env`:

```env
PORT=3310
VITE_CONTROL_SERVER_URL=https://your-domain.example.com
```

反向代理到 `3310` 端口后，浏览器即可访问控制台，远端 daemon 使用：

```env
MANAGEMENT_SERVER_URL=https://your-domain.example.com
```

### 示例 2：用 PM2 托管控制端

```bash
pm2 start "npm run web:server" --name ohmyvibe-control
pm2 save
```

### 示例 3：发布前验证 npm 包

```bash
npm run build:daemon
npm run pack:dry-run
```

## 全局安装 daemon

如果你要把 daemon 作为全局命令安装，当前包已经支持：

```bash
npm install -g ohmyvibe
```

然后直接启动：

```bash
ohmyvibe --management-server-url http://localhost:3310
```

也可以显式指定 daemon 名称或 id：

```bash
ohmyvibe daemon \
  --management-server-url http://localhost:3310 \
  --daemon-name ohmyvibe-local \
  --daemon-id local-1
```

如果仍然想走环境变量，也支持：

- `MANAGEMENT_SERVER_URL`
- `DAEMON_ID`
- `DAEMON_NAME`

发布前可先验证打包内容：

```bash
npm run build:daemon
npm run pack:dry-run
```

正式发布：

```bash
npm publish --access public
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
- 为 `codex app-server` 请求/通知补完整类型约束

## 参考文档

- OpenAI Codex App Server: https://developers.openai.com/codex/app-server
- OpenAI Codex CLI repo: https://github.com/openai/codex
