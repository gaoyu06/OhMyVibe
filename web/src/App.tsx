import { useEffect, useMemo, useRef, useState } from "react";
import { AppHeader } from "@/components/app/AppHeader";
import { type ConnectionState, useDaemonConnection } from "@/components/app/useDaemonConnection";
import { AppMainPane } from "@/components/app/AppMainPane";
import { AppSidebar } from "@/components/app/AppSidebar";
import { useHistoryRestore } from "@/components/app/useHistoryRestore";
import { OverviewPane } from "@/components/app/OverviewPane";
import { type PendingAssistantState, useChatTranscript } from "@/components/app/useChatTranscript";
import { useOverviewLayouts } from "@/components/app/useOverviewLayouts";
import { useSessionFiles } from "@/components/app/useSessionFiles";
import { fetchControlApi } from "@/lib/controlApi";
import type {
  AgentDetails,
  AgentSummary,
  DaemonConfig,
  DaemonDescriptor,
  DaemonEvent,
  DirectoryBrowseResult,
  GlobalSettings,
  ProjectNotification,
  ProjectSummary,
  SessionDetails,
  SessionTranscriptPage,
  SessionSummary,
  TranscriptEntry,
} from "@/lib/types";

const DEFAULT_CONTROL_URL = import.meta.env.VITE_CONTROL_SERVER_URL || window.location.origin;
const TRANSCRIPT_INITIAL_COUNT = 80;
const TRANSCRIPT_CHUNK_SIZE = 60;
type ThemeMode = "light" | "dark";

function App() {
  const [viewMode, setViewMode] = useState<"chat" | "overview">("chat");
  const [theme, setTheme] = useState<ThemeMode>(
    () => (localStorage.getItem("ohmyvibe-theme") as ThemeMode) || "dark",
  );
  const controlUrl = DEFAULT_CONTROL_URL;
  const [daemons, setDaemons] = useState<DaemonDescriptor[]>([]);
  const [activeDaemonId, setActiveDaemonId] = useState<string | null>(null);
  const [config, setConfig] = useState<DaemonConfig>({ models: [] });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeAgent, setActiveAgent] = useState<AgentDetails | null>(null);
  const [projectNotifications, setProjectNotifications] = useState<ProjectNotification[]>([]);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<"sessions" | "agents">("sessions");
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionDetails | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sessionLoading, setSessionLoading] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [renameSessionOpen, setRenameSessionOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [renamingSession, setRenamingSession] = useState(false);
  const [approvalActionId, setApprovalActionId] = useState<string | null>(null);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [loadingOlderTranscript, setLoadingOlderTranscript] = useState(false);
  const [pendingAssistant, setPendingAssistant] = useState<PendingAssistantState | null>(null);
  const [composer, setComposer] = useState("");
  const [cwd, setCwd] = useState("C:\\");
  const [directoryBrowser, setDirectoryBrowser] = useState<DirectoryBrowseResult | null>(null);
  const [directoryBrowserLoading, setDirectoryBrowserLoading] = useState(false);
  const [directoryBrowserPath, setDirectoryBrowserPath] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectGoal, setProjectGoal] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("medium");
  const [sandbox, setSandbox] = useState<"read-only" | "workspace-write" | "danger-full-access">(
    "danger-full-access",
  );
  const [approvalPolicy, setApprovalPolicy] = useState<
    "untrusted" | "on-failure" | "on-request" | "never"
  >("never");
  const activeDaemonIdRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const loadSessionRequestIdRef = useRef(0);
  const loadOlderTranscriptRequestIdRef = useRef(0);
  const subscribedSessionId = viewMode === "chat" ? activeSessionId : null;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("ohmyvibe-theme", theme);
  }, [theme]);

  const connectionState: ConnectionState = useDaemonConnection({
    controlUrl,
    activeDaemonId,
    activeSessionId,
    subscribedSessionId,
    onHelloDaemons: (nextDaemons) => {
      setDaemons(nextDaemons);
      setActiveDaemonId((current) => current ?? nextDaemons[0]?.id ?? null);
    },
    onDaemonConnected: (daemon) => {
      setDaemons((current) => upsertDaemon(current, daemon));
      setActiveDaemonId((current) => current ?? daemon.id);
    },
    onDaemonDisconnected: (daemonId) => {
      setDaemons((current) =>
        current.map((daemon) =>
          daemon.id === daemonId
            ? { ...daemon, online: false, lastSeenAt: new Date().toISOString() }
            : daemon,
        ),
      );
    },
    onDaemonEvent: handleDaemonEvent,
    onFlushActiveSessionEvents: (events) => {
      setActiveSession((current) => applyQueuedActiveSessionEvents(current, events));
    },
  });

  useEffect(() => {
    activeDaemonIdRef.current = activeDaemonId;
  }, [activeDaemonId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeDaemonId) {
      setConfig({ models: [] });
      setSessions([]);
      setProjects([]);
      setAgents([]);
      setActiveProjectId(null);
      setActiveAgentId(null);
      setActiveAgent(null);
      setProjectNotifications([]);
      setSettings(null);
      setActiveSession(null);
      setActiveSessionId(null);
      return;
    }
    void loadConfig(activeDaemonId);
    void loadSessions(activeDaemonId);
    void loadProjects(activeDaemonId);
    void loadSettings(activeDaemonId);
  }, [activeDaemonId]);

  useEffect(() => {
    if (!activeDaemonId || !activeSessionId || viewMode !== "chat") {
      return;
    }
    void loadSession(activeDaemonId, activeSessionId);
  }, [activeDaemonId, activeSessionId, viewMode]);

  useEffect(() => {
    if (!activeDaemonId || !activeProjectId) {
      setAgents([]);
      setActiveAgentId(null);
      setActiveAgent(null);
      setProjectNotifications([]);
      return;
    }
    void loadAgents(activeDaemonId, activeProjectId);
    void loadNotifications(activeDaemonId, activeProjectId);
  }, [activeDaemonId, activeProjectId]);

  useEffect(() => {
    if (!activeDaemonId || !activeProjectId || !activeAgentId) {
      setActiveAgent(null);
      return;
    }
    void loadAgent(activeDaemonId, activeProjectId, activeAgentId);
  }, [activeAgentId, activeDaemonId, activeProjectId]);

  useEffect(() => {
    loadOlderTranscriptRequestIdRef.current += 1;
    setLoadingOlderTranscript(false);
    setPendingAssistant(null);
    setSendingMessage(false);
    resetTranscriptUiState();
  }, [activeSessionId]);

  useEffect(() => {
    setRenameTitle(activeSession?.title ?? "");
  }, [activeSession?.id, activeSession?.title]);

  const currentModel = useMemo(
    () => config.models.find((item) => item.model === model) ?? config.models[0],
    [config.models, model],
  );

  useEffect(() => {
    if (!config.models.length) {
      return;
    }
    const resolvedModel = model || config.defaultModel || config.models[0]?.model || "";
    setModel(resolvedModel);
    const nextEffort =
      currentModel?.supportedReasoningEfforts.find((item) => item.reasoningEffort === effort)?.reasoningEffort ??
      currentModel?.defaultReasoningEffort ??
      "medium";
    setEffort(nextEffort);
  }, [config, currentModel, effort, model]);

  useEffect(() => {
    if (!activeSession) {
      return;
    }
    if (activeSession.model) {
      setModel(activeSession.model);
    }
    if (activeSession.reasoningEffort) {
      setEffort(activeSession.reasoningEffort);
    }
    if (activeSession.sandbox) {
      setSandbox(activeSession.sandbox);
    }
    if (activeSession.approvalPolicy) {
      setApprovalPolicy(activeSession.approvalPolicy);
    } else if (activeSession.sandbox) {
      setApprovalPolicy(defaultApprovalPolicyForSandbox(activeSession.sandbox));
    }
  }, [
    activeSession?.id,
    activeSession?.model,
    activeSession?.reasoningEffort,
    activeSession?.sandbox,
    activeSession?.approvalPolicy,
  ]);

  const {
    transcriptRef,
    transcript,
    visibleTranscript,
    hasOlderTranscript,
    showScrollToBottom,
    virtualItems,
    measureRow,
    totalSize,
    chatRowCount,
    handleTranscriptScroll,
    scrollTranscriptToBottom,
    prepareForOutgoingMessage,
    resetTranscriptUiState,
  } = useChatTranscript({
    activeSessionId,
    activeSession,
    pendingAssistant,
    loadingOlderTranscript,
    onLoadOlderTranscriptPage: () => {
      void loadOlderTranscriptPage();
    },
  });
  const {
    sessionPane,
    setSessionPane,
    projectFiles,
    projectFilesLoading,
    selectedFile,
    selectedFileLoading,
    fileEditorValue,
    savingFile,
    setFileEditorValue,
    setFileSelectionText,
    openFilesPane,
    browseProjectPath,
    openProjectFile,
    saveProjectFile,
    quoteFileSelection,
  } = useSessionFiles({
    controlUrl,
    activeDaemonId,
    activeSessionId,
    activeSessionCwd: activeSession?.cwd,
    onAppendQuoteToComposer: (quoted) => {
      setComposer((current) => `${current}${quoted}`.trimStart());
    },
  });
  const {
    historySearch,
    setHistorySearch,
    historyOpen,
    setHistoryOpen,
    historyLoading,
    groupedHistory,
    restoringHistoryId,
    restoreSession,
  } = useHistoryRestore({
    controlUrl,
    activeDaemonId,
    cwd,
    model,
    effort,
    sandbox,
    approvalPolicy,
    onRestoredSession: (session) => {
      const normalizedSession = normalizeSessionDetails(session);
      setActiveSessionId(normalizedSession.id);
      setActiveSession(normalizedSession);
      setSessions((current) => upsertSessionSummary(current, normalizedSession));
    },
  });
  const activeDaemon = daemons.find((item) => item.id === activeDaemonId) ?? null;
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const visibleSessions = useMemo(() => {
    if (!activeDaemonId || !activeProjectId) {
      return [] as SessionSummary[];
    }
    return sessions.filter((session) => session.projectId === activeProjectId);
  }, [activeDaemonId, activeProjectId, sessions]);
  const visibleAgents = useMemo(
    () => agents.filter((agent) => agent.projectId === activeProjectId),
    [activeProjectId, agents],
  );
  const overviewSessions = useMemo(
    () =>
      [...visibleSessions]
        .filter((session) => session.status !== "closed"),
    [visibleSessions],
  );
  const { overviewScrollRef, currentOverviewLayout, canvasStyle, startSessionDrag } = useOverviewLayouts({
    activeDaemonId,
    activeProjectId,
    overviewSessions,
  });
  useEffect(() => {
    if (!activeDaemonId || !activeProjectId) {
      setActiveSessionId(null);
      setActiveSession(null);
      return;
    }
    const nextSessionId =
      (activeSessionId && visibleSessions.some((session) => session.id === activeSessionId)
        ? activeSessionId
        : null) ??
      visibleSessions[0]?.id ??
      null;
    if (nextSessionId !== activeSessionId) {
      setActiveSessionId(nextSessionId);
    }
    if (!nextSessionId) {
      setActiveSession(null);
    }
  }, [activeDaemonId, activeProjectId, activeSessionId, visibleSessions]);

  useEffect(() => {
    if (!activeProject) {
      return;
    }
    setCwd(activeProject.defaultSessionCwd || activeProject.rootDir);
    setProjectName(activeProject.name);
    setProjectGoal(activeProject.goal);
  }, [activeProject]);

  useEffect(() => {
    if (sidebarMode !== "agents") {
      return;
    }
    const nextAgentId =
      (activeAgentId && visibleAgents.some((agent) => agent.id === activeAgentId) ? activeAgentId : null) ??
      visibleAgents[0]?.id ??
      null;
    if (nextAgentId !== activeAgentId) {
      setActiveAgentId(nextAgentId);
    }
  }, [activeAgentId, sidebarMode, visibleAgents]);

  useEffect(() => {
    if (!activeSessionId) {
      setActiveSession(null);
      return;
    }

    setActiveSession((current) => (current?.id === activeSessionId ? current : null));
  }, [activeSessionId]);

  useEffect(() => {
    if (!pendingAssistant || pendingAssistant.sessionId !== activeSessionId) {
      return;
    }
    const serverEntries = transcript.slice(pendingAssistant.baseTranscriptCount);
    const hasServerUser = serverEntries.some(
      (entry) =>
        entry.kind === "user" &&
        entry.text.trim() === pendingAssistant.userEntry.text.trim(),
    );
    const hasServerResponse = serverEntries.some((entry) => entry.kind !== "user");
    if (hasServerUser && hasServerResponse) {
      setPendingAssistant(null);
      setSendingMessage(false);
      return;
    }
    if (activeSession && ["completed", "failed", "interrupted", "idle"].includes(activeSession.status)) {
      if (hasServerResponse || activeSession.status === "interrupted" || activeSession.status === "failed") {
        setPendingAssistant(null);
      }
      setSendingMessage(false);
    }
  }, [activeSession, activeSessionId, pendingAssistant, transcript]);

  function handleDaemonEvent(event: DaemonEvent) {
    if (event.type === "session-created" || event.type === "session-updated") {
      const session = normalizeSessionSummary(event.session);
      setSessions((current) => upsertSessionSummary(current, session));
      setActiveSession((current) =>
        current && current.id === session.id ? { ...current, ...session } : current,
      );
      return;
    }

    if (event.type === "session-deleted") {
      setSessions((current) => current.filter((session) => session.id !== event.sessionId));
      setActiveSession((current) => (current?.id === event.sessionId ? null : current));
      setActiveSessionId((current) => (current === event.sessionId ? null : current));
      return;
    }

    if (event.type === "session-git-updated") {
      setSessions((current) =>
        current.map((session) =>
          session.id === event.sessionId ? { ...session, git: event.git } : session,
        ),
      );
      setActiveSession((current) =>
        current?.id === event.sessionId ? { ...current, git: event.git, gitDetails: current.gitDetails } : current,
      );
      return;
    }

    if (event.type === "project-created" || event.type === "project-updated") {
      setProjects((current) => upsertProjectSummary(current, event.project));
      setActiveProjectId((current) => current ?? event.project.id);
      return;
    }

    if (event.type === "agent-created" || event.type === "agent-updated") {
      setAgents((current) => upsertAgentSummary(current, event.agent));
      setActiveAgent((current) =>
        current?.id === event.agent.id ? { ...current, ...event.agent } : current,
      );
      return;
    }

    if (event.type === "agent-log-entry") {
      setActiveAgent((current) =>
        current?.id === event.entry.agentId
          ? {
              ...current,
              updatedAt: event.entry.createdAt,
              logs: [...current.logs, event.entry],
            }
          : current,
      );
      return;
    }

    if (event.type === "project-notification") {
      setProjectNotifications((current) => upsertProjectNotification(current, event.notification));
    }
  }

  async function api<T>(path: string, options?: RequestInit) {
    return fetchControlApi<T>(controlUrl, path, options);
  }

  async function loadConfig(daemonId: string) {
    const nextConfig = await api<DaemonConfig>(`/api/daemons/${daemonId}/config`);
    setConfig(nextConfig);
    const nextModel = nextConfig.defaultModel || nextConfig.models[0]?.model || "";
    if (nextModel) {
      setModel(nextModel);
      const foundModel = nextConfig.models.find((item) => item.model === nextModel);
      setEffort(foundModel?.defaultReasoningEffort || "medium");
    }
  }

  async function loadSessions(daemonId: string) {
    const nextSessions = await api<SessionSummary[]>(`/api/daemons/${daemonId}/sessions`);
    setSessions(nextSessions.map(normalizeSessionSummary));
  }

  async function loadProjects(daemonId: string) {
    const nextProjects = await api<ProjectSummary[]>(`/api/daemons/${daemonId}/projects`);
    setProjects(nextProjects);
    setActiveProjectId((current) => {
      if (current && nextProjects.some((project) => project.id === current)) {
        return current;
      }
      return nextProjects[0]?.id ?? null;
    });
  }

  async function loadAgents(daemonId: string, projectId: string) {
    const nextAgents = await api<AgentSummary[]>(`/api/daemons/${daemonId}/projects/${projectId}/agents`);
    setAgents((current) => mergeAgentSummaries(current, nextAgents, projectId));
  }

  async function loadAgent(daemonId: string, projectId: string, agentId: string) {
    const nextAgent = await api<AgentDetails>(
      `/api/daemons/${daemonId}/projects/${projectId}/agents/${agentId}`,
    );
    setActiveAgent(nextAgent);
    setAgents((current) => upsertAgentSummary(current, nextAgent));
  }

  async function loadNotifications(daemonId: string, projectId: string) {
    const nextNotifications = await api<ProjectNotification[]>(
      `/api/daemons/${daemonId}/projects/${projectId}/notifications`,
    );
    setProjectNotifications(nextNotifications);
  }

  async function loadSettings(daemonId: string) {
    const nextSettings = await api<GlobalSettings>(`/api/daemons/${daemonId}/settings`);
    setSettings(nextSettings);
  }

  async function loadSession(daemonId: string, sessionId: string) {
    const requestId = loadSessionRequestIdRef.current + 1;
    loadSessionRequestIdRef.current = requestId;
    setSessionLoading(true);
    try {
      const session = normalizeSessionDetails(
        await api<SessionDetails>(
          `/api/daemons/${daemonId}/sessions/${sessionId}?limit=${TRANSCRIPT_INITIAL_COUNT}`,
        ),
      );
      if (loadSessionRequestIdRef.current !== requestId) {
        return;
      }
      if (activeDaemonIdRef.current === daemonId && activeSessionIdRef.current === sessionId) {
        setActiveSession(session);
      }
    } finally {
      if (loadSessionRequestIdRef.current === requestId) {
        setSessionLoading(false);
      }
    }
  }

  async function loadOlderTranscriptPage() {
    if (!activeDaemonId || !activeSessionId || !activeSession?.transcript.length || loadingOlderTranscript) {
      return;
    }

    const beforeEntryId = activeSession.transcript[0]?.id;
    if (!beforeEntryId || !activeSession.hasMoreTranscriptBefore) {
      return;
    }

    const requestId = loadOlderTranscriptRequestIdRef.current + 1;
    loadOlderTranscriptRequestIdRef.current = requestId;
    setLoadingOlderTranscript(true);
    try {
      const page = await api<SessionTranscriptPage>(
        `/api/daemons/${activeDaemonId}/sessions/${activeSessionId}/transcript?beforeEntryId=${encodeURIComponent(beforeEntryId)}&limit=${TRANSCRIPT_CHUNK_SIZE}`,
      );
      if (
        loadOlderTranscriptRequestIdRef.current !== requestId ||
        activeDaemonIdRef.current !== activeDaemonId ||
        activeSessionIdRef.current !== activeSessionId
      ) {
        return;
      }

      setActiveSession((current) => prependTranscriptPage(current, page));
    } finally {
      if (loadOlderTranscriptRequestIdRef.current === requestId) {
        setLoadingOlderTranscript(false);
      }
    }
  }

  async function loadDirectories(daemonId: string, nextPath?: string) {
    setDirectoryBrowserLoading(true);
    try {
      const query = nextPath ? `?path=${encodeURIComponent(nextPath)}` : "";
      const result = await api<DirectoryBrowseResult>(`/api/daemons/${daemonId}/directories${query}`);
      setDirectoryBrowser(result);
      setDirectoryBrowserPath(result.currentPath);
      return result;
    } finally {
      setDirectoryBrowserLoading(false);
    }
  }

  async function handleCreateSession() {
    if (!activeDaemonId || !activeProjectId) {
      return;
    }
    setCreatingSession(true);
    try {
      const session = normalizeSessionDetails(
        await api<SessionDetails>(`/api/daemons/${activeDaemonId}/projects/${activeProjectId}/sessions`, {
          method: "POST",
          body: JSON.stringify({
            cwd,
            model,
            reasoningEffort: effort,
            sandbox,
            approvalPolicy,
          }),
        }),
      );
      setActiveSessionId(session.id);
      setActiveSession(session);
      setSessions((current) => upsertSessionSummary(current, session));
      setComposer("");
      setNewSessionOpen(false);
    } finally {
      setCreatingSession(false);
    }
  }

  async function handleCreateProject() {
    if (!activeDaemonId || !cwd.trim() || !projectName.trim()) {
      return;
    }
    setCreatingProject(true);
    try {
      const project = await api<ProjectSummary>(`/api/daemons/${activeDaemonId}/projects`, {
        method: "POST",
        body: JSON.stringify({
          name: projectName.trim(),
          rootDir: cwd.trim(),
          goal: projectGoal.trim(),
          runPolicy: { mode: "until_blocked" },
        }),
      });
      setProjects((current) => upsertProjectSummary(current, project));
      setActiveProjectId(project.id);
      setNewProjectOpen(false);
    } finally {
      setCreatingProject(false);
    }
  }

  function handleSelectSession(sessionId: string) {
    setActiveSessionId(sessionId);
  }

  async function handleOpenDirectoryPicker() {
    if (!activeDaemonId) {
      return;
    }
    setDirectoryPickerOpen(true);
    await loadDirectories(activeDaemonId, cwd);
  }

  async function handleBrowseDirectory(pathValue?: string) {
    if (!activeDaemonId) {
      return;
    }
    await loadDirectories(activeDaemonId, pathValue ?? directoryBrowserPath);
  }

  async function sendMessageText(text: string) {
    if (!activeDaemonId || !activeSessionId || !text.trim()) {
      return;
    }
    const trimmed = text.trim();
    const optimisticAssistant = trimmed !== "/compact";
    const since = Date.now();
    if (optimisticAssistant) {
      setSendingMessage(true);
      setPendingAssistant({
        sessionId: activeSessionId,
        since,
        baseTranscriptCount: transcript.length,
        userEntry: {
          id: `pending-user-${since}`,
          kind: "user",
          text: trimmed,
          createdAt: new Date(since).toISOString(),
        },
        entry: {
          id: `pending-assistant-${since}`,
          kind: "assistant",
          text: "",
          createdAt: new Date(since).toISOString(),
          status: "streaming",
        },
      });
    } else {
      setSendingMessage(true);
      setPendingAssistant(null);
    }
    prepareForOutgoingMessage();
    if (trimmed === composer.trim()) {
      setComposer("");
    }
    try {
      await api(`/api/daemons/${activeDaemonId}/sessions/${activeSessionId}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: trimmed }),
      });
      if (!optimisticAssistant) {
        setSendingMessage(false);
      }
    } catch (error) {
      if (optimisticAssistant) {
        setPendingAssistant(null);
      }
      setSendingMessage(false);
      setComposer(trimmed);
      throw error;
    }
  }

  async function handleSendMessage() {
    if (!composer.trim()) {
      return;
    }
    await sendMessageText(composer);
  }

  async function handleRunProject() {
    if (!activeDaemonId || !activeProjectId) {
      return;
    }
    const project = await api<ProjectSummary>(
      `/api/daemons/${activeDaemonId}/projects/${activeProjectId}/run`,
      { method: "POST" },
    );
    setProjects((current) => upsertProjectSummary(current, project));
  }

  async function handlePauseProject() {
    if (!activeDaemonId || !activeProjectId) {
      return;
    }
    const project = await api<ProjectSummary>(
      `/api/daemons/${activeDaemonId}/projects/${activeProjectId}/pause`,
      { method: "POST" },
    );
    setProjects((current) => upsertProjectSummary(current, project));
  }

  async function handleSendAgentMessage(text: string) {
    if (!activeDaemonId || !activeProjectId || !activeAgentId || !text.trim()) {
      return;
    }
    const agent = await api<AgentDetails>(
      `/api/daemons/${activeDaemonId}/projects/${activeProjectId}/agents/${activeAgentId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ text: text.trim() }),
      },
    );
    setActiveAgent(agent);
    setAgents((current) => upsertAgentSummary(current, agent));
  }

  async function handleSaveSettings(nextSettings: GlobalSettings) {
    if (!activeDaemonId) {
      return;
    }
    const providerSettings = await api<GlobalSettings>(
      `/api/daemons/${activeDaemonId}/settings/provider`,
      {
        method: "PATCH",
        body: JSON.stringify(nextSettings.provider),
      },
    );
    const finalSettings = await api<GlobalSettings>(
      `/api/daemons/${activeDaemonId}/settings/notifications`,
      {
        method: "PATCH",
        body: JSON.stringify(nextSettings.notifications),
      },
    );
    setSettings(finalSettings ?? providerSettings);
    setSettingsOpen(false);
  }

  async function handleSessionConfigChange(next: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  }) {
    if (!activeDaemonId || !activeSessionId) {
      return;
    }
    const session = normalizeSessionDetails(
      await api<SessionDetails>(
        `/api/daemons/${activeDaemonId}/sessions/${activeSessionId}/config`,
        {
          method: "PATCH",
          body: JSON.stringify(next),
        },
      ),
    );
    setActiveSession((current) => mergeSessionDetails(current, session));
    setSessions((current) => upsertSessionSummary(current, session));
  }

  async function handleInterrupt() {
    if (!activeDaemonId || !activeSessionId) {
      return;
    }
    await api(`/api/daemons/${activeDaemonId}/sessions/${activeSessionId}/interrupt`, {
      method: "POST",
    });
  }

  async function handleDeleteSession(sessionId: string) {
    if (!activeDaemonId) {
      return;
    }
    await api(`/api/daemons/${activeDaemonId}/sessions/${sessionId}`, {
      method: "DELETE",
    });
  }

  async function handleRenameSession() {
    if (!activeDaemonId || !activeSessionId || !renameTitle.trim()) {
      return;
    }
    setRenamingSession(true);
    try {
      const session = normalizeSessionDetails(
        await api<SessionDetails>(
          `/api/daemons/${activeDaemonId}/sessions/${activeSessionId}/title`,
          {
            method: "PATCH",
            body: JSON.stringify({ title: renameTitle.trim() }),
          },
        ),
      );
      setActiveSession((current) => mergeSessionDetails(current, session));
      setSessions((current) => upsertSessionSummary(current, session));
      setRenameSessionOpen(false);
    } finally {
      setRenamingSession(false);
    }
  }

  async function handleApprovalAction(entry: TranscriptEntry, decision: "approve" | "deny") {
    if (!activeDaemonId || !activeSessionId) {
      return;
    }
    const approvalRequestId =
      typeof entry.meta?.requestId === "string" ? entry.meta.requestId : "";
    if (!approvalRequestId) {
      return;
    }

    setApprovalActionId(entry.id);
    try {
      const session = normalizeSessionDetails(
        await api<SessionDetails>(
          `/api/daemons/${activeDaemonId}/sessions/${activeSessionId}/approvals/${encodeURIComponent(approvalRequestId)}`,
          {
            method: "POST",
            body: JSON.stringify({ decision }),
          },
        ),
      );
      setActiveSession((current) => mergeSessionDetails(current, session));
      setSessions((current) => upsertSessionSummary(current, session));
    } finally {
      setApprovalActionId(null);
    }
  }

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
        <AppHeader
          viewMode={viewMode}
          onToggleViewMode={() => setViewMode((current) => (current === "chat" ? "overview" : "chat"))}
          activeDaemonId={activeDaemonId}
          setActiveDaemonId={setActiveDaemonId}
          daemons={daemons}
          projects={projects}
          activeProjectId={activeProjectId}
          setActiveProjectId={setActiveProjectId}
          setActiveAgentId={setActiveAgentId}
          connectionState={connectionState}
          newProjectOpen={newProjectOpen}
          setNewProjectOpen={setNewProjectOpen}
          projectName={projectName}
          setProjectName={setProjectName}
          projectGoal={projectGoal}
          setProjectGoal={setProjectGoal}
          cwd={cwd}
          setCwd={setCwd}
          activeDaemonAvailable={Boolean(activeDaemonId)}
          creatingProject={creatingProject}
          onCreateProject={() => void handleCreateProject()}
          onOpenDirectoryPicker={() => void handleOpenDirectoryPicker()}
          historyOpen={historyOpen}
          setHistoryOpen={(open) => {
            void setHistoryOpen(open);
          }}
          historySearch={historySearch}
          setHistorySearch={setHistorySearch}
          historyLoading={historyLoading}
          groupedHistory={groupedHistory}
          restoringHistoryId={restoringHistoryId}
          onRestoreSession={(item) => void restoreSession(item)}
          newSessionOpen={newSessionOpen}
          setNewSessionOpen={setNewSessionOpen}
          activeProjectAvailable={Boolean(activeProjectId)}
          creatingSession={creatingSession}
          onCreateSession={() => void handleCreateSession()}
          settingsOpen={settingsOpen}
          setSettingsOpen={setSettingsOpen}
          settings={settings}
          onSaveSettings={(value) => void handleSaveSettings(value)}
          directoryPickerOpen={directoryPickerOpen}
          setDirectoryPickerOpen={setDirectoryPickerOpen}
          directoryBrowserPath={directoryBrowserPath}
          setDirectoryBrowserPath={setDirectoryBrowserPath}
          directoryBrowser={directoryBrowser}
          directoryBrowserLoading={directoryBrowserLoading}
          onBrowseDirectory={(pathValue) => void handleBrowseDirectory(pathValue)}
          theme={theme}
          setTheme={setTheme}
        />

        {viewMode === "overview" ? (
          <OverviewPane
            activeDaemon={activeDaemon}
            activeProject={activeProject}
            overviewSessions={overviewSessions}
            activeSession={activeSession}
            activeSessionId={activeSessionId}
            currentOverviewLayout={currentOverviewLayout}
            overviewScrollRef={overviewScrollRef}
            canvasStyle={canvasStyle}
            onOpenSession={(sessionId) => {
              handleSelectSession(sessionId);
              setViewMode("chat");
            }}
            onDragSessionStart={(sessionId, event) => {
              startSessionDrag(sessionId, event.clientX, event.clientY);
            }}
          />
        ) : (
          <div
            className={[
              "ui-layout-motion relative grid min-h-0 grid-cols-1",
              sessionsCollapsed ? "md:grid-cols-[52px_minmax(0,1fr)]" : "md:grid-cols-[272px_minmax(0,1fr)]",
            ].join(" ")}
          >
            {!sessionsCollapsed ? (
              <button
                type="button"
                aria-label="Close sessions"
                className="absolute inset-0 z-20 bg-background/50 backdrop-blur-[1px] md:hidden"
                onClick={() => setSessionsCollapsed(true)}
              />
            ) : null}
            <AppSidebar
              collapsed={sessionsCollapsed}
              sidebarMode={sidebarMode}
              visibleSessions={visibleSessions}
              visibleAgents={visibleAgents}
              activeSessionId={activeSessionId}
              activeAgentId={activeAgentId}
              onToggleCollapsed={() => setSessionsCollapsed((current) => !current)}
              onSetSidebarMode={setSidebarMode}
              onSelectSession={handleSelectSession}
              onDeleteSession={(sessionId) => {
                void handleDeleteSession(sessionId);
              }}
              onSelectAgent={(agentId) => {
                setActiveAgentId(agentId);
                setActiveSessionId(null);
              }}
            />

            <AppMainPane
              sessionsCollapsed={sessionsCollapsed}
              onExpandSessions={() => setSessionsCollapsed(false)}
              sidebarMode={sidebarMode}
              sessionPane={sessionPane}
              setSessionPane={setSessionPane}
              activeSessionId={activeSessionId}
              activeSession={activeSession}
              activeProject={activeProject}
              activeAgent={activeAgent}
              activeDaemonId={activeDaemonId}
              activeProjectId={activeProjectId}
              onOpenFilesPane={() => void openFilesPane()}
              onPauseProject={() => void handlePauseProject()}
              onRunProject={() => void handleRunProject()}
              renameSessionOpen={renameSessionOpen}
              setRenameSessionOpen={setRenameSessionOpen}
              renameTitle={renameTitle}
              setRenameTitle={setRenameTitle}
              renamingSession={renamingSession}
              onRenameSession={() => void handleRenameSession()}
              notifications={projectNotifications.filter((item) => item.projectId === activeProjectId)}
              onSendAgentMessage={(text) => void handleSendAgentMessage(text)}
              projectFiles={projectFiles}
              projectFilesLoading={projectFilesLoading}
              selectedFile={selectedFile}
              selectedFileLoading={selectedFileLoading}
              fileEditorValue={fileEditorValue}
              savingFile={savingFile}
              theme={theme}
              onBrowseProjectPath={(value) => void browseProjectPath(value)}
              onOpenProjectFile={(filePath) => void openProjectFile(filePath)}
              onQuoteFileSelection={quoteFileSelection}
              onSaveProjectFile={() => void saveProjectFile()}
              onFileEditorValueChange={setFileEditorValue}
              onFileSelectionChange={setFileSelectionText}
              transcriptRef={transcriptRef}
              onTranscriptScroll={handleTranscriptScroll}
              sessionLoading={sessionLoading}
              hasOlderTranscript={hasOlderTranscript}
              loadingOlderTranscript={loadingOlderTranscript}
              visibleTranscript={visibleTranscript}
              virtualItems={virtualItems}
              measureRow={measureRow}
              totalSize={totalSize}
              approvalActionId={approvalActionId}
              expanded={expanded}
              onToggleExpanded={(entryId) =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(entryId)) {
                    next.delete(entryId);
                  } else {
                    next.add(entryId);
                  }
                  return next;
                })
              }
              onApprovalAction={(entry, decision) => void handleApprovalAction(entry, decision)}
              showScrollToBottom={showScrollToBottom}
              chatRowCount={chatRowCount}
              onScrollTranscriptToBottom={scrollTranscriptToBottom}
              composer={composer}
              setComposer={setComposer}
              onSendMessage={() => void handleSendMessage()}
              sendingMessage={sendingMessage}
              cwd={cwd}
              sandbox={sandbox}
              setSandbox={setSandbox}
              approvalPolicy={approvalPolicy}
              setApprovalPolicy={setApprovalPolicy}
              model={model}
              setModel={setModel}
              effort={effort}
              setEffort={setEffort}
              currentModel={currentModel}
              config={config}
              onSessionConfigChange={(next) => void handleSessionConfigChange(next)}
              onInterrupt={() => void handleInterrupt()}
              formatEffortLabel={formatEffortLabel}
              defaultApprovalPolicyForSandbox={defaultApprovalPolicyForSandbox}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function formatEffortLabel(value: string) {
  switch (value) {
    case "none":
      return "None";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "XHigh";
    default:
      return value;
  }
}

function upsertSessionSummary(current: SessionSummary[], session: SessionSummary) {
  const normalizedSession = normalizeSessionSummary(session);
  const index = current.findIndex((item) => item.id === normalizedSession.id);
  if (index === -1) {
    return insertSessionSummarySorted(current, normalizedSession);
  }
  const merged = normalizeSessionSummary({ ...current[index], ...normalizedSession });
  const remaining = current.filter((item) => item.id !== normalizedSession.id);
  return insertSessionSummarySorted(remaining, merged);
}

function normalizeSessionSummary(session: SessionSummary): SessionSummary {
  return {
    ...session,
    previewEntries: Array.isArray(session.previewEntries) ? session.previewEntries : [],
  };
}

function normalizeSessionDetails(session: SessionDetails): SessionDetails {
  return {
    ...normalizeSessionSummary(session),
    transcript: Array.isArray(session.transcript) ? session.transcript : [],
    hasMoreTranscriptBefore: Boolean(session.hasMoreTranscriptBefore),
  };
}

function upsertProjectSummary(current: ProjectSummary[], project: ProjectSummary): ProjectSummary[] {
  const index = current.findIndex((item) => item.id === project.id);
  if (index === -1) {
    return [...current, project].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const next = [...current];
  next[index] = { ...next[index], ...project };
  return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function upsertAgentSummary(current: AgentSummary[], agent: AgentSummary): AgentSummary[] {
  const index = current.findIndex((item) => item.id === agent.id);
  if (index === -1) {
    return [...current, agent];
  }
  const next = [...current];
  next[index] = { ...next[index], ...agent };
  return next;
}

function mergeAgentSummaries(
  current: AgentSummary[],
  incoming: AgentSummary[],
  projectId: string,
): AgentSummary[] {
  const retained = current.filter((item) => item.projectId !== projectId);
  return [...retained, ...incoming];
}

function upsertProjectNotification(
  current: ProjectNotification[],
  notification: ProjectNotification,
): ProjectNotification[] {
  const index = current.findIndex((item) => item.id === notification.id);
  if (index === -1) {
    return [notification, ...current];
  }
  const next = [...current];
  next[index] = { ...next[index], ...notification };
  return next;
}

function insertSessionSummarySorted(current: SessionSummary[], session: SessionSummary) {
  const next = [...current];
  const targetIndex = next.findIndex((item) => item.updatedAt.localeCompare(session.updatedAt) < 0);
  if (targetIndex === -1) {
    next.push(session);
    return next;
  }
  next.splice(targetIndex, 0, session);
  return next;
}

function appendTranscriptEntry(details: SessionDetails, entry: TranscriptEntry): SessionDetails {
  if (details.transcript.some((item) => item.id === entry.id)) {
    return updateTranscriptEntry(details, entry);
  }
  const transcript = [...details.transcript, entry];
  return {
    ...details,
    transcript,
    transcriptCount: Math.max(details.transcriptCount, details.transcript.length) + 1,
  };
}

function updateTranscriptEntry(details: SessionDetails, entry: TranscriptEntry): SessionDetails {
  const index = details.transcript.findIndex((item) => item.id === entry.id);
  if (index === -1) {
    return appendTranscriptEntry(details, entry);
  }
  const transcript = [...details.transcript];
  transcript[index] = {
    ...transcript[index],
    ...entry,
  };
  return {
    ...details,
    transcript,
    transcriptCount: details.transcriptCount,
  };
}

function prependTranscriptPage(
  details: SessionDetails | null,
  page: SessionTranscriptPage,
): SessionDetails | null {
  if (!details || details.id !== page.sessionId) {
    return details;
  }

  if (!page.transcript.length) {
    return {
      ...details,
      hasMoreTranscriptBefore: page.hasMoreTranscriptBefore,
    };
  }

  const incomingById = new Map(page.transcript.map((entry) => [entry.id, entry]));
  const nextLoadedTranscript = details.transcript.map((entry) => {
    const incoming = incomingById.get(entry.id);
    return incoming ? { ...entry, ...incoming } : entry;
  });
  const existingIds = new Set(nextLoadedTranscript.map((entry) => entry.id));
  const olderEntries = page.transcript.filter((entry) => !existingIds.has(entry.id));
  if (!olderEntries.length) {
    return {
      ...details,
      transcript: nextLoadedTranscript,
      hasMoreTranscriptBefore: page.hasMoreTranscriptBefore,
    };
  }

  const transcript = [...olderEntries, ...nextLoadedTranscript];
  return {
    ...details,
    transcript,
    hasMoreTranscriptBefore: page.hasMoreTranscriptBefore,
  };
}

function mergeSessionDetails(current: SessionDetails | null, incoming: SessionDetails): SessionDetails {
  if (!current || current.id !== incoming.id) {
    return incoming;
  }

  const incomingById = new Map(incoming.transcript.map((entry) => [entry.id, entry]));
  const transcript = current.transcript.map((entry) => {
    const nextEntry = incomingById.get(entry.id);
    return nextEntry ? { ...entry, ...nextEntry } : entry;
  });
  const existingIds = new Set(transcript.map((entry) => entry.id));
  for (const entry of incoming.transcript) {
    if (!existingIds.has(entry.id)) {
      transcript.push(entry);
    }
  }
  const hasMoreTranscriptBefore =
    transcript.length >= incoming.transcriptCount ? false : current.hasMoreTranscriptBefore;

  return {
    ...current,
    ...incoming,
    transcript,
    hasMoreTranscriptBefore,
  };
}

function applyQueuedActiveSessionEvents(
  details: SessionDetails | null,
  events: DaemonEvent[],
): SessionDetails | null {
  if (!details || !events.length) {
    return details;
  }

  let transcript = details.transcript.slice();
  let transcriptCount = details.transcriptCount;
  let hasMoreTranscriptBefore = details.hasMoreTranscriptBefore;
  let dirty = false;
  let indexById = new Map(transcript.map((entry, index) => [entry.id, index]));

  const upsertEntry = (entry: TranscriptEntry) => {
    const index = indexById.get(entry.id);
    if (typeof index === "number") {
      transcript[index] = {
        ...transcript[index],
        ...entry,
      };
      dirty = true;
      return;
    }

    transcript.push(entry);
    indexById.set(entry.id, transcript.length - 1);
    transcriptCount += 1;
    dirty = true;
  };

  for (const event of events) {
    if (!("sessionId" in event) || event.sessionId !== details.id) {
      continue;
    }

    switch (event.type) {
      case "session-entry":
        upsertEntry(event.entry);
        break;
      case "session-entry-updated":
        upsertEntry(event.entry);
        break;
      case "session-entries-updated":
        event.entries.forEach(upsertEntry);
        if (event.removedEntryIds?.length) {
          const removedIds = new Set(event.removedEntryIds);
          const nextTranscript = transcript.filter((entry) => !removedIds.has(entry.id));
          if (nextTranscript.length !== transcript.length) {
            transcriptCount = Math.max(0, transcriptCount - (transcript.length - nextTranscript.length));
            transcript = nextTranscript;
            indexById = new Map(transcript.map((entry, index) => [entry.id, index]));
            dirty = true;
          }
        }
        break;
      case "session-reset":
        transcript = event.transcript.slice();
        transcriptCount = event.hasMoreTranscriptBefore
          ? Math.max(transcriptCount, event.transcript.length)
          : event.transcript.length;
        hasMoreTranscriptBefore = event.hasMoreTranscriptBefore;
        indexById = new Map(transcript.map((entry, index) => [entry.id, index]));
        dirty = true;
        break;
      default:
        break;
    }
  }

  if (!dirty) {
    return details;
  }

  return {
    ...details,
    transcript,
    transcriptCount,
    hasMoreTranscriptBefore,
  };
}

function upsertDaemon(current: DaemonDescriptor[], daemon: DaemonDescriptor) {
  const index = current.findIndex((item) => item.id === daemon.id);
  if (index === -1) {
    return [daemon, ...current];
  }
  const next = [...current];
  next[index] = daemon;
  return next;
}

function defaultApprovalPolicyForSandbox(
  sandbox: "read-only" | "workspace-write" | "danger-full-access",
) {
  return sandbox === "danger-full-access" ? "never" : "on-request";
}

export default App;
