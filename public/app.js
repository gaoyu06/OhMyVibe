const state = {
  config: { models: [], defaultModel: undefined },
  sessions: [],
  history: [],
  activeSessionId: null,
  activeSession: null,
  expandedEntries: new Set(),
  rowHeights: new Map(),
  historyOpen: false,
  theme: localStorage.getItem("ohmyvibe-theme") || "light",
};

const WINDOW_SIZE = 36;
const OVERSCAN = 8;
const ESTIMATED_ROW_HEIGHT = 164;

const sessionListEl = document.getElementById("session-list");
const sessionCountEl = document.getElementById("session-count");
const metaEl = document.getElementById("session-meta");
const transcriptEl = document.getElementById("transcript");
const transcriptListEl = document.getElementById("transcript-list");
const transcriptTopSpacerEl = document.getElementById("transcript-top-spacer");
const transcriptBottomSpacerEl = document.getElementById("transcript-bottom-spacer");
const createSessionForm = document.getElementById("create-session-form");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const interruptButton = document.getElementById("interrupt-button");
const deleteButton = document.getElementById("delete-button");
const themeToggleButton = document.getElementById("theme-toggle");
const historyToggleButton = document.getElementById("history-toggle");
const modelSelectEl = document.getElementById("model-select");
const effortSelectEl = document.getElementById("effort-select");
const activityIndicatorEl = document.getElementById("activity-indicator");
const historyModalEl = document.getElementById("history-modal");
const historyBackdropEl = document.getElementById("history-backdrop");
const historyCloseButton = document.getElementById("history-close");
const historyListEl = document.getElementById("history-list");

applyTheme(state.theme);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (response.status === 204) {
    return null;
  }

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

function applyTheme(theme) {
  state.theme = theme;
  document.body.dataset.theme = theme;
  localStorage.setItem("ohmyvibe-theme", theme);
  themeToggleButton.textContent = theme === "dark" ? "浅色模式" : "深色模式";
}

function populateModelSelect() {
  modelSelectEl.innerHTML = "";

  for (const model of state.config.models) {
    const option = document.createElement("option");
    option.value = model.model;
    option.textContent = `${model.displayName} · ${model.description}`;
    option.selected = model.model === state.config.defaultModel;
    modelSelectEl.appendChild(option);
  }

  populateEffortSelect(modelSelectEl.value || state.config.defaultModel);
}

function populateEffortSelect(modelName) {
  const model = state.config.models.find((item) => item.model === modelName) || state.config.models[0];
  effortSelectEl.innerHTML = "";

  for (const effort of model?.supportedReasoningEfforts || []) {
    const option = document.createElement("option");
    option.value = effort.reasoningEffort;
    option.textContent = `${effort.reasoningEffort} · ${effort.description}`;
    option.selected = effort.reasoningEffort === model.defaultReasoningEffort;
    effortSelectEl.appendChild(option);
  }
}

function renderSessions() {
  sessionCountEl.textContent = String(state.sessions.length);
  sessionListEl.innerHTML = "";

  for (const session of state.sessions) {
    const button = document.createElement("button");
    button.className = `session-item ${session.id === state.activeSessionId ? "active" : ""}`;
    button.innerHTML = `
      <div class="session-title">${escapeHtml(session.title)}</div>
      <div class="session-origin">${escapeHtml(session.origin === "restored" ? "restored" : "local")}</div>
      <div class="session-meta">${escapeHtml(session.model || "default")} · ${escapeHtml(session.reasoningEffort || "medium")}</div>
      <div class="session-meta">${escapeHtml(session.status)} · ${escapeHtml(session.cwd)}</div>
    `;
    button.addEventListener("click", () => {
      state.activeSessionId = session.id;
      renderSessions();
      loadSession(session.id);
    });
    sessionListEl.appendChild(button);
  }
}

function renderMeta() {
  const session = state.activeSession;
  if (!session) {
    metaEl.className = "meta-bar empty";
    metaEl.textContent = "选择左侧会话开始交互";
    setActivityIndicator(null);
    return;
  }

  const activity = getActivity(session);
  const statusClass = getStatusClass(session.status);
  metaEl.className = "meta-bar";
  metaEl.innerHTML = `
      <div class="meta-main">
      <div class="meta-title">${escapeHtml(session.title)}</div>
      <div class="meta-subtitle">${escapeHtml(session.cwd)}</div>
      <div class="meta-subtitle">model: ${escapeHtml(session.model || "default")} · effort: ${escapeHtml(session.reasoningEffort || "medium")}</div>
      <div class="meta-subtitle">origin: ${escapeHtml(session.origin)} · source: ${escapeHtml(session.codexSource || "unknown")}</div>
    </div>
    <div class="meta-status">
      <span class="status-dot ${statusClass}"></span>
      <div>
        <div>${escapeHtml(activity?.label || session.status)}</div>
        <div class="meta-subtitle">thread: ${escapeHtml(session.codexThreadId || "pending")}</div>
      </div>
    </div>
  `;

  setActivityIndicator(activity);
}

function renderHistory() {
  historyModalEl.classList.toggle("hidden", !state.historyOpen);
  historyListEl.innerHTML = "";

  if (!state.history.length) {
    const empty = document.createElement("div");
    empty.className = "history-item-meta";
    empty.textContent = "没有可恢复的 Codex 历史会话";
    historyListEl.appendChild(empty);
    return;
  }

  for (const item of state.history) {
    const card = document.createElement("article");
    card.className = "history-item";
    card.innerHTML = `
      <div class="history-item-title">${escapeHtml(item.title || item.id)}</div>
      <div class="history-item-meta">cwd: ${escapeHtml(item.cwd || "unknown")}</div>
      <div class="history-item-meta">updated: ${escapeHtml(formatDateTime(item.updatedAt))}</div>
      <div class="history-item-meta">status: ${escapeHtml(item.status)} · source: ${escapeHtml(item.source || "unknown")}</div>
      <div class="history-item-meta">id: ${escapeHtml(item.id)}</div>
    `;

    const actions = document.createElement("div");
    actions.className = "history-actions";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "恢复到应用";
    button.addEventListener("click", async () => {
      await restoreHistorySession(item);
    });
    actions.appendChild(button);
    card.appendChild(actions);
    historyListEl.appendChild(card);
  }
}

function getStatusClass(status) {
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "";
}

function getActivity(session) {
  const transcript = session.transcript || [];
  const lastStreamingReasoning = [...transcript].reverse().find(
    (entry) => entry.kind === "reasoning" && entry.status === "streaming",
  );
  if (lastStreamingReasoning) {
    return { type: "reasoning", label: "正在思考", text: lastStreamingReasoning.text };
  }

  const lastStreamingAssistant = [...transcript].reverse().find(
    (entry) => entry.kind === "assistant" && entry.status === "streaming",
  );
  if (lastStreamingAssistant) {
    return { type: "assistant", label: "正在回复", text: lastStreamingAssistant.text };
  }

  if (session.status === "running") {
    return { type: "running", label: "正在处理", text: "" };
  }

  return null;
}

function setActivityIndicator(activity) {
  if (!activity) {
    activityIndicatorEl.classList.add("hidden");
    activityIndicatorEl.textContent = "";
    return;
  }
  activityIndicatorEl.classList.remove("hidden");
  activityIndicatorEl.textContent = activity.label;
}

function renderTranscriptWindow() {
  const transcript = state.activeSession?.transcript || [];
  if (!transcript.length) {
    transcriptListEl.innerHTML = "";
    transcriptTopSpacerEl.style.height = "0px";
    transcriptBottomSpacerEl.style.height = "0px";
    return;
  }

  const scrollTop = transcriptEl.scrollTop;
  const estimatedIndex = Math.floor(scrollTop / ESTIMATED_ROW_HEIGHT);
  const start = Math.max(0, estimatedIndex - OVERSCAN);
  const end = Math.min(transcript.length, start + WINDOW_SIZE);

  transcriptTopSpacerEl.style.height = `${estimateHeight(0, start)}px`;
  transcriptBottomSpacerEl.style.height = `${estimateHeight(end, transcript.length)}px`;

  transcriptListEl.innerHTML = "";
  for (let index = start; index < end; index += 1) {
    const entry = transcript[index];
    const element = renderEntry(entry);
    transcriptListEl.appendChild(element);
    requestAnimationFrame(() => {
      state.rowHeights.set(entry.id, element.offsetHeight + 14);
    });
  }

  const activity = getActivity(state.activeSession);
  if (activity && !transcript.some((entry) => entry.status === "streaming")) {
    transcriptListEl.appendChild(renderPendingCard(activity.label));
  }
}

function renderPendingCard(label) {
  const wrapper = document.createElement("article");
  wrapper.className = "entry system stream";
  wrapper.innerHTML = `
    <div class="entry-header">
      <div class="entry-title"><strong>${escapeHtml(label)}</strong></div>
      <span class="pill">live</span>
    </div>
    <div class="entry-body">
      <div class="entry-preview">Agent 正在处理当前请求...</div>
    </div>
  `;
  return wrapper;
}

function estimateHeight(start, end) {
  const transcript = state.activeSession?.transcript || [];
  let total = 0;
  for (let index = start; index < end; index += 1) {
    const entry = transcript[index];
    total += state.rowHeights.get(entry.id) || ESTIMATED_ROW_HEIGHT;
  }
  return total;
}

function renderEntry(entry) {
  const wrapper = document.createElement("article");
  const expanded = state.expandedEntries.has(entry.id);
  const streaming = entry.status === "streaming";
  const title = entry.phase ? `${entry.kind} · ${entry.phase}` : entry.kind;
  wrapper.className = `entry ${entry.kind} ${streaming ? "stream" : ""}`;

  const preview = getPreviewText(entry);
  const expandable = isExpandable(entry);

  wrapper.innerHTML = `
    <div class="entry-header">
      <div class="entry-title">
        <strong>${escapeHtml(title)}</strong>
        ${entry.status ? `<span class="pill">${escapeHtml(entry.status)}</span>` : ""}
      </div>
      <span>${escapeHtml(formatTime(entry.createdAt))}</span>
    </div>
  `;

  const body = document.createElement("div");
  body.className = "entry-body";

  const previewEl = document.createElement("div");
  previewEl.className = "entry-preview";
  previewEl.textContent = preview;
  body.appendChild(previewEl);

  if (expandable) {
    const controls = document.createElement("div");
    controls.className = "entry-controls";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "entry-details-toggle";
    button.textContent = expanded ? "收起" : "展开";
    button.addEventListener("click", () => {
      if (expanded) {
        state.expandedEntries.delete(entry.id);
      } else {
        state.expandedEntries.add(entry.id);
      }
      renderTranscriptWindow();
    });
    controls.appendChild(button);
    body.appendChild(controls);
  }

  if (expandable && expanded) {
    const details = document.createElement("div");
    details.className = "entry-details";
    const pre = document.createElement("pre");
    pre.textContent = entry.text;
    details.appendChild(pre);
    body.appendChild(details);
  }

  wrapper.appendChild(body);
  return wrapper;
}

function isExpandable(entry) {
  return ["tool", "command", "file_change", "reasoning"].includes(entry.kind);
}

function getPreviewText(entry) {
  if (entry.kind === "reasoning") {
    if (entry.status === "streaming") {
      return entry.text || "正在思考...";
    }
    return compactText(entry.text, 12);
  }

  if (["tool", "command", "file_change"].includes(entry.kind)) {
    return lastLines(entry.text, 30);
  }

  return entry.text || "";
}

function compactText(text, lines) {
  const value = String(text || "").trim();
  if (!value) return "No reasoning text";
  return lastLines(value, lines);
}

function lastLines(text, count) {
  return String(text || "")
    .split(/\r?\n/)
    .slice(-count)
    .join("\n");
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

async function loadConfig() {
  state.config = await api("/api/config");
  populateModelSelect();
}

async function loadSessions() {
  state.sessions = await api("/api/sessions");
  if (!state.activeSessionId && state.sessions[0]) {
    state.activeSessionId = state.sessions[0].id;
  }
  renderSessions();
  if (state.activeSessionId) {
    await loadSession(state.activeSessionId);
  } else {
    renderMeta();
    renderTranscriptWindow();
  }
}

async function loadHistory() {
  state.history = await api("/api/history");
  renderHistory();
}

async function loadSession(sessionId) {
  const session = await api(`/api/sessions/${sessionId}`);
  state.activeSessionId = session.id;
  state.activeSession = session;
  normalizeExpandedReasoning(session.transcript);
  renderSessions();
  renderMeta();
  renderTranscriptWindow();
}

async function restoreHistorySession(item) {
  const payload = {
    cwd: item.cwd || document.getElementById("cwd-input").value,
    model: modelSelectEl.value || undefined,
    reasoningEffort: effortSelectEl.value || undefined,
    sandbox: "workspace-write",
  };
  const session = await api(`/api/history/${item.id}/restore`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  state.historyOpen = false;
  renderHistory();
  state.activeSessionId = session.id;
  state.activeSession = session;
  state.expandedEntries.clear();
  state.rowHeights.clear();
  renderSessions();
  renderMeta();
  renderTranscriptWindow();
}

function normalizeExpandedReasoning(transcript) {
  for (const entry of transcript) {
    if (entry.kind === "reasoning") {
      if (entry.status === "streaming") {
        state.expandedEntries.add(entry.id);
      } else {
        state.expandedEntries.delete(entry.id);
      }
    }
  }
}

createSessionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(createSessionForm);
  const payload = {
    cwd: String(formData.get("cwd") || ""),
    model: String(formData.get("model") || ""),
    reasoningEffort: String(formData.get("reasoningEffort") || ""),
    sandbox: "workspace-write",
  };
  const session = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  state.activeSessionId = session.id;
  state.activeSession = session;
  state.expandedEntries.clear();
  state.rowHeights.clear();
  renderSessions();
  renderMeta();
  renderTranscriptWindow();
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.activeSessionId) return;
  const text = messageInput.value.trim();
  if (!text) return;
  await api(`/api/sessions/${state.activeSessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  messageInput.value = "";
});

messageInput.addEventListener("keydown", async (event) => {
  if (event.key === "Enter" && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});

interruptButton.addEventListener("click", async () => {
  if (!state.activeSessionId) return;
  await api(`/api/sessions/${state.activeSessionId}/interrupt`, { method: "POST" });
});

deleteButton.addEventListener("click", async () => {
  if (!state.activeSessionId) return;
  await api(`/api/sessions/${state.activeSessionId}`, { method: "DELETE" });
  state.activeSession = null;
  state.activeSessionId = null;
  await loadSessions();
});

themeToggleButton.addEventListener("click", () => {
  applyTheme(state.theme === "dark" ? "light" : "dark");
});

historyToggleButton.addEventListener("click", async () => {
  state.historyOpen = true;
  renderHistory();
  await loadHistory();
});

historyCloseButton.addEventListener("click", () => {
  state.historyOpen = false;
  renderHistory();
});

historyBackdropEl.addEventListener("click", () => {
  state.historyOpen = false;
  renderHistory();
});

modelSelectEl.addEventListener("change", () => {
  populateEffortSelect(modelSelectEl.value);
});

transcriptEl.addEventListener("scroll", () => {
  renderTranscriptWindow();
});

function updateSessionSummary(session) {
  const index = state.sessions.findIndex((item) => item.id === session.id);
  if (index === -1) {
    state.sessions.unshift(session);
  } else {
    state.sessions[index] = { ...state.sessions[index], ...session };
  }
  if (state.activeSessionId === session.id && state.activeSession) {
    state.activeSession = { ...state.activeSession, ...session };
    renderMeta();
    renderTranscriptWindow();
  }
  renderSessions();
}

function appendEntry(event) {
  if (!state.activeSession || state.activeSession.id !== event.sessionId) return;
  state.activeSession = {
    ...state.activeSession,
    transcript: [...state.activeSession.transcript, event.entry],
    transcriptCount: state.activeSession.transcriptCount + 1,
  };
  if (event.entry.kind === "reasoning" && event.entry.status === "streaming") {
    state.expandedEntries.add(event.entry.id);
  }
  renderMeta();
  renderTranscriptWindow();
  stickToBottomIfNeeded();
}

function replaceTranscript(event) {
  if (!state.activeSession || state.activeSession.id !== event.sessionId) return;
  state.activeSession = {
    ...state.activeSession,
    transcript: event.transcript,
    transcriptCount: event.transcript.length,
  };
  normalizeExpandedReasoning(event.transcript);
  renderMeta();
  renderTranscriptWindow();
  stickToBottomIfNeeded();
}

function stickToBottomIfNeeded() {
  const nearBottom =
    transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 260;
  if (nearBottom) {
    requestAnimationFrame(() => {
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    });
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatDateTime(iso) {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso || "";
  }
}

const protocol = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${protocol}://${location.host}/ws`);

ws.addEventListener("message", async (event) => {
  const payload = JSON.parse(event.data);
  if (payload.type === "hello") {
    state.sessions = payload.sessions;
    renderSessions();
    if (state.activeSessionId) {
      await loadSession(state.activeSessionId);
    }
    return;
  }
  if (payload.type === "session-created" || payload.type === "session-updated") {
    updateSessionSummary(payload.session);
    return;
  }
  if (payload.type === "session-deleted") {
    state.sessions = state.sessions.filter((session) => session.id !== payload.sessionId);
    if (state.activeSessionId === payload.sessionId) {
      state.activeSessionId = null;
      state.activeSession = null;
      renderMeta();
      renderTranscriptWindow();
    }
    renderSessions();
    return;
  }
  if (payload.type === "session-entry") {
    appendEntry(payload);
    return;
  }
  if (payload.type === "session-reset") {
    replaceTranscript(payload);
  }
});

Promise.all([loadConfig(), loadSessions()]).catch((error) => {
  metaEl.textContent = error.message;
});
