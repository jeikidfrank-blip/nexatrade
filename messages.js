const supabaseConfig = window.NEXATRADE_SUPABASE_CONFIG || window.NEXATRADE_SUPABASE || {};
const supabaseClient = window.supabase
  ? window.supabase.createClient(supabaseConfig.url, supabaseConfig.publishableKey)
  : null;

const state = {
  user: null,
  account: null,
  isVip: false,
  messages: [],
  balance: null
};

const els = {
  statePanel: document.getElementById("statePanel"),
  stateMessage: document.getElementById("stateMessage"),
  signInBtn: document.getElementById("signInBtn"),
  inboxView: document.getElementById("inboxView"),
  threadView: document.getElementById("threadView"),
  threadList: document.getElementById("threadList"),
  messageBubbles: document.getElementById("messageBubbles"),
  refreshBtn: document.getElementById("refreshBtn"),
  balanceNotifyBtn: document.getElementById("balanceNotifyBtn"),
  notifyMenu: document.getElementById("notifyMenu"),
  refreshMpesaBtn: document.getElementById("refreshMpesaBtn"),
  mpesaBalanceValue: document.getElementById("mpesaBalanceValue"),
  notifyDot: document.getElementById("notifyDot"),
  backToInbox: document.getElementById("backToInbox"),
  headerAvatar: document.getElementById("headerAvatar"),
  threadTitle: document.getElementById("threadTitle"),
  threadSubtitle: document.getElementById("threadSubtitle"),
  threadAvatar: document.getElementById("threadAvatar")
};

function setStateMessage(text, showSignIn = false) {
  if (els.stateMessage) els.stateMessage.textContent = text || "";
  if (els.statePanel) els.statePanel.hidden = !text;
  if (els.inboxView) els.inboxView.hidden = !!text;
  if (els.threadView) els.threadView.hidden = true;
  if (els.signInBtn) els.signInBtn.hidden = !showSignIn;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function formatMoney(amount) {
  const n = Number(amount);
  const safe = Number.isFinite(n) ? n : 0;
  return `$${safe.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "2-digit", month: "short" });
}

function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

function getInitial() {
  const email = (state.user && state.user.email) || "";
  return (email.trim().charAt(0) || "V").toUpperCase();
}

async function loadAccount() {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient.rpc("nexatrade_get_my_account");
  if (error) throw error;
  state.account = data || null;
  state.isVip = !!(data && (data.is_vip === true || String(data.account_type || "").toLowerCase() === "vip"));
  if (els.headerAvatar) els.headerAvatar.textContent = getInitial();
  return data;
}

async function loadBalance() {
  if (!supabaseClient || !state.user) return null;
  const { data, error } = await supabaseClient
    .from("real_test_accounts")
    .select("balance")
    .eq("user_id", state.user.id)
    .maybeSingle();
  if (error) {
    if (els.mpesaBalanceValue) els.mpesaBalanceValue.textContent = "Unavailable";
    return null;
  }
  const balance = data ? Number(data.balance || 0) : 0;
  state.balance = balance;
  if (els.mpesaBalanceValue) els.mpesaBalanceValue.textContent = formatMoney(balance);
  return balance;
}

async function loadMessages() {
  if (!supabaseClient) return [];
  const { data, error } = await supabaseClient.rpc("nexatrade_list_my_withdrawal_messages", { p_limit: 200 });
  if (error) throw error;
  state.messages = Array.isArray(data) ? data : [];
  return state.messages;
}

function renderInbox() {
  const list = els.threadList;
  if (!list) return;
  list.innerHTML = "";

  if (!state.messages.length) {
    list.innerHTML = '<div class="empty-note">No withdrawal messages yet. Successful NexaTrade real test withdrawals will appear here as MPESA messages.</div>';
    if (els.notifyDot) els.notifyDot.hidden = true;
    return;
  }

  const latest = state.messages[0];
  const preview = String(latest.body || "").replace(/\s+/g, " ").trim();
  const unreadCount = Math.min(state.messages.length, 99);
  if (els.notifyDot) els.notifyDot.hidden = state.messages.length === 0;

  const item = document.createElement("button");
  item.type = "button";
  item.className = "thread-item unread";
  item.innerHTML = `
    <div class="avatar mpesa">M</div>
    <div class="thread-main">
      <div class="sender">MPESA</div>
      <div class="preview">${escapeHtml(preview)}</div>
    </div>
    <div class="thread-side">
      <div class="time">${escapeHtml(formatTime(latest.created_at))}</div>
      <span class="badge">${unreadCount}</span>
    </div>`;
  item.addEventListener("click", openThread);
  list.appendChild(item);

  // Show recent individual messages as additional rows for visibility
  state.messages.slice(0, 8).forEach((msg, idx) => {
    if (idx === 0) return; // represented by MPESA thread
    const row = document.createElement("div");
    row.className = "thread-item";
    const label = (msg.sender || "MPESA") + " • " + formatMoney(msg.amount);
    const text = String(msg.body || "").replace(/\s+/g, " ").trim();
    row.innerHTML = `
      <div class="avatar default">$</div>
      <div class="thread-main">
        <div class="sender">${escapeHtml(label)}</div>
        <div class="preview">${escapeHtml(text)}</div>
      </div>
      <div class="thread-side"><div class="time">${escapeHtml(formatTime(msg.created_at))}</div></div>`;
    row.addEventListener("click", openThread);
    list.appendChild(row);
  });
}

function openThread() {
  if (!els.threadView || !els.inboxView) return;
  els.inboxView.hidden = true;
  els.threadView.hidden = false;
  if (els.notifyDot) els.notifyDot.hidden = true;

  const count = state.messages.length;
  if (els.threadTitle) els.threadTitle.textContent = "MPESA";
  if (els.threadSubtitle) els.threadSubtitle.textContent = count ? `${count} withdrawal message${count === 1 ? "" : "s"}` : "Withdrawal messages";
  if (els.threadAvatar) els.threadAvatar.textContent = "M";

  const wrap = els.messageBubbles;
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!count) {
    wrap.innerHTML = '<div class="empty-note">No messages.</div>';
    return;
  }

  // oldest first in thread view
  [...state.messages].reverse().forEach((msg) => {
    const details = [
      msg.body || `Withdrawal successful: ${formatMoney(msg.amount)} has been sent to your registered phone number.`,
      "",
      `Amount: ${formatMoney(msg.amount)} ${msg.currency || ""}`.trim(),
      `Phone: ${msg.phone || "Registered phone number"}`,
      `Status: ${msg.status || "successful"}`,
      `Reference: ${msg.reference || "—"}`,
      `Transaction ID: ${msg.transaction_id || "—"}`,
      `Time: ${formatDateTime(msg.created_at)}`
    ].join("\n");

    const item = document.createElement("div");
    item.className = "bubble-wrap";
    item.innerHTML = `
      <div class="bubble">${escapeHtml(details)}</div>
      <div class="bubble-time">${escapeHtml(formatDateTime(msg.created_at))}</div>`;
    wrap.appendChild(item);
  });
  wrap.scrollTop = wrap.scrollHeight;
}

function closeThread() {
  if (els.threadView) els.threadView.hidden = true;
  if (els.inboxView) els.inboxView.hidden = false;
}

async function refreshAll(showLoading = true) {
  if (showLoading) setStateMessage("Refreshing messages...", false);
  try {
    await Promise.all([loadMessages(), loadBalance()]);
    if (!state.isVip) {
      setStateMessage("This Messages app is available for VIP accounts only.", false);
      return;
    }
    if (els.statePanel) els.statePanel.hidden = true;
    if (els.inboxView) els.inboxView.hidden = false;
    if (els.threadView) els.threadView.hidden = true;
    renderInbox();
  } catch (error) {
    const msg = (error && (error.message || error.error_description)) || "Could not load messages.";
    setStateMessage(msg, false);
  }
}

async function init() {
  if (!supabaseClient) {
    setStateMessage("Supabase is not configured. Messages cannot be loaded.", false);
    return;
  }

  els.signInBtn?.addEventListener("click", () => { window.location.href = "index.html"; });
  els.refreshBtn?.addEventListener("click", () => refreshAll(true));
  els.refreshMpesaBtn?.addEventListener("click", async () => {
    els.refreshMpesaBtn.disabled = true;
    els.refreshMpesaBtn.textContent = "Refreshing...";
    await loadBalance();
    els.refreshMpesaBtn.disabled = false;
    els.refreshMpesaBtn.textContent = "Refresh M-Pesa balance";
  });
  els.balanceNotifyBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!els.notifyMenu) return;
    els.notifyMenu.hidden = !els.notifyMenu.hidden;
    if (!els.notifyMenu.hidden) loadBalance();
  });
  document.addEventListener("click", (e) => {
    if (!els.notifyMenu || els.notifyMenu.hidden) return;
    if (!els.notifyMenu.contains(e.target) && e.target !== els.balanceNotifyBtn) els.notifyMenu.hidden = true;
  });
  els.backToInbox?.addEventListener("click", closeThread);

  const { data } = await supabaseClient.auth.getSession();
  const session = data && data.session ? data.session : null;
  if (!session || !session.user) {
    setStateMessage("Sign in to NexaTrade to view your VIP withdrawal messages.", true);
    return;
  }

  state.user = session.user;
  setStateMessage("Checking account access...", false);

  try {
    await loadAccount();
  } catch (_) {
    // If profile RPC is not deployed yet, message RPC will enforce VIP/access and report clearly.
  }

  if (state.account && !state.isVip) {
    setStateMessage("This Messages app is available for VIP accounts only.", false);
    return;
  }

  await refreshAll(true);

  // Best-effort realtime refresh when new messages arrive
  try {
    supabaseClient
      .channel("withdrawal-messages-" + state.user.id)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "nexatrade_withdrawal_messages", filter: `user_id=eq.${state.user.id}` }, () => {
        refreshAll(false);
      })
      .subscribe();
  } catch (_) {}
}

init();
