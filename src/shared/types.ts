export type SessionStatus =
  | "starting"
  | "idle"
  | "running"
  | "interrupted"
  | "completed"
  | "failed"
  | "closed";

export type TranscriptEntryKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "command"
  | "file_change"
  | "tool"
  | "approval"
  | "system";

export interface TranscriptEntry {
  id: string;
  kind: TranscriptEntryKind;
  text: string;
  phase?: "commentary" | "final_answer";
  status?: string;
  createdAt: string;
  meta?: Record<string, unknown>;
}

export type SessionOrigin = "created" | "restored";

export interface ModelReasoningOption {
  reasoningEffort: string;
  description: string;
}

export interface AvailableModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: ModelReasoningOption[];
}

export interface DaemonConfig {
  models: AvailableModel[];
  defaultModel?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  origin: SessionOrigin;
  model?: string;
  reasoningEffort?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  codexThreadId?: string;
  codexPath?: string;
  codexSource?: string;
  lastError?: string;
  transcriptCount: number;
}

export interface SessionDetails extends SessionSummary {
  transcript: TranscriptEntry[];
}

export interface CreateSessionInput {
  cwd: string;
  model?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
}

export interface RestoreSessionInput {
  threadId: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
}

export interface SendMessageInput {
  text: string;
}

export interface UpdateSessionConfigInput {
  model?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
}

export interface CodexHistoryEntry {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  path?: string;
  source?: string;
  modelProvider?: string;
}

export interface DaemonDescriptor {
  id: string;
  name: string;
  platform: string;
  cwd: string;
  connectedAt: string;
  lastSeenAt: string;
  online: boolean;
  sessionCount: number;
}

export type DaemonEvent =
  | {
      type: "session-created";
      session: SessionSummary;
    }
  | {
      type: "session-updated";
      session: SessionSummary;
    }
  | {
      type: "session-deleted";
      sessionId: string;
    }
  | {
      type: "session-entry";
      sessionId: string;
      entry: TranscriptEntry;
    }
  | {
      type: "session-reset";
      sessionId: string;
      transcript: TranscriptEntry[];
    };
