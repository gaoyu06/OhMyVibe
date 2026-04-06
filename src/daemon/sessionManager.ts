import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  CodexHistoryEntry,
  CreateSessionInput,
  DaemonConfig,
  DaemonEvent,
  RestoreSessionInput,
  SessionDetails,
  SessionStatus,
  SessionSummary,
  TranscriptEntry,
} from "../shared/types.js";
import { CodexAppServerClient } from "./codexAppServerClient.js";
import { SessionStore } from "./sessionStore.js";

interface ManagedSession {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  origin: "created" | "restored";
  model?: string;
  reasoningEffort?: string;
  codexThreadId?: string;
  codexPath?: string;
  codexSource?: string;
  lastError?: string;
  transcript: TranscriptEntry[];
  codex?: CodexAppServerClient;
  liveMessages: Map<string, TranscriptEntry>;
  liveReasoning: Map<string, TranscriptEntry>;
}

export class SessionManager extends EventEmitter<{ event: [DaemonEvent] }> {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly store = new SessionStore();
  private configCache?: DaemonConfig;

  constructor() {
    super();
    this.restorePersistedSessions();
  }

  list(): SessionSummary[] {
    return Array.from(this.sessions.values())
      .map((session) => this.toSummary(session))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(sessionId: string): SessionDetails | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    return {
      ...this.toSummary(session),
      transcript: [...session.transcript],
    };
  }

  async getConfig(): Promise<DaemonConfig> {
    if (this.configCache) {
      return this.configCache;
    }

    const config = await this.readConfig();
    this.configCache = config;
    return config;
  }

  async listHistory(): Promise<CodexHistoryEntry[]> {
    const client = new CodexAppServerClient({ cwd: process.cwd() });
    try {
      await client.initialize();
      const response = await client.threadList({
        limit: 200,
        sortKey: "updated_at",
        sourceKinds: ["cli", "vscode", "appServer", "unknown"],
      });

      return Array.isArray(response?.data)
        ? response.data.map((thread: any) => ({
            id: thread.id,
            title: thread.name || thread.preview || path.basename(thread.cwd || "") || "Codex Session",
            cwd: thread.cwd || "",
            createdAt: this.toIsoFromUnixSeconds(thread.createdAt),
            updatedAt: this.toIsoFromUnixSeconds(thread.updatedAt),
            status: thread.status?.type || "unknown",
            path: thread.path,
            source: thread.source,
            modelProvider: thread.modelProvider,
          }))
        : [];
    } finally {
      await client.close();
    }
  }

  async create(input: CreateSessionInput): Promise<SessionDetails> {
    const sessionId = randomUUID();
    const cwd = path.resolve(input.cwd);
    const now = new Date().toISOString();

    const session: ManagedSession = {
      id: sessionId,
      title: path.basename(cwd) || "Codex Session",
      cwd,
      createdAt: now,
      updatedAt: now,
      status: "starting",
      origin: "created",
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      transcript: [],
      liveMessages: new Map(),
      liveReasoning: new Map(),
    };

    this.sessions.set(sessionId, session);
    this.persist();
    this.emitChange({ type: "session-created", session: this.toSummary(session) });

    try {
      await this.startFreshThread(session, input);
      return this.getOrThrow(sessionId);
    } catch (error) {
      session.status = "failed";
      session.lastError = this.errorMessage(error);
      this.addEntry(session, {
        kind: "system",
        text: `Session startup failed: ${session.lastError}`,
        status: "failed",
      });
      this.persist();
      this.emitChange({ type: "session-updated", session: this.toSummary(session) });
      return this.getOrThrow(sessionId);
    }
  }

  async restore(input: RestoreSessionInput): Promise<SessionDetails> {
    const existing = Array.from(this.sessions.values()).find(
      (session) => session.codexThreadId === input.threadId,
    );
    if (existing) {
      await this.ensureCodexClient(existing, input);
      return this.getOrThrow(existing.id);
    }

    const cwd = path.resolve(input.cwd ?? process.cwd());
    const now = new Date().toISOString();
    const session: ManagedSession = {
      id: randomUUID(),
      title: "Restored Session",
      cwd,
      createdAt: now,
      updatedAt: now,
      status: "starting",
      origin: "restored",
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      codexThreadId: input.threadId,
      transcript: [],
      liveMessages: new Map(),
      liveReasoning: new Map(),
    };

    this.sessions.set(session.id, session);
    this.persist();
    this.emitChange({ type: "session-created", session: this.toSummary(session) });

    try {
      await this.ensureCodexClient(session, input);
      return this.getOrThrow(session.id);
    } catch (error) {
      session.status = "failed";
      session.lastError = this.errorMessage(error);
      this.addEntry(session, {
        kind: "system",
        text: `Session restore failed: ${session.lastError}`,
        status: "failed",
      });
      this.persist();
      this.emitChange({ type: "session-updated", session: this.toSummary(session) });
      return this.getOrThrow(session.id);
    }
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);
    await this.ensureCodexClient(session);
    if (!session.codex || !session.codexThreadId) {
      throw new Error("Session is not ready");
    }

    this.addEntry(session, { kind: "user", text });
    session.status = "running";
    this.persist();
    this.emitChange({ type: "session-updated", session: this.toSummary(session) });
    await session.codex.turnStart(session.codexThreadId, text, session.reasoningEffort);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);
    if (!session.codexThreadId) {
      return;
    }
    await this.ensureCodexClient(session);
    if (!session.codex) {
      return;
    }
    await session.codex.turnInterrupt(session.codexThreadId);
    session.status = "interrupted";
    this.touch(session);
    this.persist();
    this.emitChange({ type: "session-updated", session: this.toSummary(session) });
  }

  async close(sessionId: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);
    session.status = "closed";
    if (session.codex) {
      await session.codex.close();
    }
    this.sessions.delete(sessionId);
    this.persist();
    this.emitChange({ type: "session-deleted", sessionId });
  }

  private restorePersistedSessions(): void {
    for (const persisted of this.store.load()) {
      this.sessions.set(persisted.id, {
        id: persisted.id,
        title: persisted.title,
        cwd: persisted.cwd,
        createdAt: persisted.createdAt,
        updatedAt: persisted.updatedAt,
        status: persisted.status === "closed" ? "idle" : persisted.status,
        origin: persisted.origin ?? "created",
        model: persisted.model,
        reasoningEffort: persisted.reasoningEffort,
        codexThreadId: persisted.codexThreadId,
        codexPath: persisted.codexPath,
        codexSource: persisted.codexSource,
        lastError: persisted.lastError,
        transcript: Array.isArray(persisted.transcript) ? persisted.transcript : [],
        liveMessages: new Map(),
        liveReasoning: new Map(),
      });
    }
  }

  private persist(): void {
    this.store.save(
      Array.from(this.sessions.values())
        .map((session) => this.get(session.id))
        .filter((session): session is SessionDetails => Boolean(session)),
    );
  }

  private async startFreshThread(session: ManagedSession, input: CreateSessionInput): Promise<void> {
    const codex = new CodexAppServerClient({ cwd: session.cwd });
    session.codex = codex;
    this.attachCodexHooks(session, codex);
    await codex.initialize();

    const response = await codex.threadStart({
      cwd: session.cwd,
      model: input.model,
      sandbox: input.sandbox,
      approvalPolicy: input.approvalPolicy,
    });

    session.codexThreadId = response.thread.id;
    session.codexPath = response.thread.path;
    session.codexSource = response.thread.source;
    session.model = response.model;
    session.reasoningEffort = input.reasoningEffort ?? response.reasoningEffort ?? "medium";
    session.status = "idle";
    session.title = response.thread.preview || session.title;
    this.touch(session);
    this.persist();
    this.emitChange({ type: "session-updated", session: this.toSummary(session) });
  }

  private async ensureCodexClient(
    session: ManagedSession,
    overrides?: Partial<CreateSessionInput & RestoreSessionInput>,
  ): Promise<void> {
    if (session.codex && session.codexThreadId) {
      return;
    }

    if (!session.codexThreadId) {
      await this.startFreshThread(session, {
        cwd: session.cwd,
        model: overrides?.model ?? session.model,
        reasoningEffort: this.normalizeReasoningEffort(
          overrides?.reasoningEffort ?? session.reasoningEffort,
        ),
        sandbox: overrides?.sandbox,
        approvalPolicy: overrides?.approvalPolicy,
      });
      return;
    }

    const codex = new CodexAppServerClient({ cwd: session.cwd });
    session.codex = codex;
    this.attachCodexHooks(session, codex);
    await codex.initialize();

    const response = await codex.threadResume({
      threadId: session.codexThreadId,
      cwd: overrides?.cwd ?? session.cwd,
      model: overrides?.model ?? session.model,
      sandbox: overrides?.sandbox,
      approvalPolicy: overrides?.approvalPolicy,
    });

    session.cwd = response.cwd || session.cwd;
    session.model = response.model || session.model;
    session.reasoningEffort = this.normalizeReasoningEffort(
      overrides?.reasoningEffort ?? response.reasoningEffort ?? session.reasoningEffort,
    );
    session.codexPath = response.thread?.path || session.codexPath;
    session.codexSource = response.thread?.source || session.codexSource;
    session.title = response.thread?.name || response.thread?.preview || session.title;
    session.status = this.mapThreadStatus(response.thread?.status);
    session.transcript = this.threadToTranscript(response.thread);
    session.liveMessages.clear();
    session.liveReasoning.clear();
    this.touch(session);
    this.persist();
    this.emitChange({
      type: "session-reset",
      sessionId: session.id,
      transcript: [...session.transcript],
    });
    this.emitChange({ type: "session-updated", session: this.toSummary(session) });
  }

  private attachCodexHooks(session: ManagedSession, codex: CodexAppServerClient): void {
    codex.onNotification(async (notification) => {
      try {
        await this.handleNotification(session, notification);
      } catch (error) {
        session.lastError = this.errorMessage(error);
        session.status = "failed";
        this.addEntry(session, {
          kind: "system",
          text: `Notification handling failed: ${session.lastError}`,
          status: "failed",
        });
        this.persist();
        this.emitChange({ type: "session-updated", session: this.toSummary(session) });
      }
    });

    codex.onStderr((chunk) => {
      const text = this.cleanStderr(chunk);
      if (!text || this.shouldIgnoreStderr(text)) {
        return;
      }
      this.addEntry(session, {
        kind: "system",
        text,
        status: "stderr",
      });
    });

    codex.onExit(({ code, signal }) => {
      session.codex = undefined;
      if (session.status === "closed") {
        return;
      }
      session.status = "failed";
      session.lastError = `Codex process exited (code=${code}, signal=${signal})`;
      this.addEntry(session, {
        kind: "system",
        text: session.lastError,
        status: "failed",
      });
      this.persist();
      this.emitChange({ type: "session-updated", session: this.toSummary(session) });
    });
  }

  private async handleNotification(
    session: ManagedSession,
    notification: { method: string; params?: any },
  ): Promise<void> {
    switch (notification.method) {
      case "thread/started": {
        const preview = notification.params?.thread?.preview;
        session.codexPath = notification.params?.thread?.path || session.codexPath;
        session.codexSource = notification.params?.thread?.source || session.codexSource;
        if (typeof preview === "string" && preview.trim()) {
          session.title = preview.trim();
        }
        this.touch(session);
        this.persist();
        this.emitChange({ type: "session-updated", session: this.toSummary(session) });
        return;
      }
      case "thread/nameUpdated": {
        const title = notification.params?.name;
        if (typeof title === "string" && title.trim()) {
          session.title = title.trim();
          this.touch(session);
          this.persist();
          this.emitChange({ type: "session-updated", session: this.toSummary(session) });
        }
        return;
      }
      case "thread/statusChanged": {
        session.status = this.mapThreadStatus(notification.params?.status);
        this.touch(session);
        this.persist();
        this.emitChange({ type: "session-updated", session: this.toSummary(session) });
        return;
      }
      case "turn/started": {
        session.status = "running";
        this.touch(session);
        this.persist();
        this.emitChange({ type: "session-updated", session: this.toSummary(session) });
        return;
      }
      case "item/started": {
        const item = notification.params?.item;
        if (item?.type === "agentMessage") {
          const entry = this.ensureAssistantEntry(session, item.id);
          entry.status = "streaming";
        }
        this.touch(session);
        this.persist();
        this.emitChange({ type: "session-updated", session: this.toSummary(session) });
        return;
      }
      case "item/agentMessage/delta": {
        const itemId = notification.params?.itemId;
        const delta = notification.params?.delta;
        if (typeof itemId === "string" && typeof delta === "string") {
          const entry = this.ensureAssistantEntry(session, itemId);
          entry.text += delta;
          entry.status = "streaming";
          this.touch(session);
          this.persist();
          this.emitChange({
            type: "session-reset",
            sessionId: session.id,
            transcript: [...session.transcript],
          });
        }
        return;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const itemId = notification.params?.itemId;
        const delta = notification.params?.delta;
        if (typeof itemId === "string" && typeof delta === "string") {
          const entry = this.ensureReasoningEntry(session, itemId);
          entry.text += delta;
          entry.status = "streaming";
          this.touch(session);
          this.persist();
          this.emitChange({
            type: "session-reset",
            sessionId: session.id,
            transcript: [...session.transcript],
          });
        }
        return;
      }
      case "turn/completed": {
        const turn = notification.params?.turn;
        session.status = this.mapTurnStatus(turn?.status);
        for (const entry of session.liveMessages.values()) {
          entry.status = "completed";
        }
        for (const [itemId, entry] of session.liveReasoning.entries()) {
          if (entry.text.trim()) {
            entry.status = "completed";
            continue;
          }
          session.transcript = session.transcript.filter((item) => item.id !== itemId);
        }
        session.liveMessages.clear();
        session.liveReasoning.clear();
        this.touch(session);
        this.persist();
        this.emitChange({
          type: "session-reset",
          sessionId: session.id,
          transcript: [...session.transcript],
        });
        this.emitChange({ type: "session-updated", session: this.toSummary(session) });
        return;
      }
      case "item/completed": {
        if (notification.params?.item?.type === "userMessage") {
          return;
        }
        const entry = this.itemToEntry(notification.params?.item);
        if (!entry) {
          return;
        }
        this.upsertEntry(session, entry);
        return;
      }
      default:
        return;
    }
  }

  private threadToTranscript(thread: any): TranscriptEntry[] {
    if (!thread || !Array.isArray(thread.turns)) {
      return [];
    }

    const createdAt = this.toIsoFromUnixSeconds(thread.createdAt) || new Date().toISOString();
    const transcript: TranscriptEntry[] = [];
    let offset = 0;

    for (const turn of thread.turns) {
      if (!Array.isArray(turn?.items)) {
        continue;
      }

      for (const item of turn.items) {
        const entry = this.itemToEntry(
          item,
          new Date(new Date(createdAt).getTime() + offset * 1000).toISOString(),
        );
        offset += 1;
        if (entry) {
          transcript.push(entry);
        }
      }
    }

    return transcript;
  }

  private itemToEntry(item: any, createdAt: string = new Date().toISOString()): TranscriptEntry | undefined {
    switch (item?.type) {
      case "userMessage": {
        const text = Array.isArray(item.content)
          ? item.content
              .filter((part: any) => part?.type === "text")
              .map((part: any) => part.text)
              .join("\n")
          : "";
        return {
          id: item.id,
          kind: "user",
          text,
          createdAt,
        };
      }
      case "agentMessage":
        return {
          id: item.id,
          kind: "assistant",
          text: item.text ?? "",
          phase: item.phase ?? undefined,
          status: "completed",
          createdAt,
        };
      case "reasoning":
        if (!this.extractRichText(item).trim()) {
          return undefined;
        }
        return {
          id: item.id,
          kind: "reasoning",
          text: this.extractRichText(item),
          status: "completed",
          createdAt,
        };
      case "commandExecution":
        return {
          id: item.id,
          kind: "command",
          text: `${item.command}\n\n${item.aggregatedOutput ?? ""}`.trim(),
          status: item.status,
          createdAt,
          meta: {
            cwd: item.cwd,
            exitCode: item.exitCode,
          },
        };
      case "fileChange":
        return {
          id: item.id,
          kind: "file_change",
          text: Array.isArray(item.changes)
            ? item.changes.map((change: any) => `${change.path}\n${change.diff}`).join("\n\n")
            : "",
          status: item.status,
          createdAt,
        };
      case "mcpToolCall":
      case "dynamicToolCall":
      case "webSearch":
        return {
          id: item.id,
          kind: "tool",
          text: JSON.stringify(item, null, 2),
          status: item.status ?? "completed",
          createdAt,
        };
      case "plan":
        return {
          id: item.id,
          kind: "system",
          text: item.text ?? "",
          createdAt,
          status: "completed",
        };
      case "enteredReviewMode":
      case "exitedReviewMode":
      case "contextCompaction":
        return {
          id: item.id,
          kind: "system",
          text: JSON.stringify(item, null, 2),
          createdAt,
        };
      default:
        return undefined;
    }
  }

  private addEntry(
    session: ManagedSession,
    input: Omit<TranscriptEntry, "id" | "createdAt">,
  ): TranscriptEntry {
    const entry: TranscriptEntry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input,
    };
    session.transcript.push(entry);
    this.touch(session);
    this.persist();
    this.emitChange({ type: "session-entry", sessionId: session.id, entry });
    this.emitChange({ type: "session-updated", session: this.toSummary(session) });
    return entry;
  }

  private upsertEntry(session: ManagedSession, entry: TranscriptEntry): void {
    const existingIndex = session.transcript.findIndex((item) => item.id === entry.id);
    if (existingIndex === -1) {
      session.transcript.push(entry);
    } else {
      session.transcript[existingIndex] = {
        ...session.transcript[existingIndex],
        ...entry,
      };
    }

    this.touch(session);
    this.persist();
    this.emitChange({
      type: "session-reset",
      sessionId: session.id,
      transcript: [...session.transcript],
    });
    this.emitChange({ type: "session-updated", session: this.toSummary(session) });
  }

  private touch(session: ManagedSession): void {
    session.updatedAt = new Date().toISOString();
  }

  private emitChange(event: DaemonEvent): void {
    this.emit("event", event);
  }

  private toSummary(session: ManagedSession): SessionSummary {
    return {
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status: session.status,
      origin: session.origin,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      codexThreadId: session.codexThreadId,
      codexPath: session.codexPath,
      codexSource: session.codexSource,
      lastError: session.lastError,
      transcriptCount: session.transcript.length,
    };
  }

  private getSessionOrThrow(sessionId: string): ManagedSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  private getOrThrow(sessionId: string): SessionDetails {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  private mapThreadStatus(status: any): SessionStatus {
    switch (status?.type) {
      case "idle":
      case "notLoaded":
        return "idle";
      case "active":
        return "running";
      case "systemError":
        return "failed";
      default:
        return "idle";
    }
  }

  private mapTurnStatus(status: string | undefined): SessionStatus {
    switch (status) {
      case "completed":
        return "completed";
      case "interrupted":
        return "interrupted";
      case "failed":
        return "failed";
      case "inProgress":
        return "running";
      default:
        return "idle";
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private cleanStderr(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, "").trim();
  }

  private shouldIgnoreStderr(text: string): boolean {
    return (
      text.includes("rmcp::transport::worker") &&
      text.includes("data did not match any variant of untagged enum JsonRpcMessage")
    );
  }

  private async readConfig(): Promise<DaemonConfig> {
    const cwd = process.cwd();
    const client = new CodexAppServerClient({ cwd });
    try {
      await client.initialize();
      const response = await client.modelList();
      const models = response.data;
      return {
        models,
        defaultModel: models.find((model: any) => model.isDefault)?.model ?? models[0]?.model,
      };
    } finally {
      await client.close();
    }
  }

  private ensureAssistantEntry(session: ManagedSession, itemId: string): TranscriptEntry {
    let entry = session.liveMessages.get(itemId);
    if (!entry) {
      entry = {
        id: itemId,
        kind: "assistant",
        text: "",
        createdAt: new Date().toISOString(),
        status: "streaming",
      };
      session.liveMessages.set(itemId, entry);
      session.transcript.push(entry);
      this.persist();
      this.emitChange({ type: "session-entry", sessionId: session.id, entry });
    }
    return entry;
  }

  private ensureReasoningEntry(session: ManagedSession, itemId: string): TranscriptEntry {
    let entry = session.liveReasoning.get(itemId);
    if (!entry) {
      entry = {
        id: itemId,
        kind: "reasoning",
        text: "",
        createdAt: new Date().toISOString(),
        status: "streaming",
      };
      session.liveReasoning.set(itemId, entry);
      session.transcript.push(entry);
      this.persist();
      this.emitChange({ type: "session-entry", sessionId: session.id, entry });
    }
    return entry;
  }

  private extractRichText(item: any): string {
    const fromContent = this.flattenText(item?.content);
    const fromSummary = this.flattenText(item?.summary);
    return [fromContent, fromSummary].filter(Boolean).join("\n").trim();
  }

  private flattenText(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }
    if (!Array.isArray(value)) {
      return "";
    }
    return value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  private toIsoFromUnixSeconds(value: unknown): string {
    return typeof value === "number" && Number.isFinite(value)
      ? new Date(value * 1000).toISOString()
      : new Date().toISOString();
  }

  private normalizeReasoningEffort(value: unknown):
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | undefined {
    switch (value) {
      case "none":
      case "minimal":
      case "low":
      case "medium":
      case "high":
      case "xhigh":
        return value;
      default:
        return "medium";
    }
  }
}
