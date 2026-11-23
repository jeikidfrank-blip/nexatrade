const config = window.NEXATRADE_SUPABASE_CONFIG;
const supabaseClient = window.supabase.createClient(config.url, config.publishableKey);

const message = document.getElementById("dashboardMessage");
const globalMessage = document.getElementById("globalMessage");
const tbody = document.getElementById("usersTable");
const balanceMessage = document.getElementById("balanceMessage");

let allUsers = [];
let activeProfileUser = null;

function setMessage(element, text, type = "info") {
  if (!element) return;
  element.textContent = text || "";
  element.className = `message ${type}`.trim();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

function formatMoney(amount, currency = "KSh") {
  const n = Number(amount);
  const safe = Number.isFinite(n) ? n : 0;
  try {
    return new Intl.NumberFormat("en-KE", { style: "currency", currency: currency === "$" ? "USD" : "KES", maximumFractionDigits: 2 }).format(safe).replace("KES", currency === "$" ? "$" : "KSh");
  } catch {
    return `${currency} ${safe.toFixed(2)}`;
  }
}

function formatKsh(amount) {
  const n = Number(amount);
  const safe = Number.isFinite(n) ? n : 0;
  return `KSh ${safe.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getErrorMessage(error, fallback = "Something went wrong.") {
  return (error && (error.message || error.error_description || error.details)) || fallback;
}

async function protectDashboard() {
  const { data } = await supabaseClient.auth.getSession();
  if (!data.session) {
    window.location.replace("index.html");
    return false;
  }

  const { error: adminError } = await supabaseClient.rpc("admin_get_settings");
  if (adminError) {
    const text = "Admin access check failed: " + adminError.message + ". Deploy/run admin SQL RPCs and ensure this account is recognized as admin.";
    setMessage(message, text, "error");
    setMessage(globalMessage, text, "error");
    return false;
  }

  return true;
}

function normalizeUserField(user, keys, fallback = "") {
  for (const key of keys) {
    if (user && user[key] != null && user[key] !== "") return user[key];
  }
  return fallback;
}

function renderUsers() {
  if (!tbody) return;
  const search = String(document.getElementById("userSearch")?.value || "").trim().toLowerCase();
  const accountFilter = document.getElementById("accountFilter")?.value || "all";
  const statusFilter = document.getElementById("statusFilter")?.value || "all";

  const filtered = allUsers.filter((user) => {
    const fullName = String(normalizeUserField(user, ["full_name", "name", "fullName"], "")).toLowerCase();
    const email = String(user.email || "").toLowerCase();
    const id = String(user.id || "").toLowerCase();
    const phone = String(normalizeUserField(user, ["phone", "phone_number"], "")).toLowerCase();
    const accountType = String(user.account_type || "standard").toLowerCase();
    const status = String(user.status || "active").toLowerCase();

    if (search && !fullName.includes(search) && !email.includes(search) && !id.includes(search) && !phone.includes(search)) return false;
    if (accountFilter !== "all" && accountType !== accountFilter) return false;
    if (statusFilter !== "all" && status !== statusFilter) return false;
    return true;
  });

  tbody.innerHTML = "";
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="5">No users match the current filters.</td></tr>';
    return;
  }

  filtered.forEach((user) => {
    const row = document.createElement("tr");
    const name = normalizeUserField(user, ["full_name", "name", "fullName"], "Name not provided");
    const email = user.email || "No email";
    const phone = normalizeUserField(user, ["phone", "phone_number"], "");
    const accountType = String(user.account_type || "standard");
    const status = String(user.status || "active");

    const userCell = document.createElement("td");
    userCell.innerHTML = `<div class="user-cell"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(email)}</span><small>${escapeHtml(phone || "No phone")} · ${escapeHtml(user.id || "")}</small></div>`;

    const accountCell = document.createElement("td");
    accountCell.innerHTML = `<span class="pill ${accountType.toLowerCase() === "vip" ? "vip" : "standard"}">${escapeHtml(accountType)}</span>`;

    const statusCell = document.createElement("td");
    const statusClass = ["active", "suspended", "blocked"].includes(status.toLowerCase()) ? status.toLowerCase() : "muted-pill";
    statusCell.innerHTML = `<span class="pill ${statusClass}">${escapeHtml(status)}</span>`;

    const dateCell = document.createElement("td");
    dateCell.textContent = formatDate(user.created_at);

    const actionCell = document.createElement("td");
    actionCell.className = "actions-cell";
    const select = document.createElement("select");
    select.className = "user-action-select";
    [["", "Select action"], ["vip", "Make VIP"], ["standard", "Make Standard"], ["active", "Activate"], ["suspended", "Suspend"], ["blocked", "Block"]].forEach(([v, label]) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = label;
      select.appendChild(opt);
    });

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "user-action-button";
    applyBtn.textContent = "Apply";
    applyBtn.addEventListener("click", async () => {
      const action = select.value;
      if (!action) { setMessage(message, "Choose an action first (VIP, Standard, Activate, Suspend, or Block).", "error"); return; }
      let accountTypeUpdate = null;
      let statusUpdate = null;
      if (["vip", "standard"].includes(action)) accountTypeUpdate = action; else statusUpdate = action;
      if (!confirm(`Confirm ${action} for ${email}?`)) return;

      applyBtn.disabled = true;
      select.disabled = true;
      applyBtn.textContent = "Applying...";
      setMessage(message, `Applying "${action}" to ${email}...`, "info");

      const payloads = [
        { p_user_id: user.id, p_account_type: accountTypeUpdate, p_status: statusUpdate },
        { user_id: user.id, account_type: accountTypeUpdate, status: statusUpdate }
      ];
      let error = null;
      for (let i = 0; i < payloads.length; i++) {
        const res = await supabaseClient.rpc("admin_update_user", payloads[i]);
        if (!res.error) { error = null; break; }
        error = res.error;
        const msg = String(getErrorMessage(res.error)).toLowerCase();
        const maybeSignature = msg.includes("function") || msg.includes("argument") || msg.includes("parameter") || msg.includes("schema cache");
        if (!maybeSignature || i === payloads.length - 1) break;
      }

      applyBtn.disabled = false;
      select.disabled = false;
      applyBtn.textContent = "Apply";

      if (error) {
        setMessage(message, `Action "${action}" failed: ${getErrorMessage(error)}. Ensure admin_update_user RPC is deployed and this account is recognized as admin.`, "error");
        return;
      }
      select.value = "";
      setMessage(message, `User updated successfully (${action}).`, "success");
      await loadUsers();
      await loadOverview();
    });

    const profileBtn = document.createElement("button");
    profileBtn.type = "button";
    profileBtn.className = "profile-button secondary-button small-btn";
    profileBtn.textContent = "Profile & balances";
    profileBtn.addEventListener("click", () => showUserProfile(user));

    actionCell.append(select, applyBtn, profileBtn);
    row.append(userCell, accountCell, statusCell, dateCell, actionCell);
    tbody.appendChild(row);
  });
}

async function loadUsers() {
  setMessage(message, "Loading registered users...", "info");
  const { data, error } = await supabaseClient.rpc("admin_list_users");
  if (error) {
    setMessage(message, "Unable to load users: " + getErrorMessage(error) + " (admin_list_users RPC must be available)", "error");
    allUsers = [];
    renderUsers();
    return;
  }

  allUsers = Array.isArray(data) ? data : (Array.isArray(data?.users) ? data.users : []);
  const total = allUsers.length;
  const vip = allUsers.filter((u) => String(u.account_type || "").toLowerCase() === "vip").length;
  const restricted = allUsers.filter((u) => ["suspended", "blocked"].includes(String(u.status || "").toLowerCase())).length;

  const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  setText("totalUsers", String(total));
  setText("vipUsers", String(vip));
  setText("restrictedUsers", String(restricted));

  renderUsers();
  setMessage(message, `${total} users loaded.`, "success");
}

async function loadOverview() {
  const { data, error } = await supabaseClient.rpc("admin_get_dashboard_overview");
  const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  if (error) {
    setText("demoOpenPositions", "—");
    setText("realOpenPositions", "—");
    setText("demoTotalBalance", "—");
    setText("realTotalBalance", "—");
    setText("overviewConfirmedDeposits", "—");
    setText("overviewTodayDeposits", "Today: —");
    return;
  }
  setText("demoOpenPositions", String(data?.demo_open_positions ?? 0));
  setText("realOpenPositions", String(data?.real_test_open_positions ?? 0));
  setText("demoTotalBalance", formatMoney(data?.demo_total_balance, "$"));
  setText("realTotalBalance", formatMoney(data?.real_test_total_balance, "$"));
  setText("overviewConfirmedDeposits", formatKsh(data?.megapay_total_confirmed ?? 0));
  setText("overviewTodayDeposits", "Today: " + formatKsh(data?.megapay_today_confirmed ?? 0));
  const completedEl = document.getElementById("completedDepositCount");
  if (completedEl) completedEl.textContent = String(data?.megapay_completed_count ?? 0);
}

function setBalanceCardValue(id, valueText) {
  const el = document.getElementById(id);
  if (el) el.textContent = valueText;
}

async function loadUserBalances(userId) {
  setBalanceCardValue("demoBalanceValue", "Loading...");
  setBalanceCardValue("realTestBalanceValue", "Loading...");
  setMessage(balanceMessage, "Fetching balances...", "info");

  const { data, error } = await supabaseClient.rpc("admin_get_user_balances", { p_user_id: userId });
  if (error) {
    setBalanceCardValue("demoBalanceValue", "Unavailable");
    setBalanceCardValue("realTestBalanceValue", "Unavailable");
    setMessage(balanceMessage, "Balances unavailable: " + getErrorMessage(error) + " (run supabase-admin-balance-adjustments.sql in Supabase)", "error");
    return null;
  }

  setBalanceCardValue("demoBalanceValue", formatMoney(data?.demo_balance));
  setBalanceCardValue("realTestBalanceValue", formatMoney(data?.real_test_balance));
  const notes = [];
  if (!data?.demo_account_exists) notes.push("Demo account will be created on first adjustment.");
  if (!data?.real_test_account_exists) notes.push("Real test account will be created on first adjustment.");
  setMessage(balanceMessage, ["Balances loaded.", ...notes].join(" ").trim(), "success");
  return data;
}

async function adjustBalance(accountKey) {
  const user = activeProfileUser;
  if (!user?.id) return;
  const isDemo = accountKey === "demo";
  const modeEl = document.getElementById(isDemo ? "demoAdjustMode" : "realAdjustMode");
  const amountEl = document.getElementById(isDemo ? "demoAdjustAmount" : "realAdjustAmount");
  const button = document.getElementById(isDemo ? "applyDemoBalance" : "applyRealTestBalance");
  if (!modeEl || !amountEl || !button) return;

  const rpcName = isDemo ? "admin_adjust_demo_balance" : "admin_adjust_real_test_balance";
  const label = isDemo ? "Demo" : "Real test";
  const mode = modeEl.value || "add";
  const amount = Number(amountEl.value);
  if (!Number.isFinite(amount) || amount < 0) {
    setMessage(balanceMessage, `Enter a valid amount for ${label.toLowerCase()} balance.`, "error");
    return;
  }
  if (!confirm(`Confirm ${mode} ${formatMoney(amount)} for ${label} account of ${user.email || user.id}?`)) return;

  button.disabled = true;
  const prev = button.textContent;
  button.textContent = "Applying...";
  setMessage(balanceMessage, `Updating ${label.toLowerCase()} balance...`, "info");

  const { data, error } = await supabaseClient.rpc(rpcName, {
    p_user_id: user.id,
    p_mode: mode,
    p_amount: amount,
    p_note: "Adjusted from admin dashboard"
  });

  button.disabled = false;
  button.textContent = prev;

  if (error) {
    setMessage(balanceMessage, `${label} balance update failed: ${getErrorMessage(error)}`, "error");
    return;
  }

  amountEl.value = "";
  await loadUserBalances(user.id);
  await loadOverview();
  const balance = data?.balance ?? data?.new_balance;
  setMessage(balanceMessage, `${label} balance updated successfully. New balance: ${formatMoney(balance)}. Changes are effective for the website.`, "success");
}

function showUserProfile(user) {
  activeProfileUser = user;
  const modal = document.getElementById("profileModal");
  if (!modal) return;

  const name = normalizeUserField(user, ["full_name", "name", "fullName"], "Name not provided");
  const email = user.email || "Email unavailable";
  const accountType = String(user.account_type || "standard");
  const status = String(user.status || "active");

  document.getElementById("profileAvatar").textContent = (name || email || "U").charAt(0).toUpperCase();
  document.getElementById("profileName").textContent = name;
  document.getElementById("profileEmail").textContent = email;
  document.getElementById("profilePhone").textContent = normalizeUserField(user, ["phone", "phone_number"], "Not provided");
  document.getElementById("profileAccount").textContent = accountType;
  document.getElementById("profileStatus").textContent = status;
  document.getElementById("profileDate").textContent = formatDate(user.created_at);
  document.getElementById("profileId").textContent = user.id || "Unavailable";

  const accountBadge = document.getElementById("profileAccountBadge");
  const statusBadge = document.getElementById("profileStatusBadge");
  if (accountBadge) {
    accountBadge.textContent = accountType;
    accountBadge.className = `pill ${accountType.toLowerCase() === "vip" ? "vip" : "standard"}`;
  }
  if (statusBadge) {
    const normalized = status.toLowerCase();
    statusBadge.textContent = status;
    statusBadge.className = `pill ${["active", "suspended", "blocked"].includes(normalized) ? normalized : "muted-pill"}`;
  }

  modal.hidden = false;
  if (user.id) loadUserBalances(user.id);
}

function closeUserProfile() {
  const modal = document.getElementById("profileModal");
  if (modal) modal.hidden = true;
  activeProfileUser = null;
  setMessage(balanceMessage, "", "info");
}

async function loadSimulationSettings() {
  const settingsMessage = document.getElementById("settingsMessage");
  const { data, error } = await supabaseClient.rpc("admin_get_settings");
  if (error) {
    setMessage(settingsMessage, "Unable to load settings: " + getErrorMessage(error), "error");
    return;
  }
  const standardEl = document.getElementById("standardWinRate");
  const vipEl = document.getElementById("vipWinRate");
  if (standardEl) standardEl.value = data?.standard_win_rate ?? "";
  if (vipEl) vipEl.value = data?.vip_win_rate ?? "";
  setMessage(settingsMessage, "Simulation settings loaded.", "success");
}

async function saveSimulationSettings() {
  const standard = Number(document.getElementById("standardWinRate")?.value);
  const vip = Number(document.getElementById("vipWinRate")?.value);
  const settingsMessage = document.getElementById("settingsMessage");
  if (!Number.isFinite(standard) || !Number.isFinite(vip) || standard < 0 || standard > 100 || vip < 0 || vip > 100) {
    setMessage(settingsMessage, "Both rates must be between 0 and 100.", "error");
    return;
  }
  const saveButton = document.getElementById("saveSettings");
  if (saveButton) { saveButton.disabled = true; saveButton.textContent = "Saving..."; }
  const { error } = await supabaseClient.rpc("admin_save_settings", { p_standard_win_rate: standard, p_vip_win_rate: vip });
  if (saveButton) { saveButton.disabled = false; saveButton.textContent = "Save simulation settings"; }
  if (error) { setMessage(settingsMessage, "Save failed: " + getErrorMessage(error), "error"); return; }
  setMessage(settingsMessage, "Simulation settings saved successfully.", "success");
}

function renderDepositRows(records) {
  const receivedBody = document.getElementById("receivedDepositsBody");
  const pendingBody = document.getElementById("pendingDepositsBody");
  if (!receivedBody || !pendingBody) return;

  const all = Array.isArray(records) ? records : [];
  const confirmed = all.filter((d) => String(d.status || "").toLowerCase() === "completed" || d.credited_at);
  const pendingLike = all.filter((d) => !(String(d.status || "").toLowerCase() === "completed" || d.credited_at));

  const receivedTotal = confirmed.reduce((sum, d) => sum + Number(d.amount || 0), 0);
  const pendingTotal = pendingLike.reduce((sum, d) => sum + Number(d.amount || 0), 0);
  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setText("receivedSectionTotal", formatKsh(receivedTotal));
  setText("pendingSectionTotal", formatKsh(pendingTotal));

  const rowHtml = (d) => `<tr>
    <td>${escapeHtml(d.email || d.user_email || "—")}</td>
    <td>${escapeHtml(d.phone || d.msisdn || "—")}</td>
    <td>${formatKsh(d.amount)}</td>
    <td><code class="mono">${escapeHtml(d.reference || "—")}</code></td>
    <td><span class="pill ${String(d.status || "unknown").toLowerCase()}">${escapeHtml(d.status || "—")}</span></td>
    <td>${formatDate(d.credited_at || d.created_at || d.updated_at)}</td>
  </tr>`;

  receivedBody.innerHTML = confirmed.length ? confirmed.map(rowHtml).join("") : '<tr><td colspan="6">No confirmed deposits.</td></tr>';
  pendingBody.innerHTML = pendingLike.length ? pendingLike.map(rowHtml).join("") : '<tr><td colspan="6">No pending or other deposits.</td></tr>';
}

async function loadDepositRecords() {
  const receivedBody = document.getElementById("receivedDepositsBody");
  const pendingBody = document.getElementById("pendingDepositsBody");
  if (receivedBody) receivedBody.innerHTML = '<tr><td colspan="6">Loading...</td></tr>';
  if (pendingBody) pendingBody.innerHTML = '<tr><td colspan="6">Loading...</td></tr>';

  // Prefer detailed megapay list if available, fallback to admin_get_deposit_records
  let records = null;
  let summary = null;
  const listRes = await supabaseClient.rpc("admin_list_megapay_deposits", { p_status: null, p_limit: 500 });
  if (!listRes.error) {
    records = Array.isArray(listRes.data) ? listRes.data : [];
  }

  const recRes = await supabaseClient.rpc("admin_get_deposit_records");
  if (!recRes.error) {
    summary = recRes.data || {};
    if (!records) records = Array.isArray(summary.records) ? summary.records : [];
  } else if (listRes.error) {
    if (receivedBody) receivedBody.innerHTML = '<tr><td colspan="6">Could not load deposits.</td></tr>';
    if (pendingBody) pendingBody.innerHTML = '<tr><td colspan="6">Could not load deposits.</td></tr>';
    return;
  }

  renderDepositRows(records || []);

  const all = records || [];
  const confirmed = all.filter((d) => String(d.status || "").toLowerCase() === "completed" || d.credited_at);
  const pendingLike = all.filter((d) => String(d.status || "").toLowerCase() === "pending");
  const totalConfirmed = summary?.total_confirmed ?? confirmed.reduce((s, d) => s + Number(d.amount || 0), 0);
  const todayConfirmed = summary?.today_confirmed ?? 0;
  const pendingCount = summary?.pending_count ?? pendingLike.length;
  const pendingTotal = summary?.pending_total ?? pendingLike.reduce((s, d) => s + Number(d.amount || 0), 0);

  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setText("totalConfirmedDeposits", formatKsh(totalConfirmed));
  setText("todayConfirmedDeposits", formatKsh(todayConfirmed));
  setText("pendingDepositCount", String(pendingCount));
  setText("pendingDepositAmount", formatKsh(pendingTotal));
  setText("completedDepositCount", String(confirmed.length));
}

async function loadAll() {
  setMessage(globalMessage, "Refreshing all dashboard data...", "info");
  await Promise.allSettled([
    loadUsers(),
    loadOverview(),
    loadSimulationSettings(),
    loadDepositRecords()
  ]);
  setMessage(globalMessage, "Dashboard data refreshed.", "success");
}

document.getElementById("closeProfile")?.addEventListener("click", closeUserProfile);
document.getElementById("closeProfileBottom")?.addEventListener("click", closeUserProfile);
document.getElementById("profileModal")?.addEventListener("click", (e) => { if (e.target.id === "profileModal") closeUserProfile(); });
document.getElementById("refreshBalances")?.addEventListener("click", () => { if (activeProfileUser?.id) loadUserBalances(activeProfileUser.id); });
document.getElementById("applyDemoBalance")?.addEventListener("click", () => adjustBalance("demo"));
document.getElementById("applyRealTestBalance")?.addEventListener("click", () => adjustBalance("real"));

document.getElementById("saveSettings")?.addEventListener("click", saveSimulationSettings);
document.getElementById("refreshUsers")?.addEventListener("click", () => { loadUsers(); loadOverview(); });
document.getElementById("userSearch")?.addEventListener("input", renderUsers);
document.getElementById("accountFilter")?.addEventListener("change", renderUsers);
document.getElementById("statusFilter")?.addEventListener("change", renderUsers);
document.getElementById("refreshDeposits")?.addEventListener("click", async () => {
  const btn = document.getElementById("refreshDeposits");
  if (btn) { btn.disabled = true; btn.textContent = "Refreshing..."; }
  await Promise.allSettled([loadDepositRecords(), loadOverview()]);
  if (btn) { btn.disabled = false; btn.textContent = "Refresh deposits"; }
});
document.getElementById("refreshAll")?.addEventListener("click", loadAll);

document.getElementById("logoutButton")?.addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  window.location.replace("index.html");
});

(async function startDashboard() {
  const authorized = await protectDashboard();
  if (authorized) await loadAll();
})();
