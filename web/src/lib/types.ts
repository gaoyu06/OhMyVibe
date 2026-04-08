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

export type ProjectStatus = "idle" | "running" | "paused" | "blocked" | "completed" | "failed";

export type AgentRole = "steward" | "foreman" | "sentinel";

export type AgentStatus = "idle" | "running" | "waiting" | "blocked" | "paused" | "failed";

export type AgentLogKind =
  | "thought"
  | "action"
  | "observation"
  | "decision"
  | "escalation"
  | "user_message"
  | "agent_message"
  | "system";

export interface SessionGitCommitSummary {
  hash: string;
  subject: string;
  committedAt?: string;
}

export interface SessionGitSummary {
  isRepo: boolean;
  branch?: string;
  modifiedFileCount: number;
  stagedFileCount: number;
  untrackedFileCount: number;
  head?: SessionGitCommitSummary;
}

export interface SessionGitDetails extends SessionGitSummary {
  modifiedFiles: string[];
  stagedFiles: string[];
  untrackedFiles: string[];
}

export interface SessionSummary {
  id: string;
  projectId?: string;
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
  git?: SessionGitSummary;
}

export interface SessionDetails extends SessionSummary {
  transcript: TranscriptEntry[];
  hasMoreTranscriptBefore: boolean;
  gitDetails?: SessionGitDetails;
}

export interface SessionTranscriptPage {
  sessionId: string;
  transcript: TranscriptEntry[];
  hasMoreTranscriptBefore: boolean;
}

export interface ProjectRunPolicy {
  mode: "until_complete" | "until_time" | "until_blocked";
  runUntil?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  rootDir: string;
  goal: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  defaultSessionCwd: string;
  sessionIds: string[];
  agentIds: string[];
  runPolicy: ProjectRunPolicy;
}

export interface ProjectDetails extends ProjectSummary {
  sessions: SessionSummary[];
  agents: AgentSummary[];
}

export interface CreateProjectInput {
  name: string;
  rootDir: string;
  goal?: string;
  runPolicy?: ProjectRunPolicy;
}

export interface UpdateProjectInput {
  name?: string;
  goal?: string;
  status?: ProjectStatus;
  runPolicy?: ProjectRunPolicy;
}

export interface AgentMemoryState {
  summary: string;
  summaryUpdatedAt?: string;
  windowEntryIds: string[];
}

export interface AgentSummary {
  id: string;
  projectId: string;
  role: AgentRole;
  name: string;
  status: AgentStatus;
  boundSessionId?: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  provider?: string;
  lastError?: string;
}

export interface AgentLogEntry {
  id: string;
  agentId: string;
  kind: AgentLogKind;
  direction: "inbound" | "outbound" | "internal";
  sourceAgentId?: string;
  targetAgentId?: string;
  text: string;
  createdAt: string;
  meta?: Record<string, unknown>;
}

export interface AgentDetails extends AgentSummary {
  memory: AgentMemoryState;
  logs: AgentLogEntry[];
}

export interface SendAgentMessageInput {
  text: string;
}

export interface ProviderConfig {
  provider: "openai";
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: "responses" | "chat_completions";
  temperature?: number;
  maxOutputTokens?: number;
}

export interface NotificationConfig {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpSecure: boolean;
}

export interface GlobalSettings {
  provider: ProviderConfig;
  notifications: NotificationConfig;
}

export interface ProjectNotification {
  id: string;
  projectId: string;
  severity: "info" | "warning" | "critical";
  channel: "inbox" | "email";
  subject: string;
  body: string;
  status: "pending" | "sent" | "failed" | "skipped";
  scheduledAt?: string;
  sentAt?: string;
  createdAt: string;
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
  version?: string;
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
      hasMoreTranscriptBefore: boolean;
    }
  | {
      type: "project-created";
      project: ProjectSummary;
    }
  | {
      type: "project-updated";
      project: ProjectSummary;
    }
  | {
      type: "agent-created";
      agent: AgentSummary;
    }
  | {
      type: "agent-updated";
      agent: AgentSummary;
    }
  | {
      type: "agent-log-entry";
      entry: AgentLogEntry;
    }
  | {
      type: "project-notification";
      notification: ProjectNotification;
    }
  | {
      type: "session-git-updated";
      sessionId: string;
      git: SessionGitSummary;
    };
