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
    reason: "Strong momentum and stable earnings.",
  },

  selectedStock: {
    symbol: "INFY",
    name: "Infosys Limited",
    exchange: "NSE",
    price: 1520,
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
    startDate: "2026-08-16",
  },

  history: [
    {
      date: "16 Aug 2026",
      symbol: "INFY",
      action: "BUY",
      amount: 1520,
      result: "Order completed",
      status: "COMPLETED",
    },
    {
      date: "15 Aug 2026",
      symbol: "TCS",
      action: "SELL",
      amount: 1015,
      result: "Stop-loss hit",
      status: "EXITED",
    },
  ],
};

const stockList = [
  {
    symbol: "INFY",
    name: "Infosys Limited",
    exchange: "NSE",
    price: 1520,
    score: 82,
    risk: "Medium",
    reason: "Strong momentum and stable earnings.",
  },
  {
    symbol: "TCS",
    name: "Tata Consultancy Services",
    exchange: "NSE",
    price: 3420,
    score: 78,
    risk: "Low",
    reason: "Stable large-cap company with consistent performance.",
  },
  {
    symbol: "RELIANCE",
    name: "Reliance Industries",
    exchange: "NSE",
    price: 2880,
    score: 75,
    risk: "Medium",
    reason: "Positive sector momentum and business diversification.",
  },
  {
    symbol: "ITC",
    name: "ITC Limited",
    exchange: "NSE",
    price: 470,
    score: 74,
    risk: "Low",
    reason: "Defensive stock with consistent demand.",
  },
  {
    symbol: "HDFCBANK",
    name: "HDFC Bank",
    exchange: "NSE",
    price: 1710,
    score: 77,
    risk: "Medium",
    reason: "Strong banking franchise and stable fundamentals.",
  },
  {
    symbol: "SBIN",
    name: "State Bank of India",
    exchange: "NSE",
    price: 820,
    score: 71,
    risk: "Medium",
    reason: "Positive banking-sector strength.",
  },
];

const pageTitles = {
  home: "Home",
  ai: "AI Recommendation",
  order: "Order",
  monitor: "Monitor",
  history: "History",
  portfolio: "Portfolio",
  holdings: "Holdings",
  performance: "Performance",
  reports: "Reports",
};

const pageContainer = document.getElementById("pageContainer");
const pageTitle = document.getElementById("pageTitle");
const toast = document.getElementById("toast");
const sidebar = document.getElementById("sidebar");

document.addEventListener("click", (event) => {
  const navigationButton = event.target.closest("[data-page]");

  if (navigationButton) {
    navigate(navigationButton.dataset.page);
  }

  const actionButton = event.target.closest("[data-action]");

  if (actionButton) {
    handleAction(actionButton.dataset.action);
  }
});

document.getElementById("mobileMenuButton").addEventListener("click", () => {
  sidebar.classList.toggle("open");
});

document.getElementById("refreshButton").addEventListener("click", () => {
  showToast("Dashboard refreshed.");
  renderCurrentPage();
});

function navigate(page) {
  state.activePage = page;

  pageTitle.textContent = pageTitles[page] || "Home";

  document.querySelectorAll("[data-page]").forEach((element) => {
    element.classList.toggle(
      "active",
      element.dataset.page === page
    );
  });

  sidebar.classList.remove("open");
  renderCurrentPage();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function handleAction(action) {
  if (action === "go-ai") {
    navigate("ai");
  }

  if (action === "go-order") {
    navigate("order");
  }

  if (action === "go-monitor") {
    navigate("monitor");
  }

  if (action === "go-history") {
    navigate("history");
  }

  if (action === "select-recommendation") {
    state.selectedStock = { ...state.recommendation };
    showToast(
      `${state.selectedStock.symbol} selected. You can still change it.`
    );
    renderCurrentPage();
  }

  if (action === "refresh-recommendation") {
    const index = Math.floor(Math.random() * stockList.length);
    state.recommendation = { ...stockList[index] };
    state.selectedStock = { ...state.recommendation };
    showToast(`New AI recommendation: ${state.recommendation.symbol}`);
    renderCurrentPage();
  }

  if (action === "review-order") {
    prepareOrderFromForm();
  }

  if (action === "confirm-paper-order") {
    confirmPaperOrder();
  }

  if (action === "pause-strategy") {
    state.strategy.active = false;
    state.strategy.status = "PAUSED";
    showToast("Strategy paused.");
    renderCurrentPage();
  }

  if (action === "resume-strategy") {
    state.strategy.active = true;
    state.strategy.status = "MONITORING";
    showToast("Strategy resumed.");
    renderCurrentPage();
  }

  if (action === "exit-strategy") {
    exitStrategy("MANUAL_EXIT");
  }

  if (action === "toggle-mode") {
    state.mode = state.mode === "paper" ? "live" : "paper";
    updateModeBadge();
    showToast(
      state.mode === "paper"
        ? "Paper mode enabled."
        : "Live mode selected. Backend confirmation required."
    );
    renderCurrentPage();
  }
}

function renderCurrentPage() {
  updateModeBadge();

  const renderers = {
    home: renderHome,
    ai: renderAI,
    order: renderOrder,
    monitor: renderMonitor,
    history: renderHistory,
    portfolio: renderPortfolio,
    holdings: renderHoldings,
    performance: renderPerformance,
    reports: renderReports,
  };

  pageContainer.innerHTML = renderers[state.activePage]();
  bindDynamicEvents();
}

function updateModeBadge() {
  const modeBadge = document.getElementById("modeBadge");

  modeBadge.textContent =
    state.mode === "paper"
      ? "PAPER MODE"
      : "LIVE MODE";

  modeBadge.style.color =
    state.mode === "paper"
      ? "var(--yellow)"
      : "var(--red)";
}

function renderHome() {
  const summary = calculateSummary();

  return `
    <div class="page-heading">
      <div>
        <h2>Good morning, Vibha👋</h2>
        <p>Control your investment strategy from one place.</p>
      </div>

      <div>
        <button class="primary-button" data-action="go-ai">
          ✦ Start Investment
        </button>
      </div>
    </div>

    <div class="cards-grid">
      ${statCard(
        "Monthly Input",
        formatMoney(state.amount),
        "Amount entered for this cycle",
        "₹",
        ""
      )}

      ${statCard(
        "Previous Return",
        formatMoney(state.previousReturn),
        "Return from completed cycle",
        "↗",
        "green"
      )}

      ${statCard(
        "Next Investment Basis",
        formatMoney(state.amount + state.previousReturn),
        "Input plus previous return",
        "◈",
        ""
      )}

      ${statCard(
        "Overall Profit/Loss",
        formatSignedMoney(summary.profitLoss),
        `${summary.returnPercentage.toFixed(2)}% overall return`,
        summary.profitLoss >= 0 ? "↗" : "↘",
        summary.profitLoss >= 0 ? "green" : "red"
      )}
    </div>

    <div class="dashboard-grid">
      <div class="card card-padding">
        <div class="card-header">
          <div>
            <h3>Total Investment Return</h3>
            <p>Portfolio performance and cycle returns</p>
          </div>

          <select class="select" id="chartRange" style="width:auto;">
            <option>30 days</option>
            <option>6 months</option>
            <option>1 year</option>
          </select>
        </div>

        <div class="chart-summary">
          <div>
            <small>Current value</small>
            <strong>${formatMoney(summary.currentValue)}</strong>
          </div>

          <div>
            <small>Total return</small>
            <strong class="${summary.profitLoss >= 0 ? "green-text" : "red-text"}">
              ${formatSignedMoney(summary.profitLoss)}
            </strong>
          </div>
        </div>

        ${renderChart(summary)}
      </div>

      <div class="card card-padding">
        <div class="card-header">
          <div>
            <h3>Active Strategy</h3>
            <p>Current automated investment cycle</p>
          </div>

          <span class="status-pill">
            ${state.strategy.status}
          </span>
        </div>

        ${renderActiveStrategy()}
      </div>
    </div>

    <h3 class="section-title">Quick Actions</h3>

    <div class="quick-actions">
      <button class="action-card" data-action="go-ai">
        <div class="action-icon">✦</div>
        <div>
          <h4>AI Recommendation</h4>
          <p>Get a stock suggestion</p>
        </div>
      </button>

      <button class="action-card" data-action="go-order">
        <div class="action-icon">↗</div>
        <div>
          <h4>Place Order</h4>
          <p>Review and confirm order</p>
        </div>
      </button>

      <button class="action-card" data-action="go-monitor">
        <div class="action-icon">◉</div>
        <div>
          <h4>Monitor Strategy</h4>
          <p>Track target and stop-loss</p>
        </div>
      </button>
    </div>

    <div class="bottom-content-grid">
      <div class="card card-padding">
        <div class="card-header">
          <div>
            <h3>Top Holdings</h3>
            <p>Current investment positions</p>
          </div>

          <button class="secondary-button" data-page="holdings">
            View all
          </button>
        </div>

        ${renderTopHoldings()}
      </div>

      <div class="card card-padding">
        <div class="card-header">
          <div>
            <h3>Recent Activity</h3>
            <p>Latest strategy events</p>
          </div>

          <button class="secondary-button" data-action="go-history">
            History
          </button>
        </div>

        ${renderRecentActivity()}
      </div>
    </div>
  `;
}
/*

function renderAI() {
  app.innerHTML = renderRecommendationPage()
  setupDynamicStockSearch();
  const recommendation = state.recommendation;

  return `
    <div class="page-heading">
      <div>
        <h2>AI Recommendation</h2>
        <p>AI suggests a stock, but you always make the final selection.</p>
      </div>

      <button class="secondary-button" data-action="refresh-recommendation">
        ↻ New Recommendation
      </button>
    </div>

    <div class="form-layout">
      <div class="card form-card">
        <h3>Recommended for ₹${state.amount.toLocaleString("en-IN")}</h3>
        <p>Recommendation based on the amount, risk, and available stock price.</p>

        <div class="strategy-main">
          <div class="strategy-symbol">
            <div class="symbol-box">${recommendation.symbol.slice(0, 3)}</div>
            <div>
              <h3>${recommendation.symbol}</h3>dw
              <p>${recommendation.name}</p>
            </div>
          </div>

          <span class="status-pill">BUY SUGGESTION</span>
        </div>

        <div class="strategy-metrics" style="margin-top:20px;">
          <div class="metric-box">
            <small>Price</small>
            <strong>${formatMoney(recommendation.price)}</strong>
          </div>

          <div class="metric-box">
            <small>Risk</small>
            <strong>${recommendation.risk}</strong>
          </div>

          <div class="metric-box">
            <small>AI confidence</small>
            <strong>${recommendation.score}%</strong>
          </div>

          <div class="metric-box">
            <small>Estimated quantity</small>
            <strong>${Math.max(1, Math.floor(state.amount / recommendation.price))}</strong>
          </div>
        </div>

        <div class="info-box" style="margin-top:18px;">
          ${recommendation.reason}
        </div>

        <button class="primary-button" style="width:100%; margin-top:18px;" data-action="select-recommendation">
          Use This Recommendation
        </button>
      </div>

      <div class="card form-card">
        <h3>Select Stock Yourself</h3>
        <p>You can reject the AI suggestion and choose another stock.</p>

        <div class="form-group">
          <label>Search stock</label>
          <input
            class="input"
            id="stockSearch"
            placeholder="Search symbol or company"
          />
        </div>
        <input id="dynamicStockSearch" type="text" placeholder="Search stock">

<button id="dynamicStockSearchButton" type="button">
  Search
</button>

<div id="dynamicStockSearchResult"></div>

        <div class="warning-box" style="margin-top:18px;">
          AI suggestions are not guaranteed returns. Review the stock and
          strategy before continuing.
        </div>

        <button class="primary-button" style="width:100%; margin-top:18px;" data-action="go-order">
          Continue to Order
        </button>
      </div>
    </div>

    <div class="card card-padding" style="margin-top:18px;">
*/
function renderRecommendationPage(recommendation) {
  return `
    <div class="card">
      <div class="card-header">
        <div>
          <h3>AI Stock Recommendation</h3>
          <p>Search another stock or use the recommended stock.</p>
        </div>
      </div>

      <div class="search-box">
        <input
          id="dynamicStockSearch"
          type="text"
          placeholder="Search stock symbol, e.g. RELIANCE"
          autocomplete="off"
        />

        <button
          id="dynamicStockSearchButton"
          type="button"
        >
          Search
        </button>

        <div id="dynamicStockSearchResult"></div>
      </div>

      <div class="card-header">
        <div>
          <h3>Your Current Selection</h3>
          <p>This is the stock that will be used in the order preview.</p>
        </div>
      </div>

      <div class="preview-box">
        ${previewRow(
          "Selected stock",
          state.selectedStock
            ? `${state.selectedStock.symbol} - ${state.selectedStock.name}`
            : "No stock selected"
        )}

        ${previewRow(
          "Exchange",
          state.selectedStock?.exchange || "-"
        )}

        ${previewRow(
          "Price",
          state.selectedStock
            ? formatMoney(state.selectedStock.price)
            : "-"
        )}

        ${previewRow(
          "Selection source",
          state.selectedStock &&
          recommendation &&
          state.selectedStock.symbol === recommendation.symbol
            ? "AI recommendation"
            : "User selection"
        )}
      </div>
    </div>
  `;
}

function setupRecommendationSearch() {
  const input = document.getElementById("dynamicStockSearch");
  const button = document.getElementById("dynamicStockSearchButton");
  const result = document.getElementById("dynamicStockSearchResult");

  if (!input || !button || !result) return;

  async function searchStock() {
    const symbol = input.value.trim().toUpperCase();

    if (!symbol) {
      result.textContent = "Please enter a stock symbol.";
      return;
    }

    result.textContent = "Searching...";
    button.disabled = true;

    try {
      const response = await fetch(
        `/api/market/quote?symbol=${encodeURIComponent(symbol)}`
      );

      const data = await response.json();

      if (!response.ok || !data.success) {
        result.textContent = data.message || "Stock not found.";
        return;
      }

      state.selectedStock = {
        symbol: data.symbol,
        name: data.symbol,
        exchange: data.exchange,
        price: data.last_price
      };

      render();
    } catch (error) {
      console.error("Stock search failed:", error);
      result.textContent = "Unable to search stock.";
    } finally {
      button.disabled = false;
    }
  }

  button.onclick = searchStock;

  input.onkeydown = function (event) {
    if (event.key === "Enter") {
      searchStock();
    }
  };
}

function renderOrder() {
  const stock = state.selectedStock;
  const estimatedQuantity = Math.max(
    1,
    Math.floor(state.amount / stock.price)
  );

  const estimatedAmount = estimatedQuantity * stock.price;
  const targetPercentage = 8;
  const targetPrice = stock.price * (1 + targetPercentage / 100);

  return `
    <div class="page-heading">
      <div>
        <h2>Order Preview</h2>
        <p>Review every value before sending an order to Kite.</p>
      </div>
    </div>

    <div class="form-layout">
      <div class="card form-card">
        <h3>Change Order Details</h3>
        <p>The AI selection is editable until final confirmation.</p>

        <div class="form-group">
          <label>Stock</label>
          <select class="select" id="orderStock">
            ${stockList
              .map(
                (item) => `
                  <option value="${item.symbol}" ${
                    item.symbol === stock.symbol ? "selected" : ""
                  }>
                    ${item.symbol} - ${item.name}
                  </option>
                `
              )
              .join("")}
          </select>
        </div>

        <div class="form-group">
          <label>Transaction type</label>

          <div class="radio-grid">
            <label class="radio-option selected">
              <input type="radio" name="transaction" value="BUY" checked />
              Buy
            </label>

            <label class="radio-option">
              <input type="radio" name="transaction" value="SELL" />
              Sell
            </label>
          </div>
        </div>

        <div class="form-group">
          <label>Quantity</label>
          <input
            class="input"
            id="orderQuantity"
            type="number"
            min="1"
            value="${estimatedQuantity}"
          />
        </div>

        <div class="form-group">
          <label>Order type</label>
          <select class="select" id="orderType">
            <option value="MARKET">Market</option>
            <option value="LIMIT">Limit</option>
          </select>
        </div>

        <div class="form-group" id="limitPriceGroup" style="display:none;">
          <label>Limit price</label>
          <input
            class="input"
            id="limitPrice"
            type="number"
            step="0.05"
            value="${stock.price}"
          />
        </div>

        <div class="form-group">
          <label>Target percentage</label>
          <input
            class="input"
            id="targetPercentage"
            type="number"
            min="1"
            max="50"
            value="${targetPercentage}"
          />
        </div>

        <div class="form-group">
          <label>Maximum strategy duration</label>
          <select class="select" id="maxDays">
            <option value="30" selected>30 days</option>
            <option value="15">15 days</option>
            <option value="60">60 days</option>
          </select>
        </div>

        <button class="primary-button" style="width:100%;" data-action="review-order">
          Review Final Order
        </button>
      </div>

      <div class="card form-card">
        <h3>Final Order Summary</h3>
        <p>No live order is placed until you explicitly confirm.</p>

        <div class="preview-box">
          ${previewRow("Stock", `${stock.symbol} - ${stock.name}`)}
          ${previewRow("Estimated price", formatMoney(stock.price))}
          ${previewRow("Estimated quantity", estimatedQuantity)}
          ${previewRow("Estimated amount", formatMoney(estimatedAmount))}
          ${previewRow("Initial stop-loss", formatMoney(stock.price))}
          ${previewRow("Target price", formatMoney(targetPrice))}
          ${previewRow("Maximum duration", "30 days")}
          ${previewRow("Mode", state.mode === "paper" ? "Paper trading" : "Live trading")}
        </div>

        <div class="warning-box" style="margin-top:18px;">
          Please verify stock, quantity, price, target, and stop-loss. Market
          prices can change and execution may differ from the displayed price.
        </div>

        <div id="orderConfirmationArea" style="margin-top:18px;">
          <button class="secondary-button" style="width:100%;" data-action="confirm-paper-order">
            Confirm ${state.mode === "paper" ? "Paper" : "Live"} Order
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderMonitor() {
  const strategy = state.strategy;
  const remainingDays = Math.max(0, state.maxDays - strategy.dayNumber);
  const dayProgress = Math.min(
    100,
    (strategy.dayNumber / state.maxDays) * 100
  );

  return `
    <div class="page-heading">
      <div>
        <h2>Monitor</h2>
        <p>Track target, trailing stop-loss, cycle, and duration.</p>
      </div>

      <div>
        ${
          strategy.active
            ? `<button class="danger-button" data-action="pause-strategy">Pause Strategy</button>`
            : `<button class="primary-button" data-action="resume-strategy">Resume Strategy</button>`
        }
      </div>
    </div>

    <div class="monitor-grid">
      <div class="card card-padding">
        <div class="card-header">
          <div>
            <h3>Active Investment</h3>
            <p>Live strategy status</p>
          </div>

          <span class="status-pill">${strategy.status}</span>
        </div>

        <div class="strategy-main">
          <div class="strategy-symbol">
            <div class="symbol-box">${strategy.symbol.slice(0, 3)}</div>
            <div>
              <h3>${strategy.symbol}</h3>
              <p>Cycle ${strategy.cycleNumber} of ${state.maxCycles}</p>
            </div>
          </div>

          <button class="danger-button" data-action="exit-strategy">
            Manual Exit
          </button>
        </div>

        <div class="monitor-price">
          <div>
            <small class="dim-text">Current price</small>
            <strong>${formatMoney(strategy.currentPrice)}</strong>
          </div>

          <span>
            +${(
              ((strategy.currentPrice - strategy.purchasePrice) /
                strategy.purchasePrice) *
              100
            ).toFixed(2)}%
          </span>
        </div>

        <div class="strategy-metrics">
          ${metricBox("Purchase price", ///formatMoney(s
          formatMoney(strategy.purchasePrice))}
          ${metricBox("Highest price", formatMoney(strategy.highestPrice))}
          ${metricBox("Trailing stop-loss", formatMoney(strategy.stopLoss))}
          ${metricBox("Target price", formatMoney(strategy.targetPrice))}
        </div>

        <div class="strategy-progress" style="margin-top:22px;">
          <div class="strategy-progress-top">
            <span>30-day progress</span>
            <span>Day ${strategy.dayNumber} / ${state.maxDays}</span>
          </div>

          <div class="progress">
            <div class="progress-bar" style="width:${dayProgress}%"></div>
          </div>

          <small class="dim-text">${remainingDays} days remaining</small>
        </div>

        <div class="info-box" style="margin-top:20px;">
          Stop-loss starts at the purchase price and only increases when the
          highest observed price increases. It never moves downward.
        </div>
      </div>

      <div class="card card-padding">
        <div class="card-header">
          <div>
            <h3>Cycle Progress</h3>
            <p>Maximum repeat setting</p>
          </div>
        </div>

        <div class="cycle-circle">
          <div class="cycle-circle-inner">
            <strong>${strategy.cycleNumber}/${state.maxCycles}</strong>
            <small>cycles</small>
          </div>
        </div>

        <div class="strategy-metrics">
          ${metricBox("Invested", formatMoney(strategy.investmentAmount))}
          ${metricBox("Target", `${strategy.targetPercentage}%`)}
          ${metricBox("Days", `${strategy.dayNumber}/${state.maxDays}`)}
          ${metricBox("Basis", formatMoney(state.amount + state.previousReturn))}
        </div>

        <div class="success-box" style="margin-top:18px;">
          ${
            strategy.active
              ? "Strategy is actively monitoring the selected stock."
              : "Strategy is paused. No new automatic action should occur."
          }
        </div>
      </div>
    </div>
  `;
}

function renderHistory() {
  return `
    <div class="page-heading">
      <div>
        <h2>History</h2>
        <p>Every order, execution, exit, and return is recorded here.</p>
      </div>

      <button class="secondary-button" data-action="go-home">
        Dashboard
      </button>
    </div>

    <div class="card card-padding">
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Stock</th>
              <th>Action</th>
              <th>Amount</th>
              <th>Result</th>
              <th>Status</th>
            </tr>
          </thead>

          <tbody>
            ${
              state.history.length
                ? state.history
                    .map(
                      (item) => `
                        <tr>
                          <td>${item.date}</td>
                          <td>${item.symbol}</td>
                          <td>${item.action}</td>
                          <td>${formatMoney(item.amount)}</td>
                          <td>${item.result}</td>
                          <td>
                            <span class="history-status ${
                              item.status === "COMPLETED"
                                ? "status-completed"
                                : item.status === "EXITED"
                                  ? "status-exited"
                                  : "status-pending"
                            }">
                              ${item.status}
                            </span>
                          </td>
                        </tr>
                      `
                    )
                    .join("")
                : `
                  <tr>
                    <td colspan="6">No history records.</td>
                  </tr>
                `
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderPortfolio() {
  const summary = calculateSummary();

  return `
    <div class="page-heading">
      <div>
        <h2>Portfolio</h2>
        <p>Complete portfolio value and investment status.</p>
      </div>
    </div>

    <div class="cards-grid">
      ${statCard("Total Invested", formatMoney(summary.invested), "Capital used", "₹", "")}
      ${statCard("Current Value", formatMoney(summary.currentValue), "Current estimated value", "◈", "green")}
      ${statCard("Profit/Loss", formatSignedMoney(summary.profitLoss), "Unrealized result", "↗", summary.profitLoss >= 0 ? "green" : "red")}
      ${statCard("Return", `${summary.returnPercentage.toFixed(2)}%`, "Overall return", "%", summary.profitLoss >= 0 ? "green" : "red")}
    </div>

    <div class="card card-padding" style="margin-top:18px;">
      <div class="card-header">
        <div>
          <h3>Investment Basis</h3>
          <p>Monthly reinvestment calculation</p>
        </div>
      </div>

      <div class="preview-box">
        ${previewRow("New monthly input", formatMoney(state.amount))}
        ${previewRow("Previous cycle return", formatMoney(state.previousReturn))}
        ${previewRow("Next investment basis", formatMoney(state.amount + state.previousReturn))}
      </div>
    </div>
  `;
}

function renderHoldings() {
  const holdings = getHoldings();

  return `
    <div class="page-heading">
      <div>
        <h2>Holdings</h2>
        <p>Current stock positions used by your investment strategy.</p>
      </div>
    </div>

    <div class="card card-padding">
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Stock</th>
              <th>Quantity</th>
              <th>Buy price</th>
              <th>Current price</th>
              <th>Current value</th>
              <th>P/L</th>
            </tr>
          </thead>

          <tbody>
            ${holdings
              .map(
                (item) => `
                  <tr>
                    <td>${item.symbol}</td>
                    <td>${item.quantity}</td>
                    <td>${formatMoney(item.buyPrice)}</td>
                    <td>${formatMoney(item.currentPrice)}</td>
                    <td>${formatMoney(item.currentValue)}</td>
                    <td class="${item.profit >= 0 ? "green-text" : "red-text"}">
                      ${formatSignedMoney(item.profit)}
                    </td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderPerformance() {
  const summary = calculateSummary();

  return `
    <div class="page-heading">
      <div>
        <h2>Performance</h2>
        <p>Analyze investment and cycle returns.</p>
      </div>
    </div>

    <div class="card card-padding">
      <div class="chart-summary">
        <div>
          <small>Overall return</small>
          <strong class="green-text">
            ${summary.returnPercentage.toFixed(2)}%
          </strong>
        </div>

        <div>
          <small>Profit/Loss</small>
          <strong class="green-text">
            ${formatSignedMoney(summary.profitLoss)}
          </strong>
        </div>
      </div>

      ${renderChart(summary)}
    </div>

    <div class="cards-grid" style="margin-top:18px;">
      ${statCard("Today", "+₹0", "Position result", "↗", "green")}
      ${statCard("This Month", formatSignedMoney(state.previousReturn), "Completed return", "↗", "green")}
      ${statCard("Cycles Completed", "0", "Out of 10 maximum", "◌", "")}
      ${statCard("Target Rate", "8%", "Configured target", "%", "")}
    </div>
  `;
}

function renderReports() {
  const reports = [
    ["Investment statement", "Complete portfolio and investment summary"],
    ["Execution history", "All buy and sell events"],
    ["Return report", "Profit, loss, and cycle returns"],
    ["Strategy audit", "Stop-loss and target changes"],
  ];

  return `
    <div class="page-heading">
      <div>
        <h2>Reports</h2>
        <p>Download and review your investment records.</p>
      </div>
    </div>

    <div class="quick-actions">
      ${reports
        .map(
          ([title, description]) => `
            <div class="action-card">
              <div class="action-icon">▧</div>
              <div>
                <h4>${title}</h4>
                <p>${description}</p>
              </div>
              <button class="secondary-button" onclick="showToast('Report download started.')">
                Download
              </button>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderChart(summary) {
  const points = [
    summary.invested * 0.88,
    summary.invested * 0.91,
    summary.invested * 0.95,
    summary.invested * 0.93,
    summary.invested * 0.99,
    summary.currentValue * 0.98,
    summary.currentValue,
  ];

  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const width = 700;
  const height = 230;
  const topPadding = 20;
  const bottomPadding = 28;
  const leftPadding = 10;
  const rightPadding = 10;

  const chartHeight = height - topPadding - bottomPadding;
  const chartWidth = width - leftPadding - rightPadding;

  const coordinates = points.map((value, index) => {
    const x =
      leftPadding +
      (index / (points.length - 1)) * chartWidth;

    const normalized =
      max === min ? 0.5 : (value - min) / (max - min);

    const y =
      topPadding +
      chartHeight -
      normalized * chartHeight;

    return { x, y, value };
  });

  const linePoints = coordinates
    .map((point) => `${point.x},${point.y}`)
    .join(" ");

  const areaPoints = [
    `${coordinates[0].x},${height - bottomPadding}`,
    ...coordinates.map((point) => `${point.x},${point.y}`),
    `${coordinates[coordinates.length - 1].x},${height - bottomPadding}`,
  ].join(" ");

  const labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Aug"];

  return `
    <div class="chart-box">
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#4f8cff" stop-opacity="0.35"></stop>
            <stop offset="100%" stop-color="#4f8cff" stop-opacity="0"></stop>
          </linearGradient>
        </defs>

        <line class="chart-grid-line" x1="0" y1="40" x2="${width}" y2="40"></line>
        <line class="chart-grid-line" x1="0" y1="100" x2="${width}" y2="100"></line>
        <line class="chart-grid-line" x1="0" y1="160" x2="${width}" y2="160"></line>
        <line class="chart-grid-line" x1="0" y1="202" x2="${width}" y2="202"></line>

        <polygon class="chart-area" points="${areaPoints}"></polygon>
        <polyline class="chart-line" points="${linePoints}"></polyline>

        ${coordinates
          .map(
            (point) => `
              <circle
                cx="${point.x}"
                cy="${point.y}"
                r="3.5"
                fill="#111827"
                stroke="#4f8cff"
                stroke-width="2"
              ></circle>
            `
          )
          .join("")}

        ${labels
          .map(
            (label, index) => `
              <text
                class="chart-label"
                x="${coordinates[index].x}"
                y="222"
                text-anchor="middle"
              >
                ${label}
              </text>
            `
          )
          .join("")}
      </svg>
    </div>
  `;
}

function renderActiveStrategy() {
  const strategy = state.strategy;
  const dayProgress = Math.min(
    100,
    (strategy.dayNumber / state.maxDays) * 100
  );

  return `
    <div class="active-strategy">
      <div class="strategy-main">
        <div class="strategy-symbol">
          <div class="symbol-box">${strategy.symbol.slice(0, 3)}</div>
          <div>
            <h3>${strategy.symbol}</h3>
            <p>Cycle ${strategy.cycleNumber} of ${state.maxCycles}</p>
          </div>
        </div>

        <span class="status-pill">${strategy.status}</span>
      </div>

      <div class="strategy-metrics">
        ${metricBox("Current price", formatMoney(strategy.currentPrice))}
        ${metricBox("Purchase price", formatMoney(strategy.purchasePrice))}
        ${metricBox("Stop-loss", formatMoney(strategy.stopLoss))}
        ${metricBox("Target", formatMoney(strategy.targetPrice))}
      </div>

      <div class="strategy-progress">
        <div class="strategy-progress-top">
          <span>30-day progress</span>
          <span>Day ${strategy.dayNumber}/${state.maxDays}</span>
        </div>

        <div class="progress">
          <div class="progress-bar" style="width:${dayProgress}%"></div>
        </div>
      </div>

      <button class="secondary-button" data-action="go-monitor">
        Open Monitor
      </button>
    </div>
  `;
}

function renderTopHoldings() {
  return getHoldings()
    .slice(0, 4)
    .map(
      (item) => `
        <div class="holding-row">
          <div class="holding-symbol">
            <div class="symbol-box">${item.symbol.slice(0, 3)}</div>
            <div>
              <strong>${item.symbol}</strong>
              <small>${item.quantity} quantity</small>
            </div>
          </div>

          <div class="holding-price">
            <strong>${formatMoney(item.currentValue)}</strong>
            <small>${formatSignedMoney(item.profit)}</small>
          </div>
        </div>
      `
    )
    .join("");
}

function renderRecentActivity() {
  return state.history
    .slice(0, 4)
    .map(
      (item) => `
        <div class="activity-row">
          <div>
            <strong>${item.action} ${item.symbol}</strong>
            <small>${item.result}</small>
          </div>

          <small>${item.date}</small>
        </div>
      `
    )
    .join("");
}

/*function 
renderStockSearchResults(searchText) {
  const search = searchText.toLowerCase().trim();

  const filtered = stockList.filter(
    (item) =>
      item.symbol.toLowerCase().includes(search) ||
      item.name.toLowerCase().includes(search)
  );

  if (!filtered.length) {
    return `
      <div class="info-box">
        No stock found. Try another symbol or company name.
      </div>
    `;
  }

  return `
    <div class="holdings-list">
      ${filtered
        .map(
          (item) => `
            <button
              class="holding-row"
              data-stock-symbol="${item.symbol}"
              style="width:100%; border:0; color:white; background:transparent; text-align:left;"
            >
              <div class="holding-symbol">
                <div class="symbol-box">${item.symbol.slice(0, 3)}</div>
                <div>
                  <strong>${item.symbol}</strong>
                  <small>${item.name}</small>
                </div>
              </div>

              <div class="holding-price">
                <strong>${formatMoney(item.price)}</strong>
                <small>${item.score}% AI score</small>
              </div>
            </button>
          `
        )
        .join("")}
    </div>
  `;
}
/*new functction
  const stockSearch = document.getElementById("stockSearch");
  const searchResults = document.getElementById("searchResults");

  if (stockSearch && searchResults) {
  stockSearch.addEventListener("input", async () => {
    const query = stockSearch.value.trim();

    if (!query) {
      searchResults.innerHTML = "";
      return;
    }

    try {
      const response = await fetch(
        `/api/stocks/search?q=${encodeURIComponent(query)}`
      );

      if (response.status === 401) {
        searchResults.innerHTML =
          `<div class="search-item">Please connect Kite first</div>`;
        return;
      }

      const data = await response.json();

      if (!data.length) {
        searchResults.innerHTML =
          `<div class="search-item">No stock found</div>`;
        return;
      }

      searchResults.innerHTML = data
        .map(
          (stock) => `
            <button class="search-item" data-symbol="${stock.symbol}">
              <strong>${stock.symbol}</strong>
              <span>${stock.name}</span>
              <small>${stock.exchange} · ₹${stock.price}</small>
            </button>
          `
        )
        .join("");
    } catch (error) {
      console.error(error);
      searchResults.innerHTML =
        `<div class="search-item">Search failed</div>`;
    }
  });

  searchResults.addEventListener("click", (event) => {
    const item = event.target.closest("[data-symbol]");
    if (!item) return;

    const symbol = item.dataset.symbol;
    stockSearch.value = symbol;
    searchResults.innerHTML = "";

    console.log("Selected:", symbol);
  });
}

async function renderStockSearchResults(searchText) {
  const search = searchText.trim();
  const searchResultsDiv = document.getElementById("stockSearchResults");

  if (!search) {
    searchResultsDiv.innerHTML = stockList.map(item => `...`).join(""); // fallback to default local list
    return;
  }

  try {
    const response = await fetch(`/api/stocks/search?q=${encodeURIComponent(search)}`);
    const data = await response.json();
    
    const results = data.results || data;

    if (!results.length) {
      searchResultsDiv.innerHTML = `<div class="info-box">No stock found.</div>`;
      return;
    }

    searchResultsDiv.innerHTML = `
      <div class="holdings-list">
        ${results.map(item => `
          <button class="holding-row" data-stock-symbol="${item.symbol}" style="width:100%; border:0; color:white; background:transparent; text-align:left;">
            <div class="holding-symbol">
              <div class="symbol-box">${item.symbol.slice(0, 3)}</div>
              <div>
                <strong>${item.symbol}</strong>
                <small>${item.name || item.exchange}</small>
              </div>
            </div>
            <div class="holding-price">
              <strong>${item.price ? formatMoney(item.price) : 'NSE'}</strong>
            </div>
          </button>
        `).join("")}
      </div>
    `;
    bindStockSelectionEvents();
  } catch (error) {
    console.error("Search fetch error:", error);
  }
}

function bindDynamicEvents() {
  const stockSearch = document.getElementById("stockSearch");

 /* if (stockSearch) {
    stockSearch.addEventListener("input", () => {
      document.getElementById("stockSearchResults").innerHTML =
        renderStockSearchResults(stockSearch.value);

      bindStockSelectionEvents();
    });

    bindStockSelectionEvents();
  }
  
      if (stockSearch) {
    stockSearch.addEventListener("input", async () => {
      await renderStockSearchResults(stockSearch.value);
    });

    bindStockSelectionEvents();
  }

  const orderType = document.getElementById("orderType");

  if (orderType) {
    orderType.addEventListener("change", () => {
      const limitGroup = document.getElementById("limitPriceGroup");

      limitGroup.style.display =
        orderType.value === "LIMIT"
          ? "block"
          : "none";
    });
  }

  const orderStock = document.getElementById("orderStock");

  if (orderStock) {
    orderStock.addEventListener("change", () => {
      const stock = stockList.find(
        (item) => item.symbol === orderStock.value
      );

      if (stock) {
        state.selectedStock = { ...stock };
        renderCurrentPage();
      }
    });
  }
}
*/
async function renderStockSearchResults(searchText) {
  const search = searchText.trim();
  const searchResultsDiv = document.getElementById("stockSearchResults");

  if (!search) {
    searchResultsDiv.innerHTML = stockList.map(item => `...`).join(""); 
    return;
  }

  try {
    const response = await fetch(`/api/stocks/search?q=${encodeURIComponent(search)}`);
    const data = await response.json();
    
    const results = data.results || data;

    if (!results.length) {
      searchResultsDiv.innerHTML = `<div class="info-box">No stock found.</div>`;
      return;
    }

    searchResultsDiv.innerHTML = `
      <div class="holdings-list">
        ${results.map(item => `
          <button class="holding-row" data-stock-symbol="${item.symbol}" style="width:100%; border:0; color:white; background:transparent; text-align:left;">
            <div class="holding-symbol">
              <div class="symbol-box">${item.symbol.slice(0, 3)}</div>
              <div>
                <strong>${item.symbol}</strong>
                <small>${item.name || item.exchange}</small>
              </div>
            </div>
            <div class="holding-price">
              <strong>${item.price ? formatMoney(item.price) : 'NSE'}</strong>
            </div>
          </button>
        `).join("")}
      </div>
    `;
    bindStockSelectionEvents();
  } catch (error) {
    console.error("Search fetch error:", error);
  }
}

function bindDynamicEvents() {
  const stockSearch = document.getElementById("stockSearch");

  if (stockSearch) {
    stockSearch.addEventListener("input", async () => {
      await renderStockSearchResults(stockSearch.value);
    });

    bindStockSelectionEvents();
  }

  const orderType = document.getElementById("orderType");

  if (orderType) {
    orderType.addEventListener("change", () => {
      const limitGroup = document.getElementById("limitPriceGroup");

      limitGroup.style.display =
        orderType.value === "LIMIT"
          ? "block"
          : "none";
    });
  }

  const orderStock = document.getElementById("orderStock");

  if (orderStock) {
    orderStock.addEventListener("change", () => {
      const stock = stockList.find(
        (item) => item.symbol === orderStock.value
      );

      if (stock) {
        state.selectedStock = { ...stock };
        renderCurrentPage();
      }
    });
  }
}

function bindStockSelectionEvents() {
  document.querySelectorAll("[data-stock-symbol]").forEach((button) => {
    button.addEventListener("click", () => {
      const stock = stockList.find(
        (item) => item.symbol === button.dataset.stockSymbol
      );

      if (stock) {
        state.selectedStock = { ...stock };
        showToast(`${stock.symbol} selected by user.`);
        renderCurrentPage();
      }
    });
  });
}

function prepareOrderFromForm() {
  const selectedSymbol = document.getElementById("orderStock")?.value;
  const quantity = Number(
    document.getElementById("orderQuantity")?.value || 1
  );
  const targetPercentage = Number(
    document.getElementById("targetPercentage")?.value || 8
  );
  const maxDays = Number(
    document.getElementById("maxDays")?.value || 30
  );

  const selectedStock = stockList.find(
    (item) => item.symbol === selectedSymbol
  );

  if (!selectedStock) {
    showToast("Please select a valid stock.");
    return;
  }

  if (quantity <= 0) {
    showToast("Quantity must be greater than zero.");
    return;
  }

  if (targetPercentage <= 0) {
    showToast("Target must be greater than zero.");
    return;
  }

  state.selectedStock = { ...selectedStock };
  state.amount = quantity * selectedStock.price;
  state.maxDays = maxDays;

  state.strategy = {
    ...state.strategy,
    symbol: selectedStock.symbol,
    quantity,
    purchasePrice: selectedStock.price,
    currentPrice: selectedStock.price,
    highestPrice: selectedStock.price,
    stopLoss: selectedStock.price,
    targetPrice: selectedStock.price * (1 + targetPercentage / 100),
    targetPercentage,
    investmentAmount: quantity * selectedStock.price,
    dayNumber: 0,
    status: "AWAITING_CONFIRMATION",
  };

  showToast("Order preview updated.");
  renderCurrentPage();
}

function confirmPaperOrder() {
  const strategy = state.strategy;

  if (!strategy.symbol || strategy.quantity <= 0) {
    showToast("Complete the order details first.");
    return;
  }

  const newHistoryItem = {
    date: formatDate(new Date()),
    symbol: strategy.symbol,
    action: "BUY",
    amount: strategy.investmentAmount,
    result:
      state.mode === "paper"
        ? "Paper order completed"
        : "Sent to backend for Kite execution",
    status: state.mode === "paper" ? "COMPLETED" : "PENDING",
  };

  state.history.unshift(newHistoryItem);

  state.strategy.status =
    state.mode === "paper"
      ? "MONITORING"
      : "ORDER_PENDING";

  state.strategy.active = true;
  state.strategy.startDate = formatDate(new Date());

  showToast(
    state.mode === "paper"
      ? "Paper order completed. Monitor started."
      : "Live order request prepared. Backend confirmation required."
  );

  navigate("monitor");
}

function exitStrategy(reason) {
  const strategy = state.strategy;

  if (!strategy.active && strategy.status !== "MONITORING") {
    showToast("There is no active strategy.");
    return;
  }

  const exitPrice = strategy.currentPrice;
  const exitAmount = exitPrice * strategy.quantity;
  const profit = exitAmount - strategy.investmentAmount;

  state.history.unshift({
    date: formatDate(new Date()),
    symbol: strategy.symbol,
    action: "SELL",
    amount: exitAmount,
    result: reason === "MANUAL_EXIT"
      ? `Manual exit, ${formatSignedMoney(profit)}`
      : reason,
    status: "EXITED",
  });

  state.previousReturn = Math.max(0, profit);

  state.strategy.active = false;
  state.strategy.status = reason;
  state.strategy.dayNumber = 0;

  showToast(`Strategy exited. Result: ${formatSignedMoney(profit)}`);
  renderCurrentPage();
}
function calculateSummary() {
  const holdings = getHoldings();

  const invested = holdings.reduce(
    (total, item) => total + item.buyPrice * item.quantity,
    0
  );

  const currentValue = holdings.reduce(
    (total, item) => total + item.currentPrice * item.quantity,
    0
  );

  const profitLoss = currentValue - invested;

  return {
    invested,
    currentValue,
    profitLoss,
    returnPercentage: invested
      ? (profitLoss / invested) * 100
      : 0,
  };
}

function getHoldings() {
  const strategy = state.strategy;

  if (!strategy.symbol || !strategy.quantity) {
    return [];
  }

  return [
    {
      symbol: strategy.symbol,
      quantity: strategy.quantity,
      buyPrice: strategy.purchasePrice,
      currentPrice: strategy.currentPrice,
      currentValue: strategy.currentPrice * strategy.quantity,
      profit:
        (strategy.currentPrice - strategy.purchasePrice) *
        strategy.quantity,
    },
  ];
}

function statCard(label, value, change, icon, color) {
  return `
    <div class="stat-card ${color}">
      <div class="stat-top">
        <span>${label}</span>
        <div class="stat-icon">${icon}</div>
      </div>

      <div class="stat-value">${value}</div>
      <div class="stat-change">${change}</div>
    </div>
  `;
}

function metricBox(label, value) {
  return `
    <div class="metric-box">
      <small>${label}</small>
      <strong>${value}</strong>
    </div>
  `;
}

function previewRow(label, value) {
  return `
    <div class="preview-row">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function formatMoney(value) {
  return `₹${Math.round(Number(value) || 0).toLocaleString("en-IN")}`;
}

function formatSignedMoney(value) {
  const number = Math.round(Number(value) || 0);
  return `${number >= 0 ? "+" : "-"}₹${Math.abs(number).toLocaleString("en-IN")}`;
}

function formatDate(date) {
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(window.toastTimer);

  window.toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}
window.showToast = showToast;

renderCurrentPage();