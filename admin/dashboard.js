const config = window.NEXATRADE_SUPABASE_CONFIG;
const supabaseClient = window.supabase.createClient(config.url, config.publishableKey);

const message = document.getElementById("dashboardMessage");
const tbody = document.getElementById("usersTable");
const balanceMessage = document.getElementById("balanceMessage");

let allUsers = [];
let activeProfileUser = null;

function setMessage(element, text, type = "info") {
    if (!element) return;
    element.textContent = text || "";
    element.classList.remove("info", "success", "error");
    if (type) element.classList.add(type);
}

async function protectDashboard() {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) {
        window.location.replace("index.html");
        return false;
    }

    const { error: adminError } = await supabaseClient.rpc("admin_get_settings");
    if (adminError) {
        await supabaseClient.auth.signOut();
        window.location.replace("index.html");
        return false;
    }

    return true;
}

function createCell(content) {
    const cell = document.createElement("td");
    if (content instanceof Node) {
        cell.appendChild(content);
    } else {
        cell.textContent = content == null || content === "" ? "—" : String(content);
    }
    return cell;
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[character]));
}

function formatMoney(amount, currency = "$") {
    const numeric = Number(amount);
    if (!Number.isFinite(numeric)) return "—";
    return `${currency}${numeric.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDepositMoney(amount) {
    return "KSh " + Number(amount || 0).toLocaleString("en-KE", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function badgeClass(kind, value) {
    const normalized = String(value || "").toLowerCase();
    if (kind === "account") {
        return normalized === "vip" ? "account-badge vip" : "account-badge standard";
    }
    if (["active", "suspended", "blocked"].includes(normalized)) {
        return `status-badge ${normalized}`;
    }
    return "status-badge unknown";
}

function renderUsers() {
    if (!tbody) return;
    const query = document.getElementById("userSearch")?.value.trim().toLowerCase() || "";
    const accountFilter = document.getElementById("accountFilter")?.value || "all";
    const statusFilter = document.getElementById("statusFilter")?.value || "all";

    const filtered = allUsers.filter((user) => {
        const matchesSearch = [user.full_name, user.email, user.id, user.phone]
            .some((value) => String(value || "").toLowerCase().includes(query));
        const matchesAccount = accountFilter === "all" || String(user.account_type || "").toLowerCase() === accountFilter;
        const matchesStatus = statusFilter === "all" || String(user.status || "").toLowerCase() === statusFilter;
        return matchesSearch && matchesAccount && matchesStatus;
    });

    tbody.innerHTML = "";

    if (!filtered.length) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 5;
        cell.textContent = "No matching users found.";
        row.appendChild(cell);
        tbody.appendChild(row);
        return;
    }

    filtered.forEach((user) => {
        const row = document.createElement("tr");

        const userCell = document.createElement("td");
        const name = document.createElement("div");
        name.className = "user-cell-main";
        name.textContent = user.full_name || user.email || user.id || "Unnamed user";
        const sub = document.createElement("div");
        sub.className = "user-cell-sub";
        sub.textContent = user.email || user.phone || user.id || "—";
        userCell.append(name, sub);
        row.appendChild(userCell);

        const accountCell = document.createElement("td");
        const accountBadge = document.createElement("span");
        accountBadge.className = badgeClass("account", user.account_type || "standard");
        accountBadge.textContent = user.account_type || "standard";
        accountCell.appendChild(accountBadge);
        row.appendChild(accountCell);

        const statusCell = document.createElement("td");
        const statusBadge = document.createElement("span");
        statusBadge.className = badgeClass("status", user.status || "unknown");
        statusBadge.textContent = user.status || "unknown";
        statusCell.appendChild(statusBadge);
        row.appendChild(statusCell);

        row.appendChild(createCell(user.created_at ? new Date(user.created_at).toLocaleDateString() : "—"));

        const actionCell = document.createElement("td");

        const select = document.createElement("select");
        select.className = "user-action-select";
        [
            ["", "Choose action"],
            ["vip", "Upgrade to VIP"],
            ["standard", "Set Standard"],
            ["suspended", "Suspend account"],
            ["blocked", "Block account"],
            ["active", "Reactivate account"]
        ].forEach(([value, label]) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            select.appendChild(option);
        });

        const button = document.createElement("button");
        button.className = "user-action-button";
        button.type = "button";
        button.textContent = "Apply";
        button.addEventListener("click", async () => {
            const action = select.value;
            if (!action) {
                setMessage(message, "Choose an action first.", "error");
                return;
            }

            let accountType = null;
            let status = null;
            if (["vip", "standard"].includes(action)) accountType = action;
            else status = action;

            if (!confirm(`Confirm ${action} for ${user.email || user.id}?`)) return;

            button.disabled = true;
            button.textContent = "Saving...";
            const { error } = await supabaseClient.rpc("admin_update_user", {
                p_user_id: user.id,
                p_account_type: accountType,
                p_status: status
            });

            if (error) {
                setMessage(message, "Update failed: " + error.message, "error");
                button.disabled = false;
                button.textContent = "Apply";
                return;
            }

            setMessage(message, "User updated successfully.", "success");
            await loadUsers();
        });

        const profileButton = document.createElement("button");
        profileButton.className = "profile-button secondary-button";
        profileButton.type = "button";
        profileButton.textContent = "Profile & balances";
        profileButton.addEventListener("click", () => showUserProfile(user));

        actionCell.append(select, button, profileButton);
        row.appendChild(actionCell);
        tbody.appendChild(row);
    });
}

async function loadUsers() {
    setMessage(message, "Loading registered users...", "info");
    const { data, error } = await supabaseClient.rpc("admin_list_users");
    if (error) {
        setMessage(message, "Unable to load users: " + error.message, "error");
        return;
    }

    allUsers = Array.isArray(data) ? data : [];
    const total = allUsers.length;
    const standard = allUsers.filter((u) => String(u.account_type || "").toLowerCase() === "standard").length;
    const vip = allUsers.filter((u) => String(u.account_type || "").toLowerCase() === "vip").length;
    const restricted = allUsers.filter((u) => ["suspended", "blocked"].includes(String(u.status || "").toLowerCase())).length;

    const totalEl = document.getElementById("totalUsers");
    const standardEl = document.getElementById("standardUsers");
    const vipEl = document.getElementById("vipUsers");
    const restrictedEl = document.getElementById("restrictedUsers");
    if (totalEl) totalEl.textContent = String(total);
    if (standardEl) standardEl.textContent = String(standard);
    if (vipEl) vipEl.textContent = String(vip);
    if (restrictedEl) restrictedEl.textContent = String(restricted);

    renderUsers();
    setMessage(message, `${total} registered users loaded.`, "success");
}

function setBalanceCardValue(id, valueText) {
    const el = document.getElementById(id);
    if (el) el.textContent = valueText;
}

async function loadUserBalances(userId) {
    setBalanceCardValue("demoBalanceValue", "Loading...");
    setBalanceCardValue("realTestBalanceValue", "Loading...");
    setMessage(balanceMessage, "Fetching demo and real test balances...", "info");

    const { data, error } = await supabaseClient.rpc("admin_get_user_balances", { p_user_id: userId });
    if (error) {
        setBalanceCardValue("demoBalanceValue", "Unavailable");
        setBalanceCardValue("realTestBalanceValue", "Unavailable");
        setMessage(
            balanceMessage,
            "Balances unavailable: " + error.message + " (Run supabase-admin-balance-adjustments.sql in Supabase if this RPC is missing.)",
            "error"
        );
        return null;
    }

    setBalanceCardValue("demoBalanceValue", formatMoney(data?.demo_balance));
    setBalanceCardValue("realTestBalanceValue", formatMoney(data?.real_test_balance));
    const demoState = data?.demo_account_exists ? "" : " Demo account will be created on first adjustment.";
    const realState = data?.real_test_account_exists ? "" : " Real test account will be created on first adjustment.";
    setMessage(balanceMessage, `Balances loaded.${demoState}${realState}`.trim(), "success");
    return data;
}

async function adjustBalance(accountKey, user) {
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

    if (!confirm(`Confirm ${mode} ${formatMoney(amount)} for ${label} account of ${user.email || user.id}?`)) {
        return;
    }

    button.disabled = true;
    const previousText = button.textContent;
    button.textContent = "Applying...";
    setMessage(balanceMessage, `Updating ${label.toLowerCase()} balance...`, "info");

    const { data, error } = await supabaseClient.rpc(rpcName, {
        p_user_id: user.id,
        p_mode: mode,
        p_amount: amount,
        p_note: "Adjusted from admin dashboard"
    });

    button.disabled = false;
    button.textContent = previousText;

    if (error) {
        setMessage(balanceMessage, `${label} balance update failed: ${error.message}`, "error");
        return;
    }

    amountEl.value = "";
    await loadUserBalances(user.id);
    const balance = data?.balance ?? data?.new_balance ?? data?.demo_balance ?? data?.real_test_balance;
    setMessage(balanceMessage, `${label} balance updated successfully. New balance: ${formatMoney(balance)}.`, "success");
}

function showUserProfile(user) {
    activeProfileUser = user;
    const modal = document.getElementById("profileModal");
    if (!modal) return;

    const name = user.full_name || "Name not provided";
    const email = user.email || "Email unavailable";
    const accountType = user.account_type || "standard";
    const status = user.status || "active";

    document.getElementById("profileAvatar").textContent = (user.full_name || user.email || "U").charAt(0).toUpperCase();
    document.getElementById("profileName").textContent = name;
    document.getElementById("profileEmail").textContent = email;
    document.getElementById("profilePhone").textContent = user.phone || "Not provided";
    document.getElementById("profileAccount").textContent = accountType;
    document.getElementById("profileStatus").textContent = status;
    document.getElementById("profileDate").textContent = user.created_at ? new Date(user.created_at).toLocaleString() : "Unavailable";
    document.getElementById("profileId").textContent = user.id || "Unavailable";

    const accountBadge = document.getElementById("profileAccountBadge");
    const statusBadge = document.getElementById("profileStatusBadge");
    if (accountBadge) {
        accountBadge.textContent = accountType;
        accountBadge.className = `pill ${String(accountType).toLowerCase() === "vip" ? "vip" : "standard"}`;
    }
    if (statusBadge) {
        const normalized = String(status).toLowerCase();
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

document.getElementById("closeProfile")?.addEventListener("click", closeUserProfile);
document.getElementById("closeProfileBottom")?.addEventListener("click", closeUserProfile);
document.getElementById("profileModal")?.addEventListener("click", (event) => {
    if (event.target.id === "profileModal") closeUserProfile();
});

document.getElementById("refreshBalances")?.addEventListener("click", () => {
    if (activeProfileUser?.id) loadUserBalances(activeProfileUser.id);
});
document.getElementById("applyDemoBalance")?.addEventListener("click", () => adjustBalance("demo", activeProfileUser));
document.getElementById("applyRealTestBalance")?.addEventListener("click", () => adjustBalance("real", activeProfileUser));

async function loadSimulationSettings() {
    const settingsMessage = document.getElementById("settingsMessage");
    const { data, error } = await supabaseClient.rpc("admin_get_settings");
    if (error) {
        setMessage(settingsMessage, "Unable to load settings: " + error.message, "error");
        return;
    }
    const standardEl = document.getElementById("standardWinRate");
    const vipEl = document.getElementById("vipWinRate");
    if (standardEl) standardEl.value = data?.standard_win_rate ?? "";
    if (vipEl) vipEl.value = data?.vip_win_rate ?? "";
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
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.textContent = "Saving...";
    }
    const { error } = await supabaseClient.rpc("admin_save_settings", {
        p_standard_win_rate: standard,
        p_vip_win_rate: vip
    });
    if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = "Save simulation settings";
    }

    if (error) {
        setMessage(settingsMessage, "Save failed: " + error.message, "error");
        return;
    }
    setMessage(settingsMessage, "Simulation settings saved successfully.", "success");
}

document.getElementById("saveSettings")?.addEventListener("click", saveSimulationSettings);

function escapeDepositText(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[character]));
}

async function loadDepositRecords() {
    const receivedBody = document.getElementById("receivedDepositsBody");
    const pendingBody = document.getElementById("pendingDepositsBody");
    if (!receivedBody || !pendingBody) return;

    receivedBody.innerHTML = '<tr><td colspan="5">Loading...</td></tr>';
    pendingBody.innerHTML = '<tr><td colspan="5">Loading...</td></tr>';

    const { data, error } = await supabaseClient.rpc("admin_get_deposit_records");
    if (error) {
        receivedBody.innerHTML = '<tr><td colspan="5">Could not load records.</td></tr>';
        pendingBody.innerHTML = '<tr><td colspan="5">Could not load records.</td></tr>';
        return;
    }

    const records = Array.isArray(data?.records) ? data.records : [];
    const received = records.filter((deposit) => deposit.credited_at);
    const pending = records.filter((deposit) => deposit.status === "pending");

    const receivedTotal = received.reduce((sum, deposit) => sum + Number(deposit.amount || 0), 0);
    const pendingTotal = pending.reduce((sum, deposit) => sum + Number(deposit.amount || 0), 0);

    const receivedTotalEl = document.getElementById("receivedSectionTotal");
    const pendingTotalEl = document.getElementById("pendingSectionTotal");
    if (receivedTotalEl) receivedTotalEl.textContent = formatDepositMoney(receivedTotal);
    if (pendingTotalEl) pendingTotalEl.textContent = formatDepositMoney(pendingTotal);

    receivedBody.innerHTML = received.length
        ? received.map((deposit) => `
            <tr>
                <td>${escapeDepositText(deposit.email || "—")}</td>
                <td>${escapeDepositText(deposit.phone || "—")}</td>
                <td>${formatDepositMoney(deposit.amount)}</td>
                <td>${escapeDepositText(deposit.reference || "—")}</td>
                <td>${deposit.credited_at ? new Date(deposit.credited_at).toLocaleString("en-KE") : "—"}</td>
            </tr>
        `).join("")
        : '<tr><td colspan="5">No confirmed deposits received yet.</td></tr>';

    pendingBody.innerHTML = pending.length
        ? pending.map((deposit) => `
            <tr>
                <td>${escapeDepositText(deposit.email || "—")}</td>
                <td>${escapeDepositText(deposit.phone || "—")}</td>
                <td>${formatDepositMoney(deposit.amount)}</td>
                <td>${escapeDepositText(deposit.reference || "—")}</td>
                <td>${deposit.created_at ? new Date(deposit.created_at).toLocaleString("en-KE") : "—"}</td>
            </tr>
        `).join("")
        : '<tr><td colspan="5">No pending deposits.</td></tr>';

    const totalConfirmed = document.getElementById("totalConfirmedDeposits");
    const todayConfirmed = document.getElementById("todayConfirmedDeposits");
    const pendingCount = document.getElementById("pendingDepositCount");
    const pendingAmount = document.getElementById("pendingDepositAmount");
    if (totalConfirmed) totalConfirmed.textContent = formatDepositMoney(data?.total_confirmed);
    if (todayConfirmed) todayConfirmed.textContent = formatDepositMoney(data?.today_confirmed);
    if (pendingCount) pendingCount.textContent = Number(data?.pending_count || 0).toLocaleString("en-KE");
    if (pendingAmount) pendingAmount.textContent = formatDepositMoney(data?.pending_total);
}

document.getElementById("refreshUsers")?.addEventListener("click", loadUsers);
document.getElementById("userSearch")?.addEventListener("input", renderUsers);
document.getElementById("accountFilter")?.addEventListener("change", renderUsers);
document.getElementById("statusFilter")?.addEventListener("change", renderUsers);
document.getElementById("refreshDeposits")?.addEventListener("click", loadDepositRecords);

document.getElementById("logoutButton")?.addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
    window.location.replace("index.html");
});

(async function startDashboard() {
    const authorized = await protectDashboard();
    if (authorized) {
        await loadUsers();
        await loadSimulationSettings();
        await loadDepositRecords();
    }
})();
