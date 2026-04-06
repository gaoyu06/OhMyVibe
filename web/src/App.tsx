import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  Circle,
  LoaderCircle,
  Moon,
  PanelLeftOpen,
  Play,
  RefreshCcw,
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
import { formatDateTime, formatTime, lastLines } from "@/lib/utils";
import type {
  CodexHistoryEntry,
  DaemonConfig,
  DaemonEvent,
  SessionDetails,
  SessionSummary,
  TranscriptEntry,
} from "@/lib/types";

const DEFAULT_SERVER_URL = import.meta.env.VITE_DAEMON_URL || window.location.origin;
const TOOL_LINE_LIMIT = 30;

type ThemeMode = "light" | "dark";

interface ActivityState {
  label: string;
  variant: "default" | "warning" | "destructive" | "success";
}

function App() {
  const [theme, setTheme] = useState<ThemeMode>(
    () => (localStorage.getItem("ohmyvibe-theme") as ThemeMode) || "dark",
  );
  const [serverUrlInput, setServerUrlInput] = useState(
    () => localStorage.getItem("ohmyvibe-server-url") || DEFAULT_SERVER_URL,
  );
  const [serverUrl, setServerUrl] = useState(
    () => localStorage.getItem("ohmyvibe-server-url") || DEFAULT_SERVER_URL,
  );
  const [connectionState, setConnectionState] = useState<"connecting" | "open" | "closed" | "error">(
    "connecting",
  );
  const [config, setConfig] = useState<DaemonConfig>({ models: [] });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [history, setHistory] = useState<CodexHistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionDetails | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [composer, setComposer] = useState("");
  const [cwd, setCwd] = useState("C:\\Code\\Projects\\OhMyVibe");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("medium");
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("ohmyvibe-theme", theme);
  }, [theme]);

  useEffect(() => {
    setServerUrlInput(serverUrl);
    localStorage.setItem("ohmyvibe-server-url", serverUrl);
  }, [serverUrl]);

  useEffect(() => {
    void loadConfig();
    void loadSessions();

    const ws = new WebSocket(toWsUrl(serverUrl));
    setConnectionState("connecting");

    ws.onopen = () => setConnectionState("open");
    ws.onerror = () => setConnectionState("error");
    ws.onclose = () => setConnectionState("closed");
    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data) as DaemonEvent | { type: "hello"; sessions: SessionSummary[] };
      if (payload.type === "hello") {
        setSessions(payload.sessions);
        setActiveSessionId((current) => current ?? payload.sessions[0]?.id ?? null);
        return;
      }

      if (payload.type === "session-created" || payload.type === "session-updated") {
        setSessions((current) => upsertSessionSummary(current, payload.session));
        setActiveSession((current) =>
          current && current.id === payload.session.id ? { ...current, ...payload.session } : current,
        );
        return;
      }

      if (payload.type === "session-deleted") {
        setSessions((current) => current.filter((session) => session.id !== payload.sessionId));
        setActiveSession((current) => (current?.id === payload.sessionId ? null : current));
        setActiveSessionId((current) => (current === payload.sessionId ? null : current));
        return;
      }

      if (payload.type === "session-entry") {
        setActiveSession((current) => {
          if (!current || current.id !== payload.sessionId) {
            return current;
          }
          const nextTranscript = [...current.transcript, payload.entry];
          return { ...current, transcript: nextTranscript, transcriptCount: nextTranscript.length };
        });
        if (payload.entry.kind === "reasoning" && payload.entry.status === "streaming") {
          setExpanded((current) => new Set(current).add(payload.entry.id));
        }
        return;
      }

      if (payload.type === "session-reset") {
        setActiveSession((current) =>
          current && current.id === payload.sessionId
            ? { ...current, transcript: payload.transcript, transcriptCount: payload.transcript.length }
            : current,
        );
      }
    };

    return () => {
      ws.close();
    };
  }, [serverUrl]);

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }
    void loadSession(activeSessionId);
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

  const transcript = activeSession?.transcript ?? [];
  const parentRef = transcriptRef;
  const rowVirtualizer = useVirtualizer({
    count: transcript.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => estimateEntryHeight(transcript[index]),
    overscan: 8,
  });

  const activity = getActivity(activeSession);

  async function api<T>(path: string, options?: RequestInit) {
    const response = await fetch(new URL(path, normalizeBaseUrl(serverUrl)).toString(), {
      headers: {
        "Content-Type": "application/json",
      },
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

  async function loadConfig() {
    const nextConfig = await api<DaemonConfig>("/api/config");
    setConfig(nextConfig);
    const nextModel = nextConfig.defaultModel || nextConfig.models[0]?.model || "";
    if (nextModel) {
      setModel(nextModel);
      const foundModel = nextConfig.models.find((item) => item.model === nextModel);
      setEffort(foundModel?.defaultReasoningEffort || "medium");
    }
  }

  async function loadSessions() {
    const nextSessions = await api<SessionSummary[]>("/api/sessions");
    setSessions(nextSessions);
    setActiveSessionId((current) => current ?? nextSessions[0]?.id ?? null);
  }

  async function loadSession(sessionId: string) {
    const session = await api<SessionDetails>(`/api/sessions/${sessionId}`);
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
  }

  async function loadHistory() {
    const items = await api<CodexHistoryEntry[]>("/api/history");
    setHistory(items);
  }

  async function handleCreateSession() {
    const session = await api<SessionDetails>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        cwd,
        model,
        reasoningEffort: effort,
        sandbox: "workspace-write",
      }),
    });
    setActiveSessionId(session.id);
    setActiveSession(session);
    setComposer("");
  }

  async function handleRestoreSession(item: CodexHistoryEntry) {
    const session = await api<SessionDetails>(`/api/history/${item.id}/restore`, {
      method: "POST",
      body: JSON.stringify({
        cwd: item.cwd || cwd,
        model,
        reasoningEffort: effort,
        sandbox: "workspace-write",
      }),
    });
    setHistoryOpen(false);
    setActiveSessionId(session.id);
    setActiveSession(session);
  }

  async function handleSendMessage() {
    if (!activeSessionId || !composer.trim()) {
      return;
    }
    await api(`/api/sessions/${activeSessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: composer.trim() }),
    });
    setComposer("");
  }

  async function handleInterrupt() {
    if (!activeSessionId) {
      return;
    }
    await api(`/api/sessions/${activeSessionId}/interrupt`, { method: "POST" });
  }

  async function handleDelete() {
    if (!activeSessionId) {
      return;
    }
    await api(`/api/sessions/${activeSessionId}`, { method: "DELETE" });
  }

  async function reconnect() {
    setServerUrl(normalizeBaseUrl(serverUrlInput));
  }

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <div className="grid h-full grid-rows-[48px_minmax(0,1fr)]">
        <header className="grid grid-cols-[220px_1fr_auto] items-center gap-3 border-b border-border px-3">
          <div className="text-sm font-semibold tracking-tight">OhMyVibe</div>

          <div className="grid grid-cols-[minmax(180px,280px)_120px_120px_minmax(220px,1fr)] items-center gap-2">
            <Input value={serverUrlInput} onChange={(event) => setServerUrlInput(event.target.value)} />
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue placeholder="Model" />
              </SelectTrigger>
              <SelectContent>
                {config.models.map((item) => (
                  <SelectItem key={item.model} value={item.model}>
                    {item.model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={effort} onValueChange={setEffort}>
              <SelectTrigger>
                <SelectValue placeholder="Effort" />
              </SelectTrigger>
              <SelectContent>
                {(currentModel?.supportedReasoningEfforts || []).map((item) => (
                  <SelectItem key={item.reasoningEffort} value={item.reasoningEffort}>
                    {item.reasoningEffort}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input value={cwd} onChange={(event) => setCwd(event.target.value)} />
          </div>

          <div className="flex items-center gap-2">
            <StatusBadge connectionState={connectionState} />
            <Button variant="outline" size="sm" onClick={() => void reconnect()}>
              <RefreshCcw className="h-3.5 w-3.5" />
              Connect
            </Button>
            <Dialog
              open={historyOpen}
              onOpenChange={(open) => {
                setHistoryOpen(open);
                if (open) {
                  void loadHistory();
                }
              }}
            >
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <PanelLeftOpen className="h-3.5 w-3.5" />
                  History
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>History</DialogTitle>
                  <DialogDescription>restore from Codex sessions</DialogDescription>
                </DialogHeader>
                <ScrollArea className="h-[calc(100vh-64px)]">
                  <div className="space-y-2 p-4">
                    {history.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="grid w-full gap-1 rounded-md border border-border px-3 py-2 text-left text-xs hover:bg-accent/50"
                        onClick={() => void handleRestoreSession(item)}
                      >
                        <div className="line-clamp-2 text-sm font-medium">{item.title || item.id}</div>
                        <div className="text-muted-foreground">{item.cwd}</div>
                        <div className="text-muted-foreground">
                          {formatDateTime(item.updatedAt)} · {item.source || "unknown"} · {item.status}
                        </div>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              </DialogContent>
            </Dialog>
            <Button size="sm" onClick={() => void handleCreateSession()}>
              <Play className="h-3.5 w-3.5" />
              New
            </Button>
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

          <main className="grid min-h-0 grid-rows-[64px_minmax(0,1fr)_152px]">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{activeSession?.title || "No Session"}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {activeSession
                    ? `${activeSession.cwd} · ${activeSession.model || "default"} · ${activeSession.reasoningEffort || "medium"} · ${activeSession.codexThreadId || "pending"}`
                    : "select or create"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {activity ? <Badge variant={activity.variant}>{activity.label}</Badge> : null}
                <Button variant="outline" size="sm" disabled={!activeSessionId} onClick={() => void handleInterrupt()}>
                  <Square className="h-3.5 w-3.5" />
                  Stop
                </Button>
                <Button variant="destructive" size="sm" disabled={!activeSessionId} onClick={() => void handleDelete()}>
                  Close
                </Button>
              </div>
            </div>

            <div ref={transcriptRef} className="min-h-0 overflow-auto bg-muted/10">
              <div
                className="relative mx-auto w-full max-w-[1200px] px-3 py-3"
                style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const entry = transcript[virtualRow.index];
                  if (!entry) {
                    return null;
                  }
                  return (
                    <div
                      key={entry.id}
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
                className="min-h-[108px] max-h-[108px]"
              />
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-xs text-muted-foreground">
                  {activeSession?.codexSource || "daemon"} · {activeSession?.origin || "local"}
                </div>
                <div className="flex items-center gap-2">
                  {activity ? (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      {activity.label}
                    </div>
                  ) : null}
                  <Button size="sm" disabled={!activeSessionId || !composer.trim()} onClick={() => void handleSendMessage()}>
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

  return (
    <article className="mb-2 rounded-md border border-border bg-card px-3 py-2 shadow-sm">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <Badge variant={variantForEntry(entry)}>{entry.kind}</Badge>
          {entry.status ? <Badge variant="outline">{entry.status}</Badge> : null}
          {entry.phase ? <Badge variant="outline">{entry.phase}</Badge> : null}
        </div>
        <div>{formatTime(entry.createdAt)}</div>
      </div>
      <div className={expandable && expanded ? "max-h-72 overflow-auto rounded border border-border bg-muted/30 p-2 font-mono text-xs leading-5 whitespace-pre-wrap" : "whitespace-pre-wrap text-sm leading-6"}>
        {body || (entry.kind === "reasoning" ? "thinking" : "")}
      </div>
      {expandable && entry.text ? (
        <div className="mt-2 flex justify-end">
          <Button variant="ghost" size="sm" onClick={onToggle}>
            {expanded ? "Collapse" : "Expand"}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function StatusBadge({ connectionState }: { connectionState: "connecting" | "open" | "closed" | "error" }) {
  if (connectionState === "open") {
    return (
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Circle className="h-3.5 w-3.5 fill-emerald-500 text-emerald-500" />
        connected
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

function getActivity(session: SessionDetails | null): ActivityState | null {
  if (!session) {
    return null;
  }
  const transcript = session.transcript || [];
  const reasoning = [...transcript].reverse().find((entry) => entry.kind === "reasoning" && entry.status === "streaming");
  if (reasoning) {
    return { label: "thinking", variant: "warning" };
  }
  const assistant = [...transcript].reverse().find((entry) => entry.kind === "assistant" && entry.status === "streaming");
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

function upsertSessionSummary(current: SessionSummary[], session: SessionSummary) {
  const index = current.findIndex((item) => item.id === session.id);
  if (index === -1) {
    return [session, ...current].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const next = [...current];
  next[index] = { ...next[index], ...session };
  return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function normalizeBaseUrl(value: string) {
  const normalized = value.trim() || DEFAULT_SERVER_URL;
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
      : Math.min(lines, 16);
  return Math.max(84, 52 + previewLines * 18);
}

export default App;
