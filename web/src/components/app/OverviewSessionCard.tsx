import type { PointerEvent as ReactPointerEvent } from "react";
import { ArrowRight, GripHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { SessionDetails, SessionPreviewEntry, SessionSummary, TranscriptEntry } from "@/lib/types";
import { formatDateTime, formatTime, lastLines } from "@/lib/utils";
import { formatSessionStatusLabel, getSessionStatusDotClassName } from "./AppSidebar";
import { getActivity, type ActivityState } from "./SessionUi";

type OverviewCardLayout = { x: number; y: number; width: number; height: number };

export function OverviewSessionCard({
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
  const previewEntries = sessionPreviewEntries.length ? sessionPreviewEntries : getOverviewPreviewEntries(details);
  const live = session.status === "running" || session.status === "starting";
  const liveBackgroundClassName = live ? getOverviewCardLiveClassName(session) : "";

  return (
    <div
      className={[
        "overview-card ui-overview-card absolute grid gap-2 overflow-hidden rounded-[20px] border px-3 py-3 text-left shadow-sm",
        getOverviewCardToneClassName(session, active),
      ].join(" ")}
      style={{
        width: layout?.width ?? 336,
        minHeight: layout?.height ?? 280,
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
  const collapsed = String(entry.text || "").replace(/\s+/g, " ").trim();
  return collapsed || getOverviewEntryLabel(entry);
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
