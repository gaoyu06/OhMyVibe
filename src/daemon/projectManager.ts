import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import nodemailer from "nodemailer";
import {
  AgentDetails,
  AgentLogEntry,
  AgentRole,
  AgentSummary,
  CreateProjectInput,
  CreateSessionInput,
  DaemonConfig,
  DaemonEvent,
  DirectoryBrowseResult,
  GlobalSettings,
  NotificationConfig,
  ProjectDetails,
  ProjectFileBrowseResult,
  ProjectFileReadResult,
  ProjectNotification,
  ProjectSummary,
  ProviderConfig,
  RenameSessionInput,
  RestoreSessionInput,
  SessionDetails,
  SessionGitDetails,
  SessionGitSummary,
  SessionSummary,
  SessionTranscriptPage,
  UpdateProjectInput,
  UpdateSessionConfigInput,
} from "../shared/types.js";
import { OpenAiAgentClient } from "./openAiAgentClient.js";
import { ProjectStore, ProjectStoreState } from "./projectStore.js";
import { SessionManager } from "./sessionManager.js";
import { SettingsStore } from "./settingsStore.js";

const execFile = promisify(execFileCallback);
const GIT_CACHE_TTL_MS = 15_000;
const AGENT_CONTEXT_WINDOW_TOKENS = 400_000;
const AGENT_CONTEXT_WINDOW_CHARS = AGENT_CONTEXT_WINDOW_TOKENS * 4;
const AGENT_RECENT_LOG_LIMIT = 80;

interface GitCacheEntry {
  summary?: SessionGitSummary;
  details?: SessionGitDetails;
  expiresAt: number;
  inFlight?: Promise<void>;
}

export class ProjectManager extends EventEmitter<{ event: [DaemonEvent] }> {
  private readonly projectStore = new ProjectStore();
  private readonly settingsStore = new SettingsStore();
  private readonly sessionManager: SessionManager;
  private readonly state: ProjectStoreState;
  private settings: GlobalSettings;
  private persistTimer?: NodeJS.Timeout;
  private persistInFlight = false;
  private readonly gitCache = new Map<string, GitCacheEntry>();
  private readonly agentQueue = new Set<string>();
  private readonly runningAgents = new Set<string>();

  constructor(sessionManager: SessionManager) {
    super();
    this.sessionManager = sessionManager;
    this.state = this.projectStore.load();
    this.settings = this.settingsStore.load();

    this.sessionManager.on("event", (event) => {
      void this.handleSessionManagerEvent(event);
    });
  }

  async getConfig(): Promise<DaemonConfig> {
    return this.sessionManager.getConfig();
  }

  listSessions(): SessionSummary[] {
    return this.sessionManager.list().map((session) => this.enrichSessionSummary(session));
  }

  listSessionsCached(): SessionSummary[] {
    return this.listSessions();
  }

  getSession(
    sessionId: string,
    options?: {
      limit?: number;
    },
  ): SessionDetails | undefined {
    const session = this.sessionManager.get(sessionId, options);
    if (!session) {
      return undefined;
    }

    const gitDetails = this.getCachedGitDetails(session.cwd);
    void this.refreshGitForSession(session);
    return this.enrichSessionDetails(session, gitDetails);
  }

  getTranscriptPage(
    sessionId: string,
    options?: {
      beforeEntryId?: string;
      limit?: number;
    },
  ): SessionTranscriptPage | undefined {
    return this.sessionManager.getTranscriptPage(sessionId, options);
  }

  async listHistory() {
    return this.sessionManager.listHistory();
  }

  async browseDirectories(inputPath?: string): Promise<DirectoryBrowseResult> {
    return this.sessionManager.browseDirectories(inputPath);
  }

  async browseSessionFiles(sessionId: string, inputPath?: string): Promise<ProjectFileBrowseResult> {
    return this.sessionManager.browseSessionFiles(sessionId, inputPath);
  }

  async readSessionFile(sessionId: string, filePath: string): Promise<ProjectFileReadResult> {
    return this.sessionManager.readSessionFile(sessionId, filePath);
  }

  async writeSessionFile(sessionId: string, filePath: string, content: string): Promise<ProjectFileReadResult> {
    return this.sessionManager.writeSessionFile(sessionId, filePath, content);
  }

  async createSession(input: CreateSessionInput): Promise<SessionDetails> {
    const session = await this.sessionManager.create(input);
    void this.refreshGitForSession(session);
    return this.enrichSessionDetails(session, this.getCachedGitDetails(session.cwd));
  }

  async createProjectSession(projectId: string, input: CreateSessionInput): Promise<SessionDetails> {
    const project = this.getProjectSummaryOrThrow(projectId);
    const cwd = input.cwd?.trim() ? input.cwd : project.defaultSessionCwd;
    const session = await this.sessionManager.create({ ...input, cwd });

    project.sessionIds = this.uniqueIds([...project.sessionIds, session.id]);
    project.updatedAt = new Date().toISOString();
    this.state.sessionProjectIds[session.id] = project.id;
    this.schedulePersist();

    const foreman = this.createAgent(project.id, "foreman", {
      name: `${project.name} Foreman ${project.sessionIds.length}`,
      boundSessionId: session.id,
    });
    project.agentIds = this.uniqueIds([...project.agentIds, foreman.id]);

    this.emit("event", { type: "project-updated", project: { ...project } });
    this.emit("event", { type: "agent-created", agent: this.toAgentSummary(foreman) });

    void this.refreshGitForSession(session);
    return this.enrichSessionDetails(session, this.getCachedGitDetails(session.cwd));
  }

  async restoreSession(input: RestoreSessionInput): Promise<SessionDetails> {
    const session = await this.sessionManager.restore(input);
    void this.refreshGitForSession(session);
    return this.enrichSessionDetails(session, this.getCachedGitDetails(session.cwd));
  }

  async updateSessionConfig(sessionId: string, input: UpdateSessionConfigInput): Promise<SessionDetails> {
    const session = await this.sessionManager.updateConfig(sessionId, input);
    return this.enrichSessionDetails(session, this.getCachedGitDetails(session.cwd));
  }

  async renameSession(sessionId: string, input: RenameSessionInput): Promise<SessionDetails> {
    const session = await this.sessionManager.rename(sessionId, input);
    return this.enrichSessionDetails(session, this.getCachedGitDetails(session.cwd));
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    await this.sessionManager.sendMessage(sessionId, text);
  }

  async interruptSession(sessionId: string): Promise<void> {
    await this.sessionManager.interrupt(sessionId);
  }

  async respondApproval(
    sessionId: string,
    approvalRequestId: string,
    decision: "approve" | "deny",
  ): Promise<SessionDetails> {
    const session = await this.sessionManager.respondApproval(sessionId, approvalRequestId, decision);
    return this.enrichSessionDetails(session, this.getCachedGitDetails(session.cwd));
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.sessionManager.close(sessionId);
  }

  listProjects(): ProjectSummary[] {
    return [...this.state.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getProject(projectId: string): ProjectDetails | undefined {
    const project = this.state.projects.find((item) => item.id === projectId);
    if (!project) {
      return undefined;
    }

    return {
      ...project,
      sessions: this.listSessions().filter((session) => session.projectId === projectId),
      agents: this.listAgents(projectId),
    };
  }

  async createProject(input: CreateProjectInput): Promise<ProjectDetails> {
    const rootDir = path.resolve(input.rootDir);
    await this.ensureDirectoryExists(rootDir);

    const now = new Date().toISOString();
    const project: ProjectSummary = {
      id: randomUUID(),
      name: input.name.trim() || path.basename(rootDir) || "Project",
      rootDir,
      goal: input.goal?.trim() ?? "",
      status: "idle",
      createdAt: now,
      updatedAt: now,
      defaultSessionCwd: rootDir,
      sessionIds: [],
      agentIds: [],
      runPolicy: input.runPolicy ?? { mode: "until_blocked" },
    };

    const steward = this.createAgent(project.id, "steward", {
      name: `${project.name} Steward`,
    });
    const sentinel = this.createAgent(project.id, "sentinel", {
      name: `${project.name} Sentinel`,
    });
    project.agentIds = [steward.id, sentinel.id];

    this.state.projects.push(project);
    this.schedulePersist();

    this.emit("event", { type: "project-created", project: { ...project } });
    this.emit("event", { type: "agent-created", agent: this.toAgentSummary(steward) });
    this.emit("event", { type: "agent-created", agent: this.toAgentSummary(sentinel) });

    return this.getProject(project.id)!;
  }

  async updateProject(projectId: string, input: UpdateProjectInput): Promise<ProjectDetails> {
    const project = this.getProjectSummaryOrThrow(projectId);

    if (typeof input.name === "string" && input.name.trim()) {
      project.name = input.name.trim();
    }
    if (typeof input.goal === "string") {
      project.goal = input.goal.trim();
    }
    if (input.status) {
      project.status = input.status;
    }
    if (input.runPolicy) {
      project.runPolicy = input.runPolicy;
    }

    project.updatedAt = new Date().toISOString();
    this.schedulePersist();
    this.emit("event", { type: "project-updated", project: { ...project } });
    return this.getProject(projectId)!;
  }

  listAgents(projectId?: string): AgentSummary[] {
    return this.state.agents
      .filter((agent) => !projectId || agent.projectId === projectId)
      .map((agent) => this.toAgentSummary(agent))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getAgent(agentId: string): AgentDetails | undefined {
    const agent = this.state.agents.find((item) => item.id === agentId);
    if (!agent) {
      return undefined;
    }
    return structuredClone(agent);
  }

  async sendAgentMessage(projectId: string, agentId: string, text: string): Promise<AgentDetails> {
    const project = this.getProjectSummaryOrThrow(projectId);
    const agent = this.getAgentOrThrow(agentId);
    if (agent.projectId !== project.id) {
      throw new Error(`Agent ${agentId} does not belong to project ${projectId}`);
    }

    this.appendAgentLog(agent, {
      kind: "user_message",
      direction: "inbound",
      text,
      meta: { projectId },
    });
    this.enqueueAgent(agent.id);
    return structuredClone(agent);
  }

  async runProject(projectId: string): Promise<ProjectDetails> {
    const project = this.getProjectSummaryOrThrow(projectId);
    project.status = "running";
    project.updatedAt = new Date().toISOString();
    this.schedulePersist();
    this.emit("event", { type: "project-updated", project: { ...project } });

    const steward = this.findProjectAgent(projectId, "steward");
    if (steward) {
      this.appendAgentLog(steward, {
        kind: "system",
        direction: "internal",
        text: `Run project with policy ${project.runPolicy.mode}.`,
      });
      this.enqueueAgent(steward.id);
    }

    return this.getProject(projectId)!;
  }

  async pauseProject(projectId: string): Promise<ProjectDetails> {
    const project = this.getProjectSummaryOrThrow(projectId);
    project.status = "paused";
    project.updatedAt = new Date().toISOString();
    this.schedulePersist();
    this.emit("event", { type: "project-updated", project: { ...project } });

    for (const agent of this.state.agents) {
      if (agent.projectId !== projectId) {
        continue;
      }
      agent.status = "paused";
      agent.updatedAt = new Date().toISOString();
      this.emit("event", { type: "agent-updated", agent: this.toAgentSummary(agent) });
    }

    return this.getProject(projectId)!;
  }

  getSettings(): GlobalSettings {
    return structuredClone(this.settings);
  }

  async updateProviderConfig(input: ProviderConfig): Promise<GlobalSettings> {
    this.settings.provider = {
      provider: "openai",
      baseUrl: input.baseUrl.trim(),
      apiKey: input.apiKey,
      model: input.model.trim(),
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
    };
    await this.settingsStore.save(this.settings);
    return this.getSettings();
  }

  async updateNotificationConfig(input: NotificationConfig): Promise<GlobalSettings> {
    this.settings.notifications = {
      smtpHost: input.smtpHost.trim(),
      smtpPort: input.smtpPort,
      smtpUser: input.smtpUser,
      smtpPass: input.smtpPass,
      smtpFrom: input.smtpFrom.trim(),
      smtpSecure: Boolean(input.smtpSecure),
    };
    await this.settingsStore.save(this.settings);
    return this.getSettings();
  }

  listNotifications(projectId?: string): ProjectNotification[] {
    return this.state.notifications
      .filter((item) => !projectId || item.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async handleSessionManagerEvent(event: DaemonEvent): Promise<void> {
    switch (event.type) {
      case "session-created":
      case "session-updated": {
        const enriched = this.enrichSessionSummary(event.session);
        this.emit("event", { ...event, session: enriched });
        void this.refreshGitForSession(enriched);
        return;
      }
      case "session-deleted": {
        const projectId = this.state.sessionProjectIds[event.sessionId];
        if (projectId) {
          delete this.state.sessionProjectIds[event.sessionId];
          const project = this.state.projects.find((item) => item.id === projectId);
          if (project) {
            project.sessionIds = project.sessionIds.filter((id) => id !== event.sessionId);
            project.updatedAt = new Date().toISOString();
            this.emit("event", { type: "project-updated", project: { ...project } });
          }
          for (const agent of this.state.agents) {
            if (agent.boundSessionId !== event.sessionId) {
              continue;
            }
            agent.boundSessionId = undefined;
            agent.status = "idle";
            agent.updatedAt = new Date().toISOString();
            this.emit("event", { type: "agent-updated", agent: this.toAgentSummary(agent) });
          }
          this.schedulePersist();
        }
        this.emit("event", event);
        return;
      }
      default:
        this.emit("event", event);
    }
  }

  private getProjectSummaryOrThrow(projectId: string): ProjectSummary {
    const project = this.state.projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return project;
  }

  private getAgentOrThrow(agentId: string): AgentDetails {
    const agent = this.state.agents.find((item) => item.id === agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    return agent;
  }

  private createAgent(
    projectId: string,
    role: AgentRole,
    input: {
      name: string;
      boundSessionId?: string;
    },
  ): AgentDetails {
    const now = new Date().toISOString();
    const agent: AgentDetails = {
      id: randomUUID(),
      projectId,
      role,
      name: input.name,
      status: "idle",
      boundSessionId: input.boundSessionId,
      createdAt: now,
      updatedAt: now,
      model: this.settings.provider.model,
      provider: this.settings.provider.provider,
      memory: {
        summary: "",
        summaryUpdatedAt: now,
        windowEntryIds: [],
      },
      logs: [],
    };
    this.state.agents.push(agent);
    this.schedulePersist();
    return agent;
  }

  private toAgentSummary(agent: AgentDetails): AgentSummary {
    return {
      id: agent.id,
      projectId: agent.projectId,
      role: agent.role,
      name: agent.name,
      status: agent.status,
      boundSessionId: agent.boundSessionId,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      model: agent.model,
      provider: agent.provider,
      lastError: agent.lastError,
    };
  }

  private appendAgentLog(
    agent: AgentDetails,
    input: Omit<AgentLogEntry, "id" | "agentId" | "createdAt">,
  ): AgentLogEntry {
    const entry: AgentLogEntry = {
      id: randomUUID(),
      agentId: agent.id,
      createdAt: new Date().toISOString(),
      ...input,
    };
    agent.logs.push(entry);
    agent.updatedAt = entry.createdAt;
    agent.memory.windowEntryIds.push(entry.id);
    this.compactAgentMemory(agent);
    this.schedulePersist();
    this.emit("event", { type: "agent-log-entry", entry });
    this.emit("event", { type: "agent-updated", agent: this.toAgentSummary(agent) });
    return entry;
  }

  private compactAgentMemory(agent: AgentDetails): void {
    const totalChars = agent.logs.reduce((sum, entry) => sum + entry.text.length, 0) + agent.memory.summary.length;
    if (totalChars <= AGENT_CONTEXT_WINDOW_CHARS && agent.logs.length <= AGENT_RECENT_LOG_LIMIT * 2) {
      agent.memory.windowEntryIds = agent.logs.map((entry) => entry.id);
      return;
    }

    const retainedLogs = agent.logs.slice(-AGENT_RECENT_LOG_LIMIT);
    const droppedLogs = agent.logs.slice(0, Math.max(0, agent.logs.length - AGENT_RECENT_LOG_LIMIT));
    const droppedSummary = droppedLogs
      .map((entry) => `[${entry.kind}] ${entry.text.replace(/\s+/g, " ").trim()}`)
      .join("\n")
      .slice(0, 24_000);

    agent.memory.summary = [agent.memory.summary, droppedSummary].filter(Boolean).join("\n").slice(-60_000);
    agent.memory.summaryUpdatedAt = new Date().toISOString();
    agent.logs = retainedLogs;
    agent.memory.windowEntryIds = retainedLogs.map((entry) => entry.id);
  }

  private enqueueAgent(agentId: string): void {
    this.agentQueue.add(agentId);
    queueMicrotask(() => {
      void this.drainAgentQueue();
    });
  }

  private async drainAgentQueue(): Promise<void> {
    for (const agentId of Array.from(this.agentQueue)) {
      if (this.runningAgents.has(agentId)) {
        continue;
      }
      this.agentQueue.delete(agentId);
      this.runningAgents.add(agentId);
      try {
        await this.runAgent(agentId);
      } finally {
        this.runningAgents.delete(agentId);
      }
    }
  }

  private async runAgent(agentId: string): Promise<void> {
    const agent = this.getAgentOrThrow(agentId);
    const project = this.getProjectSummaryOrThrow(agent.projectId);

    if (project.status === "paused") {
      agent.status = "paused";
      agent.updatedAt = new Date().toISOString();
      this.emit("event", { type: "agent-updated", agent: this.toAgentSummary(agent) });
      return;
    }

    if (!this.settings.provider.apiKey.trim()) {
      agent.status = "blocked";
      agent.lastError = "Provider API key is not configured.";
      agent.updatedAt = new Date().toISOString();
      this.appendAgentLog(agent, {
        kind: "system",
        direction: "internal",
        text: agent.lastError,
      });
      return;
    }

    agent.status = "running";
    agent.lastError = undefined;
    agent.updatedAt = new Date().toISOString();
    this.emit("event", { type: "agent-updated", agent: this.toAgentSummary(agent) });

    try {
      const client = new OpenAiAgentClient(this.settings.provider);
      const decision = await client.decide(agent, this.buildAgentPrompt(agent, project));
      if (decision.thought) {
        this.appendAgentLog(agent, {
          kind: "thought",
          direction: "internal",
          text: decision.thought,
        });
      }
      await this.applyAgentDecision(agent, project, decision);
      agent.status = project.status === "running" ? "waiting" : "idle";
      agent.updatedAt = new Date().toISOString();
      this.emit("event", { type: "agent-updated", agent: this.toAgentSummary(agent) });
    } catch (error) {
      agent.status = "failed";
      agent.lastError = error instanceof Error ? error.message : String(error);
      agent.updatedAt = new Date().toISOString();
      this.appendAgentLog(agent, {
        kind: "system",
        direction: "internal",
        text: `Agent run failed: ${agent.lastError}`,
      });
    }
  }

  private buildAgentPrompt(
    agent: AgentDetails,
    project: ProjectSummary,
  ): Array<{ role: "system" | "user"; content: string }> {
    const projectSessions = this.listSessions().filter((session) => session.projectId === project.id);
    const siblingAgents = this.listAgents(project.id);
    const recentLogs = agent.logs
      .slice(-AGENT_RECENT_LOG_LIMIT)
      .map((entry) => `${entry.createdAt} [${entry.kind}/${entry.direction}] ${entry.text}`)
      .join("\n");

    return [
      {
        role: "system",
        content: [
          `You are ${agent.role} for project "${project.name}".`,
          "Follow ReAct. Return strict JSON with keys thought, action, actionInput, stopReason, userFacingText.",
          "Available actions: noop, create_session, send_session_instruction, message_agent, notify_user, mark_project_complete.",
          "Keep working until blocked, complete, or user guidance is required.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            project,
            agent: this.toAgentSummary(agent),
            memorySummary: agent.memory.summary,
            sessions: projectSessions,
            agents: siblingAgents,
            recentLogs,
          },
          null,
          2,
        ),
      },
    ];
  }

  private async applyAgentDecision(
    agent: AgentDetails,
    project: ProjectSummary,
    decision: {
      action: string;
      actionInput?: Record<string, unknown>;
      stopReason?: string;
      userFacingText?: string;
    },
  ): Promise<void> {
    this.appendAgentLog(agent, {
      kind: "decision",
      direction: "internal",
      text: JSON.stringify(decision),
    });

    switch (decision.action) {
      case "create_session": {
        const session = await this.createProjectSession(project.id, {
          cwd:
            typeof decision.actionInput?.cwd === "string" && decision.actionInput.cwd.trim()
              ? decision.actionInput.cwd
              : project.defaultSessionCwd,
          model: typeof decision.actionInput?.model === "string" ? decision.actionInput.model : undefined,
          reasoningEffort:
            typeof decision.actionInput?.reasoningEffort === "string"
              ? (decision.actionInput.reasoningEffort as CreateSessionInput["reasoningEffort"])
              : undefined,
          sandbox:
            typeof decision.actionInput?.sandbox === "string"
              ? (decision.actionInput.sandbox as CreateSessionInput["sandbox"])
              : undefined,
          approvalPolicy:
            typeof decision.actionInput?.approvalPolicy === "string"
              ? (decision.actionInput.approvalPolicy as CreateSessionInput["approvalPolicy"])
              : undefined,
        });
        this.appendAgentLog(agent, {
          kind: "action",
          direction: "outbound",
          text: `Created session ${session.title} (${session.id}).`,
        });

        const instruction =
          typeof decision.actionInput?.instruction === "string" ? decision.actionInput.instruction.trim() : "";
        if (instruction) {
          await this.sendMessage(session.id, instruction);
        }
        return;
      }
      case "send_session_instruction": {
        const sessionId =
          typeof decision.actionInput?.sessionId === "string" && decision.actionInput.sessionId
            ? decision.actionInput.sessionId
            : agent.boundSessionId;
        const instruction =
          typeof decision.actionInput?.text === "string" ? decision.actionInput.text.trim() : "";
        if (!sessionId || !instruction) {
          throw new Error("send_session_instruction requires sessionId/text");
        }
        await this.sendMessage(sessionId, instruction);
        this.appendAgentLog(agent, {
          kind: "action",
          direction: "outbound",
          text: `Sent instruction to session ${sessionId}: ${instruction}`,
        });
        return;
      }
      case "message_agent": {
        const targetAgentId =
          typeof decision.actionInput?.targetAgentId === "string" ? decision.actionInput.targetAgentId : "";
        const text = typeof decision.actionInput?.text === "string" ? decision.actionInput.text.trim() : "";
        if (!targetAgentId || !text) {
          throw new Error("message_agent requires targetAgentId/text");
        }
        const target = this.getAgentOrThrow(targetAgentId);
        this.appendAgentLog(target, {
          kind: "agent_message",
          direction: "inbound",
          sourceAgentId: agent.id,
          text,
        });
        this.appendAgentLog(agent, {
          kind: "action",
          direction: "outbound",
          targetAgentId,
          text: `Sent message to agent ${target.name}: ${text}`,
        });
        this.enqueueAgent(target.id);
        return;
      }
      case "notify_user": {
        const severity =
          decision.actionInput?.severity === "warning" || decision.actionInput?.severity === "critical"
            ? decision.actionInput.severity
            : "info";
        const channel = decision.actionInput?.channel === "email" ? "email" : "inbox";
        const subject =
          typeof decision.actionInput?.subject === "string" && decision.actionInput.subject.trim()
            ? decision.actionInput.subject.trim()
            : `${project.name} update`;
        const body = typeof decision.actionInput?.body === "string" ? decision.actionInput.body.trim() : "";

        await this.createNotification({
          projectId: project.id,
          severity,
          channel,
          subject,
          body: body || decision.userFacingText || decision.stopReason || "Project update",
          status: "pending",
          createdAt: new Date().toISOString(),
          id: randomUUID(),
        });
        return;
      }
      case "mark_project_complete": {
        project.status = "completed";
        project.updatedAt = new Date().toISOString();
        this.schedulePersist();
        this.emit("event", { type: "project-updated", project: { ...project } });
        return;
      }
      case "noop":
      default:
        if (decision.userFacingText?.trim()) {
          await this.createNotification({
            id: randomUUID(),
            projectId: project.id,
            severity: "info",
            channel: "inbox",
            subject: `${project.name} update`,
            body: decision.userFacingText.trim(),
            status: "pending",
            createdAt: new Date().toISOString(),
          });
        }
    }
  }

  private async createNotification(
    notification: Omit<ProjectNotification, "sentAt" | "scheduledAt"> & {
      scheduledAt?: string;
      sentAt?: string;
    },
  ): Promise<void> {
    const next: ProjectNotification = { ...notification };
    this.state.notifications.push(next);
    this.schedulePersist();

    if (next.channel === "email") {
      try {
        await this.sendEmailNotification(next);
        next.status = "sent";
        next.sentAt = new Date().toISOString();
      } catch (error) {
        next.status = "failed";
        next.body = `${next.body}\n\nEmail error: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else {
      next.status = "sent";
      next.sentAt = new Date().toISOString();
    }

    this.emit("event", { type: "project-notification", notification: { ...next } });
  }

  private async sendEmailNotification(notification: ProjectNotification): Promise<void> {
    const config = this.settings.notifications;
    if (!config.smtpHost || !config.smtpFrom) {
      throw new Error("SMTP is not configured.");
    }

    const transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
    });

    await transporter.sendMail({
      from: config.smtpFrom,
      to: config.smtpUser || config.smtpFrom,
      subject: notification.subject,
      text: notification.body,
    });
  }

  private findProjectAgent(projectId: string, role: AgentRole): AgentDetails | undefined {
    return this.state.agents.find((agent) => agent.projectId === projectId && agent.role === role);
  }

  private enrichSessionSummary(session: SessionSummary): SessionSummary {
    const projectId = this.state.sessionProjectIds[session.id];
    const git = this.getCachedGitSummary(session.cwd);
    if (!git) {
      void this.refreshGitForSession(session);
    }
    return {
      ...session,
      projectId,
      git,
    };
  }

  private enrichSessionDetails(
    session: SessionDetails,
    gitDetails?: SessionGitDetails,
  ): SessionDetails {
    const summary = this.enrichSessionSummary(session);
    return {
      ...session,
      ...summary,
      gitDetails,
    };
  }

  private getCachedGitSummary(cwd: string): SessionGitSummary | undefined {
    return this.gitCache.get(cwd)?.summary;
  }

  private getCachedGitDetails(cwd: string): SessionGitDetails | undefined {
    return this.gitCache.get(cwd)?.details;
  }

  private async refreshGitForSession(session: Pick<SessionSummary, "id" | "cwd">): Promise<void> {
    const existing = this.gitCache.get(session.cwd);
    if (existing?.inFlight) {
      return existing.inFlight;
    }
    if (existing && existing.expiresAt > Date.now()) {
      return;
    }

    const current: GitCacheEntry = existing ?? { expiresAt: 0 };
    current.inFlight = this.loadGitDetails(session.cwd)
      .then((details) => {
        const previousSerialized = JSON.stringify(current.summary);
        current.summary = this.toGitSummary(details);
        current.details = details;
        current.expiresAt = Date.now() + GIT_CACHE_TTL_MS;
        this.gitCache.set(session.cwd, current);
        if (JSON.stringify(current.summary) !== previousSerialized) {
          this.emit("event", {
            type: "session-git-updated",
            sessionId: session.id,
            git: current.summary,
          });
        }
      })
      .catch(() => {
        current.summary = {
          isRepo: false,
          modifiedFileCount: 0,
          stagedFileCount: 0,
          untrackedFileCount: 0,
        };
        current.details = {
          ...current.summary,
          modifiedFiles: [],
          stagedFiles: [],
          untrackedFiles: [],
        };
        current.expiresAt = Date.now() + GIT_CACHE_TTL_MS;
        this.gitCache.set(session.cwd, current);
      })
      .finally(() => {
        current.inFlight = undefined;
      });

    this.gitCache.set(session.cwd, current);
    await current.inFlight;
  }

  private async loadGitDetails(cwd: string): Promise<SessionGitDetails> {
    const branch = (await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim();
    const statusOutput = (await execFile("git", ["status", "--short"], { cwd })).stdout;
    const headOutput = (await execFile("git", ["log", "-1", "--pretty=format:%H%n%s%n%cI"], { cwd })).stdout;
    const headLines = headOutput.split(/\r?\n/);
    const modifiedFiles: string[] = [];
    const stagedFiles: string[] = [];
    const untrackedFiles: string[] = [];

    for (const line of statusOutput.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const staged = line.slice(0, 1);
      const unstaged = line.slice(1, 2);
      const file = line.slice(3).trim();
      if (staged === "?") {
        untrackedFiles.push(file);
        continue;
      }
      if (staged !== " " && staged !== "?") {
        stagedFiles.push(file);
      }
      if (unstaged !== " ") {
        modifiedFiles.push(file);
      }
    }

    return {
      isRepo: true,
      branch,
      modifiedFileCount: modifiedFiles.length,
      stagedFileCount: stagedFiles.length,
      untrackedFileCount: untrackedFiles.length,
      head: headLines[0]
        ? {
            hash: headLines[0],
            subject: headLines[1] ?? "",
            committedAt: headLines[2] ?? undefined,
          }
        : undefined,
      modifiedFiles,
      stagedFiles,
      untrackedFiles,
    };
  }

  private toGitSummary(details: SessionGitDetails): SessionGitSummary {
    return {
      isRepo: details.isRepo,
      branch: details.branch,
      modifiedFileCount: details.modifiedFileCount,
      stagedFileCount: details.stagedFileCount,
      untrackedFileCount: details.untrackedFileCount,
      head: details.head,
    };
  }

  private uniqueIds(ids: string[]): string[] {
    return Array.from(new Set(ids));
  }

  private async ensureDirectoryExists(targetPath: string): Promise<void> {
    const stat = await fs.stat(targetPath);
    if (!stat.isDirectory()) {
      throw new Error(`Project root is not a directory: ${targetPath}`);
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flushPersist();
    }, 80);
  }

  private async flushPersist(): Promise<void> {
    if (this.persistInFlight) {
      return;
    }
    this.persistInFlight = true;
    try {
      await this.projectStore.save(this.state);
    } finally {
      this.persistInFlight = false;
      if (this.persistTimer) {
        return;
      }
    }
  }
}
