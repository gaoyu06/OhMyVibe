import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import {
  CreateSessionInput,
  DaemonEvent,
  RestoreSessionInput,
  SendMessageInput,
} from "../shared/types.js";
import { SessionManager } from "./sessionManager.js";

export function startHttpServer(sessionManager: SessionManager, port: number): http.Server {
  const app = express();
  const allowOrigin = process.env.ALLOW_ORIGIN ?? "*";

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json());

  app.get("/api/sessions", (_req, res) => {
    res.json(sessionManager.list());
  });

  app.get("/api/config", async (_req, res) => {
    try {
      res.json(await sessionManager.getConfig());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/history", async (_req, res) => {
    try {
      res.json(await sessionManager.listHistory());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/sessions", async (req, res) => {
    try {
      const body = req.body as CreateSessionInput;
      const session = await sessionManager.create(body);
      res.status(201).json(session);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/history/:threadId/restore", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<RestoreSessionInput>;
      const session = await sessionManager.restore({
        threadId: req.params.threadId,
        cwd: body.cwd,
        model: body.model,
        reasoningEffort: body.reasoningEffort,
        sandbox: body.sandbox,
        approvalPolicy: body.approvalPolicy,
      });
      res.status(201).json(session);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/sessions/:sessionId", (req, res) => {
    const session = sessionManager.get(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(session);
  });

  app.post("/api/sessions/:sessionId/messages", async (req, res) => {
    try {
      const body = req.body as SendMessageInput;
      await sessionManager.sendMessage(req.params.sessionId, body.text);
      res.status(202).json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/sessions/:sessionId/interrupt", async (req, res) => {
    try {
      await sessionManager.interrupt(req.params.sessionId);
      res.status(202).json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/sessions/:sessionId", async (req, res) => {
    try {
      await sessionManager.close(req.params.sessionId);
      res.status(204).end();
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/", (_req, res) => {
    res.json({ name: "ohmyvibe-daemon", ok: true });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "hello", sessions: sessionManager.list() }));

    const listener = (event: DaemonEvent) => {
      socket.send(JSON.stringify(event));
    };

    sessionManager.on("event", listener);
    socket.on("close", () => {
      sessionManager.off("event", listener);
    });
  });

  server.listen(port);
  return server;
}
