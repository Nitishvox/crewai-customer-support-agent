/* script.js — SupportDesk AI frontend
 * Talks to the FastAPI backend (POST /chat and GET /health), keeps conversation
 * history in the browser (localStorage), and builds formatted messages with
 * text nodes so AI responses are never executed as HTML.
 */
(() => {
  "use strict";

  const CONFIG = Object.freeze({
    apiBase: window.location.protocol === "file:" ? "http://127.0.0.1:8000" : "",
    storageKey: "supportdesk-ai.conversations.v1",
    maxConversations: 30,
    maxMessageLength: 2000,
    requestTimeoutMs: 120000,
    healthCheckIntervalMs: 30000,
  });

  const dom = {
    sidebar: document.getElementById("sidebar"),
    overlay: document.getElementById("sidebarOverlay"),
    menuToggleBtn: document.getElementById("menuToggleBtn"),
    sidebarCloseBtn: document.getElementById("sidebarCloseBtn"),
    newChatBtn: document.getElementById("newChatBtn"),
    historyList: document.getElementById("historyList"),
    historyEmpty: document.getElementById("historyEmpty"),
    conversationTitle: document.getElementById("conversationTitle"),
    statusPill: document.getElementById("statusPill"),
    statusText: document.getElementById("statusText"),
    welcome: document.getElementById("welcomeScreen"),
    suggestions: document.getElementById("suggestions"),
    messages: document.getElementById("messages"),
    errorBanner: document.getElementById("errorBanner"),
    errorText: document.getElementById("errorText"),
    retryBtn: document.getElementById("retryBtn"),
    dismissErrorBtn: document.getElementById("dismissErrorBtn"),
    form: document.getElementById("chatForm"),
    input: document.getElementById("messageInput"),
    sendBtn: document.getElementById("sendBtn"),
    charCount: document.getElementById("charCount"),
  };

  const state = {
    conversations: [],
    activeId: null,
    isSending: false,
    failedMessage: null,
  };

  /* ---------- Errors ---------- */

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.name = "ApiError";
      this.status = status; // HTTP status code, or "network" / "timeout"
    }
  }

  /* ---------- Utilities ---------- */

  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function formatClock(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function formatRelative(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function makeTitle(text) {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length > 40 ? `${clean.slice(0, 40).trimEnd()}…` : clean;
  }

  const byMostRecent = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));

  function isUsableConversation(value) {
    return (
      value &&
      typeof value.id === "string" &&
      typeof value.title === "string" &&
      typeof value.updatedAt === "string" &&
      Array.isArray(value.messages)
    );
  }

  function isUsableMessage(value) {
    return value && typeof value.role === "string" && typeof value.text === "string";
  }

  /* ---------- Storage ---------- */

  function loadConversations() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CONFIG.storageKey) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(isUsableConversation)
        .map((conversation) => ({
          ...conversation,
          messages: conversation.messages.filter(isUsableMessage),
        }));
    } catch (error) {
      console.warn("Could not read saved conversations:", error);
      return [];
    }
  }

  function visibleConversations() {
    // Hide empty conversations unless they are the one currently open.
    return state.conversations.filter(
      (conversation) => conversation.messages.length > 0 || conversation.id === state.activeId
    );
  }

  function saveConversations() {
    try {
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(visibleConversations()));
    } catch (error) {
      console.warn("Could not save conversations:", error);
    }
  }

  /* ---------- Conversation state ---------- */

  function createConversation() {
    const timestamp = nowIso();
    const conversation = {
      id: createId(),
      title: "New conversation",
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [],
    };
    state.conversations.unshift(conversation);
    state.conversations = state.conversations.slice(0, CONFIG.maxConversations);
    return conversation;
  }

  function getConversation(id) {
    return state.conversations.find((conversation) => conversation.id === id) || null;
  }

  function getActiveConversation() {
    return getConversation(state.activeId);
  }

  /* ---------- Rendering ---------- */

  function createAvatar(label) {
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = label;
    return avatar;
  }

  function normalizeAssistantText(text) {
    return text
      .replace(/\r\n?/g, "\n")
      .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, "")
      .replace(/<\/?[a-z][^>]*>/gi, "")
      .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ")
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"');
  }

  function appendInlineMarkdown(container, text) {
    const parts = text.split(/(\*\*[^*\n]+?\*\*)/g);
    parts.forEach((part) => {
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        const strong = document.createElement("strong");
        strong.textContent = part.slice(2, -2);
        container.appendChild(strong);
      } else {
        container.appendChild(document.createTextNode(part));
      }
    });
  }

  function renderAssistantText(container, text) {
    const lines = normalizeAssistantText(text).split("\n");
    let paragraph = null;
    let list = null;

    lines.forEach((line) => {
      if (!line.trim()) {
        paragraph = null;
        list = null;
        return;
      }

      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      if (bullet) {
        paragraph = null;
        if (!list) {
          list = document.createElement("ul");
          container.appendChild(list);
        }
        const item = document.createElement("li");
        appendInlineMarkdown(item, bullet[1]);
        list.appendChild(item);
        return;
      }

      list = null;
      if (!paragraph) {
        paragraph = document.createElement("p");
        container.appendChild(paragraph);
      } else {
        paragraph.appendChild(document.createElement("br"));
      }
      appendInlineMarkdown(paragraph, line.trimEnd());
    });
  }

  function buildMessageElement(message) {
    const isUser = message.role === "user";
    const row = document.createElement("article");
    row.className = `message ${isUser ? "message-user" : "message-assistant"}`;

    const body = document.createElement("div");
    body.className = "message-body";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (isUser) {
      bubble.textContent = message.text;
    } else {
      renderAssistantText(bubble, message.text);
    }

    const meta = document.createElement("time");
    meta.className = "meta";
    meta.dateTime = message.createdAt;
    meta.textContent = `${isUser ? "You" : "SupportDesk AI"} · ${formatClock(message.createdAt)}`;

    body.append(bubble, meta);
    row.append(createAvatar(isUser ? "You" : "AI"), body);
    return row;
  }

  function renderHistory() {
    dom.historyList.replaceChildren();
    const items = visibleConversations();

    items.forEach((conversation) => {
      const item = document.createElement("li");
      item.className = "history-entry";
      const button = document.createElement("button");
      const isActive = conversation.id === state.activeId;

      button.type = "button";
      button.className = `history-item${isActive ? " is-active" : ""}`;
      button.dataset.id = conversation.id;
      button.disabled = state.isSending && !isActive;
      if (isActive) button.setAttribute("aria-current", "true");

      const title = document.createElement("span");
      title.className = "history-title";
      title.textContent = conversation.title;

      const time = document.createElement("span");
      time.className = "history-time";
      time.textContent = formatRelative(conversation.updatedAt);

      button.append(title, time);
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "history-delete-btn";
      deleteButton.dataset.deleteId = conversation.id;
      deleteButton.disabled = state.isSending;
      deleteButton.setAttribute("aria-label", `Delete conversation: ${conversation.title}`);
      deleteButton.title = "Delete conversation";

      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("width", "16");
      icon.setAttribute("height", "16");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.setAttribute("stroke-width", "2");
      icon.setAttribute("stroke-linecap", "round");
      icon.setAttribute("stroke-linejoin", "round");
      icon.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14M10 11v5m4-5v5");
      icon.appendChild(path);
      deleteButton.appendChild(icon);

      item.append(button, deleteButton);
      dom.historyList.appendChild(item);
    });

    dom.historyEmpty.hidden = items.length > 0;
  }

  function renderActiveConversation() {
    const conversation = getActiveConversation();
    dom.messages.replaceChildren();
    if (!conversation) return;

    const hasMessages = conversation.messages.length > 0;
    dom.conversationTitle.textContent = conversation.title;
    dom.welcome.hidden = hasMessages;
    dom.messages.hidden = !hasMessages;

    conversation.messages.forEach((message) => {
      dom.messages.appendChild(buildMessageElement(message));
    });
    scrollToBottom();
  }

  function addMessage(role, text) {
    const conversation = getActiveConversation();
    if (!conversation) return;

    const message = { id: createId(), role, text, createdAt: nowIso() };
    conversation.messages.push(message);
    conversation.updatedAt = message.createdAt;

    if (role === "user" && conversation.title === "New conversation") {
      conversation.title = makeTitle(text);
    }

    state.conversations.sort(byMostRecent);
    saveConversations();

    dom.welcome.hidden = true;
    dom.messages.hidden = false;
    dom.conversationTitle.textContent = conversation.title;
    dom.messages.appendChild(buildMessageElement(message));
    renderHistory();
    scrollToBottom();
  }

  function showTypingIndicator() {
    hideTypingIndicator();

    const row = document.createElement("div");
    row.className = "message message-assistant message-typing";
    row.setAttribute("role", "status");

    const body = document.createElement("div");
    body.className = "message-body";

    const bubble = document.createElement("div");
    bubble.className = "bubble typing-bubble";
    bubble.setAttribute("aria-label", "AI assistant is typing");
    for (let i = 0; i < 3; i += 1) {
      const dot = document.createElement("span");
      dot.className = "typing-dot";
      bubble.appendChild(dot);
    }

    const label = document.createElement("span");
    label.className = "meta";
    label.textContent = "Our support agents are working on your request…";

    body.append(bubble, label);
    row.append(createAvatar("AI"), body);
    dom.messages.appendChild(row);
    scrollToBottom();
  }

  function hideTypingIndicator() {
    dom.messages.querySelectorAll(".message-typing").forEach((element) => element.remove());
  }

  function scrollToBottom() {
    window.requestAnimationFrame(() => {
      dom.messages.scrollTo({ top: dom.messages.scrollHeight, behavior: "smooth" });
    });
  }

  function showError(message, { retryable = false } = {}) {
    dom.errorText.textContent = message;
    dom.retryBtn.hidden = !retryable;
    dom.errorBanner.hidden = false;
  }

  function hideError() {
    dom.errorBanner.hidden = true;
    dom.errorText.textContent = "";
  }

  function setConnectionStatus(stateName, label) {
    dom.statusPill.dataset.state = stateName;
    dom.statusText.textContent = label;
  }

  /* ---------- Composer state ---------- */

  function autoResize() {
    dom.input.style.height = "auto";
    dom.input.style.height = `${Math.min(dom.input.scrollHeight, 180)}px`;
  }

  function updateComposerState() {
    const length = dom.input.value.length;
    const hasText = dom.input.value.trim().length > 0;
    dom.sendBtn.disabled = state.isSending || !hasText;
    dom.charCount.textContent = `${length} / ${CONFIG.maxMessageLength}`;
  }

  function setBusy(isBusy) {
    state.isSending = isBusy;
    dom.sendBtn.classList.toggle("is-loading", isBusy);
    dom.newChatBtn.disabled = isBusy;
    renderHistory();
    updateComposerState();
  }

  function focusInputIfDesktop() {
    if (window.matchMedia("(pointer: fine)").matches) {
      dom.input.focus();
    }
  }

  /* ---------- Sidebar (mobile) ---------- */

  function openSidebar() {
    dom.sidebar.classList.add("is-open");
    dom.overlay.classList.add("is-visible");
    dom.menuToggleBtn.setAttribute("aria-expanded", "true");
  }

  function closeSidebar() {
    dom.sidebar.classList.remove("is-open");
    dom.overlay.classList.remove("is-visible");
    dom.menuToggleBtn.setAttribute("aria-expanded", "false");
  }

  /* ---------- API ---------- */

  function extractErrorDetail(data, status) {
    if (data && typeof data.detail === "string") return data.detail;
    if (status === 422) return "Please enter a valid message (1 to 2000 characters).";
    return `The server returned an error (HTTP ${status}).`;
  }

  function getErrorMessage(error) {
    if (error instanceof ApiError) {
      if (error.status === "network") {
        return "We couldn't reach the support server. Check that the backend is running, then retry.";
      }
      if (error.status === "timeout") {
        return "The assistant is taking longer than expected. Please retry.";
      }
      return error.message;
    }
    return "Something went wrong. Please try again.";
  }

  async function fetchAnswer(message) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);

    try {
      const response = await fetch(`${CONFIG.apiBase}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new ApiError(response.status, extractErrorDetail(data, response.status));
      }
      if (typeof data.answer !== "string" || !data.answer.trim()) {
        throw new ApiError(response.status, "The assistant returned an empty response. Please retry.");
      }
      return data.answer;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error.name === "AbortError") {
        throw new ApiError("timeout", "The request timed out. Please retry.");
      }
      throw new ApiError("network", "Network error.");
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function checkHealth() {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${CONFIG.apiBase}/health`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setConnectionStatus("online", "AI assistant online");
    } catch (error) {
      setConnectionStatus("offline", "Assistant offline");
    } finally {
      window.clearTimeout(timer);
    }
  }

  /* ---------- Chat flow ---------- */

  async function requestAnswer(text) {
    setBusy(true);
    showTypingIndicator();

    try {
      const answer = await fetchAnswer(text);
      hideTypingIndicator();
      state.failedMessage = null;
      setConnectionStatus("online", "AI assistant online");
      addMessage("assistant", answer);
    } catch (error) {
      hideTypingIndicator();
      state.failedMessage = text;
      if (error instanceof ApiError && error.status === "network") {
        setConnectionStatus("offline", "Assistant offline");
      }
      showError(getErrorMessage(error), { retryable: true });
      console.error("Chat request failed:", error);
    } finally {
      setBusy(false);
      focusInputIfDesktop();
    }
  }

  async function submitMessage(text) {
    if (state.isSending) return;

    if (text.length > CONFIG.maxMessageLength) {
      showError(`Messages can be up to ${CONFIG.maxMessageLength} characters.`);
      return;
    }

    hideError();
    if (!getActiveConversation()) {
      state.activeId = createConversation().id;
    }
    addMessage("user", text);
    await requestAnswer(text);
  }

  function handleFormSubmit(event) {
    event.preventDefault();
    if (state.isSending) return;

    const text = dom.input.value.trim();
    if (!text) return;

    dom.input.value = "";
    autoResize();
    updateComposerState();
    submitMessage(text);
  }

  function handleInputKeydown(event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      dom.form.requestSubmit();
    }
  }

  function retryLastMessage() {
    if (!state.failedMessage || state.isSending) return;
    const text = state.failedMessage;
    hideError();
    requestAnswer(text);
  }

  function startNewConversation() {
    if (state.isSending) return;

    const current = getActiveConversation();
    if (!current || current.messages.length > 0) {
      state.activeId = createConversation().id;
    }

    state.failedMessage = null;
    hideError();
    saveConversations();
    renderHistory();
    renderActiveConversation();
    closeSidebar();
    focusInputIfDesktop();
  }

  function switchConversation(id) {
    if (state.isSending || id === state.activeId || !getConversation(id)) return;

    state.activeId = id;
    state.failedMessage = null;
    hideError();
    renderHistory();
    renderActiveConversation();
    closeSidebar();
  }

  function deleteConversation(id) {
    if (state.isSending) return;

    const conversation = getConversation(id);
    if (!conversation) return;

    const confirmed = window.confirm(
      `Delete "${conversation.title}" from chat history? This cannot be undone.`
    );
    if (!confirmed) return;

    state.conversations = state.conversations.filter((item) => item.id !== id);
    if (state.activeId === id) {
      state.activeId = createConversation().id;
      state.failedMessage = null;
      hideError();
      renderActiveConversation();
    }

    saveConversations();
    renderHistory();
  }

  /* ---------- Events ---------- */

  function bindEvents() {
    dom.form.addEventListener("submit", handleFormSubmit);
    dom.input.addEventListener("keydown", handleInputKeydown);
    dom.input.addEventListener("input", () => {
      autoResize();
      updateComposerState();
    });

    dom.newChatBtn.addEventListener("click", startNewConversation);

    dom.historyList.addEventListener("click", (event) => {
      const deleteButton = event.target.closest("button[data-delete-id]");
      if (deleteButton) {
        deleteConversation(deleteButton.dataset.deleteId);
        return;
      }

      const item = event.target.closest("button[data-id]");
      if (item) switchConversation(item.dataset.id);
    });

    dom.suggestions.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-question]");
      if (!button || state.isSending) return;
      submitMessage(button.dataset.question);
    });

    dom.retryBtn.addEventListener("click", retryLastMessage);
    dom.dismissErrorBtn.addEventListener("click", hideError);

    dom.menuToggleBtn.addEventListener("click", openSidebar);
    dom.sidebarCloseBtn.addEventListener("click", closeSidebar);
    dom.overlay.addEventListener("click", closeSidebar);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeSidebar();
    });
  }

  /* ---------- Init ---------- */

  function init() {
    // Drop empty conversations saved in earlier sessions, then open a fresh one.
    state.conversations = loadConversations()
      .filter((conversation) => conversation.messages.length > 0)
      .sort(byMostRecent);

    createConversation();
    state.activeId = state.conversations[0].id;
    saveConversations();

    bindEvents();
    renderHistory();
    renderActiveConversation();
    updateComposerState();

    checkHealth();
    window.setInterval(checkHealth, CONFIG.healthCheckIntervalMs);
  }

  document.addEventListener("DOMContentLoaded", init);
})();