import { useEffect, useState } from "react";
import { fetchControlApi } from "@/lib/controlApi";
import type { ProjectFileBrowseResult, ProjectFileReadResult } from "@/lib/types";

export type SessionPane = "chat" | "files";

export function useSessionFiles({
  controlUrl,
  activeDaemonId,
  activeSessionId,
  activeSessionCwd,
  onAppendQuoteToComposer,
}: {
  controlUrl: string;
  activeDaemonId: string | null;
  activeSessionId: string | null;
  activeSessionCwd?: string;
  onAppendQuoteToComposer: (quoted: string) => void;
}) {
  const [sessionPane, setSessionPane] = useState<SessionPane>("chat");
  const [projectFiles, setProjectFiles] = useState<ProjectFileBrowseResult | null>(null);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<ProjectFileReadResult | null>(null);
  const [selectedFileLoading, setSelectedFileLoading] = useState(false);
  const [fileEditorValue, setFileEditorValue] = useState("");
  const [fileSelectionText, setFileSelectionText] = useState("");
  const [savingFile, setSavingFile] = useState(false);

  useEffect(() => {
    setProjectFiles(null);
    setSelectedFile(null);
    setFileEditorValue("");
    setFileSelectionText("");
    setSessionPane("chat");
  }, [activeSessionId]);

  async function loadProjectFiles(daemonId: string, sessionId: string, nextPath?: string) {
    setProjectFilesLoading(true);
    try {
      const query = nextPath ? `?path=${encodeURIComponent(nextPath)}` : "";
      const result = await fetchControlApi<ProjectFileBrowseResult>(
        controlUrl,
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
      const result = await fetchControlApi<ProjectFileReadResult>(
        controlUrl,
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

  async function openFilesPane() {
    if (!activeDaemonId || !activeSessionId || !activeSessionCwd) {
      return;
    }
    setSessionPane("files");
    await loadProjectFiles(activeDaemonId, activeSessionId, activeSessionCwd);
  }

  async function browseProjectPath(pathValue?: string) {
    if (!activeDaemonId || !activeSessionId) {
      return;
    }
    await loadProjectFiles(activeDaemonId, activeSessionId, pathValue);
  }

  async function openProjectFile(filePath: string) {
    if (!activeDaemonId || !activeSessionId) {
      return;
    }
    await loadProjectFile(activeDaemonId, activeSessionId, filePath);
  }

  async function saveProjectFile() {
    if (!activeDaemonId || !activeSessionId || !selectedFile || selectedFile.kind !== "text") {
      return;
    }
    setSavingFile(true);
    try {
      const result = await fetchControlApi<ProjectFileReadResult>(
        controlUrl,
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

  function quoteFileSelection() {
    if (!selectedFile || selectedFile.kind !== "text") {
      return;
    }
    const selectedText = fileSelectionText.trim() ? fileSelectionText : fileEditorValue;
    const extension = pathLikeExtension(selectedFile.path);
    const quoted = `\n\n[${selectedFile.path}]\n\`\`\`${extension}\n${selectedText.trim()}\n\`\`\`\n`;
    onAppendQuoteToComposer(quoted);
    setSessionPane("chat");
  }

  return {
    sessionPane,
    setSessionPane,
    projectFiles,
    projectFilesLoading,
    selectedFile,
    selectedFileLoading,
    fileEditorValue,
    savingFile,
    fileSelectionText,
    setFileEditorValue,
    setFileSelectionText,
    openFilesPane,
    browseProjectPath,
    openProjectFile,
    saveProjectFile,
    quoteFileSelection,
  };
}

function pathLikeExtension(filePath: string) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const lastSegment = normalized.split("/").pop() || "";
  const parts = lastSegment.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
}
