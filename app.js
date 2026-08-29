"use strict";

const API_BASE = "";

// Change this value to your actual investment amount.
let investmentAmount = 5000;

document.addEventListener(
  "DOMContentLoaded",
  initializeApp
);

function initializeApp() {
  setupNavigation();
  checkKiteConnection();

  /*
    If your AI Recommendation page should open
    automatically, uncomment the next line.

    showAiRecommendationPage();
  */
}

/*
  Navigation
*/

function setupNavigation() {
  const aiButtons = document.querySelectorAll(
    "[data-page='ai-recommendation'], " +
    "#aiRecommendationButton, " +
    "#aiPicksButton, " +
    ".ai-recommendation-link"
  );

  aiButtons.forEach((button) => {
    button.addEventListener(
      "click",
      function (event) {
        event.preventDefault();
        showAiRecommendationPage();
      }
    );
  });
}

/*
  Find the main application container.
  This supports common IDs used in existing HTML.
*/

function getPageContainer() {
  const possibleIds = [
    "content",
    "mainContent",
    "pageContent",
    "appContent",
    "contentArea",
    "main"
  ];

  for (const id of possibleIds) {
    const element =
      document.getElementById(id);

    if (element) {
      return element;
    }
  }

  return null;
}

/*
  AI Recommendation page
*/

function showAiRecommendationPage() {
  const container =
    getPageContainer();

  if (!container) {
    console.error(
      "No page container found. " +
      "Add id='content' to your main page container."
    );

    return;
  }

  container.innerHTML = `
    <section class="ai-recommendation-page">

      <div class="ai-header">
        <h2>AI Recommendation</h2>
        <p>
          Search any NSE stock and get a live
          Kite-based recommendation.
        </p>
      </div>

      <div class="investment-box">
        <label for="investmentAmount">
          Investment amount
        </label>

        <input
          id="investmentAmount"
          type="number"
          min="1"
          step="1"
          value="${investmentAmount}"
          placeholder="Enter amount"
        />
      </div>

      <div class="stock-search-box">
        <input
          id="stockSearch"
          type="search"
          placeholder="Search stock, e.g. INFY"
          autocomplete="off"
        />

        <button
          id="stockSearchButton"
          type="button">
          Search
        </button>
      </div>

      <div
        id="searchMessage"
        class="search-message">
      </div>

      <div
        id="searchResults"
        class="search-results">
      </div>

      <div
        id="selectedStockCard"
        class="selected-stock-card"
        hidden>

        <h3 id="selectedStockSymbol">
          No stock selected
        </h3>

        <p>
          Live price:
          <strong id="selectedStockPrice">
            --
          </strong>
        </p>

        <p id="selectedStockDetails">
        </p>

        <div
          id="aiRecommendation"
          class="ai-result">
          Search for a stock to receive a recommendation.
        </div>
      </div>

    </section>
  `;

  const searchButton =
    document.getElementById(
      "stockSearchButton"
    );

  const searchInput =
    document.getElementById(
      "stockSearch"
    );

  const amountInput =
    document.getElementById(
      "investmentAmount"
    );

  if (searchButton) {
    searchButton.addEventListener(
      "click",
      searchStocks
    );
  }

  if (searchInput) {
    searchInput.addEventListener(
      "keydown",
      function (event) {
        if (event.key === "Enter") {
          searchStocks();
        }
      }
    );

    searchInput.addEventListener(
      "input",
      clearSearchMessage
    );
  }

  if (amountInput) {
    amountInput.addEventListener(
      "input",
      function () {
        const value =
          Number(amountInput.value);

        if (Number.isFinite(value) && value > 0) {
          investmentAmount = value;

          const selectedSymbol =
            document.getElementById(
              "selectedStockSymbol"
            )?.dataset.symbol;

          const selectedPrice =
            document.getElementById(
              "selectedStockPrice"
            )?.dataset.price;

          if (
            selectedSymbol &&
            selectedPrice
          ) {
            updateAiRecommendation(
              selectedSymbol,
              Number(selectedPrice)
            );
          }
        }
      }
    );
  }

  if (searchInput) {
    searchInput.focus();
  }
}

/*
  Search stocks from backend
*/

async function searchStocks() {
  const input =
    document.getElementById(
      "stockSearch"
    );

  const resultsBox =
    document.getElementById(
      "searchResults"
    );

  const messageBox =
    document.getElementById(
      "searchMessage"
    );

  if (!input || !resultsBox) {
    console.error(
      "Search elements are not available."
    );

    return;
  }

  const query =
    input.value.trim();

  if (!query) {
    showMessage(
      messageBox,
      "Enter a stock symbol or company name.",
      "error"
    );

    resultsBox.innerHTML = "";
    return;
  }

  showMessage(
    messageBox,
    "Searching stocks from Kite...",
    "loading"
  );

  resultsBox.innerHTML = "";

  try {
    const response = await fetch(
      `${API_BASE}/api/stocks/search?q=` +
      encodeURIComponent(query),
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      }
    );

    const data =
      await readJson(response);

    if (response.status === 401) {
      showMessage(
        messageBox,
        "Kite is not connected. Connect Kite first.",
        "error"
      );

      return;
    }

    if (!response.ok || !data.success) {
      showMessage(
        messageBox,
        data.message ||
          "Stock search failed.",
        "error"
      );

      return;
    }

    const stocks =
      Array.isArray(data.results)
        ? data.results
        : [];

    if (stocks.length === 0) {
      showMessage(
        messageBox,
        "No matching NSE stock found.",
        "error"
      );

      return;
    }

    showMessage(
      messageBox,
      `${stocks.length} stock(s) found.`,
      "success"
    );

    renderSearchResults(
      stocks,
      resultsBox
    );
  } catch (error) {
    console.error(
      "Stock search error:",
      error
    );

    showMessage(
      messageBox,
      "Unable to connect to the backend.",
      "error"
    );
  }
}

/*
  Render dynamic search results
*/

function renderSearchResults(
  stocks,
  resultsBox
) {
  resultsBox.innerHTML = stocks
    .map(function (stock) {
      const exchange =
        stock.exchange || "NSE";

      const symbol =
        stock.symbol ||
        stock.tradingsymbol ||
        "";

      const name =
        stock.name || "";

      return `
        <button
          type="button"
          class="stock-result"
          data-exchange="${escapeHtml(exchange)}"
          data-symbol="${escapeHtml(symbol)}">

          <span class="stock-result-title">
            ${escapeHtml(exchange)}:${escapeHtml(symbol)}
          </span>

          <span class="stock-result-name">
            ${escapeHtml(name)}
          </span>

          <span class="stock-result-action">
            Get live price
          </span>
        </button>
      `;
    })
    .join("");

  resultsBox
    .querySelectorAll(".stock-result")
    .forEach(function (button) {
      button.addEventListener(
        "click",
        function () {
          loadLiveQuote(
            button.dataset.exchange,
            button.dataset.symbol
          );
        }
      );
    });
}

/*
  Load selected stock price
*/

async function loadLiveQuote(
  exchange,
  symbol
) {
  const card =
    document.getElementById(
      "selectedStockCard"
    );

  const symbolElement =
    document.getElementById(
      "selectedStockSymbol"
    );

  const priceElement =
    document.getElementById(
      "selectedStockPrice"
    );

  const detailsElement =
    document.getElementById(
      "selectedStockDetails"
    );

  const recommendationElement =
    document.getElementById(
      "aiRecommendation"
    );

  if (card) {
    card.hidden = false;
  }

  if (symbolElement) {
    symbolElement.textContent =
      `${exchange}:${symbol}`;

    symbolElement.dataset.symbol =
      symbol;
  }

  if (priceElement) {
    priceElement.textContent =
      "Loading...";
  }

  if (detailsElement) {
    detailsElement.textContent =
      "Requesting current price from Kite...";
  }

  if (recommendationElement) {
    recommendationElement.textContent =
      "Preparing recommendation...";
  }

  try {
    const response = await fetch(
      `${API_BASE}/api/market/quote?symbol=` +
      encodeURIComponent(symbol),
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      }
    );

    const data =
      await readJson(response);

    if (response.status === 401) {
      throw new Error(
        "Kite connection expired. " +
        "Please connect Kite again."
      );
    }

    if (!response.ok || !data.success) {
      throw new Error(
        data.message ||
          "Live price could not be loaded."
      );
    }

    const price =
      Number(data.last_price);

    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(
        "Kite returned an invalid price."
      );
    }

    if (priceElement) {
      priceElement.textContent =
        `₹${formatNumber(price)}`;

      priceElement.dataset.price =
        String(price);
    }

    if (detailsElement) {
      detailsElement.textContent =
        "Live price received from Kite Connect.";
    }

    updateAiRecommendation(
      symbol,
      price
    );
  } catch (error) {
    console.error(
      "Live quote error:",
      error
    );

    if (priceElement) {
      priceElement.textContent =
        "Unavailable";
    }

    if (detailsElement) {
      detailsElement.textContent =
        error.message;
    }

    if (recommendationElement) {
      recommendationElement.textContent =
        "Recommendation unavailable.";
    }
  }
}

/*
  Dynamic AI recommendation
*/

function updateAiRecommendation(
  symbol,
  price
) {
  const element =
    document.getElementById(
      "aiRecommendation"
    );

  if (!element) return;

  const amount =
    Number(investmentAmount);

  if (!Number.isFinite(amount) || amount <= 0) {
    element.textContent =
      "Enter a valid investment amount.";
    return;
  }

  const quantity =
    Math.floor(amount / price);

  if (quantity < 1) {
    element.innerHTML = `
      <strong>Not suitable for this budget</strong>
      <br>
      ${escapeHtml(symbol)} price is
      ₹${formatNumber(price)}.
      <br>
      Your investment amount is
      ₹${formatNumber(amount)}.
    `;

    return;
  }

  const total =
    quantity * price;

  const remaining =
    amount - total;

  element.innerHTML = `
    <strong>AI Recommendation</strong>
    <br>
    Based on the current Kite price, you could consider
    <strong>${quantity}</strong> share(s) of
    <strong>${escapeHtml(symbol)}</strong>.
    <br>
    Estimated amount:
    <strong>₹${formatNumber(total)}</strong>
    <br>
    Remaining amount:
    <strong>₹${formatNumber(remaining)}</strong>
    <br>
    <small>
      This is a calculation, not investment advice.
    </small>
  `;
}

/*
  Kite connection status
*/

async function checkKiteConnection() {
  const statusElement =
    document.getElementById(
      "kiteConnectionStatus"
    );

  if (!statusElement) {
    return;
  }

  try {
    const response = await fetch(
      `${API_BASE}/api/auth/status`,
      {
        headers: {
          Accept: "application/json"
        }
      }
    );

    const data =
      await readJson(response);

    if (data.connected) {
      statusElement.textContent =
        "Kite Connected";

      statusElement.style.color =
        "#16a34a";
    } else {
      statusElement.textContent =
        "Kite Not Connected";

      statusElement.style.color =
        "#dc2626";
    }
  } catch (error) {
    console.error(
      "Connection status error:",
      error
    );

    statusElement.textContent =
      "Connection status unavailable";
  }
}

/*
  Utility functions
*/

async function readJson(response) {
  const text =
    await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      success: false,
      message: text
    };
  }
}

function clearSearchMessage() {
  const messageBox =
    document.getElementById(
      "searchMessage"
    );

  if (messageBox) {
    messageBox.textContent = "";
  }
}

function showMessage(
  element,
  message,
  type
) {
  if (!element) return;

  element.textContent =
    message;

  element.className =
    `search-message ${type || ""}`;
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