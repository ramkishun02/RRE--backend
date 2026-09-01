"use strict";

const state = {
  activePage: "home",
  mode: "paper",
  amount: 1000,
  previousReturn: 0,
  maxCycles: 10,
  maxDays: 30,
  recommendation: {
    symbol: "INFY",
    name: "Infosys Limited",
    exchange: "NSE",
    price: 1520,
    score: 82,
    risk: "Medium",
    reason: "Strong momentum and stable earnings."
  },
  selectedStock: {
    symbol: "INFY",
    name: "Infosys Limited",
    exchange: "NSE",
    price: 1520
  },
  strategy: {
    active: true,
    status: "MONITORING",
    cycleNumber: 1,
    dayNumber: 8,
    symbol: "INFY",
    quantity: 1,
    purchasePrice: 1520,
    currentPrice: 1568,
    highestPrice: 1568,
    stopLoss: 1568,
    targetPrice: 1641.6,
    targetPercentage: 8,
    investmentAmount: 1520,
    startDate: "2026-08-16"
  },
  history: [
    {
      date: "16 Aug 2026",
      symbol: "INFY",
      action: "BUY",
      amount: 1520,
      result: "Order completed",
      status: "COMPLETED"
    },
    {
      date: "15 Aug 2026",
      symbol: "TCS",
      action: "SELL",
      amount: 1015,
      result: "Stop-loss hit",
      status: "EXITED"
    }
  ]
};

const searchedStocks = new Map();

const stockList = [
  ["INFY", "Infosys Limited", 1520, 82, "Medium", "Strong momentum and stable earnings."],
  ["TCS", "Tata Consultancy Services", 3420, 78, "Low", "Stable large-cap company with consistent performance."],
  ["RELIANCE", "Reliance Industries", 2880, 75, "Medium", "Positive sector momentum and business diversification."],
  ["ITC", "ITC Limited", 470, 74, "Low", "Defensive stock with consistent demand."],
  ["HDFCBANK", "HDFC Bank", 1710, 77, "Medium", "Strong banking franchise and stable fundamentals."],
  ["SBIN", "State Bank of India", 820, 71, "Medium", "Positive banking-sector strength."]
].map(([symbol, name, price, score, risk, reason]) => ({
  symbol, name, price, score, risk, reason, exchange: "NSE"
}));

const pageTitles = {
  home: "Home",
  ai: "AI Recommendation",
  order: "Order",
  monitor: "Monitor",
  history: "History",
  portfolio: "Portfolio",
  holdings: "Holdings",
  performance: "Performance",
  reports: "Reports"
};

const pageContainer = document.getElementById("pageContainer");
const pageTitle = document.getElementById("pageTitle");
const toast = document.getElementById("toast");
const sidebar = document.getElementById("sidebar");

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatMoney(value) {
  return `₹${Math.round(Number(value) || 0).toLocaleString("en-IN")}`;
}

function formatSignedMoney(value) {
  const amount = Math.round(Number(value) || 0);
  return `${amount >= 0 ? "+" : "-"}₹${Math.abs(amount).toLocaleString("en-IN")}`;
}

function formatDate(date) {
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}

window.showToast = showToast;

function statCard(label, value, change, icon, color = "") {
  return `<div class="stat-card ${color}">
    <div class="stat-top"><span>${escapeHtml(label)}</span><div class="stat-icon">${icon}</div></div>
    <div class="stat-value">${value}</div>
    <div class="stat-change">${escapeHtml(change)}</div>
  </div>`;
}

function metricBox(label, value) {
  return `<div class="metric-box"><small>${escapeHtml(label)}</small><strong>${value}</strong></div>`;
}

function previewRow(label, value) {
  return `<div class="preview-row"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`;
}

function calculateSummary() {
  const holdings = getHoldings();
  const invested = holdings.reduce((sum, item) => sum + item.buyPrice * item.quantity, 0);
  const currentValue = holdings.reduce((sum, item) => sum + item.currentPrice * item.quantity, 0);
  const profitLoss = currentValue - invested;
  return {
    invested,
    currentValue,
    profitLoss,
    returnPercentage: invested ? (profitLoss / invested) * 100 : 0
  };
}

function getHoldings() {
  const strategy = state.strategy;
  if (!strategy.symbol || !Number(strategy.quantity)) return [];
  return [{
    symbol: strategy.symbol,
    quantity: Number(strategy.quantity),
    buyPrice: Number(strategy.purchasePrice) || 0,
    currentPrice: Number(strategy.currentPrice) || 0,
    currentValue: (Number(strategy.currentPrice) || 0) * Number(strategy.quantity),
    profit: ((Number(strategy.currentPrice) || 0) - (Number(strategy.purchasePrice) || 0)) * Number(strategy.quantity)
  }];
}

function renderCurrentPage() {
  const renderers = {
    home: renderHome,
    ai: renderAI,
    order: renderOrder,
    monitor: renderMonitor,
    history: renderHistory,
    portfolio: renderPortfolio,
    holdings: renderHoldings,
    performance: renderPerformance,
    reports: renderReports
  };
  const renderer = renderers[state.activePage] || renderHome;
  if (pageContainer) pageContainer.innerHTML = renderer();
  if (pageTitle) pageTitle.textContent = pageTitles[state.activePage] || "Home";
  document.querySelectorAll("[data-page]").forEach((element) => {
    element.classList.toggle("active", element.dataset.page === state.activePage);
  });
  updateModeBadge();
  bindDynamicEvents();
}

function navigate(page) {
  state.activePage = pageTitles[page] ? page : "home";
  if (sidebar) sidebar.classList.remove("open");
  renderCurrentPage();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function updateModeBadge() {
  const modeBadge = byId("modeBadge");
  if (!modeBadge) return;
  modeBadge.textContent = state.mode === "paper" ? "PAPER MODE" : "LIVE MODE";
  modeBadge.style.color = state.mode === "paper" ? "var(--yellow)" : "var(--red)";
}

function handleAction(action) {
  switch (action) {
    case "go-home": navigate("home"); break;
    case "go-ai": navigate("ai"); break;
    case "go-order": navigate("order"); break;
    case "go-monitor": navigate("monitor"); break;
    case "go-history": navigate("history"); break;
    case "select-recommendation":
      state.selectedStock = { ...state.recommendation };
      showToast(`${state.selectedStock.symbol} selected.`);
      renderCurrentPage();
      break;
    case "refresh-recommendation": {
      const next = stockList[Math.floor(Math.random() * stockList.length)];
      state.recommendation = { ...next };
      state.selectedStock = { ...next };
      showToast(`New AI recommendation: ${next.symbol}`);
      renderCurrentPage();
      break;
    }
    case "review-order": prepareOrderFromForm(); break;
    case "confirm-paper-order": confirmOrder(); break;
    case "pause-strategy":
      state.strategy.active = false;
      state.strategy.status = "PAUSED";
      showToast("Strategy paused.");
      renderCurrentPage();
      break;
    case "resume-strategy":
      state.strategy.active = true;
      state.strategy.status = "MONITORING";
      showToast("Strategy resumed.");
      renderCurrentPage();
      break;
    case "exit-strategy": exitStrategy("MANUAL_EXIT"); break;
    case "toggle-mode":
      state.mode = state.mode === "paper" ? "live" : "paper";
      showToast(state.mode === "paper" ? "Paper mode enabled." : "Live mode selected. Backend confirmation required.");
      renderCurrentPage();
      break;
    default: break;
  }
}

function renderHome() {
  const summary = calculateSummary();
  return `<div class="page-heading"><div><h2>Good morning, Vibha</h2><p>Control your investment strategy from one place.</p></div><button class="primary-button" data-action="go-ai">Start Investment</button></div>
    <div class="cards-grid">
      ${statCard("Monthly Input", formatMoney(state.amount), "Amount entered for this cycle", "₹")}
      ${statCard("Previous Return", formatMoney(state.previousReturn), "Return from completed cycle", "↗", "green")}
      ${statCard("Next Investment Basis", formatMoney(state.amount + state.previousReturn), "Input plus previous return", "◈")}
      ${statCard("Overall Profit/Loss", formatSignedMoney(summary.profitLoss), `${summary.returnPercentage.toFixed(2)}% overall return`, summary.profitLoss >= 0 ? "↗" : "↘", summary.profitLoss >= 0 ? "green" : "red")}
    </div>
    <div class="dashboard-grid"><div class="card card-padding"><div class="card-header"><div><h3>Total Investment Return</h3><p>Portfolio performance and cycle returns</p></div></div>${renderChart(summary)}</div>
    <div class="card card-padding"><div class="card-header"><div><h3>Active Strategy</h3><p>Current automated investment cycle</p></div><span class="status-pill">${escapeHtml(state.strategy.status)}</span></div>${renderActiveStrategy()}</div></div>
    <h3 class="section-title">Quick Actions</h3><div class="quick-actions"><button class="action-card" data-action="go-ai"><div class="action-icon">✦</div><div><h4>AI Recommendation</h4><p>Get a stock suggestion</p></div></button><button class="action-card" data-action="go-order"><div class="action-icon">↗</div><div><h4>Place Order</h4><p>Review and confirm order</p></div></button><button class="action-card" data-action="go-monitor"><div class="action-icon">◉</div><div><h4>Monitor Strategy</h4><p>Track target and stop-loss</p></div></button></div>
    <div class="bottom-content-grid"><div class="card card-padding"><div class="card-header"><div><h3>Top Holdings</h3><p>Current investment positions</p></div><button class="secondary-button" data-page="holdings">View all</button></div>${renderTopHoldings()}</div><div class="card card-padding"><div class="card-header"><div><h3>Recent Activity</h3><p>Latest strategy events</p></div><button class="secondary-button" data-action="go-history">History</button></div>${renderRecentActivity()}</div></div>`;
}

function renderAI() {
  const recommendation = state.recommendation;
  return `<div class="page-heading"><div><h2>AI Recommendation</h2><p>Review the recommendation or search for another NSE stock.</p></div><button class="secondary-button" data-action="refresh-recommendation">New Recommendation</button></div>
    <div class="form-layout"><div class="card form-card"><h3>Recommended Stock</h3><div class="strategy-main"><div class="strategy-symbol"><div class="symbol-box">${escapeHtml(recommendation.symbol.slice(0, 3))}</div><div><h3>${escapeHtml(recommendation.symbol)}</h3><p>${escapeHtml(recommendation.name)}</p></div></div><span class="status-pill">BUY SUGGESTION</span></div><div class="strategy-metrics" style="margin-top:20px">${metricBox("Price", formatMoney(recommendation.price))}${metricBox("Risk", recommendation.risk)}${metricBox("AI confidence", `${recommendation.score}%`)}${metricBox("Estimated quantity", Math.max(1, Math.floor(state.amount / recommendation.price)))}</div><div class="info-box" style="margin-top:18px">${escapeHtml(recommendation.reason)}</div><button class="primary-button" style="width:100%;margin-top:18px" data-action="select-recommendation">Use This Recommendation</button></div>
    <div class="card form-card"><h3>Search Stock</h3><p>Search by symbol or company name. Kite connection is required for server-side results.</p><div class="search-box"><input class="input" id="stockSearch" placeholder="Search symbol, e.g. RELIANCE" autocomplete="off"><div id="stockSearchResults"></div></div><div class="preview-box" style="margin-top:18px">${previewRow("Selected stock", state.selectedStock ? `${escapeHtml(state.selectedStock.symbol)} - ${escapeHtml(state.selectedStock.name)}` : "None")}${previewRow("Price", state.selectedStock ? formatMoney(state.selectedStock.price) : "-")}</div><button class="primary-button" style="width:100%;margin-top:18px" data-action="go-order">Continue to Order</button></div></div>`;
}

function renderOrder() {
  const stock = state.selectedStock || state.recommendation;
  const price = Number(stock.price) || 0;
  const quantity = Math.max(1, Math.floor(state.amount / price) || 1);
  const target = price * 1.08;
  const orderStocks = [
    ...stockList.filter((item) => item.symbol !== stock.symbol),
    stock
  ];
  return `<div class="page-heading"><div><h2>Order Preview</h2><p>Review every value before confirming an order.</p></div></div><div class="form-layout"><div class="card form-card"><h3>Order Details</h3><div class="form-group"><label>Stock</label><select class="select" id="orderStock">${orderStocks.map((item) => `<option value="${escapeHtml(item.symbol)}" ${item.symbol === stock.symbol ? "selected" : ""}>${escapeHtml(item.symbol)} - ${escapeHtml(item.name || item.symbol)}</option>`).join("")}</select></div><div class="form-group"><label>Transaction type</label><div class="radio-grid"><label class="radio-option selected"><input type="radio" name="transaction" value="BUY" checked> Buy</label><label class="radio-option"><input type="radio" name="transaction" value="SELL"> Sell</label></div></div><div class="form-group"><label>Quantity</label><input class="input" id="orderQuantity" type="number" min="1" value="${quantity}"></div><div class="form-group"><label>Order type</label><select class="select" id="orderType"><option value="MARKET">Market</option><option value="LIMIT">Limit</option></select></div><div class="form-group" id="limitPriceGroup" style="display:none"><label>Limit price</label><input class="input" id="limitPrice" type="number" min="0.05" step="0.05" value="${price}"></div><div class="form-group"><label>Target percentage</label><input class="input" id="targetPercentage" type="number" min="1" max="50" value="8"></div><div class="form-group"><label>Maximum strategy duration</label><select class="select" id="maxDays"><option value="15">15 days</option><option value="30" selected>30 days</option><option value="60">60 days</option></select></div><button class="primary-button" style="width:100%" data-action="review-order">Update Preview</button></div><div class="card form-card"><h3>Final Order Summary</h3><p>No live order is placed until you explicitly confirm.</p><div class="preview-box">${previewRow("Stock", `${escapeHtml(stock.symbol)} - ${escapeHtml(stock.name)}`)}${previewRow("Estimated price", formatMoney(price))}${previewRow("Estimated quantity", quantity)}${previewRow("Estimated amount", formatMoney(quantity * price))}${previewRow("Initial stop-loss", formatMoney(price))}${previewRow("Target price", formatMoney(target))}${previewRow("Maximum duration", `${state.maxDays} days`)}${previewRow("Mode", state.mode === "paper" ? "Paper trading" : "Live trading")}</div><div class="warning-box" style="margin-top:18px">Verify all values before confirmation. Market prices can change.</div><div style="margin-top:18px"><button class="secondary-button" style="width:100%" data-action="confirm-paper-order">Confirm ${state.mode === "paper" ? "Paper" : "Live"} Order</button></div></div></div>`;
}

function renderMonitor() {
  const s = state.strategy;
  const progress = Math.min(100, (s.dayNumber / Math.max(1, state.maxDays)) * 100);
  const gain = s.purchasePrice ? ((s.currentPrice - s.purchasePrice) / s.purchasePrice) * 100 : 0;
  return `<div class="page-heading"><div><h2>Monitor</h2><p>Track target, trailing stop-loss, cycle, and duration.</p></div><button class="${s.active ? "danger-button" : "primary-button"}" data-action="${s.active ? "pause-strategy" : "resume-strategy"}">${s.active ? "Pause Strategy" : "Resume Strategy"}</button></div><div class="monitor-grid"><div class="card card-padding"><div class="card-header"><div><h3>Active Investment</h3><p>Current strategy status</p></div><span class="status-pill">${escapeHtml(s.status)}</span></div><div class="strategy-main"><div class="strategy-symbol"><div class="symbol-box">${escapeHtml(s.symbol.slice(0, 3))}</div><div><h3>${escapeHtml(s.symbol)}</h3><p>Cycle ${s.cycleNumber} of ${state.maxCycles}</p></div></div><button class="danger-button" data-action="exit-strategy">Manual Exit</button></div><div class="monitor-price"><div><small>Current price</small><strong>${formatMoney(s.currentPrice)}</strong></div><span>${gain >= 0 ? "+" : ""}${gain.toFixed(2)}%</span></div><div class="strategy-metrics">${metricBox("Purchase price", formatMoney(s.purchasePrice))}${metricBox("Highest price", formatMoney(s.highestPrice))}${metricBox("Trailing stop-loss", formatMoney(s.stopLoss))}${metricBox("Target price", formatMoney(s.targetPrice))}</div><div class="strategy-progress" style="margin-top:22px"><div class="strategy-progress-top"><span>Strategy progress</span><span>Day ${s.dayNumber} / ${state.maxDays}</span></div><div class="progress"><div class="progress-bar" style="width:${progress}%"></div></div><small>${Math.max(0, state.maxDays - s.dayNumber)} days remaining</small></div></div><div class="card card-padding"><h3>Cycle Progress</h3><div class="cycle-circle"><div class="cycle-circle-inner"><strong>${s.cycleNumber}/${state.maxCycles}</strong><small>cycles</small></div></div><div class="strategy-metrics">${metricBox("Invested", formatMoney(s.investmentAmount))}${metricBox("Target", `${s.targetPercentage}%`)}${metricBox("Days", `${s.dayNumber}/${state.maxDays}`)}${metricBox("Basis", formatMoney(state.amount + state.previousReturn))}</div></div></div>`;
}

function renderHistory() {
  const rows = state.history.map((item) => `<tr><td>${escapeHtml(item.date)}</td><td>${escapeHtml(item.symbol)}</td><td>${escapeHtml(item.action)}</td><td>${formatMoney(item.amount)}</td><td>${escapeHtml(item.result)}</td><td><span class="history-status">${escapeHtml(item.status)}</span></td></tr>`).join("");
  return `<div class="page-heading"><div><h2>History</h2><p>Every order, execution, exit, and return is recorded here.</p></div><button class="secondary-button" data-action="go-home">Dashboard</button></div><div class="card card-padding"><div class="table-wrapper"><table class="data-table"><thead><tr><th>Date</th><th>Stock</th><th>Action</th><th>Amount</th><th>Result</th><th>Status</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No history records.</td></tr>'}</tbody></table></div></div>`;
}

function renderPortfolio() {
  const s = calculateSummary();
  return `<div class="page-heading"><div><h2>Portfolio</h2><p>Complete portfolio value and investment status.</p></div></div><div class="cards-grid">${statCard("Total Invested", formatMoney(s.invested), "Capital used", "₹")}${statCard("Current Value", formatMoney(s.currentValue), "Current estimated value", "◈", "green")}${statCard("Profit/Loss", formatSignedMoney(s.profitLoss), "Unrealized result", "↗", s.profitLoss >= 0 ? "green" : "red")}${statCard("Return", `${s.returnPercentage.toFixed(2)}%`, "Overall return", "%", s.profitLoss >= 0 ? "green" : "red")}</div><div class="card card-padding" style="margin-top:18px"><h3>Investment Basis</h3><div class="preview-box">${previewRow("New monthly input", formatMoney(state.amount))}${previewRow("Previous cycle return", formatMoney(state.previousReturn))}${previewRow("Next investment basis", formatMoney(state.amount + state.previousReturn))}</div></div>`;
}

function renderHoldings() {
  const rows = getHoldings().map((item) => `<tr><td>${escapeHtml(item.symbol)}</td><td>${item.quantity}</td><td>${formatMoney(item.buyPrice)}</td><td>${formatMoney(item.currentPrice)}</td><td>${formatMoney(item.currentValue)}</td><td class="${item.profit >= 0 ? "green-text" : "red-text"}">${formatSignedMoney(item.profit)}</td></tr>`).join("");
  return `<div class="page-heading"><div><h2>Holdings</h2><p>Current stock positions used by your strategy.</p></div></div><div class="card card-padding"><div class="table-wrapper"><table class="data-table"><thead><tr><th>Stock</th><th>Quantity</th><th>Buy price</th><th>Current price</th><th>Current value</th><th>P/L</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No holdings.</td></tr>'}</tbody></table></div></div>`;
}

function renderPerformance() {
  const s = calculateSummary();
  return `<div class="page-heading"><div><h2>Performance</h2><p>Analyze investment and cycle returns.</p></div></div><div class="card card-padding"><div class="chart-summary"><div><small>Overall return</small><strong class="${s.profitLoss >= 0 ? "green-text" : "red-text"}">${s.returnPercentage.toFixed(2)}%</strong></div><div><small>Profit/Loss</small><strong class="${s.profitLoss >= 0 ? "green-text" : "red-text"}">${formatSignedMoney(s.profitLoss)}</strong></div></div>${renderChart(s)}</div>`;
}

function renderReports() {
  const reports = ["Investment statement", "Execution history", "Return report", "Strategy audit"];
  return `<div class="page-heading"><div><h2>Reports</h2><p>Download and review your investment records.</p></div></div><div class="quick-actions">${reports.map((name) => `<div class="action-card"><div class="action-icon">▧</div><div><h4>${name}</h4><p>Review your ${name.toLowerCase()}.</p></div><button class="secondary-button" data-action="download-report">Download</button></div>`).join("")}</div>`;
}

function renderChart(summary) {
  const points = [summary.invested * 0.88, summary.invested * 0.93, summary.invested * 0.97, summary.invested, summary.currentValue];
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const width = 700;
  const height = 230;
  const coords = points.map((value, index) => ({
    x: 10 + (index / (points.length - 1)) * 680,
    y: 20 + 180 - ((value - min) / Math.max(max - min, 1)) * 180
  }));
  const line = coords.map((p) => `${p.x},${p.y}`).join(" ");
  const area = [`${coords[0].x},202`, ...coords.map((p) => `${p.x},${p.y}`), `${coords.at(-1).x},202`].join(" ");
  return `<div class="chart-box"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><polygon class="chart-area" points="${area}"></polygon><polyline class="chart-line" points="${line}"></polyline>${coords.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="#111827" stroke="#4f8cff" stroke-width="2"></circle>`).join("")}</svg></div>`;
}

function renderActiveStrategy() {
  const s = state.strategy;
  const progress = Math.min(100, (s.dayNumber / Math.max(1, state.maxDays)) * 100);
  return `<div class="active-strategy"><div class="strategy-main"><div class="strategy-symbol"><div class="symbol-box">${escapeHtml(s.symbol.slice(0, 3))}</div><div><h3>${escapeHtml(s.symbol)}</h3><p>Cycle ${s.cycleNumber} of ${state.maxCycles}</p></div></div><span class="status-pill">${escapeHtml(s.status)}</span></div><div class="strategy-metrics">${metricBox("Current price", formatMoney(s.currentPrice))}${metricBox("Purchase price", formatMoney(s.purchasePrice))}${metricBox("Stop-loss", formatMoney(s.stopLoss))}${metricBox("Target", formatMoney(s.targetPrice))}</div><div class="progress" style="margin:18px 0"><div class="progress-bar" style="width:${progress}%"></div></div><button class="secondary-button" data-action="go-monitor">Open Monitor</button></div>`;
}

function renderTopHoldings() {
  return getHoldings().slice(0, 4).map((item) => `<div class="holding-row"><div class="holding-symbol"><div class="symbol-box">${escapeHtml(item.symbol.slice(0, 3))}</div><div><strong>${escapeHtml(item.symbol)}</strong><small>${item.quantity} quantity</small></div></div><div class="holding-price"><strong>${formatMoney(item.currentValue)}</strong><small>${formatSignedMoney(item.profit)}</small></div></div>`).join("") || '<p>No holdings yet.</p>';
}

function renderRecentActivity() {
  return state.history.slice(0, 4).map((item) => `<div class="activity-row"><div><strong>${escapeHtml(item.action)} ${escapeHtml(item.symbol)}</strong><small>${escapeHtml(item.result)}</small></div><small>${escapeHtml(item.date)}</small></div>`).join("") || '<p>No recent activity.</p>';
}

function renderSearchResults(results) {
  const target = byId("stockSearchResults");
  if (!target) return;

  const uniqueResults = [];
  const seen = new Set();

  results.forEach((item) => {
    const symbol = String(item.symbol || "").trim().toUpperCase();
    if (!symbol || seen.has(symbol)) return;

    const normalized = {
      symbol,
      name: item.name || symbol,
      exchange: item.exchange || "NSE",
      price: Number(item.price ?? item.last_price) || 0,
      instrumentToken: item.instrumentToken || item.instrument_token || ""
    };

    seen.add(symbol);
    searchedStocks.set(symbol, normalized);
    uniqueResults.push(normalized);
  });

  target.innerHTML = uniqueResults.length
    ? uniqueResults.slice(0, 20).map((item) => `<button type="button" class="holding-row search-item" data-stock-symbol="${escapeHtml(item.symbol)}"><span><strong>${escapeHtml(item.symbol)}</strong><small>${escapeHtml(item.name)}</small></span><strong>${item.price ? formatMoney(item.price) : "NSE"}</strong></button>`).join("")
    : '<div class="info-box">No stock found.</div>';
}

async function selectSearchedStock(symbol) {
  let selected = searchedStocks.get(symbol) || stockList.find((item) => item.symbol === symbol);

  if (!selected) {
    showToast("Stock details were not found. Search again.");
    return;
  }

  if (!selected.price) {
    showToast(`Loading price for ${symbol}...`);
    try {
      const response = await fetch(`/api/market/quote?symbol=${encodeURIComponent(symbol)}`);
      const data = await response.json();
      if (!response.ok || !data.success || !Number(data.last_price)) {
        showToast(data.message || "Unable to load this stock price.");
        return;
      }
      selected = {
        ...selected,
        exchange: data.exchange || selected.exchange || "NSE",
        price: Number(data.last_price)
      };
      searchedStocks.set(symbol, selected);
    } catch (error) {
      console.error("Stock quote failed:", error);
      showToast("Unable to load this stock price.");
      return;
    }
  }

  state.selectedStock = { ...selected };
  showToast(`${symbol} selected.`);
  renderCurrentPage();
}

async function searchStocks(query) {
  const local = stockList.filter((item) => item.symbol.includes(query) || item.name.toUpperCase().includes(query));
  renderSearchResults(local);
  try {
    const response = await fetch(`/api/stocks/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) return;
    const data = await response.json();
    if (data.success && Array.isArray(data.results) && data.results.length) renderSearchResults(data.results);
  } catch (error) {
    console.warn("Server stock search unavailable; showing local results.", error);
  }
}

function bindDynamicEvents() {
  const search = byId("stockSearch");
  if (search) {
    search.addEventListener("input", () => {
      const query = search.value.trim().toUpperCase();
      if (query) searchStocks(query);
      else renderSearchResults(stockList);
    });
    renderSearchResults(stockList);
  }

  const orderType = byId("orderType");
  if (orderType) orderType.addEventListener("change", () => {
    const group = byId("limitPriceGroup");
    if (group) group.style.display = orderType.value === "LIMIT" ? "block" : "none";
  });

  const orderStock = byId("orderStock");
  if (orderStock) orderStock.addEventListener("change", () => {
    const selected = stockList.find((item) => item.symbol === orderStock.value);
    if (selected) {
      state.selectedStock = { ...selected };
      renderCurrentPage();
    }
  });

  document.querySelectorAll("[data-stock-symbol]").forEach((button) => {
    button.addEventListener("click", () => selectSearchedStock(button.dataset.stockSymbol));
  });
}

function prepareOrderFromForm() {
  const symbol = byId("orderStock")?.value;
  const stock = searchedStocks.get(symbol) || stockList.find((item) => item.symbol === symbol) || state.selectedStock;
  const quantity = Number(byId("orderQuantity")?.value);
  const targetPercentage = Number(byId("targetPercentage")?.value);
  const maxDays = Number(byId("maxDays")?.value);

  if (!stock || !quantity || quantity <= 0) return showToast("Enter a valid quantity.");
  if (!targetPercentage || targetPercentage <= 0) return showToast("Target must be greater than zero.");

  state.selectedStock = { ...stock };
  state.amount = quantity * stock.price;
  state.maxDays = maxDays > 0 ? maxDays : 30;
  state.strategy = {
    ...state.strategy,
    symbol: stock.symbol,
    quantity,
    purchasePrice: stock.price,
    currentPrice: stock.price,
    highestPrice: stock.price,
    stopLoss: stock.price,
    targetPrice: stock.price * (1 + targetPercentage / 100),
    targetPercentage,
    investmentAmount: quantity * stock.price,
    dayNumber: 0,
    status: "AWAITING_CONFIRMATION"
  };
  showToast("Order preview updated.");
  renderCurrentPage();
}

function confirmOrder() {
  const s = state.strategy;
  if (!s.symbol || !s.quantity) return showToast("Complete the order details first.");
  state.history.unshift({
    date: formatDate(new Date()),
    symbol: s.symbol,
    action: "BUY",
    amount: s.investmentAmount,
    result: state.mode === "paper" ? "Paper order completed" : "Sent to backend for Kite execution",
    status: state.mode === "paper" ? "COMPLETED" : "PENDING"
  });
  s.active = true;
  s.status = state.mode === "paper" ? "MONITORING" : "ORDER_PENDING";
  s.startDate = formatDate(new Date());
  showToast(state.mode === "paper" ? "Paper order completed." : "Live order prepared.");
  navigate("monitor");
}

function exitStrategy(reason) {
  const s = state.strategy;
  if (!s.active) return showToast("There is no active strategy.");
  const exitAmount = s.currentPrice * s.quantity;
  const profit = exitAmount - s.investmentAmount;
  state.history.unshift({ date: formatDate(new Date()), symbol: s.symbol, action: "SELL", amount: exitAmount, result: reason === "MANUAL_EXIT" ? `Manual exit, ${formatSignedMoney(profit)}` : reason, status: "EXITED" });
  state.previousReturn = profit;
  s.active = false;
  s.status = reason;
  s.dayNumber = 0;
  showToast(`Strategy exited. Result: ${formatSignedMoney(profit)}`);
  renderCurrentPage();
}

document.addEventListener("click", (event) => {
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) navigate(pageButton.dataset.page);
  const actionButton = event.target.closest("[data-action]");
  if (actionButton) handleAction(actionButton.dataset.action);
});

byId("mobileMenuButton")?.addEventListener("click", () => sidebar?.classList.toggle("open"));
byId("refreshButton")?.addEventListener("click", () => {
  showToast("Dashboard refreshed.");
  renderCurrentPage();
});
byId("modeToggle")?.addEventListener("click", () => handleAction("toggle-mode"));

renderCurrentPage();
