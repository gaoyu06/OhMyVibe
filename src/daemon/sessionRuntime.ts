import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  CreateSessionInput,
  DaemonEvent,
  RestoreSessionInput,
  SessionDetails,
  SessionPreviewEntry,
  SessionStatus,
  SessionSummary,
  TranscriptEntry,
} from "../shared/types.js";
import { CodexAppServerClient } from "./codexAppServerClient.js";

export interface ManagedSession {
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
  previewEntries: SessionPreviewEntry[];
  previewDirty?: boolean;
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

interface SessionRuntimeCallbacks {
  persist: () => void;
  emitChange: (event: DaemonEvent) => void;
  markPreviewDirty: (session: ManagedSession) => void;
  touch: (session: ManagedSession) => void;
  toSummary: (session: ManagedSession) => SessionSummary;
  getDetails: (sessionId: string) => SessionDetails;
  createSessionResetEvent: (session: ManagedSession) => Extract<DaemonEvent, { type: "session-reset" }>;
  addEntry: (
    session: ManagedSession,
    input: Omit<TranscriptEntry, "id" | "createdAt">,
  ) => TranscriptEntry;
  upsertEntry: (session: ManagedSession, entry: TranscriptEntry) => void;
  normalizeReasoningEffort: (
    value: unknown,
  ) => "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
  errorMessage: (error: unknown) => string;
}

export class SessionRuntime {
  constructor(
    private readonly session: ManagedSession,
    private readonly callbacks: SessionRuntimeCallbacks,
  ) {}

  async restore(input?: RestoreSessionInput): Promise<void> {
    await this.ensureCodexClient(input);
  }

  async sendMessage(text: string): Promise<void> {
    await this.applyPendingConfig();
    await this.ensureCodexClient();
    if (!this.session.codex || !this.session.codexThreadId) {
      throw new Error("Session is not ready");
    }

    this.callbacks.addEntry(this.session, { kind: "user", text });
    this.session.status = "running";
    this.session.currentTurnMetrics = {
      startedAt: Date.now(),
      outputEntryIds: new Set(),
    };
    this.callbacks.persist();
    this.callbacks.emitChange({ type: "session-updated", session: this.callbacks.toSummary(this.session) });
    void this.startTurnInBackground(text);
  }

  async interrupt(): Promise<void> {
    if (!this.session.codexThreadId || !this.session.activeTurnId) {
      return;
    }
    await this.ensureCodexClient();
    if (!this.session.codex) {
      return;
    }
    await this.session.codex.turnInterrupt(this.session.codexThreadId, this.session.activeTurnId);
    this.session.status = "interrupted";
    this.session.activeTurnId = undefined;
    this.callbacks.touch(this.session);
    this.callbacks.persist();
    this.callbacks.emitChange({ type: "session-updated", session: this.callbacks.toSummary(this.session) });
  }

  async respondApproval(approvalRequestId: string, decision: "approve" | "deny"): Promise<void> {
    const pending = this.session.pendingApprovals.get(approvalRequestId);
    if (!pending || !this.session.codex) {
      throw new Error(`Approval request not found: ${approvalRequestId}`);
    }

    const response = this.mapApprovalResponse(pending.method, pending.params, decision);
    this.session.codex.respond(pending.requestIdRaw, response);
    this.session.pendingApprovals.delete(approvalRequestId);

    const entry = this.session.transcript.find((item) => item.id === pending.entryId);
    if (entry) {
      entry.status = decision === "approve" ? "approved" : "declined";
      entry.meta = {
        ...(entry.meta ?? {}),
        resolvedAt: new Date().toISOString(),
        decision,
      };
      this.callbacks.markPreviewDirty(this.session);
    }

    this.callbacks.touch(this.session);
    this.callbacks.persist();
    if (entry) {
      this.callbacks.emitChange({
        type: "session-entry-updated",
        sessionId: this.session.id,
        entry,
      });
    }
    this.callbacks.emitChange({ type: "session-updated", session: this.callbacks.toSummary(this.session) });
  }

  async close(): Promise<void> {
    this.session.status = "closed";
    if (this.session.codex) {
      await this.session.codex.close();
    }
  }

  async applyPendingConfig(): Promise<void> {
    if (!this.session.configDirty || this.session.status === "running" || this.session.status === "starting") {
      return;
    }

    if (this.session.codex) {
      this.session.suppressNextExitFailure = true;
      await this.session.codex.close();
      this.session.codex = undefined;
    }

    await this.ensureCodexClient({
      cwd: this.session.cwd,
      model: this.session.model,
      reasoningEffort: this.callbacks.normalizeReasoningEffort(this.session.reasoningEffort),
      sandbox: this.session.sandbox,
      approvalPolicy: this.session.approvalPolicy,
    });
  }

  async startFreshThread(input: CreateSessionInput): Promise<void> {
    await this.ensureSpawnDirectoryExists();
    const codex = new CodexAppServerClient({ cwd: this.session.cwd });
    this.session.codex = codex;
    this.attachCodexHooks(codex);
    await codex.initialize();

    const response = await codex.threadStart({
      cwd: this.session.cwd,
      model: input.model,
      sandbox: input.sandbox ?? this.session.sandbox,
      approvalPolicy: input.approvalPolicy ?? this.session.approvalPolicy,
    });

    this.session.codexThreadId = response.thread.id;
    this.session.codexPath = response.thread.path;
    this.session.codexSource = response.thread.source;
    this.session.model = response.model;
    this.session.reasoningEffort = input.reasoningEffort ?? response.reasoningEffort ?? "medium";
    this.session.sandbox = input.sandbox ?? this.session.sandbox;
    this.session.approvalPolicy = input.approvalPolicy ?? this.session.approvalPolicy;
    this.session.status = "idle";
    this.session.title = response.thread.preview || this.session.title;
    this.session.configDirty = false;
    this.callbacks.touch(this.session);
    this.callbacks.persist();
    this.callbacks.emitChange({ type: "session-updated", session: this.callbacks.toSummary(this.session) });
  }

  async ensureCodexClient(
    overrides?: Partial<CreateSessionInput & RestoreSessionInput>,
  ): Promise<void> {
    if (this.session.codex && this.session.codexThreadId) {
      return;
    }

    if (this.session.startupPromise) {
      await this.session.startupPromise;
      if (this.session.codex && this.session.codexThreadId) {
        return;
      }
    }

    const startup = (async () => {
      if (!this.session.codexThreadId) {
        await this.startFreshThread({
          cwd: this.session.cwd,
          model: overrides?.model ?? this.session.model,
          reasoningEffort: this.callbacks.normalizeReasoningEffort(
            overrides?.reasoningEffort ?? this.session.reasoningEffort,
          ),
          sandbox: overrides?.sandbox ?? this.session.sandbox,
          approvalPolicy: overrides?.approvalPolicy ?? this.session.approvalPolicy,
        });
        return;
      }

      await this.ensureSpawnDirectoryExists();
      const codex = new CodexAppServerClient({ cwd: this.session.cwd });
      this.session.codex = codex;
      this.attachCodexHooks(codex);
      await codex.initialize();

      const response = await codex.threadResume({
        threadId: this.session.codexThreadId,
        cwd: overrides?.cwd ?? this.session.cwd,
        model: overrides?.model ?? this.session.model,
        sandbox: overrides?.sandbox ?? this.session.sandbox,
        approvalPolicy: overrides?.approvalPolicy ?? this.session.approvalPolicy,
      });

      this.session.cwd = response.cwd || this.session.cwd;
      this.session.model = response.model || this.session.model;
      this.session.reasoningEffort = this.callbacks.normalizeReasoningEffort(
        overrides?.reasoningEffort ?? response.reasoningEffort ?? this.session.reasoningEffort,
      );
      this.session.sandbox = overrides?.sandbox ?? this.session.sandbox;
      this.session.approvalPolicy = overrides?.approvalPolicy ?? this.session.approvalPolicy;
      this.session.codexPath = response.thread?.path || this.session.codexPath;
      this.session.codexSource = response.thread?.source || this.session.codexSource;
      this.session.title = response.thread?.name || response.thread?.preview || this.session.title;
      this.session.status = this.mapThreadStatus(response.thread?.status);
      this.session.transcript = this.threadToTranscript(response.thread);
      this.callbacks.markPreviewDirty(this.session);
      this.session.liveMessages.clear();
      this.session.liveReasoning.clear();
      this.session.pendingApprovals.clear();
      this.session.configDirty = false;
      this.callbacks.touch(this.session);
      this.callbacks.persist();
      this.callbacks.emitChange(this.callbacks.createSessionResetEvent(this.session));
      this.callbacks.emitChange({ type: "session-updated", session: this.callbacks.toSummary(this.session) });
    })();

    this.session.startupPromise = this.trackStartup(startup);
    await this.session.startupPromise;
  }

  private attachCodexHooks(codex: CodexAppServerClient): void {
    codex.onNotification(async (notification) => {
      try {
        await this.handleNotification(notification);
      } catch (error) {
        this.session.lastError = this.callbacks.errorMessage(error);
        this.session.status = "failed";
        this.callbacks.addEntry(this.session, {
          kind: "system",
          text: `Notification handling failed: ${this.session.lastError}`,
          status: "failed",
        });
        this.callbacks.persist();
        this.callbacks.emitChange({ type: "session-updated", session: this.callbacks.toSummary(this.session) });
      }
    });

    codex.onRequest((request) => {
      this.handleCodexRequest(request);
    });

    codex.onStderr((chunk) => {
      const text = this.cleanStderr(chunk);
      if (!text || this.shouldIgnoreStderr(text)) {
        return;
      }
      this.callbacks.addEntry(this.session, {
        kind: "system",
        text,
        status: "stderr",
      });
    });

    codex.onExit(({ code, signal }) => {
      this.session.codex = undefined;
      this.session.activeTurnId = undefined;
      this.session.currentTurnMetrics = undefined;
      if (this.session.suppressNextExitFailure) {
        this.session.suppressNextExitFailure = false;
        return;
      }
      if (this.session.status === "closed") {
        return;
      }
      this.session.status = "failed";
      this.session.lastError = `Codex process exited (code=${code}, signal=${signal})`;
      this.callbacks.addEntry(this.session, {
        kind: "system",
        text: this.session.lastError,
        status: "failed",
      });
      this.callbacks.persist();
      this.callbacks.emitChange({ type: "session-updated", session: this.callbacks.toSummary(this.session) });
    });
  }

  private async startTurnInBackground(text: string): Promise<void> {
    if (!this.session.codex || !this.session.codexThreadId) {
      this.session.activeTurnId = undefined;
      this.session.status = "failed";
      this.session.lastError = "Session is not ready";
      this.callbacks.addEntry(this.session, {
        kind: "system",
        text: `Turn start failed: ${this.session.lastError}`,
        status: "failed",
      });
      this.callbacks.persist();
      this.callbacks.emitChange({ type: "session-updated", session: this.callbacks.toSummary(this.session) });
      return;
    }

    try {
      const response = await this.session.codex.turnStart({
        threadId: this.session.codexThreadId,
        text,
        effort: this.session.reasoningEffort,
        model: this.session.model,
        approvalPolicy: this.session.approvalPolicy,
        summary: "detailed",
      });
      if (typeof response?.turn?.id === "string") {
        this.session.activeTurnId = response.turn.id;
      }
    } catch (error) {
      this.session.activeTurnId = undefined;
      this.session.currentTurnMetrics = undefined;
      this.session.status = "failed";
      this.session.lastError = this.callbacks.errorMessage(error);
      this.callbacks.addEntry(this.session, {
        kind: "system",
        text: `Turn start failed: ${this.session.lastError}`,
        status: "failed",
      });
      this.callbacks.persist();
      this.callbacks.emitChange({ type: "session-updated", session: this.callbacks.toSummary(this.session) });
    }
  }

  private async handleNotification(
    notification: { method: string; params?: any },
  ): Promise<void> {
    switch (notification.method) {
      case "thread/started": {
        const preview = notification.params?.thread?.preview;
        this.session.codexPath = notification.params?.thread?.path || this.session.codexPath;
        this.session.codexSource = notification.params?.thread?.source || this.session.codexSource;
        if (typeof preview === "string" && preview.trim()) {
          this.session.title = preview.trim();
        }
        this.callbacks.touch(this.session);
        this.callbacks.persist();
        this.callbacks.emitChange({ type: "session-updated", session: this.callbacks.toSummary(this.session) });
        return;
      }
      case "thread/nameUpdated": {
        const title = notification.params?.name;
        if (typeof title === "string" && title.trim()) {
          this.session.title = title.trim();
          this.callbacks.touch(this.session);
          this.callbacks.persist();
          this.callbacks.emitChange({ type: "session-updated", session: this.callbacks.toSummary(this.session) });
        }
        return;
      }
      case "thread/statusChanged": {
        this.session.status = this.mapThreadStatus(notification.params?.status);
        this.callbacks.touch(this.session);
        this.callbacks.persist();
        this.callbacks.emitChange({ type: "session-updated", session: this.callbacks.toSummary(this.session) });
        return;
      }
      case "turn/started": {
        if (typeof notification.params?.turn?.id === "string") {
          this.session.activeTurnId = notification.params.turn.id;
        }
        this.session.status = "running";
        this.callbacks.touch(this.session);
        this.callbacks.persist();
        this.callbacks.emitChange({ type: "session-updated", session: this.callbacks.toSummary(this.session) });
        return;
      }
      case "item/started": {
        const item = notification.params?.item;
        if (item?.type === "agentMessage") {
          const entry = this.ensureAssistantEntry(item.id);
          entry.status = "streaming";
          this.trackTurnEntry(entry);
          this.callbacks.markPreviewDirty(this.session);
        }
        this.callbacks.touch(this.session);
        this.callbacks.persist();
        this.callbacks.emitChange({ type: "session-updated", session: this.callbacks.toSummary(this.session) });
        return;
      }
      case "item/agentMessage/delta": {
        const itemId = notification.params?.itemId;
        const delta = notification.params?.delta;
        if (typeof itemId === "string" && typeof delta === "string") {
          const entry = this.ensureAssistantEntry(itemId);
          entry.text += delta;
          entry.status = "streaming";
          this.markTurnOutput(entry);
          this.callbacks.markPreviewDirty(this.session);
          this.callbacks.touch(this.session);
          this.callbacks.persist();
          this.callbacks.emitChange({
            type: "session-entry-updated",
            sessionId: this.session.id,
            entry,
          });
        }
        return;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const itemId = notification.params?.itemId;
        const delta = notification.params?.delta;
        if (typeof itemId === "string" && typeof delta === "string") {
          const entry = this.ensureReasoningEntry(itemId);
          entry.text += delta;
          entry.status = "streaming";
          this.markTurnOutput(entry);
          this.callbacks.markPreviewDirty(this.session);
          this.callbacks.touch(this.session);
          this.callbacks.persist();
          this.callbacks.emitChange({
            type: "session-entry-updated",
            sessionId: this.session.id,
            entry,
          });
        }
        return;
      }
      case "item/reasoning/summaryPartAdded": {
        const itemId = notification.params?.itemId;
        if (typeof itemId === "string") {
          this.ensureReasoningEntry(itemId);
          this.callbacks.touch(this.session);
          this.callbacks.persist();
        }
        return;
      }
      case "turn/completed": {
        const turn = notification.params?.turn;
        const updatedEntries: TranscriptEntry[] = [];
        const removedEntryIds: string[] = [];
        this.session.activeTurnId = undefined;
        this.session.status = this.mapTurnStatus(turn?.status);
        this.finalizeTurnMetrics();
        for (const entry of this.session.liveMessages.values()) {
          entry.status = "completed";
          updatedEntries.push(entry);
        }
        for (const [itemId, entry] of this.session.liveReasoning.entries()) {
          if (entry.text.trim()) {
            entry.status = "completed";
            updatedEntries.push(entry);
            continue;
          }
          this.session.transcript = this.session.transcript.filter((item) => item.id !== itemId);
          removedEntryIds.push(itemId);
        }
        this.session.liveMessages.clear();
        this.session.liveReasoning.clear();
        this.session.currentTurnMetrics = undefined;
        this.callbacks.markPreviewDirty(this.session);
        this.callbacks.touch(this.session);
        this.callbacks.persist();
        if (updatedEntries.length || removedEntryIds.length) {
          this.callbacks.emitChange({
            type: "session-entries-updated",
            sessionId: this.session.id,
            entries: updatedEntries,
            removedEntryIds: removedEntryIds.length ? removedEntryIds : undefined,
          });
        }
        this.callbacks.emitChange({ type: "session-updated", session: this.callbacks.toSummary(this.session) });
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
        this.trackTurnEntry(entry);
        this.markTurnOutput(entry);
        this.callbacks.upsertEntry(this.session, entry);
        return;
      }
      default:
        return;
    }
  }

  private handleCodexRequest(
    request: { id: string | number; method: string; params?: any },
  ): void {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
      case "execCommandApproval":
      case "applyPatchApproval": {
        const requestId = String(request.id);
        const entry = this.callbacks.addEntry(this.session, {
          kind: "approval",
          text: this.describeApprovalRequest(request.method, request.params),
          status: "pending",
          meta: {
            requestId,
            approvalKind: request.method,
            payload: request.params,
          },
        });
        this.session.pendingApprovals.set(requestId, {
          entryId: entry.id,
          requestIdRaw: request.id,
          method: request.method,
          params: request.params,
        });
        return;
      }
      default:
        this.session.codex?.respondError(request.id, `Unsupported client request: ${request.method}`);
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
        return { id: item.id, kind: "user", text, createdAt };
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
          meta: { cwd: item.cwd, exitCode: item.exitCode },
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
          text: this.formatStructuredToolCall(item),
          status: item.status ?? "completed",
          createdAt,
        };
      case "function_call":
        return {
          id: item.call_id || item.id,
          kind: "tool",
          text: this.formatFunctionCall(item),
          status: item.status ?? "completed",
          createdAt,
          meta: { name: item.name },
        };
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
          meta: { name: item.name },
        };
      case "plan":
        return { id: item.id, kind: "system", text: item.text ?? "", createdAt, status: "completed" };
      case "enteredReviewMode":
      case "exitedReviewMode":
        return { id: item.id, kind: "system", text: JSON.stringify(item, null, 2), createdAt };
      case "contextCompaction":
        return {
          id: item.id,
          kind: "system",
          text: "Context compacted",
          createdAt,
          status: "completed",
          meta: {
            eventType: "contextCompaction",
            payload: item,
          },
        };
      default:
        return undefined;
    }
  }

  private async ensureSpawnDirectoryExists(): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(this.session.cwd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new Error(`Working directory does not exist: ${this.session.cwd}`);
      }
      throw error;
    }

    if (!stat.isDirectory()) {
      throw new Error(`Working directory is not a directory: ${this.session.cwd}`);
    }
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
      case "item/fileChange/requestApproval":
        return { decision: decision === "approve" ? "accept" : "decline" };
      case "execCommandApproval":
      case "applyPatchApproval":
        return { decision: decision === "approve" ? "approved" : "denied" };
      default:
        throw new Error(`Unsupported approval method: ${method}`);
    }
  }

  private trackStartup(promise: Promise<void>): Promise<void> {
    const tracked = promise.finally(() => {
      if (this.session.startupPromise === tracked) {
        this.session.startupPromise = undefined;
      }
    });
    return tracked;
  }

  private ensureAssistantEntry(itemId: string): TranscriptEntry {
    let entry = this.session.liveMessages.get(itemId);
    if (!entry) {
      entry = {
        id: itemId,
        kind: "assistant",
        text: "",
        createdAt: new Date().toISOString(),
        status: "streaming",
      };
      this.session.liveMessages.set(itemId, entry);
      this.session.transcript.push(entry);
      this.callbacks.markPreviewDirty(this.session);
      this.trackTurnEntry(entry);
      this.callbacks.persist();
      this.callbacks.emitChange({ type: "session-entry", sessionId: this.session.id, entry });
    }
    return entry;
  }

  private ensureReasoningEntry(itemId: string): TranscriptEntry {
    let entry = this.session.liveReasoning.get(itemId);
    if (!entry) {
      entry = {
        id: itemId,
        kind: "reasoning",
        text: "",
        createdAt: new Date().toISOString(),
        status: "streaming",
      };
      this.session.liveReasoning.set(itemId, entry);
      this.session.transcript.push(entry);
      this.callbacks.markPreviewDirty(this.session);
      this.trackTurnEntry(entry);
      this.callbacks.persist();
      this.callbacks.emitChange({ type: "session-entry", sessionId: this.session.id, entry });
    }
    return entry;
  }

  private trackTurnEntry(entry: TranscriptEntry): void {
    if (!this.session.currentTurnMetrics || (entry.kind !== "assistant" && entry.kind !== "reasoning")) {
      return;
    }
    this.session.currentTurnMetrics.outputEntryIds.add(entry.id);
  }

  private markTurnOutput(entry: TranscriptEntry): void {
    if (
      !this.session.currentTurnMetrics ||
      (entry.kind !== "assistant" && entry.kind !== "reasoning") ||
      !entry.text.trim()
    ) {
      return;
    }

    this.trackTurnEntry(entry);
    if (!this.session.currentTurnMetrics.firstOutputAt) {
      this.session.currentTurnMetrics.firstOutputAt = Date.now();
    }

    const meta = { ...(entry.meta ?? {}) };
    meta.firstByteMs = Math.max(
      0,
      this.session.currentTurnMetrics.firstOutputAt - this.session.currentTurnMetrics.startedAt,
    );
    entry.meta = meta;
  }

  private finalizeTurnMetrics(): void {
    if (!this.session.currentTurnMetrics) {
      return;
    }

    const totalMs = Math.max(0, Date.now() - this.session.currentTurnMetrics.startedAt);
    const firstByteMs = this.session.currentTurnMetrics.firstOutputAt
      ? Math.max(0, this.session.currentTurnMetrics.firstOutputAt - this.session.currentTurnMetrics.startedAt)
      : undefined;

    for (const entryId of this.session.currentTurnMetrics.outputEntryIds) {
      const entry = this.session.transcript.find((item) => item.id === entryId);
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
    if (this.isReadToolName(name)) {
      const target = this.extractReadTarget(item?.arguments);
      return target ? `read ${target}` : "read";
    }
    const args = this.prettyJsonString(item?.arguments);
    return args ? `${name}\n\n${args}` : name;
  }

  private formatFunctionCallOutput(item: any): string {
    if (this.isReadToolName(item?.name)) {
      return "";
    }
    return String(item?.output ?? "").trim();
  }

  private formatCustomToolCall(item: any): string {
    const name = item?.name || "custom_tool";
    if (this.isReadToolName(name)) {
      const target = this.extractReadTarget(item?.input);
      return target ? `read ${target}` : "read";
    }
    const input = typeof item?.input === "string" ? item.input : this.prettyJson(item?.input);
    return input ? `${name}\n\n${input}` : name;
  }

  private formatStructuredToolCall(item: any): string {
    const name = item?.name || item?.toolName || item?.tool?.name || item?.type || "tool";
    if (this.isReadToolName(name)) {
      const target = this.extractReadTarget(item?.arguments ?? item?.input ?? item?.params ?? item);
      return target ? `read ${target}` : "read";
    }
    return JSON.stringify(item, null, 2);
  }

  private isReadToolName(value: unknown): boolean {
    if (typeof value !== "string") {
      return false;
    }

    const normalized = value.replace(/[\s-]+/g, "_").trim().toLowerCase();
    return normalized === "read" || normalized === "read_file" || normalized === "readfile";
  }

  private extractReadTarget(value: unknown): string {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return "";
      }

      const parsed = this.parseJsonLike(trimmed);
      if (!parsed) {
        const normalized = trimmed.replace(/^file:\/\//i, "").replace(/[\\/]+$/, "");
        return path.basename(normalized) || normalized;
      }

      value = parsed;
    }

    const parsed = this.parseJsonLike(value);
    if (!parsed || typeof parsed !== "object") {
      return "";
    }

    const candidate = this.firstStringValue(parsed as Record<string, unknown>, [
      "filePath",
      "filepath",
      "path",
      "filename",
      "file",
      "target",
      "uri",
      "name",
    ]);
    if (!candidate) {
      return "";
    }

    const normalized = candidate.replace(/^file:\/\//i, "").replace(/[\\/]+$/, "").trim();
    if (!normalized) {
      return "";
    }

    return path.basename(normalized) || normalized;
  }

  private parseJsonLike(value: unknown): unknown {
    if (typeof value !== "string") {
      return value;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }

  private firstStringValue(value: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
    return "";
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
}
