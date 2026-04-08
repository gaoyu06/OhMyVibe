import { Suspense } from "react";
import { AlertCircle, ChevronDown, ChevronUp, Circle, LoaderCircle, Unplug } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SessionDetails, TranscriptEntry } from "@/lib/types";
import { formatDurationMs, formatTime, lastLines } from "@/lib/utils";
import MarkdownBodyLazy from "@/components/chat/MarkdownBody";
import DiffViewerLazy from "@/components/chat/DiffViewer";

export interface ActivityState {
  label: string;
  variant: "default" | "outline" | "warning" | "destructive" | "success";
}

export function TranscriptCard({
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
  const preview = lastLines(entry.text, 30);
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

export function InlineSelect({
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

export function TypingPlaceholder() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle className="h-4 w-4 animate-spin" />
      <span>Thinking</span>
    </div>
  );
}

export function StatusBadge({
  connectionState,
}: {
  connectionState: "connecting" | "open" | "closed" | "error";
}) {
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

export function getActivity(
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
  const reasoning = [...transcript].reverse().find((entry) => entry.kind === "reasoning" && entry.status === "streaming");
  if (reasoning) {
    return { label: "thinking", variant: "warning" };
  }
  const approval = [...transcript].reverse().find((entry) => entry.kind === "approval" && entry.status === "pending");
  if (approval) {
    return { label: "approval", variant: "warning" };
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
  return null;
}

export function isBusyActivity(activity: ActivityState) {
  return ["restoring", "starting", "loading", "sending", "thinking", "replying", "running"].includes(activity.label);
}

export function isTurnBusy(session: SessionDetails | null, sendingMessage: boolean) {
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
  const firstByteMs = typeof entry.meta?.firstByteMs === "number" ? entry.meta.firstByteMs : undefined;
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
      <div className={["overflow-hidden", expanded ? "" : "line-clamp-1"].join(" ")}>
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

export function getAttachedReasoningText(reasoning?: TranscriptEntry, expanded: boolean = false) {
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

  if (approvalKind === "execCommandApproval" || approvalKind === "item/commandExecution/requestApproval") {
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

  if (approvalKind === "applyPatchApproval" || approvalKind === "item/fileChange/requestApproval") {
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
