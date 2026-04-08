import {
  Suspense,
  lazy,
  type PointerEvent as ReactPointerEvent,
  type UIEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Circle,
  Edit3,
  Folder,
  FolderOpen,
  GripHorizontal,
  History,
  LayoutGrid,
  LoaderCircle,
  MessageSquareText,
  Moon,
  PanelLeftOpen,
  Play,
  Plus,
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
  SessionPreviewEntry,
  SessionTranscriptPage,
  SessionSummary,
  TranscriptEntry,
} from "@/lib/types";
import { formatDateTime, formatDurationMs, formatTime, lastLines } from "@/lib/utils";

const DEFAULT_CONTROL_URL = import.meta.env.VITE_CONTROL_SERVER_URL || window.location.origin;
const WORKSPACE_STORAGE_KEY = "ohmyvibe-workspaces";
const OVERVIEW_LAYOUT_STORAGE_KEY = "ohmyvibe-overview-layouts";
const TOOL_LINE_LIMIT = 30;
const TRANSCRIPT_INITIAL_COUNT = 80;
const TRANSCRIPT_CHUNK_SIZE = 60;
const OVERVIEW_CARD_WIDTH = 336;
const OVERVIEW_CARD_HEIGHT = 280;
const OVERVIEW_CARD_GAP = 20;
const MarkdownBodyLazy = lazy(() => import("./components/chat/MarkdownBody"));
const DiffViewerLazy = lazy(() => import("./components/chat/DiffViewer"));
const FilePaneLazy = lazy(() => import("./components/session/FilePane"));

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

interface ChatTranscriptMeta {
  rowCount: number;
  lastRow?: ChatTranscriptRow;
}

interface ChatTranscriptMetaCache extends ChatTranscriptMeta {
  transcript: TranscriptEntry[];
  rowCounts: number[];
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
type OverviewCardLayout = { x: number; y: number; width: number; height: number };
type OverviewLayoutStore = Record<string, Record<string, OverviewCardLayout>>;

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
  const [overviewLayouts, setOverviewLayouts] = useState<OverviewLayoutStore>(() => loadOverviewLayouts());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionDetails | null>(null);
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
  const [loadingOlderTranscript, setLoadingOlderTranscript] = useState(false);
  const [pendingAssistant, setPendingAssistant] = useState<PendingAssistantState | null>(null);
  const [composer, setComposer] = useState("");
  const [cwd, setCwd] = useState("C:\\");
  const [directoryBrowser, setDirectoryBrowser] = useState<DirectoryBrowseResult | null>(null);
  const [directoryBrowserLoading, setDirectoryBrowserLoading] = useState(false);
  const [directoryBrowserPath, setDirectoryBrowserPath] = useState("");
  const [projectFiles, setProjectFiles] = useState<ProjectFileBrowseResult | null>(null);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<ProjectFileReadResult | null>(null);
  const [selectedFileLoading, setSelectedFileLoading] = useState(false);
  const [fileEditorValue, setFileEditorValue] = useState("");
  const [fileSelectionText, setFileSelectionText] = useState("");
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
  const overviewScrollRef = useRef<HTMLDivElement | null>(null);
  const prependPendingRef = useRef<{ previousHeight: number; previousTop: number } | null>(null);
  const stickToBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const activeDaemonIdRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const chatTranscriptMetaCacheRef = useRef<ChatTranscriptMetaCache>({
    transcript: [],
    rowCounts: [],
    rowCount: 0,
  });
  const latestSubscriptionRef = useRef<{ daemonId: string | null; sessionId: string | null }>({
    daemonId: null,
    sessionId: null,
  });
  const queuedActiveSessionEventsRef = useRef<DaemonEvent[]>([]);
  const queuedActiveSessionFlushRef = useRef<number | null>(null);
  const loadSessionRequestIdRef = useRef(0);
  const loadOlderTranscriptRequestIdRef = useRef(0);
  const overviewDragRef = useRef<{
    sessionId: string;
    key: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const subscribedSessionId = viewMode === "chat" ? activeSessionId : null;

  const flushQueuedActiveSessionEvents = () => {
    const queuedEvents = queuedActiveSessionEventsRef.current;
    queuedActiveSessionEventsRef.current = [];
    if (queuedActiveSessionFlushRef.current !== null) {
      window.clearTimeout(queuedActiveSessionFlushRef.current);
      queuedActiveSessionFlushRef.current = null;
    }
    if (!queuedEvents.length) {
      return;
    }
    setActiveSession((current) => applyQueuedActiveSessionEvents(current, queuedEvents));
  };

  const queueActiveSessionEvent = (event: DaemonEvent) => {
    if (!("sessionId" in event) || event.sessionId !== activeSessionIdRef.current) {
      return;
    }

    queuedActiveSessionEventsRef.current.push(event);
    if (queuedActiveSessionFlushRef.current !== null) {
      return;
    }

    queuedActiveSessionFlushRef.current = window.setTimeout(() => {
      flushQueuedActiveSessionEvents();
    }, 32);
  };

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("ohmyvibe-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspaceState));
  }, [workspaceState]);

  useEffect(() => {
    localStorage.setItem(OVERVIEW_LAYOUT_STORAGE_KEY, JSON.stringify(overviewLayouts));
  }, [overviewLayouts]);

  useEffect(() => {
    let disposed = false;
    const ws = new WebSocket(toWsUrl(controlUrl));
    wsRef.current = ws;
    setConnectionState("connecting");

    ws.onopen = () => {
      if (!disposed) {
        setConnectionState("open");
        sendClientSubscription(ws, latestSubscriptionRef.current);
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
        | { type: "daemon-event"; daemonId: string; event: DaemonEvent }
        | { type: "daemon-events"; daemonId: string; events: DaemonEvent[] };

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

      const incomingEvents =
        payload.type === "daemon-event"
          ? [payload.event]
          : payload.type === "daemon-events"
            ? payload.events
            : null;

      if (incomingEvents) {
        for (const event of incomingEvents) {
          if (event.type === "session-created" || event.type === "session-updated") {
            const session = normalizeSessionSummary(event.session);
            setSessions((current) => upsertSessionSummary(current, session));
            setActiveSession((current) =>
              current && current.id === session.id ? { ...current, ...session } : current,
            );
            continue;
          }

          if (event.type === "session-deleted") {
            setSessions((current) => current.filter((session) => session.id !== event.sessionId));
            setActiveSession((current) => (current?.id === event.sessionId ? null : current));
            setActiveSessionId((current) => (current === event.sessionId ? null : current));
            continue;
          }

          if (event.type === "session-entry") {
            queueActiveSessionEvent(event);
            continue;
          }

          if (event.type === "session-entry-updated") {
            queueActiveSessionEvent(event);
            continue;
          }

          if (event.type === "session-entries-updated") {
            queueActiveSessionEvent(event);
            continue;
          }

          if (event.type === "session-reset") {
            queueActiveSessionEvent(event);
          }
        }
      }
    };

    return () => {
      disposed = true;
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      ws.close();
    };
  }, [controlUrl]);

  useEffect(() => {
    activeDaemonIdRef.current = activeDaemonId;
  }, [activeDaemonId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    queuedActiveSessionEventsRef.current = [];
    if (queuedActiveSessionFlushRef.current !== null) {
      window.clearTimeout(queuedActiveSessionFlushRef.current);
      queuedActiveSessionFlushRef.current = null;
    }
  }, [activeSessionId]);

  useEffect(() => {
    return () => {
      if (queuedActiveSessionFlushRef.current !== null) {
        window.clearTimeout(queuedActiveSessionFlushRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const nextSubscription = {
      daemonId: activeDaemonId,
      sessionId: subscribedSessionId,
    };
    latestSubscriptionRef.current = nextSubscription;
    sendClientSubscription(wsRef.current, nextSubscription);
  }, [activeDaemonId, subscribedSessionId]);

  useEffect(() => {
    if (!activeDaemonId) {
      setConfig({ models: [] });
      setSessions([]);
      setActiveSession(null);
      setActiveSessionId(null);
      return;
    }
    void loadConfig(activeDaemonId);
    void loadSessions(activeDaemonId);
  }, [activeDaemonId]);

  useEffect(() => {
    if (!activeDaemonId || !activeSessionId || viewMode !== "chat") {
      return;
    }
    void loadSession(activeDaemonId, activeSessionId);
  }, [activeDaemonId, activeSessionId, viewMode]);

  useEffect(() => {
    loadOlderTranscriptRequestIdRef.current += 1;
    prependPendingRef.current = null;
    setLoadingOlderTranscript(false);
    setPendingAssistant(null);
    setSendingMessage(false);
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    chatTranscriptMetaCacheRef.current = {
      transcript: [],
      rowCounts: [],
      rowCount: 0,
    };
  }, [activeSessionId]);

  useEffect(() => {
    setProjectFiles(null);
    setSelectedFile(null);
    setFileEditorValue("");
    setFileSelectionText("");
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
  const chatTranscriptMeta = useMemo(() => {
    const nextCache = analyzeChatTranscript(displayTranscript, chatTranscriptMetaCacheRef.current);
    chatTranscriptMetaCacheRef.current = nextCache;
    return nextCache;
  }, [displayTranscript]);
  const visibleTranscript = useMemo(
    () => buildVisibleChatTranscriptRows(displayTranscript, chatTranscriptMeta.rowCount),
    [chatTranscriptMeta.rowCount, displayTranscript],
  );
  const hasOlderTranscript = activeSession?.hasMoreTranscriptBefore ?? false;
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
        .filter((session) => session.status !== "closed"),
    [visibleSessions],
  );
  const overviewLayoutKey = activeDaemonId && activeWorkspace ? `${activeDaemonId}:${activeWorkspace.id}` : "";
  const currentOverviewLayout = overviewLayoutKey ? overviewLayouts[overviewLayoutKey] ?? {} : {};
  const sortedHistory = useMemo(
    () =>
      [...history].sort(
        (a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""),
      ),
    [history],
  );
  const filteredHistory = useMemo(() => {
    const query = historySearch.trim().toLowerCase();
    if (!query) {
      return sortedHistory;
    }
    return sortedHistory.filter((item) =>
      [item.title, item.cwd, item.id, item.source, item.status]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }, [historySearch, sortedHistory]);
  const groupedHistory = useMemo(() => groupHistoryByDay(filteredHistory), [filteredHistory]);
  const lastEntrySignature = useMemo(() => {
    const lastEntry = displayTranscript[displayTranscript.length - 1];
    if (!lastEntry) {
      return "";
    }
    const lastRow = chatTranscriptMeta.lastRow;
    return `${lastEntry.id}:${lastEntry.text.length}:${lastEntry.status ?? ""}:${lastRow?.reasoning?.text.length ?? 0}`;
  }, [chatTranscriptMeta.lastRow, displayTranscript]);

  useEffect(() => {
    if (!overviewLayoutKey) {
      return;
    }
    setOverviewLayouts((current) =>
      ensureOverviewLayoutStore(current, overviewLayoutKey, overviewSessions.map((session) => session.id)),
    );
  }, [overviewLayoutKey, overviewSessions]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = overviewDragRef.current;
      if (!drag) {
        return;
      }
      const container = overviewScrollRef.current;
      const scrollLeft = container?.scrollLeft ?? 0;
      const scrollTop = container?.scrollTop ?? 0;
      const nextX = Math.max(
        12,
        Math.round(drag.originX + (event.clientX - drag.startX) + (scrollLeft - drag.scrollLeft)),
      );
      const nextY = Math.max(
        12,
        Math.round(drag.originY + (event.clientY - drag.startY) + (scrollTop - drag.scrollTop)),
      );
      setOverviewLayouts((current) => updateOverviewLayoutPosition(current, drag.key, drag.sessionId, nextX, nextY));
    };

    const handlePointerUp = () => {
      overviewDragRef.current = null;
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

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

  useEffect(() => {
    if (!activeSessionId) {
      setActiveSession(null);
      return;
    }

    setActiveSession((current) => (current?.id === activeSessionId ? current : null));
  }, [activeSessionId]);

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
    setSessions(nextSessions.map(normalizeSessionSummary));
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
      setFileSelectionText("");
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
      const session = normalizeSessionDetails(
        await api<SessionDetails>(`/api/daemons/${activeDaemonId}/sessions`, {
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
      const session = normalizeSessionDetails(
        await api<SessionDetails>(
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
        ),
      );
      setHistoryOpen(false);
      setActiveSessionId(session.id);
      setActiveSession(session);
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
    const selectedText = fileSelectionText.trim() ? fileSelectionText : fileEditorValue;
    const extension = pathLikeExtension(selectedFile.path);
    const quoted = `\n\n[${selectedFile.path}]\n\`\`\`${extension}\n${selectedText.trim()}\n\`\`\`\n`;
    setComposer((current) => `${current}${quoted}`.trimStart());
    setSessionPane("chat");
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
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
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

  function handleTranscriptScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const isNearBottom = distanceToBottom <= 64;
    stickToBottomRef.current = isNearBottom;
    setShowScrollToBottom(!isNearBottom);
    if (!hasOlderTranscript || loadingOlderTranscript || prependPendingRef.current || element.scrollTop > 120) {
      return;
    }
    prependPendingRef.current = {
      previousHeight: element.scrollHeight,
      previousTop: element.scrollTop,
    };
    void loadOlderTranscriptPage();
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
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="truncate text-sm font-medium">
                      {activeDaemon?.name || "No Daemon"}
                    </div>
                    {activeDaemon?.version ? (
                      <div className="shrink-0 text-[11px] text-muted-foreground">
                        v{activeDaemon.version}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {activeDaemon
                    ? `${overviewSessions.length} active sessions · ${activeDaemon.cwd}`
                    : "select daemon"}
                </div>
              </div>
            </div>
            <div ref={overviewScrollRef} className="min-h-0 overflow-auto bg-muted/10 px-4 py-4">
              {overviewSessions.length ? (
                <div
                  className="overview-canvas relative"
                  style={getOverviewCanvasStyle(currentOverviewLayout, overviewSessions)}
                >
                  {overviewSessions.map((session) => (
                    <OverviewSessionCard
                      key={session.id}
                      session={session}
                      details={activeSession?.id === session.id ? activeSession : undefined}
                      active={session.id === activeSessionId}
                      layout={currentOverviewLayout[session.id]}
                      onOpen={() => {
                        handleSelectSession(session.id);
                        setViewMode("chat");
                      }}
                      onDragStart={(event) => {
                        if (!overviewLayoutKey) {
                          return;
                        }
                        const layout = currentOverviewLayout[session.id] ?? getDefaultOverviewCardLayout(0);
                        overviewDragRef.current = {
                          sessionId: session.id,
                          key: overviewLayoutKey,
                          startX: event.clientX,
                          startY: event.clientY,
                          originX: layout.x,
                          originY: layout.y,
                          scrollLeft: overviewScrollRef.current?.scrollLeft ?? 0,
                          scrollTop: overviewScrollRef.current?.scrollTop ?? 0,
                        };
                        document.body.style.userSelect = "none";
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
            <aside
              className={[
                "ui-panel-motion absolute inset-y-0 left-0 z-30 grid min-h-0 w-[min(85vw,320px)] grid-rows-[40px_minmax(0,1fr)] bg-background shadow-2xl md:static md:z-auto md:w-[272px] md:bg-transparent md:shadow-none",
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
                <ScrollArea className="min-w-0">
                  <div className="min-w-0 space-y-1.5 p-2">
                    {visibleSessions.map((session) => (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => handleSelectSession(session.id)}
                        className={[
                          "ui-session-item grid min-w-0 w-full gap-1 overflow-hidden rounded-xl border px-2.5 py-2 text-left text-xs backdrop-blur-sm",
                          getSessionListCardClassName(session, activeSessionId === session.id),
                        ].join(" ")}
                      >
                        <div className={`ui-session-status-bar ${getSessionStatusAccentClassName(session)}`} />
                        <div className="flex min-w-0 items-start justify-between gap-2">
                          <div className="min-w-0 flex-1 line-clamp-2 text-[13px] font-medium leading-5">
                            {session.title}
                          </div>
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
                        <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${getSessionStatusDotClassName(session)}`} />
                          <span className="shrink-0">{formatSessionStatusLabel(session.status)}</span>
                          <span className="truncate">{formatDateTime(session.updatedAt)}</span>
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">{session.cwd}</div>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              ) : null}
            </aside>

            <main className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]">
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
                  <Suspense
                    fallback={
                      <div className="flex min-h-0 items-center justify-center bg-muted/10 p-4 text-sm text-muted-foreground">
                        <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                        Loading file pane
                      </div>
                    }
                  >
                    <FilePaneLazy
                      projectFiles={projectFiles}
                      projectFilesLoading={projectFilesLoading}
                      selectedFile={selectedFile}
                      selectedFileLoading={selectedFileLoading}
                      fileEditorValue={fileEditorValue}
                      savingFile={savingFile}
                      theme={theme}
                      onBrowseProjectPath={(value?: string) => void handleBrowseProjectPath(value)}
                      onOpenProjectFile={(filePath: string) => void handleOpenProjectFile(filePath)}
                      onQuoteFileSelection={handleQuoteFileSelection}
                      onSaveProjectFile={() => void handleSaveProjectFile()}
                      onFileEditorValueChange={setFileEditorValue}
                      onFileSelectionChange={setFileSelectionText}
                    />
                  </Suspense>
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
                              {loadingOlderTranscript ? "Loading older messages" : "Scroll top to load older messages"}
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
                    {showScrollToBottom && chatTranscriptMeta.rowCount ? (
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
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void handleSendMessage();
                        }
                      }}
                      placeholder="Message Codex or use /compact · Enter send · Shift+Enter newline"
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
  layout,
  onOpen,
  onDragStart,
}: {
  session: SessionSummary;
  details?: SessionDetails;
  active: boolean;
  layout?: OverviewCardLayout;
  onOpen: () => void;
  onDragStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const activity = getSessionOverviewActivity(session, details);
  const sessionPreviewEntries = Array.isArray(session.previewEntries) ? session.previewEntries : [];
  const previewEntries = sessionPreviewEntries.length
    ? sessionPreviewEntries
    : getOverviewPreviewEntries(details);
  const live = session.status === "running" || session.status === "starting";
  const liveBackgroundClassName = live ? getOverviewCardLiveClassName(session) : "";

  return (
    <div
      className={[
        "overview-card ui-overview-card absolute grid gap-2 overflow-hidden rounded-[20px] border px-3 py-3 text-left shadow-sm",
        getOverviewCardToneClassName(session, active),
      ].join(" ")}
      style={{
        width: layout?.width ?? OVERVIEW_CARD_WIDTH,
        minHeight: layout?.height ?? OVERVIEW_CARD_HEIGHT,
        left: layout?.x ?? 0,
        top: layout?.y ?? 0,
      }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-white/55 to-transparent opacity-70" />
      {live ? <div className={`pointer-events-none absolute inset-0 ui-overview-live-sheen ${liveBackgroundClassName}`} /> : null}
      <div className={`pointer-events-none absolute inset-0 opacity-80 ${getOverviewCardAuraClassName(session)}`} />

      <div className="relative grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <button type="button" className="min-w-0 pr-1 text-left" onClick={onOpen}>
          <div className="line-clamp-2 text-sm font-medium">{session.title}</div>
          <div className="mt-1 truncate text-[11px] text-muted-foreground">{session.cwd}</div>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {activity ? <Badge variant={activity.variant}>{activity.label}</Badge> : null}
          <button
            type="button"
            className="drag-handle flex h-7 w-7 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground"
            onPointerDown={onDragStart}
            aria-label="Drag overview card"
          >
            <GripHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="relative flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
        <Badge variant={session.origin === "restored" ? "warning" : "outline"}>{session.origin}</Badge>
        <span>{session.model || "default"}</span>
        <span>{session.reasoningEffort || "medium"}</span>
        <span>{formatDateTime(session.updatedAt)}</span>
      </div>

      <div className="relative grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-xl border border-white/8 bg-background/40 px-3 py-2">
        <span className={`h-2.5 w-2.5 rounded-full ${getSessionStatusDotClassName(session)} ${live ? "animate-pulse" : ""}`} />
        <div className="truncate text-[11px] text-muted-foreground">
          {formatSessionStatusLabel(session.status)} · {details?.transcriptCount ?? session.transcriptCount} entries
        </div>
        <button
          type="button"
          className="flex h-7 min-w-7 items-center justify-center rounded-md border border-border/70 bg-background/70 px-2 text-[11px]"
          onClick={onOpen}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {live ? <div className="ui-overview-progress" /> : null}

      <button
        type="button"
        className="relative grid min-h-0 max-h-[158px] gap-1 overflow-hidden rounded-xl border border-white/8 bg-background/35 p-2 text-left"
        onClick={onOpen}
      >
        {previewEntries.length ? (
          previewEntries.map((entry) => <OverviewEntryPreview key={entry.id} entry={entry} />)
        ) : (
          <div className="text-xs text-muted-foreground">No messages yet</div>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/25 to-transparent" />
      </button>
    </div>
  );
}

function OverviewEntryPreview({ entry }: { entry: TranscriptEntry | SessionPreviewEntry }) {
  const label = getOverviewEntryLabel(entry);
  const body = getOverviewEntryPreviewText(entry);

  return (
    <div className="grid gap-0.5 border-l border-white/12 pl-2 text-left">
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="uppercase tracking-[0.16em] text-foreground/55">{label}</span>
        <span>{formatTime(entry.createdAt)}</span>
      </div>
      <div className="line-clamp-3 whitespace-pre-wrap break-words text-[12px] leading-4.5 text-foreground/88">
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

function createReasoningHostRow(reasoning: TranscriptEntry): ChatTranscriptRow {
  return {
    id: `reasoning-host:${reasoning.id}`,
    entry: {
      id: `reasoning-host:${reasoning.id}`,
      kind: "assistant",
      text: "",
      createdAt: reasoning.createdAt,
      status: reasoning.status === "streaming" ? "streaming" : "completed",
    },
    reasoning,
  };
}

function createChatTranscriptRow(
  transcript: TranscriptEntry[],
  index: number,
): ChatTranscriptRow | undefined {
  const entry = transcript[index];
  if (!entry) {
    return undefined;
  }

  if (entry.kind === "reasoning") {
    const nextEntry = transcript[index + 1];
    if (nextEntry?.kind === "assistant" || nextEntry?.kind === "reasoning") {
      return undefined;
    }
    return createReasoningHostRow(entry);
  }

  if (entry.kind === "assistant") {
    const previousEntry = transcript[index - 1];
    const reasoning = previousEntry?.kind === "reasoning" ? previousEntry : undefined;
    return {
      id: entry.id,
      entry,
      reasoning,
    };
  }

  return {
    id: entry.id,
    entry,
  };
}

function findChatTranscriptRebuildStart(
  transcript: TranscriptEntry[],
  previousTranscript: TranscriptEntry[],
): number {
  const sharedLength = Math.min(transcript.length, previousTranscript.length);
  let rebuildStart = 0;

  while (rebuildStart < sharedLength && transcript[rebuildStart] === previousTranscript[rebuildStart]) {
    rebuildStart += 1;
  }

  if (rebuildStart === transcript.length && rebuildStart === previousTranscript.length) {
    return -1;
  }

  while (
    rebuildStart > 0 &&
    (transcript[rebuildStart - 1]?.kind === "reasoning" ||
      previousTranscript[rebuildStart - 1]?.kind === "reasoning")
  ) {
    rebuildStart -= 1;
  }

  return rebuildStart;
}

function analyzeChatTranscript(
  transcript: TranscriptEntry[],
  previous?: ChatTranscriptMetaCache,
): ChatTranscriptMetaCache {
  const rebuildStart =
    previous?.transcript?.length
      ? findChatTranscriptRebuildStart(transcript, previous.transcript)
      : 0;

  if (rebuildStart === -1 && previous) {
    return previous;
  }

  const rowCounts = rebuildStart > 0 && previous ? previous.rowCounts.slice(0, rebuildStart) : [];
  let rowCount = rebuildStart > 0 && previous ? (previous.rowCounts[rebuildStart - 1] ?? 0) : 0;
  let lastRow =
    rebuildStart > 0
      ? createChatTranscriptRow(transcript, rebuildStart - 1) ?? previous?.lastRow
      : undefined;
  let pendingReasoning: TranscriptEntry | undefined;
  let pendingReasoningIndex = -1;

  const flushReasoning = () => {
    if (!pendingReasoning || pendingReasoningIndex === -1) {
      return;
    }
    rowCount += 1;
    lastRow = createReasoningHostRow(pendingReasoning);
    rowCounts[pendingReasoningIndex] = rowCount;
    pendingReasoning = undefined;
    pendingReasoningIndex = -1;
  };

  for (let index = rebuildStart; index < transcript.length; index += 1) {
    const entry = transcript[index];
    if (!entry) {
      continue;
    }

    if (entry.kind === "reasoning") {
      pendingReasoning = entry;
      pendingReasoningIndex = index;
      rowCounts[index] = rowCount;
      continue;
    }

    if (entry.kind === "assistant") {
      rowCount += 1;
      lastRow = createChatTranscriptRow(transcript, index);
      pendingReasoning = undefined;
      pendingReasoningIndex = -1;
      rowCounts[index] = rowCount;
      continue;
    }

    if (pendingReasoning) {
      flushReasoning();
    }

    rowCount += 1;
    lastRow = createChatTranscriptRow(transcript, index);
    rowCounts[index] = rowCount;
  }

  if (pendingReasoning) {
    flushReasoning();
  }

  return {
    transcript,
    rowCounts,
    rowCount,
    lastRow,
  };
}

function buildVisibleChatTranscriptRows(
  transcript: TranscriptEntry[],
  visibleCount: number,
): ChatTranscriptRow[] {
  if (!visibleCount) {
    return [];
  }

  const reversedRows: ChatTranscriptRow[] = [];

  for (let index = transcript.length - 1; index >= 0 && reversedRows.length < visibleCount; index -= 1) {
    const entry = transcript[index];
    if (!entry) {
      continue;
    }

    if (entry.kind === "reasoning") {
      const row = createChatTranscriptRow(transcript, index);
      if (!row) {
        continue;
      }
      reversedRows.push(row);
      continue;
    }

    if (entry.kind === "assistant") {
      const row = createChatTranscriptRow(transcript, index);
      if (!row) {
        continue;
      }
      if (row.reasoning) {
        index -= 1;
      }
      reversedRows.push(row);
      continue;
    }

    reversedRows.push({
      id: entry.id,
      entry,
    });
  }

  return reversedRows.reverse();
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
    <Suspense
      fallback={
        <div className={muted ? "markdown-body text-sm leading-6 text-muted-foreground" : "markdown-body text-sm leading-6"}>
          {text}
        </div>
      }
    >
      <MarkdownBodyLazy text={text} muted={muted} />
    </Suspense>
  );
}

function DiffViewer({ text }: { text: string }) {
  return (
    <Suspense
      fallback={
        <pre className="overflow-auto p-3 font-mono text-xs leading-5 whitespace-pre-wrap">
          {text}
        </pre>
      }
    >
      <DiffViewerLazy text={text} />
    </Suspense>
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

function getOverviewEntryLabel(entry: TranscriptEntry | SessionPreviewEntry) {
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

function getOverviewEntryPreviewText(entry: TranscriptEntry | SessionPreviewEntry) {
  if ("previewText" in entry) {
    return entry.previewText;
  }
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

function formatSessionStatusLabel(status: SessionSummary["status"]) {
  switch (status) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    case "closed":
      return "Closed";
    default:
      return "Idle";
  }
}

function getSessionStatusAccentClassName(session: SessionSummary) {
  switch (session.status) {
    case "running":
      return "bg-linear-to-r from-sky-500/70 via-cyan-400/65 to-emerald-400/60";
    case "starting":
      return "bg-linear-to-r from-indigo-500/68 via-sky-400/62 to-cyan-300/58";
    case "completed":
      return "bg-linear-to-r from-emerald-500/68 via-lime-400/56 to-emerald-300/54";
    case "failed":
      return "bg-linear-to-r from-rose-600/68 via-red-500/62 to-orange-400/56";
    case "interrupted":
      return "bg-linear-to-r from-amber-500/68 via-orange-400/58 to-yellow-300/50";
    default:
      return "bg-linear-to-r from-zinc-500/44 via-zinc-400/34 to-zinc-300/18";
  }
}

function getSessionStatusDotClassName(session: SessionSummary) {
  switch (session.status) {
    case "running":
      return "bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.38)]";
    case "starting":
      return "bg-sky-400 shadow-[0_0_8px_rgba(96,165,250,0.38)]";
    case "completed":
      return "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.34)]";
    case "failed":
      return "bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.34)]";
    case "interrupted":
      return "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.34)]";
    default:
      return "bg-zinc-400";
  }
}

function getSessionListCardClassName(session: SessionSummary, active: boolean) {
  const base =
    session.status === "running"
      ? "border-cyan-500/18 bg-cyan-500/4 hover:bg-cyan-500/7"
      : session.status === "starting"
        ? "border-sky-500/16 bg-sky-500/4 hover:bg-sky-500/7"
        : session.status === "completed"
          ? "border-emerald-500/16 bg-emerald-500/4 hover:bg-emerald-500/7"
          : session.status === "failed"
            ? "border-rose-500/18 bg-rose-500/4 hover:bg-rose-500/7"
            : session.status === "interrupted"
              ? "border-amber-500/18 bg-amber-500/4 hover:bg-amber-500/7"
              : "border-border/80 bg-card/42 hover:bg-accent/34";
  return active ? `${base} ring-1 ring-foreground/12 shadow-[0_10px_24px_rgba(15,23,42,0.08)]` : base;
}

function getOverviewCardToneClassName(session: SessionSummary, active: boolean) {
  const base =
    session.status === "running"
      ? "border-cyan-300/16 bg-[linear-gradient(180deg,rgba(18,25,32,0.95),rgba(12,16,22,0.96))]"
      : session.status === "starting"
        ? "border-sky-300/16 bg-[linear-gradient(180deg,rgba(20,24,34,0.95),rgba(13,16,24,0.96))]"
        : session.status === "completed"
          ? "border-emerald-300/14 bg-[linear-gradient(180deg,rgba(20,26,24,0.95),rgba(13,17,16,0.96))]"
          : session.status === "failed"
            ? "border-rose-300/16 bg-[linear-gradient(180deg,rgba(33,21,24,0.95),rgba(19,13,15,0.96))]"
            : session.status === "interrupted"
              ? "border-amber-300/16 bg-[linear-gradient(180deg,rgba(33,27,20,0.95),rgba(19,15,12,0.96))]"
              : "border-border/80 bg-[linear-gradient(180deg,rgba(25,28,35,0.95),rgba(16,18,23,0.96))]";
  return `${base} ${active ? "ring-1 ring-white/10 shadow-[0_18px_44px_rgba(15,23,42,0.28)]" : "shadow-[0_12px_32px_rgba(2,6,23,0.18)]"}`;
}

function getOverviewCardAuraClassName(session: SessionSummary) {
  switch (session.status) {
    case "running":
      return "bg-[radial-gradient(circle_at_85%_18%,rgba(34,211,238,0.14),transparent_34%),radial-gradient(circle_at_20%_0%,rgba(59,130,246,0.08),transparent_28%)]";
    case "starting":
      return "bg-[radial-gradient(circle_at_82%_16%,rgba(96,165,250,0.14),transparent_34%),radial-gradient(circle_at_12%_8%,rgba(129,140,248,0.09),transparent_26%)]";
    case "completed":
      return "bg-[radial-gradient(circle_at_84%_18%,rgba(52,211,153,0.1),transparent_32%),radial-gradient(circle_at_18%_10%,rgba(163,230,53,0.06),transparent_24%)]";
    case "failed":
      return "bg-[radial-gradient(circle_at_85%_18%,rgba(251,113,133,0.12),transparent_34%),radial-gradient(circle_at_12%_10%,rgba(248,113,113,0.08),transparent_24%)]";
    case "interrupted":
      return "bg-[radial-gradient(circle_at_85%_18%,rgba(251,191,36,0.12),transparent_34%),radial-gradient(circle_at_10%_10%,rgba(249,115,22,0.08),transparent_24%)]";
    default:
      return "bg-[radial-gradient(circle_at_85%_18%,rgba(255,255,255,0.04),transparent_34%)]";
  }
}

function getOverviewCardLiveClassName(session: SessionSummary) {
  return session.status === "starting"
    ? "bg-[linear-gradient(120deg,rgba(99,102,241,0.08),rgba(56,189,248,0.14),rgba(148,163,184,0.05),rgba(99,102,241,0.08))]"
    : "bg-[linear-gradient(120deg,rgba(34,197,94,0.05),rgba(34,211,238,0.16),rgba(59,130,246,0.08),rgba(34,197,94,0.05))]";
}

function loadOverviewLayouts(): OverviewLayoutStore {
  try {
    const raw = localStorage.getItem(OVERVIEW_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as OverviewLayoutStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function ensureOverviewLayoutStore(
  store: OverviewLayoutStore,
  key: string,
  sessionIds: string[],
) {
  const current = store[key] ?? {};
  let changed = !store[key];
  const next = { ...current };
  sessionIds.forEach((sessionId, index) => {
    if (!next[sessionId]) {
      next[sessionId] = getDefaultOverviewCardLayout(index);
      changed = true;
    }
  });
  for (const sessionId of Object.keys(next)) {
    if (!sessionIds.includes(sessionId)) {
      delete next[sessionId];
      changed = true;
    }
  }
  if (!changed) {
    return store;
  }
  return {
    ...store,
    [key]: next,
  };
}

function getDefaultOverviewCardLayout(index: number): OverviewCardLayout {
  const column = index % 4;
  const row = Math.floor(index / 4);
  return {
    x: 20 + column * (OVERVIEW_CARD_WIDTH + OVERVIEW_CARD_GAP),
    y: 20 + row * (OVERVIEW_CARD_HEIGHT + OVERVIEW_CARD_GAP),
    width: OVERVIEW_CARD_WIDTH,
    height: OVERVIEW_CARD_HEIGHT,
  };
}

function updateOverviewLayoutPosition(
  store: OverviewLayoutStore,
  key: string,
  sessionId: string,
  x: number,
  y: number,
) {
  const current = store[key] ?? {};
  const layout = current[sessionId] ?? getDefaultOverviewCardLayout(0);
  return {
    ...store,
    [key]: {
      ...current,
      [sessionId]: {
        ...layout,
        x,
        y,
      },
    },
  };
}

function getOverviewCanvasStyle(
  layoutStore: Record<string, OverviewCardLayout>,
  sessions: SessionSummary[],
) {
  const layouts = sessions.map((session, index) => layoutStore[session.id] ?? getDefaultOverviewCardLayout(index));
  const width = Math.max(
    960,
    ...layouts.map((layout) => layout.x + layout.width + OVERVIEW_CARD_GAP),
  );
  const height = Math.max(
    520,
    ...layouts.map((layout) => layout.y + layout.height + OVERVIEW_CARD_GAP),
  );
  return {
    width,
    height,
  };
}

function pathLikeExtension(filePath: string) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const lastSegment = normalized.split("/").pop() || "";
  const parts = lastSegment.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
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

function sendClientSubscription(
  socket: WebSocket | null,
  subscription: { daemonId: string | null; sessionId: string | null },
) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(
    JSON.stringify({
      type: "client-subscribe",
      daemonId: subscription.daemonId,
      sessionId: subscription.sessionId,
    }),
  );
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
