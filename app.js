"use strict";

const markets = [
  { id: "XAU", name: "Gold", symbol: "XAU / USD", price: 4055.3, change: 0.37, icon: "Au", iconClass: "xau", color: "#e7c96f", volatility: 0.0007 },
  { id: "EUR", name: "Euro / US Dollar", symbol: "EUR / USD", price: 1.1642, change: 0.12, icon: "€", iconClass: "eur", color: "#79b2ff", volatility: 0.0004 },
  { id: "GBP", name: "Pound / US Dollar", symbol: "GBP / USD", price: 1.337, change: 0.18, icon: "£", iconClass: "gbp", color: "#ba9bff", volatility: 0.00045 },
];

const state = {
  activeMarket: "XAU",
  timeframe: "1min",
  balance: 10000,
  userId: null,
  accountMode: "demo",
  positions: [],
  history: [],
  withdrawalHistory: [],
  watchlist: ["XAU", "EUR", "GBP"],
  showingHistory: false,
  chartStyle: "candle",
  candles: [],
  pendingTrade: null,
  isSubmittingTrade: false,
  fundsAction: "deposit",
  executionInterval: null,
  executionTimeout: null,
  initialized: false,
  marketUpdateInterval: null,
  sentimentInterval: null,
};

markets.forEach((market) => {
  market.dayOpen = market.price / (1 + market.change / 100);
  market.dayHigh = market.price * 1.0097;
  market.dayLow = market.price * 0.9904;
});

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const marketById = (id) => markets.find((market) => market.id === id);
const activeMarket = () => marketById(state.activeMarket);
const amountInput = $("#trade-amount");
const chartCanvas = $("#candlestick-chart");
const chartContext = chartCanvas.getContext("2d");
const compactCurrency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const supabaseConfig = window.NEXATRADE_SUPABASE_CONFIG || {};
let supabaseClient = null;
let supabaseSetupError = "";

if (!window.supabase) {
  supabaseSetupError = "Supabase’s browser library did not load. Check your internet connection and reload.";
} else if (!supabaseConfig.url || !supabaseConfig.publishableKey) {
  supabaseSetupError = "Supabase isn’t configured. Add your project URL and public publishable key to supabase-config.js.";
} else {
  try {
    supabaseClient = window.supabase.createClient(supabaseConfig.url, supabaseConfig.publishableKey);
  } catch (error) {
    supabaseSetupError = `Supabase configuration is invalid: ${error instanceof Error ? error.message : "check the project URL and public key."}`;
  }
}

function formatExactPrice(market, value) {
  if (market.id === "EUR" || market.id === "GBP") {
    return value.toFixed(4);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: market.price < 10 ? 4 : 2,
    maximumFractionDigits: market.price < 10 ? 4 : 2,
  }).format(value);
}

function formatChange(value) {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;
}

function money(value) {
  return compactCurrency.format(value);
}

function getErrorMessage(error, fallback) {
  if (error instanceof Error) return error.message;
  if (error && typeof error.message === "string" && error.message) return error.message;
  return fallback;
}

function generateCandles(market) {
  const candles = [];
  const interval = Number.parseInt(state.timeframe, 10) * 60 * 1000;
  const scale = { "1min": 0.0007, "5min": 0.0016, "15min": 0.003 }[state.timeframe];
  const step = market.price * scale * 0.3;
  let close = market.price + (Math.random() - 0.5) * step * 8;
  const lastIntervalStart = Math.floor(Date.now() / interval) * interval;
  for (let index = 0; index < 64; index += 1) {
    const open = close;
    close = Math.max(0, open + (Math.random() - 0.5) * step);
    if (index === 63) close = market.price;
    const wick = market.price * scale * (0.1 + Math.random() * 0.25);
    candles.push({
      open,
      close,
      high: Math.max(open, close) + wick * Math.random(),
      low: Math.min(open, close) - wick * Math.random(),
      startedAt: lastIntervalStart - (63 - index) * interval,
    });
  }
  candles[candles.length - 1].high = Math.max(candles[candles.length - 1].high, market.price);
  candles[candles.length - 1].low = Math.min(candles[candles.length - 1].low, market.price);
  state.candles = candles;
}

function renderWatchlist() {
  const container = $("#watchlist");
  container.replaceChildren();
  state.watchlist.forEach((id) => {
    const market = marketById(id);
    if (!market) return;
    const button = document.createElement("button");
    button.className = `watch-item${id === state.activeMarket ? " selected" : ""}`;
    button.dataset.market = id;
    button.setAttribute("aria-label", `Show ${market.name} chart`);
    button.innerHTML = `
      <span class="watch-coin coin-${market.iconClass}">${market.icon}</span>
      <span class="watch-copy"><strong>${market.id} / USD</strong><span>${market.name}</span></span>
      <span class="watch-price"><strong>${formatExactPrice(market, market.price)}</strong><span class="${market.change >= 0 ? "positive" : "negative"}">${formatChange(market.change)}</span></span>`;
    button.addEventListener("click", () => selectMarket(id));
    container.append(button);
  });
  const isWatched = state.watchlist.includes(state.activeMarket);
  $("#add-watch").title = isWatched ? "Remove current market from watchlist" : "Add current market to watchlist";
  $("#add-watch").setAttribute("aria-label", $("#add-watch").title);
  $("#add-watch").textContent = isWatched ? "−" : "+";
}

function renderMarketStrip() {
  [["XAU", "xau"], ["EUR", "eur"], ["GBP", "gbp"]].forEach(([id, short]) => {
    const market = marketById(id);
    $(`#${short}-price`).textContent = formatExactPrice(market, market.price);
    const change = $(`#${short}-change`);
    change.textContent = formatChange(market.change);
    change.className = `change ${market.change >= 0 ? "positive" : "negative"}`;
    drawSparkline($(`#spark-${short}`), market);
  });
  $("#last-updated").textContent = "just now";
}

function drawSparkline(canvas, market) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  const width = rect.width;
  const height = rect.height;
  const values = Array.from({ length: 20 }, (_, index) => {
    const trend = (index / 19 - 0.5) * market.change * 0.002;
    return market.price * (1 + trend + Math.sin(index * 1.6 + market.price) * market.volatility * 2);
  });
  const min = Math.min(...values);
  const max = Math.max(...values);
  context.beginPath();
  values.forEach((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - 2 - ((value - min) / (max - min || 1)) * (height - 5);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.strokeStyle = market.change >= 0 ? "#36cb9b" : "#ec727a";
  context.lineWidth = 1.5;
  context.stroke();
}

function renderChartLabels() {
  const market = activeMarket();
  const values = state.candles.flatMap((candle) => [candle.high, candle.low]);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const step = (max - min) / 4;
  $("#chart-y-labels").replaceChildren(...Array.from({ length: 5 }, (_, index) => {
    const label = document.createElement("span");
    label.textContent = formatExactPrice(market, max - step * index);
    return label;
  }));
  const interval = Number.parseInt(state.timeframe, 10) * 60 * 1000;
  const lastTime = state.candles[state.candles.length - 1].startedAt;
  $$("[data-chart-time]").forEach((label, index, labels) => {
    const time = new Date(lastTime - interval * (labels.length - index - 1));
    label.textContent = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  });
}

function drawChart() {
  const bounds = chartCanvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const ratio = window.devicePixelRatio || 1;
  chartCanvas.width = Math.round(bounds.width * ratio);
  chartCanvas.height = Math.round(bounds.height * ratio);
  chartContext.setTransform(ratio, 0, 0, ratio, 0, 0);

  const width = bounds.width;
  const height = bounds.height;
  const values = state.candles.flatMap((candle) => [candle.high, candle.low]);
  let min = Math.min(...values);
  let max = Math.max(...values);
  const padding = (max - min) * 0.08 || activeMarket().price * 0.003;
  min -= padding;
  max += padding;
  const yFor = (value) => height - ((value - min) / (max - min)) * height;
  const xStep = width / state.candles.length;

  chartContext.clearRect(0, 0, width, height);
  chartContext.strokeStyle = "rgba(133, 149, 163, .11)";
  chartContext.lineWidth = 1;
  for (let index = 0; index < 5; index += 1) {
    const y = Math.round((height / 4) * index) + 0.5;
    chartContext.beginPath();
    chartContext.moveTo(0, y);
    chartContext.lineTo(width, y);
    chartContext.stroke();
  }
  for (let index = 1; index < 6; index += 1) {
    const x = Math.round((width / 6) * index) + 0.5;
    chartContext.beginPath();
    chartContext.moveTo(x, 0);
    chartContext.lineTo(x, height);
    chartContext.stroke();
  }

  if (state.chartStyle === "line") {
    chartContext.beginPath();
    state.candles.forEach((candle, index) => {
      const x = index * xStep + xStep / 2;
      const y = yFor(candle.close);
      if (index === 0) chartContext.moveTo(x, y);
      else chartContext.lineTo(x, y);
    });
    chartContext.lineTo(width, height);
    chartContext.lineTo(0, height);
    chartContext.closePath();
    const fill = chartContext.createLinearGradient(0, 0, 0, height);
    fill.addColorStop(0, "rgba(46, 211, 160, .18)");
    fill.addColorStop(1, "rgba(46, 211, 160, 0)");
    chartContext.fillStyle = fill;
    chartContext.fill();
    chartContext.beginPath();
    state.candles.forEach((candle, index) => {
      const x = index * xStep + xStep / 2;
      const y = yFor(candle.close);
      if (index === 0) chartContext.moveTo(x, y);
      else chartContext.lineTo(x, y);
    });
    chartContext.strokeStyle = "#39d2a2";
    chartContext.lineWidth = 1.6;
    chartContext.stroke();
  } else {
    state.candles.forEach((candle, index) => {
      const center = index * xStep + xStep / 2;
      const rising = candle.close >= candle.open;
      const color = rising ? "#36c99a" : "#e9747c";
      chartContext.strokeStyle = color;
      chartContext.fillStyle = color;
      chartContext.lineWidth = 1;
      chartContext.beginPath();
      chartContext.moveTo(center, yFor(candle.high));
      chartContext.lineTo(center, yFor(candle.low));
      chartContext.stroke();
      const top = yFor(Math.max(candle.open, candle.close));
      const bottom = yFor(Math.min(candle.open, candle.close));
      const candleWidth = Math.max(2, Math.min(7, xStep * 0.56));
      chartContext.fillRect(center - candleWidth / 2, top, candleWidth, Math.max(1, bottom - top));
    });
  }

  const currentY = yFor(activeMarket().price);
  chartContext.setLineDash([4, 4]);
  chartContext.strokeStyle = "rgba(56, 211, 161, .55)";
  chartContext.beginPath();
  chartContext.moveTo(0, currentY);
  chartContext.lineTo(width, currentY);
  chartContext.stroke();
  chartContext.setLineDash([]);
}

function renderChart() {
  const market = activeMarket();
  $("#chart-market-name").textContent = market.name;
  $("#market-select").value = market.id;
  $("#selected-coin-icon").textContent = market.icon;
  $("#selected-coin-icon").style.color = market.color;
  $("#selected-coin-icon").style.background = `${market.color}24`;
  $("#chart-price").textContent = formatExactPrice(market, market.price);
  const changeAmount = market.price * market.change / 100;
  const change = $("#chart-change");
  change.textContent = `${changeAmount >= 0 ? "+" : "−"}${formatExactPrice(market, Math.abs(changeAmount))} (${formatChange(market.change)})`;
  change.className = `chart-price-change ${market.change >= 0 ? "positive" : "negative"}`;
  $("#chart-high").textContent = formatExactPrice(market, Math.max(market.dayHigh, market.price));
  $("#chart-low").textContent = formatExactPrice(market, Math.min(market.dayLow, market.price));
  $("#order-coin").textContent = market.icon;
  $("#order-coin").style.color = market.color;
  $("#order-coin").style.background = `${market.color}24`;
  $("#order-market-name").textContent = market.symbol;
  $("#order-market-price").textContent = formatExactPrice(market, market.price);
  $(".sentiment-heading > span").textContent = market.symbol;
  if ($("#buy-trade").dataset.market !== market.id) {
    $("#buy-trade").innerHTML = `Buy ${market.id} <span>↗</span>`;
    $("#sell-trade").innerHTML = `Sell ${market.id} <span>↘</span>`;
    $("#buy-trade").dataset.market = market.id;
    $("#sell-trade").dataset.market = market.id;
  }
  $("#favorite-button").classList.toggle("active", state.watchlist.includes(market.id));
  $("#favorite-button").textContent = state.watchlist.includes(market.id) ? "★" : "☆";
  renderChartLabels();
  drawChart();
  updateOrderEstimate();
}

function updateOrderEstimate() {
  const market = activeMarket();
  const amount = Math.max(0, Number(amountInput.value) || 0);
  const quantity = amount / market.price;
  const precision = market.price < 10 ? 4 : 6;
  $("#estimated-position").textContent = `${quantity.toFixed(precision)} ${market.id}`;
  $("#estimated-fee").textContent = money(amount * 0.001);
  $("#available-balance").textContent = state.accountMode === "demo" ? money(state.balance) : "Unavailable";
}

function renderBalance() {
  const isDemo = state.accountMode === "demo";
  const value = isDemo ? money(state.balance) : "Not connected";
  $("#balance-value").textContent = value;
  $("#available-balance").textContent = isDemo ? money(state.balance) : "Unavailable";
}

function renderAccountMode() {
  const isDemo = state.accountMode === "demo";
  $(".account-overview").classList.toggle("is-real", !isDemo);
  $$(".account-tab").forEach((button) => button.classList.toggle("active", button.dataset.accountMode === state.accountMode));
  $("#balance-label").innerHTML = isDemo
    ? 'DEMO ACCOUNT BALANCE <span class="info-tip" title="Simulated funds only">i</span>'
    : "REAL ACCOUNT STATUS";
  $("#account-status").textContent = isDemo
    ? "Simulated funds · $10,000 starting balance"
    : "Provider setup pending · No real funds accepted";
  $("#account-status").classList.toggle("is-locked", !isDemo);
  $("#order-mode-description").textContent = isDemo
    ? "4-second demo trade · 1:1 payout"
    : "Real-money trading unavailable until provider setup";
  $("#order-mode-tag").textContent = isDemo ? "DEMO" : "LOCKED";
  $("#available-balance-label").textContent = isDemo ? "Available demo balance" : "Real balance";
  $("#order-disclaimer").textContent = isDemo
    ? "Demo only. Orders do not reach an exchange."
    : "Real trading is locked. No live orders or funds are connected.";
  $("#trade-amount").disabled = !isDemo;
  $$(".amount-presets button").forEach((button) => { button.disabled = !isDemo; });
  $$(".trade-action").forEach((button) => { button.disabled = !isDemo || state.isSubmittingTrade || Boolean(state.pendingTrade); });
  $("#balance-deposit").textContent = "Deposit";
  $("#balance-withdraw").textContent = "Withdraw";
  renderBalance();
  updateOrderEstimate();
}

async function loadDemoBalance(userId) {
  let { data, error } = await supabaseClient
    .from("demo_accounts")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;

  if (!data) {
    const { error: insertError } = await supabaseClient
      .from("demo_accounts")
      .insert({ user_id: userId, balance: 10000 });
    if (insertError && insertError.code !== "23505") throw insertError;

    const result = await supabaseClient
      .from("demo_accounts")
      .select("balance")
      .eq("user_id", userId)
      .maybeSingle();
    data = result.data;
    error = result.error;
  }

  if (error) throw error;
  const balance = Number(data && data.balance);
  if (!Number.isFinite(balance) || balance < 0) {
    throw new Error("The demo account balance is missing or invalid.");
  }
  return balance;
}

async function persistDemoBalance(previousBalance) {
  try {
    const { data, error } = await supabaseClient
      .from("demo_accounts")
      .update({ balance: state.balance })
      .eq("user_id", state.userId)
      .select("balance")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("No demo account balance was updated.");
    const savedBalance = Number(data.balance);
    if (!Number.isFinite(savedBalance) || savedBalance < 0) {
      throw new Error("Supabase returned an invalid demo balance.");
    }
    state.balance = savedBalance;
    renderBalance();
    return true;
  } catch (error) {
    state.balance = previousBalance;
    renderBalance();
    const message = getErrorMessage(error, "Supabase request failed.");
    toast(`Could not save your demo balance: ${message}`, true);
    return false;
  }
}

function renderPositions() {
  const positions = state.showingHistory ? state.history : state.positions;
  $("#positions-title").textContent = state.showingHistory ? "Completed trades" : "Open positions";
  $("#mark-price-heading").textContent = state.showingHistory ? "EXIT PRICE" : "MARK PRICE";
  $("#pnl-heading").textContent = state.showingHistory ? "REALIZED P&L" : "UNREALIZED P&L";
  $("#position-count").textContent = String(positions.length);
  $("#view-all-positions").innerHTML = state.showingHistory ? "View open positions <span>↗</span>" : "View completed trades <span>↗</span>";
  const body = $("#positions-body");
  body.replaceChildren();
  if (!positions.length) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    row.innerHTML = `<td colspan="7"><span class="empty-icon">⌁</span><strong>${state.showingHistory ? "No closed trades yet" : "No open positions yet"}</strong><span>${state.showingHistory ? "Closed demo trades will appear here." : "Place a demo trade to see it here."}</span></td>`;
    body.append(row);
    return;
  }

  positions.slice().reverse().forEach((position) => {
    const market = marketById(position.marketId);
    const currentPrice = market.price;
    const rawPnl = (currentPrice - position.entryPrice) / position.entryPrice * position.amount * (position.side === "buy" ? 1 : -1);
    const pnl = state.showingHistory ? position.pnl : rawPnl - position.fee;
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="position-market"><span class="watch-coin coin-${market.iconClass}">${market.icon}</span><span class="position-market-copy"><strong>${market.id} / USD</strong><span>${market.name}</span></span></span></td>
      <td><span class="side-pill ${position.side}">${position.side === "buy" ? "BUY / LONG" : "SELL / SHORT"}</span></td>
      <td>${money(position.amount)}</td>
      <td>${formatExactPrice(market, position.entryPrice)}</td>
      <td>${state.showingHistory ? formatExactPrice(market, position.exitPrice) : formatExactPrice(market, currentPrice)}</td>
      <td class="${pnl >= 0 ? "positive" : "negative"}">${pnl >= 0 ? "+" : "−"}${money(Math.abs(pnl))}</td>
      <td>${state.showingHistory ? `<span class="result-tag ${position.outcome || "closed"}">${position.outcome ? position.outcome.toUpperCase() : "CLOSED"}</span>` : `<button class="close-position" data-position="${position.id}">Close</button>`}</td>`;
    if (!state.showingHistory) {
      row.querySelector(".close-position").addEventListener("click", () => closePosition(position.id));
    }
    body.append(row);
  });
}

function renderWithdrawalHistory() {
  const body = $("#withdrawal-history-body");
  const records = state.withdrawalHistory;
  $("#withdrawal-count").textContent = String(records.length);
  body.replaceChildren();
  if (!records.length) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    row.innerHTML = '<td colspan="5"><span class="empty-icon">↙</span><strong>No withdrawals yet</strong><span>Completed demo withdrawals will appear here.</span></td>';
    body.append(row);
    return;
  }

  records.slice().reverse().forEach((record) => {
    const row = document.createElement("tr");
    const date = document.createElement("td");
    date.textContent = new Date(record.createdAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
    const account = document.createElement("td");
    account.textContent = "Demo";
    const amount = document.createElement("td");
    amount.textContent = `−${money(record.amount)}`;
    const balance = document.createElement("td");
    balance.textContent = money(record.balanceAfter);
    const status = document.createElement("td");
    status.innerHTML = '<span class="result-tag closed">COMPLETED</span>';
    row.append(date, account, amount, balance, status);
    body.append(row);
  });
}

function setSentiment() {
  const buyers = Math.floor(52 + Math.random() * 20);
  $("#sentiment-buy").textContent = `${buyers}%`;
  $("#sentiment-sell").textContent = `${100 - buyers}%`;
  $("#sentiment-buy-bar").style.width = `${buyers}%`;
}

function selectMarket(id) {
  if (!marketById(id)) return;
  state.activeMarket = id;
  generateCandles(activeMarket());
  renderWatchlist();
  renderChart();
  renderPositions();
}

function toast(message, isError = false) {
  const item = document.createElement("div");
  item.className = `toast${isError ? " error" : ""}`;
  item.textContent = message;
  $("#toast-region").append(item);
  window.setTimeout(() => item.remove(), 3500);
}

async function placeTrade(side) {
  if (state.accountMode !== "demo") {
    toast("Real trading is unavailable until a licensed trading provider is connected.", true);
    return;
  }
  if (state.pendingTrade || state.isSubmittingTrade) return;
  const amount = Number(amountInput.value);
  if (!Number.isFinite(amount) || amount < 10) {
    toast("Enter a trade amount of at least $10.", true);
    amountInput.focus();
    return;
  }
  const fee = amount * 0.001;
  if (amount + fee > state.balance) {
    toast("Not enough demo funds for this trade and its simulated fee.", true);
    return;
  }
  const previousBalance = state.balance;
  state.isSubmittingTrade = true;
  renderAccountMode();
  state.balance -= amount + fee;
  renderBalance();
  if (!await persistDemoBalance(previousBalance)) {
    state.isSubmittingTrade = false;
    renderAccountMode();
    return;
  }
  state.isSubmittingTrade = false;
  const market = activeMarket();
  const trade = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    marketId: market.id,
    side,
    amount,
    entryPrice: market.price,
    fee,
    openedAt: new Date(),
    startedAt: Date.now(),
  };
  state.pendingTrade = trade;
  state.showingHistory = false;
  $("#trade-result").hidden = false;
  $("#trade-result").className = "trade-result is-pending";
  $("#result-status").textContent = `EXECUTING ${side.toUpperCase()}`;
  $("#result-timer").textContent = "4s";
  $("#result-message").textContent = `${market.symbol} demo order. Checking the market direction for four seconds.`;
  $("#result-entry").textContent = formatExactPrice(market, trade.entryPrice);
  $("#result-exit").textContent = "Pending";
  $("#result-pnl").textContent = "Pending";
  $("#execution-progress").style.width = "0%";
  renderAccountMode();
  renderPositions();
  updateExecutionProgress();
  state.executionInterval = window.setInterval(updateExecutionProgress, 100);
  state.executionTimeout = window.setTimeout(() => settleTrade(trade), 4000);
}

function updateExecutionProgress() {
  const trade = state.pendingTrade;
  if (!trade) return;
  const elapsed = Date.now() - trade.startedAt;
  const remaining = Math.max(0, 4000 - elapsed);
  $("#result-timer").textContent = `${Math.ceil(remaining / 1000)}s`;
  $("#execution-progress").style.width = `${Math.min(100, (elapsed / 4000) * 100)}%`;
}

async function settleTrade(trade) {
  if (state.pendingTrade !== trade) return;
  window.clearInterval(state.executionInterval);
  state.executionInterval = null;
  state.executionTimeout = null;

  const market = marketById(trade.marketId);
  const exitPrice = market.price;
  const movement = exitPrice - trade.entryPrice;
  const epsilon = market.price * 1e-10;
  const direction = movement > epsilon ? "up" : movement < -epsilon ? "down" : "unchanged";
  const outcome = direction === "unchanged" ? "push" : (
    (trade.side === "buy" && direction === "up") || (trade.side === "sell" && direction === "down")
      ? "win"
      : "loss"
  );
  const pnl = outcome === "win" ? trade.amount - trade.fee : outcome === "push" ? -trade.fee : -trade.amount - trade.fee;

  const previousBalance = state.balance;
  state.balance += outcome === "win" ? trade.amount * 2 : outcome === "push" ? trade.amount : 0;
  await persistDemoBalance(previousBalance);
  state.history.push({
    ...trade,
    exitPrice,
    pnl,
    outcome,
    closedAt: new Date(),
  });
  state.pendingTrade = null;
  state.showingHistory = true;
  renderAccountMode();
  $("#trade-result").className = `trade-result is-complete is-${outcome}`;
  $("#result-status").textContent = outcome === "push" ? "NO MOVEMENT" : outcome.toUpperCase();
  $("#result-timer").textContent = "4s complete";
  $("#result-message").textContent = `${trade.side.toUpperCase()} ${market.symbol} moved ${direction}. Demo P&L: ${pnl >= 0 ? "+" : "−"}${money(Math.abs(pnl))}.`;
  $("#result-entry").textContent = formatExactPrice(market, trade.entryPrice);
  $("#result-exit").textContent = formatExactPrice(market, exitPrice);
  $("#result-pnl").textContent = `${pnl >= 0 ? "+" : "−"}${money(Math.abs(pnl))}`;
  renderPositions();
  toast(`${outcome === "win" ? "Demo trade won" : outcome === "loss" ? "Demo trade lost" : "No price movement"} · ${pnl >= 0 ? "+" : "−"}${money(Math.abs(pnl))}.`);
}

async function closePosition(id) {
  if (state.accountMode !== "demo") return;
  const index = state.positions.findIndex((position) => position.id === id);
  if (index < 0) return;
  const position = state.positions.splice(index, 1)[0];
  const market = marketById(position.marketId);
  const grossPnl = (market.price - position.entryPrice) / position.entryPrice * position.amount * (position.side === "buy" ? 1 : -1);
  const closeFee = position.amount * (market.price / position.entryPrice) * 0.001;
  const netPnl = grossPnl - position.fee - closeFee;
  const previousBalance = state.balance;
  state.balance += Math.max(0, position.amount + grossPnl - closeFee);
  if (!await persistDemoBalance(previousBalance)) {
    state.positions.splice(index, 0, position);
    renderPositions();
    return;
  }
  state.history.push({ ...position, pnl: netPnl, exitPrice: market.price, closedAt: new Date() });
  renderPositions();
  toast(`Position closed. Demo P&L: ${netPnl >= 0 ? "+" : "−"}${money(Math.abs(netPnl))}.`);
}

function updateMarkets() {
  markets.forEach((market) => {
    const movement = (Math.random() - 0.495) * market.volatility;
    market.price = Math.max(market.price * 0.5, market.price * (1 + movement));
    market.change = (market.price / market.dayOpen - 1) * 100;
    market.dayHigh = Math.max(market.dayHigh, market.price);
    market.dayLow = Math.min(market.dayLow, market.price);
    if (market.id === state.activeMarket && state.candles.length) {
      const candle = state.candles[state.candles.length - 1];
      const interval = Number.parseInt(state.timeframe, 10) * 60 * 1000;
      if (Date.now() - candle.startedAt >= interval) {
        const nextOpen = candle.close;
        const startedAt = Math.floor(Date.now() / interval) * interval;
        state.candles.push({ open: nextOpen, close: market.price, high: Math.max(nextOpen, market.price), low: Math.min(nextOpen, market.price), startedAt });
        if (state.candles.length > 64) state.candles.shift();
      } else {
        candle.close = market.price;
        candle.high = Math.max(candle.high, market.price);
        candle.low = Math.min(candle.low, market.price);
      }
    }
  });
  renderMarketStrip();
  renderWatchlist();
  renderChart();
  renderPositions();
}

function selectAccountMode(mode) {
  if (mode !== "demo" && mode !== "real") return;
  if (state.pendingTrade || state.isSubmittingTrade) {
    toast("Wait for the current demo trade to finish before changing accounts.", true);
    return;
  }
  state.accountMode = mode;
  renderAccountMode();
}

function openFundsModal(action = "deposit") {
  state.fundsAction = action;
  const isDeposit = action === "deposit";
  const isDemo = state.accountMode === "demo";
  $("#funds-title").textContent = isDemo
    ? `${isDeposit ? "Deposit" : "Withdraw"} demo funds`
    : `Real ${isDeposit ? "deposits" : "withdrawals"} unavailable`;
  $("#funds-description").textContent = isDemo
    ? "This only changes your simulated demo balance. No real money is involved."
    : "Payment and licensed trading providers are not connected yet. No real money can be deposited, withdrawn, or traded.";
  $("#funds-amount-field").hidden = !isDemo;
  $("#confirm-funds").hidden = !isDemo;
  if (isDemo) {
    $("#funds-amount").min = isDeposit ? "100" : "10";
    $("#funds-amount").step = isDeposit ? "100" : "10";
    $("#funds-amount").value = isDeposit ? "1000" : "100";
    $("#funds-amount-field").querySelector("label").textContent = `${isDeposit ? "DEPOSIT" : "WITHDRAW"} AMOUNT IN USD`;
    $("#confirm-funds").className = `trade-submit ${isDeposit ? "buy-submit" : "sell-submit"}`;
    $("#confirm-funds").innerHTML = `${isDeposit ? "Deposit" : "Withdraw"} demo funds <span>→</span>`;
  }
  $("#funds-modal").hidden = false;
  if (isDemo) $("#funds-amount").focus();
}

function closeFundsModal() {
  $("#funds-modal").hidden = true;
}

function setNavigationMenuOpen(isOpen) {
  document.body.classList.toggle("menu-open", isOpen);
  $("#menu-backdrop").hidden = !isOpen;
  $("#menu-toggle").setAttribute("aria-expanded", String(isOpen));
  $("#menu-toggle").setAttribute("aria-label", isOpen ? "Close navigation menu" : "Open navigation menu");
}

function selectView(view) {
  const panel = $(`[data-view-panel="${view}"]`);
  if (!panel) return;
  $$("[data-view-panel]").forEach((item) => { item.hidden = item !== panel; });
  $$(".nav-link[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  $("#page-title").textContent = view;
  if (view === "Markets") renderMarketStrip();
  if (view === "History") {
    state.showingHistory = true;
    renderPositions();
  }
  if (view === "Withdrawal History") renderWithdrawalHistory();
  if (view === "Trade") renderChart();
  setNavigationMenuOpen(false);
  window.scrollTo({ top: 0 });
}

function toggleProfileDetails() {
  const details = $("#profile-details");
  details.hidden = !details.hidden;
  $("#profile-button").setAttribute("aria-expanded", String(!details.hidden));
}

async function submitDemoFunds() {
  if (state.accountMode !== "demo") {
    closeFundsModal();
    toast("Real money actions are locked until payment and trading providers are connected.", true);
    return;
  }
  const amount = Number($("#funds-amount").value);
  const isDeposit = state.fundsAction === "deposit";
  const minimum = isDeposit ? 100 : 10;
  if (!Number.isFinite(amount) || amount < minimum) {
    toast(`Enter at least ${money(minimum)}.`, true);
    return;
  }
  if (!isDeposit && amount > state.balance) {
    toast("You cannot withdraw more than your available demo balance.", true);
    return;
  }

  const previousBalance = state.balance;
  state.balance += isDeposit ? amount : -amount;
  renderBalance();
  $("#confirm-funds").disabled = true;
  const saved = await persistDemoBalance(previousBalance);
  $("#confirm-funds").disabled = false;
  if (!saved) return;

  if (!isDeposit) {
    state.withdrawalHistory.push({
      amount,
      balanceAfter: state.balance,
      createdAt: new Date().toISOString(),
    });
    renderWithdrawalHistory();
  }
  closeFundsModal();
  toast(`${money(amount)} ${isDeposit ? "added to" : "withdrawn from"} your demo balance.`);
}

function initialize() {
  generateCandles(activeMarket());
  renderMarketStrip();
  renderWatchlist();
  renderChart();
  renderBalance();
  renderAccountMode();
  renderPositions();
  renderWithdrawalHistory();
  setSentiment();

  $$(".timeframe").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".timeframe").forEach((item) => item.classList.toggle("active", item === button));
      state.timeframe = button.dataset.timeframe;
      generateCandles(activeMarket());
      renderChart();
    });
  });

  $$(".amount-presets button").forEach((button) => button.addEventListener("click", () => {
    amountInput.value = button.dataset.amount;
    updateOrderEstimate();
  }));
  amountInput.addEventListener("input", updateOrderEstimate);
  $("#buy-trade").addEventListener("click", () => placeTrade("buy"));
  $("#sell-trade").addEventListener("click", () => placeTrade("sell"));
  $("#favorite-button").addEventListener("click", () => toggleWatch(activeMarket().id));
  $("#market-select").addEventListener("change", (event) => selectMarket(event.target.value));
  $("#add-watch").addEventListener("click", () => toggleWatch(activeMarket().id));
  $("#view-all-positions").addEventListener("click", () => {
    state.showingHistory = !state.showingHistory;
    renderPositions();
  });
  $$(".account-tab").forEach((button) => button.addEventListener("click", () => selectAccountMode(button.dataset.accountMode)));
  $("#open-funds").addEventListener("click", () => openFundsModal("deposit"));
  $("#balance-deposit").addEventListener("click", () => openFundsModal("deposit"));
  $("#balance-withdraw").addEventListener("click", () => openFundsModal("withdraw"));
  $("#close-funds").addEventListener("click", closeFundsModal);
  $("#funds-modal").addEventListener("click", (event) => {
    if (event.target === $("#funds-modal")) closeFundsModal();
  });
  $("#confirm-funds").addEventListener("click", submitDemoFunds);
  $("#profile-button").addEventListener("click", toggleProfileDetails);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeFundsModal();
      setNavigationMenuOpen(false);
    }
  });

  $$(".nav-link[data-view]").forEach((button) => button.addEventListener("click", () => selectView(button.dataset.view)));
  $("#menu-toggle").addEventListener("click", () => {
    setNavigationMenuOpen(!document.body.classList.contains("menu-open"));
  });
  $("#menu-backdrop").addEventListener("click", () => setNavigationMenuOpen(false));
  $("#notifications-button").addEventListener("click", () => toast("You’re all caught up. Market updates are simulated."));
  $("#help-button").addEventListener("click", () => toast("Demo trades use simulated prices and do not reach an exchange."));
  $("#disclaimer-link").addEventListener("click", (event) => {
    event.preventDefault();
    toast("NexaTrade is a front-end demo. Prices, sentiment, and orders are simulated; no financial advice or real trading is provided.");
  });
  $("#chart-menu").addEventListener("click", () => {
    state.chartStyle = state.chartStyle === "candle" ? "line" : "candle";
    $("#chart-menu").title = state.chartStyle === "candle" ? "Switch to line chart" : "Switch to candlestick chart";
    drawChart();
    toast(`Chart display: ${state.chartStyle === "candle" ? "candlesticks" : "line"}.`);
  });

  chartCanvas.addEventListener("mousemove", (event) => {
    const rect = chartCanvas.getBoundingClientRect();
    const index = Math.max(0, Math.min(state.candles.length - 1, Math.floor((event.clientX - rect.left) / rect.width * state.candles.length)));
    const candle = state.candles[index];
    const tip = $("#chart-tooltip");
    tip.textContent = `${state.timeframe} · O ${formatExactPrice(activeMarket(), candle.open)} · H ${formatExactPrice(activeMarket(), candle.high)} · L ${formatExactPrice(activeMarket(), candle.low)} · C ${formatExactPrice(activeMarket(), candle.close)}`;
    tip.style.display = "block";
    tip.style.left = `${Math.max(42, Math.min(rect.width - 210, event.clientX - rect.left + 10))}px`;
    tip.style.top = `${Math.max(0, event.clientY - rect.top - 27)}px`;
  });
  chartCanvas.addEventListener("mouseleave", () => { $("#chart-tooltip").style.display = "none"; });
  window.addEventListener("resize", () => {
    drawChart();
    renderMarketStrip();
  });
}

function toggleWatch(id) {
  if (state.watchlist.includes(id)) {
    state.watchlist = state.watchlist.filter((item) => item !== id);
    toast(`${id} removed from your watchlist.`);
  } else {
    state.watchlist.push(id);
    toast(`${id} added to your watchlist.`);
  }
  renderWatchlist();
  renderChart();
}

function setAuthMode(mode) {
  const isSignUp = mode === "signup";
  $("#auth-title").innerHTML = isSignUp ? 'Create your NexaTrade account<span class="title-period">.</span>' : 'Welcome back<span class="title-period">.</span>';
  $("#auth-name-field").hidden = !isSignUp;
  $("#auth-phone-field").hidden = !isSignUp;
  $("#auth-confirm-field").hidden = !isSignUp;
  $("#auth-name").required = isSignUp;
  $("#auth-confirm").required = isSignUp;
  $("#auth-password").autocomplete = isSignUp ? "new-password" : "current-password";
  $("#auth-submit").innerHTML = `${isSignUp ? "Create account" : "Sign in"} <span>→</span>`;
  $$(".auth-tab").forEach((button) => button.classList.toggle("active", button.dataset.authMode === mode));
  $("#auth-error").hidden = true;
  $("#auth-error").textContent = "";
  $("#auth-message").hidden = true;
  $("#auth-message").textContent = "";
  $("#auth-form").dataset.mode = mode;
}

function showAuthError(message) {
  $("#auth-message").hidden = true;
  $("#auth-error").textContent = message;
  $("#auth-error").hidden = false;
}

function showAuthMessage(message) {
  $("#auth-error").hidden = true;
  $("#auth-message").textContent = message;
  $("#auth-message").hidden = false;
}

function startDashboard() {
  if (!state.initialized) {
    initialize();
    state.initialized = true;
  } else {
    renderMarketStrip();
    renderWatchlist();
    renderChart();
    renderBalance();
    renderPositions();
    renderWithdrawalHistory();
  }
  if (!state.marketUpdateInterval) state.marketUpdateInterval = window.setInterval(updateMarkets, 3000);
  if (!state.sentimentInterval) state.sentimentInterval = window.setInterval(setSentiment, 9000);
}

function stopDashboard() {
  window.clearInterval(state.marketUpdateInterval);
  window.clearInterval(state.sentimentInterval);
  state.marketUpdateInterval = null;
  state.sentimentInterval = null;
}

function resetUserDemoState() {
  state.userId = null;
  state.balance = 10000;
  state.accountMode = "demo";
  state.positions = [];
  state.history = [];
  state.withdrawalHistory = [];
  state.watchlist = ["XAU", "EUR", "GBP"];
  state.showingHistory = false;
  state.activeMarket = "XAU";
  state.timeframe = "1min";
  state.chartStyle = "candle";
  state.pendingTrade = null;
  state.isSubmittingTrade = false;
  $("#profile-details").hidden = true;
  $("#profile-button").setAttribute("aria-expanded", "false");
  generateCandles(activeMarket());
  $$(".timeframe").forEach((button) => button.classList.toggle("active", button.dataset.timeframe === state.timeframe));
  $("#trade-result").hidden = true;
}

async function enterDashboard(user) {
  let demoBalance;
  try {
    demoBalance = await loadDemoBalance(user.id);
  } catch (error) {
    const detail = getErrorMessage(error, "Supabase request failed.");
    showAuthError(`Could not load your demo account. Run supabase-demo-accounts.sql in the Supabase SQL Editor, then reload. Details: ${detail}`);
    return false;
  }

  if (state.userId !== user.id) resetUserDemoState();
  state.userId = user.id;
  state.balance = demoBalance;
  const email = user.email || "";
  const name = user.user_metadata && user.user_metadata.full_name
    ? user.user_metadata.full_name
    : email.split("@")[0] || "Trader";
  const phone = user.phone || (user.user_metadata && user.user_metadata.phone) || "Not provided";
  $("#auth-password").value = "";
  $("#auth-confirm").value = "";
  $("#user-name").textContent = name;
  $("#user-email").textContent = email;
  $("#user-phone").textContent = `Phone: ${phone}`;
  $(".avatar").textContent = name.charAt(0).toUpperCase();
  renderAccountMode();
  document.body.classList.add("authenticated");
  startDashboard();
  return true;
}

async function submitAuth(event) {
  event.preventDefault();
  $("#auth-error").hidden = true;
  $("#auth-message").hidden = true;

  if (!supabaseClient) {
    showAuthError(supabaseSetupError);
    return;
  }

  const mode = $("#auth-form").dataset.mode || "signin";
  const name = $("#auth-name").value.trim();
  const phone = $("#auth-phone").value.trim();
  const email = $("#auth-email").value.trim().toLowerCase();
  const password = $("#auth-password").value;
  if (!$("#auth-email").checkValidity()) {
    showAuthError("Enter a valid email address.");
    $("#auth-email").focus();
    return;
  }
  if (password.length < 8) {
    showAuthError("Use a password with at least 8 characters.");
    $("#auth-password").focus();
    return;
  }
  if (mode === "signup") {
    if (!name) {
      showAuthError("Enter your name to create an account.");
      $("#auth-name").focus();
      return;
    }
    if (password !== $("#auth-confirm").value) {
      showAuthError("The passwords do not match.");
      $("#auth-confirm").focus();
      return;
    }
  }

  const submitButton = $("#auth-submit");
  submitButton.disabled = true;
  submitButton.textContent = mode === "signup" ? "Creating account…" : "Signing in…";
  try {
    const result = mode === "signup"
      ? await supabaseClient.auth.signUp({
        email,
        password,
        options: { data: { full_name: name, phone } },
      })
      : await supabaseClient.auth.signInWithPassword({ email, password });

    if (result.error) {
      const message = result.error.message;
      if (mode === "signin" && /invalid login credentials/i.test(message)) {
        showAuthError("The email or password doesn’t match a registered account. Check the details you used to sign up and try again.");
      } else if (mode === "signin" && /email not confirmed/i.test(message)) {
        showAuthError("Confirm your email using the link sent when you registered, then sign in.");
      } else {
        showAuthError(message);
      }
    } else if (result.data.session) {
      await enterDashboard(result.data.user);
    } else if (mode === "signup") {
      $("#auth-password").value = "";
      $("#auth-confirm").value = "";
      setAuthMode("signin");
      showAuthMessage("Account created. Check your email to confirm it, then sign in.");
    } else {
      showAuthError("Sign-in completed without an active session. Check your Supabase auth settings and try again.");
    }
  } catch (error) {
    showAuthError(error instanceof Error ? error.message : "Could not reach Supabase. Check your connection and project settings.");
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = `${mode === "signup" ? "Create account" : "Sign in"} <span>→</span>`;
  }
}

async function signOut() {
  if (state.pendingTrade || state.isSubmittingTrade) {
    toast("Wait for the four-second demo trade to finish before signing out.");
    return;
  }
  if (!supabaseClient) {
    showAuthError(supabaseSetupError);
    return;
  }
  try {
    const { error } = await supabaseClient.auth.signOut();
    if (error) {
      toast(`Could not sign out: ${error.message}`, true);
      return;
    }
    stopDashboard();
    document.body.classList.remove("authenticated");
    resetUserDemoState();
    $("#auth-password").value = "";
    $("#auth-confirm").value = "";
    $("#auth-email").value = "";
    setAuthMode("signin");
    $("#auth-email").focus();
  } catch (error) {
    toast(`Could not sign out: ${error instanceof Error ? error.message : "Supabase request failed."}`, true);
  }
}

async function initializeAuth() {
  $$(".auth-tab").forEach((button) => button.addEventListener("click", () => setAuthMode(button.dataset.authMode)));
  $("#auth-form").addEventListener("submit", submitAuth);
  $("#sign-out").addEventListener("click", signOut);
  setAuthMode("signin");

  if (!supabaseClient) {
    showAuthError(supabaseSetupError);
    return;
  }

  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) {
      showAuthError(`Could not restore your sign-in: ${error.message}`);
      return;
    }
    if (data.session) await enterDashboard(data.session.user);
  } catch (error) {
    showAuthError(`Could not restore your sign-in: ${error instanceof Error ? error.message : "Supabase request failed."}`);
  }
}

initializeAuth();
