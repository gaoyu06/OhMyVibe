import { type UIEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Circle,
  Edit3,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  GitCommitHorizontal,
  History,
  LayoutGrid,
  LoaderCircle,
  MessageSquareText,
  Moon,
  PanelLeftOpen,
  Play,
  Plus,
  Save,
  Send,
  Server,
  Square,
  Sun,
  Trash2,
  Unplug,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  CodexHistoryEntry,
  DaemonConfig,
  DaemonDescriptor,
  DaemonEvent,
  DirectoryBrowseResult,
  ProjectFileBrowseResult,
  ProjectFileReadResult,
  SessionDetails,
  SessionSummary,
  TranscriptEntry,
} from "@/lib/types";
import { formatDateTime, formatDurationMs, formatTime, lastLines } from "@/lib/utils";

const DEFAULT_CONTROL_URL = import.meta.env.VITE_CONTROL_SERVER_URL || window.location.origin;
const WORKSPACE_STORAGE_KEY = "ohmyvibe-workspaces";
const TOOL_LINE_LIMIT = 30;
const TRANSCRIPT_INITIAL_COUNT = 80;
const TRANSCRIPT_CHUNK_SIZE = 60;

type ThemeMode = "light" | "dark";

interface ActivityState {
  label: string;
  variant: "default" | "outline" | "warning" | "destructive" | "success";
}

interface PendingAssistantState {
  sessionId: string;
  since: number;
  baseTranscriptCount: number;
  userEntry: TranscriptEntry;
  entry: TranscriptEntry;
}

interface ChatTranscriptRow {
  id: string;
  entry: TranscriptEntry;
  reasoning?: TranscriptEntry;
}

interface WorkspaceDefinition {
  id: string;
  sessionKeys: string[];
  activeSessionKey: string | null;
}

interface WorkspaceStore {
  activeWorkspaceId: string;
  workspaces: WorkspaceDefinition[];
}

type SessionPane = "chat" | "files";

const SANDBOX_OPTIONS = [
  { value: "danger-full-access", label: "Full Access" },
  { value: "workspace-write", label: "Workspace" },
  { value: "read-only", label: "Read Only" },
] as const;

function App() {
  const [viewMode, setViewMode] = useState<"chat" | "overview">("chat");
  const [theme, setTheme] = useState<ThemeMode>(
    () => (localStorage.getItem("ohmyvibe-theme") as ThemeMode) || "dark",
  );
  const controlUrl = DEFAULT_CONTROL_URL;
  const [connectionState, setConnectionState] = useState<"connecting" | "open" | "closed" | "error">(
    "connecting",
  );
  const [daemons, setDaemons] = useState<DaemonDescriptor[]>([]);
  const [activeDaemonId, setActiveDaemonId] = useState<string | null>(null);
  const [config, setConfig] = useState<DaemonConfig>({ models: [] });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [history, setHistory] = useState<CodexHistoryEntry[]>([]);
  const [historySearch, setHistorySearch] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [sessionPane, setSessionPane] = useState<SessionPane>("chat");
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [workspaceState, setWorkspaceState] = useState<WorkspaceStore>(() => loadWorkspaceState());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionDetails | null>(null);
  const [sessionDetailsById, setSessionDetailsById] = useState<Record<string, SessionDetails>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [restoringHistoryId, setRestoringHistoryId] = useState<string | null>(null);
  const [renameSessionOpen, setRenameSessionOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [renamingSession, setRenamingSession] = useState(false);
  const [approvalActionId, setApprovalActionId] = useState<string | null>(null);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [pendingAssistant, setPendingAssistant] = useState<PendingAssistantState | null>(null);
  const [loadedTranscriptCount, setLoadedTranscriptCount] = useState(TRANSCRIPT_INITIAL_COUNT);
  const [composer, setComposer] = useState("");
  const [cwd, setCwd] = useState("C:\\Code\\Projects\\OhMyVibe");
  const [directoryBrowser, setDirectoryBrowser] = useState<DirectoryBrowseResult | null>(null);
  const [directoryBrowserLoading, setDirectoryBrowserLoading] = useState(false);
  const [directoryBrowserPath, setDirectoryBrowserPath] = useState("");
  const [projectFiles, setProjectFiles] = useState<ProjectFileBrowseResult | null>(null);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<ProjectFileReadResult | null>(null);
  const [selectedFileLoading, setSelectedFileLoading] = useState(false);
  const [fileEditorValue, setFileEditorValue] = useState("");
  const [savingFile, setSavingFile] = useState(false);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("medium");
  const [sandbox, setSandbox] = useState<"read-only" | "workspace-write" | "danger-full-access">(
    "danger-full-access",
  );
  const [approvalPolicy, setApprovalPolicy] = useState<
    "untrusted" | "on-failure" | "on-request" | "never"
  >("never");
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const prependPendingRef = useRef<{ previousHeight: number; previousTop: number } | null>(null);
  const stickToBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("ohmyvibe-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspaceState));
  }, [workspaceState]);

  useEffect(() => {
    let disposed = false;
    const ws = new WebSocket(toWsUrl(controlUrl));
    setConnectionState("connecting");

    ws.onopen = () => {
      if (!disposed) {
        setConnectionState("open");
      }
    };
    ws.onerror = () => {
      if (!disposed) {
        setConnectionState("error");
      }
    };
    ws.onclose = () => {
      if (!disposed) {
        setConnectionState("closed");
      }
    };
    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data) as
        | { type: "hello"; daemons: DaemonDescriptor[] }
        | { type: "hello"; sessions: SessionSummary[] }
        | { type: "daemon-connected"; daemon: DaemonDescriptor }
        | { type: "daemon-disconnected"; daemonId: string }
        | { type: "daemon-event"; daemonId: string; event: DaemonEvent };

      if (payload.type === "hello") {
        const nextDaemons = Array.isArray((payload as { daemons?: DaemonDescriptor[] }).daemons)
          ? (payload as { daemons: DaemonDescriptor[] }).daemons
          : [];
        setDaemons(nextDaemons);
        setActiveDaemonId((current) => current ?? nextDaemons[0]?.id ?? null);
        return;
      }

      if (payload.type === "daemon-connected") {
        setDaemons((current) => upsertDaemon(current, payload.daemon));
        setActiveDaemonId((current) => current ?? payload.daemon.id);
        return;
      }

      if (payload.type === "daemon-disconnected") {
        setDaemons((current) =>
          current.map((daemon) =>
            daemon.id === payload.daemonId
              ? { ...daemon, online: false, lastSeenAt: new Date().toISOString() }
              : daemon,
          ),
        );
        return;
      }

      if (payload.type === "daemon-event" && payload.daemonId === activeDaemonId) {
        const event = payload.event;
        if (event.type === "session-created" || event.type === "session-updated") {
          setSessions((current) => upsertSessionSummary(current, event.session));
          setSessionDetailsById((current) => {
            const existing = current[event.session.id];
            if (!existing) {
              return current;
            }
            return {
              ...current,
              [event.session.id]: { ...existing, ...event.session },
            };
          });
          setActiveSession((current) =>
            current && current.id === event.session.id ? { ...current, ...event.session } : current,
          );
          return;
        }
        if (event.type === "session-deleted") {
          setSessions((current) => current.filter((session) => session.id !== event.sessionId));
          setSessionDetailsById((current) => {
            const next = { ...current };
            delete next[event.sessionId];
            return next;
          });
          setActiveSession((current) => (current?.id === event.sessionId ? null : current));
          setActiveSessionId((current) => (current === event.sessionId ? null : current));
          return;
        }
        if (event.type === "session-entry") {
          setSessionDetailsById((current) => {
            const existing = current[event.sessionId];
            if (!existing) {
              return current;
            }
            const nextTranscript = [...existing.transcript, event.entry];
            return {
              ...current,
              [event.sessionId]: {
                ...existing,
                transcript: nextTranscript,
                transcriptCount: nextTranscript.length,
              },
            };
          });
          setActiveSession((current) => {
            if (!current || current.id !== event.sessionId) {
              return current;
            }
            const nextTranscript = [...current.transcript, event.entry];
            return { ...current, transcript: nextTranscript, transcriptCount: nextTranscript.length };
          });
          return;
        }
        if (event.type === "session-reset") {
          setSessionDetailsById((current) => {
            const existing = current[event.sessionId];
            if (!existing) {
              return current;
            }
            return {
              ...current,
              [event.sessionId]: {
                ...existing,
                transcript: event.transcript,
                transcriptCount: event.transcript.length,
              },
            };
          });
          setActiveSession((current) =>
            current && current.id === event.sessionId
              ? { ...current, transcript: event.transcript, transcriptCount: event.transcript.length }
              : current,
          );
        }
      }
    };

    return () => {
      disposed = true;
      ws.close();
    };
  }, [activeDaemonId, controlUrl]);

  useEffect(() => {
    if (!activeDaemonId) {
      setConfig({ models: [] });
      setSessions([]);
      setActiveSession(null);
      setActiveSessionId(null);
      setSessionDetailsById({});
      return;
    }
    void loadConfig(activeDaemonId);
    void loadSessions(activeDaemonId);
  }, [activeDaemonId]);

  useEffect(() => {
    if (!activeDaemonId || !activeSessionId) {
      return;
    }
    void loadSession(activeDaemonId, activeSessionId);
  }, [activeDaemonId, activeSessionId]);

  useEffect(() => {
    setLoadedTranscriptCount(TRANSCRIPT_INITIAL_COUNT);
    prependPendingRef.current = null;
    setPendingAssistant(null);
    setSendingMessage(false);
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
  }, [activeSessionId]);

  useEffect(() => {
    setProjectFiles(null);
    setSelectedFile(null);
    setFileEditorValue("");
    setSessionPane("chat");
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

  const transcript = activeSession?.transcript ?? [];
  const displayTranscript = useMemo(() => {
    if (!pendingAssistant || pendingAssistant.sessionId !== activeSessionId) {
      return transcript;
    }
    const serverEntries = transcript.slice(pendingAssistant.baseTranscriptCount);
    const hasServerUser = serverEntries.some(
      (entry) =>
        entry.kind === "user" &&
        entry.text.trim() === pendingAssistant.userEntry.text.trim(),
    );
    const hasServerResponse = serverEntries.some((entry) => entry.kind !== "user");
    return [
      ...transcript,
      ...(hasServerUser ? [] : [pendingAssistant.userEntry]),
      ...(hasServerResponse ? [] : [pendingAssistant.entry]),
    ];
  }, [activeSessionId, pendingAssistant, transcript]);
  const chatTranscript = useMemo(() => buildChatTranscriptRows(displayTranscript), [displayTranscript]);
  const transcriptStart = Math.max(0, chatTranscript.length - loadedTranscriptCount);
  const visibleTranscript = useMemo(
    () => chatTranscript.slice(transcriptStart),
    [chatTranscript, transcriptStart],
  );
  const hasOlderTranscript = transcriptStart > 0;
  const rowVirtualizer = useVirtualizer({
    count: visibleTranscript.length,
    getScrollElement: () => transcriptRef.current,
    estimateSize: (index) => estimateEntryHeight(visibleTranscript[index]),
    overscan: 8,
    measureElement: (element) => element.getBoundingClientRect().height,
  });
  const activity = getActivity(activeSession, {
    creatingSession,
    restoringHistory: Boolean(restoringHistoryId),
    sessionLoading,
    sendingMessage,
  });
  const activeDaemon = daemons.find((item) => item.id === activeDaemonId) ?? null;
  const activeWorkspace =
    workspaceState.workspaces.find((workspace) => workspace.id === workspaceState.activeWorkspaceId) ??
    workspaceState.workspaces[0];
  const visibleSessions = useMemo(() => {
    if (!activeDaemonId || !activeWorkspace) {
      return [] as SessionSummary[];
    }
    const sessionKeys = new Set(activeWorkspace.sessionKeys);
    return sessions.filter((session) => sessionKeys.has(makeSessionKey(activeDaemonId, session.id)));
  }, [activeDaemonId, activeWorkspace, sessions]);
  const overviewSessions = useMemo(
    () =>
      [...visibleSessions]
        .filter((session) => session.status !== "closed")
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [visibleSessions],
  );
  const filteredHistory = useMemo(() => {
    const query = historySearch.trim().toLowerCase();
    const sorted = [...history].sort(
      (a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""),
    );
    if (!query) {
      return sorted;
    }
    return sorted.filter((item) =>
      [item.title, item.cwd, item.id, item.source, item.status]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }, [history, historySearch]);
  const groupedHistory = useMemo(() => groupHistoryByDay(filteredHistory), [filteredHistory]);
  const lastEntrySignature = useMemo(() => {
    const lastEntry = displayTranscript[displayTranscript.length - 1];
    if (!lastEntry) {
      return "";
    }
    const lastRow = chatTranscript[chatTranscript.length - 1];
    return `${lastEntry.id}:${lastEntry.text.length}:${lastEntry.status ?? ""}:${lastRow?.reasoning?.text.length ?? 0}`;
  }, [chatTranscript, displayTranscript]);

  useEffect(() => {
    if (!activeDaemonId || viewMode !== "overview" || !overviewSessions.length) {
      return;
    }
    void loadOverviewSessions(
      activeDaemonId,
      overviewSessions.map((session) => session.id),
    );
  }, [activeDaemonId, overviewSessions, viewMode]);

  useEffect(() => {
    if (!activeDaemonId) {
      return;
    }
    const sessionIds = sessions.map((session) => session.id);
    setWorkspaceState((current) =>
      syncWorkspaceStoreWithSessions(current, activeDaemonId, sessionIds),
    );
  }, [activeDaemonId, sessions]);

  useEffect(() => {
    if (!activeDaemonId || !activeWorkspace) {
      setActiveSessionId(null);
      setActiveSession(null);
      return;
    }
    const preferredSessionId = parseSessionId(activeWorkspace.activeSessionKey, activeDaemonId);
    const nextSessionId =
      (preferredSessionId && visibleSessions.some((session) => session.id === preferredSessionId)
        ? preferredSessionId
        : null) ??
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
  }, [activeDaemonId, activeSessionId, activeWorkspace, visibleSessions]);

  useLayoutEffect(() => {
    const scrollElement = transcriptRef.current;
    const pending = prependPendingRef.current;
    if (!scrollElement || !pending) {
      return;
    }
    const delta = scrollElement.scrollHeight - pending.previousHeight;
    scrollElement.scrollTop = pending.previousTop + delta;
    prependPendingRef.current = null;
  }, [visibleTranscript.length]);

  useLayoutEffect(() => {
    const scrollElement = transcriptRef.current;
    if (!scrollElement || prependPendingRef.current || !stickToBottomRef.current) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      scrollElement.scrollTop = scrollElement.scrollHeight;
      setShowScrollToBottom(false);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [lastEntrySignature, visibleTranscript.length]);

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

  async function api<T>(path: string, options?: RequestInit) {
    const response = await fetch(new URL(path, normalizeBaseUrl(controlUrl)).toString(), {
      headers: { "Content-Type": "application/json" },
      ...options,
    });

    if (response.status === 204) {
      return null as T;
    }

    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error || "request_failed");
    }
    return payload;
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
    setSessions(nextSessions);
  }

  async function loadSession(daemonId: string, sessionId: string) {
    setSessionLoading(true);
    try {
      const session = await api<SessionDetails>(`/api/daemons/${daemonId}/sessions/${sessionId}`);
      setActiveSession(session);
      setSessionDetailsById((current) => ({
        ...current,
        [session.id]: session,
      }));
    } finally {
      setSessionLoading(false);
    }
  }

  async function loadOverviewSessions(daemonId: string, sessionIds: string[]) {
    const missingIds = sessionIds.filter((sessionId) => !sessionDetailsById[sessionId]);
    if (!missingIds.length) {
      return;
    }
    const details = await Promise.all(
      missingIds.map((sessionId) =>
        api<SessionDetails>(`/api/daemons/${daemonId}/sessions/${sessionId}`),
      ),
    );
    setSessionDetailsById((current) => {
      const next = { ...current };
      for (const detail of details) {
        next[detail.id] = detail;
      }
      return next;
    });
  }

  async function loadHistory(daemonId: string) {
    setHistoryLoading(true);
    try {
      const items = await api<CodexHistoryEntry[]>(`/api/daemons/${daemonId}/history`);
      setHistory(items);
    } finally {
      setHistoryLoading(false);
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

  async function loadProjectFiles(daemonId: string, sessionId: string, nextPath?: string) {
    setProjectFilesLoading(true);
    try {
      const query = nextPath ? `?path=${encodeURIComponent(nextPath)}` : "";
      const result = await api<ProjectFileBrowseResult>(
        `/api/daemons/${daemonId}/sessions/${sessionId}/files${query}`,
      );
      setProjectFiles(result);
      return result;
    } finally {
      setProjectFilesLoading(false);
    }
  }

  async function loadProjectFile(daemonId: string, sessionId: string, filePath: string) {
    setSelectedFileLoading(true);
    try {
      const result = await api<ProjectFileReadResult>(
        `/api/daemons/${daemonId}/sessions/${sessionId}/file?path=${encodeURIComponent(filePath)}`,
      );
      setSelectedFile(result);
      setFileEditorValue(result.kind === "text" ? result.content : "");
      return result;
    } finally {
      setSelectedFileLoading(false);
    }
  }

  async function handleCreateSession() {
    if (!activeDaemonId) {
      return;
    }
    setCreatingSession(true);
    try {
      const session = await api<SessionDetails>(`/api/daemons/${activeDaemonId}/sessions`, {
        method: "POST",
        body: JSON.stringify({
          cwd,
          model,
          reasoningEffort: effort,
          sandbox,
          approvalPolicy,
        }),
      });
      setActiveSessionId(session.id);
      setActiveSession(session);
      setSessionDetailsById((current) => ({ ...current, [session.id]: session }));
      setSessions((current) => upsertSessionSummary(current, session));
      setWorkspaceState((current) =>
        addSessionToWorkspace(current, current.activeWorkspaceId, activeDaemonId, session.id),
      );
      setComposer("");
      setNewSessionOpen(false);
    } finally {
      setCreatingSession(false);
    }
  }

  async function handleRestoreSession(item: CodexHistoryEntry) {
    if (!activeDaemonId) {
      return;
    }
    setRestoringHistoryId(item.id);
    try {
      const session = await api<SessionDetails>(
        `/api/daemons/${activeDaemonId}/history/${item.id}/restore`,
        {
          method: "POST",
          body: JSON.stringify({
            cwd: item.cwd || cwd,
            model,
            reasoningEffort: effort,
            sandbox,
            approvalPolicy,
          }),
        },
      );
      setHistoryOpen(false);
      setActiveSessionId(session.id);
      setActiveSession(session);
      setSessionDetailsById((current) => ({ ...current, [session.id]: session }));
      setSessions((current) => upsertSessionSummary(current, session));
      setWorkspaceState((current) =>
        addSessionToWorkspace(current, current.activeWorkspaceId, activeDaemonId, session.id),
      );
    } finally {
      setRestoringHistoryId(null);
    }
  }

  function handleSelectSession(sessionId: string) {
    setActiveSessionId(sessionId);
    if (!activeDaemonId) {
      return;
    }
    setWorkspaceState((current) =>
      setWorkspaceActiveSession(current, current.activeWorkspaceId, activeDaemonId, sessionId),
    );
  }

  function handleCreateWorkspace() {
    setWorkspaceState((current) => createWorkspace(current));
  }

  function handleDeleteWorkspace() {
    setWorkspaceState((current) => deleteActiveWorkspace(current));
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

  async function handleOpenFilesPane() {
    if (!activeDaemonId || !activeSessionId || !activeSession) {
      return;
    }
    setSessionPane("files");
    await loadProjectFiles(activeDaemonId, activeSessionId, activeSession.cwd);
  }

  async function handleBrowseProjectPath(pathValue?: string) {
    if (!activeDaemonId || !activeSessionId) {
      return;
    }
    await loadProjectFiles(activeDaemonId, activeSessionId, pathValue);
  }

  async function handleOpenProjectFile(filePath: string) {
    if (!activeDaemonId || !activeSessionId) {
      return;
    }
    await loadProjectFile(activeDaemonId, activeSessionId, filePath);
  }

  async function handleSaveProjectFile() {
    if (!activeDaemonId || !activeSessionId || !selectedFile || selectedFile.kind !== "text") {
      return;
    }
    setSavingFile(true);
    try {
      const result = await api<ProjectFileReadResult>(
        `/api/daemons/${activeDaemonId}/sessions/${activeSessionId}/file`,
        {
          method: "PUT",
          body: JSON.stringify({
            path: selectedFile.path,
            content: fileEditorValue,
          }),
        },
      );
      setSelectedFile(result);
      setFileEditorValue(result.content);
    } finally {
      setSavingFile(false);
    }
  }

  function handleQuoteFileSelection() {
    if (!selectedFile || selectedFile.kind !== "text") {
      return;
    }
    const textarea = document.getElementById("project-file-editor") as HTMLTextAreaElement | null;
    const start = textarea?.selectionStart ?? 0;
    const end = textarea?.selectionEnd ?? 0;
    const selectedText =
      start !== end ? fileEditorValue.slice(start, end) : fileEditorValue;
    const extension = pathLikeExtension(selectedFile.path);
    const quoted = `\n\n[${selectedFile.path}]\n\`\`\`${extension}\n${selectedText.trim()}\n\`\`\`\n`;
    setComposer((current) => `${current}${quoted}`.trimStart());
    setSessionPane("chat");
  }

  async function handleSendMessage() {
    if (!activeDaemonId || !activeSessionId || !composer.trim()) {
      return;
    }
    const text = composer.trim();
    const since = Date.now();
    setSendingMessage(true);
    setPendingAssistant({
      sessionId: activeSessionId,
      since,
      baseTranscriptCount: transcript.length,
      userEntry: {
        id: `pending-user-${since}`,
        kind: "user",
        text,
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
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    setComposer("");
    try {
      await api(`/api/daemons/${activeDaemonId}/sessions/${activeSessionId}/messages`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
    } catch (error) {
      setPendingAssistant(null);
      setSendingMessage(false);
      setComposer(text);
      throw error;
    }
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
    const session = await api<SessionDetails>(
      `/api/daemons/${activeDaemonId}/sessions/${activeSessionId}/config`,
      {
        method: "PATCH",
        body: JSON.stringify(next),
      },
    );
    setActiveSession(session);
    setSessionDetailsById((current) => ({ ...current, [session.id]: session }));
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
      const session = await api<SessionDetails>(
        `/api/daemons/${activeDaemonId}/sessions/${activeSessionId}/title`,
        {
          method: "PATCH",
          body: JSON.stringify({ title: renameTitle.trim() }),
        },
      );
      setActiveSession(session);
      setSessionDetailsById((current) => ({ ...current, [session.id]: session }));
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
      const session = await api<SessionDetails>(
        `/api/daemons/${activeDaemonId}/sessions/${activeSessionId}/approvals/${encodeURIComponent(approvalRequestId)}`,
        {
          method: "POST",
          body: JSON.stringify({ decision }),
        },
      );
      setActiveSession(session);
      setSessionDetailsById((current) => ({ ...current, [session.id]: session }));
      setSessions((current) => upsertSessionSummary(current, session));
    } finally {
      setApprovalActionId(null);
    }
  }

  function handleTranscriptScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const isNearBottom = distanceToBottom <= 64;
    stickToBottomRef.current = isNearBottom;
    setShowScrollToBottom(!isNearBottom);
    if (!hasOlderTranscript || prependPendingRef.current || element.scrollTop > 120) {
      return;
    }
    prependPendingRef.current = {
      previousHeight: element.scrollHeight,
      previousTop: element.scrollTop,
    };
    setLoadedTranscriptCount((current) =>
      Math.min(transcript.length, current + TRANSCRIPT_CHUNK_SIZE),
    );
  }

  function scrollTranscriptToBottom() {
    const scrollElement = transcriptRef.current;
    if (!scrollElement) {
      return;
    }
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    scrollElement.scrollTop = scrollElement.scrollHeight;
  }

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
        <header className="flex items-center gap-2 overflow-x-auto border-b border-border px-3 py-2 whitespace-nowrap">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setViewMode((current) => (current === "chat" ? "overview" : "chat"))}
            >
              {viewMode === "chat" ? (
                <LayoutGrid className="h-4 w-4" />
              ) : (
                <MessageSquareText className="h-4 w-4" />
              )}
            </Button>
            <Select value={activeDaemonId ?? ""} onValueChange={setActiveDaemonId}>
              <SelectTrigger
                aria-label="Select daemon"
                className="h-9 w-9 shrink-0 justify-center rounded-lg border-border/80 bg-card/60 px-0 text-sm shadow-none [&>svg:last-child]:hidden md:h-8 md:min-w-[220px] md:max-w-[360px] md:flex-1 md:justify-between md:bg-transparent md:px-2 md:[&>svg:last-child]:inline-flex"
              >
                <Server className="h-4 w-4 shrink-0" />
                <span className="hidden min-w-0 flex-1 truncate md:block">
                  <SelectValue placeholder="Daemon" />
                </span>
              </SelectTrigger>
              <SelectContent>
                {daemons.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0 max-w-[42vw] shrink md:max-w-none">
            <div className="flex items-center gap-1 overflow-x-auto rounded-md border border-border bg-muted/30 px-1 py-1">
              {workspaceState.workspaces.map((workspace, index) => (
                <Button
                  key={workspace.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={[
                    "h-7 min-w-7 px-2 text-xs",
                    workspace.id === workspaceState.activeWorkspaceId
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground",
                  ].join(" ")}
                  onClick={() =>
                    setWorkspaceState((current) => ({
                      ...current,
                      activeWorkspaceId: workspace.id,
                    }))
                  }
                >
                  {index + 1}
                </Button>
              ))}
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={handleCreateWorkspace}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={handleDeleteWorkspace}
                disabled={workspaceState.workspaces.length <= 1}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge connectionState={connectionState} />
            <div className="flex shrink-0 items-center gap-1">
              <Dialog
                open={historyOpen}
                onOpenChange={(open) => {
                  setHistoryOpen(open);
                  if (open && activeDaemonId) {
                    void loadHistory(activeDaemonId);
                  }
                }}
              >
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 px-2 sm:px-2.5" disabled={!activeDaemonId}>
                    <History className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">History</span>
                  </Button>
                </DialogTrigger>
                <DialogContent className="ui-dialog-content--drawer">
                  <DialogHeader>
                    <DialogTitle>History</DialogTitle>
                    <DialogDescription>restore from daemon-bound Codex sessions</DialogDescription>
                  </DialogHeader>
                  <ScrollArea className="h-[calc(100vh-64px)]">
                    <div className="space-y-2 p-4">
                      <Input
                        value={historySearch}
                        onChange={(event) => setHistorySearch(event.target.value)}
                        placeholder="Search history"
                        className="h-8"
                      />
                      {historyLoading ? (
                        <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                          Loading history
                        </div>
                      ) : null}
                      {groupedHistory.map((item) =>
                        item.type === "separator" ? (
                          <div
                            key={item.key}
                            className="sticky top-0 z-10 -mx-1 bg-background/95 px-1 py-1 text-[11px] font-medium text-muted-foreground backdrop-blur"
                          >
                            {item.label}
                          </div>
                        ) : (
                          <button
                            key={item.entry.id}
                            type="button"
                            className="grid w-full gap-1 rounded-md border border-border px-3 py-2 text-left text-xs hover:bg-accent/50 disabled:cursor-wait disabled:opacity-70"
                            onClick={() => void handleRestoreSession(item.entry)}
                            disabled={Boolean(restoringHistoryId)}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="line-clamp-2 text-sm font-medium">{item.entry.title || item.entry.id}</div>
                              {restoringHistoryId === item.entry.id ? (
                                <LoaderCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
                              ) : null}
                            </div>
                            <div className="text-muted-foreground">{item.entry.cwd}</div>
                            <div className="text-muted-foreground">
                              {formatDateTime(item.entry.updatedAt)} · {item.entry.source || "unknown"} · {restoringHistoryId === item.entry.id ? "restoring" : item.entry.status}
                            </div>
                          </button>
                        ),
                      )}
                    </div>
                  </ScrollArea>
                </DialogContent>
              </Dialog>
              <Dialog open={newSessionOpen} onOpenChange={setNewSessionOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" className="h-8 px-2 sm:px-2.5" disabled={!activeDaemonId}>
                    <Play className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">New</span>
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-[560px] md:w-full">
                  <DialogHeader>
                    <DialogTitle>New Session</DialogTitle>
                    <DialogDescription>cwd</DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-3 p-4">
                    <div className="flex items-center gap-2">
                      <Input
                        value={cwd}
                        onChange={(event) => setCwd(event.target.value)}
                        placeholder="Working directory"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="shrink-0"
                        onClick={() => void handleOpenDirectoryPicker()}
                        disabled={!activeDaemonId}
                      >
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        disabled={!activeDaemonId || !cwd.trim() || creatingSession}
                        onClick={() => void handleCreateSession()}
                      >
                        {creatingSession ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
                        Create
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
              <Dialog
                open={directoryPickerOpen}
                onOpenChange={(open) => {
                  setDirectoryPickerOpen(open);
                  if (!open) {
                    setDirectoryBrowserPath("");
                  }
                }}
              >
                <DialogContent className="max-w-[720px] md:w-full">
                  <DialogHeader>
                    <DialogTitle>Select Directory</DialogTitle>
                    <DialogDescription>remote daemon filesystem</DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-3 p-4">
                    <div className="flex items-center gap-2">
                      <Input
                        value={directoryBrowserPath}
                        onChange={(event) => setDirectoryBrowserPath(event.target.value)}
                        placeholder="Directory path"
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void handleBrowseDirectory(directoryBrowserPath);
                          }
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        disabled={!directoryBrowser?.parentPath || directoryBrowserLoading}
                        onClick={() => void handleBrowseDirectory(directoryBrowser?.parentPath)}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!directoryBrowserPath.trim() || directoryBrowserLoading}
                        onClick={() => void handleBrowseDirectory(directoryBrowserPath)}
                      >
                        Open
                      </Button>
                    </div>
                    <div className="rounded-md border border-border">
                      <ScrollArea className="h-[360px]">
                        <div className="grid gap-1 p-2">
                          {directoryBrowserLoading ? (
                            <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
                              <LoaderCircle className="h-4 w-4 animate-spin" />
                              Loading directories
                            </div>
                          ) : null}
                          {!directoryBrowserLoading && !directoryBrowser?.entries.length ? (
                            <div className="px-2 py-2 text-sm text-muted-foreground">No subdirectories</div>
                          ) : null}
                          {directoryBrowser?.entries.map((entry) => (
                            <button
                              key={entry.path}
                              type="button"
                              className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-accent/60"
                              onClick={() => void handleBrowseDirectory(entry.path)}
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="truncate">{entry.name}</span>
                              </div>
                              <ChevronDown className="-rotate-90 h-4 w-4 shrink-0 text-muted-foreground" />
                            </button>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-xs text-muted-foreground">
                        {directoryBrowser?.currentPath || directoryBrowserPath || cwd}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        disabled={!directoryBrowser?.currentPath && !directoryBrowserPath.trim()}
                        onClick={() => {
                          setCwd(directoryBrowser?.currentPath || directoryBrowserPath.trim());
                          setDirectoryPickerOpen(false);
                        }}
                      >
                        Select
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
              >
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </header>

        {viewMode === "overview" ? (
          <main className="grid min-h-0 grid-rows-[64px_minmax(0,1fr)]">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {activeDaemon ? (
                    <Badge variant={activeDaemon.online ? "success" : "destructive"}>
                      {activeDaemon.online ? "online" : "offline"}
                    </Badge>
                  ) : null}
                  <div className="truncate text-sm font-medium">
                    {activeDaemon?.name || "No Daemon"}
                  </div>
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {activeDaemon
                    ? `${overviewSessions.length} active sessions · ${activeDaemon.cwd}`
                    : "select daemon"}
                </div>
              </div>
            </div>
            <div className="min-h-0 overflow-auto bg-muted/10 px-4 py-4">
              {overviewSessions.length ? (
                <div className="overview-columns">
                  {overviewSessions.map((session) => (
                    <OverviewSessionCard
                      key={session.id}
                      session={session}
                      details={sessionDetailsById[session.id]}
                      active={session.id === activeSessionId}
                      onOpen={() => {
                        handleSelectSession(session.id);
                        setViewMode("chat");
                      }}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <div className="rounded-lg border border-dashed border-border bg-card px-4 py-3 text-sm text-muted-foreground">
                    No active sessions
                  </div>
                </div>
              )}
            </div>
          </main>
        ) : (
          <div
            className={[
              "ui-layout-motion relative grid min-h-0 grid-cols-1",
              sessionsCollapsed ? "md:grid-cols-[52px_minmax(0,1fr)]" : "md:grid-cols-[248px_minmax(0,1fr)]",
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
            <aside
              className={[
                "ui-panel-motion absolute inset-y-0 left-0 z-30 grid min-h-0 w-[min(85vw,320px)] grid-rows-[40px_minmax(0,1fr)] bg-background shadow-2xl md:static md:z-auto md:w-auto md:bg-transparent md:shadow-none",
                sessionsCollapsed
                  ? "pointer-events-none -translate-x-full overflow-hidden border-r-0 opacity-0 md:pointer-events-auto md:w-[52px] md:translate-x-0 md:border-r md:opacity-100"
                  : "border-r border-border opacity-100",
              ].join(" ")}
            >
              <div className="flex items-center gap-2 px-2.5 text-xs uppercase tracking-[0.2em] text-muted-foreground">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  aria-label={sessionsCollapsed ? "Expand sessions" : "Collapse sessions"}
                  onClick={() => setSessionsCollapsed((current) => !current)}
                >
                  <PanelLeftOpen
                    className={`h-4 w-4 transition-transform ${sessionsCollapsed ? "" : "rotate-180"}`}
                  />
                </Button>
                {!sessionsCollapsed ? <span className="truncate">Sessions</span> : null}
                {!sessionsCollapsed ? <Badge variant="outline">{visibleSessions.length}</Badge> : null}
              </div>
              {!sessionsCollapsed ? (
                <ScrollArea>
                  <div className="space-y-1.5 p-2">
                    {visibleSessions.map((session) => (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => handleSelectSession(session.id)}
                        className={[
                          "ui-session-item grid w-full gap-1 rounded-md border px-2 py-1.5 text-left text-xs",
                          activeSessionId === session.id
                            ? "border-primary/40 bg-primary/10"
                            : "border-border hover:bg-accent/60",
                        ].join(" ")}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="line-clamp-2 text-[13px] font-medium leading-5">{session.title}</div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                            aria-label="Delete session"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDeleteSession(session.id);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        <div className="text-[11px] text-muted-foreground">{formatDateTime(session.updatedAt)}</div>
                        <div className="truncate text-[11px] text-muted-foreground">{session.cwd}</div>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              ) : null}
            </aside>

            <main className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]">
              <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 overflow-hidden">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {sessionsCollapsed ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 md:hidden"
                      aria-label="Expand sessions"
                      onClick={() => setSessionsCollapsed(false)}
                    >
                      <PanelLeftOpen className="h-4 w-4" />
                    </Button>
                  ) : null}
                  <div className="flex items-center gap-1 rounded-md border border-border bg-muted/30 p-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className={sessionPane === "chat" ? "h-7 bg-card px-2 text-xs shadow-sm" : "h-7 px-2 text-xs"}
                      onClick={() => setSessionPane("chat")}
                      disabled={!activeSessionId}
                    >
                      <MessageSquareText className="h-3.5 w-3.5" />
                      Chat
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={sessionPane === "files" ? "h-7 bg-card px-2 text-xs shadow-sm" : "h-7 px-2 text-xs"}
                      onClick={() => void handleOpenFilesPane()}
                      disabled={!activeSessionId}
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      Files
                    </Button>
                  </div>
                  <div className="truncate text-sm font-medium">
                    {activeSession?.title || activeDaemon?.name || "No Session"}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Dialog open={renameSessionOpen} onOpenChange={setRenameSessionOpen}>
                    <DialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label="Rename session"
                        disabled={!activeSessionId}
                      >
                        <Edit3 className="h-4 w-4" />
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-[420px] md:w-full">
                      <DialogHeader>
                        <DialogTitle>Rename Session</DialogTitle>
                        <DialogDescription>Update the local session title</DialogDescription>
                      </DialogHeader>
                      <div className="grid gap-3 p-4">
                        <Input
                          value={renameTitle}
                          onChange={(event) => setRenameTitle(event.target.value)}
                          placeholder="Session title"
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void handleRenameSession();
                            }
                          }}
                        />
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            disabled={!activeSessionId || !renameTitle.trim() || renamingSession}
                            onClick={() => void handleRenameSession()}
                          >
                            {renamingSession ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
                            Save
                          </Button>
                        </div>
                      </div>
                    </DialogContent>
                  </Dialog>
                </div>
              </div>

              {sessionPane === "files" ? (
                <>
                  <div className="grid min-h-0 grid-cols-1 bg-muted/10 md:grid-cols-[280px_minmax(0,1fr)]">
                    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-b border-border md:border-r md:border-b-0">
                      <div className="grid gap-2 border-b border-border px-3 py-3">
                        <div className="truncate text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                          Project Files
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {projectFiles?.currentPath || activeSession?.cwd || ""}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 px-2"
                            disabled={!projectFiles?.parentPath || projectFilesLoading}
                            onClick={() => void handleBrowseProjectPath(projectFiles?.parentPath)}
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                            Up
                          </Button>
                          {projectFilesLoading ? (
                            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                              <LoaderCircle className="h-3 w-3 animate-spin" />
                              Loading
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <ScrollArea>
                        <div className="grid gap-1 p-2">
                          {!projectFilesLoading && !projectFiles?.entries.length ? (
                            <div className="px-2 py-2 text-sm text-muted-foreground">No files</div>
                          ) : null}
                          {projectFiles?.entries.map((entry) => (
                            <button
                              key={entry.path}
                              type="button"
                              className={[
                                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/50",
                                selectedFile?.path === entry.path ? "bg-accent/60" : "",
                              ].join(" ")}
                              onClick={() =>
                                entry.kind === "directory"
                                  ? void handleBrowseProjectPath(entry.path)
                                  : void handleOpenProjectFile(entry.path)
                              }
                            >
                              {entry.kind === "directory" ? (
                                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                              ) : getProjectFileIcon(entry.path)}
                              <div className="min-w-0 flex-1 truncate">{entry.name}</div>
                              {entry.kind === "file" && typeof entry.size === "number" ? (
                                <div className="shrink-0 text-[10px] text-muted-foreground">
                                  {formatFileSize(entry.size)}
                                </div>
                              ) : null}
                            </button>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>

                    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
                      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                        <div className="min-w-0 truncate text-xs text-muted-foreground">
                          {selectedFile?.path || "Select a file"}
                        </div>
                        <div className="flex items-center gap-2">
                          {selectedFile?.kind === "text" ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 px-2"
                              onClick={handleQuoteFileSelection}
                            >
                              <FileCode2 className="h-3.5 w-3.5" />
                              Quote
                            </Button>
                          ) : null}
                          {selectedFile?.kind === "text" ? (
                            <Button
                              type="button"
                              size="sm"
                              className="h-7 px-2"
                              onClick={() => void handleSaveProjectFile()}
                              disabled={savingFile}
                            >
                              {savingFile ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                              Save
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      <div className="min-h-0 overflow-auto">
                        {selectedFileLoading ? (
                          <div className="flex h-full items-center justify-center px-4 py-4 text-sm text-muted-foreground">
                            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                            Loading file
                          </div>
                        ) : selectedFile?.kind === "image" ? (
                          <div className="flex h-full items-start justify-center p-4">
                            <img
                              src={selectedFile.content}
                              alt={selectedFile.path}
                              className="max-h-full max-w-full rounded-md border border-border bg-background object-contain"
                            />
                          </div>
                        ) : selectedFile?.kind === "binary" ? (
                          <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
                            Binary preview is not supported
                          </div>
                        ) : selectedFile?.kind === "text" ? (
                          <Textarea
                            id="project-file-editor"
                            value={fileEditorValue}
                            onChange={(event) => setFileEditorValue(event.target.value)}
                            className="h-full min-h-full w-full resize-none border-0 rounded-none bg-transparent px-4 py-3 font-mono text-[12px] leading-6 shadow-none focus-visible:ring-0"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
                            Select a file to preview
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
                    <div className="truncate text-[11px] text-muted-foreground">
                      {activeSession ? activeSession.cwd : cwd}
                    </div>
                    <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => setSessionPane("chat")}>
                      <MessageSquareText className="h-3.5 w-3.5" />
                      Back to Chat
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div
                    ref={transcriptRef}
                    className="relative min-h-0 overflow-auto bg-muted/10"
                    onScroll={handleTranscriptScroll}
                  >
                    {sessionLoading ? (
                      <div className="flex h-full items-center justify-center px-3 py-3">
                        <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground shadow-sm">
                          <LoaderCircle className="h-4 w-4 animate-spin" />
                          Loading session
                        </div>
                      </div>
                    ) : (
                      <div
                        className="relative mx-auto w-full max-w-[1200px] px-3 py-3"
                        style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                      >
                        {hasOlderTranscript ? (
                          <div className="sticky top-0 z-10 mb-2 flex justify-center">
                            <div className="rounded-full border border-border bg-background/90 px-3 py-1 text-[11px] text-muted-foreground backdrop-blur">
                              Scroll top to load older messages
                            </div>
                          </div>
                        ) : null}
                        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                          const row = visibleTranscript[virtualRow.index];
                          if (!row) {
                            return null;
                          }
                          return (
                            <div
                              key={row.id}
                              data-index={virtualRow.index}
                              ref={(node) => {
                                if (node) {
                                  rowVirtualizer.measureElement(node);
                                }
                              }}
                              className="absolute left-0 top-0 w-full px-3 ui-entry-reveal"
                              style={{ transform: `translateY(${virtualRow.start}px)` }}
                            >
                              <TranscriptCard
                                entry={row.entry}
                                reasoning={row.reasoning}
                                busy={approvalActionId === row.entry.id}
                                expanded={expanded.has(row.entry.id)}
                                onApprovalAction={(decision) => void handleApprovalAction(row.entry, decision)}
                                onToggle={() =>
                                  setExpanded((current) => {
                                    const next = new Set(current);
                                    if (next.has(row.entry.id)) {
                                      next.delete(row.entry.id);
                                    } else {
                                      next.add(row.entry.id);
                                    }
                                    return next;
                                  })
                                }
                              />
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {showScrollToBottom && chatTranscript.length ? (
                      <div className="ui-fab-reveal pointer-events-none sticky bottom-3 z-20 flex justify-end px-3">
                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          className="pointer-events-auto h-8 w-8 rounded-full shadow-sm"
                          onClick={scrollTranscriptToBottom}
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : null}
                  </div>

                  <div className="grid gap-2 border-t border-border p-3">
                    <Textarea
                      value={composer}
                      onChange={(event) => setComposer(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.ctrlKey) {
                          event.preventDefault();
                          void handleSendMessage();
                        }
                      }}
                      placeholder="Enter send · Ctrl+Enter newline"
                      className="min-h-[96px] max-h-[128px] md:max-h-[96px]"
                    />
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-center gap-2">
                        {activity ? (
                          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                            {isBusyActivity(activity) ? (
                              <LoaderCircle className="h-3 w-3 animate-spin" />
                            ) : (
                              <Circle className="h-3 w-3 fill-current" />
                            )}
                            {activity.label}
                          </div>
                        ) : (
                          <div className="truncate text-[11px] text-muted-foreground">
                            {activeSession ? activeSession.cwd : cwd}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1 sm:justify-end">
                        <InlineSelect
                          value={sandbox}
                          onValueChange={(value) => {
                            const nextValue = value as "read-only" | "workspace-write" | "danger-full-access";
                            const nextApprovalPolicy = defaultApprovalPolicyForSandbox(nextValue);
                            setSandbox(nextValue);
                            setApprovalPolicy(nextApprovalPolicy);
                            void handleSessionConfigChange({
                              sandbox: nextValue,
                              approvalPolicy: nextApprovalPolicy,
                            });
                          }}
                          options={SANDBOX_OPTIONS}
                        />
                        <InlineSelect
                          value={model}
                          onValueChange={(value) => {
                            setModel(value);
                            void handleSessionConfigChange({ model: value });
                          }}
                          options={config.models.map((item) => ({
                            value: item.model,
                            label: item.model,
                          }))}
                        />
                        <InlineSelect
                          value={effort}
                          onValueChange={(value) => {
                            setEffort(value);
                            void handleSessionConfigChange({ reasoningEffort: value });
                          }}
                          options={(currentModel?.supportedReasoningEfforts || []).map((item) => ({
                            value: item.reasoningEffort,
                            label: formatEffortLabel(item.reasoningEffort),
                          }))}
                        />
                        {isTurnBusy(activeSession, sendingMessage) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!activeDaemonId || !activeSessionId}
                            onClick={() => void handleInterrupt()}
                          >
                            <Square className="h-3.5 w-3.5" />
                            Stop
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            disabled={!activeDaemonId || !activeSessionId || !composer.trim()}
                            onClick={() => void handleSendMessage()}
                          >
                            <Send className="h-3.5 w-3.5" />
                            Send
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </main>
          </div>
        )}
      </div>
    </div>
  );
}

function TranscriptCard({
  entry,
  reasoning,
  busy,
  expanded,
  onApprovalAction,
  onToggle,
}: {
  entry: TranscriptEntry;
  reasoning?: TranscriptEntry;
  busy: boolean;
  expanded: boolean;
  onApprovalAction: (decision: "approve" | "deny") => void;
  onToggle: () => void;
}) {
  const expandable = ["tool", "command", "file_change"].includes(entry.kind);
  const preview = lastLines(entry.text, TOOL_LINE_LIMIT);
  const body = expandable && !expanded ? preview : entry.text;
  const rowClassName = getBubbleRowClassName(entry);
  const bubbleClassName = getBubbleClassName(entry);
  const metaBadges = getEntryMetaBadges(entry);
  const compactFileChange = entry.kind === "file_change";
  const showMetaHeader = !compactFileChange && (metaBadges.length > 0 || !isChatBubble(entry));

  return (
    <article className={`mb-4 flex w-full ${rowClassName}`}>
      <div className={bubbleClassName}>
        {entry.kind === "assistant" && reasoning ? (
          <AttachedReasoning reasoning={reasoning} expanded={expanded} onToggle={onToggle} />
        ) : null}

        {showMetaHeader ? (
          <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <div className="flex items-center gap-1.5">
              {!isChatBubble(entry) ? <Badge variant={variantForEntry(entry)}>{entry.kind}</Badge> : null}
              {metaBadges.map((badge) => (
                <Badge key={badge.label} variant={badge.variant}>
                  {badge.label}
                </Badge>
              ))}
            </div>
            <div>{formatTime(entry.createdAt)}</div>
          </div>
        ) : null}

        {renderEntryBody(entry, body, expanded)}

        {entry.kind === "approval" ? (
          <ApprovalActions entry={entry} busy={busy} onApprovalAction={onApprovalAction} />
        ) : null}

        {isChatBubble(entry) ? <TurnTimingFooter entry={reasoning?.meta ? reasoning : entry} /> : null}

        {expandable && entry.text ? (
          <div className="mt-2 flex justify-end">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onToggle}>
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function OverviewSessionCard({
  session,
  details,
  active,
  onOpen,
}: {
  session: SessionSummary;
  details?: SessionDetails;
  active: boolean;
  onOpen: () => void;
}) {
  const activity = getSessionOverviewActivity(session, details);
  const previewEntries = getOverviewPreviewEntries(details);

  return (
    <button
      type="button"
      className={[
        "overview-card ui-overview-card grid max-h-[340px] w-full gap-2 overflow-hidden rounded-xl border bg-card px-3 py-3 text-left shadow-sm",
        active ? "border-primary/40 bg-primary/5" : "border-border hover:bg-accent/40",
      ].join(" ")}
      onClick={onOpen}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="line-clamp-2 text-sm font-medium">{session.title}</div>
          <div className="mt-1 truncate text-[11px] text-muted-foreground">{session.cwd}</div>
        </div>
        {activity ? <Badge variant={activity.variant}>{activity.label}</Badge> : null}
      </div>

      <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
        <Badge variant={session.origin === "restored" ? "warning" : "outline"}>{session.origin}</Badge>
        <span>{session.model || "default"}</span>
        <span>{session.reasoningEffort || "medium"}</span>
        <span>{formatDateTime(session.updatedAt)}</span>
      </div>

      <div className="grid min-h-0 gap-1 overflow-hidden">
        {previewEntries.length ? (
          previewEntries.map((entry) => <OverviewEntryPreview key={entry.id} entry={entry} />)
        ) : (
          <div className="text-xs text-muted-foreground">
            {details ? "No messages yet" : "Loading transcript"}
          </div>
        )}
      </div>
    </button>
  );
}

function OverviewEntryPreview({ entry }: { entry: TranscriptEntry }) {
  const label = getOverviewEntryLabel(entry);
  const body = getOverviewEntryPreviewText(entry);

  return (
    <div className="grid gap-0.5 text-left">
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="uppercase tracking-[0.16em]">{label}</span>
        <span>{formatTime(entry.createdAt)}</span>
      </div>
      <div className="line-clamp-6 whitespace-pre-wrap break-words text-[12px] leading-4.5 text-foreground/90">
        {body}
      </div>
    </div>
  );
}

function ApprovalActions({
  entry,
  busy,
  onApprovalAction,
}: {
  entry: TranscriptEntry;
  busy: boolean;
  onApprovalAction: (decision: "approve" | "deny") => void;
}) {
  if (entry.status && entry.status !== "pending") {
    return (
      <div className="mt-3 text-[11px] text-muted-foreground">
        {entry.status === "approved" ? "Approved" : entry.status === "declined" ? "Denied" : entry.status}
      </div>
    );
  }

  return (
    <div className="mt-3 flex items-center justify-end gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => onApprovalAction("deny")}>
        {busy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : null}
        Deny
      </Button>
      <Button size="sm" disabled={busy} onClick={() => onApprovalAction("approve")}>
        {busy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : null}
        Approve
      </Button>
    </div>
  );
}

function TurnTimingFooter({ entry }: { entry: TranscriptEntry }) {
  const firstByteMs =
    typeof entry.meta?.firstByteMs === "number" ? entry.meta.firstByteMs : undefined;
  const totalMs = typeof entry.meta?.totalMs === "number" ? entry.meta.totalMs : undefined;
  if (typeof firstByteMs !== "number" && typeof totalMs !== "number") {
    return null;
  }

  const parts = [
    typeof firstByteMs === "number" ? `首字 ${formatDurationMs(firstByteMs)}` : "",
    typeof totalMs === "number" ? `总耗时 ${formatDurationMs(totalMs)}` : "",
  ].filter(Boolean);

  if (!parts.length) {
    return null;
  }

  return <div className="mt-2 text-[11px] text-muted-foreground">{parts.join(" · ")}</div>;
}

function AttachedReasoning({
  reasoning,
  expanded,
  onToggle,
}: {
  reasoning: TranscriptEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const text = getAttachedReasoningText(reasoning, expanded);
  if (!text) {
    return null;
  }

  return reasoning.status === "streaming" ? (
    <div className="mb-3">
      <MarkdownBody text={text} muted />
    </div>
  ) : (
    <div className="mb-3">
      <div
        className={[
          "overflow-hidden",
          expanded ? "" : "line-clamp-1",
        ].join(" ")}
      >
        <MarkdownBody text={text} muted />
      </div>
      <div className="mt-1 flex justify-end">
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onToggle}>
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

function getReasoningFullText(reasoning?: TranscriptEntry) {
  if (!reasoning) {
    return "";
  }
  const text = (reasoning.text || "").trim();
  if (!text) {
    return reasoning.status === "streaming" ? "Thinking..." : "";
  }
  return text;
}

function getAttachedReasoningText(reasoning?: TranscriptEntry, expanded: boolean = false) {
  const text = getReasoningFullText(reasoning);
  if (!text) {
    return "";
  }
  if (reasoning?.status === "streaming") {
    return text;
  }
  if (expanded) {
    return text;
  }
  const firstLine = text.split(/\r?\n/).find((line) => line.trim());
  return firstLine?.trim() ?? text;
}

function buildChatTranscriptRows(transcript: TranscriptEntry[]): ChatTranscriptRow[] {
  const rows: ChatTranscriptRow[] = [];
  let pendingReasoning: TranscriptEntry | undefined;

  const flushReasoning = () => {
    if (!pendingReasoning) {
      return;
    }
    rows.push({
      id: `reasoning-host:${pendingReasoning.id}`,
      entry: {
        id: `reasoning-host:${pendingReasoning.id}`,
        kind: "assistant",
        text: "",
        createdAt: pendingReasoning.createdAt,
        status: pendingReasoning.status === "streaming" ? "streaming" : "completed",
      },
      reasoning: pendingReasoning,
    });
    pendingReasoning = undefined;
  };

  for (const entry of transcript) {
    if (entry.kind === "reasoning") {
      pendingReasoning = entry;
      continue;
    }

    if (entry.kind === "assistant") {
      rows.push({
        id: entry.id,
        entry,
        reasoning: pendingReasoning,
      });
      pendingReasoning = undefined;
      continue;
    }

    if (pendingReasoning) {
      flushReasoning();
    }

    rows.push({
      id: entry.id,
      entry,
    });
  }

  if (pendingReasoning) {
    flushReasoning();
  }

  return rows;
}

function renderEntryBody(entry: TranscriptEntry, body: string, expanded: boolean) {
  if (entry.kind === "assistant" || entry.kind === "user") {
    if (entry.kind === "assistant" && entry.status === "streaming" && !body.trim()) {
      return <TypingPlaceholder />;
    }
    return <MarkdownBody text={body} />;
  }

  if (entry.kind === "file_change") {
    return (
      <div
        className={
          expanded
            ? "max-h-80 overflow-auto rounded-md border border-border bg-background/70"
            : "max-h-56 overflow-hidden rounded-md border border-border bg-background/70"
        }
      >
        <DiffViewer text={body} />
      </div>
    );
  }

  if (entry.kind === "command" || entry.kind === "tool") {
    return (
      <div
        className={
          expanded
            ? "max-h-80 overflow-auto rounded-md border border-border bg-background/70 p-2 font-mono text-xs leading-5 whitespace-pre-wrap"
            : "overflow-hidden whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground/90"
        }
      >
        {body}
      </div>
    );
  }

  if (entry.kind === "reasoning") {
    return expanded ? (
      <div className="max-h-72 overflow-auto rounded-md border border-border bg-background/60 p-2">
        <MarkdownBody text={body || "thinking"} muted />
      </div>
    ) : (
      <div className="text-sm leading-6 text-muted-foreground">{body || "thinking"}</div>
    );
  }

  if (entry.kind === "approval") {
    return <ApprovalBody entry={entry} />;
  }

  return <MarkdownBody text={body || ""} muted={entry.kind === "system"} />;
}

function ApprovalBody({ entry }: { entry: TranscriptEntry }) {
  const approvalKind = typeof entry.meta?.approvalKind === "string" ? entry.meta.approvalKind : "";
  const payload = (entry.meta?.payload ?? {}) as Record<string, unknown>;

  if (approvalKind === "item/permissions/requestApproval") {
    return (
      <div className="grid gap-2 text-sm">
        <div className="font-medium">Additional permissions requested</div>
        {typeof payload.reason === "string" && payload.reason ? (
          <div className="text-muted-foreground">{payload.reason}</div>
        ) : null}
        <pre className="overflow-auto rounded-md border border-border bg-background/70 p-3 font-mono text-xs leading-5 whitespace-pre-wrap">
          {JSON.stringify(payload.permissions ?? {}, null, 2)}
        </pre>
      </div>
    );
  }

  if (
    approvalKind === "execCommandApproval" ||
    approvalKind === "item/commandExecution/requestApproval"
  ) {
    return (
      <div className="grid gap-2 text-sm">
        <div className="font-medium">Command approval requested</div>
        {typeof payload.reason === "string" && payload.reason ? (
          <div className="text-muted-foreground">{payload.reason}</div>
        ) : null}
        <pre className="overflow-auto rounded-md border border-border bg-background/70 p-3 font-mono text-xs leading-5 whitespace-pre-wrap">
          {Array.isArray(payload.command) ? payload.command.join(" ") : String(payload.command ?? "")}
        </pre>
        {typeof payload.cwd === "string" && payload.cwd ? (
          <div className="text-[11px] text-muted-foreground">{payload.cwd}</div>
        ) : null}
      </div>
    );
  }

  if (
    approvalKind === "applyPatchApproval" ||
    approvalKind === "item/fileChange/requestApproval"
  ) {
    return (
      <div className="grid gap-2 text-sm">
        <div className="font-medium">File change approval requested</div>
        {typeof payload.reason === "string" && payload.reason ? (
          <div className="text-muted-foreground">{payload.reason}</div>
        ) : null}
        <pre className="max-h-64 overflow-auto rounded-md border border-border bg-background/70 p-3 font-mono text-xs leading-5 whitespace-pre-wrap">
          {JSON.stringify(payload.fileChanges ?? {}, null, 2)}
        </pre>
      </div>
    );
  }

  return <MarkdownBody text={entry.text} muted />;
}

function MarkdownBody({ text, muted = false }: { text: string; muted?: boolean }) {
  return (
    <div className={muted ? "markdown-body text-sm leading-6 text-muted-foreground" : "markdown-body text-sm leading-6"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { children, className } = props;
            const inline = !className;
            if (inline) {
              return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">{children}</code>;
            }
            return (
              <pre className="overflow-auto rounded-md border border-border bg-background/70 p-3">
                <code className={className}>{children}</code>
              </pre>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function DiffViewer({ text }: { text: string }) {
  const sections = parseDiffSections(text);

  return (
    <div className="divide-y divide-border">
      {sections.map((section, index) => (
        <div key={`${section.path}-${index}`} className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium">
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            <span className="truncate">{section.path || `Change ${index + 1}`}</span>
          </div>
          <div className="font-mono text-xs leading-5">
            {section.lines.map((line, lineIndex) => (
              <div
                key={`${section.path}-${lineIndex}`}
                className={getDiffLineClassName(line)}
              >
                <span className="select-none pr-3 text-[10px] text-muted-foreground/70">
                  {lineIndex + 1}
                </span>
                <span className="whitespace-pre-wrap break-words">{line || " "}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function InlineSelect({
  value,
  onValueChange,
  options,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className="h-6 w-auto shrink-0 gap-1 border-0 bg-transparent px-1.5 text-[12px] font-medium text-foreground shadow-none ring-0 outline-none hover:bg-transparent focus:ring-0 focus:ring-offset-0 data-[placeholder]:text-muted-foreground">
        <SelectValue placeholder="Select" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TypingPlaceholder() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle className="h-4 w-4 animate-spin" />
      <span>Thinking</span>
    </div>
  );
}

function StatusBadge({ connectionState }: { connectionState: "connecting" | "open" | "closed" | "error" }) {
  if (connectionState === "open") {
    return (
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Circle className="h-3.5 w-3.5 fill-emerald-500 text-emerald-500" />
        <span className="hidden sm:inline">control</span>
      </div>
    );
  }
  if (connectionState === "connecting") {
    return (
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        <span className="hidden sm:inline">connecting</span>
      </div>
    );
  }
  if (connectionState === "error") {
    return (
      <div className="flex items-center gap-1 text-xs text-red-400">
        <AlertCircle className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">error</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <Unplug className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">closed</span>
    </div>
  );
}

function getActivity(
  session: SessionDetails | null,
  pending?: {
    creatingSession?: boolean;
    restoringHistory?: boolean;
    sessionLoading?: boolean;
    sendingMessage?: boolean;
  },
): ActivityState | null {
  if (pending?.restoringHistory) {
    return { label: "restoring", variant: "warning" };
  }
  if (pending?.creatingSession) {
    return { label: "starting", variant: "default" };
  }
  if (pending?.sessionLoading) {
    return { label: "loading", variant: "default" };
  }
  if (pending?.sendingMessage) {
    return { label: "sending", variant: "default" };
  }
  if (!session) {
    return null;
  }
  const transcript = session.transcript || [];
  const reasoning = [...transcript]
    .reverse()
    .find((entry) => entry.kind === "reasoning" && entry.status === "streaming");
  if (reasoning) {
    return { label: "thinking", variant: "warning" };
  }
  const approval = [...transcript]
    .reverse()
    .find((entry) => entry.kind === "approval" && entry.status === "pending");
  if (approval) {
    return { label: "approval", variant: "warning" };
  }
  const assistant = [...transcript]
    .reverse()
    .find((entry) => entry.kind === "assistant" && entry.status === "streaming");
  if (assistant) {
    return { label: "replying", variant: "default" };
  }
  if (session.status === "running") {
    return { label: "running", variant: "default" };
  }
  if (session.status === "failed") {
    return { label: "failed", variant: "destructive" };
  }
  return null;
}

function isBusyActivity(activity: ActivityState) {
  return ["restoring", "starting", "loading", "sending", "thinking", "replying", "running"].includes(
    activity.label,
  );
}

function isTurnBusy(session: SessionDetails | null, sendingMessage: boolean) {
  if (sendingMessage) {
    return true;
  }
  if (!session) {
    return false;
  }
  return session.status === "running";
}

function variantForEntry(entry: TranscriptEntry): "default" | "outline" | "warning" | "destructive" | "success" {
  switch (entry.kind) {
    case "assistant":
      return "default";
    case "reasoning":
      return "warning";
    case "approval":
      return entry.status === "approved" ? "success" : entry.status === "declined" ? "destructive" : "warning";
    case "system":
      return entry.status === "failed" ? "destructive" : "outline";
    case "user":
      return "success";
    default:
      return "outline";
  }
}

function isChatBubble(entry: TranscriptEntry) {
  return entry.kind === "user" || entry.kind === "assistant";
}

function getEntryMetaBadges(entry: TranscriptEntry): Array<{
  label: string;
  variant: "default" | "outline" | "warning" | "destructive" | "success";
}> {
  const badges: Array<{
    label: string;
    variant: "default" | "outline" | "warning" | "destructive" | "success";
  }> = [];

  if (entry.kind === "reasoning") {
    if (entry.status && entry.status !== "completed") {
      badges.push({ label: entry.status, variant: "outline" });
    }
    return badges;
  }

  if (entry.kind === "approval" && entry.status) {
    badges.push({
      label: entry.status,
      variant:
        entry.status === "approved"
          ? "success"
          : entry.status === "declined"
            ? "destructive"
            : "warning",
    });
    return badges;
  }

  if (!isChatBubble(entry) && entry.status) {
    badges.push({
      label: entry.status,
      variant: entry.status === "failed" ? "destructive" : "outline",
    });
  }

  if (!isChatBubble(entry) && entry.phase && entry.phase !== "final_answer") {
    badges.push({ label: entry.phase, variant: "outline" });
  }

  return badges;
}

function getBubbleClassName(entry: TranscriptEntry) {
  if (entry.kind === "user") {
    return "inline-block w-fit max-w-[min(82%,880px)] rounded-2xl rounded-br-md border border-primary/20 bg-primary text-primary-foreground px-4 py-3 shadow-sm";
  }
  if (entry.kind === "assistant") {
    return "inline-block w-fit max-w-[min(82%,880px)] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 shadow-sm";
  }
  if (entry.kind === "reasoning") {
    return "inline-block w-fit max-w-[min(82%,880px)] rounded-2xl rounded-bl-md border border-amber-500/20 bg-amber-500/6 px-4 py-3 shadow-sm";
  }
  if (entry.kind === "approval") {
    return "w-full max-w-full rounded-xl border border-amber-500/30 bg-amber-500/6 px-3 py-3 shadow-sm";
  }
  if (entry.kind === "system") {
    return "w-full max-w-full rounded-xl border border-border bg-muted/40 px-3 py-2 shadow-sm";
  }
  if (entry.kind === "file_change") {
    return "w-full max-w-full rounded-xl border border-border bg-card px-2.5 py-2 shadow-sm";
  }
  return "w-full max-w-full rounded-xl border border-border bg-card px-3 py-3 shadow-sm";
}

function getBubbleRowClassName(entry: TranscriptEntry) {
  if (entry.kind === "user") {
    return "justify-end";
  }
  if (entry.kind === "assistant" || entry.kind === "reasoning") {
    return "justify-start";
  }
  return "justify-start";
}

function getSessionOverviewActivity(session: SessionSummary, details?: SessionDetails): ActivityState | null {
  const detailActivity = details ? getActivity(details) : null;
  if (detailActivity) {
    return detailActivity;
  }
  if (session.status === "failed") {
    return { label: "failed", variant: "destructive" };
  }
  if (session.status === "running" || session.status === "starting") {
    return { label: session.status, variant: "default" };
  }
  if (session.status === "interrupted") {
    return { label: "interrupted", variant: "warning" };
  }
  return null;
}

function getOverviewPreviewEntries(details?: SessionDetails) {
  if (!details?.transcript?.length) {
    return [];
  }
  const selected: TranscriptEntry[] = [];
  let textBudget = 520;
  for (let index = details.transcript.length - 1; index >= 0; index -= 1) {
    const entry = details.transcript[index];
    if (!entry) {
      continue;
    }
    const previewText = getOverviewEntryPreviewText(entry);
    const cost = Math.max(40, previewText.length);
    if (selected.length && textBudget - cost < 0) {
      break;
    }
    selected.unshift(entry);
    textBudget -= cost;
    if (selected.length >= 6) {
      break;
    }
  }
  return selected;
}

function getOverviewEntryLabel(entry: TranscriptEntry) {
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

function getOverviewEntryPreviewText(entry: TranscriptEntry) {
  if (entry.kind === "assistant" && entry.status === "streaming" && !entry.text.trim()) {
    return "Thinking…";
  }
  if (entry.kind === "approval") {
    const approvalKind = typeof entry.meta?.approvalKind === "string" ? entry.meta.approvalKind : "approval";
    return approvalKind;
  }
  if (entry.kind === "tool" || entry.kind === "command" || entry.kind === "file_change") {
    return lastLines(entry.text, 6) || `${getOverviewEntryLabel(entry)} output`;
  }
  const collapsed = String(entry.text || "")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed || getOverviewEntryLabel(entry);
}

function getProjectFileIcon(filePath: string) {
  const extension = pathLikeExtension(filePath);
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(extension)) {
    return <FileImage className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  if (
    [
      "ts",
      "tsx",
      "js",
      "jsx",
      "json",
      "css",
      "html",
      "md",
      "py",
      "rs",
      "go",
      "java",
      "c",
      "cpp",
      "h",
      "hpp",
      "yml",
      "yaml",
      "toml",
      "sh",
      "ps1",
    ].includes(extension)
  ) {
    return <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  return <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

function pathLikeExtension(filePath: string) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const lastSegment = normalized.split("/").pop() || "";
  const parts = lastSegment.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
}

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function parseDiffSections(text: string) {
  const lines = String(text || "").split(/\r?\n/);
  const sections: Array<{ path: string; lines: string[] }> = [];
  let current: { path: string; lines: string[] } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = {
        path: match?.[2] || match?.[1] || line,
        lines: [line],
      };
      sections.push(current);
      continue;
    }

    if (!current) {
      const nextLine = lines[index + 1] ?? "";
      if (line && !isDiffLine(line) && (isDiffLine(nextLine) || nextLine.startsWith("diff --git "))) {
        current = { path: line, lines: [] };
        sections.push(current);
        continue;
      }
      current = { path: "output", lines: [] };
      sections.push(current);
    }

    current.lines.push(line);
  }

  return sections.filter((section) => section.lines.length || section.path);
}

function isDiffLine(line: string) {
  return (
    line.startsWith("@@") ||
    line.startsWith("+") ||
    line.startsWith("-") ||
    line.startsWith(" ") ||
    line.startsWith("---") ||
    line.startsWith("+++") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode") ||
    line.startsWith("deleted file mode")
  );
}

function getDiffLineClassName(line: string) {
  if (line.startsWith("@@")) {
    return "grid grid-cols-[auto_1fr] gap-0 border-b border-border/60 bg-blue-500/8 px-3 py-1 text-blue-700 dark:text-blue-300";
  }
  if (line.startsWith("+++")) {
    return "grid grid-cols-[auto_1fr] gap-0 bg-emerald-500/10 px-3 py-1 text-emerald-800 dark:text-emerald-300";
  }
  if (line.startsWith("---")) {
    return "grid grid-cols-[auto_1fr] gap-0 bg-rose-500/10 px-3 py-1 text-rose-800 dark:text-rose-300";
  }
  if (line.startsWith("+")) {
    return "grid grid-cols-[auto_1fr] gap-0 bg-emerald-500/8 px-3 py-1 text-emerald-800 dark:text-emerald-200";
  }
  if (line.startsWith("-")) {
    return "grid grid-cols-[auto_1fr] gap-0 bg-rose-500/8 px-3 py-1 text-rose-800 dark:text-rose-200";
  }
  return "grid grid-cols-[auto_1fr] gap-0 px-3 py-1 text-foreground/90";
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
  const index = current.findIndex((item) => item.id === session.id);
  if (index === -1) {
    return [session, ...current].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const next = [...current];
  next[index] = { ...next[index], ...session };
  return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

function groupHistoryByDay(history: CodexHistoryEntry[]) {
  const grouped: Array<
    | { type: "separator"; key: string; label: string }
    | { type: "item"; entry: CodexHistoryEntry }
  > = [];
  let currentDay = "";

  for (const entry of history) {
    const dateKey = formatHistoryDayKey(entry.updatedAt || entry.createdAt);
    if (dateKey !== currentDay) {
      currentDay = dateKey;
      grouped.push({
        type: "separator",
        key: `separator-${dateKey}`,
        label: formatHistoryDayLabel(entry.updatedAt || entry.createdAt),
      });
    }
    grouped.push({ type: "item", entry });
  }

  return grouped;
}

function formatHistoryDayKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function formatHistoryDayLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
}

function loadWorkspaceState(): WorkspaceStore {
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) {
      return createDefaultWorkspaceStore();
    }
    const parsed = JSON.parse(raw) as Partial<WorkspaceStore>;
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
          .map((workspace) => ({
            id: typeof workspace?.id === "string" ? workspace.id : createWorkspaceId(),
            sessionKeys: Array.isArray(workspace?.sessionKeys)
              ? workspace.sessionKeys.filter((item): item is string => typeof item === "string")
              : [],
            activeSessionKey: typeof workspace?.activeSessionKey === "string" ? workspace.activeSessionKey : null,
          }))
          .filter((workspace) => workspace.id)
      : [];
    if (!workspaces.length) {
      return createDefaultWorkspaceStore();
    }
    const activeWorkspaceId =
      typeof parsed.activeWorkspaceId === "string" &&
      workspaces.some((workspace) => workspace.id === parsed.activeWorkspaceId)
        ? parsed.activeWorkspaceId
        : workspaces[0].id;
    return { activeWorkspaceId, workspaces };
  } catch {
    return createDefaultWorkspaceStore();
  }
}

function createDefaultWorkspaceStore(): WorkspaceStore {
  const workspaces = Array.from({ length: 3 }, () => ({
    id: createWorkspaceId(),
    sessionKeys: [],
    activeSessionKey: null,
  }));
  return {
    activeWorkspaceId: workspaces[0].id,
    workspaces,
  };
}

function createWorkspaceId() {
  return `ws-${Math.random().toString(36).slice(2, 10)}`;
}

function makeSessionKey(daemonId: string, sessionId: string) {
  return `${daemonId}::${sessionId}`;
}

function parseSessionId(sessionKey: string | null | undefined, daemonId: string) {
  if (!sessionKey) {
    return null;
  }
  const prefix = `${daemonId}::`;
  return sessionKey.startsWith(prefix) ? sessionKey.slice(prefix.length) : null;
}

function syncWorkspaceStoreWithSessions(
  state: WorkspaceStore,
  daemonId: string,
  sessionIds: string[],
) {
  const validKeys = new Set(sessionIds.map((sessionId) => makeSessionKey(daemonId, sessionId)));
  const assignedKeys = new Set<string>();
  const activeWorkspaceId =
    state.workspaces.some((workspace) => workspace.id === state.activeWorkspaceId)
      ? state.activeWorkspaceId
      : state.workspaces[0]?.id ?? createWorkspaceId();

  const workspaces = state.workspaces.length ? state.workspaces : createDefaultWorkspaceStore().workspaces;
  const nextWorkspaces = workspaces.map((workspace) => {
    const sessionKeys = workspace.sessionKeys.filter((key) => {
      if (!key.startsWith(`${daemonId}::`)) {
        assignedKeys.add(key);
        return true;
      }
      if (validKeys.has(key)) {
        assignedKeys.add(key);
        return true;
      }
      return false;
    });
    const activeSessionKey =
      workspace.activeSessionKey && sessionKeys.includes(workspace.activeSessionKey)
        ? workspace.activeSessionKey
        : null;
    return { ...workspace, sessionKeys, activeSessionKey };
  });

  const unassignedKeys = [...validKeys].filter((key) => !assignedKeys.has(key));
  if (unassignedKeys.length) {
    const targetWorkspace =
      nextWorkspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? nextWorkspaces[0];
    if (targetWorkspace) {
      targetWorkspace.sessionKeys = [...targetWorkspace.sessionKeys, ...unassignedKeys];
      if (!targetWorkspace.activeSessionKey) {
        targetWorkspace.activeSessionKey = unassignedKeys[0] ?? null;
      }
    }
  }

  return {
    activeWorkspaceId,
    workspaces: nextWorkspaces,
  };
}

function addSessionToWorkspace(
  state: WorkspaceStore,
  workspaceId: string,
  daemonId: string,
  sessionId: string,
) {
  const sessionKey = makeSessionKey(daemonId, sessionId);
  return {
    ...state,
    activeWorkspaceId: workspaceId,
    workspaces: state.workspaces.map((workspace) => {
      const nextKeys = workspace.sessionKeys.filter((key) => key !== sessionKey);
      if (workspace.id !== workspaceId) {
        return {
          ...workspace,
          sessionKeys: nextKeys,
          activeSessionKey: workspace.activeSessionKey === sessionKey ? null : workspace.activeSessionKey,
        };
      }
      return {
        ...workspace,
        sessionKeys: [...nextKeys, sessionKey],
        activeSessionKey: sessionKey,
      };
    }),
  };
}

function setWorkspaceActiveSession(
  state: WorkspaceStore,
  workspaceId: string,
  daemonId: string,
  sessionId: string,
) {
  const sessionKey = makeSessionKey(daemonId, sessionId);
  return {
    ...state,
    workspaces: state.workspaces.map((workspace) =>
      workspace.id === workspaceId
        ? {
            ...workspace,
            sessionKeys: workspace.sessionKeys.includes(sessionKey)
              ? workspace.sessionKeys
              : [...workspace.sessionKeys, sessionKey],
            activeSessionKey: sessionKey,
          }
        : workspace,
    ),
  };
}

function createWorkspace(state: WorkspaceStore) {
  const workspace = {
    id: createWorkspaceId(),
    sessionKeys: [],
    activeSessionKey: null,
  };
  return {
    activeWorkspaceId: workspace.id,
    workspaces: [...state.workspaces, workspace],
  };
}

function deleteActiveWorkspace(state: WorkspaceStore) {
  if (state.workspaces.length <= 1) {
    return state;
  }
  const index = state.workspaces.findIndex((workspace) => workspace.id === state.activeWorkspaceId);
  if (index === -1) {
    return state;
  }
  const nextWorkspaces = state.workspaces.filter((workspace) => workspace.id !== state.activeWorkspaceId);
  const nextActive =
    nextWorkspaces[Math.max(0, index - 1)]?.id ?? nextWorkspaces[0]?.id ?? state.activeWorkspaceId;
  return {
    activeWorkspaceId: nextActive,
    workspaces: nextWorkspaces,
  };
}

function normalizeBaseUrl(value: string) {
  const normalized = value.trim() || DEFAULT_CONTROL_URL;
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function toWsUrl(value: string) {
  const url = new URL(normalizeBaseUrl(value));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
}

function estimateEntryHeight(row: ChatTranscriptRow | undefined) {
  if (!row) {
    return 80;
  }

  const reasoningText = getAttachedReasoningText(row.reasoning);
  const reasoningLines = reasoningText ? Math.min(String(reasoningText).split(/\r?\n/).length, row.reasoning?.status === "streaming" ? 18 : 1) : 0;
  const lines = String(row.entry.text || "").split(/\r?\n/).length;
  const previewLines =
    row.entry.kind === "tool" || row.entry.kind === "command" || row.entry.kind === "file_change"
      ? Math.min(lines, TOOL_LINE_LIMIT)
      : row.entry.kind === "assistant" || row.entry.kind === "user"
        ? Math.min(lines + 1, 24)
        : Math.min(lines, 16);

  return Math.max(88, 56 + previewLines * 20 + reasoningLines * 20);
}

export default App;
