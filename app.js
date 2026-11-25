"use strict";

// Demo market data (XAUUSD only).
const markets = [
  { id: "XAU", name: "Gold", symbol: "XAUUSD", price: 4726.40, change: 0.18, dayOpen: 4717.91, dayHigh: 4742.85, dayLow: 4709.30, icon: "Au", iconClass: "xau", color: "#e7c96f", volatility: 0.0007 },
];

const state = {
  activeMarket: "XAU",
  timeframe: "15sec",
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
  watchlist: ["XAU"],
  showingHistory: false,
  candles: [],
  visibleCandles: 72,
  candleOffset: 0,
  priceZoom: 1,
  priceOffset: 0,
  isSubmittingTrade: false,
  isSubmittingTransfer: false,
  tradeDisplay: null,
  tradeResultTimeout: null,
  quoteErrorNotified: false,
  marketQuoteLoading: false,
  initialized: false,
  marketUpdateInterval: null,
  sentimentInterval: null,
  candleTimerInterval: null,
  liveTickInterval: null,
};

markets.forEach((market) => {
  market.dayOpen = market.price / (1 + market.change / 100);
  market.dayHigh = market.price * 1.0097;
  market.dayLow = market.price * 0.9904;
  market.dayVolume = market.dayVolume || 128400;
});

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const marketById = (id) => markets.find((market) => market.id === id);
const activeMarket = () => marketById(state.activeMarket);
const amountInput = $("#trade-amount");
const compactCurrency = new Intl.NumberFormat("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timeframeDurations = {
  "15sec": 15_000,
  "30sec": 30_000,
  "1min": 60_000
};
const supabaseConfig = window.NEXATRADE_SUPABASE_CONFIG || {};
let supabaseClient = null;
let supabaseSetupError = "";

let chartCanvas = null;
let chartCtx = null;
let chartResizeObserver = null;
let chartRefreshTimer = null;
let chartNeedsRedraw = true;
let chartPointer = { down: false, x: 0, y: 0, offset: 0, priceOffset: 0, moved: false };
const chartActivePointers = new Map();
let chartPinchState = null;

function getChartContainer() {
  return $("#index-chart")?.parentElement || $(".im-chart-wrap") || $(".chart-container");
}

function getChartCanvas() {
  return $("#index-chart");
}

function resizeChartCanvas() {
  const canvas = getChartCanvas();
  const container = getChartContainer();
  if (!canvas || !container) return null;
  const width = Math.max(320, Math.floor(container.clientWidth || 600));
  const height = Math.max(220, Math.floor(container.clientHeight || 390));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const pixelWidth = Math.floor(width * dpr);
  const pixelHeight = Math.floor(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  chartCanvas = canvas;
  chartCtx = ctx;
  return { canvas, ctx, width, height, dpr };
}

function refreshChartDisplay() {
  chartNeedsRedraw = true;
  drawChart();
}

function scheduleChartRefresh(delay = 60) {
  if (chartRefreshTimer) clearTimeout(chartRefreshTimer);
  chartRefreshTimer = setTimeout(() => {
    chartRefreshTimer = null;
    try { refreshChartDisplay(); } catch (_) { }
  }, delay);
}

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

function formatChartAxisPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  const abs = Math.abs(number);
  const digits = abs >= 1000 ? 2 : abs >= 10 ? 2 : abs >= 1 ? 4 : 6;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(number);
}

function formatChartTimeLabel(startedAt, includeSeconds = true) {
  const date = new Date(Number(startedAt));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
    hour12: false,
  });
}

function getChartReferencePrice(market) {
  const candidates = [];
  const pushValue = (value) => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) candidates.push(n);
  };

  (state.candles || []).slice(-40).forEach((candle) => {
    if (!candle) return;
    pushValue(candle.open);
    pushValue(candle.high);
    pushValue(candle.low);
    pushValue(candle.close);
  });

  if (candidates.length) {
    const sorted = [...candidates].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const inliers = candidates.filter((value) => value >= median / 4 && value <= median * 4);
    const pool = inliers.length ? inliers : candidates;
    const poolSorted = [...pool].sort((a, b) => a - b);
    const ref = poolSorted[Math.floor(poolSorted.length / 2)];
    const dayOpen = Number(market?.dayOpen);
    if (Number.isFinite(dayOpen) && dayOpen > 0 && (ref > dayOpen * 5 || ref < dayOpen / 5)) {
      return dayOpen;
    }
    if (Number.isFinite(ref) && ref > 0) return ref;
  }

  const dayOpen = Number(market?.dayOpen);
  if (Number.isFinite(dayOpen) && dayOpen > 0) return dayOpen;
  const price = Number(market?.price);
  if (Number.isFinite(price) && price > 0 && price < 100000) return price;
  return 4726.4;
}

function isPlausibleMarketPrice(price, reference) {
  const n = Number(price);
  const ref = Number(reference);
  return Number.isFinite(n) && n > 0 && Number.isFinite(ref) && ref > 0 && n >= ref / 4 && n <= ref * 4;
}

function sanitizeMarketPrice(price, market, reference = getChartReferencePrice(market)) {
  const n = Number(price);
  if (isPlausibleMarketPrice(n, reference)) return n;
  return reference;
}

function repairMarketChartState(market = activeMarket()) {
  if (!market) return getChartReferencePrice(market);
  const reference = getChartReferencePrice(market);
  let lastSaneClose = reference;

  (state.candles || []).forEach((candle) => {
    if (!candle) return;
    const raw = [candle.open, candle.high, candle.low, candle.close].map((value) => Number(value));
    const finite = raw.filter((value) => Number.isFinite(value) && value > 0);
    const pool = finite.filter((value) => isPlausibleMarketPrice(value, reference));
    const base = pool.length ? pool[pool.length - 1] : lastSaneClose;
    const open = isPlausibleMarketPrice(candle.open, reference) ? Number(candle.open) : base;
    const close = isPlausibleMarketPrice(candle.close, reference) ? Number(candle.close) : open;
    let high = isPlausibleMarketPrice(candle.high, reference) ? Number(candle.high) : Math.max(open, close);
    let low = isPlausibleMarketPrice(candle.low, reference) ? Number(candle.low) : Math.min(open, close);
    high = Math.max(high, open, close);
    low = Math.min(low, open, close);
    candle.open = open;
    candle.high = high;
    candle.low = Math.max(0.0001, low);
    candle.close = close;
    lastSaneClose = close;
  });

  market.price = sanitizeMarketPrice(market.price, market, lastSaneClose || reference);
  const dayOpen = Number(market.dayOpen);
  if (!Number.isFinite(dayOpen) || dayOpen <= 0 || !isPlausibleMarketPrice(dayOpen, reference)) {
    market.dayOpen = reference / (1 + (Number(market.change) || 0) / 100);
  }
  if (!isPlausibleMarketPrice(market.dayHigh, reference)) {
    market.dayHigh = market.price;
  }
  if (!isPlausibleMarketPrice(market.dayLow, reference)) {
    market.dayLow = market.price;
  }
  market.dayHigh = Math.max(market.dayHigh, market.price);
  market.dayLow = Math.min(market.dayLow, market.price);
  market.change = (market.price / Math.max(0.0001, market.dayOpen) - 1) * 100;
  return market.price;
}

function getVisibleChartSlice() {
  const candles = state.candles || [];
  const total = candles.length;
  if (!total) return { candles: [], start: 0, end: 0 };
  const count = Math.max(12, Math.min(total, Math.round(state.visibleCandles || 48)));
  const maxOffset = Math.max(0, total - count);
  state.candleOffset = Math.max(0, Math.min(maxOffset, Math.round(state.candleOffset || 0)));
  const end = total - state.candleOffset;
  const start = Math.max(0, end - count);
  return { candles: candles.slice(start, end), start, end };
}

function getChartPriceBounds(visibleCandles) {
  const market = activeMarket();
  const values = [];
  (visibleCandles || []).forEach((c) => {
    if (!c) return;
    [c.open, c.high, c.low, c.close].forEach((v) => {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) values.push(n);
    });
  });
  if (!values.length) {
    const price = Number(market?.price) || 1;
    const high = price * 1.001;
    const low = price * 0.999;
    const span = (high - low) / Math.max(0.4, state.priceZoom || 1);
    const mid = ((high + low) / 2) + (state.priceOffset || 0) * span;
    const padded = span * 0.12;
    return { min: mid - span / 2 - padded, max: mid + span / 2 + padded };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const minRef = median / 4;
  const maxRef = median * 4;
  let filtered = values.filter((v) => v >= minRef && v <= maxRef);
  if (!filtered.length) filtered = values;

  let high = -Infinity;
  let low = Infinity;
  filtered.forEach((v) => {
    if (v > high) high = v;
    if (v < low) low = v;
  });

  if (!Number.isFinite(high) || !Number.isFinite(low)) {
    const price = Number(market?.price) || 1;
    high = price * 1.001;
    low = price * 0.999;
  }
  if (high <= low) high = low + Math.max(Math.abs(low) * 0.0002, 0.01);
  const span = (high - low) / Math.max(0.4, state.priceZoom || 1);
  const mid = ((high + low) / 2) + (state.priceOffset || 0) * span;
  const padded = span * 0.12;
  return { min: mid - span / 2 - padded, max: mid + span / 2 + padded };
}

function ensureChart() {
  const setup = resizeChartCanvas();
  if (!setup) return null;
  if (!chartResizeObserver && typeof ResizeObserver !== "undefined") {
    const container = getChartContainer();
    if (container) {
      chartResizeObserver = new ResizeObserver(() => scheduleChartRefresh(40));
      chartResizeObserver.observe(container);
    }
  }
  const canvas = getChartCanvas();
  if (canvas && !canvas.dataset.imChartBound) {
    canvas.dataset.imChartBound = "1";
    const getPinchDistance = (points) => {
      if (points.length < 2) return 0;
      const dx = points[0].x - points[1].x;
      const dy = points[0].y - points[1].y;
      return Math.hypot(dx, dy);
    };

    canvas.addEventListener("pointerdown", (event) => {
      chartActivePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      try { canvas.setPointerCapture(event.pointerId); } catch (_) { }
      const points = Array.from(chartActivePointers.values());
      if (points.length >= 2) {
        chartPinchState = {
          distance: getPinchDistance(points),
          visibleCandles: state.visibleCandles || 72,
          priceZoom: state.priceZoom || 1,
        };
        chartPointer.down = false;
      } else {
        chartPinchState = null;
        chartPointer.down = true;
        chartPointer.moved = false;
        chartPointer.x = event.clientX;
        chartPointer.y = event.clientY;
        chartPointer.offset = state.candleOffset || 0;
        chartPointer.priceOffset = state.priceOffset || 0;
      }
    });

    canvas.addEventListener("pointermove", (event) => {
      if (!chartActivePointers.has(event.pointerId)) return;
      chartActivePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = Array.from(chartActivePointers.values());

      if (points.length >= 2) {
        const distance = getPinchDistance(points);
        if (!chartPinchState || !chartPinchState.distance) {
          chartPinchState = {
            distance: distance || 1,
            visibleCandles: state.visibleCandles || 72,
            priceZoom: state.priceZoom || 1,
          };
          return;
        }
        const ratio = distance / chartPinchState.distance;
        if (Number.isFinite(ratio) && ratio > 0) {
          const total = (state.candles || []).length || 300;
          const nextVisible = Math.max(20, Math.min(total, Math.round(chartPinchState.visibleCandles / ratio)));
          state.visibleCandles = nextVisible;
          drawChart();
        }
        return;
      }

      if (!chartPointer.down) return;
      const dx = event.clientX - chartPointer.x;
      const dy = event.clientY - chartPointer.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) chartPointer.moved = true;
      const { candles } = getVisibleChartSlice();
      const barWidth = Math.max(6, (canvas.clientWidth - 78) / Math.max(1, candles.length || state.visibleCandles || 48));
      const deltaBars = Math.round(dx / barWidth);
      state.candleOffset = Math.max(0, chartPointer.offset + deltaBars);
      const plotH = Math.max(20, (canvas.clientHeight || 0) - 24);
      state.priceOffset = Math.max(-6, Math.min(6, (chartPointer.priceOffset || 0) + (dy / Math.max(plotH, 1))));
      drawChart();
    });

    const endPointer = (event) => {
      chartActivePointers.delete(event.pointerId);
      try { canvas.releasePointerCapture(event.pointerId); } catch (_) { }
      const points = Array.from(chartActivePointers.values());
      if (points.length >= 2) {
        chartPinchState = {
          distance: getPinchDistance(points),
          visibleCandles: state.visibleCandles || 72,
          priceZoom: state.priceZoom || 1,
        };
        chartPointer.down = false;
        return;
      }
      chartPinchState = null;
      if (points.length === 1) {
        chartPointer.down = true;
        chartPointer.moved = false;
        chartPointer.x = points[0].x;
        chartPointer.y = points[0].y;
        chartPointer.offset = state.candleOffset || 0;
        chartPointer.priceOffset = state.priceOffset || 0;
      } else {
        chartPointer.down = false;
      }
    };

    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
    canvas.addEventListener("pointerleave", (event) => {
      if (event.pointerId != null) chartActivePointers.delete(event.pointerId);
      if (chartActivePointers.size === 0) {
        chartPointer.down = false;
        chartPinchState = null;
      }
    });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const direction = event.deltaY < 0 ? 1 : -1;
      if (event.shiftKey) {
        zoomChartPrice(direction);
      } else {
        zoomChartTime(direction);
      }
    }, { passive: false });
  }
  return setup;
}

function setChartData() {
  chartNeedsRedraw = true;
  drawChart();
}

function updateChartLastCandle() {
  chartNeedsRedraw = true;
  drawChart();
}

function refreshChartViewport() {
  chartNeedsRedraw = true;
  drawChart();
}

function zoomChartTime(direction = 1) {
  const dir = Number(direction) >= 0 ? 1 : -1;
  const factor = dir > 0 ? 0.9 : 1.111;
  state.visibleCandles = Math.max(12, Math.min(240, Math.round((state.visibleCandles || 48) * factor)));
  drawChart();
}

function zoomChartPrice(direction = 1) {
  const dir = Number(direction) >= 0 ? 1 : -1;
  state.priceZoom = Math.max(0.5, Math.min(8, (state.priceZoom || 1) * (dir > 0 ? 1.18 : 0.86)));
  drawChart();
}

function resetChartViewport() {
  state.visibleCandles = 48;
  state.candleOffset = 0;
  state.priceZoom = 1;
  state.priceOffset = 0;
  drawChart();
}

function drawChart() {
  const setup = ensureChart();
  if (!setup) return;
  const { ctx, width, height } = setup;
  const { candles } = getVisibleChartSlice();
  const market = activeMarket();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#080e18";
  ctx.fillRect(0, 0, width, height);

  const left = 6;
  const right = 60;
  const top = 6;
  const bottom = 18;
  const plotW = Math.max(20, width - left - right);
  const plotH = Math.max(20, height - top - bottom);
  if (!candles.length) {
    ctx.fillStyle = "#8e9db2";
    ctx.font = '10px "IBM Plex Sans", sans-serif';
    ctx.fillText("Waiting for feed…", 12, 20);
    return;
  }

  const bounds = getChartPriceBounds(candles);
  const priceToY = (price) => top + ((bounds.max - price) / Math.max(bounds.max - bounds.min, 0.000001)) * plotH;
  const slot = plotW / candles.length;
  const bodyW = Math.max(4, Math.min(18, slot * 0.72));

  // grid
  ctx.strokeStyle = "rgba(42, 58, 77, 0.55)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#b8cadb";
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i += 1) {
    const y = top + (plotH / yTicks) * i;
    const price = bounds.max - ((bounds.max - bounds.min) / yTicks) * i;
    ctx.beginPath();
    ctx.moveTo(left, Math.round(y) + 0.5);
    ctx.lineTo(left + plotW, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.fillText(formatChartAxisPrice(price), width - 3, y);
  }
  const xTicks = Math.min(6, Math.max(2, Math.floor(candles.length / 12)));
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = '9px "IBM Plex Mono", monospace';
  for (let i = 0; i <= xTicks; i += 1) {
    const idx = Math.min(candles.length - 1, Math.floor((candles.length - 1) * (i / xTicks)));
    const c = candles[idx];
    const x = left + idx * slot + slot / 2;
    ctx.beginPath();
    ctx.strokeStyle = "rgba(42, 58, 77, 0.35)";
    ctx.moveTo(Math.round(x) + 0.5, top);
    ctx.lineTo(Math.round(x) + 0.5, top + plotH);
    ctx.stroke();
    ctx.fillStyle = "#9eb3c7";
    ctx.fillText(formatChartTimeLabel(c.startedAt, true), x, top + plotH + 4);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, plotW, plotH);
  ctx.clip();

  // candles
  candles.forEach((candle, index) => {
    if (!candle) return;
    const o = Number(candle.open);
    const c = Number(candle.close);
    const h = Number(candle.high);
    const l = Number(candle.low);
    if (![o, c, h, l].every(Number.isFinite)) return;
    const x = left + index * slot + slot / 2;
    const openY = priceToY(o);
    const closeY = priceToY(c);
    const highY = priceToY(h);
    const lowY = priceToY(l);
    const up = c >= o;
    const color = up ? "#17e66a" : "#ff4b52";
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(1.5, Math.abs(closeY - openY));

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, Math.round(highY));
    ctx.lineTo(Math.round(x) + 0.5, Math.round(lowY));
    ctx.stroke();

    ctx.fillRect(Math.round(x - bodyW / 2), Math.round(bodyTop), Math.max(1, Math.round(bodyW)), Math.max(1, Math.round(bodyHeight)));
  });

  // current price line/label
  const last = candles[candles.length - 1];
  const rawCurrent = market ? Number(market.price) : Number(last?.close);
  const current = Number.isFinite(rawCurrent) ? rawCurrent : Number(last?.close) || 0;
  const y = Math.max(top + 6, Math.min(top + plotH - 6, priceToY(current)));
  const upNow = current >= Number(last?.open || current);
  const lineColor = upNow ? "#17e66a" : "#ff4b52";
  ctx.strokeStyle = lineColor;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(left + plotW, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  const label = formatChartAxisPrice(current);
  ctx.font = 'bold 10px "IBM Plex Mono", monospace';
  const labelW = Math.ceil(ctx.measureText(label).width) + 10;
  const labelX = width - right + 1;
  ctx.fillStyle = lineColor;
  ctx.fillRect(labelX, y - 9, labelW, 18);
  ctx.fillStyle = "#04150d";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, labelX + 5, y);

  const overlay = $("#chart-y-axis-label");
  if (overlay) {
    overlay.textContent = "";
    overlay.style.display = "none";
  }
  chartNeedsRedraw = false;
}

const THEME_KEY = "nexatrade-theme";

function getSavedTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function applyTheme(theme) {
  const resolvedTheme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = resolvedTheme;
  const metaTheme = $("#meta-theme-color");
  if (metaTheme) metaTheme.setAttribute("content", resolvedTheme === "light" ? "#f4f7fb" : "#090d12");
  $$(".theme-option").forEach((button) => {
    button.classList.toggle("active", button.dataset.themeChoice === resolvedTheme);
  });
  try { drawChart(); } catch (_) { }
}

function setTheme(theme) {
  const resolvedTheme = theme === "light" ? "light" : "dark";
  applyTheme(resolvedTheme);
  try {
    localStorage.setItem(THEME_KEY, resolvedTheme);
  } catch {
    // Ignore storage failures.
  }
}

function initTheme() {
  setTheme(getSavedTheme() || document.documentElement.dataset.theme || "dark");
}


function generateCandles(market) {
  const candles = [];
  const interval = getTimeframeInterval();
  const historyCount = 300;
  const baseVol = Math.max(0.00004, (market.volatility || 0.0007) * (interval === 15000 ? 0.28 : 0.45));

  let close = market.price * (1 + (Math.random() - 0.5) * baseVol * 6);
  const lastIntervalStart = Math.floor(Date.now() / interval) * interval;

  for (let index = 0; index < historyCount; index += 1) {
    const open = close;
    const drift = (market.dayOpen - open) / Math.max(market.dayOpen, 0.0001) * 0.02;
    const impulse = (Math.random() - 0.5) * baseVol * 0.9;
    const trend = ((market.change || 0) / 100) * 0.012 * baseVol;
    close = Math.max(0.0001, open * (1 + impulse + trend + drift));

    if (index === historyCount - 1) {
      close = market.price;
    }

    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);
    const body = Math.max(Math.abs(open - close), market.price * baseVol * 0.12);
    const maxWick = Math.max(body * 0.18, market.price * baseVol * 0.06);
    const wickUp = Math.min(maxWick, body * (0.03 + Math.random() * 0.1) + market.price * baseVol * (0.005 + Math.random() * 0.02));
    const wickDown = Math.min(maxWick, body * (0.03 + Math.random() * 0.1) + market.price * baseVol * (0.005 + Math.random() * 0.02));

    candles.push({
      open,
      close,
      high: bodyHigh + wickUp,
      low: Math.max(0.0001, bodyLow - wickDown),
      startedAt: lastIntervalStart - (historyCount - 1 - index) * interval,
    });
  }

  const last = candles[candles.length - 1];
  last.close = market.price;
  last.high = Math.max(last.high, market.price, last.open);
  last.low = Math.min(last.low, market.price, last.open);

  state.candles = candles;
  state.visibleCandles = Math.min(48, candles.length);
  state.candleOffset = 0;
  state.priceZoom = 1;
  state.priceOffset = 0;
  if (!Number.isFinite(market.dayVolume)) market.dayVolume = 128400 + Math.random() * 9000;
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
  const market = marketById("XAU") || markets[0];
  if (market) {
    const priceEl = $("#xau-price");
    const changeEl = $("#xau-change");
    if (priceEl) priceEl.textContent = formatExactPrice(market, market.price);
    if (changeEl) {
      changeEl.textContent = formatChange(market.change);
      changeEl.className = `change ${market.change >= 0 ? "positive" : "negative"}`;
    }
  }
  const lastUpdated = $("#last-updated");
  if (lastUpdated) lastUpdated.textContent = "just now";
}


function renderChartLabels() {
  // Custom canvas chart renders its own axes.
}

function renderCandleCountdown() {
  const candle = state.candles[state.candles.length - 1];
  const countdown = $("#candle-countdown");
  const feed = $("#chart-feed-status");
  if (!candle) {
    if (countdown) countdown.textContent = "NEXT CANDLE IN --:--";
    if (feed) {
      feed.textContent = "WAITING FOR FEED";
      feed.classList.remove("live");
    }
    return;
  }
  const remainingMs = Math.max(0, candle.startedAt + getTimeframeInterval() - Date.now());
  const remaining = Math.ceil(remainingMs / 1000);
  const minutes = String(Math.floor(remaining / 60)).padStart(2, "0");
  const seconds = String(remaining % 60).padStart(2, "0");
  if (countdown) countdown.textContent = `NEXT CANDLE IN ${minutes}:${seconds}`;
  if (feed) {
    feed.textContent = "LIVE FEED";
    feed.classList.add("live");
  }
}

function syncActiveMarketCandle(price) {
  if (!state.candles.length) return;
  const market = activeMarket();
  if (!market) return;
  const interval = Number(getTimeframeInterval());
  if (!Number.isFinite(interval) || interval <= 0) return;

  const reference = getChartReferencePrice(market);
  const safePrice = sanitizeMarketPrice(price, market, reference);
  if (!Number.isFinite(safePrice) || safePrice <= 0) return;

  let candle = state.candles[state.candles.length - 1];
  if (!candle) return;

  let guard = 0;
  while (Date.now() >= candle.startedAt + interval && guard < 500) {
    const nextOpen = sanitizeMarketPrice(candle.close, market, reference);
    const startedAt = candle.startedAt + interval;
    candle = {
      open: nextOpen,
      close: nextOpen,
      high: nextOpen,
      low: nextOpen,
      startedAt,
    };
    state.candles.push(candle);
    if (state.candles.length > 2000) {
      state.candles.shift();
    }
    guard += 1;
  }

  // Smooth price movement during candle formation to avoid sudden spikes.
  const prevClose = Number(candle.close);
  const smoothBase = Number.isFinite(prevClose) && prevClose > 0 ? prevClose : (Number(candle.open) || safePrice);
  const maxStep = Math.max(smoothBase * 0.00045, safePrice * 0.00012);
  const formedPrice = sanitizeMarketPrice(
    smoothBase + Math.max(-maxStep, Math.min(maxStep, safePrice - smoothBase)),
    market,
    reference
  );

  candle.close = formedPrice;
  const open = Number(candle.open) || formedPrice;
  const bodyHigh = Math.max(open, formedPrice);
  const bodyLow = Math.min(open, formedPrice);
  const body = Math.max(Math.abs(open - formedPrice), formedPrice * 0.00003);
  const wickCap = Math.max(body * 0.12, formedPrice * 0.00006);
  candle.high = Math.min(Math.max(Number(candle.high) || bodyHigh, bodyHigh), bodyHigh + wickCap);
  candle.low = Math.max(Math.min(Number(candle.low) || bodyLow, bodyLow), Math.max(0.0001, bodyLow - wickCap));
  market.price = formedPrice;
  if (!isPlausibleMarketPrice(market.dayOpen, reference)) {
    market.dayOpen = reference;
  }
  if (!isPlausibleMarketPrice(market.dayHigh, reference)) market.dayHigh = formedPrice;
  if (!isPlausibleMarketPrice(market.dayLow, reference)) market.dayLow = formedPrice;
  market.dayHigh = Math.max(market.dayHigh, formedPrice);
  market.dayLow = Math.min(market.dayLow, formedPrice);
  market.change = (market.price / Math.max(0.0001, market.dayOpen) - 1) * 100;
}

function tickLiveChart() {
  if (!state.initialized || !state.candles.length) return;
  const market = activeMarket();
  if (!market) return;

  repairMarketChartState(market);
  const last = state.candles[state.candles.length - 1];
  if (!last) return;
  const interval = getTimeframeInterval();
  const progress = interval > 0 ? Math.max(0, Math.min(1, (Date.now() - last.startedAt) / interval)) : 0;
  const baseVol = Math.max(0.00002, (market.volatility || 0.0007) * 0.16);
  const noise = (Math.random() - 0.5) * baseVol;
  const pulse = Math.sin(Date.now() / 2400) * baseVol * 0.08;
  const revert = ((market.dayOpen - market.price) / Math.max(market.dayOpen, 0.0001)) * 0.008 * baseVol;
  const momentum = ((Number(last.close) - Number(last.open)) / Math.max(Number(last.open) || market.price, 0.0001)) * 0.05 * baseVol;
  const delta = Math.max(-baseVol * 0.55, Math.min(baseVol * 0.55, noise + pulse + revert + momentum));
  const reference = getChartReferencePrice(market);
  const basePrice = sanitizeMarketPrice(market.price, market, reference);
  const nextPrice = sanitizeMarketPrice(basePrice * (1 + delta), market, reference);

  syncActiveMarketCandle(nextPrice);
  market.dayVolume = (market.dayVolume || 128400) + Math.round(20 + Math.random() * 140 + progress * 30);

  renderCandleCountdown();
  renderMarketStrip();
  renderWatchlist();

  const chartPrice = $("#chart-price");
  const chartChange = $("#chart-change");
  const chartHigh = $("#chart-high");
  const chartLow = $("#chart-low");
  const chartVolume = $("#chart-volume");
  const orderPrice = $("#order-market-price");
  const displayPrice = sanitizeMarketPrice(market.price, market, reference);
  const changePct = Number(market.change || 0);
  if (chartPrice) {
    chartPrice.textContent = formatExactPrice(market, displayPrice);
    chartPrice.classList.toggle("down", changePct < 0);
  }
  if (chartChange) {
    chartChange.textContent = `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;
    chartChange.className = `im-change chart-price-change ${changePct >= 0 ? "positive" : "negative"}`;
  }
  if (chartHigh) chartHigh.textContent = formatExactPrice(market, Math.max(Number(market.dayHigh) || displayPrice, displayPrice));
  if (chartLow) chartLow.textContent = formatExactPrice(market, Math.min(Number(market.dayLow) || displayPrice, displayPrice));
  if (chartVolume) {
    const vol = market.dayVolume || 0;
    const label = vol >= 1000 ? `${(vol / 1000).toFixed(1)}K oz` : `${Math.round(vol)} oz`;
    chartVolume.textContent = label;
  }
  if (orderPrice) orderPrice.textContent = formatExactPrice(market, market.price);
  updateOrderEstimate();
  updateChartLastCandle();
}

function renderChart() {
  const market = activeMarket();
  if (!market) return;

  const chartMarketName = $("#chart-market-name");
  const marketSelect = $("#market-select");
  const selectedCoinIcon = $("#selected-coin-icon");
  const chartPrice = $("#chart-price");
  const chartChange = $("#chart-change");
  const chartHigh = $("#chart-high");
  const chartLow = $("#chart-low");
  const chartVolume = $("#chart-volume");
  const intervalLabel = $("#chart-interval-label");
  const feedStatus = $("#chart-feed-status");
  const orderCoin = $("#order-coin");
  const orderMarketName = $("#order-market-name");
  const orderMarketPrice = $("#order-market-price");
  const sentimentSymbol = $(".sentiment-heading > span");
  const buyButton = $("#buy-trade");
  const sellButton = $("#sell-trade");
  const favoriteButton = $("#favorite-button");

  if (chartMarketName) chartMarketName.textContent = market.name;
  if (marketSelect) marketSelect.value = market.id;
  if (selectedCoinIcon) {
    selectedCoinIcon.textContent = market.icon;
    selectedCoinIcon.style.color = market.color;
    selectedCoinIcon.style.background = `${market.color}24`;
  }

  repairMarketChartState(market);
  const reference = getChartReferencePrice(market);
  const displayPrice = sanitizeMarketPrice(market.price, market, reference);
  const changePct = Number(market.change || 0);
  if (chartPrice) {
    chartPrice.textContent = formatExactPrice(market, displayPrice);
    chartPrice.classList.toggle("down", changePct < 0);
  }
  if (chartChange) {
    chartChange.textContent = `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;
    chartChange.className = `im-change chart-price-change ${changePct >= 0 ? "positive" : "negative"}`;
  }
  if (chartHigh) chartHigh.textContent = formatExactPrice(market, Math.max(Number(market.dayHigh) || displayPrice, displayPrice));
  if (chartLow) chartLow.textContent = formatExactPrice(market, Math.min(Number(market.dayLow) || displayPrice, displayPrice));
  if (chartVolume) {
    const vol = Number(market.dayVolume || 128400);
    chartVolume.textContent = vol >= 1000 ? `${(vol / 1000).toFixed(1)}K oz` : `${Math.round(vol)} oz`;
  }
  if (intervalLabel) intervalLabel.textContent = "15s";
  if (feedStatus) {
    feedStatus.textContent = state.initialized ? "LIVE FEED" : "CONNECTING FEED";
    feedStatus.classList.toggle("live", !!state.initialized);
  }

  if (orderCoin) {
    orderCoin.textContent = market.icon;
    orderCoin.style.color = market.color;
    orderCoin.style.background = `${market.color}24`;
  }
  if (orderMarketName) orderMarketName.textContent = "";
  if (orderMarketPrice) orderMarketPrice.textContent = formatExactPrice(market, displayPrice);
  if (sentimentSymbol) sentimentSymbol.textContent = market.symbol;
  if (buyButton) {
    if (buyButton.dataset.market !== market.id) buyButton.innerHTML = `Buy ${market.symbol} <span>↗</span>`;
    buyButton.dataset.market = market.id;
  }
  if (sellButton) {
    if (sellButton.dataset.market !== market.id) sellButton.innerHTML = `Sell ${market.symbol} <span>↘</span>`;
    sellButton.dataset.market = market.id;
  }
  if (favoriteButton) {
    favoriteButton.classList.toggle("active", state.watchlist.includes(market.id));
    favoriteButton.textContent = state.watchlist.includes(market.id) ? "★" : "☆";
  }

  updateOrderEstimate();
  ensureChart();
  drawChart();
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


  $$("#trade-amount").forEach((field) => {
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

function getAutomaticTradeLevels(side, market) {
  const factor = side === "buy" ? 10 : 0.1;
  const stopLoss = side === "buy" ? Math.max(0.0001, market.price * 0.5) : market.price * 2;
  const takeProfit = side === "buy" ? market.price * factor : Math.max(0.0001, market.price * 0.5);
  return { stopLoss, takeProfit };
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
  state.realTestBalance = balance;
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
    .select("id,transaction_type,amount,balance_after,counterparty_email,created_at")
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
    const transactionType = isDemo ? "deposit" : record.transaction_type;
    const isTransfer = transactionType === "transfer_sent" || transactionType === "transfer_received";

    transaction.textContent = isDemo
      ? "Demo deposit"
      : transactionType === "withdrawal"
        ? "Withdrawal"
        : transactionType === "transfer_sent"
          ? `Transfer to ${record.counterparty_email || "NexaTrade user"}`
          : transactionType === "transfer_received"
            ? `Transfer from ${record.counterparty_email || "NexaTrade user"}`
            : "Deposit";

    const amount = document.createElement("td");
    const prefix = transactionType === "withdrawal" || transactionType === "transfer_sent" ? "-" : "+";
    amount.textContent = `${prefix}${money(Number(record.amount))}`;

    const balance = document.createElement("td");
    balance.textContent = money(Number(record.balance_after));

    const type = document.createElement("td");
    type.textContent = isTransfer ? "Internal transfer" : transactionType === "withdrawal" ? "Withdrawal" : "Deposit";

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
  const notice = $("#result-notice-message");
  const tag = $("#result-tag");
  const amount = $("#result-outcome-amount");

  const isPending = Boolean(display && display.status === "pending");
  panel.hidden = !display || isPending;
  $("#result-executing").hidden = !isPending;

  if (notice) {
    notice.hidden = true;
    notice.textContent = "";
  }
  if (tag) tag.hidden = true;
  if (amount) amount.hidden = true;

  if (!display || isPending) return;

  $("#dismiss-trade-result").hidden = false;

  if (display.kind === "notice") {
    const tone = display.tone === "error" ? "is-error" : "is-win";
    panel.className = `trade-result is-notice ${tone}`;
    $("#result-status").textContent = display.title || "Notice";
    if (notice) {
      notice.textContent = display.message || "";
      notice.hidden = !display.message;
    }
    return;
  }

  const isOpen = Boolean(display.status === "open");
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

  $("#result-status").textContent = isClosed
    ? pnl > 0
      ? `TRADE CLOSED · WIN ×${multiplier}`
      : pnl < 0
        ? "TRADE CLOSED · LOSS"
        : "TRADE CLOSED · BREAK EVEN"
    : isLive
      ? "POSITION OPEN · LIVE P&L"
      : "TRADE NOT EXECUTED";

  if (amount) {
    amount.hidden = !isClosed && !isLive;
    if (isClosed || isLive) {
      amount.textContent = `${pnl > 0 ? "+" : pnl < 0 ? "−" : ""}${money(Math.abs(pnl))}`;
    }
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
  resetAiScanSignal();
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

  const { stopLoss, takeProfit } = getAutomaticTradeLevels(side, market);

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

      notification = `Trade ${position.outcome.toUpperCase()}: ${position.pnl >= 0 ? "+" : "−"
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
      const reference = getChartReferencePrice(market);
      const safePrice = sanitizeMarketPrice(Number(quote.price), market, reference);
      market.price = safePrice;
      if (!isPlausibleMarketPrice(market.dayOpen, reference)) market.dayOpen = reference;
      if (!isPlausibleMarketPrice(market.dayHigh, reference)) market.dayHigh = safePrice;
      if (!isPlausibleMarketPrice(market.dayLow, reference)) market.dayLow = safePrice;
      market.dayHigh = Math.max(market.dayHigh, safePrice);
      market.dayLow = Math.min(market.dayLow, safePrice);
      market.change = (market.price / Math.max(0.0001, market.dayOpen) - 1) * 100;
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
      const reference = getChartReferencePrice(market);
      const basePrice = sanitizeMarketPrice(market.price, market, reference);
      const drift = (Math.random() - 0.5) * market.volatility * 1.6;
      market.price = sanitizeMarketPrice(basePrice * (1 + drift), market, reference);
      if (!isPlausibleMarketPrice(market.dayOpen, reference)) market.dayOpen = reference;
      if (!isPlausibleMarketPrice(market.dayHigh, reference)) market.dayHigh = market.price;
      if (!isPlausibleMarketPrice(market.dayLow, reference)) market.dayLow = market.price;
      market.dayHigh = Math.max(market.dayHigh, market.price);
      market.dayLow = Math.min(market.dayLow, market.price);
      market.change = (market.price / Math.max(0.0001, market.dayOpen) - 1) * 100;
    });
    if (!state.quoteErrorNotified) {
      toast(`Could not update market prices from server. Showing simulated movement.`, true);
      state.quoteErrorNotified = true;
    }
  } finally {
    state.marketQuoteLoading = false;
  }

  const active = activeMarket();
  if (active) syncActiveMarketCandle(active.price);

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

async function refreshInternalTransferBalance() {
  if (!state.userId || !supabaseClient) {
    toast("Sign in to transfer simulated account funds.", true);
    return;
  }

  try {
    state.realTestBalance = await loadRealTestBalance();
    $("#internal-transfer-balance").textContent = money(state.realTestBalance);
  } catch (error) {
    toast(`Could not load transfer balance: ${getErrorMessage(error, "Account loading failed.")}`, true);
  }
}

async function submitInternalTransfer(event) {
  event.preventDefault();
  if (state.isSubmittingTransfer) return;
  if (!supabaseClient || !state.userId) {
    toast("Sign in to transfer simulated account funds.", true);
    return;
  }

  const recipientEmail = $("#transfer-recipient-email").value.trim();
  const amount = Number($("#transfer-amount").value);
  const errorBox = $("#internal-transfer-error");
  const submitButton = $("#submit-internal-transfer");
  errorBox.hidden = true;
  errorBox.textContent = "";

  if (!Number.isFinite(amount) || amount <= 0 || Number(amount.toFixed(2)) !== amount) {
    errorBox.textContent = "Enter an amount greater than zero with no more than two decimal places.";
    errorBox.hidden = false;
    return;
  }
  if (recipientEmail.toLowerCase() === String(state.userEmail || "").toLowerCase()) {
    errorBox.textContent = "You cannot transfer funds to your own account.";
    errorBox.hidden = false;
    return;
  }

  state.isSubmittingTransfer = true;
  submitButton.disabled = true;
  submitButton.textContent = "Sending transfer...";

  try {
    const { data, error } = await supabaseClient.rpc("real_test_internal_transfer", {
      p_recipient_email: recipientEmail,
      p_amount: amount
    });
    if (error) throw error;

    const updatedBalance = Number(data?.balance);
    if (Number.isFinite(updatedBalance) && updatedBalance >= 0) state.realTestBalance = updatedBalance;
    $("#internal-transfer-balance").textContent = money(state.realTestBalance);
    $("#transfer-recipient-email").value = "";
    $("#transfer-amount").value = "";
    toast(`Transfer of ${money(amount)} sent to ${recipientEmail}.`);

    try {
      const [balance] = await Promise.all([loadRealTestBalance(), loadRealTestTransactions()]);
      state.realTestBalance = balance;
      $("#internal-transfer-balance").textContent = money(balance);
    } catch (refreshError) {
      toast(`Transfer completed, but account history could not be refreshed: ${getErrorMessage(refreshError, "Refresh failed.")}`, true);
    }
  } catch (error) {
    const message = getErrorMessage(error, "Could not complete the transfer.");
    errorBox.textContent = message;
    errorBox.hidden = false;
    toast(`Transfer failed: ${message}`, true);
  } finally {
    state.isSubmittingTransfer = false;
    submitButton.disabled = false;
    submitButton.innerHTML = "Send transfer <span>→</span>";
  }
}

function selectView(view) {
  const panel = $(`[data-view-panel="${view}"]`);
  if (!panel) return;
  $$("[data-view-panel]").forEach((item) => { item.hidden = item !== panel; });
  $$(".nav-link[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  $("#page-title").textContent = view === "Transfer" ? "Internal transfer" : view;
  if (view === "Markets") renderMarketStrip();
  if (view === "History") {
    state.showingHistory = true;
    renderPositions();
  }
  if (view === "Trade") renderChart();
  if (view === "Transfer") refreshInternalTransferBalance();
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
    ? api.createReference("NEXATRADE")
    : ("NEXATRADE-" + Date.now());

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

    if (!isSet && !isDemo && action === "withdrawal") {
      showTradeResult({
        kind: "notice",
        status: "notice",
        tone: "success",
        title: "Withdrawal successful"
      });
    } else {
      toast(
        isSet
          ? `Demo balance set to ${money(state.balance)}.`
          : isDemo
            ? `${money(amount)} added to your demo balance.`
            : `${money(amount)} added to your balance.`,
      );
    }
  } catch (error) {
    const message = getErrorMessage(error, "Could not update funds.");
    if (useExternalProvider) setFundsCheckoutResult(message, true);
    toast(`Could not update funds: ${message}`, true);
  } finally {
    $("#confirm-funds").disabled = false;
  }
}


function resetAiScanSignal() {
  const button = $("#ai-scan-button");
  if (!button) return;
  const status = button.querySelector(".ai-scan-status");
  if (status) status.textContent = "Scan market";
  else button.textContent = "AI";
  button.classList.remove("is-buy", "is-sell", "is-scanning");
  button.title = "AI scanner (optional): scans simulated market and suggests a buy or sell entry with win-rate probability";
  button.setAttribute("aria-label", "AI scanner: scan simulated market for entry");
}

function scanSimulatedMarketEntry() {
  const candles = Array.isArray(state.candles) ? state.candles.slice(-12) : [];
  const market = activeMarket();
  const fallbackSignal = Number(market && market.change) < 0 ? "sell" : "buy";
  if (!candles.length || !market) {
    return { signal: fallbackSignal };
  }

  const closes = candles.map((candle) => Number(candle.close)).filter(Number.isFinite);
  const last = candles[candles.length - 1];
  const recent = closes.slice(-4);
  const previous = closes.slice(-8, -4);
  const recentAvg = recent.length ? recent.reduce((sum, value) => sum + value, 0) / recent.length : Number(last.close || market.price || 0);
  const previousAvg = previous.length ? previous.reduce((sum, value) => sum + value, 0) / previous.length : recentAvg;
  const momentum = recentAvg - previousAvg;
  const lastDirection = Number(last.close || 0) - Number(last.open || 0);
  const priceRef = Math.max(Number(market.price || last.close || 1), 0.0001);
  const score = momentum + lastDirection + (Number(market.change || 0) * priceRef * 0.0005);
  const signal = score >= 0 ? "buy" : "sell";

  return { signal };
}

async function runAiMarketScan() {
  const button = $("#ai-scan-button");
  if (!button || button.disabled) return;
  const status = button.querySelector(".ai-scan-status");
  button.classList.add("is-scanning");
  button.classList.remove("is-buy", "is-sell");
  if (status) status.textContent = "Scanning market...";
  else button.textContent = "Scanning...";
  button.title = "AI scanner (optional): scanning simulated market...";
  button.setAttribute("aria-label", "AI scanner is scanning simulated market");
  button.disabled = true;
  try {
    await new Promise((resolve) => window.setTimeout(resolve, 3000));
    const { signal } = scanSimulatedMarketEntry();
    const probability = Math.floor(Math.random() * 40) + 61; // 61-100
    const label = signal === "buy" ? "BUY" : "SELL";
    if (status) status.textContent = `${label} signal · ${probability}% win`;
    else button.textContent = `AI ${label} ${probability}%`;
    button.classList.toggle("is-buy", signal === "buy");
    button.classList.toggle("is-sell", signal === "sell");
    button.title = `AI scanner (optional): simulated market scan suggests ${label} with ${probability}% win-rate probability. Click to scan again.`;
    button.setAttribute("aria-label", `AI scanner suggests ${label} with ${probability}% win-rate probability. Optional. Click to scan again.`);
  } finally {
    button.classList.remove("is-scanning");
    button.disabled = false;
  }
}

function initialize() {
  state.timeframe = "15sec";
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
  const feedStatus = $("#chart-feed-status");
  if (feedStatus) {
    feedStatus.textContent = "LIVE FEED";
    feedStatus.classList.add("live");
  }
  scheduleChartRefresh(60);
  setTimeout(() => scheduleChartRefresh(0), 300);
  setTimeout(() => scheduleChartRefresh(0), 900);

  $$(".timeframe").forEach((button) => {
    button.addEventListener("click", () => {
      // Indexmarkets-style chart runs on a fixed 15s feed.
      state.timeframe = "15sec";
      $$(".timeframe").forEach((item) => item.classList.toggle("active", item.dataset.timeframe === "15sec"));
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
      const notificationsMenu = $("#notifications-menu");
      const notificationsButton = $("#notifications-button");
      if (notificationsMenu) notificationsMenu.hidden = true;
      if (notificationsButton) notificationsButton.setAttribute("aria-expanded", "false");
    }
  });

  $$(".nav-link[data-view]").forEach((button) => button.addEventListener("click", () => selectView(button.dataset.view)));
  $("#internal-transfer-form").addEventListener("submit", submitInternalTransfer);
  $("#menu-toggle").addEventListener("click", () => {
    setNavigationMenuOpen(!document.body.classList.contains("menu-open"));
  });
  $("#menu-backdrop").addEventListener("click", () => setNavigationMenuOpen(false));
  const notificationsButton = $("#notifications-button");
  const notificationsMenu = $("#notifications-menu");
  const toggleNotificationsMenu = (forceOpen) => {
    if (!notificationsMenu || !notificationsButton) return;
    const open = typeof forceOpen === "boolean" ? forceOpen : notificationsMenu.hidden;
    notificationsMenu.hidden = !open;
    notificationsButton.setAttribute("aria-expanded", String(open));
    if (open) {
      const menuBalance = $("#notifications-mpesa-balance");
      if (menuBalance) menuBalance.textContent = money(state.realTestBalance);
    }
  };
  const refreshMpesaBalanceFromMenu = async (buttonEl) => {
    const btn = buttonEl || $("#refresh-mpesa-balance");
    if (!supabaseClient || !state.userId) { toast("Sign in to refresh M-Pesa balance.", true); return; }
    if (btn) { btn.disabled = true; btn.textContent = "Refreshing..."; }
    try {
      state.realTestBalance = await loadRealTestBalance();
      renderBalance();
      toast("M-Pesa balance refreshed.");
    } catch (error) {
      toast(`Could not refresh M-Pesa balance: ${getErrorMessage(error, "Request failed.")}`, true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Refresh M-Pesa balance"; }
    }
  };

  if (notificationsButton) {
    notificationsButton.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleNotificationsMenu();
    });
  }
  $("#refresh-mpesa-balance")?.addEventListener("click", () => refreshMpesaBalanceFromMenu());
  $("#open-messages-app")?.addEventListener("click", () => {
    if (!state.userId) { toast("Sign in to open the Messages app.", true); return; }
    window.location.href = "messages.html";
  });
  document.addEventListener("click", (event) => {
    if (!notificationsMenu || notificationsMenu.hidden) return;
    const wrap = notificationsButton ? notificationsButton.closest(".notification-wrap") : null;
    if (wrap && wrap.contains(event.target)) return;
    toggleNotificationsMenu(false);
  });

  $("#help-button").addEventListener("click", () => toast("Demo trades use demo prices and do not reach an exchange."));
  const chartMenuButton = $("#chart-menu");
  if (chartMenuButton) {
    chartMenuButton.title = "Candlestick chart";
    chartMenuButton.setAttribute("aria-label", "Candlestick chart");
    chartMenuButton.addEventListener("click", () => {
      drawChart();
      toast("Chart display: candlesticks.");
    });
  }

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
  const aiScanButton = $("#ai-scan-button");
  if (aiScanButton) aiScanButton.addEventListener("click", runAiMarketScan);
  $("#dismiss-trade-result").addEventListener("click", dismissTradeResult);

  window.addEventListener("resize", () => {
    try { resizeChartCanvas(); drawChart(); } catch (_) { }
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
  const authTitle = $("#auth-title");
  const nameField = $("#auth-name-field");
  const phoneField = $("#auth-phone-field");
  const confirmField = $("#auth-confirm-field");
  const nameInput = $("#auth-name");
  const confirmInput = $("#auth-confirm");
  const passwordInput = $("#auth-password");
  const submitButton = $("#auth-submit");
  const authError = $("#auth-error");
  const authMessage = $("#auth-message");
  const authForm = $("#auth-form");

  if (authTitle) authTitle.innerHTML = isSignUp ? 'Create your NexaTrade account<span class="title-period">.</span>' : 'Welcome back<span class="title-period">.</span>';
  if (nameField) nameField.hidden = !isSignUp;
  if (phoneField) phoneField.hidden = !isSignUp;
  if (confirmField) confirmField.hidden = !isSignUp;
  if (nameInput) nameInput.required = isSignUp;
  if (confirmInput) confirmInput.required = isSignUp;
  if (passwordInput) passwordInput.autocomplete = isSignUp ? "new-password" : "current-password";
  if (submitButton) submitButton.innerHTML = `${isSignUp ? "Create account" : "Sign in"} <span>→</span>`;
  $$(".auth-tab").forEach((button) => button.classList.toggle("active", button.dataset.authMode === mode));
  if (authError) {
    authError.hidden = true;
    authError.textContent = "";
  }
  if (authMessage) {
    authMessage.hidden = true;
    authMessage.textContent = "";
  }
  if (authForm) authForm.dataset.mode = mode;
}

function showAuthError(message) {
  const authMessage = $("#auth-message");
  const authError = $("#auth-error");
  if (authMessage) {
    authMessage.hidden = true;
    authMessage.textContent = "";
  }
  if (authError) {
    authError.textContent = String(message || "Something went wrong.");
    authError.hidden = false;
  }
}

function showAuthMessage(message) {
  const authError = $("#auth-error");
  const authMessage = $("#auth-message");
  if (authError) {
    authError.hidden = true;
    authError.textContent = "";
  }
  if (authMessage) {
    authMessage.textContent = String(message || "");
    authMessage.hidden = false;
  }
}

function startDashboard() {
  try {
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
  } catch (error) {
    console.error("Could not initialize dashboard UI:", error);
    toast(getErrorMessage(error, "Could not initialize the dashboard."), true);
  }
  if (!state.marketUpdateInterval) state.marketUpdateInterval = window.setInterval(updateMarkets, 3000);
  if (!state.candleTimerInterval) state.candleTimerInterval = window.setInterval(renderCandleCountdown, 1000);
  if (!state.liveTickInterval) state.liveTickInterval = window.setInterval(tickLiveChart, 800);
  try {
    updateMarkets();
  } catch (error) {
    console.error("Could not refresh markets:", error);
  }
  if (!state.sentimentInterval) state.sentimentInterval = window.setInterval(setSentiment, 9000);
}

function stopDashboard() {
  window.clearInterval(state.marketUpdateInterval);
  window.clearInterval(state.sentimentInterval);
  window.clearInterval(state.candleTimerInterval);
  window.clearInterval(state.liveTickInterval);
  state.marketUpdateInterval = null;
  state.sentimentInterval = null;
  state.candleTimerInterval = null;
  state.liveTickInterval = null;
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
  state.watchlist = ["XAU"];
  state.showingHistory = false;
  state.activeMarket = "XAU";
  state.timeframe = "30sec";
  state.isSubmittingTrade = false;
  state.isSubmittingTransfer = false;
  state.tradeDisplay = null;
  const profileDetails = $("#profile-details");
  const profileButton = $("#profile-button");
  if (profileDetails) profileDetails.hidden = true;
  if (profileButton) profileButton.setAttribute("aria-expanded", "false");
  generateCandles(activeMarket());
  $$(".timeframe").forEach((button) => button.classList.toggle("active", button.dataset.timeframe === state.timeframe));
  const tradeResult = $("#trade-result");
  if (tradeResult) tradeResult.hidden = true;
}

async function loadMyAccountProfile() {
  if (!supabaseClient) return;
  try {
    const { data, error } = await supabaseClient.rpc("nexatrade_get_my_account");
    if (error) throw error;
    state.userAccountType = String((data && data.account_type) || "standard").toLowerCase();
    state.isVip = !!(data && (data.is_vip === true || state.userAccountType === "vip"));
    if (data && data.phone && !state.userPhone) state.userPhone = String(data.phone);
  } catch (_) {
    state.userAccountType = state.userAccountType || "standard";
    state.isVip = !!state.isVip;
  }
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
  await loadMyAccountProfile();
  renderAccountMode();
  document.body.classList.add("authenticated");
  try {
    startDashboard();
  } catch (error) {
    console.error("Could not start dashboard after sign-in:", error);
  }
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

function registerAppServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Service worker registration failed:", error);
    });
  });
}

async function initializeAuth() {
  registerAppServiceWorker();
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
