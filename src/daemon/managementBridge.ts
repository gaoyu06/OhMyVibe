import os from "node:os";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import packageJson from "../../package.json" with { type: "json" };
import { ProjectManager } from "./projectManager.js";

interface BridgeOptions {
  serverUrl: string;
  daemonId?: string;
  daemonName?: string;
}

export class ManagementBridge {
  private readonly serverUrl: string;
  private readonly daemonId: string;
  private readonly daemonName: string;
  private readonly projectManager: ProjectManager;
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private eventFlushTimer?: NodeJS.Timeout;
  private readonly pendingEvents: unknown[] = [];

  constructor(projectManager: ProjectManager, options: BridgeOptions) {
    this.projectManager = projectManager;
    this.serverUrl = options.serverUrl;
    this.daemonId = options.daemonId ?? randomUUID();
    this.daemonName = options.daemonName ?? os.hostname();
  }

  start(): void {
    this.connect();
    this.projectManager.on("event", (event) => {
      this.enqueueEvent(event);
    });
  }

  private connect(): void {
    const url = new URL(this.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/daemon";
    url.search = "";

    this.socket = new WebSocket(url);

    this.socket.on("open", () => {
      this.sendHello();
    });

    this.socket.on("message", async (raw) => {
      try {
        const message = JSON.parse(String(raw));
        if (message?.type !== "daemon-request") {
          return;
        }
        const data = await this.handleRequest(message.method, message.params ?? {});
        this.send({
          type: "daemon-response",
          daemonId: this.daemonId,
          requestId: message.requestId,
          ok: true,
          data,
        });
      } catch (error) {
        const requestId = (() => {
          try {
            return JSON.parse(String(raw)).requestId;
          } catch {
            return undefined;
          }
        })();
        this.send({
          type: "daemon-response",
          daemonId: this.daemonId,
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.socket.on("close", () => {
      this.scheduleReconnect();
    });

    this.socket.on("error", () => {
      this.socket?.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 3000);
  }

  private sendHello(): void {
    this.flushPendingEvents();
    this.send({
      type: "daemon-hello",
      daemon: {
        id: this.daemonId,
        name: this.daemonName,
        version: packageJson.version,
        platform: process.platform,
        cwd: process.cwd(),
        connectedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        online: true,
        sessionCount: this.projectManager.listSessionsCached().length,
      },
      sessions: this.projectManager.listSessionsCached(),
      projects: this.projectManager.listProjects(),
      agents: this.projectManager.listAgents(),
    });
  }

  private enqueueEvent(event: unknown): void {
    this.pendingEvents.push(event);
    if (this.eventFlushTimer) {
      return;
    }
    this.eventFlushTimer = setTimeout(() => {
      this.eventFlushTimer = undefined;
      this.flushPendingEvents();
    }, 16);
  }

  private flushPendingEvents(): void {
    if (!this.pendingEvents.length) {
      return;
    }
    const events = this.pendingEvents.splice(0, this.pendingEvents.length);
    this.send({
      type: "daemon-events",
      daemonId: this.daemonId,
      events,
    });
  }

  private async handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "getConfig":
        return this.projectManager.getConfig();
      case "listSessions":
        return this.projectManager.listSessions();
      case "getSession":
        return this.projectManager.getSession(String(params.sessionId), {
          limit: typeof params.limit === "number" ? params.limit : undefined,
        });
      case "getSessionTranscript":
        return this.projectManager.getTranscriptPage(String(params.sessionId), {
          beforeEntryId: typeof params.beforeEntryId === "string" ? params.beforeEntryId : undefined,
          limit: typeof params.limit === "number" ? params.limit : undefined,
        });
      case "listHistory":
        return this.projectManager.listHistory();
      case "browseDirectories":
        return this.projectManager.browseDirectories(
          typeof params.path === "string" ? params.path : undefined,
        );
      case "browseSessionFiles":
        return this.projectManager.browseSessionFiles(
          String(params.sessionId),
          typeof params.path === "string" ? params.path : undefined,
        );
      case "readSessionFile":
        return this.projectManager.readSessionFile(String(params.sessionId), String(params.path));
      case "writeSessionFile":
        return this.projectManager.writeSessionFile(
          String(params.sessionId),
          String(params.path),
          String(params.content ?? ""),
        );
      case "createSession":
        return this.projectManager.createSession({
          cwd: String(params.cwd ?? process.cwd()),
          model: typeof params.model === "string" ? params.model : undefined,
          reasoningEffort:
            typeof params.reasoningEffort === "string" ? (params.reasoningEffort as any) : undefined,
          sandbox: typeof params.sandbox === "string" ? (params.sandbox as any) : undefined,
          approvalPolicy:
            typeof params.approvalPolicy === "string" ? (params.approvalPolicy as any) : undefined,
        });
      case "createProjectSession":
        return this.projectManager.createProjectSession(String(params.projectId), {
          cwd: String(params.cwd ?? process.cwd()),
          model: typeof params.model === "string" ? params.model : undefined,
          reasoningEffort:
            typeof params.reasoningEffort === "string" ? (params.reasoningEffort as any) : undefined,
          sandbox: typeof params.sandbox === "string" ? (params.sandbox as any) : undefined,
          approvalPolicy:
            typeof params.approvalPolicy === "string" ? (params.approvalPolicy as any) : undefined,
        });
      case "restoreSession":
        return this.projectManager.restoreSession({
          threadId: String(params.threadId),
          cwd: typeof params.cwd === "string" ? params.cwd : undefined,
          model: typeof params.model === "string" ? params.model : undefined,
          reasoningEffort:
            typeof params.reasoningEffort === "string" ? (params.reasoningEffort as any) : undefined,
          sandbox: typeof params.sandbox === "string" ? (params.sandbox as any) : undefined,
          approvalPolicy:
            typeof params.approvalPolicy === "string" ? (params.approvalPolicy as any) : undefined,
        });
      case "sendMessage":
        await this.projectManager.sendMessage(String(params.sessionId), String(params.text ?? ""));
        return { ok: true };
      case "updateSessionConfig":
        return this.projectManager.updateSessionConfig(String(params.sessionId), {
          model: typeof params.model === "string" ? params.model : undefined,
          reasoningEffort:
            typeof params.reasoningEffort === "string" ? (params.reasoningEffort as any) : undefined,
          sandbox: typeof params.sandbox === "string" ? (params.sandbox as any) : undefined,
          approvalPolicy:
            typeof params.approvalPolicy === "string" ? (params.approvalPolicy as any) : undefined,
        });
      case "renameSession":
        return this.projectManager.renameSession(String(params.sessionId), {
          title: String(params.title ?? ""),
        });
      case "interruptSession":
        await this.projectManager.interruptSession(String(params.sessionId));
        return { ok: true };
      case "respondApproval":
        return this.projectManager.respondApproval(
          String(params.sessionId),
          String(params.approvalRequestId),
          params.decision === "deny" ? "deny" : "approve",
        );
      case "closeSession":
        await this.projectManager.closeSession(String(params.sessionId));
        return { ok: true };
      case "listProjects":
        return this.projectManager.listProjects();
      case "getProject":
        return this.projectManager.getProject(String(params.projectId));
      case "createProject":
        return this.projectManager.createProject({
          name: String(params.name ?? ""),
          rootDir: String(params.rootDir ?? process.cwd()),
          goal: typeof params.goal === "string" ? params.goal : undefined,
          runPolicy: params.runPolicy as any,
        });
      case "updateProject":
        return this.projectManager.updateProject(String(params.projectId), {
          name: typeof params.name === "string" ? params.name : undefined,
          goal: typeof params.goal === "string" ? params.goal : undefined,
          status: typeof params.status === "string" ? (params.status as any) : undefined,
          runPolicy: params.runPolicy as any,
        });
      case "listAgents":
        return this.projectManager.listAgents(
          typeof params.projectId === "string" ? params.projectId : undefined,
        );
      case "getAgent":
        return this.projectManager.getAgent(String(params.agentId));
      case "sendAgentMessage":
        return this.projectManager.sendAgentMessage(
          String(params.projectId),
          String(params.agentId),
          String(params.text ?? ""),
        );
      case "runProject":
        return this.projectManager.runProject(String(params.projectId));
      case "pauseProject":
        return this.projectManager.pauseProject(String(params.projectId));
      case "getSettings":
        return this.projectManager.getSettings();
      case "updateProviderConfig":
        return this.projectManager.updateProviderConfig(params as any);
      case "updateNotificationConfig":
        return this.projectManager.updateNotificationConfig(params as any);
      case "listNotifications":
        return this.projectManager.listNotifications(
          typeof params.projectId === "string" ? params.projectId : undefined,
        );
      default:
        throw new Error(`Unsupported bridge method: ${method}`);
    }
  }

  private send(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(payload));
  }
}
