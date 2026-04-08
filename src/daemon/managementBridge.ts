import os from "node:os";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { SessionManager } from "./sessionManager.js";

interface BridgeOptions {
  serverUrl: string;
  daemonId?: string;
  daemonName?: string;
}

export class ManagementBridge {
  private readonly serverUrl: string;
  private readonly daemonId: string;
  private readonly daemonName: string;
  private readonly sessionManager: SessionManager;
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private eventFlushTimer?: NodeJS.Timeout;
  private readonly pendingEvents: unknown[] = [];

  constructor(sessionManager: SessionManager, options: BridgeOptions) {
    this.sessionManager = sessionManager;
    this.serverUrl = options.serverUrl;
    this.daemonId = options.daemonId ?? randomUUID();
    this.daemonName = options.daemonName ?? os.hostname();
  }

  start(): void {
    this.connect();
    this.sessionManager.on("event", (event) => {
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
        platform: process.platform,
        cwd: process.cwd(),
        connectedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        online: true,
        sessionCount: this.sessionManager.list().length,
      },
      sessions: this.sessionManager.list(),
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
        return this.sessionManager.getConfig();
      case "listSessions":
        return this.sessionManager.list();
      case "getSession":
        return this.sessionManager.get(String(params.sessionId));
      case "listHistory":
        return this.sessionManager.listHistory();
      case "browseDirectories":
        return this.sessionManager.browseDirectories(
          typeof params.path === "string" ? params.path : undefined,
        );
      case "browseSessionFiles":
        return this.sessionManager.browseSessionFiles(
          String(params.sessionId),
          typeof params.path === "string" ? params.path : undefined,
        );
      case "readSessionFile":
        return this.sessionManager.readSessionFile(String(params.sessionId), String(params.path));
      case "writeSessionFile":
        return this.sessionManager.writeSessionFile(
          String(params.sessionId),
          String(params.path),
          String(params.content ?? ""),
        );
      case "createSession":
        return this.sessionManager.create({
          cwd: String(params.cwd ?? process.cwd()),
          model: typeof params.model === "string" ? params.model : undefined,
          reasoningEffort:
            typeof params.reasoningEffort === "string" ? (params.reasoningEffort as any) : undefined,
          sandbox: typeof params.sandbox === "string" ? (params.sandbox as any) : undefined,
          approvalPolicy:
            typeof params.approvalPolicy === "string" ? (params.approvalPolicy as any) : undefined,
        });
      case "restoreSession":
        return this.sessionManager.restore({
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
        await this.sessionManager.sendMessage(String(params.sessionId), String(params.text ?? ""));
        return { ok: true };
      case "updateSessionConfig":
        return this.sessionManager.updateConfig(String(params.sessionId), {
          model: typeof params.model === "string" ? params.model : undefined,
          reasoningEffort:
            typeof params.reasoningEffort === "string" ? (params.reasoningEffort as any) : undefined,
          sandbox: typeof params.sandbox === "string" ? (params.sandbox as any) : undefined,
          approvalPolicy:
            typeof params.approvalPolicy === "string" ? (params.approvalPolicy as any) : undefined,
        });
      case "renameSession":
        return this.sessionManager.rename(String(params.sessionId), {
          title: String(params.title ?? ""),
        });
      case "interruptSession":
        await this.sessionManager.interrupt(String(params.sessionId));
        return { ok: true };
      case "respondApproval":
        return this.sessionManager.respondApproval(
          String(params.sessionId),
          String(params.approvalRequestId),
          params.decision === "deny" ? "deny" : "approve",
        );
      case "closeSession":
        await this.sessionManager.close(String(params.sessionId));
        return { ok: true };
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
