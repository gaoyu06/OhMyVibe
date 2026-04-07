import { AvailableModel } from "../shared/types.js";
import { JsonRpcNotification, JsonRpcProcess, JsonRpcRequest } from "./jsonRpc.js";

export interface CodexClientOptions {
  cwd: string;
}

export class CodexAppServerClient {
  private readonly rpc: JsonRpcProcess;

  constructor(options: CodexClientOptions) {
    const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "codex";
    const args =
      process.platform === "win32"
        ? ["/d", "/s", "/c", "codex.cmd app-server --listen stdio://"]
        : ["app-server", "--listen", "stdio://"];

    this.rpc = new JsonRpcProcess(command, args, options.cwd);
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): void {
    this.rpc.on("notification", listener);
  }

  onRequest(listener: (request: JsonRpcRequest) => void): void {
    this.rpc.on("request", listener);
  }

  onStderr(listener: (chunk: string) => void): void {
    this.rpc.on("stderr", listener);
  }

  onExit(listener: (event: { code: number | null; signal: NodeJS.Signals | null }) => void): void {
    this.rpc.on("exit", listener);
  }

  initialize(): Promise<any> {
    return this.rpc.request("initialize", {
      clientInfo: {
        name: "ohmyvibe-daemon",
        title: "OhMyVibe Daemon",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  }

  threadStart(params: {
    cwd: string;
    model?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  }): Promise<any> {
    return this.rpc.request("thread/start", {
      cwd: params.cwd,
      model: params.model ?? null,
      sandbox: params.sandbox ?? "workspace-write",
      approvalPolicy: params.approvalPolicy ?? "never",
      personality: "pragmatic",
    });
  }

  threadResume(params: {
    threadId: string;
    cwd?: string;
    model?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  }): Promise<any> {
    return this.rpc.request("thread/resume", {
      threadId: params.threadId,
      cwd: params.cwd ?? null,
      model: params.model ?? null,
      sandbox: params.sandbox ?? "workspace-write",
      approvalPolicy: params.approvalPolicy ?? "never",
      personality: "pragmatic",
    });
  }

  turnStart(params: {
    threadId: string;
    text: string;
    effort?: string;
    model?: string;
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
    summary?: "auto" | "concise" | "detailed" | "none";
  }): Promise<any> {
    return this.rpc.request("turn/start", {
      threadId: params.threadId,
      effort: params.effort ?? null,
      model: params.model ?? null,
      approvalPolicy: params.approvalPolicy ?? null,
      summary: params.summary ?? "detailed",
      input: [
        {
          type: "text",
          text: params.text,
        },
      ],
    });
  }

  threadRead(threadId: string): Promise<any> {
    return this.rpc.request("thread/read", { threadId });
  }

  threadList(params?: {
    limit?: number;
    cursor?: string;
    cwd?: string;
    searchTerm?: string;
    sortKey?: "created_at" | "updated_at";
    sourceKinds?: string[];
    archived?: boolean;
  }): Promise<any> {
    return this.rpc.request("thread/list", {
      limit: params?.limit ?? 100,
      cursor: params?.cursor ?? null,
      cwd: params?.cwd ?? null,
      searchTerm: params?.searchTerm ?? null,
      sortKey: params?.sortKey ?? "updated_at",
      sourceKinds: params?.sourceKinds ?? ["cli", "vscode", "appServer", "unknown"],
      archived: params?.archived ?? false,
    });
  }

  turnInterrupt(threadId: string, turnId: string): Promise<any> {
    return this.rpc.request("turn/interrupt", { threadId, turnId });
  }

  modelList(): Promise<{ data: AvailableModel[]; nextCursor: string | null }> {
    return this.rpc.request("model/list", {
      includeHidden: false,
      limit: 50,
    });
  }

  respond(requestId: string | number, result: unknown): void {
    this.rpc.respond(requestId, result);
  }

  respondError(requestId: string | number, message: string, code: number = -32601): void {
    this.rpc.respondError(requestId, code, message);
  }

  close(): Promise<void> {
    return this.rpc.close();
  }
}
