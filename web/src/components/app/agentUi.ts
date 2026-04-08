import type { AgentRole } from "@/lib/types";
import { cn } from "@/lib/utils";

export function getAgentRoleEmoji(role: AgentRole) {
  switch (role) {
    case "steward":
      return "🧭";
    case "foreman":
      return "🛠️";
    case "sentinel":
      return "🛰️";
    default:
      return "🤖";
  }
}

export function getAgentRoleLabel(role: AgentRole) {
  switch (role) {
    case "steward":
      return "Steward";
    case "foreman":
      return "Foreman";
    case "sentinel":
      return "Sentinel";
    default:
      return role;
  }
}

export function getAgentRoleBadgeClassName(role: AgentRole) {
  switch (role) {
    case "steward":
      return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-200";
    case "foreman":
      return "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-200";
    case "sentinel":
      return "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-200";
    default:
      return "border-border bg-muted/30 text-foreground";
  }
}

export function getAgentRoleCardClassName(role: AgentRole, active: boolean) {
  const base =
    role === "steward"
      ? "border-amber-500/16 bg-amber-500/4 hover:bg-amber-500/8"
      : role === "foreman"
        ? "border-sky-500/16 bg-sky-500/4 hover:bg-sky-500/8"
        : role === "sentinel"
          ? "border-rose-500/16 bg-rose-500/4 hover:bg-rose-500/8"
          : "border-border/70 bg-card/45 hover:bg-accent/30";
  return cn(base, active && "ring-1 ring-foreground/12 shadow-[0_10px_24px_rgba(15,23,42,0.08)]");
}

export function getAgentRolePanelClassName(role: AgentRole) {
  switch (role) {
    case "steward":
      return "border-amber-500/18 bg-linear-to-br from-amber-500/8 via-card to-background";
    case "foreman":
      return "border-sky-500/18 bg-linear-to-br from-sky-500/8 via-card to-background";
    case "sentinel":
      return "border-rose-500/18 bg-linear-to-br from-rose-500/8 via-card to-background";
    default:
      return "border-border bg-card";
  }
}
