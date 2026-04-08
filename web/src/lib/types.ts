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

export interface SessionPreviewEntry {
  id: string;
  kind: TranscriptEntryKind;
  previewText: string;
  createdAt: string;
  status?: string;
}

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
  origin: "created" | "restored";
  model?: string;
  reasoningEffort?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  codexThreadId?: string;
  codexPath?: string;
  codexSource?: string;
  lastError?: string;
  transcriptCount: number;
  previewEntries: SessionPreviewEntry[];
}

export interface SessionDetails extends SessionSummary {
  transcript: TranscriptEntry[];
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

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryBrowseResult {
  currentPath: string;
  parentPath?: string;
  entries: DirectoryEntry[];
}

export interface ProjectFileEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  size?: number;
}

export interface ProjectFileBrowseResult {
  currentPath: string;
  parentPath?: string;
  entries: ProjectFileEntry[];
}

export interface ProjectFileReadResult {
  path: string;
  kind: "text" | "image" | "binary";
  mimeType?: string;
  content: string;
  size: number;
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
      type: "session-entry-updated";
      sessionId: string;
      entry: TranscriptEntry;
    }
  | {
      type: "session-entries-updated";
      sessionId: string;
      entries: TranscriptEntry[];
      removedEntryIds?: string[];
    }
  | {
      type: "session-reset";
      sessionId: string;
      transcript: TranscriptEntry[];
    };
