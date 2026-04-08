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
  SessionPreviewEntry,
  SessionStatus,
  SessionSummary,
  TranscriptEntry,
  UpdateSessionConfigInput,
} from "../shared/types.js";
import { CodexAppServerClient } from "./codexAppServerClient.js";
import { ManagedSession, SessionRuntime } from "./sessionRuntime.js";
import { SessionStore } from "./sessionStore.js";

export class SessionManager extends EventEmitter<{ event: [DaemonEvent] }> {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly store = new SessionStore();
  private configCache?: DaemonConfig;
  private persistTimer?: NodeJS.Timeout;
  private persistInFlight = false;
  private readonly dirtySessionIds = new Set<string>();
  private readonly deletedSessionIds = new Set<string>();
  private sessionUpdateTimer?: NodeJS.Timeout;
  private readonly pendingSessionUpdates = new Map<string, SessionSummary>();

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
      previewEntries: [],
      liveMessages: new Map(),
      liveReasoning: new Map(),
      pendingApprovals: new Map(),
    };

    this.sessions.set(sessionId, session);
    this.persist(session);
    this.emitChange({ type: "session-created", session: this.toSummary(session) });
    const runtime = this.createRuntime(session);
    session.startupPromise = this.trackSessionStartup(session, this.startSessionInBackground(session, runtime, input));
    return this.getOrThrow(sessionId);
  }

  async restore(input: RestoreSessionInput): Promise<SessionDetails> {
    const existing = Array.from(this.sessions.values()).find(
      (session) => session.codexThreadId === input.threadId,
    );
    if (existing) {
      await this.runtimeFor(existing).restore(input);
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
      previewEntries: [],
      liveMessages: new Map(),
      liveReasoning: new Map(),
      pendingApprovals: new Map(),
    };

    this.sessions.set(session.id, session);
    this.persist(session);
    this.emitChange({ type: "session-created", session: this.toSummary(session) });
    const runtime = this.createRuntime(session);
    session.startupPromise = this.trackSessionStartup(session, this.restoreSessionInBackground(session, runtime, input));
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
    this.persist(session);
    this.emitChange({ type: "session-updated", session: this.toSummary(session) });

    if (session.status !== "running" && session.status !== "starting") {
      await this.runtimeFor(session).applyPendingConfig();
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
    this.persist(session);
    this.emitChange({ type: "session-updated", session: this.toSummary(session) });
    return this.getOrThrow(sessionId);
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);
    await this.runtimeFor(session).sendMessage(text);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);
    await this.runtimeFor(session).interrupt();
  }

  async respondApproval(
    sessionId: string,
    approvalRequestId: string,
    decision: "approve" | "deny",
  ): Promise<SessionDetails> {
    const session = this.getSessionOrThrow(sessionId);
    await this.runtimeFor(session).respondApproval(approvalRequestId, decision);
    return this.getOrThrow(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);
    await this.runtimeFor(session).close();
    this.sessions.delete(sessionId);
    this.runtimes.delete(sessionId);
    this.persistDeletion(sessionId);
    this.emitChange({ type: "session-deleted", sessionId });
  }

  private restorePersistedSessions(): void {
    for (const persisted of this.store.load()) {
      const session: ManagedSession = {
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
        previewEntries: Array.isArray(persisted.previewEntries) ? persisted.previewEntries : [],
        previewDirty: !Array.isArray(persisted.previewEntries),
        liveMessages: new Map(),
        liveReasoning: new Map(),
        pendingApprovals: new Map(),
      };
      this.sessions.set(persisted.id, session);
      this.createRuntime(session);
    }
  }

  private persist(target?: ManagedSession | string): void {
    if (typeof target === "string" && target) {
      this.deletedSessionIds.delete(target);
      this.dirtySessionIds.add(target);
    } else if (target && typeof target !== "string") {
      this.deletedSessionIds.delete(target.id);
      this.dirtySessionIds.add(target.id);
    } else {
      for (const sessionId of this.sessions.keys()) {
        this.deletedSessionIds.delete(sessionId);
        this.dirtySessionIds.add(sessionId);
      }
    }

    this.schedulePersistFlush();
  }

  private persistDeletion(sessionId: string): void {
    this.dirtySessionIds.delete(sessionId);
    this.deletedSessionIds.add(sessionId);
    this.schedulePersistFlush();
  }

  private schedulePersistFlush(): void {
    if (this.persistTimer) {
      return;
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flushPersist();
    }, 120);
  }

  private async flushPersist(): Promise<void> {
    if (this.persistInFlight) {
      return;
    }

    if (!this.dirtySessionIds.size && !this.deletedSessionIds.size) {
      return;
    }

    this.persistInFlight = true;
    const deletedSessionIds = Array.from(this.deletedSessionIds);
    const dirtySessionIds = Array.from(this.dirtySessionIds).filter(
      (sessionId) => !this.deletedSessionIds.has(sessionId),
    );

    this.deletedSessionIds.clear();
    this.dirtySessionIds.clear();

    try {
      for (const sessionId of dirtySessionIds) {
        const session = this.sessions.get(sessionId);
        if (!session) {
          continue;
        }
        await this.store.saveSession(this.serializeSessionForStore(session));
      }

      for (const sessionId of deletedSessionIds) {
        await this.store.deleteSession(sessionId);
      }
    } catch {
      for (const sessionId of dirtySessionIds) {
        if (!this.deletedSessionIds.has(sessionId)) {
          this.dirtySessionIds.add(sessionId);
        }
      }
      for (const sessionId of deletedSessionIds) {
        this.deletedSessionIds.add(sessionId);
        this.dirtySessionIds.delete(sessionId);
      }
    } finally {
      this.persistInFlight = false;
      if (this.dirtySessionIds.size || this.deletedSessionIds.size) {
        this.schedulePersistFlush();
      }
    }
  }

  private async startSessionInBackground(
    session: ManagedSession,
    runtime: SessionRuntime,
    input: CreateSessionInput,
  ): Promise<void> {
    try {
      await runtime.startFreshThread(input);
    } catch (error) {
      session.activeTurnId = undefined;
      session.status = "failed";
      session.lastError = this.errorMessage(error);
      this.addEntry(session, {
        kind: "system",
        text: `Session startup failed: ${session.lastError}`,
        status: "failed",
      });
      this.persist(session);
      this.emitChange({ type: "session-updated", session: this.toSummary(session) });
    }
  }

  private async restoreSessionInBackground(
    session: ManagedSession,
    runtime: SessionRuntime,
    input: RestoreSessionInput,
  ): Promise<void> {
    try {
      await runtime.restore(input);
    } catch (error) {
      session.activeTurnId = undefined;
      session.status = "failed";
      session.lastError = this.errorMessage(error);
      this.addEntry(session, {
        kind: "system",
        text: `Session restore failed: ${session.lastError}`,
        status: "failed",
      });
      this.persist(session);
      this.emitChange({ type: "session-updated", session: this.toSummary(session) });
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
    this.markPreviewDirty(session);
    this.touch(session);
    this.persist(session);
    this.emitChange({ type: "session-entry", sessionId: session.id, entry });
    this.emitChange({ type: "session-updated", session: this.toSummary(session) });
    return entry;
  }

  private upsertEntry(session: ManagedSession, entry: TranscriptEntry): void {
    const existingIndex = session.transcript.findIndex((item) => item.id === entry.id);
    let event: DaemonEvent;
    if (existingIndex === -1) {
      session.transcript.push(entry);
      event = {
        type: "session-entry",
        sessionId: session.id,
        entry,
      };
    } else {
      const existing = session.transcript[existingIndex];
      const keepExistingReadPreview =
        existing.kind === "tool" &&
        entry.kind === "tool" &&
        this.isReadToolName(existing.meta?.name);
      const mergedText =
        keepExistingReadPreview
          ? existing.text
          : existing.kind === "tool" &&
              entry.kind === "tool" &&
              existing.text &&
              entry.text &&
              existing.text !== entry.text
          ? `${existing.text}\n\n${entry.text}`.trim()
          : entry.text || existing.text;
      session.transcript[existingIndex] = {
        ...existing,
        ...entry,
        text: mergedText,
      };
      event = {
        type: "session-entry-updated",
        sessionId: session.id,
        entry: session.transcript[existingIndex],
      };
    }

    this.markPreviewDirty(session);
    this.touch(session);
    this.persist(session);
    this.emitChange(event);
    this.emitChange({ type: "session-updated", session: this.toSummary(session) });
  }

  private touch(session: ManagedSession): void {
    session.updatedAt = new Date().toISOString();
  }

  private markPreviewDirty(session: ManagedSession): void {
    session.previewDirty = true;
  }

  private emitChange(event: DaemonEvent): void {
    if (event.type === "session-updated") {
      this.pendingSessionUpdates.set(event.session.id, event.session);
      if (this.sessionUpdateTimer) {
        return;
      }
      this.sessionUpdateTimer = setTimeout(() => {
        this.sessionUpdateTimer = undefined;
        const updates = Array.from(this.pendingSessionUpdates.values());
        this.pendingSessionUpdates.clear();
        for (const session of updates) {
          this.emit("event", { type: "session-updated", session });
        }
      }, 80);
      return;
    }

    if (event.type === "session-deleted") {
      this.pendingSessionUpdates.delete(event.sessionId);
    }

    this.emit("event", event);
  }

  private trackSessionStartup(session: ManagedSession, promise: Promise<void>): Promise<void> {
    const tracked = promise.finally(() => {
      if (session.startupPromise === tracked) {
        session.startupPromise = undefined;
      }
    });
    return tracked;
  }

  private createRuntime(session: ManagedSession): SessionRuntime {
    const runtime = new SessionRuntime(session, {
      persist: () => this.persist(session),
      emitChange: (event) => this.emitChange(event),
      markPreviewDirty: (target) => this.markPreviewDirty(target),
      touch: (target) => this.touch(target),
      toSummary: (target) => this.toSummary(target),
      getDetails: (sessionId) => this.getOrThrow(sessionId),
      addEntry: (target, input) => this.addEntry(target, input),
      upsertEntry: (target, entry) => this.upsertEntry(target, entry),
      normalizeReasoningEffort: (value) => this.normalizeReasoningEffort(value),
      errorMessage: (error) => this.errorMessage(error),
    });
    this.runtimes.set(session.id, runtime);
    return runtime;
  }

  private runtimeFor(session: ManagedSession): SessionRuntime {
    return this.runtimes.get(session.id) ?? this.createRuntime(session);
  }

  private serializeSessionForStore(session: ManagedSession): SessionDetails {
    const previewEntries = this.getPreviewEntries(session);
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
      previewEntries,
      transcript: [...session.transcript],
    };
  }

  private toSummary(session: ManagedSession): SessionSummary {
    const previewEntries = this.getPreviewEntries(session);
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
      previewEntries,
    };
  }

  private getPreviewEntries(session: ManagedSession): SessionPreviewEntry[] {
    if (!session.previewDirty) {
      return session.previewEntries;
    }

    session.previewEntries = this.toPreviewEntries(session.transcript);
    session.previewDirty = false;
    return session.previewEntries;
  }

  private toPreviewEntries(transcript: TranscriptEntry[]): SessionPreviewEntry[] {
    if (!transcript.length) {
      return [];
    }

    const selected: SessionPreviewEntry[] = [];
    let textBudget = 520;

    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      const entry = transcript[index];
      if (!entry) {
        continue;
      }

      const previewText = this.toPreviewText(entry);
      if (!previewText) {
        continue;
      }

      const cost = Math.max(40, previewText.length);
      if (selected.length && textBudget - cost < 0) {
        break;
      }

      selected.unshift({
        id: entry.id,
        kind: entry.kind,
        previewText,
        createdAt: entry.createdAt,
        status: entry.status,
      });
      textBudget -= cost;

      if (selected.length >= 6) {
        break;
      }
    }

    return selected;
  }

  private toPreviewText(entry: TranscriptEntry): string {
    if (entry.kind === "assistant" && entry.status === "streaming" && !entry.text.trim()) {
      return "Thinking...";
    }

    if (entry.kind === "approval") {
      const approvalKind = typeof entry.meta?.approvalKind === "string" ? entry.meta.approvalKind : "";
      if (approvalKind) {
        return approvalKind;
      }
    }

    if (entry.kind === "tool" || entry.kind === "command" || entry.kind === "file_change") {
      return this.lastLines(entry.text, 6) || this.entryLabel(entry);
    }

    const collapsed = String(entry.text || "")
      .replace(/\s+/g, " ")
      .trim();
    return collapsed || this.entryLabel(entry);
  }

  private entryLabel(entry: TranscriptEntry): string {
    switch (entry.kind) {
      case "user":
        return "User";
      case "assistant":
        return entry.status === "streaming" ? "Assistant" : "Reply";
      case "reasoning":
        return "Thinking";
      case "tool":
        return "Tool";
      case "command":
        return "Command";
      case "file_change":
        return "Diff";
      case "approval":
        return "Approval";
      default:
        return "System";
    }
  }

  private lastLines(text: string, limit: number): string {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    return lines.slice(-limit).join("\n").trim();
  }

  private isReadToolName(value: unknown): boolean {
    if (typeof value !== "string") {
      return false;
    }

    const normalized = value.replace(/[\s-]+/g, "_").trim().toLowerCase();
    return normalized === "read" || normalized === "read_file" || normalized === "readfile";
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

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
