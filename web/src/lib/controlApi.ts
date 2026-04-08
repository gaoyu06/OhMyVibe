export function normalizeControlBaseUrl(value: string) {
  const normalized = value.trim() || window.location.origin;
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export async function fetchControlApi<T>(
  baseUrl: string,
  path: string,
  options?: RequestInit,
) {
  const response = await fetch(new URL(path, normalizeControlBaseUrl(baseUrl)).toString(), {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (response.status === 204) {
    return null as T;
  }

  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || "request_failed");
  }
  return payload;
}

export function toControlWsUrl(baseUrl: string) {
  const url = new URL(normalizeControlBaseUrl(baseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
}

export function sendControlSubscription(
  socket: WebSocket | null,
  subscription: { daemonId: string | null; sessionId: string | null },
) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(
    JSON.stringify({
      type: "client-subscribe",
      daemonId: subscription.daemonId,
      sessionId: subscription.sessionId,
    }),
  );
}
