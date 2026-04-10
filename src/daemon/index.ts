import "dotenv/config";
import packageJson from "../../package.json" with { type: "json" };
import { ManagementBridge } from "./managementBridge.js";
import { ProjectManager } from "./projectManager.js";
import { SessionManager } from "./sessionManager.js";

const sessionManager = new SessionManager();
const projectManager = new ProjectManager(sessionManager);
const managementServerUrl = process.env.MANAGEMENT_SERVER_URL;

if (!managementServerUrl) {
  throw new Error("MANAGEMENT_SERVER_URL is required");
}

const bridge = new ManagementBridge(projectManager, {
  serverUrl: managementServerUrl,
  daemonId: process.env.DAEMON_ID,
  daemonName: process.env.DAEMON_NAME,
});
bridge.start();

console.log(`OhMyVibe daemon connecting to ${managementServerUrl}`);
console.log(`OhMyVibe daemon version ${packageJson.version}`);
