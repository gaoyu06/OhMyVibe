import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import { Buffer } from "node:buffer";
import path from "node:path";
import {
  CodexHistoryEntry,
  CreateSessionInput,
  DaemonConfig,
  DaemonEvent,
  DirectoryBrowseResult,
  ProjectFileBrowseResult,
  ProjectFileReadResult,
  RenameSessionInput,
  RestoreSessionInput,
  SessionDetails,
  SessionStatus,
  SessionSummary,
  TranscriptEntry,
  UpdateSessionConfigInput,
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
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  codexThreadId?: string;
  codexPath?: string;
  codexSource?: string;
  lastError?: string;
  transcript: TranscriptEntry[];
  codex?: CodexAppServerClient;
  liveMessages: Map<string, TranscriptEntry>;
  liveReasoning: Map<string, TranscriptEntry>;
  pendingApprovals: Map<
    string,
    {
      entryId: string;
      requestIdRaw: string | number;
      method: string;
      params: any;
    }
  >;
  configDirty?: boolean;
  suppressNextExitFailure?: boolean;
  startupPromise?: Promise<void>;
  activeTurnId?: string;
  currentTurnMetrics?: {
    startedAt: number;
    firstOutputAt?: number;
    outputEntryIds: Set<string>;
  };
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

  async browseDirectories(inputPath?: string): Promise<DirectoryBrowseResult> {
    if (process.platform === "win32" && (!inputPath || !inputPath.trim())) {
      return this.listWindowsRoots();
    }

    const requestedPath = inputPath && inputPath.trim() ? inputPath.trim() : process.cwd();
    const currentPath = path.resolve(requestedPath);
    const stat = await fs.stat(currentPath);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${currentPath}`);
    }

    const entries = (await fs.readdir(currentPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(currentPath, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      currentPath,
      parentPath: this.resolveParentPath(currentPath),
      entries,
    };
  }

  async browseSessionFiles(sessionId: string, inputPath?: string): Promise<ProjectFileBrowseResult> {
    const session = this.getSessionOrThrow(sessionId);
    const currentPath = this.resolveSessionPath(session, inputPath ?? session.cwd);
    const stat = await fs.stat(currentPath);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${currentPath}`);
    }

    const entries = (await fs.readdir(currentPath, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith(".git"))
      .map((entry) => {
        const entryPath = path.join(currentPath, entry.name);
        return {
          name: entry.name,
          path: entryPath,
          kind: entry.isDirectory() ? "directory" : "file",
        } as const;
      })
      .sort((a, b) => {
        if (a.kind !== b.kind) {
          return a.kind === "directory" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

    const enrichedEntries = await Promise.all(
      entries.map(async (entry) => {
        if (entry.kind === "directory") {
          return entry;
        }
        try {
          const fileStat = await fs.stat(entry.path);
          return { ...entry, size: fileStat.size };
        } catch {
          return entry;
        }
      }),
    );

    return {
      currentPath,
      parentPath:
        currentPath === session.cwd ? undefined : this.resolveParentPath(currentPath),
      entries: enrichedEntries,
    };
  }

  async readSessionFile(sessionId: string, filePath: string): Promise<ProjectFileReadResult> {
    const session = this.getSessionOrThrow(sessionId);
    const resolvedPath = this.resolveSessionPath(session, filePath);
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${resolvedPath}`);
    }

    const size = stat.size;
    const extension = path.extname(resolvedPath).toLowerCase();
    const mimeType = this.getMimeType(extension);
    const buffer = await fs.readFile(resolvedPath);

    if (mimeType?.startsWith("image/")) {
      return {
        path: resolvedPath,
        kind: "image",
        mimeType,
        content: `data:${mimeType};base64,${buffer.toString("base64")}`,
        size,
      };
    }

    if (this.isTextFile(extension, buffer)) {
      return {
        path: resolvedPath,
        kind: "text",
        mimeType: mimeType ?? "text/plain",
        content: buffer.toString("utf8"),
        size,
      };
    }

    return {
      path: resolvedPath,
      kind: "binary",
      mimeType,
      content: "",
      size,
    };
  }

  async writeSessionFile(sessionId: string, filePath: string, content: string): Promise<ProjectFileReadResult> {
    const session = this.getSessionOrThrow(sessionId);
    const resolvedPath = this.resolveSessionPath(session, filePath);
    await fs.writeFile(resolvedPath, content, "utf8");
    return this.readSessionFile(sessionId, resolvedPath);
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
      sandbox: input.sandbox ?? "workspace-write",
      approvalPolicy: input.approvalPolicy ?? "never",
      transcript: [],
      liveMessages: new Map(),
      liveReasoning: new Map(),
      pendingApprovals: new Map(),
    };

    this.sessions.set(sessionId, session);
    this.persist();
    this.emitChange({ type: "session-created", session: this.toSummary(session) });
    session.startupPromise = this.trackStartup(session, this.startSessionInBackground(session, input));
    return this.getOrThrow(sessionId);
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
      sandbox: input.sandbox ?? "workspace-write",
      approvalPolicy: input.approvalPolicy ?? "never",
      codexThreadId: input.threadId,
      transcript: [],
      liveMessages: new Map(),
      liveReasoning: new Map(),
      pendingApprovals: new Map(),
    };

    this.sessions.set(session.id, session);
    this.persist();
    this.emitChange({ type: "session-created", session: this.toSummary(session) });
    session.startupPromise = this.trackStartup(session, this.restoreSessionInBackground(session, input));
    return this.getOrThrow(session.id);
  }

  async updateConfig(sessionId: string, input: UpdateSessionConfigInput): Promise<SessionDetails> {
    const session = this.getSessionOrThrow(sessionId);
    const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : session.model;
    const reasoningEffort = this.normalizeReasoningEffort(
      input.reasoningEffort ?? session.reasoningEffort,
    );
    const sandbox = input.sandbox ?? session.sandbox ?? "workspace-write";
    const approvalPolicy = input.approvalPolicy ?? session.approvalPolicy ?? "never";
    const runtimeChanged = sandbox !== session.sandbox;

    session.model = model;
    session.reasoningEffort = reasoningEffort;
    session.sandbox = sandbox;
    session.approvalPolicy = approvalPolicy;
    session.configDirty = session.configDirty || runtimeChanged;
    this.touch(session);
    this.persist();
    this.emitChange({ type: "session-updated", session: this.toSummary(session) });

    if (session.status !== "running" && session.status !== "starting") {
      await this.applyPendingConfig(session);
    }

    return this.getOrThrow(sessionId);
  }

  async rename(sessionId: string, input: RenameSessionInput): Promise<SessionDetails> {
    const session = this.getSessionOrThrow(sessionId);
    const nextTitle = typeof input.title === "string" ? input.title.trim() : "";
    if (!nextTitle) {
      throw new Error("Session title is required");
    }

    session.title = nextTitle;
    this.touch(session);
    this.persist();
    this.emitChange({ type: "session-updated", session: this.toSummary(session) });
    return this.getOrThrow(sessionId);
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);
    await this.applyPendingConfig(session);
    await this.ensureCodexClient(session);
    if (!session.codex || !session.codexThreadId) {
      throw new Error("Session is not ready");
    }

    this.addEntry(session, { kind: "user", text });
    session.status = "running";
    session.currentTurnMetrics = {
      startedAt: Date.now(),
      outputEntryIds: new Set(),
    };
    this.persist();
    this.emitChange({ type: "session-updated", session: this.toSummary(session) });
    void this.startTurnInBackground(session, text);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);
    if (!session.codexThreadId || !session.activeTurnId) {
      return;
    }
    await this.ensureCodexClient(session);
    if (!session.codex) {
      return;
    }
    await session.codex.turnInterrupt(session.codexThreadId, session.activeTurnId);
    session.status = "interrupted";
    session.activeTurnId = undefined;
    this.touch(session);
    this.persist();
    this.emitChange({ type: "session-updated", session: this.toSummary(session) });
  }

  async respondApproval(
    sessionId: string,
    approvalRequestId: string,
    decision: "approve" | "deny",
  ): Promise<SessionDetails> {
    const session = this.getSessionOrThrow(sessionId);
    const pending = session.pendingApprovals.get(approvalRequestId);
    if (!pending || !session.codex) {
      throw new Error(`Approval request not found: ${approvalRequestId}`);
    }

    const response = this.mapApprovalResponse(pending.method, pending.params, decision);
    session.codex.respond(pending.requestIdRaw, response);
    session.pendingApprovals.delete(approvalRequestId);

    const entry = session.transcript.find((item) => item.id === pending.entryId);
    if (entry) {
      entry.status = decision === "approve" ? "approved" : "declined";
      entry.meta = {
        ...(entry.meta ?? {}),
        resolvedAt: new Date().toISOString(),
        decision,
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
    return this.getOrThrow(sessionId);
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
        sandbox: persisted.sandbox,
        approvalPolicy: persisted.approvalPolicy,
        codexThreadId: persisted.codexThreadId,
        codexPath: persisted.codexPath,
        codexSource: persisted.codexSource,
        lastError: persisted.lastError,
        transcript: Array.isArray(persisted.transcript) ? persisted.transcript : [],
        liveMessages: new Map(),
        liveReasoning: new Map(),
        pendingApprovals: new Map(),
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

  private async startSessionInBackground(
    session: ManagedSession,
    input: CreateSessionInput,
  ): Promise<void> {
    try {
      await this.startFreshThread(session, input);
    } catch (error) {
      session.activeTurnId = undefined;
      session.status = "failed";
      session.lastError = this.errorMessage(error);
      this.addEntry(session, {
        kind: "system",
        text: `Session startup failed: ${session.lastError}`,
        status: "failed",
      });
      this.persist();
      this.emitChange({ type: "session-updated", session: this.toSummary(session) });
    }
  }

  private async restoreSessionInBackground(
    session: ManagedSession,
    input: RestoreSessionInput,
  ): Promise<void> {
    try {
      await this.ensureCodexClient(session, input);
    } catch (error) {
      session.activeTurnId = undefined;
      session.status = "failed";
      session.lastError = this.errorMessage(error);
      this.addEntry(session, {
        kind: "system",
        text: `Session restore failed: ${session.lastError}`,
        status: "failed",
      });
      this.persist();
      this.emitChange({ type: "session-updated", session: this.toSummary(session) });
    }
  }

  private async startTurnInBackground(session: ManagedSession, text: string): Promise<void> {
    if (!session.codex || !session.codexThreadId) {
      session.activeTurnId = undefined;
      session.status = "failed";
      session.lastError = "Session is not ready";
      this.addEntry(session, {
        kind: "system",
        text: `Turn start failed: ${session.lastError}`,
        status: "failed",
      });
      this.persist();
      this.emitChange({ type: "session-updated", session: this.toSummary(session) });
      return;
    }

    try {
      const response = await session.codex.turnStart({
        threadId: session.codexThreadId,
        text,
        effort: session.reasoningEffort,
        model: session.model,
        approvalPolicy: session.approvalPolicy,
        summary: "detailed",
      });
      if (typeof response?.turn?.id === "string") {
        session.activeTurnId = response.turn.id;
      }
    } catch (error) {
      session.activeTurnId = undefined;
      session.currentTurnMetrics = undefined;
      session.status = "failed";
      session.lastError = this.errorMessage(error);
      this.addEntry(session, {
        kind: "system",
        text: `Turn start failed: ${session.lastError}`,
        status: "failed",
      });
      this.persist();
      this.emitChange({ type: "session-updated", session: this.toSummary(session) });
    }
  }

  private async startFreshThread(session: ManagedSession, input: CreateSessionInput): Promise<void> {
    const codex = new CodexAppServerClient({ cwd: session.cwd });
    session.codex = codex;
    this.attachCodexHooks(session, codex);
    await codex.initialize();

    const response = await codex.threadStart({
      cwd: session.cwd,
      model: input.model,
      sandbox: input.sandbox ?? session.sandbox,
      approvalPolicy: input.approvalPolicy ?? session.approvalPolicy,
    });

    session.codexThreadId = response.thread.id;
    session.codexPath = response.thread.path;
    session.codexSource = response.thread.source;
    session.model = response.model;
    session.reasoningEffort = input.reasoningEffort ?? response.reasoningEffort ?? "medium";
    session.sandbox = input.sandbox ?? session.sandbox;
    session.approvalPolicy = input.approvalPolicy ?? session.approvalPolicy;
    session.status = "idle";
    session.title = response.thread.preview || session.title;
    session.configDirty = false;
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

    if (session.startupPromise) {
      await session.startupPromise;
      if (session.codex && session.codexThreadId) {
        return;
      }
    }

    const startup = (async () => {
      if (!session.codexThreadId) {
        await this.startFreshThread(session, {
          cwd: session.cwd,
          model: overrides?.model ?? session.model,
          reasoningEffort: this.normalizeReasoningEffort(
            overrides?.reasoningEffort ?? session.reasoningEffort,
          ),
          sandbox: overrides?.sandbox ?? session.sandbox,
          approvalPolicy: overrides?.approvalPolicy ?? session.approvalPolicy,
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
        sandbox: overrides?.sandbox ?? session.sandbox,
        approvalPolicy: overrides?.approvalPolicy ?? session.approvalPolicy,
      });

      session.cwd = response.cwd || session.cwd;
      session.model = response.model || session.model;
      session.reasoningEffort = this.normalizeReasoningEffort(
        overrides?.reasoningEffort ?? response.reasoningEffort ?? session.reasoningEffort,
      );
      session.sandbox = overrides?.sandbox ?? session.sandbox;
      session.approvalPolicy = overrides?.approvalPolicy ?? session.approvalPolicy;
      session.codexPath = response.thread?.path || session.codexPath;
      session.codexSource = response.thread?.source || session.codexSource;
      session.title = response.thread?.name || response.thread?.preview || session.title;
      session.status = this.mapThreadStatus(response.thread?.status);
      session.transcript = this.threadToTranscript(response.thread);
      session.liveMessages.clear();
      session.liveReasoning.clear();
      session.pendingApprovals.clear();
      session.configDirty = false;
      this.touch(session);
      this.persist();
      this.emitChange({
        type: "session-reset",
        sessionId: session.id,
        transcript: [...session.transcript],
      });
      this.emitChange({ type: "session-updated", session: this.toSummary(session) });
    })();

    session.startupPromise = this.trackStartup(session, startup);
    await session.startupPromise;
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

    codex.onRequest((request) => {
      this.handleCodexRequest(session, request);
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
      session.activeTurnId = undefined;
      session.currentTurnMetrics = undefined;
      if (session.suppressNextExitFailure) {
        session.suppressNextExitFailure = false;
        return;
      }
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
        if (typeof notification.params?.turn?.id === "string") {
          session.activeTurnId = notification.params.turn.id;
        }
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
          this.trackTurnEntry(session, entry);
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
          this.markTurnOutput(session, entry);
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
          this.markTurnOutput(session, entry);
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
      case "item/reasoning/summaryPartAdded": {
        const itemId = notification.params?.itemId;
        if (typeof itemId === "string") {
          this.ensureReasoningEntry(session, itemId);
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
        session.activeTurnId = undefined;
        session.status = this.mapTurnStatus(turn?.status);
        this.finalizeTurnMetrics(session);
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
        session.currentTurnMetrics = undefined;
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
        this.trackTurnEntry(session, entry);
        this.markTurnOutput(session, entry);
        this.upsertEntry(session, entry);
        return;
      }
      default:
        return;
    }
  }

  private handleCodexRequest(
    session: ManagedSession,
    request: { id: string | number; method: string; params?: any },
  ): void {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
      case "execCommandApproval":
      case "applyPatchApproval": {
        const requestId = String(request.id);
        const entry = this.addEntry(session, {
          kind: "approval",
          text: this.describeApprovalRequest(request.method, request.params),
          status: "pending",
          meta: {
            requestId,
            approvalKind: request.method,
            payload: request.params,
          },
        });
        session.pendingApprovals.set(requestId, {
          entryId: entry.id,
          requestIdRaw: request.id,
          method: request.method,
          params: request.params,
        });
        return;
      }
      default:
        session.codex?.respondError(request.id, `Unsupported client request: ${request.method}`);
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
      case "function_call": {
        return {
          id: item.call_id || item.id,
          kind: "tool",
          text: this.formatFunctionCall(item),
          status: item.status ?? "completed",
          createdAt,
          meta: {
            name: item.name,
          },
        };
      }
      case "function_call_output":
        return {
          id: item.call_id || item.id,
          kind: "tool",
          text: this.formatFunctionCallOutput(item),
          status: item.status ?? "completed",
          createdAt,
        };
      case "custom_tool_call":
        return {
          id: item.call_id || item.id,
          kind: "tool",
          text: this.formatCustomToolCall(item),
          status: item.status ?? "completed",
          createdAt,
          meta: {
            name: item.name,
          },
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
      const existing = session.transcript[existingIndex];
      const mergedText =
        existing.kind === "tool" && entry.kind === "tool" && existing.text && entry.text && existing.text !== entry.text
          ? `${existing.text}\n\n${entry.text}`.trim()
          : entry.text || existing.text;
      session.transcript[existingIndex] = {
        ...existing,
        ...entry,
        text: mergedText,
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

  private async applyPendingConfig(session: ManagedSession): Promise<void> {
    if (!session.configDirty || session.status === "running" || session.status === "starting") {
      return;
    }

    if (session.codex) {
      session.suppressNextExitFailure = true;
      await session.codex.close();
      session.codex = undefined;
    }

    await this.ensureCodexClient(session, {
      cwd: session.cwd,
      model: session.model,
      reasoningEffort: this.normalizeReasoningEffort(session.reasoningEffort),
      sandbox: session.sandbox,
      approvalPolicy: session.approvalPolicy,
    });
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
      sandbox: session.sandbox,
      approvalPolicy: session.approvalPolicy,
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
    return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\r/g, "").trim();
  }

  private shouldIgnoreStderr(text: string): boolean {
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
    return (
      (normalized.includes("rmcp::transport::worker") &&
        normalized.includes("data did not match any variant of untagged enum jsonrpcmessage")) ||
      (normalized.includes("rmcp::transport::worker") &&
        normalized.includes("transport channel closed") &&
        normalized.includes("unexpected eof during handshake")) ||
      (normalized.includes("responses_websocket") &&
        normalized.includes("failed to connect to websocket") &&
        normalized.includes("tls handshake eof")) ||
      (normalized.includes("models_manager::manager") &&
        normalized.includes("failed to refresh available models")) ||
      normalized.includes("timeout waiting for child process to exit")
    );
  }

  private describeApprovalRequest(method: string, params: any): string {
    if (method === "item/permissions/requestApproval") {
      const lines = ["Additional permissions requested"];
      if (params?.reason) {
        lines.push(`Reason: ${params.reason}`);
      }
      const payload = this.prettyJson(params?.permissions);
      if (payload) {
        lines.push("", payload);
      }
      return lines.join("\n");
    }

    if (method === "item/commandExecution/requestApproval") {
      const lines = ["Command approval requested"];
      if (params?.command) {
        lines.push(`Command: ${params.command}`);
      }
      if (params?.cwd) {
        lines.push(`Cwd: ${params.cwd}`);
      }
      if (params?.reason) {
        lines.push(`Reason: ${params.reason}`);
      }
      return lines.join("\n");
    }

    if (method === "item/fileChange/requestApproval") {
      const lines = ["File change approval requested"];
      if (params?.grantRoot) {
        lines.push(`Grant root: ${params.grantRoot}`);
      }
      if (params?.reason) {
        lines.push(`Reason: ${params.reason}`);
      }
      return lines.join("\n");
    }

    if (method === "execCommandApproval") {
      const lines = ["Command approval requested"];
      const command = Array.isArray(params?.command) ? params.command.join(" ") : "";
      if (command) {
        lines.push(`Command: ${command}`);
      }
      if (params?.cwd) {
        lines.push(`Cwd: ${params.cwd}`);
      }
      if (params?.reason) {
        lines.push(`Reason: ${params.reason}`);
      }
      return lines.join("\n");
    }

    if (method === "applyPatchApproval") {
      const lines = ["File change approval requested"];
      if (params?.grantRoot) {
        lines.push(`Grant root: ${params.grantRoot}`);
      }
      if (params?.reason) {
        lines.push(`Reason: ${params.reason}`);
      }
      const changes = this.prettyJson(params?.fileChanges);
      if (changes) {
        lines.push("", changes);
      }
      return lines.join("\n");
    }

    return JSON.stringify(params ?? {}, null, 2);
  }

  private mapApprovalResponse(method: string, params: any, decision: "approve" | "deny"): unknown {
    switch (method) {
      case "item/permissions/requestApproval":
        return {
          permissions: decision === "approve" ? (params?.permissions ?? {}) : {},
          scope: "turn",
        };
      case "item/commandExecution/requestApproval":
        return {
          decision: decision === "approve" ? "accept" : "decline",
        };
      case "item/fileChange/requestApproval":
        return {
          decision: decision === "approve" ? "accept" : "decline",
        };
      case "execCommandApproval":
        return {
          decision: decision === "approve" ? "approved" : "denied",
        };
      case "applyPatchApproval":
        return {
          decision: decision === "approve" ? "approved" : "denied",
        };
      default:
        throw new Error(`Unsupported approval method: ${method}`);
    }
  }

  private trackStartup(session: ManagedSession, promise: Promise<void>): Promise<void> {
    const tracked = promise.finally(() => {
      if (session.startupPromise === tracked) {
        session.startupPromise = undefined;
      }
    });
    return tracked;
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
      this.trackTurnEntry(session, entry);
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
      this.trackTurnEntry(session, entry);
      this.persist();
      this.emitChange({ type: "session-entry", sessionId: session.id, entry });
    }
    return entry;
  }

  private trackTurnEntry(session: ManagedSession, entry: TranscriptEntry): void {
    if (!session.currentTurnMetrics || (entry.kind !== "assistant" && entry.kind !== "reasoning")) {
      return;
    }
    session.currentTurnMetrics.outputEntryIds.add(entry.id);
  }

  private markTurnOutput(session: ManagedSession, entry: TranscriptEntry): void {
    if (
      !session.currentTurnMetrics ||
      (entry.kind !== "assistant" && entry.kind !== "reasoning") ||
      !entry.text.trim()
    ) {
      return;
    }

    this.trackTurnEntry(session, entry);
    if (!session.currentTurnMetrics.firstOutputAt) {
      session.currentTurnMetrics.firstOutputAt = Date.now();
    }

    const meta = { ...(entry.meta ?? {}) };
    meta.firstByteMs = Math.max(0, session.currentTurnMetrics.firstOutputAt - session.currentTurnMetrics.startedAt);
    entry.meta = meta;
  }

  private finalizeTurnMetrics(session: ManagedSession): void {
    if (!session.currentTurnMetrics) {
      return;
    }

    const totalMs = Math.max(0, Date.now() - session.currentTurnMetrics.startedAt);
    const firstByteMs = session.currentTurnMetrics.firstOutputAt
      ? Math.max(0, session.currentTurnMetrics.firstOutputAt - session.currentTurnMetrics.startedAt)
      : undefined;

    for (const entryId of session.currentTurnMetrics.outputEntryIds) {
      const entry = session.transcript.find((item) => item.id === entryId);
      if (!entry) {
        continue;
      }

      const meta = { ...(entry.meta ?? {}) };
      if (typeof firstByteMs === "number") {
        meta.firstByteMs = firstByteMs;
      }
      meta.totalMs = totalMs;
      entry.meta = meta;
    }
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

  private formatFunctionCall(item: any): string {
    const name = item?.name || "tool";
    const args = this.prettyJsonString(item?.arguments);
    return args ? `${name}\n\n${args}` : name;
  }

  private formatFunctionCallOutput(item: any): string {
    return String(item?.output ?? "").trim();
  }

  private formatCustomToolCall(item: any): string {
    const name = item?.name || "custom_tool";
    const input = typeof item?.input === "string" ? item.input : this.prettyJson(item?.input);
    return input ? `${name}\n\n${input}` : name;
  }

  private prettyJsonString(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) {
      return "";
    }
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }

  private prettyJson(value: unknown): string {
    if (value === undefined || value === null) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
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

  private async listWindowsRoots(): Promise<DirectoryBrowseResult> {
    const entries: DirectoryBrowseResult["entries"] = [];
    for (let code = 67; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      try {
        const stat = await fs.stat(drive);
        if (stat.isDirectory()) {
          entries.push({ name: drive, path: drive });
        }
      } catch {
        continue;
      }
    }

    return {
      currentPath: path.parse(process.cwd()).root || `${os.homedir().slice(0, 2)}\\`,
      entries,
    };
  }

  private resolveParentPath(currentPath: string): string | undefined {
    const root = path.parse(currentPath).root;
    if (currentPath === root) {
      return undefined;
    }
    const parentPath = path.dirname(currentPath);
    return parentPath && parentPath !== currentPath ? parentPath : undefined;
  }

  private resolveSessionPath(session: ManagedSession, targetPath: string): string {
    const basePath = path.resolve(session.cwd);
    const resolvedPath = path.resolve(targetPath);
    const relative = path.relative(basePath, resolvedPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path is outside session workspace: ${targetPath}`);
    }
    return resolvedPath;
  }

  private getMimeType(extension: string): string | undefined {
    switch (extension) {
      case ".png":
        return "image/png";
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".gif":
        return "image/gif";
      case ".webp":
        return "image/webp";
      case ".svg":
        return "image/svg+xml";
      case ".json":
        return "application/json";
      case ".md":
        return "text/markdown";
      case ".ts":
      case ".tsx":
      case ".js":
      case ".jsx":
      case ".css":
      case ".html":
      case ".py":
      case ".rs":
      case ".go":
      case ".java":
      case ".c":
      case ".cpp":
      case ".h":
      case ".yml":
      case ".yaml":
      case ".toml":
      case ".txt":
        return "text/plain";
      default:
        return undefined;
    }
  }

  private isTextFile(extension: string, buffer: Buffer): boolean {
    const knownTextExtensions = new Set([
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".json",
      ".css",
      ".scss",
      ".html",
      ".md",
      ".txt",
      ".py",
      ".rs",
      ".go",
      ".java",
      ".c",
      ".cpp",
      ".h",
      ".yml",
      ".yaml",
      ".toml",
      ".env",
      ".gitignore",
    ]);

    if (knownTextExtensions.has(extension)) {
      return true;
    }

    const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
    return !sample.includes(0);
  }
}
