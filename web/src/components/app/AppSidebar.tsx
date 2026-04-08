import { PanelLeftOpen, Trash2 } from "lucide-react";
import {
  getAgentRoleBadgeClassName,
  getAgentRoleCardClassName,
  getAgentRoleEmoji,
  getAgentRoleLabel,
} from "@/components/app/agentUi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { AgentSummary, SessionSummary } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

export function AppSidebar({
  collapsed,
  sidebarMode,
  visibleSessions,
  visibleAgents,
  activeSessionId,
  activeAgentId,
  onToggleCollapsed,
  onSetSidebarMode,
  onSelectSession,
  onDeleteSession,
  onSelectAgent,
}: {
  collapsed: boolean;
  sidebarMode: "sessions" | "agents";
  visibleSessions: SessionSummary[];
  visibleAgents: AgentSummary[];
  activeSessionId: string | null;
  activeAgentId: string | null;
  onToggleCollapsed: () => void;
  onSetSidebarMode: (mode: "sessions" | "agents") => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onSelectAgent: (agentId: string) => void;
}) {
  return (
    <aside
      className={[
        "ui-panel-motion absolute inset-y-0 left-0 z-30 grid min-h-0 w-[min(85vw,320px)] grid-rows-[40px_minmax(0,1fr)] bg-background shadow-2xl md:static md:z-auto md:w-[272px] md:bg-transparent md:shadow-none",
        collapsed
          ? "pointer-events-none -translate-x-full overflow-hidden border-r-0 opacity-0 md:pointer-events-auto md:w-[52px] md:translate-x-0 md:border-r md:opacity-100"
          : "border-r border-border opacity-100",
      ].join(" ")}
    >
      <div className="flex items-center gap-2 px-2.5 text-xs uppercase tracking-[0.2em] text-muted-foreground">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={collapsed ? "Expand sessions" : "Collapse sessions"}
          onClick={onToggleCollapsed}
        >
          <PanelLeftOpen className={`h-4 w-4 transition-transform ${collapsed ? "" : "rotate-180"}`} />
        </Button>
        {!collapsed ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className={sidebarMode === "sessions" ? "h-7 bg-card px-2 text-[11px] shadow-sm" : "h-7 px-2 text-[11px]"}
              onClick={() => onSetSidebarMode("sessions")}
            >
              Sessions
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={sidebarMode === "agents" ? "h-7 bg-card px-2 text-[11px] shadow-sm" : "h-7 px-2 text-[11px]"}
              onClick={() => onSetSidebarMode("agents")}
            >
              Agents
            </Button>
          </div>
        ) : null}
        {!collapsed ? (
          <Badge variant="outline">{sidebarMode === "sessions" ? visibleSessions.length : visibleAgents.length}</Badge>
        ) : null}
      </div>
      {!collapsed ? (
        <ScrollArea className="min-w-0">
          <div className="min-w-0 space-y-1.5 p-2">
            {sidebarMode === "sessions"
              ? visibleSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => onSelectSession(session.id)}
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
                          onDeleteSession(session.id);
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
                    <div className="truncate text-[11px] text-muted-foreground">
                      {session.git?.branch ? `${session.git.branch} · ` : ""}
                      {session.cwd}
                    </div>
                  </button>
                ))
              : visibleAgents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => onSelectAgent(agent.id)}
                    className={[
                      "grid min-w-0 w-full gap-1 overflow-hidden rounded-xl border px-2.5 py-2 text-left text-xs",
                      getAgentRoleCardClassName(agent.role, activeAgentId === agent.id),
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="shrink-0 text-sm leading-none">{getAgentRoleEmoji(agent.role)}</span>
                          <div className="truncate text-[13px] font-medium">{agent.name}</div>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span
                            className={`rounded-full border px-1.5 py-0.5 uppercase tracking-[0.14em] ${getAgentRoleBadgeClassName(agent.role)}`}
                          >
                            {getAgentRoleLabel(agent.role)}
                          </span>
                          <span>{agent.status}</span>
                        </div>
                      </div>
                      <span className="shrink-0 text-base leading-none">{getAgentRoleEmoji(agent.role)}</span>
                    </div>
                    {agent.boundSessionId ? (
                      <div className="truncate text-[11px] text-muted-foreground">Session {agent.boundSessionId}</div>
                    ) : null}
                  </button>
                ))}
          </div>
        </ScrollArea>
      ) : null}
    </aside>
  );
}

export function formatSessionStatusLabel(status: SessionSummary["status"]) {
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

export function getSessionStatusAccentClassName(session: SessionSummary) {
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

export function getSessionStatusDotClassName(session: SessionSummary) {
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

export function getSessionListCardClassName(session: SessionSummary, active: boolean) {
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
