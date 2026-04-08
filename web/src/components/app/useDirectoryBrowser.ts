import { useState } from "react";
import { browseDaemonDirectories } from "@/lib/daemonApi";
import type { DirectoryBrowseResult } from "@/lib/types";

export function useDirectoryBrowser({
  controlUrl,
  activeDaemonId,
  cwd,
}: {
  controlUrl: string;
  activeDaemonId: string | null;
  cwd: string;
}) {
  const [directoryPickerOpen, setDirectoryPickerOpenState] = useState(false);
  const [directoryBrowser, setDirectoryBrowser] = useState<DirectoryBrowseResult | null>(null);
  const [directoryBrowserLoading, setDirectoryBrowserLoading] = useState(false);
  const [directoryBrowserPath, setDirectoryBrowserPath] = useState("");

  async function loadDirectories(daemonId: string, nextPath?: string) {
    setDirectoryBrowserLoading(true);
    try {
      const result = await browseDaemonDirectories(controlUrl, daemonId, nextPath);
      setDirectoryBrowser(result);
      setDirectoryBrowserPath(result.currentPath);
      return result;
    } finally {
      setDirectoryBrowserLoading(false);
    }
  }

  async function openDirectoryPicker() {
    if (!activeDaemonId) {
      return;
    }
    setDirectoryPickerOpenState(true);
    await loadDirectories(activeDaemonId, cwd);
  }

  async function browseDirectory(pathValue?: string) {
    if (!activeDaemonId) {
      return;
    }
    await loadDirectories(activeDaemonId, pathValue ?? directoryBrowserPath);
  }

  function setDirectoryPickerOpen(open: boolean) {
    setDirectoryPickerOpenState(open);
    if (!open) {
      setDirectoryBrowserPath("");
    }
  }

  return {
    directoryPickerOpen,
    setDirectoryPickerOpen,
    directoryBrowserPath,
    setDirectoryBrowserPath,
    directoryBrowser,
    directoryBrowserLoading,
    openDirectoryPicker,
    browseDirectory,
  };
}
