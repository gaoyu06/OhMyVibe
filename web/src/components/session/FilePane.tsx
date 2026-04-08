import { Suspense, lazy } from "react";
import { FileCode2, FileImage, FileText, Folder, LoaderCircle, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ProjectFileBrowseResult, ProjectFileReadResult } from "@/lib/types";

const CodeEditor = lazy(() => import("./ProjectCodeEditor"));

export default function FilePane({
  projectFiles,
  projectFilesLoading,
  selectedFile,
  selectedFileLoading,
  fileEditorValue,
  savingFile,
  theme,
  onBrowseProjectPath,
  onOpenProjectFile,
  onQuoteFileSelection,
  onSaveProjectFile,
  onFileEditorValueChange,
  onFileSelectionChange,
}: {
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
}) {
  return (
    <div className="grid min-h-0 grid-cols-1 bg-muted/10 md:grid-cols-[280px_minmax(0,1fr)]">
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-b border-border md:border-r md:border-b-0">
        <div className="grid gap-2 border-b border-border px-3 py-3">
          <div className="truncate text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Project Files
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {projectFiles?.currentPath || ""}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2"
              disabled={!projectFiles?.parentPath || projectFilesLoading}
              onClick={() => onBrowseProjectPath(projectFiles?.parentPath)}
            >
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
                  entry.kind === "directory" ? onBrowseProjectPath(entry.path) : onOpenProjectFile(entry.path)
                }
              >
                {entry.kind === "directory" ? (
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : getProjectFileIcon(entry.path)}
                <div className="min-w-0 flex-1 truncate">{entry.name}</div>
                {entry.kind === "file" && typeof entry.size === "number" ? (
                  <div className="shrink-0 text-[10px] text-muted-foreground">{formatFileSize(entry.size)}</div>
                ) : null}
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>

      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="min-w-0 truncate text-xs text-muted-foreground">{selectedFile?.path || "Select a file"}</div>
          <div className="flex items-center gap-2">
            {selectedFile?.kind === "text" ? (
              <Button type="button" variant="outline" size="sm" className="h-7 px-2" onClick={onQuoteFileSelection}>
                <FileCode2 className="h-3.5 w-3.5" />
                Quote
              </Button>
            ) : null}
            {selectedFile?.kind === "text" ? (
              <Button type="button" size="sm" className="h-7 px-2" onClick={onSaveProjectFile} disabled={savingFile}>
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
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center px-4 py-4 text-sm text-muted-foreground">
                  <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                  Loading editor
                </div>
              }
            >
              <CodeEditor
                path={selectedFile.path}
                value={fileEditorValue}
                theme={theme}
                onChange={onFileEditorValueChange}
                onSelectionChange={onFileSelectionChange}
              />
            </Suspense>
          ) : (
            <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
              Select a file to preview
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function getProjectFileIcon(filePath: string) {
  const extension = pathLikeExtension(filePath);
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(extension)) {
    return <FileImage className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  if (["ts", "tsx", "js", "jsx", "json", "css", "html", "md", "py", "rs", "go", "java", "c", "cpp", "h", "hpp", "yml", "yaml", "toml", "sh", "ps1"].includes(extension)) {
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
