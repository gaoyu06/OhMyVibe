import { type UIEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  Circle,
  GitCommitHorizontal,
  LoaderCircle,
  Moon,
  PanelLeftOpen,
  Play,
  Send,
  Square,
  Sun,
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
  SessionDetails,
  SessionSummary,
  TranscriptEntry,
} from "@/lib/types";
import { formatDateTime, formatTime, lastLines } from "@/lib/utils";

const DEFAULT_CONTROL_URL = import.meta.env.VITE_CONTROL_SERVER_URL || window.location.origin;
const TOOL_LINE_LIMIT = 30;
const TRANSCRIPT_INITIAL_COUNT = 80;
const TRANSCRIPT_CHUNK_SIZE = 60;

type ThemeMode = "light" | "dark";

interface ActivityState {
  label: string;
  variant: "default" | "warning" | "destructive" | "success";
}

const SANDBOX_OPTIONS = [
  { value: "danger-full-access", label: "Full Access" },
  { value: "workspace-write", label: "Workspace" },
  { value: "read-only", label: "Read Only" },
] as const;

function App() {
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionDetails | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [restoringHistoryId, setRestoringHistoryId] = useState<string | null>(null);
  const [loadedTranscriptCount, setLoadedTranscriptCount] = useState(TRANSCRIPT_INITIAL_COUNT);
  const [composer, setComposer] = useState("");
  const [cwd, setCwd] = useState("C:\\Code\\Projects\\OhMyVibe");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("medium");
  const [sandbox, setSandbox] = useState<"read-only" | "workspace-write" | "danger-full-access">(
    "danger-full-access",
  );
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const prependPendingRef = useRef<{ previousHeight: number; previousTop: number } | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("ohmyvibe-theme", theme);
  }, [theme]);

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
          setActiveSession((current) =>
            current && current.id === event.session.id ? { ...current, ...event.session } : current,
          );
          return;
        }
        if (event.type === "session-deleted") {
          setSessions((current) => current.filter((session) => session.id !== event.sessionId));
          setActiveSession((current) => (current?.id === event.sessionId ? null : current));
          setActiveSessionId((current) => (current === event.sessionId ? null : current));
          return;
        }
        if (event.type === "session-entry") {
          setActiveSession((current) => {
            if (!current || current.id !== event.sessionId) {
              return current;
            }
            const nextTranscript = [...current.transcript, event.entry];
            return { ...current, transcript: nextTranscript, transcriptCount: nextTranscript.length };
          });
          if (event.entry.kind === "reasoning" && event.entry.status === "streaming") {
            setExpanded((current) => new Set(current).add(event.entry.id));
          }
          return;
        }
        if (event.type === "session-reset") {
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
  }, [activeSessionId]);

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
  }, [activeSession?.id, activeSession?.model, activeSession?.reasoningEffort, activeSession?.sandbox]);

  const transcript = activeSession?.transcript ?? [];
  const transcriptStart = Math.max(0, transcript.length - loadedTranscriptCount);
  const visibleTranscript = useMemo(
    () => transcript.slice(transcriptStart),
    [transcript, transcriptStart],
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
  });
  const activeDaemon = daemons.find((item) => item.id === activeDaemonId) ?? null;

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
    setActiveSessionId((current) => current ?? nextSessions[0]?.id ?? null);
  }

  async function loadSession(daemonId: string, sessionId: string) {
    setSessionLoading(true);
    try {
      const session = await api<SessionDetails>(`/api/daemons/${daemonId}/sessions/${sessionId}`);
      setActiveSession(session);
      setExpanded((current) => {
        const next = new Set(current);
        for (const entry of session.transcript) {
          if (entry.kind === "reasoning" && entry.status === "streaming") {
            next.add(entry.id);
          }
        }
        return next;
      });
    } finally {
      setSessionLoading(false);
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
        }),
      });
      setActiveSessionId(session.id);
      setActiveSession(session);
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
          }),
        },
      );
      setHistoryOpen(false);
      setActiveSessionId(session.id);
      setActiveSession(session);
    } finally {
      setRestoringHistoryId(null);
    }
  }

  async function handleSendMessage() {
    if (!activeDaemonId || !activeSessionId || !composer.trim()) {
      return;
    }
    await api(`/api/daemons/${activeDaemonId}/sessions/${activeSessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: composer.trim() }),
    });
    setComposer("");
  }

  async function handleSessionConfigChange(next: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
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

  async function handleDelete() {
    if (!activeDaemonId || !activeSessionId) {
      return;
    }
    await api(`/api/daemons/${activeDaemonId}/sessions/${activeSessionId}`, {
      method: "DELETE",
    });
  }

  function handleTranscriptScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
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

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <div className="grid h-full grid-rows-[48px_minmax(0,1fr)]">
        <header className="grid grid-cols-[220px_1fr_auto] items-center gap-3 border-b border-border px-3">
          <div className="text-sm font-semibold tracking-tight">OhMyVibe</div>

          <div className="grid grid-cols-[280px] items-center gap-2">
            <Select value={activeDaemonId ?? ""} onValueChange={setActiveDaemonId}>
              <SelectTrigger>
                <SelectValue placeholder="Daemon" />
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

          <div className="flex items-center gap-2">
            <StatusBadge connectionState={connectionState} />
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
                <Button variant="outline" size="sm" disabled={!activeDaemonId}>
                  <PanelLeftOpen className="h-3.5 w-3.5" />
                  History
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>History</DialogTitle>
                  <DialogDescription>restore from daemon-bound Codex sessions</DialogDescription>
                </DialogHeader>
                <ScrollArea className="h-[calc(100vh-64px)]">
                  <div className="space-y-2 p-4">
                    {historyLoading ? (
                      <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                        Loading history
                      </div>
                    ) : null}
                    {history.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="grid w-full gap-1 rounded-md border border-border px-3 py-2 text-left text-xs hover:bg-accent/50 disabled:cursor-wait disabled:opacity-70"
                        onClick={() => void handleRestoreSession(item)}
                        disabled={Boolean(restoringHistoryId)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="line-clamp-2 text-sm font-medium">{item.title || item.id}</div>
                          {restoringHistoryId === item.id ? (
                            <LoaderCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
                          ) : null}
                        </div>
                        <div className="text-muted-foreground">{item.cwd}</div>
                        <div className="text-muted-foreground">
                          {formatDateTime(item.updatedAt)} · {item.source || "unknown"} · {restoringHistoryId === item.id ? "restoring" : item.status}
                        </div>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              </DialogContent>
            </Dialog>
            <Dialog open={newSessionOpen} onOpenChange={setNewSessionOpen}>
              <DialogTrigger asChild>
                <Button size="sm" disabled={!activeDaemonId}>
                  <Play className="h-3.5 w-3.5" />
                  New
                </Button>
              </DialogTrigger>
              <DialogContent className="top-1/2 right-1/2 h-auto max-w-[560px] translate-x-1/2 -translate-y-1/2 rounded-lg border">
                <DialogHeader>
                  <DialogTitle>New Session</DialogTitle>
                  <DialogDescription>cwd</DialogDescription>
                </DialogHeader>
                <div className="grid gap-3 p-4">
                  <Input
                    value={cwd}
                    onChange={(event) => setCwd(event.target.value)}
                    placeholder="Working directory"
                  />
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
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>
        </header>

        <div className="grid min-h-0 grid-cols-[280px_minmax(0,1fr)]">
          <aside className="grid min-h-0 grid-rows-[40px_minmax(0,1fr)] border-r border-border">
            <div className="flex items-center justify-between px-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">
              <span>Sessions</span>
              <Badge variant="outline">{sessions.length}</Badge>
            </div>
            <ScrollArea>
              <div className="space-y-1.5 p-2">
                {sessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => setActiveSessionId(session.id)}
                    className={[
                      "grid w-full gap-1 rounded-md border px-2.5 py-2 text-left text-xs transition-colors",
                      activeSessionId === session.id
                        ? "border-primary/40 bg-primary/10"
                        : "border-border hover:bg-accent/60",
                    ].join(" ")}
                  >
                    <div className="line-clamp-2 text-sm font-medium">{session.title}</div>
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Badge variant={session.origin === "restored" ? "warning" : "outline"}>
                        {session.origin}
                      </Badge>
                      <span>{session.model || "default"}</span>
                      <span>{session.reasoningEffort || "medium"}</span>
                    </div>
                    <div className="truncate text-muted-foreground">{session.cwd}</div>
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span>{session.status}</span>
                      <span>{formatDateTime(session.updatedAt)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </aside>

          <main className="grid min-h-0 grid-rows-[64px_minmax(0,1fr)_auto]">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{activeSession?.title || activeDaemon?.name || "No Session"}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {activeSession
                    ? `${activeSession.cwd} · ${activeSession.model || "default"} · ${activeSession.reasoningEffort || "medium"} · ${activeSession.codexThreadId || "pending"}`
                    : activeDaemon
                      ? `${activeDaemon.cwd} · ${activeDaemon.platform} · ${activeDaemon.id}`
                      : "select daemon"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {activeDaemon ? (
                  <Badge variant={activeDaemon.online ? "success" : "destructive"}>
                    {activeDaemon.online ? "online" : "offline"}
                  </Badge>
                ) : null}
                {activity ? <Badge variant={activity.variant}>{activity.label}</Badge> : null}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!activeDaemonId || !activeSessionId}
                  onClick={() => void handleInterrupt()}
                >
                  <Square className="h-3.5 w-3.5" />
                  Stop
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={!activeDaemonId || !activeSessionId}
                  onClick={() => void handleDelete()}
                >
                  Close
                </Button>
              </div>
            </div>

            <div
              ref={transcriptRef}
              className="min-h-0 overflow-auto bg-muted/10"
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
                    const entry = visibleTranscript[virtualRow.index];
                    if (!entry) {
                      return null;
                    }
                    return (
                      <div
                        key={entry.id}
                        data-index={virtualRow.index}
                        ref={(node) => {
                          if (node) {
                            rowVirtualizer.measureElement(node);
                          }
                        }}
                        className="absolute left-0 top-0 w-full px-3"
                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                      >
                        <TranscriptCard
                          entry={entry}
                          expanded={expanded.has(entry.id)}
                          onToggle={() =>
                            setExpanded((current) => {
                              const next = new Set(current);
                              if (next.has(entry.id)) {
                                next.delete(entry.id);
                              } else {
                                next.add(entry.id);
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
            </div>

            <div className="grid gap-1.5 border-t border-border p-3">
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
                className="min-h-[96px] max-h-[96px]"
              />
              <div className="flex items-center gap-1 overflow-x-auto">
                <InlineSelect
                  value={sandbox}
                  onValueChange={(value) => {
                    const nextValue = value as "read-only" | "workspace-write" | "danger-full-access";
                    setSandbox(nextValue);
                    void handleSessionConfigChange({ sandbox: nextValue });
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
                <div className="truncate pl-2 text-xs text-muted-foreground">
                  {activeSession ? activeSession.cwd : cwd}
                </div>
              </div>
              <div className="flex items-center justify-end gap-2">
                <div className="flex items-center gap-2">
                  {activity ? (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      {activity.label}
                    </div>
                  ) : null}
                  <Button
                    size="sm"
                    disabled={!activeDaemonId || !activeSessionId || !composer.trim()}
                    onClick={() => void handleSendMessage()}
                  >
                    <Send className="h-3.5 w-3.5" />
                    Send
                  </Button>
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

function TranscriptCard({
  entry,
  expanded,
  onToggle,
}: {
  entry: TranscriptEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const expandable = ["tool", "command", "file_change", "reasoning"].includes(entry.kind);
  const preview = entry.kind === "reasoning" ? entry.text || "thinking" : lastLines(entry.text, TOOL_LINE_LIMIT);
  const body = expandable && !expanded ? preview : entry.text;
  const rowClassName = getBubbleRowClassName(entry);
  const bubbleClassName = getBubbleClassName(entry);
  const metaBadges = getEntryMetaBadges(entry);
  const showMetaHeader = metaBadges.length > 0 || !isChatBubble(entry);

  return (
    <article className={`mb-4 flex w-full ${rowClassName}`}>
      <div className={bubbleClassName}>
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

        {expandable && entry.text ? (
          <div className="mt-2 flex justify-end">
            <Button variant="ghost" size="sm" onClick={onToggle}>
              {expanded ? "Collapse" : "Expand"}
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function renderEntryBody(entry: TranscriptEntry, body: string, expanded: boolean) {
  if (entry.kind === "assistant" || entry.kind === "user") {
    return <MarkdownBody text={body} />;
  }

  if (entry.kind === "file_change") {
    return expanded ? (
      <div className="max-h-80 overflow-auto rounded-md border border-border bg-background/70">
        <DiffViewer text={body} />
      </div>
    ) : (
      <pre className="overflow-hidden whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground/90">
        {body}
      </pre>
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

  return <MarkdownBody text={body || ""} muted={entry.kind === "system"} />;
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
      <SelectTrigger className="h-7 w-auto shrink-0 gap-1 border-transparent bg-transparent px-2 text-[14px] font-medium text-foreground shadow-none hover:bg-accent/50 focus:ring-0">
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

function StatusBadge({ connectionState }: { connectionState: "connecting" | "open" | "closed" | "error" }) {
  if (connectionState === "open") {
    return (
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Circle className="h-3.5 w-3.5 fill-emerald-500 text-emerald-500" />
        control
      </div>
    );
  }
  if (connectionState === "connecting") {
    return (
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        connecting
      </div>
    );
  }
  if (connectionState === "error") {
    return (
      <div className="flex items-center gap-1 text-xs text-red-400">
        <AlertCircle className="h-3.5 w-3.5" />
        error
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <Unplug className="h-3.5 w-3.5" />
      closed
    </div>
  );
}

function getActivity(
  session: SessionDetails | null,
  pending?: {
    creatingSession?: boolean;
    restoringHistory?: boolean;
    sessionLoading?: boolean;
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
  if (session.status === "completed") {
    return { label: "completed", variant: "success" };
  }
  return null;
}

function variantForEntry(entry: TranscriptEntry): "default" | "outline" | "warning" | "destructive" | "success" {
  switch (entry.kind) {
    case "assistant":
      return "default";
    case "reasoning":
      return "warning";
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
  if (entry.kind === "system") {
    return "w-full max-w-full rounded-xl border border-border bg-muted/40 px-3 py-2 shadow-sm";
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

function estimateEntryHeight(entry: TranscriptEntry | undefined) {
  if (!entry) {
    return 80;
  }
  const lines = String(entry.text || "").split(/\r?\n/).length;
  const previewLines =
    entry.kind === "tool" || entry.kind === "command" || entry.kind === "file_change"
      ? Math.min(lines, TOOL_LINE_LIMIT)
      : entry.kind === "assistant" || entry.kind === "user"
        ? Math.min(lines + 1, 24)
      : Math.min(lines, 16);
  return Math.max(88, 56 + previewLines * 20);
}

export default App;
