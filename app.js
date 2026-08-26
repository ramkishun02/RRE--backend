"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const stockSearch = document.getElementById("stockSearch");
  const searchButton = document.getElementById("searchStockButton");
  const searchResults = document.getElementById("searchResults");

  const logoutButton = document.getElementById("logoutButton");
  const logoutButton2 = document.getElementById("logoutButton2");

  const statusText = document.getElementById("kiteStatusText");
  const statusBox = document.getElementById("kiteSessionBox");
  const statusBox2 = document.getElementById("statusBox");

  const menuToggle = document.getElementById("menuToggle");
  const sidebar = document.getElementById("sidebar");

  async function checkKiteSession() {
    try {
      const response = await fetch("/api/auth/status");
      const data = await response.json();

      if (data.connected) {
        if (statusText) {
          statusText.textContent = "Kite connected";
        }

        if (statusBox) {
          statusBox.className = "kite-session-box connected";
          statusBox.textContent =
            `✓ Kite connected: ${data.userName || data.userId || "Authorized"}`;
        }

        if (statusBox2) {
          statusBox2.className = "success-box";
          statusBox2.textContent =
            `Kite session active for ${data.userName || data.userId || "your account"}`;
        }

        if (stockSearch) {
          stockSearch.disabled = false;
          stockSearch.placeholder = "Search stock, e.g. INFY";
        }

        if (searchButton) {
          searchButton.disabled = false;
        }
      } else {
        if (statusText) {
          statusText.textContent = "Kite not connected";
        }

        if (statusBox) {
          statusBox.className = "kite-session-box disconnected";
          statusBox.textContent =
            "Kite is not connected. Please connect your account.";
        }

        if (statusBox2) {
          statusBox2.className = "warning-box";
          statusBox2.textContent =
            "Connect Kite before searching stocks.";
        }

        if (stockSearch) {
          stockSearch.disabled = true;
          stockSearch.placeholder = "Connect Kite first";
        }

        if (searchButton) {
          searchButton.disabled = true;
        }
      }
    } catch (error) {
      console.error("Session check failed:", error);

      if (statusText) {
        statusText.textContent = "Status unavailable";
      }
    }
  }

  async function searchStocks() {
    if (!stockSearch || !searchResults) return;

    const query = stockSearch.value.trim();

    if (!query) {
      searchResults.innerHTML =
        `<div class="search-message">Enter a stock symbol</div>`;
      return;
    }

    if (searchButton) {
      searchButton.disabled = true;
      searchButton.textContent = "Searching...";
    }

    searchResults.innerHTML =
      `<div class="search-message">Searching...</div>`;

    try {
      const response = await fetch(
        `/api/stocks/search?q=${encodeURIComponent(query)}`
      );

      const data = await response.json();

      if (response.status === 401) {
        searchResults.innerHTML =
          `<div class="search-message">Please connect Kite first</div>`;
        return;
      }

      if (!response.ok) {
        throw new Error(data.error || "Search failed");
      }

      if (!Array.isArray(data) || data.length === 0) {
        searchResults.innerHTML =
          `<div class="search-message">No stock found</div>`;
        return;
      }

      searchResults.innerHTML = data
        .map(
          (stock) => `
            <button
              type="button"
              class="search-item"
              data-symbol="${escapeHtml(stock.symbol)}"
              data-name="${escapeHtml(stock.name)}"
              data-exchange="${escapeHtml(stock.exchange)}"
              data-price="${Number(stock.price || 0)}"
            >
              <strong>${escapeHtml(stock.symbol)}</strong>
              <span>${escapeHtml(stock.name)}</span>
              <small>
                ${escapeHtml(stock.exchange)} · ₹${Number(stock.price || 0)}
              </small>
            </button>
          `
        )
        .join("");
    } catch (error) {
      console.error("Search failed:", error);

      searchResults.innerHTML =
        `<div class="search-message">Search failed. Try again.</div>`;
    } finally {
      if (searchButton) {
        searchButton.disabled = false;
        searchButton.textContent = "Search";
      }
    }
  }

  async function logout() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
      });

      window.location.href = "/";
    } catch (error) {
      console.error("Logout failed:", error);
      alert("Logout failed");
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  if (searchButton) {
    searchButton.addEventListener("click", searchStocks);
  }

  if (stockSearch) {
    stockSearch.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        searchStocks();
      }
    });
  }

  if (searchResults) {
    searchResults.addEventListener("click", (event) => {
      const selected = event.target.closest(".search-item");

      if (!selected) return;

      const selectedStock = {
        symbol: selected.dataset.symbol,
        name: selected.dataset.name,
        exchange: selected.dataset.exchange,
        price: Number(selected.dataset.price || 0),
      };

      window.selectedStock = selectedStock;

      if (stockSearch) {
        stockSearch.value = selectedStock.symbol;
      }

      searchResults.innerHTML = `
        <div class="search-message">
          Selected: <strong>${escapeHtml(selectedStock.symbol)}</strong>
        </div>
      `;

      console.log("Selected stock:", selectedStock);
    });
  }

  if (logoutButton) {
    logoutButton.addEventListener("click", logout);
  }

  if (logoutButton2) {
    logoutButton2.addEventListener("click", logout);
  }

  if (menuToggle && sidebar) {
    menuToggle.addEventListener("click", () => {
      sidebar.classList.toggle("open");
    });
  }

  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-page]").forEach((item) => {
        item.classList.remove("active");
      });

      document
        .querySelectorAll(`[data-page="${button.dataset.page}"]`)
        .forEach((item) => {
          item.classList.add("active");
        });

      if (sidebar) {
        sidebar.classList.remove("open");
      }
    });
  });

  checkKiteSession();
});