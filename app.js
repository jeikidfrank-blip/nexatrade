"use strict";

// Demo price data for USD currency pairs.
const markets = [
  { id: "XAU", name: "Gold", symbol: "XAUUSD", price: 3342.58, change: 0.37, icon: "Au", iconClass: "xau", color: "#e7c96f", volatility: 0.0007 },
  { id: "EUR", name: "Euro", symbol: "EURUSD", price: 1.0846, change: 0.12, icon: "€", iconClass: "eur", color: "#79b2ff", volatility: 0.0004 },
  { id: "GBP", name: "Pound", symbol: "GBPUSD", price: 1.2742, change: 0.18, icon: "£", iconClass: "gbp", color: "#ba9bff", volatility: 0.00045 },
];

const state = {
  activeMarket: "XAU",
  timeframe: "1min",
  balance: 10000, realTestBalance: 0,
  realTestTransactions: [],
  realTestPositions: [],
  realTestHistory: [],
  fundsAction: "deposit",
  userId: null,
  userPhone: "",
  accountMode: "demo",
  positions: [],
  history: [],
  demoDeposits: [],
  watchlist: ["XAU", "EUR", "GBP"],
  showingHistory: false,
  chartStyle: "candle",
  candles: [],
  visibleCandles: 64,
  candleOffset: 0,
  priceZoom: 1,
  priceOffset: 0,
  isSubmittingTrade: false,
  tradeDisplay: null,
  tradeResultTimeout: null,
  defaultRiskValues: null,
  quoteErrorNotified: false,
  marketQuoteLoading: false,
  initialized: false,
  marketUpdateInterval: null,
  sentimentInterval: null,
  candleTimerInterval: null,
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
const compactCurrency = new Intl.NumberFormat("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timeframeDurations = { "30sec": 30_000, "1min": 60_000, "5min": 300_000 };
const supabaseConfig = window.NEXATRADE_SUPABASE_CONFIG || {};
let supabaseClient = null;
let supabaseSetupError = "";
let chartPointerDrag = null;

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
  const digits = Math.abs(value) < 10 ? 4 : 2;
  return `$${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)}`;
}

function formatChange(value) {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;
}

function money(value) {
  return `KSh ${compactCurrency.format(value)}`;
}

function getErrorMessage(error, fallback) {
  if (error instanceof Error) return error.message;
  if (error && typeof error.message === "string" && error.message) return error.message;
  return fallback;
}

function getTimeframeInterval() {
  const interval = timeframeDurations[state.timeframe];
  if (!interval) throw new Error(`Unsupported chart timeframe: ${state.timeframe}`);
  return interval;
}

function generateCandles(market) {
  const candles = [];
  const interval = getTimeframeInterval();
  const scale = { "30sec": 0.00045, "1min": 0.0007, "5min": 0.0016 }[state.timeframe];
  const step = market.price * scale * 0.3;
  const historyCount = 360;
  let close = market.price + (Math.random() - 0.5) * step * 18;
  const lastIntervalStart = Math.floor(Date.now() / interval) * interval;
  for (let index = 0; index < historyCount; index += 1) {
    const open = close;
    const drift = (Math.random() - 0.5) * step + (market.change / 100) * market.price * 0.002;
    close = Math.max(0.0001, open + drift);
    if (index === historyCount - 1) close = market.price;
    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);
    const wick = market.price * scale * (0.08 + Math.random() * 0.32);
    candles.push({
      open,
      close,
      high: bodyHigh + wick * (0.3 + Math.random()),
      low: Math.max(0.0001, bodyLow - wick * (0.3 + Math.random())),
      startedAt: lastIntervalStart - (historyCount - 1 - index) * interval,
    });
  }
  const last = candles[candles.length - 1];
  last.high = Math.max(last.high, market.price);
  last.low = Math.min(last.low, market.price);
  state.candles = candles;
  state.visibleCandles = Math.min(64, candles.length);
  state.candleOffset = 0;
  state.priceZoom = 1;
  state.priceOffset = 0;
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
      <span class="watch-copy"><strong class="watch-symbol">${market.symbol}</strong><span class="watch-name">${market.name}</span></span>
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


function getVisibleCandles() {
  const end = Math.max(0, state.candles.length - state.candleOffset);
  const start = Math.max(0, end - state.visibleCandles);
  return { candles: state.candles.slice(start, end), start };
}

function getChartPriceBounds(candles = getVisibleCandles().candles) {
  const marketPrice = activeMarket().price;
  if (!candles.length) {
    const range = marketPrice * 0.006;
    return { min: marketPrice - range / 2, max: marketPrice + range / 2, center: marketPrice, baseRange: range };
  }
  const values = candles.flatMap((candle) => [candle.high, candle.low]);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const baseRange = (rawMax - rawMin || marketPrice * 0.006) * 1.16;
  const center = (rawMin + rawMax) / 2 + state.priceOffset;
  const range = baseRange / state.priceZoom;
  return { min: center - range / 2, max: center + range / 2, center, baseRange };
}

function renderChartLabels() {
  const market = activeMarket();
  const visible = getVisibleCandles().candles;
  const bounds = getChartPriceBounds(visible);
  const step = (bounds.max - bounds.min) / 4;
  const firstTime = visible.length ? new Date(visible[0].startedAt) : null;
  const lastTime = visible.length ? new Date(visible[visible.length - 1].startedAt) : null;
  const timeOptions = { hour: "2-digit", minute: "2-digit", hour12: false };
  if (state.timeframe === "30sec") timeOptions.second = "2-digit";
  if (firstTime && lastTime && firstTime.toDateString() !== lastTime.toDateString()) {
    timeOptions.month = "2-digit";
    timeOptions.day = "2-digit";
  }
  $("#chart-y-labels").replaceChildren(...Array.from({ length: 5 }, (_, index) => {
    const label = document.createElement("span");
    label.textContent = formatExactPrice(market, bounds.max - step * index);
    return label;
  }));
  $$("[data-chart-time]").forEach((label, index, labels) => {
    const candleIndex = Math.round(index / (labels.length - 1) * (visible.length - 1));
    const candle = visible[candleIndex];
    if (!candle) {
      label.textContent = "";
      return;
    }
    const time = new Date(candle.startedAt);
    label.textContent = time.toLocaleString([], timeOptions);
  });
}

function renderCandleCountdown() {
  const candle = state.candles[state.candles.length - 1];
  if (!candle) return;
  const remaining = Math.max(0, Math.ceil(
    (candle.startedAt + getTimeframeInterval() - Date.now()) / 1000,
  ));
  const minutes = String(Math.floor(remaining / 60)).padStart(2, "0");
  const seconds = String(remaining % 60).padStart(2, "0");
  $("#candle-countdown").textContent = `NEXT CANDLE IN ${minutes}:${seconds}`;
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
  const candles = getVisibleCandles().candles;
  if (!candles.length) return;
  const { min, max } = getChartPriceBounds(candles);
  const yFor = (value) => height - ((value - min) / (max - min)) * height;
  const xStep = width / candles.length;

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
    candles.forEach((candle, index) => {
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
    candles.forEach((candle, index) => {
      const x = index * xStep + xStep / 2;
      const y = yFor(candle.close);
      if (index === 0) chartContext.moveTo(x, y);
      else chartContext.lineTo(x, y);
    });
    chartContext.strokeStyle = "#39d2a2";
    chartContext.lineWidth = 1.6;
    chartContext.stroke();
  } else {
    candles.forEach((candle, index) => {
      const center = index * xStep + xStep / 2;
      const rising = candle.close >= candle.open;
      const color = rising ? "#36c99a" : "#e9747c";
      chartContext.strokeStyle = color;
      chartContext.fillStyle = color;
      chartContext.lineWidth = 1.5;
      chartContext.beginPath();
      chartContext.moveTo(center, yFor(candle.high));
      chartContext.lineTo(center, yFor(candle.low));
      chartContext.stroke();
      const top = yFor(Math.max(candle.open, candle.close));
      const bottom = yFor(Math.min(candle.open, candle.close));
      const candleWidth = Math.max(3, Math.min(10, xStep * 0.68));
      chartContext.fillRect(center - candleWidth / 2, top, candleWidth, Math.max(1.5, bottom - top));
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

function refreshChartViewport() {
  renderChartLabels();
  drawChart();
}

function zoomChartTime(factor, anchorFraction = 0.5) {
  const visible = getVisibleCandles();
  if (!visible.candles.length) return;
  const oldCount = state.visibleCandles;
  const nextCount = Math.max(12, Math.min(240, Math.round(oldCount * factor)));
  if (nextCount === oldCount) return;
  const anchorIndex = visible.start + anchorFraction * visible.candles.length;
  const nextEnd = anchorIndex + (1 - anchorFraction) * nextCount;
  state.visibleCandles = nextCount;
  state.candleOffset = Math.round(Math.max(
    0,
    Math.min(state.candles.length - 12, state.candles.length - nextEnd),
  ));
  refreshChartViewport();
}

function zoomChartPrice(factor, anchorFraction = 0.5) {
  const bounds = getChartPriceBounds();
  const nextZoom = Math.max(0.25, Math.min(12, state.priceZoom * factor));
  if (nextZoom === state.priceZoom) return;
  const anchorPrice = bounds.max - anchorFraction * (bounds.max - bounds.min);
  const nextRange = bounds.baseRange / nextZoom;
  const baseCenter = bounds.center - state.priceOffset;
  const nextCenter = anchorPrice + (anchorFraction - 0.5) * nextRange;
  state.priceZoom = nextZoom;
  state.priceOffset = nextCenter - baseCenter;
  refreshChartViewport();
}

function resetChartViewport() {
  state.visibleCandles = 64;
  state.candleOffset = 0;
  state.priceZoom = 1;
  state.priceOffset = 0;
  refreshChartViewport();
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
  if (!state.defaultRiskValues || state.defaultRiskValues.marketId !== market.id) {
    setRiskDefaults("buy", market);
  }
  $(".sentiment-heading > span").textContent = market.symbol;
  if ($("#buy-trade").dataset.market !== market.id) {
    $("#buy-trade").innerHTML = `Buy ${market.symbol} <span>↗</span>`;
    $("#sell-trade").innerHTML = `Sell ${market.symbol} <span>↘</span>`;
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
  $("#available-balance").textContent = state.accountMode === "demo"
    ? money(state.balance)
    : money(state.realTestBalance);
}

function renderBalance() {
  const isDemo = state.accountMode === "demo";

  const balance = isDemo
    ? state.balance
    : state.realTestBalance;

  $("#balance-value").textContent = money(balance);
  $("#available-balance").textContent = money(balance);
}

function renderAccountMode() {
  const isDemo = state.accountMode === "demo";

  $(".account-overview").classList.toggle("is-real", !isDemo);

  $$(".account-tab").forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.accountMode === state.accountMode
    );
  });

  $("#balance-label").innerHTML = isDemo
    ? 'DEMO BALANCE <span class="info-tip" title="Demo funds only">i</span>'
    : 'REAL ACCOUNT BALANCE <span class="info-tip" title="No real money">i</span>';

  $("#account-status").textContent = isDemo
    ? "DEMO · No real money involved"
    : "";

  $("#order-mode-description").textContent = isDemo
    ? "Demo position · server-priced execution"
    : "Market order";

  const orderModeTag = $("#order-mode-tag");
  if (orderModeTag) {
    orderModeTag.hidden = !isDemo;
    orderModeTag.textContent = "DEMO";
  }

  $("#available-balance-label").textContent = isDemo
    ? "Available demo funds"
    : "Available funds";


  $$("#trade-amount, #stop-loss-price, #take-profit-price").forEach((field) => {
    field.disabled = false;
  });

  $$(".amount-presets button").forEach((button) => {
    button.disabled = false;
  });

  $$(".trade-action").forEach((button) => {
    button.disabled = state.isSubmittingTrade;
  });

  $$(".close-position").forEach((button) => {
    button.disabled = state.isSubmittingTrade;
  });

  $("#balance-withdraw").hidden = isDemo;

  renderBalance();
  updateOrderEstimate();
}

function setRiskDefaults(side, market) {
  const stop = side === "buy" ? market.price * 0.97 : market.price * 1.03;
  const take = side === "buy" ? market.price * 1.06 : market.price * 0.94;
  const precision = market.price < 10 ? 4 : 2;
  const values = { marketId: market.id, side, stop: stop.toFixed(precision), take: take.toFixed(precision) };
  $("#stop-loss-price").value = values.stop;
  $("#take-profit-price").value = values.take;
  state.defaultRiskValues = values;
}

async function loadDemoBalance() {
  const { data, error } = await supabaseClient
    .from("demo_accounts")
    .select("balance")
    .eq("user_id", state.userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error("The demo account was not created. Run the Supabase setup script and try again.");
  }
  const balance = Number(data.balance);
  if (!Number.isFinite(balance) || balance < 0) {
    throw new Error("The demo account balance is missing or invalid.");
  }
  return balance;
}

async function loadRealTestBalance() {
  const { data, error } = await supabaseClient
    .from("real_test_accounts")
    .select("balance")
    .eq("user_id", state.userId)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    throw new Error("Real Test Account was not created.");
  }

  const balance = Number(data.balance);

  if (!Number.isFinite(balance) || balance < 0) {
    throw new Error("Invalid Real Test Account balance.");
  }

  return balance;
}

function mapPositionRow(row) {
  return {
    id: row.id,
    marketId: row.market,
    side: row.side,
    amount: Number(row.amount),
    quantity: Number(row.quantity),
    entryPrice: Number(row.entry_price),
    stopLoss: Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    entryFee: Number(row.entry_fee),
    exitPrice: row.exit_price === null ? null : Number(row.exit_price),
    pnl: row.pnl === null ? null : Number(row.pnl),
    pnlMultiplier: Number(row.pnl_multiplier ?? 1),
    outcome: row.pnl === null ? null : Number(row.pnl) > 0 ? "win" : Number(row.pnl) < 0 ? "loss" : "push",
    status: row.status,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
  };
}

async function loadDemoPositions() {
  const { data, error } = await supabaseClient
    .from("demo_positions")
    .select("id,market,side,amount,quantity,entry_price,stop_loss,take_profit,entry_fee,exit_price,pnl,pnl_multiplier,status,opened_at,closed_at")
    .eq("user_id", state.userId)
    .order("opened_at", { ascending: false })
    .limit(500);

  if (error) throw error;

  const positions = (data || []).map(mapPositionRow);

  state.positions = positions.filter((position) => position.status === "open");
  state.history = positions.filter((position) => position.status === "closed");

  renderPositions();
}

async function loadDemoDeposits() {
  const { data, error } = await supabaseClient
    .from("demo_transactions")
    .select("id,amount,balance_after,created_at")
    .eq("user_id", state.userId)
    .eq("transaction_type", "deposit")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  state.demoDeposits = data || [];
  renderDemoDeposits();
}

async function loadRealTestTransactions() {
  const { data, error } = await supabaseClient
    .from("real_test_transactions")
    .select("id,transaction_type,amount,balance_after,created_at")
    .eq("user_id", state.userId)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) throw error;

  state.realTestTransactions = data || [];
  renderDemoDeposits();
}

async function loadRealTestPositions() {
  const { data, error } = await supabaseClient
    .from("real_test_positions")
    .select("id,market,side,amount,quantity,entry_price,stop_loss,take_profit,entry_fee,exit_price,pnl,status,opened_at,closed_at")
    .eq("user_id", state.userId)
    .order("opened_at", { ascending: false })
    .limit(500);

  if (error) throw error;

  const positions = (data || []).map(mapPositionRow);

  state.realTestPositions = positions.filter((position) => position.status === "open");
  state.realTestHistory = positions.filter((position) => position.status === "closed");
}


function renderPositions() {
  const isDemo = state.accountMode === "demo";
  const positions = isDemo
    ? (state.showingHistory ? state.history : state.positions)
    : (state.showingHistory ? state.realTestHistory : state.realTestPositions);

  $("#positions-title").textContent = state.showingHistory ? "Completed trades" : "Open positions";
  const pnlHeading = $("#pnl-heading");
  if (pnlHeading) pnlHeading.textContent = state.showingHistory ? "REALIZED P&L" : "UNREALIZED P&L";
  $("#position-count").textContent = String(positions.length);
  $("#view-all-positions").innerHTML = state.showingHistory ? "View open positions <span>↗</span>" : "View completed trades <span>↗</span>";

  const body = $("#positions-body");
  body.replaceChildren();

  if (!positions.length) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    row.innerHTML = `<td colspan="5"><span class="empty-icon">⌁</span><strong>${state.showingHistory ? "No closed trades yet" : "No open positions yet"}</strong><span>${state.showingHistory ? "Closed trades will appear here." : "Place a trade to see it here."}</span></td>`;
    body.append(row);
    return;
  }

  positions.slice().reverse().forEach((position) => {
    const market = marketById(position.marketId);
    const currentPrice = market.price;
    const rawPnl = (currentPrice - position.entryPrice) * position.quantity * (position.side === "buy" ? 1 : -1);
    const pnl = state.showingHistory ? position.pnl : rawPnl - position.entryFee - position.quantity * currentPrice * 0.001;
    const quantityPrecision = market.price < 10 ? 4 : 6;
    const row = document.createElement("tr");

    const multiplier = Number(position.pnlMultiplier || 1);

    const outcomeLabel = isDemo && position.outcome === "win"
      ? `WIN ×${multiplier}`
      : position.outcome
        ? position.outcome.toUpperCase()
        : "CLOSED";

    row.innerHTML = `
      <td><span class="position-market"><span class="watch-coin coin-${market.iconClass}">${market.icon}</span><span class="position-market-copy"><strong class="position-symbol">${market.symbol}</strong><span class="position-name">${market.name}</span></span></span></td>
      <td><span class="side-pill ${position.side}">${position.side === "buy" ? "BUY / LONG" : "SELL / SHORT"}</span></td>
      <td><strong>${position.quantity.toFixed(quantityPrecision)} ${market.id}</strong><br><span>${money(position.amount)}</span></td>
      <td class="${pnl >= 0 ? "positive" : "negative"}">${pnl >= 0 ? "+" : "−"}${money(Math.abs(pnl))}</td>
      <td>${state.showingHistory ? `<span class="result-tag ${position.outcome || "closed"}">${outcomeLabel}</span>` : `<button class="close-position" data-position="${position.id}">Close</button>`}</td>`;

    if (!state.showingHistory) {
      const closeButton = row.querySelector(".close-position");
      closeButton.disabled = state.isSubmittingTrade;
      closeButton.addEventListener("click", () => closePosition(position.id));
    }

    body.append(row);
  });
}
function renderDemoDeposits() {
  const body = $("#demo-transactions-body");
  const isDemo = state.accountMode === "demo";

  const records = isDemo
    ? state.demoDeposits
    : state.realTestTransactions;

  $("#transactions-title").textContent = "Transaction history";
  const transactionsModeTag = $("#transactions-mode-tag");
  if (transactionsModeTag) transactionsModeTag.textContent = "";

  body.replaceChildren();

  if (!records.length) {
    const row = document.createElement("tr");
    row.className = "empty-row";

    row.innerHTML = '<td colspan="5"><span class="empty-icon">＋</span><strong>No transactions yet</strong><span>Your deposits and withdrawals will appear here.</span></td>';

    body.append(row);
    return;
  }

  records.forEach((record) => {
    const row = document.createElement("tr");

    const date = document.createElement("td");
    date.textContent = new Date(record.created_at).toLocaleString(
      undefined,
      { dateStyle: "short", timeStyle: "short" }
    );

    const transaction = document.createElement("td");
    const transactionType = isDemo
      ? "deposit"
      : record.transaction_type;

    transaction.textContent = isDemo
      ? "Demo deposit"
      : transactionType === "withdrawal"
        ? "Withdrawal"
        : "Deposit";

    const amount = document.createElement("td");
    const prefix = transactionType === "withdrawal" ? "-" : "+";
    amount.textContent = `${prefix}${money(Number(record.amount))}`;

    const balance = document.createElement("td");
    balance.textContent = money(Number(record.balance_after));

    const type = document.createElement("td");
    type.textContent = transactionType === "withdrawal" ? "Withdrawal" : "Deposit";

    row.append(date, transaction, amount, balance, type);
    body.append(row);
  });
}

function unrealizedPnl(position) {
  const market = marketById(position.marketId);
  if (!market) return 0;
  const direction = position.side === "buy" ? 1 : -1;
  const gross = (market.price - position.entryPrice) * position.quantity * direction;
  return gross - position.entryFee - position.quantity * market.price * 0.001;
}

function renderTradeResult() {
  const display = state.tradeDisplay;
  const panel = $("#trade-result");

  const isPending = Boolean(display && display.status === "pending");
  const isOpen = Boolean(display && display.status === "open");

  panel.hidden = !display || isPending;
  $("#result-executing").hidden = !isPending;

  if (!display) return;

  if (isPending) {
    return;
  }

  const isClosed = display.status === "closed";
  const isLive = isOpen && display.position;

  const pnl = isClosed
    ? Number(display.position?.pnl || 0)
    : isLive
      ? unrealizedPnl(display.position)
      : 0;

  const multiplier = Number(display.position?.pnlMultiplier || 1);

  panel.className = `trade-result ${isClosed
    ? pnl >= 0 ? "is-win" : "is-loss"
    : isLive
      ? pnl >= 0 ? "is-win" : "is-loss"
      : "is-error"
    }`;

  $("#dismiss-trade-result").hidden = false;

  $("#result-status").textContent = isClosed
    ? pnl > 0
      ? `TRADE CLOSED · WIN ×${multiplier}`
      : pnl < 0
        ? "TRADE CLOSED · LOSS"
        : "TRADE CLOSED · BREAK EVEN"
    : isLive
      ? "POSITION OPEN · LIVE P&L"
      : "TRADE NOT EXECUTED";

  const amount = $("#result-outcome-amount");

  amount.hidden = !isClosed && !isLive;

  if (isClosed || isLive) {
    amount.textContent =
      `${pnl > 0 ? "+" : pnl < 0 ? "−" : ""}${money(Math.abs(pnl))}`;
  }
}

function showTradeResult(display) {
  if (state.tradeResultTimeout) window.clearTimeout(state.tradeResultTimeout);
  state.tradeResultTimeout = null;
  state.tradeDisplay = display;
  renderTradeResult();
  if (display.status !== "pending" && display.status !== "open") {
    state.tradeResultTimeout = window.setTimeout(() => {
      state.tradeResultTimeout = null;
      state.tradeDisplay = null;
      renderTradeResult();
    }, 6000);
  }
}

function waitForMinimumExecutionTime(startedAt) {
  const duration = 3000;
  const endTime = startedAt + duration;

  return new Promise((resolve) => {
    const message = $("#result-executing-message");

    function updateCountdown() {
      const remaining = Math.max(0, endTime - Date.now());
      const seconds = Math.ceil(remaining / 1000);

      if (remaining > 0) {
        message.textContent = `Executing order · ${seconds}`;
        setTimeout(updateCountdown, 100);
      } else {
        message.textContent = "Confirming execution...";
        resolve();
      }
    }

    updateCountdown();
  });
}

function dismissTradeResult() {
  if (state.tradeResultTimeout) window.clearTimeout(state.tradeResultTimeout);
  state.tradeResultTimeout = null;
  state.tradeDisplay = null;
  renderTradeResult();
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
  renderTradeResult();
}

function toast(message, isError = false) {
  const item = document.createElement("div");
  item.className = `toast${isError ? " error" : ""}`;
  item.textContent = message;
  $("#toast-region").append(item);
  window.setTimeout(() => item.remove(), 3500);
}


const MIN_POSITION = 100;

function availableBalance() {
  return state.accountMode === "demo" ? state.balance : state.realTestBalance;
}

function maxAffordableAmount() {
  const balance = availableBalance();
  const value = Math.floor((balance / 1.001) * 100) / 100;
  return value > 0 ? value : 0;
}

function friendlyTradeError(message) {
  if (/could not find the function|schema cache|PGRST20[25]/i.test(message)) {
    return "The real-account trading functions are missing from your database. Run supabase-real-test-trading.sql in the Supabase SQL Editor, then reload this page.";
  }
  return message;
}

async function placeTrade(side) {
  if (state.isSubmittingTrade) return;

  const isDemo = state.accountMode === "demo";
  const amount = Number(amountInput.value);

  if (!Number.isFinite(amount) || amount < MIN_POSITION) {
    toast(`Enter a position amount of at least ${money(MIN_POSITION)}.`, true);
    amountInput.focus();
    return;
  }

  const market = activeMarket();

  const entryFee = Math.round(amount * 0.001 * 100) / 100;
  const requiredMargin = Math.round((amount + entryFee) * 100) / 100;
  const balance = availableBalance();

  if (requiredMargin > balance) {
    toast(`This position needs ${money(requiredMargin)} including the ${money(entryFee)} fee, but your balance is ${money(balance)}. Lower the amount, press Max, or deposit more.`, true);
    amountInput.focus();
    return;
  }

  if (state.defaultRiskValues && state.defaultRiskValues.marketId === market.id
    && $("#stop-loss-price").value === state.defaultRiskValues.stop
    && $("#take-profit-price").value === state.defaultRiskValues.take
    && state.defaultRiskValues.side !== side) {
    setRiskDefaults(side, market);
  }

  if (state.defaultRiskValues
    && state.defaultRiskValues.marketId === market.id
    && state.defaultRiskValues.side === side) {
    const currentStop = Number($("#stop-loss-price").value);
    const currentTake = Number($("#take-profit-price").value);
    const stillBrackets = side === "buy"
      ? currentStop < market.price && currentTake > market.price
      : currentStop > market.price && currentTake < market.price;
    if (!stillBrackets) setRiskDefaults(side, market);
  }

  const stopLoss = Number($("#stop-loss-price").value);
  const takeProfit = Number($("#take-profit-price").value);

  if (!Number.isFinite(stopLoss) || !Number.isFinite(takeProfit)) {
    toast("Enter valid stop-loss and take-profit prices.", true);
    return;
  }

  const executionStartedAt = Date.now();
  state.isSubmittingTrade = true;
  showTradeResult({ status: "pending", side, marketId: market.id, operation: "open" });
  renderAccountMode();

  let resultDisplay = null;
  let notification;
  let notificationIsError = false;

  try {
    const { data, error } = await supabaseClient.rpc(
      isDemo ? "demo_open_position" : "real_test_open_position",
      {
        p_market: market.id,
        p_side: side,
        p_amount: amount,
        p_stop_loss: stopLoss,
        p_take_profit: takeProfit,
      }
    );

    if (error) throw error;
    if (!data || !data.position) throw new Error("The server did not return the opened position.");

    const openedPosition = mapPositionRow(data.position);

    state.showingHistory = false;

    if (isDemo) {
      // Immediately settle the newly opened demo trade.
      const { data: closeData, error: closeError } = await supabaseClient.rpc(
        "demo_close_position",
        { p_position_id: openedPosition.id }
      );

      if (closeError) throw closeError;

      if (!closeData || !closeData.position) {
        throw new Error("The server did not return the settled trade.");
      }

      const position = mapPositionRow(closeData.position);
      const balance = Number(closeData.balance_after);

      if (!Number.isFinite(balance) || balance < 0) {
        throw new Error("The server returned an invalid balance.");
      }

      state.balance = balance;

      await loadDemoPositions();

      resultDisplay = {
        status: "closed",
        side: position.side,
        marketId: position.marketId,
        position,
        outcome: position.outcome,
      };

      notification = `Demo trade ${position.outcome.toUpperCase()}: ${position.pnl >= 0 ? "+" : "−"
        }${money(Math.abs(position.pnl))}.`;

    } else {
      // Immediately settle the real-test trade.
      const { data: closeData, error: closeError } = await supabaseClient.rpc(
        "real_test_close_position",
        { p_position_id: openedPosition.id }
      );

      if (closeError) throw closeError;

      if (!closeData || !closeData.position) {
        throw new Error("The server did not return the settled trade.");
      }

      const position = mapPositionRow(closeData.position);
      const balance = Number(closeData.balance_after);

      if (!Number.isFinite(balance) || balance < 0) {
        throw new Error("The server returned an invalid balance.");
      }

      state.realTestBalance = balance;

      await loadRealTestPositions();

      resultDisplay = {
        status: "closed",
        side: position.side,
        marketId: position.marketId,
        position,
        outcome: position.outcome,
      };

      notification = `Trade ${position.outcome.toUpperCase()}: ${
        position.pnl >= 0 ? "+" : "−"
      }${money(Math.abs(position.pnl))}.`;
    }

    renderBalance();
    renderPositions();
  } catch (error) {
    const message = friendlyTradeError(getErrorMessage(error, "Supabase request failed."));
    resultDisplay = { status: "error", side, marketId: market.id, message };
    notification = `Could not open position: ${message}`;
    notificationIsError = true;
  } finally {
    await waitForMinimumExecutionTime(executionStartedAt);
    state.isSubmittingTrade = false;
    if (resultDisplay) {
      showTradeResult(resultDisplay);
    } else {
      dismissTradeResult();
    }
    renderAccountMode();
    toast(notification, notificationIsError);
  }
}

async function closePosition(id) {
  if (state.isSubmittingTrade) return;

  const isDemo = state.accountMode === "demo";
  const source = isDemo ? state.positions : state.realTestPositions;
  const positionToClose = source.find((position) => position.id === id);

  const executionStartedAt = Date.now();
  state.isSubmittingTrade = true;
  showTradeResult({
    status: "pending",
    side: positionToClose ? positionToClose.side : "buy",
    marketId: positionToClose ? positionToClose.marketId : state.activeMarket,
    operation: "close",
  });
  renderAccountMode();

  let resultDisplay;
  let notification;
  let notificationIsError = false;

  try {
    const { data, error } = await supabaseClient.rpc(
      isDemo ? "demo_close_position" : "real_test_close_position",
      { p_position_id: id }
    );

    if (error) throw error;
    if (!data || !data.position) throw new Error("The server did not return the closed position.");

    const position = mapPositionRow(data.position);
    const balance = Number(data.balance_after);
    if (!Number.isFinite(balance) || balance < 0) throw new Error("The server returned an invalid balance.");

    if (isDemo) {
      state.balance = balance;
      await loadDemoPositions();
    } else {
      state.realTestBalance = balance;
      await loadRealTestPositions();
      renderPositions();
    }

    resultDisplay = {
      status: "closed",
      side: position.side,
      marketId: position.marketId,
      position,
      outcome: position.outcome,
    };

    renderBalance();

    const market = marketById(position.marketId);
    notification = `Position closed at ${formatExactPrice(market, position.exitPrice)}. P&L: ${position.pnl >= 0 ? "+" : "−"}${money(Math.abs(position.pnl))}.`;
  } catch (error) {
    const message = friendlyTradeError(getErrorMessage(error, "Supabase request failed."));
    resultDisplay = {
      status: "error",
      side: positionToClose ? positionToClose.side : "buy",
      marketId: positionToClose ? positionToClose.marketId : state.activeMarket,
      message,
    };
    notification = `Could not close position: ${message}`;
    notificationIsError = true;
  } finally {
    await waitForMinimumExecutionTime(executionStartedAt);
    state.isSubmittingTrade = false;
    showTradeResult(resultDisplay);
    renderAccountMode();
    toast(notification, notificationIsError);
  }
}

async function updateMarkets() {
  if (!supabaseClient || !state.userId || state.marketQuoteLoading) return;
  state.marketQuoteLoading = true;

  const isDemo = state.accountMode === "demo";

  try {
    const openPositionsBeforeUpdate = new Map(
      (isDemo ? state.positions : state.realTestPositions).map((position) => [position.id, position]),
    );

    const { data, error } = await supabaseClient.rpc(
      isDemo ? "get_demo_market_prices" : "real_test_market_prices",
    );
    if (error) throw error;

    (data || []).forEach((quote) => {
      const market = marketById(quote.market);
      if (!market) return;
      market.price = Number(quote.price);
      market.change = (market.price / market.dayOpen - 1) * 100;
      market.dayHigh = Math.max(market.dayHigh, market.price);
      market.dayLow = Math.min(market.dayLow, market.price);
    });

    if (isDemo) {
      await loadDemoPositions();
      state.balance = await loadDemoBalance();
    } else {
      await loadRealTestPositions();
      state.realTestBalance = await loadRealTestBalance();
      renderPositions();
    }

    const closedNow = isDemo ? state.history : state.realTestHistory;
    const justClosed = Array.from(openPositionsBeforeUpdate.keys())
      .map((id) => closedNow.find((position) => position.id === id))
      .filter(Boolean);

    if (justClosed.length) {
      const position = justClosed[justClosed.length - 1];
      showTradeResult({
        status: "closed",
        side: position.side,
        marketId: position.marketId,
        position,
        outcome: position.outcome,
      });
    } else if (state.tradeDisplay && state.tradeDisplay.status === "open") {
      const openPosition = (isDemo ? state.positions : state.realTestPositions)
        .find((position) => position.id === state.tradeDisplay.position.id);
      if (openPosition) state.tradeDisplay.position = openPosition;
    }

    renderBalance();
    state.quoteErrorNotified = false;
  } catch (error) {
    markets.forEach((market) => {
      const drift = (Math.random() - 0.5) * market.volatility * 1.6;
      market.price = Math.max(0.0001, market.price * (1 + drift));
      market.change = (market.price / market.dayOpen - 1) * 100;
      market.dayHigh = Math.max(market.dayHigh, market.price);
      market.dayLow = Math.min(market.dayLow, market.price);
    });
    if (!state.quoteErrorNotified) {
      toast(`Could not update market prices from server. Showing simulated movement.`, true);
      state.quoteErrorNotified = true;
    }
  } finally {
    state.marketQuoteLoading = false;
  }

  markets.forEach((market) => {
    if (market.id === state.activeMarket && state.candles.length) {
      const candle = state.candles[state.candles.length - 1];
      const interval = getTimeframeInterval();
      if (Date.now() - candle.startedAt >= interval) {
        const nextOpen = candle.close;
        const startedAt = Math.floor(Date.now() / interval) * interval;
        if (state.candleOffset > 0 && state.candles.length < 2000) state.candleOffset += 1;
        state.candles.push({ open: nextOpen, close: market.price, high: Math.max(nextOpen, market.price), low: Math.min(nextOpen, market.price), startedAt });
        if (state.candles.length > 2000) {
          state.candles.shift();
          state.candleOffset = Math.min(state.candleOffset, state.candles.length - 12);
        }
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
  renderTradeResult();
}


async function selectAccountMode(mode) {
  if (mode !== "demo" && mode !== "real") return;

  if (state.isSubmittingTrade) {
    toast("Wait for the current trade request to finish.", true);
    return;
  }

  state.accountMode = mode;
  renderDemoDeposits();
  renderAccountMode();
  renderPositions();

  try {
    if (mode === "demo") {
      state.balance = await loadDemoBalance();
      await loadDemoPositions();
    } else {
      state.realTestBalance = await loadRealTestBalance();
      await Promise.all([loadRealTestTransactions(), loadRealTestPositions()]);
      renderPositions();
    }

    renderAccountMode();
  } catch (error) {
    toast(
      `Could not load account: ${getErrorMessage(error, "Account loading failed.")}`,
      true
    );
  }
}

function fundsActionChoices(isDemo) {
  return isDemo
    ? [["deposit", "Deposit"], ["set", "Set balance"]]
    : [["deposit", "Deposit"], ["withdrawal", "Withdraw"]];
}

function getDepositProviders() {
  const api = window.NexaTradePayments;
  if (!api || typeof api.getDepositProviders !== "function") return [];
  return api.getDepositProviders();
}

function renderFundsProviderOptions() {
  const select = $("#funds-provider");
  if (!select) return;
  const providers = getDepositProviders();
  const options = providers.map((provider) => [provider.id, provider.label || provider.id]);

  select.replaceChildren(...options.map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));

  if (providers.length && !providers.some((provider) => provider.id === select.value)) {
    select.value = providers[0].id;
  }
}

function setFundsCheckoutResult(message, isError) {
  const box = $("#funds-checkout-result");
  if (!message) {
    box.hidden = true;
    box.className = "funds-checkout-result";
    box.textContent = "";
    return;
  }
  box.hidden = false;
  box.className = "funds-checkout-result" + (isError ? " error" : "");
  box.textContent = message;
}

function setFundsCheckoutResultHtml(html, isError) {
  const box = $("#funds-checkout-result");
  if (!html) {
    setFundsCheckoutResult("", false);
    return;
  }
  box.hidden = false;
  box.className = "funds-checkout-result" + (isError ? " error" : "");
  box.innerHTML = html;
}

function openFundsModal(preferredAction) {
  const isDemo = state.accountMode === "demo";

  $("#funds-title").textContent = isDemo
    ? "Deposit demo funds"
    : "Manage account";

  const fundsDescription = isDemo
    ? "Add demo funds for training, or set an exact demo balance. No real money is involved."
    : "";
  $("#funds-description").textContent = fundsDescription;
  $("#funds-description").hidden = !fundsDescription;

  const actionSelect = $("#funds-action");
  actionSelect.replaceChildren(...fundsActionChoices(isDemo).map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));

  if (typeof preferredAction === "string"
    && fundsActionChoices(isDemo).some(([value]) => value === preferredAction)) {
    actionSelect.value = preferredAction;
  }

  renderFundsProviderOptions();
  setFundsCheckoutResult("", false);

  $("#funds-amount-field").hidden = false;
  $("#funds-action-field").hidden = false;

  $("#funds-amount").min = isDemo ? "0" : "0.01";
  $("#funds-amount").step = "0.01";
  $("#funds-amount").value = "1000";

  const withdrawalPhone = $("#funds-withdrawal-phone");
  if (withdrawalPhone) {
    const normalized = normalizeMsisdn(state.userPhone || "");
    withdrawalPhone.value = normalized || (state.userPhone || "");
  }

  $("#confirm-funds").hidden = false;
  $("#confirm-funds").className = "trade-submit buy-submit";
  $("#confirm-funds").disabled = false;

  updateFundsActionButton();

  $("#funds-modal").hidden = false;
  $("#funds-amount").focus();
}

function closeFundsModal() {
  $("#funds-modal").hidden = true;
  setFundsCheckoutResult("", false);
  state.pendingMegapayDeposit = null;
}

function updateFundsActionButton() {
  const isDemo = state.accountMode === "demo";
  const action = $("#funds-action").value;
  const button = $("#confirm-funds");
  const label = document.querySelector("#funds-amount-field label");
  const providerField = $("#funds-provider-field");
  const providerNote = $("#funds-provider-note");
  const providers = getDepositProviders();
  const provider = $("#funds-provider") ? $("#funds-provider").value : "";
  const isRealDeposit = !isDemo && action === "deposit";
  const isRealWithdrawal = !isDemo && action === "withdrawal";
  const usingExternalProvider = isRealDeposit && Boolean(provider);

  const providerDetails = $("#funds-provider-details");
  const withdrawalDetails = $("#funds-withdrawal-details");
  if (providerField) providerField.hidden = !isRealDeposit;
  if (providerDetails) providerDetails.hidden = !usingExternalProvider;
  if (withdrawalDetails) withdrawalDetails.hidden = !isRealWithdrawal;

  if (!isRealDeposit) {
    if (providerNote) providerNote.textContent = "";
  } else if (!providers.length) {
    if (providerNote) providerNote.textContent = "M-Pesa deposits are not configured right now.";
  } else {
    if (providerNote) providerNote.textContent = "Real account deposits use M-Pesa STK push only. Switch to Demo mode for test deposits.";
    const emailInput = $("#funds-email");
    const profileEmail = $("#profile-email") ? $("#profile-email").value.trim() : "";
    const fallbackEmail = profileEmail || state.userEmail || "";
    if (emailInput && !emailInput.value && fallbackEmail.includes("@")) {
      emailInput.value = fallbackEmail;
    }
  }

  if (action === "set") {
    button.innerHTML = 'Set demo balance <span>→</span>';
    if (label) label.textContent = "NEW DEMO BALANCE IN KSH";
    $("#funds-amount").value = Number(state.balance || 0).toFixed(2);
    setFundsCheckoutResult("", false);
    return;
  }

  if (action === "withdrawal") {
    button.innerHTML = 'Withdraw funds <span>→</span>';
    if (label) label.textContent = "AMOUNT IN KSH";
    setFundsCheckoutResult("", false);
    return;
  }

  if (usingExternalProvider) {
    button.innerHTML = 'Continue to payment <span>→</span>';
    if (label) label.textContent = "AMOUNT IN KSH";
  } else {
    button.innerHTML = isDemo
      ? 'Deposit demo funds <span>→</span>'
      : 'Deposit funds <span>→</span>';
    if (label) label.textContent = isDemo ? "DEMO AMOUNT IN KSH" : "AMOUNT IN KSH";
  }
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
  if (view === "Trade") renderChart();
  setNavigationMenuOpen(false);
  window.scrollTo({ top: 0 });
}

function toggleProfileDetails() {
  const details = $("#profile-details");
  details.hidden = !details.hidden;
  $("#profile-button").setAttribute("aria-expanded", String(!details.hidden));
}

function setProfileMessage(message = "", type = "") {
  const element = $("#profile-message");
  if (!element) return;
  element.textContent = message;
  element.classList.remove("error", "success");
  if (type) element.classList.add(type);
}

async function saveProfile(event) {
  if (event) event.preventDefault();
  if (!supabaseClient) {
    setProfileMessage("Supabase is not configured.", "error");
    return;
  }

  const saveButton = $("#profile-save");
  const nameInput = $("#profile-name");
  const emailInput = $("#profile-email");
  const phoneInput = $("#profile-phone");
  const fullName = nameInput ? nameInput.value.trim() : "";
  const email = emailInput ? emailInput.value.trim().toLowerCase() : "";
  const phone = phoneInput ? phoneInput.value.trim() : "";
  const normalizedPhone = phone ? normalizeMsisdn(phone) : "";

  if (!fullName) {
    setProfileMessage("Enter your name.", "error");
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setProfileMessage("Enter a valid email address.", "error");
    return;
  }
  if (phone && !/^0\d{9}$/.test(normalizedPhone)) {
    setProfileMessage("Enter a valid phone number (e.g. 0712345678) or leave it blank.", "error");
    return;
  }

  const payload = { data: { full_name: fullName, phone: normalizedPhone || phone } };
  const emailChanged = email !== (state.userEmail || "").trim().toLowerCase();
  if (emailChanged) payload.email = email;

  if (saveButton) saveButton.disabled = true;
  setProfileMessage("Saving profile...", "");
  try {
    const { data, error } = await supabaseClient.auth.updateUser(payload);
    if (error) throw error;

    state.userName = fullName;
    state.userPhone = normalizedPhone || phone;
    if (emailInput) emailInput.value = email;
    if (phoneInput) phoneInput.value = state.userPhone;
    const avatar = $("#profile-avatar");
    if (avatar) avatar.textContent = fullName.charAt(0).toUpperCase();

    const updatedEmail = data && data.user && data.user.email ? String(data.user.email).toLowerCase() : state.userEmail;
    const confirmationNeeded = emailChanged && updatedEmail !== email;
    if (!confirmationNeeded && updatedEmail) state.userEmail = updatedEmail;
    if (!confirmationNeeded) state.userEmail = email;

    const message = confirmationNeeded
      ? "Profile saved. Check your new email inbox to confirm the email change."
      : "Profile updated.";
    setProfileMessage(message, "success");
    toast(message);
  } catch (error) {
    const message = getErrorMessage(error, "Could not update profile.");
    setProfileMessage(message, "error");
    toast(`Could not update profile: ${message}`, true);
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeMsisdn(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10 && digits.startsWith("0")) return digits;
  if (digits.length === 9 && digits.startsWith("7")) return "0" + digits;
  if (digits.length === 12 && digits.startsWith("254")) return "0" + digits.slice(3);
  return digits;
}

function formatMegapayStatus(raw) {
  if (!raw || typeof raw !== "object") return "Status response received.";
  const status = raw.status || raw.transaction_status || raw.ResultDesc || raw.ResponseDescription || raw.message || raw.description || raw.CustomerMessage;
  const code = raw.ResultCode != null ? (" (code " + raw.ResultCode + ")") : "";
  const receipt = raw.MpesaReceiptNumber || raw.receipt || raw.receipt_number;
  let text = status ? String(status) + code : "Status response received.";
  if (receipt) text += " Receipt: " + receipt + ".";
  return text;
}

async function checkMegapayDepositStatus(button) {
  const pending = state.pendingMegapayDeposit;
  const statusBox = $("#funds-status-result");
  if (!pending) {
    if (statusBox) statusBox.textContent = "No pending M-Pesa payment to check.";
    return;
  }

  const api = window.NexaTradePayments;
  if (!api || typeof api.checkStatus !== "function") {
    if (statusBox) statusBox.textContent = "Payment status check is not available.";
    return;
  }

  button.disabled = true;
  if (statusBox) statusBox.textContent = "Checking payment status...";
  try {
    let accessToken = null;
    try {
      if (supabaseClient && supabaseClient.auth && typeof supabaseClient.auth.getSession === "function") {
        const { data } = await supabaseClient.auth.getSession();
        accessToken = data && data.session ? data.session.access_token : null;
      }
    } catch (_) { accessToken = null; }

    const result = await api.checkStatus(pending.providerId, {
      transactionRequestId: pending.transactionRequestId,
      reference: pending.reference,
      email: pending.email || null,
      accessToken: accessToken,
      apikey: supabaseConfig && supabaseConfig.publishableKey ? supabaseConfig.publishableKey : null,
    });

    if (!result || !result.ok) {
      throw new Error((result && result.error) || "Could not check payment status.");
    }

    const message = result.localTest
      ? (result.message || "Status check: pending.")
      : formatMegapayStatus(result.raw);
    if (statusBox) statusBox.textContent = message + " If payment is successful, balance is credited only by verified server-side processing/webhook.";
    toast("Payment status checked.");

    // Refresh in case a trusted server/webhook already credited the balance.
    if (state.accountMode !== "demo") {
      state.realTestBalance = await loadRealTestBalance();
      renderBalance();
      await loadRealTestTransactions();
    }
  } catch (error) {
    if (statusBox) statusBox.textContent = "Could not check status: " + getErrorMessage(error, "Request failed.");
    toast("Could not check payment status.", true);
  } finally {
    button.disabled = false;
  }
}

async function submitExternalDeposit(amount, providerId) {
  const api = window.NexaTradePayments;
  if (!api || typeof api.createCheckout !== "function") {
    throw new Error("Payment integration is not available. Reload the page and try again.");
  }

  const rawMsisdn = $("#funds-msisdn") ? $("#funds-msisdn").value : "";
  const msisdn = normalizeMsisdn(rawMsisdn);
  if (!/^0\d{9}$/.test(msisdn)) {
    throw new Error("Enter a valid M-Pesa phone number (e.g. 0712345678).");
  }
  const email = $("#funds-email") ? String($("#funds-email").value || "").trim() : "";

  const reference = typeof api.createReference === "function"
    ? api.createReference("MP")
    : ("MP-" + Date.now());

  let accessToken = null;
  try {
    if (supabaseClient && supabaseClient.auth && typeof supabaseClient.auth.getSession === "function") {
      const { data } = await supabaseClient.auth.getSession();
      accessToken = data && data.session ? data.session.access_token : null;
    }
  } catch (_) { accessToken = null; }

  const result = await api.createCheckout(providerId, {
    amount: amount,
    currency: "KES",
    reference: reference,
    msisdn: msisdn,
    email: email || null,
    accessToken: accessToken,
    apikey: supabaseConfig && supabaseConfig.publishableKey ? supabaseConfig.publishableKey : null,
    metadata: {
      userId: state.userId || null,
      accountMode: state.accountMode,
      purpose: "deposit",
    },
  });

  if (!result || !result.ok) {
    throw new Error((result && result.error) || "Could not start the payment checkout.");
  }

  const ref = String(result.reference || reference);
  const transactionRequestId = String(result.transactionRequestId || (result.raw && (result.raw.transaction_request_id || result.raw.CheckoutRequestID || result.raw.MerchantRequestID || result.raw.requestId)) || ref);

  state.pendingMegapayDeposit = {
    providerId: providerId,
    transactionRequestId: transactionRequestId,
    reference: ref,
    email: email || "",
    amount: amount,
  };

  const message = "STK push request sent. Check your phone to enter your PIN and complete payment.";
  setFundsCheckoutResult(message, false);
  toast(message);
}

async function submitDemoFunds() {
  const isDemo = state.accountMode === "demo";
  const action = $("#funds-action").value;
  const amount = Number($("#funds-amount").value);
  const isSet = isDemo && action === "set";
  const minimum = isSet ? 0 : (isDemo || action === "deposit" ? 100 : 0.01);
  const providerId = $("#funds-provider") ? $("#funds-provider").value : "";
  const useExternalProvider = !isDemo && action === "deposit" && providerId && providerId !== "instant";

  setFundsCheckoutResult("", false);

  if (!isDemo && action === "deposit" && !useExternalProvider) {
    toast("Real account deposits use M-Pesa STK push only. Use Demo mode for test deposits.", true);
    return;
  }

  if (!Number.isFinite(amount) || amount < minimum || Math.round(amount * 100) !== amount * 100) {
    toast(
      isSet
        ? "Enter a demo balance of 0 or more with no more than two decimal places."
        : action === "withdrawal"
          ? "Enter a valid withdrawal with no more than two decimal places."
          : `Enter a ${isDemo ? "demo" : "test"} ${action} of at least ${money(minimum)} with no more than two decimal places.`,
      true
    );
    return;
  }

  let withdrawalPhone = "";
  if (!isDemo && action === "withdrawal") {
    withdrawalPhone = normalizeMsisdn($("#funds-withdrawal-phone") ? $("#funds-withdrawal-phone").value : state.userPhone);
    if (!/^0\d{9}$/.test(withdrawalPhone)) {
      toast("Enter a valid phone number for withdrawal (e.g. 0712345678).", true);
      return;
    }
  }

  $("#confirm-funds").disabled = true;
  try {
    if (useExternalProvider) {
      await submitExternalDeposit(amount, providerId);
      // Do not credit balance here: deposits must be credited from a verified
      // server-side webhook/callback. Refresh account data in case it already ran.
      state.realTestBalance = await loadRealTestBalance();
      renderBalance();
      await loadRealTestTransactions();
      return;
    }

    if (!isDemo && action === "withdrawal" && withdrawalPhone) {
      state.userPhone = withdrawalPhone;
      const profilePhoneInput = $("#profile-phone");
      if (profilePhoneInput) profilePhoneInput.value = withdrawalPhone;
      try {
        if (supabaseClient && supabaseClient.auth && typeof supabaseClient.auth.updateUser === "function") {
          await supabaseClient.auth.updateUser({ data: { phone: withdrawalPhone } });
        }
      } catch (_) {
        // Keep withdrawal flow working even if profile phone persistence fails.
      }
    }

    const rpcName = isSet
      ? "demo_set_balance"
      : isDemo
        ? "demo_deposit"
        : action === "withdrawal"
          ? "real_test_withdraw"
          : "real_test_deposit";

    const { error } = await supabaseClient.rpc(
      rpcName,
      isSet ? { p_balance: amount } : { p_amount: amount },
    );

    if (error) throw error;

    // Re-read the authoritative balance and paint it immediately, so a failure
    // in the ledger query can never leave the card showing the old figure.
    // Then refresh the transaction list.
    if (isDemo) {
      state.balance = await loadDemoBalance();
      renderBalance();
      await loadDemoDeposits();
    } else {
      state.realTestBalance = await loadRealTestBalance();
      renderBalance();
      await loadRealTestTransactions();
    }

    closeFundsModal();

    toast(
      isSet
        ? `Demo balance set to ${money(state.balance)}.`
        : isDemo
          ? `${money(amount)} added to your demo balance.`
          : `${money(amount)} ${action === "withdrawal" ? "withdrawn from" : "added to"} your balance.`,
    );
  } catch (error) {
    const message = getErrorMessage(error, "Could not update funds.");
    if (useExternalProvider) setFundsCheckoutResult(message, true);
    toast(`Could not update funds: ${message}`, true);
  } finally {
    $("#confirm-funds").disabled = false;
  }
}


function initialize() {
  generateCandles(activeMarket());
  renderMarketStrip();
  renderWatchlist();
  renderChart();
  renderCandleCountdown();
  renderBalance();
  renderAccountMode();
  renderPositions();
  renderDemoDeposits();
  setSentiment();

  $$(".timeframe").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".timeframe").forEach((item) => item.classList.toggle("active", item === button));
      state.timeframe = button.dataset.timeframe;
      generateCandles(activeMarket());
      renderChart();
      renderCandleCountdown();
    });
  });

  $$(".amount-presets button").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.amount === "max") {
      const affordable = maxAffordableAmount();
      if (affordable < MIN_POSITION) {
        toast(`Your balance is ${money(availableBalance())}. A ${money(MIN_POSITION)} position needs ${money(MIN_POSITION * 1.001)} including the fee, so deposit a little more first.`, true);
        return;
      }
      amountInput.value = affordable.toFixed(2);
    } else {
      amountInput.value = button.dataset.amount;
    }
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
  $("#open-funds").addEventListener("click", () => openFundsModal());
  $("#balance-deposit").addEventListener("click", () => openFundsModal());
  $("#balance-withdraw").addEventListener("click", () => openFundsModal("withdrawal"));
  $("#close-funds").addEventListener("click", closeFundsModal);
  $("#funds-action").addEventListener("change", updateFundsActionButton);
  const fundsProvider = $("#funds-provider");
  if (fundsProvider) fundsProvider.addEventListener("change", updateFundsActionButton);
  $("#funds-modal").addEventListener("click", (event) => {
    if (event.target === $("#funds-modal")) closeFundsModal();
  });
  $("#confirm-funds").addEventListener("click", submitDemoFunds);

  const fundsCheckoutResult = $("#funds-checkout-result");
  if (fundsCheckoutResult) {
    fundsCheckoutResult.addEventListener("click", async (event) => {
      const button = event.target.closest("#funds-check-status");
      if (!button) return;
      event.preventDefault();
      await checkMegapayDepositStatus(button);
    });
  }
  $("#stop-loss-price").addEventListener("input", () => { state.defaultRiskValues = null; });
  $("#take-profit-price").addEventListener("input", () => { state.defaultRiskValues = null; });
  $("#profile-button").addEventListener("click", toggleProfileDetails);
  const profileForm = $("#profile-form");
  if (profileForm) profileForm.addEventListener("submit", saveProfile);
  $$(".theme-option[data-theme-choice]").forEach((button) => {
    button.addEventListener("click", () => setTheme(button.dataset.themeChoice));
  });
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
  $("#notifications-button").addEventListener("click", () => toast("You’re all caught up. Market updates are for demo purposes."));
  $("#help-button").addEventListener("click", () => toast("Demo trades use demo prices and do not reach an exchange."));
  $("#chart-menu").addEventListener("click", () => {
    state.chartStyle = state.chartStyle === "candle" ? "line" : "candle";
    $("#chart-menu").title = state.chartStyle === "candle" ? "Switch to line chart" : "Switch to candlestick chart";
    drawChart();
    toast(`Chart display: ${state.chartStyle === "candle" ? "candlesticks" : "line"}.`);
  });

  $$("[data-chart-control]").forEach((button) => {
    button.addEventListener("click", () => {
      switch (button.dataset.chartControl) {
        case "time-in":
          zoomChartTime(0.8);
          break;
        case "time-out":
          zoomChartTime(1.25);
          break;
        case "price-in":
          zoomChartPrice(1.25);
          break;
        case "price-out":
          zoomChartPrice(0.8);
          break;
        case "reset":
          resetChartViewport();
          break;
      }
    });
  });
  $("#dismiss-trade-result").addEventListener("click", dismissTradeResult);

  chartCanvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = chartCanvas.getBoundingClientRect();
    const anchorX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const anchorY = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const factor = Math.exp(event.deltaY * 0.001);
    if (event.shiftKey || event.ctrlKey) zoomChartPrice(1 / factor, anchorY);
    else zoomChartTime(factor, anchorX);
  }, { passive: false });

  chartCanvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const tip = $("#chart-tooltip");
    const bounds = getChartPriceBounds();
    chartPointerDrag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      candleOffset: state.candleOffset,
      priceOffset: state.priceOffset,
      candleCount: state.visibleCandles,
      priceRange: bounds.max - bounds.min,
    };
    chartCanvas.setPointerCapture(event.pointerId);
    chartCanvas.classList.add("is-dragging");
    tip.style.display = "none";
  });
  chartCanvas.addEventListener("pointermove", (event) => {
    const rect = chartCanvas.getBoundingClientRect();
    if (chartPointerDrag && chartPointerDrag.pointerId === event.pointerId) {
      const maxOffset = Math.max(0, state.candles.length - 12);
      state.candleOffset = Math.max(0, Math.min(
        maxOffset,
        chartPointerDrag.candleOffset
        + Math.round((event.clientX - chartPointerDrag.x) / rect.width * chartPointerDrag.candleCount),
      ));
      state.priceOffset = chartPointerDrag.priceOffset
        - (event.clientY - chartPointerDrag.y) / rect.height * chartPointerDrag.priceRange;
      refreshChartViewport();
      return;
    }

    const visible = getVisibleCandles().candles;
    if (!visible.length) return;
    const fraction = Math.max(0, Math.min(0.999999, (event.clientX - rect.left) / rect.width));
    const candle = visible[Math.floor(fraction * visible.length)];
    const tip = $("#chart-tooltip");
    tip.textContent = `${state.timeframe} · O ${formatExactPrice(activeMarket(), candle.open)} · H ${formatExactPrice(activeMarket(), candle.high)} · L ${formatExactPrice(activeMarket(), candle.low)} · C ${formatExactPrice(activeMarket(), candle.close)}`;
    tip.style.display = "block";
    tip.style.left = `${Math.max(42, Math.min(rect.width - 210, event.clientX - rect.left + 10))}px`;
    tip.style.top = `${Math.max(0, event.clientY - rect.top - 27)}px`;
  });
  const endChartPan = (event) => {
    if (!chartPointerDrag || chartPointerDrag.pointerId !== event.pointerId) return;
    chartPointerDrag = null;
    chartCanvas.classList.remove("is-dragging");
  };
  chartCanvas.addEventListener("pointerup", endChartPan);
  chartCanvas.addEventListener("pointercancel", endChartPan);
  chartCanvas.addEventListener("pointerleave", () => {
    if (!chartPointerDrag) $("#chart-tooltip").style.display = "none";
  });
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
    renderCandleCountdown();
    renderBalance();
    renderPositions();
    renderDemoDeposits();
  }
  if (!state.marketUpdateInterval) state.marketUpdateInterval = window.setInterval(updateMarkets, 3000);
  if (!state.candleTimerInterval) state.candleTimerInterval = window.setInterval(renderCandleCountdown, 1000);
  updateMarkets();
  if (!state.sentimentInterval) state.sentimentInterval = window.setInterval(setSentiment, 9000);
}

function stopDashboard() {
  window.clearInterval(state.marketUpdateInterval);
  window.clearInterval(state.sentimentInterval);
  window.clearInterval(state.candleTimerInterval);
  state.marketUpdateInterval = null;
  state.sentimentInterval = null;
  state.candleTimerInterval = null;
}

function resetUserDemoState() {
  if (state.tradeResultTimeout) window.clearTimeout(state.tradeResultTimeout);
  state.tradeResultTimeout = null;
  state.userId = null;
  state.balance = 10000;
  state.realTestBalance = 0;
  state.realTestTransactions = [];
  state.realTestPositions = [];
  state.realTestHistory = [];
  state.accountMode = "demo";
  state.positions = [];
  state.history = [];
  state.demoDeposits = [];
  state.watchlist = ["XAU", "EUR", "GBP"];
  state.showingHistory = false;
  state.activeMarket = "XAU";
  state.timeframe = "1min";
  state.chartStyle = "candle";
  state.isSubmittingTrade = false;
  state.tradeDisplay = null;
  state.defaultRiskValues = null;
  $("#profile-details").hidden = true;
  $("#profile-button").setAttribute("aria-expanded", "false");
  generateCandles(activeMarket());
  $$(".timeframe").forEach((button) => button.classList.toggle("active", button.dataset.timeframe === state.timeframe));
  $("#trade-result").hidden = true;
}

async function enterDashboard(user) {
  try {
    if (state.userId !== user.id) resetUserDemoState();
    state.userId = user.id;
    const [demoBalance] = await Promise.all([loadDemoBalance(), loadDemoPositions(), loadDemoDeposits()]);
    state.balance = demoBalance;
  } catch (error) {
    const detail = getErrorMessage(error, "Supabase request failed.");
    showAuthError(`Could not load your demo account. Run supabase-demo-accounts.sql in the Supabase SQL Editor, then reload. Details: ${detail}`);
    return false;
  }

  state.userId = user.id;
  const email = user.email || "";
  const name = user.user_metadata && user.user_metadata.full_name
    ? user.user_metadata.full_name
    : email.split("@")[0] || "Trader";
  const rawPhone = user.phone || (user.user_metadata && user.user_metadata.phone) || "";
  state.userPhone = String(rawPhone || "").trim();
  state.userName = name;
  state.userEmail = email;
  $("#auth-password").value = "";
  $("#auth-confirm").value = "";
  const profileName = $("#profile-name");
  const profileEmail = $("#profile-email");
  const profilePhone = $("#profile-phone");
  if (profileName) profileName.value = name;
  if (profileEmail) profileEmail.value = email;
  if (profilePhone) profilePhone.value = state.userPhone;
  const avatar = $("#profile-avatar");
  if (avatar) avatar.textContent = name.charAt(0).toUpperCase();
  setProfileMessage("");
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
  if (state.isSubmittingTrade) {
    toast("Wait for the demo trade request to finish before signing out.");
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
  try {
    initTheme();
    $$(".auth-tab").forEach((button) => button.addEventListener("click", () => setAuthMode(button.dataset.authMode)));
    const authForm = $("#auth-form");
    if (authForm) authForm.addEventListener("submit", submitAuth);
    const signOutButton = $("#sign-out");
    if (signOutButton) signOutButton.addEventListener("click", signOut);
    setAuthMode("signin");
  } catch (error) {
    console.error("Could not initialize auth UI:", error);
  }

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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeAuth);
} else {
  initializeAuth();
}
