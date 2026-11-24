/* NEXATRADE SIMULATED M-PESA BALANCE */
const NEXA_MPESA_LIMIT = 500000;
const NEXA_MPESA_STORAGE = "nexa_mpesa_balance";
const NEXA_MPESA_TRANSACTIONS = "nexa_mpesa_transactions";

function getNexaMpesaBalance() {
  return Number(localStorage.getItem(NEXA_MPESA_STORAGE) || 0);
}

function recordNexaMpesaWithdrawal(amount, transactionId) {
  const value = Number(amount);

  if (!Number.isFinite(value) || value <= 0 || !transactionId) {
    return getNexaMpesaBalance();
  }

  let transactions = [];
  try {
    transactions = JSON.parse(localStorage.getItem(NEXA_MPESA_TRANSACTIONS) || "[]");
  } catch (_) {
    transactions = [];
  }

  // Prevent counting the same withdrawal twice
  if (transactions.some((tx) => tx && tx.id === String(transactionId))) {
    return getNexaMpesaBalance();
  }

  let balance = getNexaMpesaBalance() + value;

  // Reset when the limit is reached
  if (balance >= NEXA_MPESA_LIMIT) {
    balance = 0;
  }

  transactions.push({
    id: String(transactionId),
    amount: value,
    balanceAfter: balance
  });

  localStorage.setItem(NEXA_MPESA_TRANSACTIONS, JSON.stringify(transactions));
  localStorage.setItem(NEXA_MPESA_STORAGE, String(balance));

  return balance;
}

const supabaseConfig = window.NEXATRADE_SUPABASE_CONFIG || window.NEXATRADE_SUPABASE || {};
const supabaseClient = window.supabase
  ? window.supabase.createClient(supabaseConfig.url, supabaseConfig.publishableKey)
  : null;

const state = {
  user: null,
  messages: [],
  balance: null,
  currentThread: null,
  searchQuery: "",
  selectionMode: false,
  selected: new Set(),
  readMap: {},
  hidden: new Set(),
  lastRealMpesaIds: new Set(),
  initializedRealMpesa: false,
  newRealMpesa: false
};

function getReadMapStorageKey() {
  return `nexatrade_messages_read_${state.user?.id || "guest"}`;
}

function loadSavedReadMap() {
  try {
    const saved = localStorage.getItem(getReadMapStorageKey());
    state.readMap = saved ? JSON.parse(saved) : {};
  } catch (error) {
    state.readMap = {};
  }
}

function saveReadMap() {
  try {
    localStorage.setItem(
      getReadMapStorageKey(),
      JSON.stringify(state.readMap)
    );
  } catch (error) {
    console.warn("Could not save message read status:", error);
  }
}


const els = {
  statusTime: document.getElementById("statusTime"),
  topBar: document.getElementById("topBar"),
  threadList: document.getElementById("threadList"),
  inboxView: document.getElementById("inboxView"),
  threadView: document.getElementById("threadView"),
  bubbleList: document.getElementById("bubbleList"),
  backBtn: document.getElementById("backBtn"),
  threadName: document.getElementById("threadName"),
  threadSub: document.getElementById("threadSub"),
  threadAvatar: document.getElementById("threadAvatar"),
  threadMenuBtn: document.getElementById("threadMenuBtn"),
  threadFooter: document.getElementById("threadFooter"),
  profileBtn: document.getElementById("profileBtn"),
  accountMenu: document.getElementById("accountMenu"),
  mpesaBalanceValue: document.getElementById("mpesaBalanceValue"),
  refreshMpesaBtn: document.getElementById("refreshMpesaBtn"),
  refreshMsgsBtn: document.getElementById("refreshMsgsBtn"),
  openMpesaQuickBtn: document.getElementById("openMpesaQuickBtn"),
  menuStatus: document.getElementById("menuStatus"),
  stateRow: document.getElementById("stateRow"),
  fab: document.getElementById("fab"),
  searchBtn: document.getElementById("searchBtn"),
  searchHeader: document.getElementById("searchHeader"),
  normalHeader: document.getElementById("normalHeader"),
  searchBackBtn: document.getElementById("searchBackBtn"),
  searchInput: document.getElementById("searchInput"),
  searchClearBtn: document.getElementById("searchClearBtn"),
  selectionBar: document.getElementById("selectionBar"),
  selectionCancelBtn: document.getElementById("selectionCancelBtn"),
  selectionCount: document.getElementById("selectionCount"),
  markReadBtn: document.getElementById("markReadBtn"),
  deleteBtn: document.getElementById("deleteBtn"),
  mpesaAlert: document.getElementById("mpesaAlert"),
  mpesaAlertText: document.getElementById("mpesaAlertText"),
  snackbar: document.getElementById("snackbar"),
  composeView: document.getElementById("composeView"),
  composeBackBtn: document.getElementById("composeBackBtn"),
  composeOpenMpesa: document.getElementById("composeOpenMpesa"),
  appLock: document.getElementById("appLock"),
  appLockForm: document.getElementById("appLockForm"),
  appLockPassword: document.getElementById("appLockPassword"),
  appLockError: document.getElementById("appLockError"),
  appLockSubmit: document.getElementById("appLockSubmit")
};

const APP_UNLOCK_PASSWORD = "Kin254ke*";

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

function formatKsh(amount) {
  const n = Number(amount);
  const safe = Number.isFinite(n) ? n : 0;
  return "Ksh" + safe.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatMpesaDate(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return "23/11/26";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

function formatMpesaTime(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return "8:14 PM";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function maskMpesaPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length >= 10) {
    const start = digits.slice(0, 4);
    const end = digits.slice(-3);
    return `${start}***${end}`;
  }
  return "07** ***000";
}

function mpesaCode(msg) {
  const raw = String((msg && (msg.reference || msg.transaction_id || msg.id)) || "");
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (cleaned.length >= 10) return cleaned.slice(0, 10);
  let h = 0;
  for (let i = 0; i < raw.length; i += 1) h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
  const seed = Math.abs(h).toString(36).toUpperCase() + cleaned;
  return (seed + "UKNP52QKGJ").slice(0, 10);
}

function isNexaTradeMpesaWithdrawal(msg, thread) {
  if (!msg) return false;
  const sender = String(msg.sender || "").toUpperCase();
  if (sender !== "MPESA") return false;
  if (msg.nexatradeWithdrawal) return true;
  const ref = String(msg.reference || "");
  if (msg.transaction_id || ref.startsWith("DEMO-WDL")) return true;
  if (thread && thread.isRealMpesa) return true;
  return false;
}

function mpesaPreviewForWithdrawal(msg) {
  const amount = formatKsh(msg.amount || 0);
  const code = mpesaCode(msg);
  return `${code} Confirmed. You have received ${amount} from nexatrade.com...`;
}

function escapeHtmlWithLinks(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/(\d{2}\/\d{2}\/\d{2})/g, '<span class="mpesa-inline-link">$1</span>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a class="mpesa-inline-link" href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function showSnackbar(text) {
  if (!els.snackbar) return;
  els.snackbar.textContent = text || "";
  els.snackbar.hidden = !text;
  if (text) {
    clearTimeout(showSnackbar._t);
    showSnackbar._t = setTimeout(() => { els.snackbar.hidden = true; }, 2200);
  }
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
  const realPreview = mpesaLatest ? mpesaPreviewForWithdrawal(mpesaLatest) : null;
  const mpesaThread = mpesaItems ? {
    sender: "MPESA",
    items: mpesaItems,
    latest: mpesaLatest,
    count: mpesaItems.length,
    preview: realPreview,
    timeLabel: relativeTime(mpesaLatest.created_at),
    baseBadge: mpesaItems.length,
    trailIcon: null,
    isRealMpesa: true
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
      transaction_id: null,
      created_at: new Date(Date.now() - 32 * 60000).toISOString()
    }],
    latest: { body: "UKNIU34L4U Confirmed. Fuliz...", created_at: new Date(Date.now() - 32 * 60000).toISOString() },
    count: 1,
    preview: "UKNIU34L4U Confirmed. Fuliz...",
    timeLabel: "32 min",
    baseBadge: 0,
    trailIcon: null,
    isRealMpesa: false
  };

  return [
    mpesaThread,
    { sender: "836", items: [{ id: "demo-836", sender: "836", body: "Do you like your friend's signature? Reply with '1' to set a signature for incoming calls or '2' to Skiza tune 7295062 by Oga Obinna.", amount: 0, phone: "836", status: "received", reference: "—", transaction_id: "—", created_at: new Date(Date.now() - 35 * 60000).toISOString() }], latest: { body: "Do you like your friend's signature? Reply with '1' to set...", created_at: new Date(Date.now() - 35 * 60000).toISOString() }, count: 1, preview: "Do you like your friend's signature? Reply with '1' to set...", timeLabel: "35 min", baseBadge: 1, trailIcon: null },
    { sender: "0742 974015", items: [{ id: "demo-0742", sender: "0742 974015", body: "If you don't know where you are going 🚶 , you might wind up somewhere else.", amount: 0, phone: "0742 974015", status: "received", reference: "—", transaction_id: "—", created_at: new Date(Date.now() - 35 * 60000).toISOString() }], latest: { body: "If you don't know where you are going 🚶 , you might wind up s...", created_at: new Date(Date.now() - 35 * 60000).toISOString() }, count: 2, preview: "If you don't know where you are going 🚶 , you might wind up s...", timeLabel: "35 min", baseBadge: 2, trailIcon: null },
    { sender: "MPESA JUMBE", items: [{ id: "demo-jumbe", sender: "MPESA JUMBE", body: "UKNIU34KZ0 Confirmed. You sent: Ksh100.00 to your M-PESA Wallet on 23/11/26 at 8:13 PM. New M-PESA Wallet balance is Ksh2.07.", amount: 100.00, phone: "M-PESA Wallet", status: "confirmed", reference: "UKNIU34KZ0", transaction_id: "—", created_at: new Date(Date.now() - 36 * 60000).toISOString() }], latest: { body: "UKNIU34KZ0 Confirmed. You sent: Ksh100.00...", created_at: new Date(Date.now() - 36 * 60000).toISOString() }, count: 1, preview: "UKNIU34KZ0 Confirmed. You sent: Ksh100.00...", timeLabel: "36 min", baseBadge: 1, trailIcon: null },
    { sender: "Safaricom", items: [{ id: "demo-saf1", sender: "Safaricom", body: "You have received 45 Talkmore Minutes. Expiry date 23-11-2026 11:59 PM. Dial *544# to check balance.", amount: 0, phone: "Safaricom", status: "received", reference: "—", transaction_id: "—", created_at: new Date(new Date().setHours(18, 56, 0, 0)).toISOString() }], latest: { body: "You have received 45 Talkmore Minutes. Expiry date 23-11-202...", created_at: new Date(new Date().setHours(18, 56, 0, 0)).toISOString() }, count: 1, preview: "You have received 45 Talkmore Minutes. Expiry date 23-11-202...", timeLabel: "18:56", baseBadge: 1, trailIcon: null },
    { sender: "ONFONMOBILE", items: [{ id: "demo-onfon", sender: "ONFONMOBILE", body: "UKNIU32QLS Confirmed. Your transaction was successful.", amount: 0, phone: "ONFONMOBILE", status: "confirmed", reference: "UKNIU32QLS", transaction_id: "—", created_at: new Date(new Date().setHours(14, 28, 0, 0)).toISOString() }], latest: { body: "UKNIU32QLS Confirmed...", created_at: new Date(new Date().setHours(14, 28, 0, 0)).toISOString() }, count: 1, preview: "UKNIU32QLS Confirmed...", timeLabel: "14:28", baseBadge: 0, trailIcon: null },
    { sender: "Voice Mail", items: [{ id: "demo-vm", sender: "Voice Mail", body: "You 've been part of the journey now it's time for BIG rewards! Dial *123# to enjoy.", amount: 0, phone: "Voice Mail", status: "received", reference: "—", transaction_id: "—", created_at: new Date(new Date().setHours(13, 10, 0, 0)).toISOString() }], latest: { body: "You 've been part of the journey now it's time for BIG rewards!...", created_at: new Date(new Date().setHours(13, 10, 0, 0)).toISOString() }, count: 1, preview: "You 've been part of the journey now it's time for BIG rewards!...", timeLabel: "", baseBadge: 0, trailIcon: "star" },
    { sender: "SAFARICOM", items: [{ id: "demo-saf2", sender: "SAFARICOM", body: "Pay with confidence! My One App from Safaricom shows till offers, data deals and more.", amount: 0, phone: "SAFARICOM", status: "received", reference: "—", transaction_id: "—", created_at: new Date(new Date().setHours(12, 30, 0, 0)).toISOString() }], latest: { body: "Pay with confidence! My One App from Safaricom shows till o...", created_at: new Date(new Date().setHours(12, 30, 0, 0)).toISOString() }, count: 1, preview: "Pay with confidence! My One App from Safaricom shows till o...", timeLabel: "", baseBadge: 0, trailIcon: null }
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

function detectNewRealMpesa() {
  const grouped = groupMessagesBySender(state.messages);
  const realMpesa = grouped.find((t) => String(t.sender).toUpperCase() === "MPESA");
  const ids = new Set((realMpesa ? realMpesa.items : []).map((m) => String(m.id || "")));
  if (!state.initializedRealMpesa) {
    state.lastRealMpesaIds = ids;
    state.initializedRealMpesa = true;
    state.newRealMpesa = false;
    return;
  }
  let hasNew = false;
  ids.forEach((id) => { if (id && !state.lastRealMpesaIds.has(id)) hasNew = true; });
  if (hasNew) {
    state.newRealMpesa = true;
    // make MPESA unread so it's easy to notice/open
    state.readMap["MPESA"] = "unread";
  }
  state.lastRealMpesaIds = ids;
}

async function loadMessages() {
  try {
    state.messages = await loadMessagesViaRpc();
  } catch (rpcError) {
    try {
      state.messages = await loadMessagesFallback();
    } catch (fallbackError) {
      state.messages = [];
      console.warn("Could not load NexaTrade withdrawal messages", rpcError || fallbackError);
    }
  }
  detectNewRealMpesa();
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

function isUnread(thread) {
  const key = thread.sender;
  if (state.readMap[key] === "unread") return true;
  if (state.readMap[key] === "read") return false;
  return Number(thread.baseBadge || 0) > 0;
}

function getDisplayThreads() {
  const grouped = groupMessagesBySender(state.messages);
  const realMpesa = grouped.find((t) => String(t.sender).toUpperCase() === "MPESA");
  let threads = buildScreenshotThreads(realMpesa ? realMpesa.items : null);
  threads = threads.filter((t) => !state.hidden.has(t.sender));
  const q = state.searchQuery.trim().toLowerCase();
  if (q) {
    threads = threads.filter((t) => {
      const hay = `${t.sender} ${t.preview || ""} ${(t.items || []).map((i) => i.body || "").join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }
  // move MPESA to top when real withdrawals are flowing in
  if (realMpesa && realMpesa.items.length) {
    threads.sort((a, b) => (a.sender === "MPESA" ? -1 : 0) - (b.sender === "MPESA" ? -1 : 0));
  }
  return threads;
}

function updateHeaderModes() {
  const searching = state.searchQuery !== "" || (els.searchHeader && !els.searchHeader.hidden);
  if (els.normalHeader) els.normalHeader.hidden = !!state.selectionMode || searching;
  if (els.searchHeader) els.searchHeader.hidden = !!state.selectionMode || !searching;
  if (els.selectionBar) els.selectionBar.hidden = !state.selectionMode;
  if (els.selectionCount) els.selectionCount.textContent = `${state.selected.size} selected`;
}

function renderInbox() {
  const list = els.threadList;
  if (!list) return;
  updateHeaderModes();
  list.innerHTML = "";

  const threads = getDisplayThreads();
  if (!threads.length) {
    list.innerHTML = '<div class="state-row" style="padding:24px 24px;color:#9aa0a6;">No conversations found.</div>';
    updateMpesaAlert();
    return;
  }

  threads.forEach((thread) => {
    const av = avatarForSender(thread.sender);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "thread-row";
    row.setAttribute("role", "listitem");
    const unread = isUnread(thread);
    if (unread) row.classList.add("unread");
    if (state.selected.has(thread.sender)) row.classList.add("selected");

    const preview = thread.preview || previewText(thread.latest && thread.latest.body) || "";
    const timeLabel = thread.timeLabel != null ? thread.timeLabel : relativeTime(thread.latest && thread.latest.created_at);
    const badgeCount = unread ? Math.max(1, Number(thread.baseBadge || 0) || (thread.count || 0)) : 0;
    const showBadge = badgeCount > 0 && thread.trailIcon !== "star";
    const avatarHtml = state.selectionMode && state.selected.has(thread.sender)
      ? '<div class="list-avatar av-cyan"><span class="select-check">✓</span></div>'
      : `<div class="list-avatar ${av.cls}">${av.content}</div>`;
    const trail = thread.trailIcon === "star"
      ? `<span class="trail-icon">${starTrailSvg()}</span>`
      : `${timeLabel ? `<span class="time">${escapeHtml(timeLabel)}</span>` : ""}${showBadge ? `<span class="unread-badge">${badgeCount > 99 ? "99+" : badgeCount}</span>` : ""}`;

    row.innerHTML = `
      ${avatarHtml}
      <div class="row-main">
        <div class="row-top"><span class="sender">${escapeHtml(thread.sender)}</span></div>
        <div class="preview-line"><span class="preview">${escapeHtml(preview)}</span></div>
      </div>
      <div class="row-trail">${trail}</div>`;

    let pressTimer = null;
    const startPress = () => { pressTimer = setTimeout(() => enterSelection(thread.sender), 450); };
    const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
    row.addEventListener("mousedown", startPress);
    row.addEventListener("touchstart", startPress, { passive: true });
    row.addEventListener("mouseup", cancelPress);
    row.addEventListener("mouseleave", cancelPress);
    row.addEventListener("touchend", cancelPress);
    row.addEventListener("touchcancel", cancelPress);
    row.addEventListener("click", (e) => {
      cancelPress();
      if (state.selectionMode) { toggleSelect(thread.sender); e.preventDefault(); return; }
      openThread(thread.sender);
    });
    list.appendChild(row);
  });
  updateMpesaAlert();
}

function enterSelection(sender) {
  state.selectionMode = true;
  state.selected.clear();
  if (sender) state.selected.add(sender);
  showSnackbar("");
  renderInbox();
}

function exitSelection() {
  state.selectionMode = false;
  state.selected.clear();
  renderInbox();
}

function toggleSelect(sender) {
  if (state.selected.has(sender)) state.selected.delete(sender); else state.selected.add(sender);
  if (!state.selected.size) exitSelection(); else renderInbox();
}

function markSelectedReadToggle() {
  const threads = getDisplayThreads();
  const selectedThreads = threads.filter((t) => state.selected.has(t.sender));
  const anyUnread = selectedThreads.some((t) => isUnread(t));
  selectedThreads.forEach((t) => { state.readMap[t.sender] = anyUnread ? "read" : "unread"; });
  saveReadMap();
  if (anyUnread && state.selected.has("MPESA")) state.newRealMpesa = false;
  showSnackbar(anyUnread ? "Marked as read" : "Marked as unread");
  exitSelection();
}

function deleteSelected() {
  state.selected.forEach((s) => state.hidden.add(s));
  if (state.selected.has("MPESA")) state.newRealMpesa = false;
  showSnackbar("Conversation deleted");
  exitSelection();
}

function updateMpesaAlert() {
  if (!els.mpesaAlert) return;
  const grouped = groupMessagesBySender(state.messages);
  const realMpesa = grouped.find((t) => String(t.sender).toUpperCase() === "MPESA");
  const hasReal = !!(realMpesa && realMpesa.items.length);
  const show = hasReal && state.newRealMpesa && !state.hidden.has("MPESA") && state.currentThread !== "MPESA";
  els.mpesaAlert.hidden = !show;
  if (show && els.mpesaAlertText) {
    const n = realMpesa.items.length;
    els.mpesaAlertText.textContent = `${n} NexaTrade withdrawal message${n === 1 ? "" : "s"} in MPESA`;
  }
}

function openThread(sender) {
  state.currentThread = sender;
  const thread = getDisplayThreads().find((t) => t.sender === sender) || buildScreenshotThreads(groupMessagesBySender(state.messages).find((t) => String(t.sender).toUpperCase() === "MPESA")?.items || null).find((t) => t.sender === sender);
  if (!thread) return;
  state.readMap[sender] = "read";
  saveReadMap();
  if (sender === "MPESA") state.newRealMpesa = false;
  if (els.inboxView) els.inboxView.hidden = true;
  if (els.threadView) els.threadView.hidden = false;
  if (els.fab) els.fab.hidden = true;
  if (els.composeView) els.composeView.hidden = true;
  if (els.topBar) els.topBar.hidden = true;
  const av = avatarForSender(sender);
  if (els.threadName) els.threadName.textContent = sender;
  const isMpesaThread = String(sender).toUpperCase() === "MPESA";
  if (els.threadSub) {
    els.threadSub.textContent = isMpesaThread ? "" : `${thread.count} message${thread.count === 1 ? "" : "s"}`;
    els.threadSub.hidden = isMpesaThread;
  }
  if (els.threadAvatar) {
    els.threadAvatar.className = `list-avatar ${av.cls}`;
    els.threadAvatar.innerHTML = av.content;
  }
  if (els.threadFooter) {
    if (isMpesaThread) {
      els.threadFooter.className = "compose-readonly mpesa-reply-footer";
      els.threadFooter.innerHTML = `Sender can't accept replies. <a href="#" class="mpesa-learn-more" aria-label="Learn more">Learn more</a>`;
    } else {
      els.threadFooter.className = "compose-readonly";
      els.threadFooter.textContent = "Text message • NexaTrade withdrawal inbox";
    }
  }
  renderBubbles(thread.items || [], thread);
  renderInbox(); // update badges/read state behind
  if (els.inboxView) els.inboxView.hidden = true; // keep thread visible
}

function renderNexaTradeMpesaDetail(msg) {
  const amountValue = Number(msg.amount || 0);
  const amount = formatKsh(amountValue);
  const code = mpesaCode(msg);
  const date = formatMpesaDate(msg.created_at);
  const time = formatMpesaTime(msg.created_at);
  const txKey = String((msg && (msg.id || msg.transaction_id || msg.reference)) || code);
  const balance = formatKsh(recordNexaMpesaWithdrawal(amountValue, txKey));

  const smsText = [
    code,
    "Confirmed.You have",
    `received ${amount} from`,
    "nexatrade limited on",
    `${date} at ${time}`,
    "New M-PESA balance is",
    `${balance}. Invest & earn`,
    "daily interest with ZIIDI on",
    "https://saf.cx/cF6ir"
  ].join("\n");

  const row = document.createElement("div");
  row.className = "msg-row mpesa-detail-row";

  row.innerHTML = `
    <div class="mpesa-bubble-row">
      <div class="msg-bubble mpesa-sms-bubble">
        <div class="mpesa-sms-text">${escapeHtmlWithLinks(smsText)}</div>
      </div>
      <button class="mpesa-bubble-action" type="button" aria-label="Forward message">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
          <path d="M12 8l4 4-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M16 8l4 4-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M20 12H7a3 3 0 0 0 0 6h1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
    <div class="mpesa-rich-wrap">
      <a class="mpesa-rich-card mpesa-rich-card-image" href="https://saf.cx/cF6ir" target="_blank" rel="noopener noreferrer" aria-label="Open M-PESA information link">
        <img src="safaricom-mpesa.png" alt="Simulated M-PESA message" class="mpesa-rich-image">
        <span class="mpesa-rich-footer">
          <span class="mpesa-rich-footer-title">Fintech App</span>
          <span class="mpesa-rich-footer-url">saf.cx</span>
        </span>
      </a>
    </div>
  `;

  return row;
}


function renderGenericBubble(msg) {
  const row = document.createElement("div");
  row.className = "msg-row";
  const body = String(msg.body || "").trim() || "No message content.";
  const time = msg.created_at ? formatDateTime(msg.created_at) : "";
  row.innerHTML = `
    <div class="msg-bubble">
      <div class="msg-body-text">${escapeHtml(body)}</div>
      ${time ? `<div class="msg-time">${escapeHtml(time)}</div>` : ""}
    </div>
  `;
  return row;
}

function renderBubbles(items, thread) {
  if (!els.bubbleList) return;

  els.bubbleList.innerHTML = "";

  const sorted = [...items].sort(
    (a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0)
  );
  const sender = String((thread && thread.sender) || state.currentThread || "").toUpperCase();

  sorted.forEach((msg) => {
    let row;
    if (sender === "MPESA" && isNexaTradeMpesaWithdrawal(msg, thread)) {
      row = renderNexaTradeMpesaDetail(msg);
    } else {
      row = renderGenericBubble(msg);
    }
    els.bubbleList.appendChild(row);
  });

  els.bubbleList.scrollTop = els.bubbleList.scrollHeight;
}



function closeThread() {
  state.currentThread = null;
  if (els.threadSub) els.threadSub.hidden = false;
  if (els.threadFooter) {
    els.threadFooter.className = "compose-readonly";
    els.threadFooter.textContent = "Text message • NexaTrade withdrawal inbox";
  }
  if (els.threadView) els.threadView.hidden = true;
  if (els.inboxView) els.inboxView.hidden = false;
  if (els.fab) els.fab.hidden = false;
  renderInbox();
}

function openCompose() {
  if (els.composeView) els.composeView.hidden = false;
  if (els.fab) els.fab.hidden = true;
}

function closeCompose() {
  if (els.composeView) els.composeView.hidden = true;
  if (els.fab && els.threadView && els.threadView.hidden) els.fab.hidden = false;
}

function enterSearch() {
  if (els.searchHeader) els.searchHeader.hidden = false;
  if (els.normalHeader) els.normalHeader.hidden = true;
  if (els.searchInput) { els.searchInput.value = state.searchQuery || ""; els.searchInput.focus(); }
  renderInbox();
}

function exitSearch() {
  state.searchQuery = "";
  if (els.searchInput) els.searchInput.value = "";
  if (els.searchHeader) els.searchHeader.hidden = true;
  if (els.normalHeader) els.normalHeader.hidden = false;
  renderInbox();
}

async function refreshAll(showStatus = false, opts = {}) {
  if (showStatus) setMenuStatus("Refreshing...");
  try {
    if (supabaseClient && state.user) {
      await Promise.all([loadMessages(), loadBalance()]);
    }
    renderInbox();
    if (state.currentThread) openThread(state.currentThread);
    if (showStatus) setMenuStatus("Updated");
    if (opts.autoOpenMpesa && state.newRealMpesa) openThread("MPESA");
  } catch (error) {
    const msg = (error && (error.message || error.error_description)) || "Could not load messages.";
    setMenuStatus(msg);
    renderInbox();
  } finally {
    if (showStatus) setTimeout(() => setMenuStatus(""), 1800);
  }
}

function showAppLock() {
  if (els.appLock) els.appLock.hidden = false;
  if (els.appLockError) els.appLockError.hidden = true;
  if (els.appLockPassword) {
    els.appLockPassword.value = "";
    setTimeout(() => els.appLockPassword.focus(), 0);
  }
}

function hideAppLock() {
  if (els.appLock) els.appLock.hidden = true;
}

async function triggerAppUpdatesOnUnlock() {
  try {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) registration.update().catch(() => { });
    }
  } catch (_) { }
  await refreshAll(true);
  if (state.newRealMpesa) openThread("MPESA");
}

async function startApp() {
  if (!supabaseClient) { setStateRow(""); return; }

  try {
    const { data } = await supabaseClient.auth.getSession();
    const session = data && data.session ? data.session : null;
    if (!session || !session.user) { setStateRow("Sign in to NexaTrade to load withdrawal messages."); return; }
    state.user = session.user;
    loadSavedReadMap();
    await refreshAll(false);
  } catch (_) {
    renderInbox();
  }

  try {
    if (state.user) {
      supabaseClient
        .channel("withdrawal-messages-" + state.user.id)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "nexatrade_withdrawal_messages", filter: `user_id=eq.${state.user.id}` }, () => {
          refreshAll(false).then(() => {
            showSnackbar("New NexaTrade withdrawal received");
          }).catch(() => { });
        })
        .subscribe();
    }
  } catch (_) { }

  // Poll as a fallback in case realtime publication/subscription is unavailable.
  if (state.user && supabaseClient) {
    setInterval(() => {
      if (document.visibilityState === "hidden") return;
      refreshAll(false).catch(() => { });
    }, 12000);
  }
}

async function handleUnlockSubmit(event) {
  if (event) event.preventDefault();
  const entered = els.appLockPassword ? String(els.appLockPassword.value || "") : "";
  if (entered !== APP_UNLOCK_PASSWORD) {
    if (els.appLockError) els.appLockError.hidden = false;
    if (els.appLockPassword) {
      els.appLockPassword.focus();
      els.appLockPassword.select();
    }
    return;
  }
  if (els.appLockError) els.appLockError.hidden = true;
  if (els.appLockSubmit) els.appLockSubmit.disabled = true;
  hideAppLock();
  try {
    if (!state.appStarted) {
      state.appStarted = true;
      await startApp();
    }
    await triggerAppUpdatesOnUnlock();
  } finally {
    if (els.appLockSubmit) els.appLockSubmit.disabled = false;
  }
}

function init() {
  updateStatusTime();
  setInterval(updateStatusTime, 30000);

  renderInbox();

  els.fab?.addEventListener("click", openCompose);
  els.backBtn?.addEventListener("click", closeThread);
  els.composeBackBtn?.addEventListener("click", closeCompose);
  els.composeOpenMpesa?.addEventListener("click", () => { closeCompose(); openThread("MPESA"); });
  els.mpesaAlert?.addEventListener("click", () => openThread("MPESA"));
  els.openMpesaQuickBtn?.addEventListener("click", () => { if (els.accountMenu) els.accountMenu.hidden = true; openThread("MPESA"); });

  els.searchBtn?.addEventListener("click", enterSearch);
  els.searchBackBtn?.addEventListener("click", exitSearch);
  els.searchInput?.addEventListener("input", (e) => {
    state.searchQuery = e.target.value || "";
    if (els.searchClearBtn) els.searchClearBtn.hidden = !state.searchQuery;
    renderInbox();
  });
  els.searchClearBtn?.addEventListener("click", () => {
    state.searchQuery = "";
    if (els.searchInput) { els.searchInput.value = ""; els.searchInput.focus(); }
    if (els.searchClearBtn) els.searchClearBtn.hidden = true;
    renderInbox();
  });

  els.selectionCancelBtn?.addEventListener("click", exitSelection);
  els.markReadBtn?.addEventListener("click", markSelectedReadToggle);
  els.deleteBtn?.addEventListener("click", deleteSelected);

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

  els.appLockForm?.addEventListener("submit", handleUnlockSubmit);
  showAppLock();
}

init();
