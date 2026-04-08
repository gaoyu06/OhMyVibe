import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "@/lib/types";

const OVERVIEW_LAYOUT_STORAGE_KEY = "ohmyvibe-overview-layouts";
const OVERVIEW_CARD_WIDTH = 336;
const OVERVIEW_CARD_HEIGHT = 280;
const OVERVIEW_CARD_GAP = 20;

type OverviewCardLayout = { x: number; y: number; width: number; height: number };
type OverviewLayoutStore = Record<string, Record<string, OverviewCardLayout>>;

export function useOverviewLayouts({
  activeDaemonId,
  activeProjectId,
  overviewSessions,
}: {
  activeDaemonId: string | null;
  activeProjectId: string | null;
  overviewSessions: SessionSummary[];
}) {
  const [overviewLayouts, setOverviewLayouts] = useState<OverviewLayoutStore>(() => loadOverviewLayouts());
  const overviewScrollRef = useRef<HTMLDivElement | null>(null);
  const overviewDragRef = useRef<{
    sessionId: string;
    key: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  const overviewLayoutKey = activeDaemonId && activeProjectId ? `${activeDaemonId}:${activeProjectId}` : "";
  const currentOverviewLayout = overviewLayoutKey ? overviewLayouts[overviewLayoutKey] ?? {} : {};
  const canvasStyle = useMemo(
    () => getOverviewCanvasStyle(currentOverviewLayout, overviewSessions),
    [currentOverviewLayout, overviewSessions],
  );

  useEffect(() => {
    localStorage.setItem(OVERVIEW_LAYOUT_STORAGE_KEY, JSON.stringify(overviewLayouts));
  }, [overviewLayouts]);

  useEffect(() => {
    if (!overviewLayoutKey) {
      return;
    }
    setOverviewLayouts((current) =>
      ensureOverviewLayoutStore(current, overviewLayoutKey, overviewSessions.map((session) => session.id)),
    );
  }, [overviewLayoutKey, overviewSessions]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = overviewDragRef.current;
      if (!drag) {
        return;
      }
      const container = overviewScrollRef.current;
      const scrollLeft = container?.scrollLeft ?? 0;
      const scrollTop = container?.scrollTop ?? 0;
      const nextX = Math.max(
        12,
        Math.round(drag.originX + (event.clientX - drag.startX) + (scrollLeft - drag.scrollLeft)),
      );
      const nextY = Math.max(
        12,
        Math.round(drag.originY + (event.clientY - drag.startY) + (scrollTop - drag.scrollTop)),
      );
      setOverviewLayouts((current) => updateOverviewLayoutPosition(current, drag.key, drag.sessionId, nextX, nextY));
    };

    const handlePointerUp = () => {
      overviewDragRef.current = null;
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  const startSessionDrag = (sessionId: string, clientX: number, clientY: number) => {
    if (!overviewLayoutKey) {
      return;
    }
    const layout = currentOverviewLayout[sessionId] ?? getDefaultOverviewCardLayout(0);
    overviewDragRef.current = {
      sessionId,
      key: overviewLayoutKey,
      startX: clientX,
      startY: clientY,
      originX: layout.x,
      originY: layout.y,
      scrollLeft: overviewScrollRef.current?.scrollLeft ?? 0,
      scrollTop: overviewScrollRef.current?.scrollTop ?? 0,
    };
    document.body.style.userSelect = "none";
  };

  return {
    overviewScrollRef,
    currentOverviewLayout,
    canvasStyle,
    startSessionDrag,
  };
}

function loadOverviewLayouts(): OverviewLayoutStore {
  try {
    const raw = localStorage.getItem(OVERVIEW_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as OverviewLayoutStore;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function ensureOverviewLayoutStore(
  store: OverviewLayoutStore,
  key: string,
  sessionIds: string[],
) {
  const current = store[key] ?? {};
  let changed = !store[key];
  const next = { ...current };
  sessionIds.forEach((sessionId, index) => {
    if (!next[sessionId]) {
      next[sessionId] = getDefaultOverviewCardLayout(index);
      changed = true;
    }
  });
  for (const sessionId of Object.keys(next)) {
    if (!sessionIds.includes(sessionId)) {
      delete next[sessionId];
      changed = true;
    }
  }
  if (!changed) {
    return store;
  }
  return {
    ...store,
    [key]: next,
  };
}

function getDefaultOverviewCardLayout(index: number): OverviewCardLayout {
  const column = index % 4;
  const row = Math.floor(index / 4);
  return {
    x: 20 + column * (OVERVIEW_CARD_WIDTH + OVERVIEW_CARD_GAP),
    y: 20 + row * (OVERVIEW_CARD_HEIGHT + OVERVIEW_CARD_GAP),
    width: OVERVIEW_CARD_WIDTH,
    height: OVERVIEW_CARD_HEIGHT,
  };
}

function updateOverviewLayoutPosition(
  store: OverviewLayoutStore,
  key: string,
  sessionId: string,
  x: number,
  y: number,
) {
  const current = store[key] ?? {};
  const layout = current[sessionId] ?? getDefaultOverviewCardLayout(0);
  return {
    ...store,
    [key]: {
      ...current,
      [sessionId]: {
        ...layout,
        x,
        y,
      },
    },
  };
}

function getOverviewCanvasStyle(
  layoutStore: Record<string, OverviewCardLayout>,
  sessions: SessionSummary[],
) {
  const layouts = sessions.map((session, index) => layoutStore[session.id] ?? getDefaultOverviewCardLayout(index));
  const width = Math.max(
    960,
    ...layouts.map((layout) => layout.x + layout.width + OVERVIEW_CARD_GAP),
  );
  const height = Math.max(
    520,
    ...layouts.map((layout) => layout.y + layout.height + OVERVIEW_CARD_GAP),
  );
  return {
    width,
    height,
  };
}
