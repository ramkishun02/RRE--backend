const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = Number(process.env.PORT) || 10000;

const KITE_API_KEY = process.env.KITE_API_KEY;
const KITE_API_SECRET = process.env.KITE_API_SECRET;

const BASE_URL =
  process.env.BASE_URL || "https://rre-backend-1.onrender.com";

const CALLBACK_URL =
  process.env.KITE_REDIRECT_URL || `${BASE_URL}/kite/callback`;

const DATABASE_URL = process.env.DATABASE_URL;

let db = null;

if (DATABASE_URL) {
  db = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false,
    },
  });
}

// --------------------------------------------------
// DATABASE INITIALIZATION
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

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function createChecksum(apiKey, requestToken, apiSecret) {
  return crypto
    .createHash("sha256")
    .update(apiKey + requestToken + apiSecret)
    .digest("hex");
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
    throw new Error("Database is not configured.");
  }

  const result = await db.query(`
    SELECT access_token
    FROM kite_tokens
    WHERE expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP
    ORDER BY id DESC
    LIMIT 1
  `);

  return result.rows.length > 0 ? result.rows[0].access_token : null;
}

// --------------------------------------------------
// HOME PAGE
// --------------------------------------------------

app.get("/", async (req, res) => {
  try {
    const accessToken = db ? await getStoredKiteToken() : null;

    const databaseConfigured = Boolean(DATABASE_URL);
    const kiteConfigured = Boolean(KITE_API_KEY && KITE_API_SECRET);

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>RRE Backend</title>
          <meta charset="UTF-8" />
        </head>
        <body>
          <h1>RRE Backend</h1>

          <p>Server is running.</p>

          <p>
            Database:
            ${databaseConfigured ? "Configured" : "Not configured"}
          </p>

          <p>
            Kite API:
            ${kiteConfigured ? "Configured" : "Not configured"}
          </p>

          <p>
            Kite token:
            ${accessToken ? "Connected" : "Not connected"}
          </p>

          <p>
            Callback URL:
            <code>${CALLBACK_URL}</code>
          </p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Home route error:", error);

    res.status(500).send(`
      <h1>Server error</h1>
      <p>${error.message}</p>
    `);
  }
});

// --------------------------------------------------
// KITE CALLBACK
// --------------------------------------------------

app.get("/kite/callback", async (req, res) => {
  const { request_token: requestToken, action, message } = req.query;

  if (action === "login" && message) {
    return res.status(400).send(`
      <h1>Kite login failed</h1>
      <p>${message}</p>
      <p><a href="/">Return to RRE</a></p>
    `);
  }

  if (!requestToken) {
    return res.status(400).send(`
      <h1>Kite login failed</h1>
      <p>Kite did not return a request_token.</p>
      <p>Check that the Redirect URL exactly matches:</p>
      <p><code>${CALLBACK_URL}</code></p>
      <p><a href="/">Return to RRE</a></p>
    `);
  }

  if (!KITE_API_KEY || !KITE_API_SECRET) {
    return res.status(500).send(`
      <h1>Configuration error</h1>
      <p>Add KITE_API_KEY and KITE_API_SECRET to the environment variables.</p>
    `);
  }

  if (!db) {
    return res.status(500).send(`
      <h1>Database error</h1>
      <p>DATABASE_URL is not configured.</p>
    `);
  }

  try {
    console.log("Request token received.");
    console.log("Generating Kite session...");

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
        error_type: result.error_type,
        message: result.message,
      })
    );

    if (!response.ok || result.status !== "success") {
      return res.status(400).send(`
        <h1>Token exchange failed</h1>
        <p>${result.message || "Unable to create Kite session."}</p>
        <p>Error type: ${result.error_type || "Unknown"}</p>
        <p>The request token may be expired or already used.</p>
        <p><a href="/">Return to RRE</a></p>
      `);
    }

    const data = result.data || {};

    const accessToken = data.access_token;
    const userId = data.user_id;
    const loginTime = data.login_time;

    if (!accessToken) {
      throw new Error("Kite response did not contain access_token.");
    }

    await saveAccessToken(accessToken, userId, loginTime);

    console.log("Kite access token saved.");

    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Kite Authentication Successful</title>
          <meta charset="UTF-8" />
        </head>
        <body>
          <h1>Authentication successful</h1>
          <p>Your Kite access token has been stored securely.</p>
          <p>User ID: ${userId || "Connected"}</p>
          <p><a href="/">Return to RRE</a></p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Kite callback error:", error);

    return res.status(500).send(`
      <h1>Authentication error</h1>
      <p>${error.message}</p>
      <p><a href="/">Return to RRE</a></p>
    `);
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

    const url =
      "https://api.kite.trade/quote/ltp" +
      `?i=${encodeURIComponent(instrument)}`;

    const response = await fetch(url, {
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
// START SERVER
// --------------------------------------------------

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, () => {
      console.log(`RRE backend running on port ${PORT}`);
      console.log(`Callback URL: ${CALLBACK_URL}`);
    });
  } catch (error) {
    console.error("Server startup error:", error);
    process.exit(1);
  }
}

startServer();