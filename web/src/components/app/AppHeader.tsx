import {
  ArrowUp,
  ChevronDown,
  Folder,
  FolderOpen,
  History,
  LayoutGrid,
  LoaderCircle,
  MessageSquareText,
  Moon,
  Play,
  Plus,
  Server,
  Settings2,
  Sun,
} from "lucide-react";
import { StatusBadge } from "@/components/app/SessionUi";
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
import type { CodexHistoryEntry, DaemonDescriptor, DirectoryBrowseResult, GlobalSettings, ProjectSummary } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";
import { SettingsEditor } from "./AgentPane";

type ThemeMode = "light" | "dark";

export function AppHeader({
  viewMode,
  onToggleViewMode,
  activeDaemonId,
  setActiveDaemonId,
  daemons,
  projects,
  activeProjectId,
  setActiveProjectId,
  setActiveAgentId,
  connectionState,
  newProjectOpen,
  setNewProjectOpen,
  projectName,
  setProjectName,
  projectGoal,
  setProjectGoal,
  cwd,
  setCwd,
  activeDaemonAvailable,
  creatingProject,
  onCreateProject,
  onOpenDirectoryPicker,
  historyOpen,
  setHistoryOpen,
  historySearch,
  setHistorySearch,
  historyLoading,
  groupedHistory,
  restoringHistoryId,
  onRestoreSession,
  newSessionOpen,
  setNewSessionOpen,
  activeProjectAvailable,
  creatingSession,
  onCreateSession,
  settingsOpen,
  setSettingsOpen,
  settings,
  onSaveSettings,
  directoryPickerOpen,
  setDirectoryPickerOpen,
  directoryBrowserPath,
  setDirectoryBrowserPath,
  directoryBrowser,
  directoryBrowserLoading,
  onBrowseDirectory,
  theme,
  setTheme,
}: {
  viewMode: "chat" | "overview";
  onToggleViewMode: () => void;
  activeDaemonId: string | null;
  setActiveDaemonId: (value: string | null) => void;
  daemons: DaemonDescriptor[];
  projects: ProjectSummary[];
  activeProjectId: string | null;
  setActiveProjectId: (value: string | null) => void;
  setActiveAgentId: (value: string | null) => void;
  connectionState: "connecting" | "open" | "closed" | "error";
  newProjectOpen: boolean;
  setNewProjectOpen: (open: boolean) => void;
  projectName: string;
  setProjectName: (value: string) => void;
  projectGoal: string;
  setProjectGoal: (value: string) => void;
  cwd: string;
  setCwd: (value: string) => void;
  activeDaemonAvailable: boolean;
  creatingProject: boolean;
  onCreateProject: () => void;
  onOpenDirectoryPicker: () => void;
  historyOpen: boolean;
  setHistoryOpen: (open: boolean) => void;
  historySearch: string;
  setHistorySearch: (value: string) => void;
  historyLoading: boolean;
  groupedHistory: Array<
    | { type: "separator"; key: string; label: string }
    | { type: "item"; entry: CodexHistoryEntry }
  >;
  restoringHistoryId: string | null;
  onRestoreSession: (item: CodexHistoryEntry) => void;
  newSessionOpen: boolean;
  setNewSessionOpen: (open: boolean) => void;
  activeProjectAvailable: boolean;
  creatingSession: boolean;
  onCreateSession: () => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  settings: GlobalSettings | null;
  onSaveSettings: (value: GlobalSettings) => void;
  directoryPickerOpen: boolean;
  setDirectoryPickerOpen: (open: boolean) => void;
  directoryBrowserPath: string;
  setDirectoryBrowserPath: (value: string) => void;
  directoryBrowser: DirectoryBrowseResult | null;
  directoryBrowserLoading: boolean;
  onBrowseDirectory: (pathValue?: string) => void;
  theme: ThemeMode;
  setTheme: (value: ThemeMode | ((current: ThemeMode) => ThemeMode)) => void;
}) {
  return (
    <header className="flex items-center gap-2 overflow-x-auto border-b border-border px-3 py-2 whitespace-nowrap">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onToggleViewMode}>
          {viewMode === "chat" ? <LayoutGrid className="h-4 w-4" /> : <MessageSquareText className="h-4 w-4" />}
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
      <div className="min-w-0 max-w-[52vw] shrink md:max-w-none">
        <div className="flex items-center gap-1 overflow-x-auto rounded-md border border-border bg-muted/30 px-1 py-1">
          {projects.map((project) => (
            <Button
              key={project.id}
              type="button"
              variant="ghost"
              size="sm"
              className={[
                "h-7 max-w-[240px] px-2 text-xs",
                project.id === activeProjectId ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
              ].join(" ")}
              onClick={() => {
                setActiveProjectId(project.id);
                setActiveAgentId(null);
              }}
            >
              <span className="truncate">{project.name}</span>
            </Button>
          ))}
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => setNewProjectOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <StatusBadge connectionState={connectionState} />
        <div className="flex shrink-0 items-center gap-1">
          <Dialog open={newProjectOpen} onOpenChange={setNewProjectOpen}>
            <DialogContent className="max-w-[560px] md:w-full">
              <DialogHeader>
                <DialogTitle>New Project</DialogTitle>
                <DialogDescription>Persistent project root and goal</DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 p-4">
                <Input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Project name" />
                <Textarea value={projectGoal} onChange={(event) => setProjectGoal(event.target.value)} placeholder="Project goal" className="min-h-[88px]" />
                <div className="flex items-center gap-2">
                  <Input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="Project root directory" />
                  <Button type="button" variant="outline" size="icon" className="shrink-0" onClick={onOpenDirectoryPicker} disabled={!activeDaemonAvailable}>
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex justify-end">
                  <Button size="sm" disabled={!activeDaemonAvailable || !projectName.trim() || !cwd.trim() || creatingProject} onClick={onCreateProject}>
                    {creatingProject ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
                    Create Project
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 px-2 sm:px-2.5" disabled={!activeDaemonAvailable}>
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
                  <Input value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Search history" className="h-8" />
                  {historyLoading ? (
                    <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      Loading history
                    </div>
                  ) : null}
                  {groupedHistory.map((item) =>
                    item.type === "separator" ? (
                      <div key={item.key} className="sticky top-0 z-10 -mx-1 bg-background/95 px-1 py-1 text-[11px] font-medium text-muted-foreground backdrop-blur">
                        {item.label}
                      </div>
                    ) : (
                      <button
                        key={item.entry.id}
                        type="button"
                        className="grid w-full gap-1 rounded-md border border-border px-3 py-2 text-left text-xs hover:bg-accent/50 disabled:cursor-wait disabled:opacity-70"
                        onClick={() => onRestoreSession(item.entry)}
                        disabled={Boolean(restoringHistoryId)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="line-clamp-2 text-sm font-medium">{item.entry.title || item.entry.id}</div>
                          {restoringHistoryId === item.entry.id ? <LoaderCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" /> : null}
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
              <Button size="sm" className="h-8 px-2 sm:px-2.5" disabled={!activeDaemonAvailable || !activeProjectAvailable}>
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
                  <Input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="Working directory" />
                  <Button type="button" variant="outline" size="icon" className="shrink-0" onClick={onOpenDirectoryPicker} disabled={!activeDaemonAvailable}>
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex justify-end">
                  <Button size="sm" disabled={!activeDaemonAvailable || !activeProjectAvailable || !cwd.trim() || creatingSession} onClick={onCreateSession}>
                    {creatingSession ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
                    Create
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" disabled={!activeDaemonAvailable}>
                <Settings2 className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-[640px] md:w-full">
              <DialogHeader>
                <DialogTitle>Settings</DialogTitle>
                <DialogDescription>Global provider and notification config</DialogDescription>
              </DialogHeader>
              {settings ? <SettingsEditor settings={settings} onSave={onSaveSettings} /> : <div className="p-4 text-sm text-muted-foreground">Loading settings</div>}
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
                        onBrowseDirectory(directoryBrowserPath);
                      }
                    }}
                  />
                  <Button type="button" variant="outline" size="icon" disabled={!directoryBrowser?.parentPath || directoryBrowserLoading} onClick={() => onBrowseDirectory(directoryBrowser?.parentPath)}>
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={!directoryBrowserPath.trim() || directoryBrowserLoading} onClick={() => onBrowseDirectory(directoryBrowserPath)}>
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
                      {!directoryBrowserLoading && !directoryBrowser?.entries.length ? <div className="px-2 py-2 text-sm text-muted-foreground">No subdirectories</div> : null}
                      {directoryBrowser?.entries.map((entry) => (
                        <button
                          key={entry.path}
                          type="button"
                          className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-accent/60"
                          onClick={() => onBrowseDirectory(entry.path)}
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
                  <div className="truncate text-xs text-muted-foreground">{directoryBrowser?.currentPath || directoryBrowserPath || cwd}</div>
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
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}>
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </header>
  );
}
