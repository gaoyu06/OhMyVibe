import { startHttpServer } from "./httpServer.js";
import { SessionManager } from "./sessionManager.js";

const port = Number(process.env.PORT ?? "3210");
const sessionManager = new SessionManager();
startHttpServer(sessionManager, port);

console.log(`OhMyVibe daemon listening on http://localhost:${port}`);
