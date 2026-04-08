import { useEffect, useRef, useState } from "react";
import { sendControlSubscription, toControlWsUrl } from "@/lib/controlApi";
import type { DaemonDescriptor, DaemonEvent } from "@/lib/types";

export type ConnectionState = "connecting" | "open" | "closed" | "error";

type DaemonSocketPayload =
  | { type: "hello"; daemons?: DaemonDescriptor[] }
  | { type: "daemon-connected"; daemon: DaemonDescriptor }
  | { type: "daemon-disconnected"; daemonId: string }
  | { type: "daemon-event"; daemonId: string; event: DaemonEvent }
  | { type: "daemon-events"; daemonId: string; events: DaemonEvent[] };

export function useDaemonConnection({
  controlUrl,
  activeDaemonId,
  activeSessionId,
  subscribedSessionId,
  onHelloDaemons,
  onDaemonConnected,
  onDaemonDisconnected,
  onDaemonEvent,
  onFlushActiveSessionEvents,
}: {
  controlUrl: string;
  activeDaemonId: string | null;
  activeSessionId: string | null;
  subscribedSessionId: string | null;
  onHelloDaemons: (daemons: DaemonDescriptor[]) => void;
  onDaemonConnected: (daemon: DaemonDescriptor) => void;
  onDaemonDisconnected: (daemonId: string) => void;
  onDaemonEvent: (event: DaemonEvent) => void;
  onFlushActiveSessionEvents: (events: DaemonEvent[]) => void;
}) {
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const latestSubscriptionRef = useRef<{ daemonId: string | null; sessionId: string | null }>({
    daemonId: null,
    sessionId: null,
  });
  const activeSessionIdRef = useRef<string | null>(null);
  const queuedActiveSessionEventsRef = useRef<DaemonEvent[]>([]);
  const queuedActiveSessionFlushRef = useRef<number | null>(null);
  const onHelloDaemonsRef = useRef(onHelloDaemons);
  const onDaemonConnectedRef = useRef(onDaemonConnected);
  const onDaemonDisconnectedRef = useRef(onDaemonDisconnected);
  const onDaemonEventRef = useRef(onDaemonEvent);
  const onFlushActiveSessionEventsRef = useRef(onFlushActiveSessionEvents);

  const flushQueuedActiveSessionEvents = () => {
    const queuedEvents = queuedActiveSessionEventsRef.current;
    queuedActiveSessionEventsRef.current = [];
    if (queuedActiveSessionFlushRef.current !== null) {
      window.clearTimeout(queuedActiveSessionFlushRef.current);
      queuedActiveSessionFlushRef.current = null;
    }
    if (!queuedEvents.length) {
      return;
    }
    onFlushActiveSessionEventsRef.current(queuedEvents);
  };

  const queueActiveSessionEvent = (event: DaemonEvent) => {
    if (!("sessionId" in event) || event.sessionId !== activeSessionIdRef.current) {
      onDaemonEventRef.current(event);
      return;
    }

    queuedActiveSessionEventsRef.current.push(event);
    if (queuedActiveSessionFlushRef.current !== null) {
      return;
    }

    queuedActiveSessionFlushRef.current = window.setTimeout(() => {
      flushQueuedActiveSessionEvents();
    }, 32);
  };

  useEffect(() => {
    onHelloDaemonsRef.current = onHelloDaemons;
    onDaemonConnectedRef.current = onDaemonConnected;
    onDaemonDisconnectedRef.current = onDaemonDisconnected;
    onDaemonEventRef.current = onDaemonEvent;
    onFlushActiveSessionEventsRef.current = onFlushActiveSessionEvents;
  }, [onDaemonConnected, onDaemonDisconnected, onDaemonEvent, onFlushActiveSessionEvents, onHelloDaemons]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    queuedActiveSessionEventsRef.current = [];
    if (queuedActiveSessionFlushRef.current !== null) {
      window.clearTimeout(queuedActiveSessionFlushRef.current);
      queuedActiveSessionFlushRef.current = null;
    }
  }, [activeSessionId]);

  useEffect(() => {
    return () => {
      if (queuedActiveSessionFlushRef.current !== null) {
        window.clearTimeout(queuedActiveSessionFlushRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const ws = new WebSocket(toControlWsUrl(controlUrl));
    wsRef.current = ws;
    setConnectionState("connecting");

    ws.onopen = () => {
      if (!disposed) {
        setConnectionState("open");
        sendControlSubscription(ws, latestSubscriptionRef.current);
      }
    };
    ws.onerror = () => {
      if (!disposed) {
        setConnectionState("error");
      }
    };
    ws.onclose = () => {
      if (!disposed) {
        setConnectionState("closed");
      }
    };
    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data) as DaemonSocketPayload;

      if (payload.type === "hello") {
        onHelloDaemonsRef.current(Array.isArray(payload.daemons) ? payload.daemons : []);
        return;
      }

      if (payload.type === "daemon-connected") {
        onDaemonConnectedRef.current(payload.daemon);
        return;
      }

      if (payload.type === "daemon-disconnected") {
        onDaemonDisconnectedRef.current(payload.daemonId);
        return;
      }

      const incomingEvents = payload.type === "daemon-event" ? [payload.event] : payload.events;
      for (const daemonEvent of incomingEvents) {
        if (isBufferedActiveSessionEvent(daemonEvent)) {
          queueActiveSessionEvent(daemonEvent);
          continue;
        }
        onDaemonEventRef.current(daemonEvent);
      }
    };

    return () => {
      disposed = true;
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      ws.close();
    };
  }, [controlUrl]);

  useEffect(() => {
    const nextSubscription = {
      daemonId: activeDaemonId,
      sessionId: subscribedSessionId,
    };
    latestSubscriptionRef.current = nextSubscription;
    sendControlSubscription(wsRef.current, nextSubscription);
  }, [activeDaemonId, subscribedSessionId]);

  return connectionState;
}

function isBufferedActiveSessionEvent(event: DaemonEvent) {
  return (
    event.type === "session-entry" ||
    event.type === "session-entry-updated" ||
    event.type === "session-entries-updated" ||
    event.type === "session-reset"
  );
}
