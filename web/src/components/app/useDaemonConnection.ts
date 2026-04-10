import { useEffect, useRef, useState } from "react";
import { sendControlSubscription, toControlWsUrl } from "@/lib/controlApi";
import type { DaemonDescriptor, DaemonEvent } from "@/lib/types";

export type ConnectionState = "connecting" | "open" | "closed" | "error";

const SOCKET_OPEN_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 10_000;

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
  const reconnectTimerRef = useRef<number | null>(null);
  const connectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);

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
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (connectTimeoutRef.current !== null) {
        window.clearTimeout(connectTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const clearConnectTimeout = () => {
      if (connectTimeoutRef.current !== null) {
        window.clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimerRef.current !== null) {
        return;
      }

      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * Math.max(1, 2 ** reconnectAttemptRef.current),
        RECONNECT_MAX_DELAY_MS,
      );
      reconnectAttemptRef.current += 1;
      setConnectionState("connecting");
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    };

    const bindSocket = (ws: WebSocket) => {
      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) {
          ws.close();
          return;
        }

        clearConnectTimeout();
        clearReconnectTimer();
        reconnectAttemptRef.current = 0;
        setConnectionState("open");
        sendControlSubscription(ws, latestSubscriptionRef.current);
      };

      ws.onerror = () => {
        if (!disposed && wsRef.current === ws) {
          setConnectionState("error");
        }
      };

      ws.onclose = () => {
        clearConnectTimeout();
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        if (disposed) {
          setConnectionState("closed");
          return;
        }
        scheduleReconnect();
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
    };

    const connect = () => {
      if (disposed) {
        return;
      }

      clearConnectTimeout();
      const ws = new WebSocket(toControlWsUrl(controlUrl));
      wsRef.current = ws;
      setConnectionState("connecting");
      connectTimeoutRef.current = window.setTimeout(() => {
        if (wsRef.current === ws && ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      }, SOCKET_OPEN_TIMEOUT_MS);
      bindSocket(ws);
    };

    connect();

    return () => {
      disposed = true;
      clearReconnectTimer();
      clearConnectTimeout();
      const ws = wsRef.current;
      if (ws) {
        wsRef.current = null;
        ws.close();
      }
      setConnectionState("closed");
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
