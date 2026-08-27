"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

const app = express();

const PORT = Number(process.env.PORT || 10000);

const KITE_API_KEY = process.env.KITE_API_KEY || "";
const KITE_API_SECRET = process.env.KITE_API_SECRET || "";

const BASE_URL =
  process.env.BASE_URL ||
  "https://rre-backend-1.onrender.com";

const CALLBACK_URL =
  process.env.KITE_REDIRECT_URL ||
  `${BASE_URL}/kite/callback`;

const DASHBOARD_URL =
  process.env.DASHBOARD_URL ||
  `${BASE_URL}/dashboard`;

const DATABASE_URL = process.env.DATABASE_URL || "";

let db = null;

if (DATABASE_URL) {
  db = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  db.on("error", (error) => {
    console.error("PostgreSQL pool error:", error.message);
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/*
  Serve index.html, app.js, style.css and assets.
  Keep these files in the same project directory.
*/
app.use(express.static(path.join(__dirname, "public")));

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function page(title, message, link = "/") {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      max-width: 700px;
      margin: 40px auto;
      padding: 20px;
      line-height: 1.5;
    }
    a {
      display: inline-block;
      margin-top: 20px;
    }
    pre {
      white-space: pre-wrap;
      background: #f3f3f3;
      padding: 12px;
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <a href="${escapeHtml(link)}">Return to application</a>
</body>
</html>`;
}

function checksum(apiKey, requestToken, apiSecret) {
  return crypto
    .createHash("sha256")
    .update(apiKey + requestToken + apiSecret)
    .digest("hex");
}

function kiteHeaders(accessToken) {
  return {
    "X-Kite-Version": "3",
    Authorization: `token ${KITE_API_KEY}:${accessToken}`
  };
}

async function kiteFetch(url, options = {}) {
  const response = await fetch(url, options);

  let data;

  try {
    data = await response.json();
  } catch {
    data = {
      status: "error",
      message: await response.text()
    };
  }

  return {
    response,
    data
  };
}

/*
  Token storage
*/
async function ensureTokenTable() {
  if (!db) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS kite_tokens (
      id INTEGER PRIMARY KEY,
      access_token TEXT NOT NULL,
      user_id TEXT,
      login_time TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function saveKiteToken(accessToken, userId, loginTime) {
  if (!db) {
    throw new Error("DATABASE_URL is not configured.");
  }

  await db.query(
    `
    INSERT INTO kite_tokens
      (id, access_token, user_id, login_time, updated_at)
    VALUES
      (1, $1, $2, $3, NOW())
    ON CONFLICT (id)
    DO UPDATE SET
      access_token = EXCLUDED.access_token,
      user_id = EXCLUDED.user_id,
      login_time = EXCLUDED.login_time,
      updated_at = NOW()
    `,
    [accessToken, userId || null, loginTime || null]
  );
}

async function getKiteToken() {
  if (!db) return null;

  const result = await db.query(`
    SELECT access_token, user_id, login_time
    FROM kite_tokens
    WHERE id = 1
    LIMIT 1
  `);

  return result.rows[0] || null;
}

async function deleteKiteToken() {
  if (!db) return;

  await db.query(`
    DELETE FROM kite_tokens
    WHERE id = 1
  `);
}

async function requireKiteToken(res) {
  if (!KITE_API_KEY) {
    res.status(500).json({
      success: false,
      error: "KITE_API_KEY_NOT_CONFIGURED",
      message: "KITE_API_KEY is missing."
    });

    return null;
  }

  if (!db) {
    res.status(500).json({
      success: false,
      error: "DATABASE_NOT_CONFIGURED",
      message: "DATABASE_URL is missing."
    });

    return null;
  }

  const token = await getKiteToken();

  if (!token || !token.access_token) {
    res.status(401).json({
      success: false,
      error: "KITE_LOGIN_REQUIRED",
      message: "Connect Kite before using this feature.",
      loginUrl: "/kite/login"
    });

    return null;
  }

  return token.access_token;
}

/*
  Home
*/
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/*
  Health check
*/
app.get("/health", async (req, res) => {
  let databaseReady = false;

  if (db) {
    try {
      await db.query("SELECT 1");
      databaseReady = true;
    } catch (error) {
      console.error("Database health error:", error.message);
    }
  }

  const token = db ? await getKiteToken() : null;

  res.json({
    success: true,
    backend: true,
    databaseConfigured: Boolean(DATABASE_URL),
    databaseReady,
    kiteConfigured: Boolean(KITE_API_KEY && KITE_API_SECRET),
    accessTokenConfigured: Boolean(token?.access_token),
    callbackUrl: CALLBACK_URL,
    dashboardUrl: DASHBOARD_URL,
    time: new Date().toISOString()
  });
});

/*
  Kite login
*/
app.get("/kite/login", (req, res) => {
  if (!KITE_API_KEY) {
    return res
      .status(500)
      .send(page(
        "Kite configuration error",
        "KITE_API_KEY is missing."
      ));
  }

  const loginUrl =
    "https://kite.zerodha.com/connect/login?v=3" +
    `&api_key=${encodeURIComponent(KITE_API_KEY)}`;

  res.redirect(loginUrl);
});

/*
  Kite callback
*/
app.get("/kite/callback", async (req, res) => {
  const requestToken = String(
    req.query.request_token || ""
  ).trim();

  const status = String(req.query.status || "");

  if (status !== "success" || !requestToken) {
    return res
      .status(400)
      .send(page(
        "Kite login was not completed",
        "Kite did not provide a valid request token."
      ));
  }

  if (!KITE_API_KEY || !KITE_API_SECRET) {
    return res
      .status(500)
      .send(page(
        "Kite configuration error",
        "KITE_API_KEY or KITE_API_SECRET is missing."
      ));
  }

  if (!db) {
    return res
      .status(500)
      .send(page(
        "Database configuration error",
        "DATABASE_URL is required to save the Kite access token."
      ));
  }

  try {
    const body = new URLSearchParams({
      api_key: KITE_API_KEY,
      request_token: requestToken,
      checksum: checksum(
        KITE_API_KEY,
        requestToken,
        KITE_API_SECRET
      )
    });

    const { response, data } = await kiteFetch(
      "https://api.kite.trade/session/token",
      {
        method: "POST",
        headers: {
          "X-Kite-Version": "3",
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: body.toString()
      }
    );

    console.log("Kite token exchange:", {
      httpStatus: response.status,
      status: data.status,
      errorType: data.error_type,
      message: data.message
    });

    if (
      !response.ok ||
      data.status !== "success" ||
      !data.data?.access_token
    ) {
      return res
        .status(response.status || 400)
        .send(page(
          "Kite authentication failed",
          data.message ||
            "The request token could not be exchanged."
        ));
    }

    await saveKiteToken(
      data.data.access_token,
      data.data.user_id,
      data.data.login_time
    );

    console.log(
      "Kite access token saved for user:",
      data.data.user_id
    );

    return res.redirect(DASHBOARD_URL);
  } catch (error) {
    console.error("Kite callback error:", error);

    return res
      .status(500)
      .send(page(
        "Kite callback error",
        error.message
      ));
  }
});

/*
  Kite connection status
*/
app.get("/api/auth/status", async (req, res) => {
  try {
    const token = db ? await getKiteToken() : null;

    res.json({
      success: true,
      connected: Boolean(token?.access_token),
      userId: token?.user_id || null,
      loginTime: token?.login_time || null
    });
  } catch (error) {
    console.error("Status error:", error.message);

    res.status(500).json({
      success: false,
      error: "STATUS_ERROR",
      message: error.message
    });
  }
});

/*
  Dashboard route
*/
app.get("/dashboard", async (req, res) => {
  try {
    const token = db ? await getKiteToken() : null;

    if (!token?.access_token) {
      return res.redirect("/kite/login");
    }

    return res.sendFile(
      path.join(__dirname, "public", "index.html")
    );
  } catch (error) {
    console.error("Dashboard error:", error.message);

    return res
      .status(500)
      .send(page(
        "Dashboard error",
        error.message
      ));
  }
});

/*
  User profile test
*/
app.get("/api/kite/profile", async (req, res) => {
  try {
    const accessToken = await requireKiteToken(res);

    if (!accessToken) return;

    const { response, data } = await kiteFetch(
      "https://api.kite.trade/user/profile",
      {
        headers: kiteHeaders(accessToken)
      }
    );

    res.status(response.status).json(data);
  } catch (error) {
    console.error("Profile error:", error.message);

    res.status(500).json({
      success: false,
      error: "PROFILE_REQUEST_FAILED",
      message: error.message
    });
  }
});

/*
  Live market quote
  Example:
  /api/market/quote?symbol=INFY
*/
app.get("/api/market/quote", async (req, res) => {
  try {
    const symbol = String(
      req.query.symbol || ""
    ).trim().toUpperCase();

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: "SYMBOL_REQUIRED",
        message: "Use /api/market/quote?symbol=INFY"
      });
    }

    const accessToken = await requireKiteToken(res);

    if (!accessToken) return;

    const instrument = `NSE:${symbol}`;

    const quoteUrl =
      "https://api.kite.trade/quote/ltp" +
      `?i=${encodeURIComponent(instrument)}`;

    const { response, data } = await kiteFetch(
      quoteUrl,
      {
        headers: kiteHeaders(accessToken)
      }
    );

    if (
      !response.ok ||
      data.status !== "success"
    ) {
      return res.status(response.status || 500).json({
        success: false,
        error: data.error_type || "KITE_QUOTE_ERROR",
        message: data.message || "Kite quote failed.",
        kite: data
      });
    }

    const quote = data.data?.[instrument];

    if (!quote) {
      return res.status(404).json({
        success: false,
        error: "SYMBOL_NOT_FOUND",
        message: `${instrument} was not returned by Kite.`
      });
    }

    return res.json({
      success: true,
      exchange: "NSE",
      symbol,
      instrument,
      last_price: quote.last_price,
      source: "Kite Connect",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Quote error:", error.message);

    res.status(500).json({
      success: false,
      error: "MARKET_DATA_ERROR",
      message: error.message
    });
  }
});

/*
  Stock search using Kite's daily instruments CSV.
  For stability, this caches the file in memory for 24 hours.
*/
let instrumentsCache = [];
let instrumentsCacheTime = 0;

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];

    if (character === '"') {
      if (
        quoted &&
        line[i + 1] === '"'
      ) {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (
      character === "," &&
      !quoted
    ) {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }

  values.push(current);
  return values;
}

async function getInstruments(accessToken) {
  const now = Date.now();

  if (
    instrumentsCache.length &&
    now - instrumentsCacheTime < 24 * 60 * 60 * 1000
  ) {
    return instrumentsCache;
  }

  const response = await fetch(
    "https://api.kite.trade/instruments",
    {
      headers: kiteHeaders(accessToken)
    }
  );

  if (!response.ok) {
    throw new Error(
      `Kite instruments request failed: ${response.status}`
    );
  }

  const csv = await response.text();
  const lines = csv.split(/?/);
  const headings = parseCsvLine(lines.shift() || "");

  const index = {
    token: headings.indexOf("instrument_token"),
    symbol: headings.indexOf("tradingsymbol"),
    name: headings.indexOf("name"),
    exchange: headings.indexOf("exchange"),
    segment: headings.indexOf("segment")
  };

  instrumentsCache = lines
    .filter((line) => line.trim())
    .map((line) => {
      const columns = parseCsvLine(line);

      return {
        instrumentToken: columns[index.token] || "",
        symbol: columns[index.symbol] || "",
        name: columns[index.name] || "",
        exchange: columns[index.exchange] || "",
        segment: columns[index.segment] || ""
      };
    });

  instrumentsCacheTime = now;

  return instrumentsCache;
}

app.get("/api/stocks/search", async (req, res) => {
  try {
    const query = String(
      req.query.q || ""
    ).trim().toUpperCase();

    if (!query) {
      return res.json({
        success: true,
        results: []
      });
    }

    const accessToken = await requireKiteToken(res);

    if (!accessToken) return;

    const instruments = await getInstruments(
      accessToken
    );

    const results = instruments
      .filter((instrument) => {
        const isNseEquity =
          instrument.exchange === "NSE" &&
          instrument.segment === "NSE";

        const symbolMatches =
          instrument.symbol
            .toUpperCase()
            .includes(query);

        const nameMatches =
          instrument.name
            .toUpperCase()
            .includes(query);

        return (
          isNseEquity &&
          (symbolMatches || nameMatches)
        );
      })
      .slice(0, 20);

    return res.json({
      success: true,
      results
    });
  } catch (error) {
    console.error("Stock search error:", error.message);

    res.status(500).json({
      success: false,
      error: "STOCK_SEARCH_FAILED",
      message: error.message
    });
  }
});

/*
  Logout and invalidate the Kite token
*/
app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = db ? await getKiteToken() : null;

    if (
      token?.access_token &&
      KITE_API_KEY
    ) {
      const logoutUrl =
        "https://api.kite.trade/session/token" +
        `?api_key=${encodeURIComponent(KITE_API_KEY)}` +
        `&access_token=${encodeURIComponent(
          token.access_token
        )}`;

      try {
        await fetch(logoutUrl, {
          method: "DELETE",
          headers: {
            "X-Kite-Version": "3"
          }
        });
      } catch (error) {
        console.error(
          "Kite logout request failed:",
          error.message
        );
      }
    }

    await deleteKiteToken();
    instrumentsCache = [];
    instrumentsCacheTime = 0;

    res.json({
      success: true,
      message: "Logged out"
    });
  } catch (error) {
    console.error("Logout error:", error.message);

    res.status(500).json({
      success: false,
      error: "LOGOUT_FAILED",
      message: error.message
    });
  }
});

/*
  API 404 response
*/
app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    error: "API_ROUTE_NOT_FOUND",
    message: `${req.method} ${req.originalUrl} was not found.`
  });
});

/*
  Start exactly once
*/
async function start() {
  try {
    await ensureTokenTable();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Callback URL: ${CALLBACK_URL}`);
      console.log(`Dashboard URL: ${DASHBOARD_URL}`);
    });
  } catch (error) {
    console.error("Startup failed:", error);
    process.exit(1);
  }
}

start();
