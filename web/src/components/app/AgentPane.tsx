import { useEffect, useState } from "react";
import { Bell, Send, Trash2 } from "lucide-react";
import {
  getAgentRoleBadgeClassName,
  getAgentRoleEmoji,
  getAgentRoleLabel,
  getAgentRolePanelClassName,
} from "@/components/app/agentUi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import type { AgentDetails, AgentLogEntry, ProjectNotification } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

export function AgentPane({
  agent,
  notifications,
  onSendMessage,
  onClearLogs,
  clearingLogs,
}: {
  agent: AgentDetails | null;
  notifications: ProjectNotification[];
  onSendMessage: (text: string) => void;
  onClearLogs: () => void;
  clearingLogs: boolean;
}) {
  const [composer, setComposer] = useState("");

  if (!agent) {
    return (
      <div className="flex min-h-0 items-center justify-center bg-muted/10 p-4 text-sm text-muted-foreground">
        Select an agent
      </div>
    );
  }

  return (
    <>
      <div className="grid min-h-0 grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1fr)_320px]">
        <ScrollArea className="min-h-0 border-r border-border bg-muted/10">
          <div className="space-y-3 p-4">
            <div className={`rounded-xl border p-3 ${getAgentRolePanelClassName(agent.role)}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-lg leading-none">{getAgentRoleEmoji(agent.role)}</span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-[0.14em] ${getAgentRoleBadgeClassName(agent.role)}`}
                    >
                      {getAgentRoleLabel(agent.role)}
                    </span>
                  </div>
                  <div className="mt-2 text-sm font-medium">{agent.name}</div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    {agent.provider || "provider"} · {agent.model || "default model"} · {agent.status}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0"
                  disabled={clearingLogs || (!agent.logs.length && !agent.memory.summary)}
                  onClick={onClearLogs}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear Logs
                </Button>
              </div>
              {agent.boundSessionId ? (
                <div className="mt-1 text-xs text-muted-foreground">Bound session: {agent.boundSessionId}</div>
              ) : null}
              {agent.memory.summary ? (
                <div className="mt-3 rounded-lg border border-border/80 bg-muted/30 p-3 text-xs leading-5 text-muted-foreground whitespace-pre-wrap">
                  {agent.memory.summary}
                </div>
              ) : null}
            </div>
            {agent.logs.length ? (
              agent.logs.map((entry) => (
                <div key={entry.id} className="rounded-xl border border-border bg-card p-3">
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{entry.kind}</Badge>
                      <span>{entry.direction}</span>
                    </div>
                    <span>{formatDateTime(entry.createdAt)}</span>
                  </div>
                  {renderAgentLogContent(entry)}
                </div>
              ))
            ) : (
              <div className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">
                No agent logs
              </div>
            )}
          </div>
        </ScrollArea>
        <ScrollArea className="min-h-0 bg-background">
          <div className="space-y-3 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Bell className="h-4 w-4" />
              Notifications
            </div>
            {notifications.length ? (
              notifications.map((item) => (
                <div key={item.id} className="rounded-xl border border-border bg-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">{item.subject}</div>
                    <Badge
                      variant={
                        item.severity === "critical"
                          ? "destructive"
                          : item.severity === "warning"
                            ? "warning"
                            : "outline"
                      }
                    >
                      {item.channel}
                    </Badge>
                  </div>
                  <div className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
                    {item.body}
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-xl border border-dashed border-border p-3 text-sm text-muted-foreground">
                No notifications
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
      <div className="grid gap-2 border-t border-border p-3">
        <Textarea
          value={composer}
          onChange={(event) => setComposer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSendMessage(composer);
              setComposer("");
            }
          }}
          placeholder="Message agent"
          className="min-h-[96px] max-h-[128px]"
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={!composer.trim()}
            onClick={() => {
              onSendMessage(composer);
              setComposer("");
            }}
          >
            <Send className="h-3.5 w-3.5" />
            Send
          </Button>
        </div>
      </div>
    </>
  );
}

function renderAgentLogContent(entry: AgentLogEntry) {
  const structured = readStructuredAgentLog(entry);
  if (!structured) {
    return <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{entry.text}</div>;
  }

  const fields = [
    structured.action ? { label: "Action", value: structured.action } : null,
    structured.sessionTitle
      ? { label: "Session", value: `${structured.sessionTitle}${structured.sessionId ? ` (${structured.sessionId})` : ""}` }
      : structured.sessionId
        ? { label: "Session", value: structured.sessionId }
        : null,
    structured.targetAgentName
      ? {
          label: "Target",
          value: `${structured.targetAgentName}${structured.targetAgentId ? ` (${structured.targetAgentId})` : ""}`,
        }
      : structured.targetAgentId
        ? { label: "Target", value: structured.targetAgentId }
        : null,
    structured.sourceAgentName
      ? {
          label: "Source",
          value: `${structured.sourceAgentName}${structured.sourceAgentId ? ` (${structured.sourceAgentId})` : ""}`,
        }
      : structured.sourceAgentId
        ? { label: "Source", value: structured.sourceAgentId }
        : null,
    structured.cwd ? { label: "Cwd", value: structured.cwd } : null,
    structured.delegatedToForeman ? { label: "Delegated", value: "via foreman" } : null,
    structured.sessionStatus ? { label: "Status", value: structured.sessionStatus } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item?.value));

  return (
    <div className="mt-2 rounded-lg border border-border/70 bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{structured.action || entry.kind}</Badge>
        {structured.stopReason ? <Badge variant="outline">stop</Badge> : null}
      </div>
      {fields.length ? (
        <div className="mt-3 grid gap-2 text-sm">
          {fields.map((field) => (
            <div key={`${entry.id}-${field.label}`} className="grid gap-1">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{field.label}</div>
              <div className="break-words leading-6">{field.value}</div>
            </div>
          ))}
        </div>
      ) : null}
      {structured.instruction ? (
        <div className="mt-3 grid gap-1">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Instruction</div>
          <div className="whitespace-pre-wrap break-words text-sm leading-6">{structured.instruction}</div>
        </div>
      ) : null}
      {structured.text ? (
        <div className="mt-3 grid gap-1">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Message</div>
          <div className="whitespace-pre-wrap break-words text-sm leading-6">{structured.text}</div>
        </div>
      ) : null}
      {structured.userFacingText ? (
        <div className="mt-3 grid gap-1">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">User Update</div>
          <div className="whitespace-pre-wrap break-words text-sm leading-6">{structured.userFacingText}</div>
        </div>
      ) : null}
      {structured.stopReason ? (
        <div className="mt-3 grid gap-1">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Stop Reason</div>
          <div className="whitespace-pre-wrap break-words text-sm leading-6">{structured.stopReason}</div>
        </div>
      ) : null}
    </div>
  );
}

function readStructuredAgentLog(entry: AgentLogEntry) {
  const fromMeta = entry.meta && typeof entry.meta === "object" ? entry.meta : null;
  if (fromMeta && typeof fromMeta.action === "string") {
    const actionInput =
      fromMeta.actionInput && typeof fromMeta.actionInput === "object"
        ? (fromMeta.actionInput as Record<string, unknown>)
        : null;
    return {
      action: typeof fromMeta.action === "string" ? fromMeta.action : "",
      delegatedToForeman: Boolean(fromMeta.delegatedToForeman),
      instruction:
        typeof fromMeta.instruction === "string"
          ? fromMeta.instruction
          : actionInput && typeof actionInput.instruction === "string"
            ? actionInput.instruction
            : "",
      sessionId:
        typeof fromMeta.sessionId === "string"
          ? fromMeta.sessionId
          : actionInput && typeof actionInput.sessionId === "string"
            ? actionInput.sessionId
            : "",
      sessionTitle: typeof fromMeta.sessionTitle === "string" ? fromMeta.sessionTitle : "",
      sessionStatus: typeof fromMeta.sessionStatus === "string" ? fromMeta.sessionStatus : "",
      targetAgentId:
        typeof fromMeta.targetAgentId === "string"
          ? fromMeta.targetAgentId
          : actionInput && typeof actionInput.targetAgentId === "string"
            ? actionInput.targetAgentId
            : "",
      targetAgentName: typeof fromMeta.targetAgentName === "string" ? fromMeta.targetAgentName : "",
      sourceAgentId: typeof fromMeta.sourceAgentId === "string" ? fromMeta.sourceAgentId : "",
      sourceAgentName: typeof fromMeta.sourceAgentName === "string" ? fromMeta.sourceAgentName : "",
      cwd:
        typeof fromMeta.cwd === "string"
          ? fromMeta.cwd
          : actionInput && typeof actionInput.cwd === "string"
            ? actionInput.cwd
            : "",
      text: typeof fromMeta.text === "string" ? fromMeta.text : "",
      stopReason: typeof fromMeta.stopReason === "string" ? fromMeta.stopReason : "",
      userFacingText: typeof fromMeta.userFacingText === "string" ? fromMeta.userFacingText : "",
    };
  }

  if (entry.kind !== "decision") {
    return null;
  }

  try {
    const parsed = JSON.parse(entry.text) as Record<string, unknown>;
    if (typeof parsed.action !== "string") {
      return null;
    }
    return {
      action: parsed.action,
      delegatedToForeman: false,
      instruction:
        typeof parsed.actionInput === "object" &&
        parsed.actionInput &&
        typeof (parsed.actionInput as Record<string, unknown>).instruction === "string"
          ? ((parsed.actionInput as Record<string, unknown>).instruction as string)
          : "",
      sessionId:
        typeof parsed.actionInput === "object" &&
        parsed.actionInput &&
        typeof (parsed.actionInput as Record<string, unknown>).sessionId === "string"
          ? ((parsed.actionInput as Record<string, unknown>).sessionId as string)
          : "",
      sessionTitle: "",
      sessionStatus: "",
      targetAgentId:
        typeof parsed.actionInput === "object" &&
        parsed.actionInput &&
        typeof (parsed.actionInput as Record<string, unknown>).targetAgentId === "string"
          ? ((parsed.actionInput as Record<string, unknown>).targetAgentId as string)
          : "",
      targetAgentName: "",
      sourceAgentId: "",
      sourceAgentName: "",
      cwd:
        typeof parsed.actionInput === "object" &&
        parsed.actionInput &&
        typeof (parsed.actionInput as Record<string, unknown>).cwd === "string"
          ? ((parsed.actionInput as Record<string, unknown>).cwd as string)
          : "",
      text:
        typeof parsed.actionInput === "object" &&
        parsed.actionInput &&
        typeof (parsed.actionInput as Record<string, unknown>).text === "string"
          ? ((parsed.actionInput as Record<string, unknown>).text as string)
          : "",
      stopReason: typeof parsed.stopReason === "string" ? parsed.stopReason : "",
      userFacingText: typeof parsed.userFacingText === "string" ? parsed.userFacingText : "",
    };
  } catch {
    return null;
  }
}

export function SettingsEditor({
  settings,
  onSave,
}: {
  settings: import("@/lib/types").GlobalSettings;
  onSave: (settings: import("@/lib/types").GlobalSettings) => void;
}) {
  const [draft, setDraft] = useState(settings);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  return (
    <div className="grid gap-4 p-4">
      <div className="grid gap-2">
        <div className="text-sm font-medium">Provider</div>
        <select
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          value={draft.provider.apiFormat}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              provider: {
                ...current.provider,
                apiFormat:
                  event.target.value === "chat_completions" ? "chat_completions" : "responses",
              },
            }))
          }
        >
          <option value="responses">Responses API</option>
          <option value="chat_completions">Chat Completions API</option>
        </select>
        <input
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          value={draft.provider.baseUrl}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              provider: { ...current.provider, baseUrl: event.target.value },
            }))
          }
          placeholder="Base URL"
        />
        <input
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          value={draft.provider.apiKey}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              provider: { ...current.provider, apiKey: event.target.value },
            }))
          }
          placeholder="API key"
        />
        <input
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          value={draft.provider.model}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              provider: { ...current.provider, model: event.target.value },
            }))
          }
          placeholder="Model"
        />
      </div>
      <div className="grid gap-2">
        <div className="text-sm font-medium">SMTP</div>
        <input
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          value={draft.notifications.smtpHost}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              notifications: { ...current.notifications, smtpHost: event.target.value },
            }))
          }
          placeholder="SMTP host"
        />
        <input
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          value={String(draft.notifications.smtpPort)}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              notifications: {
                ...current.notifications,
                smtpPort: Number(event.target.value) || 0,
              },
            }))
          }
          placeholder="SMTP port"
        />
        <input
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          value={draft.notifications.smtpUser}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              notifications: { ...current.notifications, smtpUser: event.target.value },
            }))
          }
          placeholder="SMTP user"
        />
        <input
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          value={draft.notifications.smtpPass}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              notifications: { ...current.notifications, smtpPass: event.target.value },
            }))
          }
          placeholder="SMTP password"
        />
        <input
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          value={draft.notifications.smtpFrom}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              notifications: { ...current.notifications, smtpFrom: event.target.value },
            }))
          }
          placeholder="SMTP from"
        />
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={() => onSave(draft)}>
          Save Settings
        </Button>
      </div>
    </div>
  );
}
