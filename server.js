"use strict";
const path = require("path");
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = Number(process.env.PORT || 10000);

const KITE_API_KEY = process.env.KITE_API_KEY;
const KITE_API_SECRET = process.env.KITE_API_SECRET;

const BASE_URL =
  process.env.BASE_URL || "https://rre-backend-1.onrender.com";

const CALLBACK_URL =
  process.env.KITE_REDIRECT_URL || `${BASE_URL}/kite/callback`;

const DASHBOARD_URL =
  process.env.DASHBOARD_URL || `${BASE_URL}/dashboard`;

const DATABASE_URL = process.env.DATABASE_URL;

let db = null;

if (DATABASE_URL) {
  db = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false,
    },
  });

  db.on("error", (error) => {
    console.error("Unexpected PostgreSQL error:", error);
  });
}

// --------------------------------------------------
// HTML HELPERS
// --------------------------------------------------

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderPage(title, content) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      margin: 0;
      padding: 30px 15px;
      font-family: Arial, sans-serif;
      background: #f4f6f8;
      color: #222;
    }

    .card {
      max-width: 760px;
      margin: auto;
      padding: 30px;
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.12);
    }

    h1 {
      margin-top: 0;
    }

    .status {
      margin: 12px 0;
      font-size: 17px;
    }

    .ok {
      color: #148a32;
      font-weight: bold;
    }

    .bad {
      color: #c62828;
      font-weight: bold;
    }

    .button {
      display: inline-block;
      margin: 8px 6px 0 0;
      padding: 12px 18px;
      color: #fff;
      background: #1976d2;
      border: 0;
      border-radius: 8px;
      text-decoration: none;
      cursor: pointer;
      font-size: 15px;
    }

    .button:hover {
      background: #125ca3;
    }

    input {
      width: 100%;
      box-sizing: border-box;
      margin: 8px 0;
      padding: 12px;
      border: 1px solid #bbb;
      border-radius: 7px;
      font-size: 16px;
    }

    code {
      word-break: break-all;
    }

    pre {
      min-height: 80px;
      padding: 15px;
      white-space: pre-wrap;
      word-break: break-word;
      background: #f0f2f4;
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <main class="card">
    ${content}
  </main>
</body>
</html>
`;
}

// --------------------------------------------------
// DATABASE
// --------------------------------------------------

async function initializeDatabase() {
  if (!db) {
    console.log("DATABASE_URL not configured.");
    return;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS kite_tokens (
      id SERIAL PRIMARY KEY,
      access_token TEXT NOT NULL,
      user_id TEXT,
      login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("RRE database initialized.");
}

async function saveAccessToken(accessToken, userId, loginTime) {
  if (!db) {
    throw new Error("Database is not configured.");
  }

  await db.query("DELETE FROM kite_tokens");

  await db.query(
    `
      INSERT INTO kite_tokens (
        access_token,
        user_id,
        login_time,
        expires_at
      )
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '1 day')
    `,
    [accessToken, userId || null, loginTime || new Date()]
  );
}

async function getStoredKiteToken() {
  if (!db) {
    return null;
  }

  const result = await db.query(`
    SELECT access_token
    FROM kite_tokens
    WHERE expires_at IS NULL
       OR expires_at > CURRENT_TIMESTAMP
    ORDER BY id DESC
    LIMIT 1
  `);

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].access_token;
}

// --------------------------------------------------
// KITE HELPERS
// --------------------------------------------------

function createChecksum(apiKey, requestToken, apiSecret) {
  return crypto
    .createHash("sha256")
    .update(apiKey + requestToken + apiSecret)
    .digest("hex");
}

function getKiteLoginUrl() {
  return (
    "https://kite.zerodha.com/connect/login" +
    `?v=3&api_key=${encodeURIComponent(KITE_API_KEY)}`
  );
}

// --------------------------------------------------
// HOME PAGE
// --------------------------------------------------

app.get("/", async (req, res) => {
  try {
    const accessToken = await getStoredKiteToken();

    const databaseConfigured = Boolean(DATABASE_URL);
    const kiteConfigured = Boolean(
      KITE_API_KEY && KITE_API_SECRET
    );
    const tokenConfigured = Boolean(accessToken);

    res.send(
      renderPage(
        "RRE Backend",
        `
          <h1>RRE Backend</h1>

          <div class="status">
            Backend:
            <span class="ok">RUNNING</span>
          </div>

          <div class="status">
            Database:
            <span class="${databaseConfigured ? "ok" : "bad"}">
              ${databaseConfigured ? "CONFIGURED" : "NOT CONFIGURED"}
            </span>
          </div>

          <div class="status">
            Kite API:
            <span class="${kiteConfigured ? "ok" : "bad"}">
              ${kiteConfigured ? "CONFIGURED" : "NOT CONFIGURED"}
            </span>
          </div>

          <div class="status">
            Access token:
            <span class="${tokenConfigured ? "ok" : "bad"}">
              ${tokenConfigured ? "CONNECTED" : "NOT CONNECTED"}
            </span>
          </div>

          <hr>

          <p>
            <strong>Callback URL:</strong><br>
            <code>${escapeHtml(CALLBACK_URL)}</code>
          </p>

          <a class="button" href="/health">Health Check</a>
          <a class="button" href="/status">Status</a>
          <a class="button" href="/kite/login">Connect Kite</a>
          <a class="button" href="/index">Dashboard</a>
        `
      )
    );
  } catch (error) {
    console.error("Home route error:", error);

    res.status(500).send(
      renderPage(
        "Server Error",
        `
          <h1>Server error</h1>
          <p>${escapeHtml(error.message)}</p>
          <a class="button" href="/">Return home</a>
        `
      )
    );
  }
});

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/health", async (req, res) => {
  let databaseReady = false;

  if (db) {
    try {
      await db.query("SELECT 1");
      databaseReady = true;
    } catch (error) {
      console.error("Database health check failed:", error.message);
    }
  }

  const accessToken = await getStoredKiteToken();

  res.json({
    backend: true,
    databaseConfigured: Boolean(DATABASE_URL),
    databaseReady,
    kiteConfigured: Boolean(KITE_API_KEY && KITE_API_SECRET),
    accessTokenConfigured: Boolean(accessToken),
    callbackUrl: CALLBACK_URL,
    dashboardUrl: DASHBOARD_URL,
    timestamp: new Date().toISOString(),
  });
});

// --------------------------------------------------
// STATUS
// --------------------------------------------------

app.get("/status", async (req, res) => {
  let accessTokenConfigured = false;

  try {
    accessTokenConfigured = Boolean(await getStoredKiteToken());
  } catch (error) {
    console.error("Status token check failed:", error.message);
  }

  res.json({
    backend: true,
    apiKeyConfigured: Boolean(KITE_API_KEY),
    apiSecretConfigured: Boolean(KITE_API_SECRET),
    databaseConfigured: Boolean(DATABASE_URL),
    accessTokenConfigured,
    callbackUrl: CALLBACK_URL,
    dashboardUrl: DASHBOARD_URL,
    timestamp: new Date().toISOString(),
  });
});

// --------------------------------------------------
// KITE LOGIN
// --------------------------------------------------

app.get("/kite/login", (req, res) => {
  if (!KITE_API_KEY) {
    return res.status(500).send(
      renderPage(
        "Kite Configuration Error",
        `
          <h1>Kite configuration error</h1>
          <p>
            <code>KITE_API_KEY</code> is missing in the environment variables.
          </p>
          <a class="button" href="/">Return home</a>
        `
      )
    );
  }

  const loginUrl = getKiteLoginUrl();

  console.log("Redirecting to Kite login.");

  return res.redirect(loginUrl);
});

// --------------------------------------------------
// KITE CALLBACK
// --------------------------------------------------

app.get("/kite/callback", async (req, res) => {
  const {
    request_token: requestToken,
    status,
    message,
  } = req.query;

  console.log("Kite callback received.");
  console.log("Callback status:", status);

  if (status === "error") {
    return res.status(400).send(
      renderPage(
        "Kite Login Failed",
        `
          <h1>Kite login failed</h1>
          <p>${escapeHtml(message || "Kite returned an error.")}</p>
          <a class="button" href="/kite/login">Try again</a>
        `
      )
    );
  }

  if (!requestToken) {
    return res.status(400).send(
      renderPage(
        "Request Token Missing",
        `
          <h1>Request token missing</h1>
          <p>Kite did not return a request token.</p>
          <p>Verify this Redirect URL in the Kite developer console:</p>
          <p><code>${escapeHtml(CALLBACK_URL)}</code></p>
          <a class="button" href="/kite/login">Try again</a>
        `
      )
    );
  }

  if (!KITE_API_KEY || !KITE_API_SECRET) {
    return res.status(500).send(
      renderPage(
        "Kite Configuration Error",
        `
          <h1>Kite configuration error</h1>
          <p>
            Configure both <code>KITE_API_KEY</code> and
            <code>KITE_API_SECRET</code>.
          </p>
        `
      )
    );
  }

  if (!db) {
    return res.status(500).send(
      renderPage(
        "Database Configuration Error",
        `
          <h1>Database configuration error</h1>
          <p><code>DATABASE_URL</code> is not configured.</p>
        `
      )
    );
  }

  try {
    const checksum = createChecksum(
      KITE_API_KEY,
      requestToken,
      KITE_API_SECRET
    );

    const body = new URLSearchParams({
      api_key: KITE_API_KEY,
      request_token: requestToken,
      checksum,
    });

    const response = await fetch(
      "https://api.kite.trade/session/token",
      {
        method: "POST",
        headers: {
          "X-Kite-Version": "3",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      }
    );

    const result = await response.json();

    console.log(
      "Kite session response:",
      JSON.stringify({
        status: result.status,
        errorType: result.error_type,
        message: result.message,
      })
    );

    if (!response.ok || result.status !== "success") {
      return res.status(400).send(
        renderPage(
          "Kite Authentication Failed",
          `
            <h1>Kite authentication failed</h1>
            <p>${escapeHtml(
              result.message || "Token exchange failed."
            )}</p>
            <p>
              Error type:
              ${escapeHtml(result.error_type || "unknown")}
            </p>
            <p>
              The request token may have expired or already been used.
            </p>
            <a class="button" href="/kite/login">Try again</a>
          `
        )
      );
    }

    const data = result.data || {};

    const accessToken = data.access_token;
    const userId = data.user_id;
    const loginTime = data.login_time;

    if (!accessToken) {
      throw new Error(
        "Kite response did not contain an access token."
      );
    }

    await saveAccessToken(accessToken, userId, loginTime);

    console.log("Kite access token saved.");
    console.log("Redirecting to dashboard:", DASHBOARD_URL);

    return res.redirect(DASHBOARD_URL);
  } catch (error) {
    console.error("Kite callback error:", error);

    return res.status(500).send(
      renderPage(
        "Kite Callback Error",
        `
          <h1>Kite callback error</h1>
          <p>${escapeHtml(error.message)}</p>
          <a class="button" href="/kite/login">Try again</a>
        `
      )
    );
  }
});

// --------------------------------------------------
// DASHBOARD
// --------------------------------------------------

app.get("/dashboard", async (req, res) => {
  try {
    const accessToken = await getStoredKiteToken();

    if (!accessToken) {
      return res.redirect("/kite/login");
    }

    res.send(
      renderPage(
        "RRE Dashboard",
        `
          <h1>RRE Dashboard</h1>

          <p class="ok">
            Kite authentication is active.
          </p>

          <p>
            Enter an NSE symbol to retrieve the live quote.
          </p>

          <label for="symbol">NSE Symbol</label>
          <input
            id="symbol"
            type="text"
            value="RELIANCE"
            placeholder="RELIANCE"
          >

          <button class="button" onclick="loadQuote()">
            Get Live Quote
          </button>

          <pre id="result">Enter a symbol and click Get Live Quote.</pre>

          <a class="button" href="/">Home</a>

          <script>
            async function loadQuote() {
              const symbol = document
                .getElementById("symbol")
                .value
                .trim()
                .toUpperCase();

              const resultElement =
                document.getElementById("result");

              if (!symbol) {
                resultElement.textContent =
                  "Please enter an NSE symbol.";
                return;
              }

              resultElement.textContent = "Loading...";

              try {
                const response = await fetch(
                  "/api/market/quote?symbol=" +
                  encodeURIComponent(symbol)
                );

                const data = await response.json();

                resultElement.textContent =
                  JSON.stringify(data, null, 2);
              } catch (error) {
                resultElement.textContent =
                  "Request failed: " + error.message;
              }
            }
          </script>
        `
      )
    );
  } catch (error) {
    console.error("Dashboard error:", error);

    res.status(500).send(
      renderPage(
        "Dashboard Error",
        `
          <h1>Dashboard error</h1>
          <p>${escapeHtml(error.message)}</p>
          <a class="button" href="/">Return home</a>
        `
      )
    );
  }
});

// --------------------------------------------------
// LIVE NSE QUOTE
// --------------------------------------------------

app.get("/api/market/quote", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "")
      .trim()
      .toUpperCase();

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: "SYMBOL_REQUIRED",
        message: "Use ?symbol=RELIANCE",
      });
    }

    if (!KITE_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "KITE_API_KEY_NOT_CONFIGURED",
        message: "KITE_API_KEY is not configured.",
      });
    }

    const accessToken = await getStoredKiteToken();

    if (!accessToken) {
      return res.status(401).json({
        success: false,
        error: "ACCESS_TOKEN_NOT_CONFIGURED",
        message: "Connect Kite first.",
      });
    }

    const instrument = `NSE:${symbol}`;

    const quoteUrl =
      "https://api.kite.trade/quote/ltp" +
      `?i=${encodeURIComponent(instrument)}`;

    const response = await fetch(quoteUrl, {
      method: "GET",
      headers: {
        "X-Kite-Version": "3",
        Authorization: `token ${KITE_API_KEY}:${accessToken}`,
      },
    });

    const result = await response.json();

    if (!response.ok || result.status !== "success") {
      console.error("Kite quote error:", result);

      return res.status(response.status || 500).json({
        success: false,
        error: result.error_type || "KITE_QUOTE_ERROR",
        message:
          result.message || "Unable to retrieve NSE quote.",
      });
    }

    const quote = result.data?.[instrument];

    if (!quote) {
      return res.status(404).json({
        success: false,
        error: "SYMBOL_NOT_FOUND",
        message: `NSE symbol ${symbol} was not found.`,
      });
    }

    return res.json({
      success: true,
      exchange: "NSE",
      symbol,
      last_price: quote.last_price,
      timestamp: new Date().toISOString(),
      source: "Kite Connect",
    });
  } catch (error) {
    console.error("Live NSE quote error:", error);

    return res.status(500).json({
      success: false,
      error: "MARKET_DATA_ERROR",
      message: error.message,
    });
  }
});

// --------------------------------------------------
// 404 HANDLER
// --------------------------------------------------

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "NOT_FOUND",
    message: `Route ${req.method} ${req.originalUrl} was not found.`,
  });
});

// --------------------------------------------------
// GLOBAL ERROR HANDLER
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    success: false,
    error: "INTERNAL_SERVER_ERROR",
    message: error.message,
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`RRE backend running on port ${PORT}`);
      console.log(`Callback URL: ${CALLBACK_URL}`);
      console.log(`Dashboard URL: ${DASHBOARD_URL}`);
    });
  } catch (error) {
    console.error("Server startup error:", error);
    process.exit(1);
  }
}
//const express = require("express");
//const app = express();

app.get("/", (req, res) => {
  res.send("Hello");
});

app.listen(5000, () => {
  console.log("Server started at http://localhost:5000");
});
startServer();