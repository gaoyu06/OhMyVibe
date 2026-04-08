import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { Badge } from "@/components/ui/badge";
import type { DaemonDescriptor, ProjectSummary, SessionDetails, SessionSummary } from "@/lib/types";
import { OverviewSessionCard } from "./OverviewSessionCard";

type OverviewCardLayout = { x: number; y: number; width: number; height: number };

export function OverviewPane({
  activeDaemon,
  activeProject,
  overviewSessions,
  activeSession,
  activeSessionId,
  currentOverviewLayout,
  overviewScrollRef,
  canvasStyle,
  onOpenSession,
  onDragSessionStart,
}: {
  activeDaemon: DaemonDescriptor | null;
  activeProject: ProjectSummary | null;
  overviewSessions: SessionSummary[];
  activeSession: SessionDetails | null;
  activeSessionId: string | null;
  currentOverviewLayout: Record<string, OverviewCardLayout>;
  overviewScrollRef: RefObject<HTMLDivElement | null>;
  canvasStyle: { width: number; height: number };
  onOpenSession: (sessionId: string) => void;
  onDragSessionStart: (sessionId: string, event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <main className="grid min-h-0 grid-rows-[64px_minmax(0,1fr)]">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {activeDaemon ? <Badge variant={activeDaemon.online ? "success" : "destructive"}>{activeDaemon.online ? "online" : "offline"}</Badge> : null}
            <div className="flex min-w-0 items-center gap-2">
              <div className="truncate text-sm font-medium">{activeDaemon?.name || "No Daemon"}</div>
              {activeDaemon?.version ? <div className="shrink-0 text-[11px] text-muted-foreground">v{activeDaemon.version}</div> : null}
            </div>
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {activeProject
              ? `${overviewSessions.length} active sessions · ${activeProject.rootDir}`
              : activeDaemon
                ? `0 active sessions · ${activeDaemon.cwd}`
                : "select daemon"}
          </div>
        </div>
      </div>
      <div ref={overviewScrollRef} className="min-h-0 overflow-auto bg-muted/10 px-4 py-4">
        {overviewSessions.length ? (
          <div className="overview-canvas relative" style={canvasStyle}>
            {overviewSessions.map((session) => (
              <OverviewSessionCard
                key={session.id}
                session={session}
                details={activeSession?.id === session.id ? activeSession : undefined}
                active={session.id === activeSessionId}
                layout={currentOverviewLayout[session.id]}
                onOpen={() => onOpenSession(session.id)}
                onDragStart={(event) => onDragSessionStart(session.id, event)}
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
  );
}
