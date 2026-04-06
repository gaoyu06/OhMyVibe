import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type AgentSideConnection as AgentConnection,
} from "@agentclientprotocol/sdk";
import { SessionManager } from "../daemon/sessionManager.js";

class OhMyVibeAcpAgent implements Agent {
  constructor(
    private readonly connection: AgentConnection,
    private readonly sessions: SessionManager,
    private readonly acpToManaged = new Map<string, string>(),
  ) {}

  async initialize(): Promise<any> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async newSession(params: any): Promise<any> {
    const session = await this.sessions.create({
      cwd: params.cwd,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    this.acpToManaged.set(session.id, session.id);
    return { sessionId: session.id };
  }

  async authenticate(): Promise<any> {
    return {};
  }

  async prompt(params: any): Promise<any> {
    const managedId = this.resolveSession(params.sessionId);
    const text = (params.prompt ?? [])
      .filter((block: any) => block?.type === "text")
      .map((block: any) => block.text)
      .join("\n");

    await this.sessions.sendMessage(managedId, text);

    const listener = async (event: any) => {
      if (event.type !== "session-entry" || event.sessionId !== managedId) {
        return;
      }

      if (event.entry.kind === "assistant") {
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: event.entry.text,
            },
          },
        });
      }
    };

    this.sessions.on("event", listener);

    try {
      while (true) {
        const session = this.sessions.get(managedId);
        const status = session?.status;
        if (
          !session ||
          (status !== undefined && ["completed", "interrupted", "failed", "idle"].includes(status))
        ) {
          return {
            stopReason: status === "interrupted" ? "cancelled" : "end_turn",
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } finally {
      this.sessions.off("event", listener);
    }
  }

  async cancel(params: any): Promise<void> {
    const managedId = this.resolveSession(params.sessionId);
    await this.sessions.interrupt(managedId);
  }

  private resolveSession(sessionId: string): string {
    const managedId = this.acpToManaged.get(sessionId) ?? sessionId;
    const session = this.sessions.get(managedId);
    if (!session) {
      throw new Error(`ACP session not found: ${sessionId}`);
    }
    return managedId;
  }
}

const sessionManager = new SessionManager();
const input = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
const output = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
const stream = ndJsonStream(input, output);

new AgentSideConnection(
  (connection) => new OhMyVibeAcpAgent(connection, sessionManager),
  stream,
);
