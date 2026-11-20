/* script.js — Amazon Marketplace with Aria AI Copilot
 * Handles product browsing, cart, orders tracking, and full Aria AI Copilot
 * conversation management with safe Markdown rendering and conversation deletion.
 */
(() => {
  "use strict";

  const CONFIG = Object.freeze({
    apiBase: window.location.protocol === "file:" ? "http://127.0.0.1:8000" : "",
    storageKey: "amazon-aria.conversations.v2",
    cartStorageKey: "amazon-aria.cart.v2",
    maxConversations: 30,
    maxMessageLength: 2000,
    requestTimeoutMs: 120000,
    healthCheckIntervalMs: 30000,
  });

  // Default fallback catalog if network is slow or loading
  const FALLBACK_PRODUCTS = [
    {
      product_id: "PRD-101",
      name: "Wireless Noise-Cancelling Headphones",
      category: "Electronics",
      price: 129.99,
      list_price: 159.99,
      stock: 24,
      rating: 4.8,
      reviews_count: 1420,
      badge: "Overall Pick",
      description: "Premium over-ear headphones with active hybrid noise cancellation, 30-hour battery life, and crystal-clear microphone.",
      image_icon: "🎧"
    },
    {
      product_id: "PRD-102",
      name: "Smart Fitness Watch",
      category: "Wearables",
      price: 89.5,
      list_price: 119.99,
      stock: 18,
      rating: 4.7,
      reviews_count: 985,
      badge: "Best Seller",
      description: "All-day activity tracker with heart rate monitor, sleep tracking, GPS, and 7-day battery life. Water resistant up to 50m.",
      image_icon: "⌚"
    },
    {
      product_id: "PRD-103",
      name: "Ergonomic Office Chair",
      category: "Furniture",
      price: 249.0,
      list_price: 299.99,
      stock: 7,
      rating: 4.9,
      reviews_count: 630,
      badge: "Top Rated",
      description: "High-back mesh executive chair with adjustable lumbar support, 3D armrests, and smooth silent roller wheels.",
      image_icon: "🪑"
    },
    {
      product_id: "PRD-104",
      name: "Stainless Steel Water Bottle",
      category: "Kitchen & Outdoors",
      price: 24.99,
      list_price: 32.99,
      stock: 52,
      rating: 4.6,
      reviews_count: 2150,
      badge: "Popular",
      description: "Double-wall vacuum insulated water bottle (32oz), keeps drinks ice cold for 24 hours or piping hot for 12 hours. BPA-free.",
      image_icon: "🍶"
    },
    {
      product_id: "PRD-105",
      name: "4K Action Camera",
      category: "Electronics",
      price: 319.99,
      list_price: 379.99,
      stock: 12,
      rating: 4.5,
      reviews_count: 480,
      badge: "Limited Deal",
      description: "Ultra HD 4K 60FPS sports action cam with dual touchscreens, electronic image stabilization, and waterproof housing.",
      image_icon: "📷"
    },
    {
      product_id: "PRD-106",
      name: "Mechanical Keyboard",
      category: "Computers",
      price: 139.0,
      list_price: 169.99,
      stock: 31,
      rating: 4.9,
      reviews_count: 1740,
      badge: "Amazon Choice",
      description: "Hot-swappable tactile RGB gaming keyboard with custom PBT keycaps, sound-dampening foam, and braided USB-C cable.",
      image_icon: "⌨️"
    },
    {
      product_id: "PRD-107",
      name: "Fast Wireless Charging Stand",
      category: "Electronics",
      price: 29.99,
      list_price: 39.99,
      stock: 45,
      rating: 4.6,
      reviews_count: 820,
      badge: "Prime",
      description: "15W fast wireless charger stand compatible with iPhone and Android, dual-coil design for portrait and landscape viewing.",
      image_icon: "⚡"
    },
    {
      product_id: "PRD-108",
      name: "Organic Cotton Bed Sheet Set",
      category: "Home & Bedding",
      price: 59.99,
      list_price: 79.99,
      stock: 20,
      rating: 4.7,
      reviews_count: 540,
      badge: "Prime",
      description: "100% GOTS certified organic cotton 400 thread count sateen sheet set. Breathable, hypoallergenic, deep pocket design.",
      image_icon: "🛏️"
    }
  ];

  const dom = {
    // Top nav & store elements
    cartCount: document.getElementById("cartCount"),
    productGrid: document.getElementById("productGrid"),
    deptSelect: document.getElementById("deptSelect"),
    amzSearchInput: document.getElementById("amzSearchInput"),
    amzSearchBtn: document.getElementById("amzSearchBtn"),
    heroPrompts: document.getElementById("heroPrompts"),
    ordersNavBtn: document.getElementById("ordersNavBtn"),
    ordersModal: document.getElementById("ordersModal"),
    closeOrdersModalBtn: document.getElementById("closeOrdersModalBtn"),
    ordersList: document.getElementById("ordersList"),
    toast: document.getElementById("toastNotification"),
    toastMessage: document.getElementById("toastMessage"),

    // Aria drawer elements
    ariaDrawer: document.getElementById("ariaDrawer"),
    openAriaBtn: document.getElementById("openAriaBtn"),
    closeAriaBtn: document.getElementById("closeAriaBtn"),
    floatingAriaPill: document.getElementById("floatingAriaPill"),
    ariaCopilotPill: document.getElementById("ariaCopilotPill"),
    historyToggleBtn: document.getElementById("historyToggleBtn"),
    ariaHistoryPanel: document.getElementById("ariaHistoryPanel"),
    clearAllHistoryBtn: document.getElementById("clearAllHistoryBtn"),
    historyList: document.getElementById("historyList"),
    historyEmpty: document.getElementById("historyEmpty"),
    drawerNewChatBtn: document.getElementById("drawerNewChatBtn"),
    ariaStatusBadge: document.getElementById("ariaStatusBadge"),
    ariaStatusText: document.getElementById("ariaStatusText"),
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
    products: [...FALLBACK_PRODUCTS],
    activeCategory: "all",
    cart: [],
    conversations: [],
    activeId: null,
    isSending: false,
    failedMessage: null,
    historyOpen: false,
  };

  /* ---------- Custom Error ---------- */

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.name = "ApiError";
      this.status = status;
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
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function makeTitle(text) {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length > 36 ? `${clean.slice(0, 36).trimEnd()}…` : clean;
  }

  const byMostRecent = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));

  function showToast(message) {
    if (!dom.toast) return;
    dom.toastMessage.textContent = message;
    dom.toast.hidden = false;
    window.clearTimeout(dom.toast._timer);
    dom.toast._timer = window.setTimeout(() => {
      dom.toast.hidden = true;
    }, 2800);
  }

  /* ---------- Conversation Storage ---------- */

  function loadConversations() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CONFIG.storageKey) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (c) => c && typeof c.id === "string" && Array.isArray(c.messages)
      );
    } catch (e) {
      console.warn("Could not read saved conversations:", e);
      return [];
    }
  }

  function saveConversations() {
    try {
      const toSave = state.conversations.filter(
        (c) => c.messages.length > 0 || c.id === state.activeId
      );
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(toSave));
    } catch (e) {
      console.warn("Could not save conversations:", e);
    }
  }

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
    return state.conversations.find((c) => c.id === id) || null;
  }

  function getActiveConversation() {
    return getConversation(state.activeId);
  }

  /* ---------- Cart Management ---------- */

  function loadCart() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CONFIG.cartStorageKey) || "[]");
      state.cart = Array.isArray(parsed) ? parsed : [];
    } catch {
      state.cart = [];
    }
    updateCartCount();
  }

  function saveCart() {
    try {
      localStorage.setItem(CONFIG.cartStorageKey, JSON.stringify(state.cart));
    } catch {
      // Ignore
    }
    updateCartCount();
  }

  function updateCartCount() {
    const total = state.cart.reduce((sum, item) => sum + (item.quantity || 1), 0);
    if (dom.cartCount) dom.cartCount.textContent = total;
  }

  function addToCart(product) {
    const existing = state.cart.find((i) => i.product_id === product.product_id);
    if (existing) {
      existing.quantity = (existing.quantity || 1) + 1;
    } else {
      state.cart.push({ ...product, quantity: 1 });
    }
    saveCart();
    showToast(`Added 1x "${product.name}" to Cart!`);
  }

  /* ---------- Catalog Rendering ---------- */

  async function fetchProducts() {
    try {
      const res = await fetch(`${CONFIG.apiBase}/api/products`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          state.products = data;
        }
      }
    } catch (e) {
      console.warn("Using embedded product catalog:", e);
    }
    renderProducts();
  }

  function renderProducts(filterKeyword = "") {
    if (!dom.productGrid) return;
    dom.productGrid.replaceChildren();

    const kw = filterKeyword.toLowerCase().trim();
    const list = state.products.filter((p) => {
      const matchCat =
        state.activeCategory === "all" ||
        p.category.toLowerCase() === state.activeCategory.toLowerCase();
      if (!matchCat) return false;
      if (!kw) return true;
      return (
        p.name.toLowerCase().includes(kw) ||
        p.description.toLowerCase().includes(kw) ||
        p.category.toLowerCase().includes(kw)
      );
    });

    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-catalog";
      empty.textContent = `No products found matching "${filterKeyword}". Try searching something else or ask Aria!`;
      dom.productGrid.appendChild(empty);
      return;
    }

    list.forEach((product) => {
      const card = document.createElement("article");
      card.className = "product-card";

      // Badge
      const badgeHtml = product.badge
        ? `<div class="card-badge ${product.badge.toLowerCase().includes("prime") ? "badge-prime" : ""}">${product.badge}</div>`
        : "";

      // Stock text
      const stockHtml =
        product.stock > 0
          ? `<span class="stock-tag in-stock">In Stock (${product.stock} available)</span>`
          : `<span class="stock-tag out-of-stock">Currently Out of Stock</span>`;

      card.innerHTML = `
        ${badgeHtml}
        <div class="product-visual">
          <span class="product-icon">${product.image_icon || "📦"}</span>
        </div>
        <div class="product-info">
          <span class="product-category">${product.category}</span>
          <h3 class="product-title" title="${product.name}">${product.name}</h3>
          
          <div class="product-rating">
            <span class="stars">★★★★★</span>
            <span class="rating-val">${product.rating || "4.8"}</span>
            <span class="rating-count">(${Number(product.reviews_count || 1200).toLocaleString()})</span>
          </div>

          <div class="product-price-row">
            <span class="price-symbol">$</span>
            <span class="price-val">${Number(product.price).toFixed(2)}</span>
            ${product.list_price ? `<span class="list-price">List: $${product.list_price.toFixed(2)}</span>` : ""}
          </div>

          <div class="prime-delivery">
            <span class="prime-logo">prime</span>
            <span class="delivery-text">FREE delivery Tomorrow</span>
          </div>

          ${stockHtml}

          <div class="card-actions">
            <button class="btn-add-cart" type="button" data-add-id="${product.product_id}">
              Add to Cart
            </button>
            <button class="btn-ask-aria" type="button" data-ask-name="${product.name}">
              ✨ Ask Aria
            </button>
          </div>
        </div>
      `;

      dom.productGrid.appendChild(card);
    });
  }

  /* ---------- Orders Modal ---------- */

  async function showOrdersModal() {
    if (!dom.ordersModal || !dom.ordersList) return;
    dom.ordersList.innerHTML = "<p>Loading your orders…</p>";
    dom.ordersModal.hidden = false;

    try {
      const res = await fetch(`${CONFIG.apiBase}/api/orders`);
      const orders = res.ok ? await res.json() : [];
      dom.ordersList.replaceChildren();

      if (!Array.isArray(orders) || orders.length === 0) {
        dom.ordersList.innerHTML = "<p>No orders on file yet. Start shopping with Aria!</p>";
        return;
      }

      orders.forEach((order) => {
        const item = document.createElement("div");
        item.className = "order-card";

        const statusClass =
          order.order_status === "Delivered"
            ? "status-delivered"
            : order.order_status === "Processing"
            ? "status-processing"
            : order.order_status === "Cancelled"
            ? "status-cancelled"
            : "status-shipped";

        item.innerHTML = `
          <div class="order-header-row">
            <div>
              <span class="order-id">Order #${order.order_id}</span>
              <span class="order-customer"> · ${order.customer_name || "Customer"}</span>
            </div>
            <span class="order-status-pill ${statusClass}">${order.order_status}</span>
          </div>
          <div class="order-details">
            <p><strong>Item:</strong> ${order.product_name} (Qty: ${order.quantity || 1})</p>
            <p><strong>Total:</strong> $${Number(order.amount).toFixed(2)}</p>
            <p><strong>Ship to:</strong> ${order.delivery_address || "Not specified"}</p>
            ${order.tracking_id ? `<p><strong>Tracking:</strong> <code>${order.tracking_id}</code></p>` : ""}
            ${order.estimated_delivery ? `<p><strong>Est. Delivery:</strong> ${order.estimated_delivery}</p>` : ""}
          </div>
          <div class="order-actions">
            <button class="order-btn" data-order-action="track" data-id="${order.order_id}">
              🔍 Track with Aria
            </button>
            ${
              order.order_status === "Processing"
                ? `
              <button class="order-btn" data-order-action="cancel" data-id="${order.order_id}">
                ❌ Cancel Order
              </button>
              <button class="order-btn" data-order-action="address" data-id="${order.order_id}">
                📍 Change Address
              </button>
            `
                : ""
            }
            <button class="order-btn" data-order-action="damaged" data-id="${order.order_id}">
              ⚠️ Report Issue
            </button>
          </div>
        `;
        dom.ordersList.appendChild(item);
      });
    } catch {
      dom.ordersList.innerHTML = "<p>Could not load orders. Please try again later.</p>";
    }
  }

  function closeOrdersModal() {
    if (dom.ordersModal) dom.ordersModal.hidden = true;
  }

  /* ---------- Aria AI Assistant Drawer & Chat ---------- */

  function openAria(prefillMessage = "") {
    if (!dom.ariaDrawer) return;
    dom.ariaDrawer.classList.add("is-open");
    if (dom.floatingAriaPill) dom.floatingAriaPill.classList.add("is-hidden");

    if (prefillMessage) {
      submitMessage(prefillMessage);
    } else {
      focusInputIfDesktop();
    }
  }

  function closeAria() {
    if (!dom.ariaDrawer) return;
    dom.ariaDrawer.classList.remove("is-open");
    if (dom.floatingAriaPill) dom.floatingAriaPill.classList.remove("is-hidden");
  }

  function toggleHistoryPanel() {
    state.historyOpen = !state.historyOpen;
    if (dom.ariaHistoryPanel) {
      dom.ariaHistoryPanel.hidden = !state.historyOpen;
    }
  }

  function createAvatar(label) {
    const avatar = document.createElement("div");
    avatar.className = `avatar ${label === "AI" ? "avatar-ai" : "avatar-user"}`;
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = label;
    return avatar;
  }

  /* Step 3: Safe Markdown Rendering for Assistant messages */
  function buildMessageElement(message) {
    const isUser = message.role === "user";
    const row = document.createElement("article");
    row.className = `message ${isUser ? "message-user" : "message-assistant"}`;

    const body = document.createElement("div");
    body.className = "message-body";

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    if (isUser || typeof window.renderMarkdown !== "function") {
      // Customer messages stay plain text
      bubble.textContent = message.text;
    } else {
      // AI replies are rendered as safe formatted Markdown (bold, tables, lists, code)
      bubble.appendChild(window.renderMarkdown(message.text));
    }

    const meta = document.createElement("time");
    meta.className = "meta";
    meta.dateTime = message.createdAt;
    meta.textContent = `${isUser ? "You" : "Aria AI"} · ${formatClock(message.createdAt)}`;

    body.append(bubble, meta);
    row.append(createAvatar(isUser ? "You" : "AI"), body);
    return row;
  }

  function renderHistory() {
    if (!dom.historyList) return;
    dom.historyList.replaceChildren();

    const items = state.conversations.filter(
      (c) => c.messages.length > 0 || c.id === state.activeId
    );

    items.forEach((conversation) => {
      const item = document.createElement("li");
      item.className = "history-entry";
      const isActive = conversation.id === state.activeId;

      const button = document.createElement("button");
      button.type = "button";
      button.className = `history-item${isActive ? " is-active" : ""}`;
      button.dataset.id = conversation.id;
      button.disabled = state.isSending && !isActive;

      const title = document.createElement("span");
      title.className = "history-title";
      title.textContent = conversation.title;

      const time = document.createElement("span");
      time.className = "history-time";
      time.textContent = formatRelative(conversation.updatedAt);

      button.append(title, time);

      // Delete Button for this individual conversation
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "history-delete-btn";
      deleteButton.dataset.deleteId = conversation.id;
      deleteButton.disabled = state.isSending;
      deleteButton.title = "Delete conversation";
      deleteButton.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14M10 11v5m4-5v5"/>
        </svg>
      `;

      item.append(button, deleteButton);
      dom.historyList.appendChild(item);
    });

    if (dom.historyEmpty) {
      dom.historyEmpty.hidden = items.length > 0;
    }
  }

  function renderActiveConversation() {
    const conversation = getActiveConversation();
    if (!dom.messages) return;
    dom.messages.replaceChildren();
    if (!conversation) return;

    const hasMessages = conversation.messages.length > 0;
    if (dom.welcome) dom.welcome.hidden = hasMessages;
    dom.messages.hidden = !hasMessages;

    conversation.messages.forEach((msg) => {
      dom.messages.appendChild(buildMessageElement(msg));
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

    if (dom.welcome) dom.welcome.hidden = true;
    if (dom.messages) {
      dom.messages.hidden = false;
      dom.messages.appendChild(buildMessageElement(message));
    }
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
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement("span");
      dot.className = "typing-dot";
      bubble.appendChild(dot);
    }

    const label = document.createElement("span");
    label.className = "meta";
    label.textContent = "Aria is checking inventory, orders & policies…";

    body.append(bubble, label);
    row.append(createAvatar("AI"), body);

    if (dom.messages) {
      dom.messages.appendChild(row);
      scrollToBottom();
    }
  }

  function hideTypingIndicator() {
    if (!dom.messages) return;
    dom.messages.querySelectorAll(".message-typing").forEach((el) => el.remove());
  }

  function scrollToBottom() {
    if (!dom.messages) return;
    window.requestAnimationFrame(() => {
      dom.messages.scrollTo({ top: dom.messages.scrollHeight, behavior: "smooth" });
    });
  }

  function showError(message, { retryable = false } = {}) {
    if (!dom.errorBanner) return;
    dom.errorText.textContent = message;
    if (dom.retryBtn) dom.retryBtn.hidden = !retryable;
    dom.errorBanner.hidden = false;
  }

  function hideError() {
    if (dom.errorBanner) {
      dom.errorBanner.hidden = true;
      dom.errorText.textContent = "";
    }
  }

  function extractErrorDetail(payload, status) {
    if (payload && typeof payload.detail === "string" && payload.detail.trim()) {
      return payload.detail.trim();
    }
    if (status === 503) {
      return "The AI assistant is temporarily unavailable. Please try again shortly.";
    }
    if (status === 504) {
      return "The assistant took too long to answer. Please try again.";
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
      throw new ApiError("network", "Network error. Please check your connection.");
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function requestAnswer(text) {
    setBusy(true);
    showTypingIndicator();

    try {
      const answer = await fetchAnswer(text);
      hideTypingIndicator();
      state.failedMessage = null;
      hideError();
      addMessage("assistant", answer);
    } catch (error) {
      hideTypingIndicator();
      state.failedMessage = text;
      showError(error.message || "Could not retrieve answer. Please try again.", {
        retryable: true,
      });
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
    focusInputIfDesktop();
  }

  function switchConversation(id) {
    if (state.isSending || id === state.activeId || !getConversation(id)) return;
    state.activeId = id;
    state.failedMessage = null;
    hideError();
    renderHistory();
    renderActiveConversation();
  }

  function deleteConversation(id) {
    if (state.isSending) return;
    const conversation = getConversation(id);
    if (!conversation) return;

    const confirmed = window.confirm(
      `Delete "${conversation.title}" from your chat history?`
    );
    if (!confirmed) return;

    state.conversations = state.conversations.filter((c) => c.id !== id);
    if (state.activeId === id) {
      state.activeId = createConversation().id;
      state.failedMessage = null;
      hideError();
      renderActiveConversation();
    }
    saveConversations();
    renderHistory();
  }

  function clearAllHistory() {
    if (state.isSending) return;
    if (state.conversations.length === 0) return;

    const confirmed = window.confirm(
      "Are you sure you want to delete ALL chat history? This cannot be undone."
    );
    if (!confirmed) return;

    state.conversations = [];
    state.activeId = createConversation().id;
    state.failedMessage = null;
    hideError();
    saveConversations();
    renderHistory();
    renderActiveConversation();
  }

  function retryLastMessage() {
    if (state.isSending || !state.failedMessage) return;
    hideError();
    requestAnswer(state.failedMessage);
  }

  function autoResize() {
    if (!dom.input) return;
    dom.input.style.height = "auto";
    dom.input.style.height = `${Math.min(dom.input.scrollHeight, 160)}px`;
  }

  function updateComposerState() {
    if (!dom.input || !dom.sendBtn) return;
    const length = dom.input.value.length;
    const hasText = dom.input.value.trim().length > 0;
    dom.sendBtn.disabled = state.isSending || !hasText;
    if (dom.charCount) {
      dom.charCount.textContent = `${length} / ${CONFIG.maxMessageLength}`;
    }
  }

  function setBusy(isBusy) {
    state.isSending = isBusy;
    if (dom.sendBtn) dom.sendBtn.classList.toggle("is-loading", isBusy);
    if (dom.drawerNewChatBtn) dom.drawerNewChatBtn.disabled = isBusy;
    renderHistory();
    updateComposerState();
  }

  function focusInputIfDesktop() {
    if (dom.input && window.matchMedia("(pointer: fine)").matches) {
      dom.input.focus();
    }
  }

  async function checkHealth() {
    try {
      const res = await fetch(`${CONFIG.apiBase}/health`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (dom.ariaStatusText) dom.ariaStatusText.textContent = "Online";
        if (dom.ariaStatusBadge) dom.ariaStatusBadge.dataset.state = "online";
      } else {
        throw new Error("Bad status");
      }
    } catch {
      if (dom.ariaStatusText) dom.ariaStatusText.textContent = "Standby";
      if (dom.ariaStatusBadge) dom.ariaStatusBadge.dataset.state = "offline";
    }
  }

  /* ---------- Event Bindings ---------- */

  function bindEvents() {
    // Form & Input
    if (dom.form) {
      dom.form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (state.isSending) return;
        const text = dom.input.value.trim();
        if (!text) return;
        dom.input.value = "";
        autoResize();
        updateComposerState();
        submitMessage(text);
      });
    }

    if (dom.input) {
      dom.input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (dom.form) dom.form.dispatchEvent(new Event("submit"));
        }
      });
      dom.input.addEventListener("input", () => {
        autoResize();
        updateComposerState();
      });
    }

    // Hero quick prompts
    if (dom.heroPrompts) {
      dom.heroPrompts.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-prompt]");
        if (!btn) return;
        openAria(btn.dataset.prompt);
      });
    }

    // Suggestions inside Aria welcome
    if (dom.suggestions) {
      dom.suggestions.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-question]");
        if (!btn) return;
        submitMessage(btn.dataset.question);
      });
    }

    // Drawer toggles
    if (dom.openAriaBtn) dom.openAriaBtn.addEventListener("click", () => openAria());
    if (dom.closeAriaBtn) dom.closeAriaBtn.addEventListener("click", () => closeAria());
    if (dom.floatingAriaPill) dom.floatingAriaPill.addEventListener("click", () => openAria());
    if (dom.ariaCopilotPill) dom.ariaCopilotPill.addEventListener("click", (e) => {
      e.preventDefault();
      openAria();
    });

    // History & New Chat
    if (dom.historyToggleBtn) dom.historyToggleBtn.addEventListener("click", toggleHistoryPanel);
    if (dom.drawerNewChatBtn) dom.drawerNewChatBtn.addEventListener("click", startNewConversation);
    if (dom.clearAllHistoryBtn) dom.clearAllHistoryBtn.addEventListener("click", clearAllHistory);

    if (dom.historyList) {
      dom.historyList.addEventListener("click", (e) => {
        const delBtn = e.target.closest("button[data-delete-id]");
        if (delBtn) {
          deleteConversation(delBtn.dataset.deleteId);
          return;
        }
        const itemBtn = e.target.closest("button[data-id]");
        if (itemBtn) switchConversation(itemBtn.dataset.id);
      });
    }

    // Retry / dismiss errors
    if (dom.retryBtn) dom.retryBtn.addEventListener("click", retryLastMessage);
    if (dom.dismissErrorBtn) dom.dismissErrorBtn.addEventListener("click", hideError);

    // Department dropdown change
    if (dom.deptSelect) {
      dom.deptSelect.addEventListener("change", (e) => {
        const val = e.target.value;
        state.activeCategory = val;

        // Sync with filter pills
        document.querySelectorAll(".filter-pill").forEach((pill) => {
          pill.classList.toggle("active", pill.dataset.category.toLowerCase() === val.toLowerCase());
        });

        // Update placeholder
        if (dom.amzSearchInput) {
          if (val === "all") {
            dom.amzSearchInput.placeholder = "Search Amazon or ask Aria AI (e.g. 'Do you have fitness watch?')";
          } else {
            const label = e.target.options[e.target.selectedIndex].text;
            dom.amzSearchInput.placeholder = `Search in ${label} or ask Aria...`;
          }
        }

        renderProducts(dom.amzSearchInput ? dom.amzSearchInput.value : "");
      });
    }

    // Deliver to location prompt
    const locationBtn = document.getElementById("locationBtn");
    const deliverLocation = document.getElementById("deliverLocation");
    if (locationBtn && deliverLocation) {
      locationBtn.addEventListener("click", () => {
        const current = deliverLocation.textContent;
        const newLoc = window.prompt("Enter your delivery city or pin code:", current);
        if (newLoc && newLoc.trim()) {
          deliverLocation.textContent = newLoc.trim();
          showToast(`Delivery location updated to "${newLoc.trim()}"`);
        }
      });
    }

    // Catalog filtering
    document.querySelectorAll(".filter-pill").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        document.querySelectorAll(".filter-pill").forEach((b) => b.classList.remove("active"));
        e.currentTarget.classList.add("active");
        state.activeCategory = e.currentTarget.dataset.category;

        // Sync dropdown
        if (dom.deptSelect) {
          const matchOpt = Array.from(dom.deptSelect.options).find(
            (opt) => opt.value.toLowerCase() === state.activeCategory.toLowerCase()
          );
          dom.deptSelect.value = matchOpt ? matchOpt.value : "all";
        }

        renderProducts(dom.amzSearchInput ? dom.amzSearchInput.value : "");
      });
    });

    // Search bar
    if (dom.amzSearchBtn && dom.amzSearchInput) {
      const doSearch = () => {
        const query = dom.amzSearchInput.value.trim();
        // If user typed question for Aria, open Aria directly
        if (/where|how|can|refund|order|stock|help|who|what|\?/i.test(query)) {
          openAria(query);
        } else {
          renderProducts(query);
        }
      };
      dom.amzSearchBtn.addEventListener("click", doSearch);
      dom.amzSearchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doSearch();
      });
      dom.amzSearchInput.addEventListener("input", () => {
        renderProducts(dom.amzSearchInput.value);
      });
    }

    // Product card actions (Add to Cart, Ask Aria)
    if (dom.productGrid) {
      dom.productGrid.addEventListener("click", (e) => {
        const addBtn = e.target.closest("button[data-add-id]");
        if (addBtn) {
          const prod = state.products.find((p) => p.product_id === addBtn.dataset.addId);
          if (prod) addToCart(prod);
          return;
        }

        const askBtn = e.target.closest("button[data-ask-name]");
        if (askBtn) {
          openAria(`Do you have ${askBtn.dataset.askName} in stock?`);
        }
      });
    }

    // Orders Modal
    if (dom.ordersNavBtn) dom.ordersNavBtn.addEventListener("click", showOrdersModal);
    if (dom.closeOrdersModalBtn) dom.closeOrdersModalBtn.addEventListener("click", closeOrdersModal);
    if (dom.ordersModal) {
      dom.ordersModal.addEventListener("click", (e) => {
        if (e.target === dom.ordersModal) closeOrdersModal();
      });
    }

    // Order card action delegation
    if (dom.ordersList) {
      dom.ordersList.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-order-action]");
        if (!btn) return;
        const action = btn.dataset.orderAction;
        const ordId = btn.dataset.id;
        closeOrdersModal();

        if (action === "track") {
          openAria(`Where is my order ${ordId}?`);
        } else if (action === "cancel") {
          openAria(`Cancel my order ${ordId}`);
        } else if (action === "address") {
          openAria(`Change my delivery address for ${ordId} to 15 Park Street, Kolkata`);
        } else if (action === "damaged") {
          openAria(`My order ${ordId} arrived damaged. Please help.`);
        }
      });
    }
  }

  /* ---------- Initialization ---------- */

  function init() {
    loadCart();

    state.conversations = loadConversations()
      .filter((c) => c.messages.length > 0)
      .sort(byMostRecent);

    createConversation();
    state.activeId = state.conversations[0].id;
    saveConversations();

    bindEvents();
    renderHistory();
    renderActiveConversation();
    updateComposerState();

    fetchProducts();
    checkHealth();
    window.setInterval(checkHealth, CONFIG.healthCheckIntervalMs);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
