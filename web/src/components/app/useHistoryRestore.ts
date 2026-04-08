import { useMemo, useState } from "react";
import { fetchControlApi } from "@/lib/controlApi";
import type { CodexHistoryEntry, SessionDetails } from "@/lib/types";

export function useHistoryRestore({
  controlUrl,
  activeDaemonId,
  cwd,
  model,
  effort,
  sandbox,
  approvalPolicy,
  onRestoredSession,
}: {
  controlUrl: string;
  activeDaemonId: string | null;
  cwd: string;
  model: string;
  effort: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
  onRestoredSession: (session: SessionDetails) => void;
}) {
  const [history, setHistory] = useState<CodexHistoryEntry[]>([]);
  const [historySearch, setHistorySearch] = useState("");
  const [historyOpen, setHistoryOpenState] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [restoringHistoryId, setRestoringHistoryId] = useState<string | null>(null);

  const groupedHistory = useMemo(() => {
    const sortedHistory = [...history].sort(
      (a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""),
    );
    const query = historySearch.trim().toLowerCase();
    const filteredHistory = !query
      ? sortedHistory
      : sortedHistory.filter((item) =>
          [item.title, item.cwd, item.id, item.source, item.status]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(query)),
        );

    return groupHistoryByDay(filteredHistory);
  }, [history, historySearch]);

  async function loadHistory() {
    if (!activeDaemonId) {
      return;
    }
    setHistoryLoading(true);
    try {
      const items = await fetchControlApi<CodexHistoryEntry[]>(
        controlUrl,
        `/api/daemons/${activeDaemonId}/history`,
      );
      setHistory(items);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function setHistoryOpen(open: boolean) {
    setHistoryOpenState(open);
    if (open && activeDaemonId) {
      await loadHistory();
    }
  }

  async function restoreSession(item: CodexHistoryEntry) {
    if (!activeDaemonId) {
      return;
    }
    setRestoringHistoryId(item.id);
    try {
      const session = await fetchControlApi<SessionDetails>(
        controlUrl,
        `/api/daemons/${activeDaemonId}/history/${item.id}/restore`,
        {
          method: "POST",
          body: JSON.stringify({
            cwd: item.cwd || cwd,
            model,
            reasoningEffort: effort,
            sandbox,
            approvalPolicy,
          }),
        },
      );
      setHistoryOpenState(false);
      onRestoredSession(session);
    } finally {
      setRestoringHistoryId(null);
    }
  }

  return {
    historySearch,
    setHistorySearch,
    historyOpen,
    setHistoryOpen,
    historyLoading,
    groupedHistory,
    restoringHistoryId,
    restoreSession,
  };
}

function groupHistoryByDay(history: CodexHistoryEntry[]) {
  const grouped: Array<
    | { type: "separator"; key: string; label: string }
    | { type: "item"; entry: CodexHistoryEntry }
  > = [];
  let currentDay = "";

  for (const entry of history) {
    const dateKey = formatHistoryDayKey(entry.updatedAt || entry.createdAt);
    if (dateKey !== currentDay) {
      currentDay = dateKey;
      grouped.push({
        type: "separator",
        key: `separator-${dateKey}`,
        label: formatHistoryDayLabel(entry.updatedAt || entry.createdAt),
      });
    }
    grouped.push({ type: "item", entry });
  }

  return grouped;
}

function formatHistoryDayKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function formatHistoryDayLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
}
