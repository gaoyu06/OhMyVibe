import "dotenv/config";
import express from "express";
import http from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { DaemonEvent } from "../src/shared/types.js";

interface DaemonDescriptor {
  id: string;
  name: string;
  platform: string;
  cwd: string;
  connectedAt: string;
  lastSeenAt: string;
  online: boolean;
  sessionCount: number;
}

interface ConnectedDaemon {
  descriptor: DaemonDescriptor;
  socket: WebSocket;
}

interface ClientSubscription {
  daemonId: string | null;
  sessionId: string | null;
}

const app = express();
app.use(express.json());

const port = Number(process.env.PORT ?? "3310");
const rootDir = path.resolve(process.cwd());
const clientDistDir = path.join(rootDir, "dist");
const server = http.createServer(app);
const daemonWss = new WebSocketServer({ noServer: true });
const clientWss = new WebSocketServer({ noServer: true });
const daemons = new Map<string, ConnectedDaemon>();
const clientSubscriptions = new WeakMap<WebSocket, ClientSubscription>();
const pending = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }
>();

app.use(express.static(clientDistDir));

app.get("/api/daemons", (_req, res) => {
  res.json(Array.from(daemons.values()).map((item) => item.descriptor));
});

app.get("/api/daemons/:daemonId/config", async (req, res) => {
  try {
    res.json(await requestDaemon(req.params.daemonId, "getConfig"));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/daemons/:daemonId/sessions", async (req, res) => {
  try {
    res.json(await requestDaemon(req.params.daemonId, "listSessions"));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/daemons/:daemonId/history", async (req, res) => {
  try {
    res.json(await requestDaemon(req.params.daemonId, "listHistory"));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/daemons/:daemonId/directories", async (req, res) => {
  try {
    const pathParam = typeof req.query.path === "string" ? req.query.path : undefined;
    res.json(
      await requestDaemon(req.params.daemonId, "browseDirectories", {
        path: pathParam,
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/daemons/:daemonId/sessions/:sessionId", async (req, res) => {
  try {
    const session = await requestDaemon(req.params.daemonId, "getSession", {
      sessionId: req.params.sessionId,
    });
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(session);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/daemons/:daemonId/sessions/:sessionId/files", async (req, res) => {
  try {
    const pathParam = typeof req.query.path === "string" ? req.query.path : undefined;
    res.json(
      await requestDaemon(req.params.daemonId, "browseSessionFiles", {
        sessionId: req.params.sessionId,
        path: pathParam,
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/daemons/:daemonId/sessions/:sessionId/file", async (req, res) => {
  try {
    const pathParam = typeof req.query.path === "string" ? req.query.path : "";
    res.json(
      await requestDaemon(req.params.daemonId, "readSessionFile", {
        sessionId: req.params.sessionId,
        path: pathParam,
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put("/api/daemons/:daemonId/sessions/:sessionId/file", async (req, res) => {
  try {
    res.json(
      await requestDaemon(req.params.daemonId, "writeSessionFile", {
        sessionId: req.params.sessionId,
        path: req.body?.path ?? "",
        content: req.body?.content ?? "",
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/daemons/:daemonId/sessions", async (req, res) => {
  try {
    res.status(201).json(await requestDaemon(req.params.daemonId, "createSession", req.body ?? {}));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/daemons/:daemonId/history/:threadId/restore", async (req, res) => {
  try {
    res.status(201).json(
      await requestDaemon(req.params.daemonId, "restoreSession", {
        ...(req.body ?? {}),
        threadId: req.params.threadId,
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/daemons/:daemonId/sessions/:sessionId/messages", async (req, res) => {
  try {
    res.status(202).json(
      await requestDaemon(req.params.daemonId, "sendMessage", {
        sessionId: req.params.sessionId,
        text: req.body?.text ?? "",
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.patch("/api/daemons/:daemonId/sessions/:sessionId/config", async (req, res) => {
  try {
    res.json(
      await requestDaemon(req.params.daemonId, "updateSessionConfig", {
        sessionId: req.params.sessionId,
        ...(req.body ?? {}),
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.patch("/api/daemons/:daemonId/sessions/:sessionId/title", async (req, res) => {
  try {
    res.json(
      await requestDaemon(req.params.daemonId, "renameSession", {
        sessionId: req.params.sessionId,
        title: req.body?.title ?? "",
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/daemons/:daemonId/sessions/:sessionId/interrupt", async (req, res) => {
  try {
    res.status(202).json(
      await requestDaemon(req.params.daemonId, "interruptSession", {
        sessionId: req.params.sessionId,
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/daemons/:daemonId/sessions/:sessionId/approvals/:approvalId", async (req, res) => {
  try {
    res.json(
      await requestDaemon(req.params.daemonId, "respondApproval", {
        sessionId: req.params.sessionId,
        approvalRequestId: req.params.approvalId,
        decision: req.body?.decision === "deny" ? "deny" : "approve",
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/daemons/:daemonId/sessions/:sessionId", async (req, res) => {
  try {
    await requestDaemon(req.params.daemonId, "closeSession", {
      sessionId: req.params.sessionId,
    });
    res.status(204).end();
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/{*any}", (_req, res) => {
  res.sendFile(path.join(clientDistDir, "index.html"));
});

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;

  if (pathname === "/daemon") {
    daemonWss.handleUpgrade(request, socket, head, (ws) => {
      daemonWss.emit("connection", ws, request);
    });
    return;
  }

  if (pathname === "/ws") {
    clientWss.handleUpgrade(request, socket, head, (ws) => {
      clientWss.emit("connection", ws, request);
    });
    return;
  }

  socket.destroy();
});

daemonWss.on("connection", (socket) => {
  let daemonId: string | undefined;

  socket.on("message", (raw) => {
    const payload = JSON.parse(String(raw));

    if (payload.type === "daemon-hello") {
      const helloId = typeof payload?.daemon?.id === "string" ? payload.daemon.id : "";
      if (!helloId) {
        return;
      }
      daemonId = helloId;
      const descriptor = {
        ...payload.daemon,
        lastSeenAt: new Date().toISOString(),
        online: true,
        sessionCount: Array.isArray(payload.sessions) ? payload.sessions.length : 0,
      };
      daemons.set(helloId, {
        descriptor,
        socket,
      });
      broadcast({
        type: "daemon-connected",
        daemon: descriptor,
      });
      return;
    }

    if (payload.type === "daemon-response") {
      const requestId = String(payload.requestId || "");
      const record = pending.get(requestId);
      if (!record) {
        return;
      }
      clearTimeout(record.timeout);
      pending.delete(requestId);
      if (payload.ok) {
        record.resolve(payload.data);
      } else {
        record.reject(new Error(payload.error || "daemon_request_failed"));
      }
      return;
    }

    if (payload.type === "daemon-event" && daemonId) {
      const current = daemons.get(daemonId);
      if (current) {
        current.descriptor.lastSeenAt = new Date().toISOString();
      }
      dispatchDaemonEvent(daemonId, payload.event as DaemonEvent);
      return;
    }

    if (payload.type === "daemon-events" && daemonId && Array.isArray(payload.events)) {
      const current = daemons.get(daemonId);
      if (current) {
        current.descriptor.lastSeenAt = new Date().toISOString();
      }
      dispatchDaemonEvents(daemonId, payload.events as DaemonEvent[]);
    }
  });

  socket.on("close", () => {
    if (!daemonId) {
      return;
    }
    const current = daemons.get(daemonId);
    if (!current) {
      return;
    }
    current.descriptor.online = false;
    current.descriptor.lastSeenAt = new Date().toISOString();
    daemons.delete(daemonId);
    broadcast({ type: "daemon-disconnected", daemonId });
  });
});

clientWss.on("connection", (socket) => {
  clientSubscriptions.set(socket, { daemonId: null, sessionId: null });

  socket.send(
    JSON.stringify({
      type: "hello",
      daemons: Array.from(daemons.values()).map((item) => item.descriptor),
    }),
  );

  socket.on("message", (raw) => {
    const payload = JSON.parse(String(raw));
    if (payload.type !== "client-subscribe") {
      return;
    }

    const daemonId = typeof payload.daemonId === "string" && payload.daemonId.trim()
      ? payload.daemonId.trim()
      : null;
    const sessionId = daemonId && typeof payload.sessionId === "string" && payload.sessionId.trim()
      ? payload.sessionId.trim()
      : null;

    clientSubscriptions.set(socket, { daemonId, sessionId });
  });
});

server.listen(port, () => {
  console.log(`OhMyVibe control server listening on http://localhost:${port}`);
});

function broadcast(payload: unknown) {
  const serialized = JSON.stringify(payload);
  for (const client of clientWss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  }
}

function requestDaemon(daemonId: string, method: string, params: Record<string, unknown> = {}) {
  const daemon = daemons.get(daemonId);
  if (!daemon) {
    throw new Error(`Daemon not connected: ${daemonId}`);
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  daemon.socket.send(
    JSON.stringify({
      type: "daemon-request",
      requestId,
      method,
      params,
    }),
  );

  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Daemon request timeout: ${method}`));
    }, 30000);
    pending.set(requestId, { resolve, reject, timeout });
  });
}

function dispatchDaemonEvent(daemonId: string, event: DaemonEvent) {
  let serialized: string | undefined;
  for (const client of clientWss.clients) {
    if (client.readyState !== WebSocket.OPEN) {
      continue;
    }
    const subscription = clientSubscriptions.get(client);
    if (!shouldSendDaemonEvent(subscription, daemonId, event)) {
      continue;
    }
    serialized ??= JSON.stringify({
      type: "daemon-event",
      daemonId,
      event,
    });
    client.send(serialized);
  }
}

function dispatchDaemonEvents(daemonId: string, events: DaemonEvent[]) {
  if (!events.length) {
    return;
  }

  const clientsBySessionId = new Map<string | null, WebSocket[]>();
  for (const client of clientWss.clients) {
    if (client.readyState !== WebSocket.OPEN) {
      continue;
    }
    const subscription = clientSubscriptions.get(client);
    if (!subscription || subscription.daemonId !== daemonId) {
      continue;
    }

    const sessionId = subscription.sessionId ?? null;
    const clients = clientsBySessionId.get(sessionId);
    if (clients) {
      clients.push(client);
      continue;
    }
    clientsBySessionId.set(sessionId, [client]);
  }

  const partitionedEvents = partitionDaemonEvents(events);
  const serializedPayloads = new Map<string | null, string>();

  for (const [sessionId, clients] of clientsBySessionId) {
    const filteredEvents = getPartitionedEventsForSession(partitionedEvents, sessionId);
    if (!filteredEvents.length) {
      continue;
    }

    let serialized = serializedPayloads.get(sessionId);
    if (!serialized) {
      serialized = JSON.stringify({
        type: "daemon-events",
        daemonId,
        events: filteredEvents,
      });
      serializedPayloads.set(sessionId, serialized);
    }

    for (const client of clients) {
      client.send(serialized);
    }
  }
}

function partitionDaemonEvents(events: DaemonEvent[]) {
  const sharedEvents: DaemonEvent[] = [];
  const sessionEvents = new Map<string, DaemonEvent[]>();

  for (const event of events) {
    switch (event.type) {
      case "session-created":
      case "session-updated":
      case "session-deleted":
        sharedEvents.push(event);
        break;
      case "session-entry":
      case "session-entry-updated":
      case "session-entries-updated":
      case "session-reset": {
        const bucket = sessionEvents.get(event.sessionId);
        if (bucket) {
          bucket.push(event);
          continue;
        }
        sessionEvents.set(event.sessionId, [event]);
        break;
      }
      default:
        break;
    }
  }

  return { sharedEvents, sessionEvents };
}

function getPartitionedEventsForSession(
  partitioned: ReturnType<typeof partitionDaemonEvents>,
  sessionId: string | null,
) {
  if (!sessionId) {
    return partitioned.sharedEvents;
  }

  const targetedEvents = partitioned.sessionEvents.get(sessionId);
  if (!targetedEvents?.length) {
    return partitioned.sharedEvents;
  }

  if (!partitioned.sharedEvents.length) {
    return targetedEvents;
  }

  return [...partitioned.sharedEvents, ...targetedEvents];
}

function shouldSendDaemonEvent(
  subscription: ClientSubscription | undefined,
  daemonId: string,
  event: DaemonEvent,
) {
  if (!subscription || subscription.daemonId !== daemonId) {
    return false;
  }

  switch (event.type) {
    case "session-created":
    case "session-updated":
    case "session-deleted":
      return true;
    case "session-entry":
    case "session-entry-updated":
    case "session-entries-updated":
    case "session-reset":
      return subscription.sessionId === event.sessionId;
    default:
      return false;
  }
}
