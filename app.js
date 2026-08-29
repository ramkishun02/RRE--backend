"use strict";

const API = "";

const state = {
  page: "dashboard",
  investmentAmount: 5000,
  selectedStock: null,
  selectedPrice: null,
  watchlist: loadStorage("rre_watchlist", []),
  user: loadStorage("rre_user", null)
};

document.addEventListener(
  "DOMContentLoaded",
  startApp
);

function startApp() {
  const container =
    findPageContainer();

  if (!container) {
    showFatalError(
      "pageContainer is missing in index.html"
    );

    return;
  }

  createApplicationLayout(container);
  bindApplicationEvents();
  showPage("dashboard");
  loadKiteStatus();
}

function findPageContainer() {
  return (
    document.getElementById("pageContainer") ||
    document.getElementById("content") ||
    document.getElementById("mainContent") ||
    document.querySelector("main")
  );
}

function createApplicationLayout(
  container
) {
  container.innerHTML = `
    <div class="rre-application">

      <header class="rre-header">
        <div>
          <h1>RRE Dashboard</h1>
          <span id="kiteStatus">
            Checking Kite connection...
          </span>
        </div>

        <button
          id="logoutButton"
          type="button">
          Logout
        </button>
      </header>

      <div class="rre-body">

        <aside class="rre-sidebar">
          <button
            class="nav-button"
            data-page="dashboard">
            Dashboard
          </button>

          <button
            class="nav-button"
            data-page="ai">
            AI Recommendation
          </button>

          <button
            class="nav-button"
            data-page="portfolio">
            Portfolio
          </button>

          <button
            class="nav-button"
            data-page="watchlist">
            Watchlist
          </button>

          <button
            class="nav-button"
            data-page="orders">
            Orders
          </button>

          <button
            class="nav-button"
            data-page="profile">
            Profile
          </button>

          <button
            class="nav-button"
            data-page="settings">
            Settings
          </button>
        </aside>

        <main
          id="rrePageContent"
          class="rre-page-content">
        </main>

      </div>
    </div>
  `;
}

function bindApplicationEvents() {
  document
    .querySelectorAll(".nav-button")
    .forEach((button) => {
      button.addEventListener(
        "click",
        () => {
          showPage(button.dataset.page);
        }
      );
    });

  const logoutButton =
    document.getElementById(
      "logoutButton"
    );

  if (logoutButton) {
    logoutButton.addEventListener(
      "click",
      logout
    );
  }
}

function showPage(page) {
  state.page = page;

  const content =
    document.getElementById(
      "rrePageContent"
    );

  if (!content) return;

  document
    .querySelectorAll(".nav-button")
    .forEach((button) => {
      button.classList.toggle(
        "active",
        button.dataset.page === page
      );
    });

  if (page === "dashboard") {
    renderDashboard(content);
  } else if (page === "ai") {
    renderAiRecommendation(content);
  } else if (page === "portfolio") {
    renderPortfolio(content);
  } else if (page === "watchlist") {
    renderWatchlist(content);
  } else if (page === "orders") {
    renderOrders(content);
  } else if (page === "profile") {
    renderProfile(content);
  } else if (page === "settings") {
    renderSettings(content);
  } else {
    renderDashboard(content);
  }
}

/*
  Dashboard
*/

function renderDashboard(content) {
  content.innerHTML = `
    <section class="page">
      <h2>Dashboard</h2>

      <div class="card-grid">
        <div class="card">
          <h3>Kite Status</h3>
          <p id="dashboardKiteStatus">
            Checking...
          </p>
        </div>

        <div class="card">
          <h3>Watchlist Stocks</h3>
          <p>${state.watchlist.length}</p>
        </div>

        <div class="card">
          <h3>Investment Amount</h3>
          <p>
            ₹${formatNumber(
              state.investmentAmount
            )}
          </p>
        </div>
      </div>

      <div class="card">
        <h3>Get Live NSE Quote</h3>

        <input
          id="dashboardSymbol"
          type="text"
          placeholder="Enter symbol e.g. TCS"
        />

        <button
          id="dashboardQuoteButton"
          type="button">
          Get Quote
        </button>

        <div id="dashboardQuoteResult"></div>
      </div>
    </section>
  `;

  document
    .getElementById(
      "dashboardQuoteButton"
    )
    .addEventListener(
      "click",
      () => {
        const symbol =
          document
            .getElementById(
              "dashboardSymbol"
            )
            .value
            .trim()
            .toUpperCase();

        getQuote(
          symbol,
          "dashboardQuoteResult"
        );
      }
    );

  loadKiteStatus();
}

/*
  AI Recommendation
*/

function renderAiRecommendation(
  content
) {
  content.innerHTML = `
    <section class="page">
      <h2>AI Recommendation</h2>

      <label>
        Investment amount
        <input
          id="aiInvestmentAmount"
          type="number"
          min="1"
          value="${state.investmentAmount}"
        />
      </label>

      <div class="search-row">
        <input
          id="aiSearchInput"
          type="search"
          placeholder="Search stock or company"
        />

        <button
          id="aiSearchButton"
          type="button">
          Search
        </button>
      </div>

      <p id="aiSearchMessage"></p>

      <div id="aiSearchResults"></div>

      <div
        id="aiSelectedStock"
        class="card">
        No stock selected.
      </div>

      <div
        id="aiResult"
        class="card">
        Search a stock to get a recommendation.
      </div>
    </section>
  `;

  document
    .getElementById(
      "aiSearchButton"
    )
    .addEventListener(
      "click",
      searchStocks
    );

  document
    .getElementById(
      "aiSearchInput"
    )
    .addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter") {
          searchStocks();
        }
      }
    );

  document
    .getElementById(
      "aiInvestmentAmount"
    )
    .addEventListener(
      "input",
      (event) => {
        const amount =
          Number(event.target.value);

        if (amount > 0) {
          state.investmentAmount =
            amount;

          if (
            state.selectedStock &&
            state.selectedPrice
          ) {
            updateRecommendation();
          }
        }
      }
    );
}

async function searchStocks() {
  const input =
    document.getElementById(
      "aiSearchInput"
    );

  const message =
    document.getElementById(
      "aiSearchMessage"
    );

  const results =
    document.getElementById(
      "aiSearchResults"
    );

  const query =
    input.value.trim();

  if (!query) {
    message.textContent =
      "Enter a stock symbol.";

    return;
  }

  message.textContent =
    "Searching...";

  results.innerHTML = "";

  try {
    const response = await fetch(
      `${API}/api/stocks/search?q=` +
      encodeURIComponent(query)
    );

    const data =
      await response.json();

    if (!response.ok || !data.success) {
      message.textContent =
        data.message ||
        "Search failed.";

      return;
    }

    const stocks =
      Array.isArray(data.results)
        ? data.results
        : [];

    if (!stocks.length) {
      message.textContent =
        "No stock found.";

      return;
    }

    message.textContent =
      "Select a stock:";

    stocks.forEach((stock) => {
      const button =
        document.createElement(
          "button"
        );

      button.type = "button";
      button.className =
        "stock-result";

      button.textContent =
        `${stock.exchange || "NSE"}:` +
        `${stock.symbol}` +
        `${stock.name ? " - " + stock.name : ""}`;

      button.addEventListener(
        "click",
        () => {
          loadSelectedStock(
            stock.exchange || "NSE",
            stock.symbol
          );
        }
      );

      results.appendChild(button);
    });
  } catch (error) {
    console.error(error);

    message.textContent =
      "Backend connection failed.";
  }
}

async function loadSelectedStock(
  exchange,
  symbol
) {
  const selected =
    document.getElementById(
      "aiSelectedStock"
    );

  selected.textContent =
    `${exchange}:${symbol} loading...`;

  try {
    const data =
      await requestJson(
        `/api/market/quote?symbol=` +
        encodeURIComponent(symbol)
      );

    const price =
      Number(data.last_price);

    state.selectedStock =
      symbol;

    state.selectedPrice =
      price;

    selected.textContent =
      `${exchange}:${symbol} - ₹` +
      formatNumber(price);

    updateRecommendation();
    addToWatchlist(symbol);
  } catch (error) {
    selected.textContent =
      error.message;
  }
}

function updateRecommendation() {
  const output =
    document.getElementById(
      "aiResult"
    );

  if (!output) return;

  const amount =
    Number(state.investmentAmount);

  const price =
    Number(state.selectedPrice);

  const quantity =
    Math.floor(amount / price);

  if (quantity < 1) {
    output.innerHTML = `
      <strong>
        ${escapeHtml(
          state.selectedStock
        )}
      </strong>
      is above your investment amount.
      <br>
      Price: ₹${formatNumber(price)}
      <br>
      Investment amount: ₹${formatNumber(amount)}
    `;

    return;
  }

  const used =
    quantity * price;

  output.innerHTML = `
    <h3>Recommendation</h3>
    <p>
      Stock:
      <strong>
        ${escapeHtml(
          state.selectedStock
        )}
      </strong>
    </p>
    <p>
      Possible quantity:
      <strong>${quantity}</strong>
    </p>
    <p>
      Estimated investment:
      <strong>₹${formatNumber(used)}</strong>
    </p>
    <p>
      Remaining amount:
      <strong>
        ₹${formatNumber(amount - used)}
      </strong>
    </p>
    <small>
      This is a calculation, not financial advice.
    </small>
  `;
}

/*
  Portfolio
*/

async function renderPortfolio(content) {
  content.innerHTML = `
    <section class="page">
      <h2>Portfolio</h2>
      <div id="portfolioResult">
        Loading portfolio...
      </div>
    </section>
  `;

  try {
    const holdings =
      await requestJson(
        "/api/portfolio/holdings"
      );

    const positions =
      await requestJson(
        "/api/portfolio/positions"
      );

    const holdingRows =
      Array.isArray(holdings.data)
        ? holdings.data
        : Array.isArray(holdings.holdings)
          ? holdings.holdings
          : [];

    const positionRows =
      Array.isArray(positions.data)
        ? positions.data
        : Array.isArray(positions.net)
          ? positions.net
          : [];

    document
      .getElementById(
        "portfolioResult"
      )
      .innerHTML = `
        <div class="card">
          <h3>Holdings</h3>
          ${renderRows(
            holdingRows
          )}
        </div>

        <div class="card">
          <h3>Positions</h3>
          ${renderRows(
            positionRows
          )}
        </div>
      `;
  } catch (error) {
    document
      .getElementById(
        "portfolioResult"
      )
      .textContent =
      error.message;
  }
}

/*
  Watchlist
*/

function renderWatchlist(content) {
  content.innerHTML = `
    <section class="page">
      <h2>Watchlist</h2>
      <div id="watchlistResult">
        ${
          state.watchlist.length
            ? state.watchlist
                .map(
                  (symbol) => `
                    <div class="card">
                      <strong>
                        ${escapeHtml(symbol)}
                      </strong>

                      <button
                        type="button"
                        data-watch-symbol="${escapeHtml(symbol)}">
                        Get Quote
                      </button>

                      <span
                        id="watch-${escapeHtml(symbol)}">
                      </span>
                    </div>
                  `
                )
                .join("")
            : "<p>Your watchlist is empty.</p>"
        }
      </div>
    </section>
  `;

  document
    .querySelectorAll(
      "[data-watch-symbol]"
    )
    .forEach((button) => {
      button.addEventListener(
        "click",
        () => {
          getQuote(
            button.dataset.watchSymbol,
            `watch-${button.dataset.watchSymbol}`
          );
        }
      );
    });
}

function addToWatchlist(symbol) {
  if (!symbol) return;

  if (!state.watchlist.includes(symbol)) {
    state.watchlist.push(symbol);

    saveStorage(
      "rre_watchlist",
      state.watchlist
    );
  }
}

/*
  Orders
*/

function renderOrders(content) {
  content.innerHTML = `
    <section class="page">
      <h2>Orders</h2>

      <div id="ordersResult">
        Loading orders...
      </div>
    </section>
  `;

  loadOrders();
}

async function loadOrders() {
  try {
    const data =
      await requestJson(
        "/api/orders"
      );

    const orders =
      Array.isArray(data.data)
        ? data.data
        : Array.isArray(data.orders)
          ? data.orders
          : [];

    document
      .getElementById(
        "ordersResult"
      )
      .innerHTML =
      renderRows(orders);
  } catch (error) {
    document
      .getElementById(
        "ordersResult"
      )
      .textContent =
      error.message;
  }
}

/*
  Profile
*/

function renderProfile(content) {
  content.innerHTML = `
    <section class="page">
      <h2>Profile</h2>

      <div class="card">
        <p>
          User ID:
          <strong id="profileUserId">
            Loading...
          </strong>
        </p>

        <button
          id="refreshProfileButton"
          type="button">
          Refresh Profile
        </button>
      </div>
    </section>
  `;

  loadProfile();
}

async function loadProfile() {
  try {
    const data =
      await requestJson(
        "/api/user/profile"
      );

    document
      .getElementById(
        "profileUserId"
      )
      .textContent =
      data.user_id ||
      data.data?.user_id ||
      "Connected";
  } catch (error) {
    document
      .getElementById(
        "profileUserId"
      )
      .textContent =
      error.message;
  }
}

/*
  Settings
*/

function renderSettings(content) {
  content.innerHTML = `
    <section class="page">
      <h2>Settings</h2>

      <div class="card">
        <label>
          Default investment amount
          <input
            id="settingsInvestmentAmount"
            type="number"
            min="1"
            value="${state.investmentAmount}"
          />
        </label>

        <button
          id="saveSettingsButton"
          type="button">
          Save Settings
        </button>

        <p id="settingsMessage"></p>
      </div>
    </section>
  `;

  document
    .getElementById(
      "saveSettingsButton"
    )
    .addEventListener(
      "click",
      () => {
        const amount =
          Number(
            document.getElementById(
              "settingsInvestmentAmount"
            ).value
          );

        if (amount <= 0) {
          return;
        }

        state.investmentAmount =
          amount;

        saveStorage(
          "rre_investment_amount",
          amount
        );

        document
          .getElementById(
            "settingsMessage"
          )
          .textContent =
          "Settings saved.";
      }
    );
}

/*
  Quote
*/

async function getQuote(
  symbol,
  outputId
) {
  const output =
    document.getElementById(outputId);

  if (!symbol) {
    output.textContent =
      "Enter a valid symbol.";

    return;
  }

  output.textContent =
    "Loading...";

  try {
    const data =
      await requestJson(
        `/api/market/quote?symbol=` +
        encodeURIComponent(symbol)
      );

    output.textContent =
      `₹${formatNumber(data.last_price)}`;
  } catch (error) {
    output.textContent =
      error.message;
  }
}

/*
  Kite status
*/

async function loadKiteStatus() {
  const status =
    document.getElementById(
      "kiteStatus"
    );

  if (!status) return;

  try {
    const data =
      await requestJson(
        "/api/auth/status"
      );

    status.textContent =
      data.connected ||
      data.accessTokenConfigured
        ? "Kite Connected"
        : "Kite Not Connected";
  } catch {
    status.textContent =
      "Kite status unavailable";
  }
}

/*
  Logout
*/

function logout() {
  localStorage.removeItem(
    "rre_user"
  );

  window.location.href =
    "/kite/login";
}

/*
  Request helpers
*/

async function requestJson(url) {
  const response =
    await fetch(API + url, {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    });

  const text =
    await response.text();

  let data = {};

  try {
    data =
      text ? JSON.parse(text) : {};
  } catch {
    data = {
      success: false,
      message: text
    };
  }

  if (!response.ok || data.success === false) {
    throw new Error(
      data.message ||
      `Request failed: ${response.status}`
    );
  }

  return data;
}

/*
  Rendering helpers
*/

function renderRows(rows) {
  if (!rows.length) {
    return "<p>No records available.</p>";
  }

  return `
    <div class="table-list">
      ${rows
        .map(
          (row) => `
            <div class="table-row">
              <strong>
                ${escapeHtml(
                  row.tradingsymbol ||
                  row.symbol ||
                  row.instrument_token ||
                  "Record"
                )}
              </strong>

              <span>
                Qty:
                ${escapeHtml(
                  row.quantity ||
                  row.net_quantity ||
                  row.qty ||
                  "-"
                )}
              </span>

              <span>
                P&L:
                ${escapeHtml(
                  row.pnl ??
                  row.unrealised ??
                  "-"
                )}
              </span>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function showFatalError(message) {
  document.body.innerHTML = `
    <div style="
      padding: 30px;
      font-family: Arial;
      color: white;
      background: #08111f;
    ">
      <h2>Application Error</h2>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function formatNumber(value) {
  return Number(value).toLocaleString(
    "en-IN",
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function loadStorage(key, fallback) {
  try {
    const value =
      localStorage.getItem(key);

    return value
      ? JSON.parse(value)
      : fallback;
  } catch {
    return fallback;
  }
}

function saveStorage(key, value) {
  localStorage.setItem(
    key,
    JSON.stringify(value)
  );
}