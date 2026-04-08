import { fetchControlApi } from "@/lib/controlApi";
import type {
  AgentDetails,
  AgentSummary,
  DaemonConfig,
  DirectoryBrowseResult,
  GlobalSettings,
  ProjectNotification,
  ProjectSummary,
  SessionDetails,
  SessionSummary,
  SessionTranscriptPage,
} from "@/lib/types";

export function getDaemonConfig(controlUrl: string, daemonId: string) {
  return fetchControlApi<DaemonConfig>(controlUrl, `/api/daemons/${daemonId}/config`);
}

export function listDaemonSessions(controlUrl: string, daemonId: string) {
  return fetchControlApi<SessionSummary[]>(controlUrl, `/api/daemons/${daemonId}/sessions`);
}

export function listDaemonProjects(controlUrl: string, daemonId: string) {
  return fetchControlApi<ProjectSummary[]>(controlUrl, `/api/daemons/${daemonId}/projects`);
}

export function listProjectAgents(controlUrl: string, daemonId: string, projectId: string) {
  return fetchControlApi<AgentSummary[]>(controlUrl, `/api/daemons/${daemonId}/projects/${projectId}/agents`);
}

export function getProjectAgent(controlUrl: string, daemonId: string, projectId: string, agentId: string) {
  return fetchControlApi<AgentDetails>(
    controlUrl,
    `/api/daemons/${daemonId}/projects/${projectId}/agents/${agentId}`,
  );
}

export function listProjectNotifications(controlUrl: string, daemonId: string, projectId: string) {
  return fetchControlApi<ProjectNotification[]>(
    controlUrl,
    `/api/daemons/${daemonId}/projects/${projectId}/notifications`,
  );
}

export function getDaemonSettings(controlUrl: string, daemonId: string) {
  return fetchControlApi<GlobalSettings>(controlUrl, `/api/daemons/${daemonId}/settings`);
}

export function getSessionDetails(
  controlUrl: string,
  daemonId: string,
  sessionId: string,
  limit: number,
) {
  return fetchControlApi<SessionDetails>(
    controlUrl,
    `/api/daemons/${daemonId}/sessions/${sessionId}?limit=${limit}`,
  );
}

export function getSessionTranscriptPage(
  controlUrl: string,
  daemonId: string,
  sessionId: string,
  beforeEntryId: string,
  limit: number,
) {
  return fetchControlApi<SessionTranscriptPage>(
    controlUrl,
    `/api/daemons/${daemonId}/sessions/${sessionId}/transcript?beforeEntryId=${encodeURIComponent(beforeEntryId)}&limit=${limit}`,
  );
}

export function browseDaemonDirectories(controlUrl: string, daemonId: string, nextPath?: string) {
  const query = nextPath ? `?path=${encodeURIComponent(nextPath)}` : "";
  return fetchControlApi<DirectoryBrowseResult>(controlUrl, `/api/daemons/${daemonId}/directories${query}`);
}

export function createProjectSession(
  controlUrl: string,
  daemonId: string,
  projectId: string,
  body: {
    cwd: string;
    model: string;
    reasoningEffort: string;
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
  },
) {
  return fetchControlApi<SessionDetails>(
    controlUrl,
    `/api/daemons/${daemonId}/projects/${projectId}/sessions`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

export function createProject(
  controlUrl: string,
  daemonId: string,
  body: {
    name: string;
    rootDir: string;
    goal: string;
    runPolicy: { mode: "until_blocked" };
  },
) {
  return fetchControlApi<ProjectSummary>(controlUrl, `/api/daemons/${daemonId}/projects`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function postSessionMessage(controlUrl: string, daemonId: string, sessionId: string, text: string) {
  return fetchControlApi<null>(controlUrl, `/api/daemons/${daemonId}/sessions/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export function runProject(controlUrl: string, daemonId: string, projectId: string) {
  return fetchControlApi<ProjectSummary>(controlUrl, `/api/daemons/${daemonId}/projects/${projectId}/run`, {
    method: "POST",
  });
}

export function pauseProject(controlUrl: string, daemonId: string, projectId: string) {
  return fetchControlApi<ProjectSummary>(controlUrl, `/api/daemons/${daemonId}/projects/${projectId}/pause`, {
    method: "POST",
  });
}

export function postAgentMessage(
  controlUrl: string,
  daemonId: string,
  projectId: string,
  agentId: string,
  text: string,
) {
  return fetchControlApi<AgentDetails>(
    controlUrl,
    `/api/daemons/${daemonId}/projects/${projectId}/agents/${agentId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ text }),
    },
  );
}

export function clearProjectAgentLogs(
  controlUrl: string,
  daemonId: string,
  projectId: string,
  agentId: string,
) {
  return fetchControlApi<AgentDetails>(
    controlUrl,
    `/api/daemons/${daemonId}/projects/${projectId}/agents/${agentId}/logs`,
    {
      method: "DELETE",
    },
  );
}

export function patchProviderSettings(controlUrl: string, daemonId: string, provider: GlobalSettings["provider"]) {
  return fetchControlApi<GlobalSettings>(controlUrl, `/api/daemons/${daemonId}/settings/provider`, {
    method: "PATCH",
    body: JSON.stringify(provider),
  });
}

export function patchNotificationSettings(
  controlUrl: string,
  daemonId: string,
  notifications: GlobalSettings["notifications"],
) {
  return fetchControlApi<GlobalSettings>(controlUrl, `/api/daemons/${daemonId}/settings/notifications`, {
    method: "PATCH",
    body: JSON.stringify(notifications),
  });
}

export function patchSessionConfig(
  controlUrl: string,
  daemonId: string,
  sessionId: string,
  body: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  },
) {
  return fetchControlApi<SessionDetails>(controlUrl, `/api/daemons/${daemonId}/sessions/${sessionId}/config`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function interruptSession(controlUrl: string, daemonId: string, sessionId: string) {
  return fetchControlApi<null>(controlUrl, `/api/daemons/${daemonId}/sessions/${sessionId}/interrupt`, {
    method: "POST",
  });
}

export function deleteSession(controlUrl: string, daemonId: string, sessionId: string) {
  return fetchControlApi<null>(controlUrl, `/api/daemons/${daemonId}/sessions/${sessionId}`, {
    method: "DELETE",
  });
}

export function renameSession(
  controlUrl: string,
  daemonId: string,
  sessionId: string,
  title: string,
) {
  return fetchControlApi<SessionDetails>(controlUrl, `/api/daemons/${daemonId}/sessions/${sessionId}/title`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

export function respondSessionApproval(
  controlUrl: string,
  daemonId: string,
  sessionId: string,
  requestId: string,
  decision: "approve" | "deny",
) {
  return fetchControlApi<SessionDetails>(
    controlUrl,
    `/api/daemons/${daemonId}/sessions/${sessionId}/approvals/${encodeURIComponent(requestId)}`,
    {
      method: "POST",
      body: JSON.stringify({ decision }),
    },
  );
}
