import { startHttpServer } from "./httpServer.js";
import { ManagementBridge } from "./managementBridge.js";
import { SessionManager } from "./sessionManager.js";

const port = Number(process.env.PORT ?? "3210");
const sessionManager = new SessionManager();
startHttpServer(sessionManager, port);

const managementServerUrl = process.env.MANAGEMENT_SERVER_URL;
if (managementServerUrl) {
  const bridge = new ManagementBridge(sessionManager, {
    serverUrl: managementServerUrl,
    daemonId: process.env.DAEMON_ID,
    daemonName: process.env.DAEMON_NAME,
  });
  bridge.start();
}

console.log(`OhMyVibe daemon listening on http://localhost:${port}`);
