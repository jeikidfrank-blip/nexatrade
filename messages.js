const supabaseConfig = window.NEXATRADE_SUPABASE_CONFIG || window.NEXATRADE_SUPABASE || {};
const supabaseClient = window.supabase
  ? window.supabase.createClient(supabaseConfig.url, supabaseConfig.publishableKey)
  : null;

const state = {
  user: null,
  messages: [],
  balance: null,
  currentThread: null
};

const els = {
  statusTime: document.getElementById("statusTime"),
  threadList: document.getElementById("threadList"),
  inboxView: document.getElementById("inboxView"),
  threadView: document.getElementById("threadView"),
  bubbleList: document.getElementById("bubbleList"),
  backBtn: document.getElementById("backBtn"),
  threadName: document.getElementById("threadName"),
  threadSub: document.getElementById("threadSub"),
  threadAvatar: document.getElementById("threadAvatar"),
  profileBtn: document.getElementById("profileBtn"),
  accountMenu: document.getElementById("accountMenu"),
  mpesaBalanceValue: document.getElementById("mpesaBalanceValue"),
  refreshMpesaBtn: document.getElementById("refreshMpesaBtn"),
  refreshMsgsBtn: document.getElementById("refreshMsgsBtn"),
  menuStatus: document.getElementById("menuStatus"),
  stateRow: document.getElementById("stateRow"),
  fab: document.getElementById("fab")
};

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

function relativeTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const diffMs = Math.max(0, now - d);
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins} min`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "2-digit", month: "short" });
}

function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function previewText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function personSvg() {
  return '<svg viewBox="0 0 24 24" class="person-ic" aria-hidden="true"><path d="M12 12a4.2 4.2 0 100-8.4 4.2 4.2 0 000 8.4zm0 2.1c-4.42 0-8 2.13-8 4.75V21h16v-2.15c0-2.62-3.58-4.75-8-4.75z" fill="currentColor"/></svg>';
}

function starTrailSvg() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" fill="currentColor"/></svg>';
}

function avatarForSender(sender) {
  const s = String(sender || "").toUpperCase();
  if (s === "MPESA") return { cls: "av-yellow", content: personSvg() };
  if (s.includes("JUMBE")) return { cls: "av-coral", content: personSvg() };
  if (s.includes("SAF")) return { cls: "av-green", content: personSvg() };
  if (s.includes("VOICE")) return { cls: "av-orange letter", content: "V" };
  if (s === "836") return { cls: "av-green", content: personSvg() };
  if (/^\d/.test(s)) return { cls: "av-cyan", content: personSvg() };
  if (s.includes("ONFON")) return { cls: "av-cyan", content: personSvg() };
  return { cls: "av-cyan", content: personSvg() };
}

function buildScreenshotThreads(realMpesaItems) {
  const mpesaItems = Array.isArray(realMpesaItems) && realMpesaItems.length ? realMpesaItems : null;
  const mpesaLatest = mpesaItems ? mpesaItems[0] : null;
  const mpesaThread = mpesaItems ? {
    sender: "MPESA",
    items: mpesaItems,
    latest: mpesaLatest,
    count: mpesaItems.length,
    preview: previewText(mpesaLatest.body || `Withdrawal successful ${formatMoney(mpesaLatest.amount)} has been sent to your registered phone number.`),
    timeLabel: relativeTime(mpesaLatest.created_at),
    badge: mpesaItems.length,
    trailIcon: null
  } : {
    sender: "MPESA",
    items: [{
      id: "demo-mpesa-1",
      sender: "MPESA",
      body: "UKNIU34L4U Confirmed. Fuliza M-PESA amount is Ksh 110.00. Interest charged Ksh 1.10. Total Fuliza M-PESA outstanding amount is Ksh 672.81 due on 22/12/26.",
      amount: 110.00,
      phone: "Registered phone number",
      status: "successful",
      reference: "UKNIU34L4U",
      transaction_id: "—",
      created_at: new Date(Date.now() - 32 * 60000).toISOString()
    }],
    latest: { body: "UKNIU34L4U Confirmed. Fuliz...", created_at: new Date(Date.now() - 32 * 60000).toISOString() },
    count: 1,
    preview: "UKNIU34L4U Confirmed. Fuliz...",
    timeLabel: "32 min",
    badge: 0,
    trailIcon: null
  };

  return [
    mpesaThread,
    {
      sender: "836",
      items: [{ id: "demo-836", sender: "836", body: "Do you like your friend's signature? Reply with '1' to set a signature for incoming calls or '2' to Skiza tune 7295062 by Oga Obinna.", amount: 0, phone: "836", status: "received", reference: "—", transaction_id: "—", created_at: new Date(Date.now() - 35 * 60000).toISOString() }],
      latest: { body: "Do you like your friend's signature? Reply with '1' to set...", created_at: new Date(Date.now() - 35 * 60000).toISOString() },
      count: 1,
      preview: "Do you like your friend's signature? Reply with '1' to set...",
      timeLabel: "35 min",
      badge: 1,
      trailIcon: null
    },
    {
      sender: "0742 974015",
      items: [{ id: "demo-0742", sender: "0742 974015", body: "If you don't know where you are going 🚶 , you might wind up somewhere else.", amount: 0, phone: "0742 974015", status: "received", reference: "—", transaction_id: "—", created_at: new Date(Date.now() - 35 * 60000).toISOString() }],
      latest: { body: "If you don't know where you are going 🚶 , you might wind up s...", created_at: new Date(Date.now() - 35 * 60000).toISOString() },
      count: 2,
      preview: "If you don't know where you are going 🚶 , you might wind up s...",
      timeLabel: "35 min",
      badge: 2,
      trailIcon: null
    },
    {
      sender: "MPESA JUMBE",
      items: [{ id: "demo-jumbe", sender: "MPESA JUMBE", body: "UKNIU34KZ0 Confirmed. You sent: Ksh100.00 to your M-PESA Wallet on 23/11/26 at 8:13 PM. New M-PESA Wallet balance is Ksh2.07.", amount: 100.00, phone: "M-PESA Wallet", status: "confirmed", reference: "UKNIU34KZ0", transaction_id: "—", created_at: new Date(Date.now() - 36 * 60000).toISOString() }],
      latest: { body: "UKNIU34KZ0 Confirmed. You sent: Ksh100.00...", created_at: new Date(Date.now() - 36 * 60000).toISOString() },
      count: 1,
      preview: "UKNIU34KZ0 Confirmed. You sent: Ksh100.00...",
      timeLabel: "36 min",
      badge: 1,
      trailIcon: null
    },
    {
      sender: "Safaricom",
      items: [{ id: "demo-saf1", sender: "Safaricom", body: "You have received 45 Talkmore Minutes. Expiry date 23-11-2026 11:59 PM. Dial *544# to check balance.", amount: 0, phone: "Safaricom", status: "received", reference: "—", transaction_id: "—", created_at: new Date().setHours(18,56,0,0) && new Date(new Date().setHours(18,56,0,0)).toISOString() }],
      latest: { body: "You have received 45 Talkmore Minutes. Expiry date 23-11-202...", created_at: new Date(new Date().setHours(18,56,0,0)).toISOString() },
      count: 1,
      preview: "You have received 45 Talkmore Minutes. Expiry date 23-11-202...",
      timeLabel: "18:56",
      badge: 1,
      trailIcon: null
    },
    {
      sender: "ONFONMOBILE",
      items: [{ id: "demo-onfon", sender: "ONFONMOBILE", body: "UKNIU32QLS Confirmed. Your transaction was successful.", amount: 0, phone: "ONFONMOBILE", status: "confirmed", reference: "UKNIU32QLS", transaction_id: "—", created_at: new Date(new Date().setHours(14,28,0,0)).toISOString() }],
      latest: { body: "UKNIU32QLS Confirmed...", created_at: new Date(new Date().setHours(14,28,0,0)).toISOString() },
      count: 1,
      preview: "UKNIU32QLS Confirmed...",
      timeLabel: "14:28",
      badge: 0,
      trailIcon: null
    },
    {
      sender: "Voice Mail",
      items: [{ id: "demo-vm", sender: "Voice Mail", body: "You 've been part of the journey now it's time for BIG rewards! Dial *123# to enjoy.", amount: 0, phone: "Voice Mail", status: "received", reference: "—", transaction_id: "—", created_at: new Date(new Date().setHours(13,10,0,0)).toISOString() }],
      latest: { body: "You 've been part of the journey now it's time for BIG rewards!...", created_at: new Date(new Date().setHours(13,10,0,0)).toISOString() },
      count: 1,
      preview: "You 've been part of the journey now it's time for BIG rewards!...",
      timeLabel: "",
      badge: 0,
      trailIcon: "star"
    },
    {
      sender: "SAFARICOM",
      items: [{ id: "demo-saf2", sender: "SAFARICOM", body: "Pay with confidence! My One App from Safaricom shows till offers, data deals and more.", amount: 0, phone: "SAFARICOM", status: "received", reference: "—", transaction_id: "—", created_at: new Date(new Date().setHours(12,30,0,0)).toISOString() }],
      latest: { body: "Pay with confidence! My One App from Safaricom shows till o...", created_at: new Date(new Date().setHours(12,30,0,0)).toISOString() },
      count: 1,
      preview: "Pay with confidence! My One App from Safaricom shows till o...",
      timeLabel: "",
      badge: 0,
      trailIcon: null
    }
  ];
}

function setStateRow(text) {
  if (!els.stateRow) return;
  if (!text) { els.stateRow.hidden = true; els.stateRow.textContent = ""; return; }
  els.stateRow.hidden = false;
  els.stateRow.textContent = text;
}

function setMenuStatus(text) {
  if (els.menuStatus) els.menuStatus.textContent = text || "";
}

function updateStatusTime() {
  if (!els.statusTime) return;
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  els.statusTime.textContent = `${hh}:${mm}`;
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

async function loadMessagesViaRpc() {
  const { data, error } = await supabaseClient.rpc("nexatrade_list_my_withdrawal_messages", { p_limit: 200 });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function loadMessagesFallback() {
  const { data, error } = await supabaseClient
    .from("nexatrade_withdrawal_messages")
    .select("*")
    .eq("user_id", state.user.id)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function loadMessages() {
  try {
    state.messages = await loadMessagesViaRpc();
  } catch (error) {
    try {
      state.messages = await loadMessagesFallback();
      return state.messages;
    } catch (_) {
      throw error;
    }
  }
  return state.messages;
}

function groupMessagesBySender(messages) {
  const groups = new Map();
  messages.forEach((m) => {
    const sender = String(m.sender || "MPESA").trim() || "MPESA";
    if (!groups.has(sender)) groups.set(sender, []);
    groups.get(sender).push(m);
  });
  return Array.from(groups.entries()).map(([sender, items]) => {
    const sorted = [...items].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    return { sender, items: sorted, latest: sorted[0], count: sorted.length };
  }).sort((a, b) => new Date(b.latest.created_at || 0) - new Date(a.latest.created_at || 0));
}

function getDisplayThreads() {
  const grouped = groupMessagesBySender(state.messages);
  const realMpesa = grouped.find((t) => String(t.sender).toUpperCase() === "MPESA");
  return buildScreenshotThreads(realMpesa ? realMpesa.items : null);
}

function renderInbox() {
  const list = els.threadList;
  if (!list) return;
  list.innerHTML = "";

  const threads = getDisplayThreads();
  threads.forEach((thread) => {
    const av = avatarForSender(thread.sender);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "thread-row";
    row.setAttribute("role", "listitem");
    const preview = thread.preview || previewText(thread.latest && thread.latest.body) || "";
    const timeLabel = thread.timeLabel != null ? thread.timeLabel : relativeTime(thread.latest && thread.latest.created_at);
    const badge = Number(thread.badge || 0);
    const trail = thread.trailIcon === "star"
      ? `<span class="trail-icon">${starTrailSvg()}</span>`
      : `${timeLabel ? `<span class="time">${escapeHtml(timeLabel)}</span>` : ""}${badge > 0 ? `<span class="unread-badge">${badge > 99 ? "99+" : badge}</span>` : ""}`;
    row.innerHTML = `
      <div class="list-avatar ${av.cls}">${av.content}</div>
      <div class="row-main">
        <div class="row-top"><span class="sender">${escapeHtml(thread.sender)}</span></div>
        <div class="preview-line"><span class="preview">${escapeHtml(preview)}</span></div>
      </div>
      <div class="row-trail">${trail}</div>`;
    row.addEventListener("click", () => openThread(thread.sender));
    list.appendChild(row);
  });
}

function openThread(sender) {
  state.currentThread = sender;
  const thread = getDisplayThreads().find((t) => t.sender === sender);
  if (!thread) return;
  if (els.inboxView) els.inboxView.hidden = true;
  if (els.threadView) els.threadView.hidden = false;
  if (els.fab) els.fab.hidden = true;
  const av = avatarForSender(sender);
  if (els.threadName) els.threadName.textContent = sender;
  if (els.threadSub) els.threadSub.textContent = `${thread.count} message${thread.count === 1 ? "" : "s"}`;
  if (els.threadAvatar) {
    els.threadAvatar.className = `list-avatar ${av.cls}`;
    els.threadAvatar.innerHTML = av.content;
  }
  renderBubbles(thread.items || []);
}

function renderBubbles(items) {
  if (!els.bubbleList) return;
  els.bubbleList.innerHTML = "";
  const sorted = [...items].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  sorted.forEach((msg) => {
    const body = msg.body || `Withdrawal successful ${formatMoney(msg.amount)} has been sent to your registered phone number.`;
    const text = `${body}\n\nAmount: ${formatMoney(msg.amount)}\nPhone: ${msg.phone || "Registered phone number"}\nStatus: ${msg.status || "successful"}\nReference: ${msg.reference || "—"}\nTransaction ID: ${msg.transaction_id || "—"}`;
    const row = document.createElement("div");
    row.className = "msg-row";
    row.innerHTML = `<div class="msg-bubble">${escapeHtml(text)}</div><div class="msg-time">${escapeHtml(formatDateTime(msg.created_at))}</div>`;
    els.bubbleList.appendChild(row);
  });
  els.bubbleList.scrollTop = els.bubbleList.scrollHeight;
}

function closeThread() {
  state.currentThread = null;
  if (els.threadView) els.threadView.hidden = true;
  if (els.inboxView) els.inboxView.hidden = false;
  if (els.fab) els.fab.hidden = false;
}

async function refreshAll(showStatus = false) {
  if (showStatus) setMenuStatus("Refreshing...");
  try {
    if (supabaseClient && state.user) {
      await Promise.all([loadMessages(), loadBalance()]);
    }
    renderInbox();
    if (state.currentThread) openThread(state.currentThread);
    if (showStatus) setMenuStatus("Updated");
  } catch (error) {
    const msg = (error && (error.message || error.error_description)) || "Could not load messages.";
    setMenuStatus(msg);
    renderInbox();
    if (state.currentThread) openThread(state.currentThread);
  } finally {
    if (showStatus) setTimeout(() => setMenuStatus(""), 1800);
  }
}

async function init() {
  updateStatusTime();
  setInterval(updateStatusTime, 30000);

  // Always render screenshot-matching inbox content; real NexaTrade MPESA messages replace demo MPESA when available.
  renderInbox();

  els.fab?.addEventListener("click", () => {});
  els.backBtn?.addEventListener("click", closeThread);
  els.profileBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!els.accountMenu) return;
    els.accountMenu.hidden = !els.accountMenu.hidden;
    if (!els.accountMenu.hidden && state.user) loadBalance();
  });
  document.addEventListener("click", (e) => {
    if (!els.accountMenu || els.accountMenu.hidden) return;
    if (!els.accountMenu.contains(e.target) && e.target !== els.profileBtn) els.accountMenu.hidden = true;
  });
  els.refreshMpesaBtn?.addEventListener("click", async () => {
    els.refreshMpesaBtn.disabled = true;
    setMenuStatus(state.user ? "Refreshing M-Pesa balance..." : "Sign in to NexaTrade to refresh balance");
    try { if (state.user) await loadBalance(); } catch (_) { setMenuStatus("Could not refresh balance"); }
    if (state.user) setMenuStatus("Balance updated");
    els.refreshMpesaBtn.disabled = false;
    setTimeout(() => setMenuStatus(""), 1800);
  });
  els.refreshMsgsBtn?.addEventListener("click", () => refreshAll(true));

  if (!supabaseClient) {
    setStateRow("");
    return;
  }

  try {
    const { data } = await supabaseClient.auth.getSession();
    const session = data && data.session ? data.session : null;
    if (!session || !session.user) {
      setStateRow("");
      return;
    }
    state.user = session.user;
    await refreshAll(false);
  } catch (_) {
    renderInbox();
  }

  try {
    if (state.user) {
      supabaseClient
        .channel("withdrawal-messages-" + state.user.id)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "nexatrade_withdrawal_messages", filter: `user_id=eq.${state.user.id}` }, () => {
          loadMessages().then(() => { renderInbox(); if (state.currentThread) openThread(state.currentThread); }).catch(() => {});
        })
        .subscribe();
    }
  } catch (_) {}
}

init();
