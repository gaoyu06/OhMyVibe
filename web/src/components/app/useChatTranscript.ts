import { useVirtualizer } from "@tanstack/react-virtual";
import { type UIEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionDetails, TranscriptEntry } from "@/lib/types";

const TOOL_LINE_LIMIT = 30;

export interface PendingAssistantState {
  sessionId: string;
  since: number;
  baseTranscriptCount: number;
  userEntry: TranscriptEntry;
  entry: TranscriptEntry;
}

export interface ChatTranscriptRow {
  id: string;
  entry: TranscriptEntry;
  reasoning?: TranscriptEntry;
}

interface ChatTranscriptMeta {
  rowCount: number;
  lastRow?: ChatTranscriptRow;
}

interface ChatTranscriptMetaCache extends ChatTranscriptMeta {
  transcript: TranscriptEntry[];
  rowCounts: number[];
}

export function useChatTranscript({
  activeSessionId,
  activeSession,
  pendingAssistant,
  loadingOlderTranscript,
  onLoadOlderTranscriptPage,
}: {
  activeSessionId: string | null;
  activeSession: SessionDetails | null;
  pendingAssistant: PendingAssistantState | null;
  loadingOlderTranscript: boolean;
  onLoadOlderTranscriptPage: () => void;
}) {
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const prependPendingRef = useRef<{ previousHeight: number; previousTop: number } | null>(null);
  const stickToBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const chatTranscriptMetaCacheRef = useRef<ChatTranscriptMetaCache>({
    transcript: [],
    rowCounts: [],
    rowCount: 0,
  });

  const transcript = activeSession?.transcript ?? [];
  const displayTranscript = useMemo(() => {
    if (!pendingAssistant || pendingAssistant.sessionId !== activeSessionId) {
      return transcript;
    }
    const serverEntries = transcript.slice(pendingAssistant.baseTranscriptCount);
    const hasServerUser = serverEntries.some(
      (entry) =>
        entry.kind === "user" &&
        entry.text.trim() === pendingAssistant.userEntry.text.trim(),
    );
    const hasServerResponse = serverEntries.some((entry) => entry.kind !== "user");
    return [
      ...transcript,
      ...(hasServerUser ? [] : [pendingAssistant.userEntry]),
      ...(hasServerResponse ? [] : [pendingAssistant.entry]),
    ];
  }, [activeSessionId, pendingAssistant, transcript]);

  const chatTranscriptMeta = useMemo(() => {
    const nextCache = analyzeChatTranscript(displayTranscript, chatTranscriptMetaCacheRef.current);
    chatTranscriptMetaCacheRef.current = nextCache;
    return nextCache;
  }, [displayTranscript]);

  const visibleTranscript = useMemo(
    () => buildVisibleChatTranscriptRows(displayTranscript, chatTranscriptMeta.rowCount),
    [chatTranscriptMeta.rowCount, displayTranscript],
  );

  const hasOlderTranscript = activeSession?.hasMoreTranscriptBefore ?? false;
  const rowVirtualizer = useVirtualizer({
    count: visibleTranscript.length,
    getScrollElement: () => transcriptRef.current,
    estimateSize: (index) => estimateEntryHeight(visibleTranscript[index]),
    overscan: 8,
    measureElement: (element) => element.getBoundingClientRect().height,
  });

  const lastEntrySignature = useMemo(() => {
    const lastEntry = displayTranscript[displayTranscript.length - 1];
    if (!lastEntry) {
      return "";
    }
    const lastRow = chatTranscriptMeta.lastRow;
    return `${lastEntry.id}:${lastEntry.text.length}:${lastEntry.status ?? ""}:${lastRow?.reasoning?.text.length ?? 0}`;
  }, [chatTranscriptMeta.lastRow, displayTranscript]);

  useLayoutEffect(() => {
    const scrollElement = transcriptRef.current;
    const pending = prependPendingRef.current;
    if (!scrollElement || !pending) {
      return;
    }
    const delta = scrollElement.scrollHeight - pending.previousHeight;
    scrollElement.scrollTop = pending.previousTop + delta;
    prependPendingRef.current = null;
  }, [visibleTranscript.length]);

  useLayoutEffect(() => {
    const scrollElement = transcriptRef.current;
    if (!scrollElement || prependPendingRef.current || !stickToBottomRef.current) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      scrollElement.scrollTop = scrollElement.scrollHeight;
      setShowScrollToBottom(false);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [lastEntrySignature, visibleTranscript.length]);

  const handleTranscriptScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const isNearBottom = distanceToBottom <= 64;
    stickToBottomRef.current = isNearBottom;
    setShowScrollToBottom(!isNearBottom);
    if (!hasOlderTranscript || loadingOlderTranscript || prependPendingRef.current || element.scrollTop > 120) {
      return;
    }
    prependPendingRef.current = {
      previousHeight: element.scrollHeight,
      previousTop: element.scrollTop,
    };
    onLoadOlderTranscriptPage();
  };

  const scrollTranscriptToBottom = () => {
    const scrollElement = transcriptRef.current;
    if (!scrollElement) {
      return;
    }
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    scrollElement.scrollTop = scrollElement.scrollHeight;
  };

  const prepareForOutgoingMessage = () => {
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
  };

  const resetTranscriptUiState = () => {
    prependPendingRef.current = null;
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    chatTranscriptMetaCacheRef.current = {
      transcript: [],
      rowCounts: [],
      rowCount: 0,
    };
  };

  return {
    transcriptRef,
    transcript,
    displayTranscript,
    visibleTranscript,
    hasOlderTranscript,
    showScrollToBottom,
    virtualItems: rowVirtualizer.getVirtualItems().map((item) => ({
      index: item.index,
      key: item.key,
      start: item.start,
    })),
    measureRow: (node: HTMLDivElement | null) => {
      if (node) {
        rowVirtualizer.measureElement(node);
      }
    },
    totalSize: rowVirtualizer.getTotalSize(),
    chatRowCount: chatTranscriptMeta.rowCount,
    handleTranscriptScroll,
    scrollTranscriptToBottom,
    prepareForOutgoingMessage,
    resetTranscriptUiState,
  };
}

function createReasoningHostRow(reasoning: TranscriptEntry): ChatTranscriptRow {
  return {
    id: `${reasoning.id}:reasoning`,
    entry: {
      ...reasoning,
      kind: "assistant",
      text: "",
    },
    reasoning,
  };
}

function createChatTranscriptRow(
  transcript: TranscriptEntry[],
  index: number,
): ChatTranscriptRow | undefined {
  const entry = transcript[index];
  if (!entry || entry.kind === "reasoning") {
    return undefined;
  }
  const previous = transcript[index - 1];
  if (entry.kind === "assistant" && previous?.kind === "reasoning") {
    return {
      id: entry.id,
      entry,
      reasoning: previous,
    };
  }
  return { id: entry.id, entry };
}

function findChatTranscriptRebuildStart(
  transcript: TranscriptEntry[],
  previousTranscript: TranscriptEntry[],
): number {
  const sharedLength = Math.min(transcript.length, previousTranscript.length);
  let rebuildStart = 0;

  while (rebuildStart < sharedLength && transcript[rebuildStart] === previousTranscript[rebuildStart]) {
    rebuildStart += 1;
  }

  if (rebuildStart === transcript.length && rebuildStart === previousTranscript.length) {
    return -1;
  }

  while (
    rebuildStart > 0 &&
    (transcript[rebuildStart - 1]?.kind === "reasoning" ||
      previousTranscript[rebuildStart - 1]?.kind === "reasoning")
  ) {
    rebuildStart -= 1;
  }

  return rebuildStart;
}

function analyzeChatTranscript(
  transcript: TranscriptEntry[],
  previous?: ChatTranscriptMetaCache,
): ChatTranscriptMetaCache {
  const rebuildStart =
    previous?.transcript?.length
      ? findChatTranscriptRebuildStart(transcript, previous.transcript)
      : 0;

  if (rebuildStart === -1 && previous) {
    return previous;
  }

  const rowCounts = rebuildStart > 0 && previous ? previous.rowCounts.slice(0, rebuildStart) : [];
  let rowCount = rebuildStart > 0 && previous ? (previous.rowCounts[rebuildStart - 1] ?? 0) : 0;
  let lastRow =
    rebuildStart > 0
      ? createChatTranscriptRow(transcript, rebuildStart - 1) ?? previous?.lastRow
      : undefined;
  let pendingReasoning: TranscriptEntry | undefined;
  let pendingReasoningIndex = -1;

  const flushReasoning = () => {
    if (!pendingReasoning || pendingReasoningIndex === -1) {
      return;
    }
    rowCount += 1;
    lastRow = createReasoningHostRow(pendingReasoning);
    rowCounts[pendingReasoningIndex] = rowCount;
    pendingReasoning = undefined;
    pendingReasoningIndex = -1;
  };

  for (let index = rebuildStart; index < transcript.length; index += 1) {
    const entry = transcript[index];
    if (!entry) {
      continue;
    }

    if (entry.kind === "reasoning") {
      pendingReasoning = entry;
      pendingReasoningIndex = index;
      rowCounts[index] = rowCount;
      continue;
    }

    if (entry.kind === "assistant") {
      rowCount += 1;
      lastRow = createChatTranscriptRow(transcript, index);
      pendingReasoning = undefined;
      pendingReasoningIndex = -1;
      rowCounts[index] = rowCount;
      continue;
    }

    if (pendingReasoning) {
      flushReasoning();
    }

    rowCount += 1;
    lastRow = createChatTranscriptRow(transcript, index);
    rowCounts[index] = rowCount;
  }

  if (pendingReasoning) {
    flushReasoning();
  }

  return {
    transcript,
    rowCounts,
    rowCount,
    lastRow,
  };
}

function buildVisibleChatTranscriptRows(
  transcript: TranscriptEntry[],
  visibleCount: number,
): ChatTranscriptRow[] {
  if (!visibleCount) {
    return [];
  }

  const reversedRows: ChatTranscriptRow[] = [];

  for (let index = transcript.length - 1; index >= 0 && reversedRows.length < visibleCount; index -= 1) {
    const entry = transcript[index];
    if (!entry) {
      continue;
    }

    if (entry.kind === "reasoning") {
      const row = createChatTranscriptRow(transcript, index);
      if (!row) {
        continue;
      }
      reversedRows.push(row);
      continue;
    }

    if (entry.kind === "assistant") {
      const row = createChatTranscriptRow(transcript, index);
      if (!row) {
        continue;
      }
      if (row.reasoning) {
        index -= 1;
      }
      reversedRows.push(row);
      continue;
    }

    reversedRows.push({
      id: entry.id,
      entry,
    });
  }

  return reversedRows.reverse();
}

function estimateEntryHeight(row: ChatTranscriptRow | undefined) {
  if (!row) {
    return 140;
  }

  const reasoningLines = row.reasoning?.text ? Math.min(10, row.reasoning.text.split("\n").length) : 0;
  const contentLines = row.entry.text
    ? Math.min(TOOL_LINE_LIMIT, row.entry.text.split("\n").length)
    : 0;

  return 96 + contentLines * 18 + reasoningLines * 16;
}
