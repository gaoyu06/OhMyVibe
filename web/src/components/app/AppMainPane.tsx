import { lazy, Suspense, useEffect, useState, type Key, type UIEvent } from "react";
import { ArrowDown, Circle, Edit3, FolderOpen, GitBranch, GitCommitHorizontal, LoaderCircle, MessageSquareText, PanelLeftOpen, Play, Send, Square } from "lucide-react";
import { AgentPane } from "@/components/app/AgentPane";
import { getActivity, InlineSelect, isBusyActivity, isTurnBusy, TranscriptCard } from "@/components/app/SessionUi";
import type { ChatTranscriptRow } from "@/components/app/useChatTranscript";
import type { SessionPane } from "@/components/app/useSessionFiles";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import type {
  AgentDetails,
  DaemonConfig,
  ProjectFileBrowseResult,
  ProjectFileReadResult,
  ProjectNotification,
  ProjectRunPolicy,
  ProjectSummary,
  SessionDetails,
} from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

const FilePaneLazy = lazy(() => import("../session/FilePane"));

export function AppMainPane(props: {
  sessionsCollapsed: boolean;
  onExpandSessions: () => void;
  sidebarMode: "sessions" | "agents";
  sessionPane: SessionPane;
  setSessionPane: (value: SessionPane) => void;
  activeSessionId: string | null;
  activeSession: SessionDetails | null;
  activeProject: ProjectSummary | null;
  activeAgent: AgentDetails | null;
  activeDaemonId: string | null;
  activeProjectId: string | null;
  onOpenFilesPane: () => void;
  onPauseProject: () => void;
  onRunProject: (runPolicy: ProjectRunPolicy) => void;
  renameSessionOpen: boolean;
  setRenameSessionOpen: (value: boolean) => void;
  renameTitle: string;
  setRenameTitle: (value: string) => void;
  renamingSession: boolean;
  onRenameSession: () => void;
  notifications: ProjectNotification[];
  onSendAgentMessage: (text: string) => void;
  onClearAgentLogs: () => void;
  clearingAgentLogs: boolean;
  projectFiles: ProjectFileBrowseResult | null;
  projectFilesLoading: boolean;
  selectedFile: ProjectFileReadResult | null;
  selectedFileLoading: boolean;
  fileEditorValue: string;
  savingFile: boolean;
  theme: "light" | "dark";
  onBrowseProjectPath: (value?: string) => void;
  onOpenProjectFile: (filePath: string) => void;
  onQuoteFileSelection: () => void;
  onSaveProjectFile: () => void;
  onFileEditorValueChange: (value: string) => void;
  onFileSelectionChange: (value: string) => void;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
  onTranscriptScroll: (event: UIEvent<HTMLDivElement>) => void;
  sessionLoading: boolean;
  hasOlderTranscript: boolean;
  loadingOlderTranscript: boolean;
  visibleTranscript: ChatTranscriptRow[];
  virtualItems: Array<{ index: number; key: Key; start: number }>;
  measureRow: (node: HTMLDivElement | null) => void;
  totalSize: number;
  approvalActionId: string | null;
  expanded: Set<string>;
  onToggleExpanded: (entryId: string) => void;
  onApprovalAction: (entry: import("@/lib/types").TranscriptEntry, decision: "approve" | "deny") => void;
  showScrollToBottom: boolean;
  chatRowCount: number;
  onScrollTranscriptToBottom: () => void;
  composer: string;
  setComposer: (value: string) => void;
  onSendMessage: () => void;
  sendingMessage: boolean;
  cwd: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  setSandbox: (value: "read-only" | "workspace-write" | "danger-full-access") => void;
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
  setApprovalPolicy: (value: "untrusted" | "on-failure" | "on-request" | "never") => void;
  model: string;
  setModel: (value: string) => void;
  effort: string;
  setEffort: (value: string) => void;
  currentModel: import("@/lib/types").AvailableModel | undefined;
  config: DaemonConfig;
  onSessionConfigChange: (next: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  }) => void;
  onInterrupt: () => void;
  formatEffortLabel: (value: string) => string;
  defaultApprovalPolicyForSandbox: (value: "read-only" | "workspace-write" | "danger-full-access") => "untrusted" | "on-failure" | "on-request" | "never";
}) {
  const activity = getActivity(props.activeSession, {
    sessionLoading: props.sessionLoading,
    sendingMessage: props.sendingMessage,
  });
  const [runProjectOpen, setRunProjectOpen] = useState(false);
  const [runPolicyMode, setRunPolicyMode] = useState<ProjectRunPolicy["mode"]>("until_blocked");
  const [runPolicyUntil, setRunPolicyUntil] = useState("");

  useEffect(() => {
    if (!props.activeProject) {
      setRunPolicyMode("until_blocked");
      setRunPolicyUntil("");
      return;
    }
    setRunPolicyMode(props.activeProject.runPolicy.mode);
    setRunPolicyUntil(toDateTimeLocalValue(props.activeProject.runPolicy.runUntil));
  }, [props.activeProject?.id, props.activeProject?.runPolicy.mode, props.activeProject?.runPolicy.runUntil]);

  return (
    <main className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 overflow-hidden">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {props.sessionsCollapsed ? (
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 md:hidden" aria-label="Expand sessions" onClick={props.onExpandSessions}>
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          ) : null}
          {props.sidebarMode === "sessions" ? (
            <div className="flex items-center gap-1 rounded-md border border-border bg-muted/30 p-1">
              <Button
                variant="ghost"
                size="sm"
                className={props.sessionPane === "chat" ? "h-7 bg-card px-2 text-xs shadow-sm" : "h-7 px-2 text-xs"}
                onClick={() => props.setSessionPane("chat")}
                disabled={!props.activeSessionId}
              >
                <MessageSquareText className="h-3.5 w-3.5" />
                Chat
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={props.sessionPane === "files" ? "h-7 bg-card px-2 text-xs shadow-sm" : "h-7 px-2 text-xs"}
                onClick={props.onOpenFilesPane}
                disabled={!props.activeSessionId}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                Files
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={props.sessionPane === "git" ? "h-7 bg-card px-2 text-xs shadow-sm" : "h-7 px-2 text-xs"}
                onClick={() => props.setSessionPane("git")}
                disabled={!props.activeSessionId}
              >
                <GitBranch className="h-3.5 w-3.5" />
                Git
              </Button>
            </div>
          ) : null}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {props.sidebarMode === "agents"
                ? props.activeAgent?.name || props.activeProject?.name || "No Agent"
                : props.activeSession?.title || props.activeProject?.name || "No Session"}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {props.sidebarMode === "agents"
                ? props.activeAgent
                  ? `${props.activeAgent.role} · ${props.activeAgent.status}`
                  : props.activeProject?.goal || "Select agent"
                : props.activeSession?.git?.branch
                  ? `${props.activeSession.git.branch} · ${props.activeSession.cwd}`
                  : props.activeSession?.cwd || props.activeProject?.rootDir || ""}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {props.activeProject ? (
            props.activeProject.status === "running" ? (
              <Button variant="outline" size="sm" className="h-8 px-2" onClick={props.onPauseProject}>
                <Square className="h-3.5 w-3.5" />
                Pause Project
              </Button>
            ) : (
              <Dialog open={runProjectOpen} onOpenChange={setRunProjectOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" className="h-8 px-2">
                    <Play className="h-3.5 w-3.5" />
                    Run Project
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-[460px] md:w-full">
                  <DialogHeader>
                    <DialogTitle>Run Project</DialogTitle>
                    <DialogDescription>Choose the run policy before starting automation.</DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-3 p-4">
                    <div className="grid gap-2">
                      <div className="text-sm font-medium">Run Policy</div>
                      <select
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                        value={runPolicyMode}
                        onChange={(event) => setRunPolicyMode(event.target.value as ProjectRunPolicy["mode"])}
                      >
                        <option value="until_blocked">Until Blocked</option>
                        <option value="until_complete">Until Complete</option>
                        <option value="until_time">Until Time</option>
                      </select>
                    </div>
                    {runPolicyMode === "until_time" ? (
                      <div className="grid gap-2">
                        <div className="text-sm font-medium">Run Until</div>
                        <Input
                          type="datetime-local"
                          value={runPolicyUntil}
                          onChange={(event) => setRunPolicyUntil(event.target.value)}
                        />
                      </div>
                    ) : null}
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        disabled={runPolicyMode === "until_time" && !runPolicyUntil}
                        onClick={() => {
                          props.onRunProject({
                            mode: runPolicyMode,
                            runUntil:
                              runPolicyMode === "until_time" && runPolicyUntil
                                ? new Date(runPolicyUntil).toISOString()
                                : undefined,
                          });
                          setRunProjectOpen(false);
                        }}
                      >
                        <Play className="h-3.5 w-3.5" />
                        Start
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            )
          ) : null}
          <Dialog open={props.renameSessionOpen} onOpenChange={props.setRenameSessionOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Rename session" disabled={!props.activeSessionId || props.sidebarMode !== "sessions"}>
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
                  value={props.renameTitle}
                  onChange={(event) => props.setRenameTitle(event.target.value)}
                  placeholder="Session title"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      props.onRenameSession();
                    }
                  }}
                />
                <div className="flex justify-end">
                  <Button size="sm" disabled={!props.activeSessionId || !props.renameTitle.trim() || props.renamingSession} onClick={props.onRenameSession}>
                    {props.renamingSession ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
                    Save
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {props.sidebarMode === "agents" ? (
        <AgentPane
          agent={props.activeAgent}
          notifications={props.notifications}
          onSendMessage={props.onSendAgentMessage}
          onClearLogs={props.onClearAgentLogs}
          clearingLogs={props.clearingAgentLogs}
        />
      ) : props.sessionPane === "files" ? (
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
              projectFiles={props.projectFiles}
              projectFilesLoading={props.projectFilesLoading}
              selectedFile={props.selectedFile}
              selectedFileLoading={props.selectedFileLoading}
              fileEditorValue={props.fileEditorValue}
              savingFile={props.savingFile}
              theme={props.theme}
              onBrowseProjectPath={props.onBrowseProjectPath}
              onOpenProjectFile={props.onOpenProjectFile}
              onQuoteFileSelection={props.onQuoteFileSelection}
              onSaveProjectFile={props.onSaveProjectFile}
              onFileEditorValueChange={props.onFileEditorValueChange}
              onFileSelectionChange={props.onFileSelectionChange}
            />
          </Suspense>
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
            <div className="truncate text-[11px] text-muted-foreground">{props.activeSession ? props.activeSession.cwd : props.cwd}</div>
            <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => props.setSessionPane("chat")}>
              <MessageSquareText className="h-3.5 w-3.5" />
              Back to Chat
            </Button>
          </div>
        </>
      ) : props.sessionPane === "git" ? (
        <>
          <ScrollArea className="min-h-0 bg-muted/10">
            <div className="mx-auto grid w-full max-w-[1200px] gap-4 p-4">
              <GitSessionPane session={props.activeSession} />
            </div>
          </ScrollArea>
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
            <div className="truncate text-[11px] text-muted-foreground">
              {props.activeSession?.git?.branch ? `${props.activeSession.git.branch} · ` : ""}
              {props.activeSession ? props.activeSession.cwd : props.cwd}
            </div>
            <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => props.setSessionPane("chat")}>
              <MessageSquareText className="h-3.5 w-3.5" />
              Back to Chat
            </Button>
          </div>
        </>
      ) : (
        <>
          <div ref={props.transcriptRef} className="relative min-h-0 overflow-auto bg-muted/10" onScroll={props.onTranscriptScroll}>
            {props.sessionLoading ? (
              <div className="flex h-full items-center justify-center px-3 py-3">
                <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground shadow-sm">
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  Loading session
                </div>
              </div>
            ) : (
              <div className="relative mx-auto w-full max-w-[1200px] px-3 py-3" style={{ height: `${props.totalSize}px` }}>
                {props.hasOlderTranscript ? (
                  <div className="sticky top-0 z-10 mb-2 flex justify-center">
                    <div className="rounded-full border border-border bg-background/90 px-3 py-1 text-[11px] text-muted-foreground backdrop-blur">
                      {props.loadingOlderTranscript ? "Loading older messages" : "Scroll top to load older messages"}
                    </div>
                  </div>
                ) : null}
                {props.virtualItems.map((virtualRow) => {
                  const row = props.visibleTranscript[virtualRow.index];
                  if (!row) {
                    return null;
                  }
                  return (
                    <div
                      key={row.id}
                      data-index={virtualRow.index}
                      ref={props.measureRow}
                      className="absolute left-0 top-0 w-full px-3 ui-entry-reveal"
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    >
                      <TranscriptCard
                        entry={row.entry}
                        reasoning={row.reasoning}
                        busy={props.approvalActionId === row.entry.id}
                        expanded={props.expanded.has(row.entry.id)}
                        onApprovalAction={(decision) => props.onApprovalAction(row.entry, decision)}
                        onToggle={() => props.onToggleExpanded(row.entry.id)}
                      />
                    </div>
                  );
                })}
              </div>
            )}
            {props.showScrollToBottom && props.chatRowCount ? (
              <div className="ui-fab-reveal pointer-events-none sticky bottom-3 z-20 flex justify-end px-3">
                <Button type="button" size="icon" variant="outline" className="pointer-events-auto h-8 w-8 rounded-full shadow-sm" onClick={props.onScrollTranscriptToBottom}>
                  <ArrowDown className="h-4 w-4" />
                </Button>
              </div>
            ) : null}
          </div>

          <div className="grid gap-2 border-t border-border p-3">
            <Textarea
              value={props.composer}
              onChange={(event) => props.setComposer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  props.onSendMessage();
                }
              }}
              placeholder="Message Codex or use /compact · Enter send · Shift+Enter newline"
              className="min-h-[96px] max-h-[128px] md:max-h-[96px]"
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-2">
                {activity ? (
                  <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    {isBusyActivity(activity) ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Circle className="h-3 w-3 fill-current" />}
                    {activity.label}
                  </div>
                ) : (
                  <div className="truncate text-[11px] text-muted-foreground">{props.activeSession ? props.activeSession.cwd : props.cwd}</div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1 sm:justify-end">
                <InlineSelect
                  value={props.sandbox}
                  onValueChange={(value) => {
                    const nextValue = value as "read-only" | "workspace-write" | "danger-full-access";
                    const nextApprovalPolicy = props.defaultApprovalPolicyForSandbox(nextValue);
                    props.setSandbox(nextValue);
                    props.setApprovalPolicy(nextApprovalPolicy);
                    props.onSessionConfigChange({ sandbox: nextValue, approvalPolicy: nextApprovalPolicy });
                  }}
                  options={[
                    { value: "danger-full-access", label: "Full Access" },
                    { value: "workspace-write", label: "Workspace" },
                    { value: "read-only", label: "Read Only" },
                  ]}
                />
                <InlineSelect
                  value={props.model}
                  onValueChange={(value) => {
                    props.setModel(value);
                    props.onSessionConfigChange({ model: value });
                  }}
                  options={props.config.models.map((item) => ({ value: item.model, label: item.model }))}
                />
                <InlineSelect
                  value={props.effort}
                  onValueChange={(value) => {
                    props.setEffort(value);
                    props.onSessionConfigChange({ reasoningEffort: value });
                  }}
                  options={(props.currentModel?.supportedReasoningEfforts || []).map((item) => ({
                    value: item.reasoningEffort,
                    label: props.formatEffortLabel(item.reasoningEffort),
                  }))}
                />
                {isTurnBusy(props.activeSession, props.sendingMessage) ? (
                  <Button size="sm" variant="outline" disabled={!props.activeDaemonId || !props.activeSessionId} onClick={props.onInterrupt}>
                    <Square className="h-3.5 w-3.5" />
                    Stop
                  </Button>
                ) : (
                  <Button size="sm" disabled={!props.activeDaemonId || !props.activeSessionId || !props.composer.trim()} onClick={props.onSendMessage}>
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
  );
}

function GitSessionPane({ session }: { session: SessionDetails | null }) {
  if (!session) {
    return (
      <div className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">
        Select a session to view git details.
      </div>
    );
  }

  const details = session.gitDetails;
  if (!details?.isRepo) {
    return (
      <div className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">
        This session directory is not a git repository.
      </div>
    );
  }

  return (
    <>
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            <GitBranch className="h-3.5 w-3.5" />
            {details.branch || "detached"}
          </Badge>
          <Badge variant="outline">Modified {details.modifiedFileCount}</Badge>
          <Badge variant="outline">Staged {details.stagedFileCount}</Badge>
          <Badge variant="outline">Untracked {details.untrackedFileCount}</Badge>
        </div>
        {details.head ? (
          <div className="mt-4 rounded-lg border border-border/70 bg-muted/20 p-3">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              Latest Commit
            </div>
            <div className="mt-2 text-sm font-medium">{details.head.subject || details.head.hash}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {details.head.hash.slice(0, 12)}
              {details.head.committedAt ? ` · ${formatDateTime(details.head.committedAt)}` : ""}
            </div>
          </div>
        ) : null}
      </div>
      <GitFileList title="Modified Files" files={details.modifiedFiles} />
      <GitFileList title="Staged Files" files={details.stagedFiles} />
      <GitFileList title="Untracked Files" files={details.untrackedFiles} />
    </>
  );
}

function GitFileList({ title, files }: { title: string; files: string[] }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-sm font-medium">{title}</div>
      {files.length ? (
        <div className="mt-3 grid gap-2">
          {files.map((file) => (
            <div
              key={`${title}-${file}`}
              className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm leading-6 break-all"
            >
              {file}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 text-sm text-muted-foreground">No files</div>
      )}
    </div>
  );
}

function toDateTimeLocalValue(value?: string) {
  if (!value) {
    return "";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  const offsetMs = parsed.getTimezoneOffset() * 60_000;
  return new Date(parsed.getTime() - offsetMs).toISOString().slice(0, 16);
}
