const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 10000;

const KITE_API_KEY = process.env.KITE_API_KEY;
const KITE_API_SECRET = process.env.KITE_API_SECRET;

const BASE_URL =
  process.env.BASE_URL ||
  "https://rre-backend-1.onrender.com";

const CALLBACK_URL =
  process.env.KITE_REDIRECT_URL ||
  `${BASE_URL}/kite/callback`;

const DATABASE_URL = process.env.DATABASE_URL;

let db = null;

if (DATABASE_URL) {
  db = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });
}

// --------------------------------------------------
// DATABASE INITIALIZATION
// --------------------------------------------------

async function initializeDatabase() {
  if (!db) {
    console.log("DATABASE_URL not configured");
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
    throw new Error("Database is not configured");
  }

  await db.query(`DELETE FROM kite_tokens`);

  await db.query(
    `
      INSERT INTO kite_tokens
      (
        access_token,
        user_id,
        login_time,
        expires_at
      )
      VALUES ($1, $2, $3, CURRENT_DATE + INTERVAL '1 day')
    `,
    [
      accessToken,
      userId || null,
      loginTime || new Date()
    ]
  );
}

async function getAccessToken() {
  if (!db) return null;

  const result = await db.query(`
    SELECT access_token
    FROM kite_tokens
    ORDER BY id DESC
    LIMIT 1
  `);

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].access_token;
}
// --------------------------------------------------
// GET STORED KITE ACCESS TOKEN
// --------------------------------------------------

async function getStoredKiteToken() {
  if (!db) {
    throw new Error("Database is not configured");
  }

  const result = await db.query(`
    SELECT access_token
    FROM kite_tokens
    ORDER BY id DESC
    LIMIT 1
  `);

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].access_token;
}
// --------------------------------------------------
// HOME PAGE
// --------------------------------------------------

app.get("/", async (req, res) => {
  const token = await getAccessToken();

  const databaseConfigured = !!DATABASE_URL;
  const kiteConfigured =
    !!KITE_API_KEY && !!KITE_API_SECRET;

  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RRE Backend v3</title>

<style>
body {
  margin: 0;
  padding: 30px 15px;
  font-family: Arial, sans-serif;
  background: #f4f6f8;
}

.card {
  max-width: 650px;
  margin: auto;
  background: white;
  padding: 30px;
  border-radius: 18px;
  box-shadow: 0 4px 20px rgba(0,0,0,.12);
}

h1 {
  color: #222;
}

.status {
  margin: 12px 0;
  font-size: 18px;
}

.ok {
  color: green;
  font-weight: bold;
}

.bad {
  color: red;
  font-weight: bold;
}

a.button {
  display: inline-block;
  padding: 14px 20px;
  margin: 8px 5px 0 0;
  background: #1976d2;
  color: white;
  text-decoration: none;
  border-radius: 8px;
}
</style>
</head>

<body>

<div class="card">

<h1>RRE Backend v3</h1>

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
Access Token:
<span class="${token ? "ok" : "bad"}">
${token ? "CONFIGURED" : "NOT CONFIGURED"}
</span>
</div>

<hr>

<a class="button" href="/health">Health Check</a>

<a class="button" href="/status">Configuration Status</a>

<a class="button" href="/kite/login">Connect Kite</a>

</div>

</body>
</html>
`);
});

// --------------------------------------------------
// HEALTH
// --------------------------------------------------

app.get("/health", async (req, res) => {
  let databaseReady = false;

  if (db) {
    try {
      await db.query("SELECT 1");
      databaseReady = true;
    } catch (err) {
      databaseReady = false;
    }
  }

  const accessToken = await getAccessToken();

  res.json({
    backend: true,
    databaseConfigured: !!DATABASE_URL,
    databaseReady,
    kiteConfigured: !!KITE_API_KEY && !!KITE_API_SECRET,
    accessTokenConfigured: !!accessToken,
    callbackUrl: CALLBACK_URL
  });
});

// --------------------------------------------------
// STATUS
// --------------------------------------------------

app.get("/status", async (req, res) => {
  const accessToken = await getAccessToken();

  res.json({
    backend: true,
    kitePackage: "not required",
    apiKeyConfigured: !!KITE_API_KEY,
    apiSecretConfigured: !!KITE_API_SECRET,
    databaseConfigured: !!DATABASE_URL,
    accessTokenConfigured: !!accessToken,
    callbackUrl: CALLBACK_URL
  });
});
// --------------------------------------------------
// LIVE NSE QUOTE
// --------------------------------------------------

app.get("/api/market/quote", async (req, res) => {

  try {

    const symbol = String(
      req.query.symbol || ""
    ).trim().toUpperCase();

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: "SYMBOL_REQUIRED",
        message: "Use ?symbol=RELIANCE"
      });
    }

    // Get daily Kite access token
    const accessToken = await getStoredKiteToken();

    if (!accessToken) {
      return res.status(401).json({
        success: false,
        error: "ACCESS_TOKEN_NOT_CONFIGURED",
        message: "Connect Kite first."
      });
    }

    // ----------------------------------------------
    // Kite API request
    // ----------------------------------------------

    const url =
      "https://api.kite.trade/quote/ltp" +
      "?i=" +
      encodeURIComponent(`NSE:${symbol}`);

    const response = await fetch(url, {
      method: "GET",

      headers: {
        "X-Kite-Version": "3",
        "Authorization":
          `token ${KITE_API_KEY}:${accessToken}`
      }
    });

    const result = await response.json();

    if (!response.ok || result.status !== "success") {

      console.error(
        "Kite quote error:",
        result
      );

      return res.status(
        response.status || 500
      ).json({
        success: false,
        error: result.error_type || "KITE_QUOTE_ERROR",
        message:
          result.message ||
          "Unable to retrieve NSE quote."
      });
    }

    // ----------------------------------------------
    // Extract price
    // ----------------------------------------------

    const instrument =
      result.data?.[`NSE:${symbol}`];

    if (!instrument) {
      return res.status(404).json({
        success: false,
        error: "SYMBOL_NOT_FOUND",
        message:
          `NSE symbol ${symbol} was not found.`
      });
    }

    // ----------------------------------------------
    // RRE response
    // ----------------------------------------------

    res.json({
      success: true,

      exchange: "NSE",

      symbol,

      last_price:
        instrument.last_price,

      timestamp:
        new Date().toISOString(),

      source: "Kite Connect"
    });

  } catch (error) {

    console.error(
      "Live NSE quote error:",
      error
    );

    res.status(500).json({
      success: false,
      error: "MARKET_DATA_ERROR",
      message: error.message
    });
  }
});
// --------------------------------------------------
// KITE LOGIN
// --------------------------------------------------

app.get("/kite/login", (req, res) => {

  if (!KITE_API_KEY) {
    return res.status(500).send(
      "KITE_API_KEY is missing in Render environment variables."
    );
  }

  const loginUrl =
    "https://kite.zerodha.com/connect/login" +
    "?v=3" +
    "&api_key=" +
    encodeURIComponent(KITE_API_KEY);

  console.log("Redirecting to Kite:");
  console.log(loginUrl);

  res.redirect(loginUrl);
});

// --------------------------------------------------
// KITE CALLBACK
// --------------------------------------------------

app.get("/kite/callback", async (req, res) => {

  console.log("Kite callback received");

  console.log("Callback query:", req.query);

  const {
    request_token,
    status,
    action
  } = req.query;

  if (status === "error") {
    return res.status(400).send(`
      <h2>Kite login failed</h2>
      <p>${req.query.message || "Kite returned an error."}</p>
      <p><a href="/">Return to RRE</a></p>
    `);
  }

  if (!request_token) {
    return res.status(400).send(`
      <h2>Request token missing</h2>

      <p>Kite did not return a request_token.</p>

      <p>
      Check that the Redirect URL in the Kite developer console
      exactly matches:
      </p>

      <pre>${CALLBACK_URL}</pre>

      <p><a href="/">Return to RRE</a></p>
    `);
  }

  if (!KITE_API_SECRET) {
    return res.status(500).send(`
      <h2>KITE_API_SECRET missing</h2>
      <p>Add KITE_API_SECRET to Render environment variables.</p>
    `);
  }

  try {

    // ------------------------------------------------
    // CREATE SHA256 CHECKSUM
    // ------------------------------------------------

    const checksum = createChecksum(
      KITE_API_KEY,
      request_token,
      KITE_API_SECRET
    );
    app.get("/kite/callback", async (req, res) => {
   ...
});
    console.log("Request token received.");
    console.log("Generating Kite session...");

    // ------------------------------------------------
    // TOKEN EXCHANGE
    // ------------------------------------------------

    const body = new URLSearchParams();

    body.append("api_key", KITE_API_KEY);
    body.append("request_token", request_token);
    body.append("checksum", checksum);

    const response = await fetch(
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

    const result = await response.json();

    console.log(
      "Kite session response:",
      JSON.stringify({
        status: result.status,
        error_type: result.error_type,
        message: result.message
      })
    );

    if (!response.ok || result.status !== "success") {

      return res.status(400).send(`
        <h2>Kite authentication failed</h2>

        <p>
        ${result.message || "Token exchange failed"}
        </p>

        <p>
        Error type:
        ${result.error_type || "unknown"}
        </p>

        <p>
        The request token may be expired or already used.
        </p>

        <p>
        <a href="/kite/login">Try Kite login again</a>
        </p>
      `);
    }

    // ------------------------------------------------
    // EXTRACT TOKEN
    // ------------------------------------------------

    const data = result.data;

    const accessToken = data.access_token;
    const userId = data.user_id;
    const loginTime = data.login_time;

    if (!accessToken) {
      throw new Error(
        "Kite response did not contain access_token"
      );
    }

    // ------------------------------------------------
    // SAVE TOKEN
    // ------------------------------------------------

    await saveAccessToken(
      accessToken,
      userId,
      loginTime
    );

    console.log("Kite access token saved.");

    res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kite Connected</title>

<style>
body {
  font-family: Arial;
  text-align: center;
  padding: 50px 20px;
  background: #f4f6f8;
}

.card {
  max-width: 500px;
  margin: auto;
  padding: 30px;
  background: white;
  border-radius: 15px;
}

.success {
  color: green;
  font-size: 22px;
  font-weight: bold;
}
</style>
</head>

<body>

<div class="card">

<h1>Kite Connected</h1>

<p class="success">
Authentication successful
</p>

<p>
Your Kite access token has been securely stored
in PostgreSQL.
</p>

<p>
User ID: ${userId || "Connected"}
</p>

<p>
<a href="/">Return to RRE Backend</a>
</p>

</div>

</body>
</html>
`);

  } catch (error) {

    console.error(
      "Kite callback error:",
      error
    );

    res.status(500).send(`
      <h2>RRE Kite callback error</h2>

      <p>
      ${error.message}
      </p>

      <p>
      <a href="/">Return to RRE</a>
      </p>
    `);
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

async function startServer() {

  try {

    await initializeDatabase();

    app.listen(PORT, () => {

      console.log(
        `RRE backend v3 running on port ${PORT}`
      );

      console.log(
        `Callback URL: ${CALLBACK_URL}`
      );

    });

  } catch (error) {

    console.error(
      "Server startup error:",
      error
    );

    process.exit(1);
  }
}
// --------------------------------------------------
// LIVE NSE QUOTE
// --------------------------------------------------

app.get("/api/market/quote", async (req, res) => {

  try {

    const symbol = String(
      req.query.symbol || ""
    ).trim().toUpperCase();

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: "SYMBOL_REQUIRED",
        message: "Use ?symbol=RELIANCE"
      });
    }

    // Get daily Kite access token
    const accessToken = await getStoredKiteToken();

    if (!accessToken) {
      return res.status(401).json({
        success: false,
        error: "ACCESS_TOKEN_NOT_CONFIGURED",
        message: "Connect Kite first."
      });
    }

    // ----------------------------------------------
    // Kite API request
    // ----------------------------------------------

    const url =
      "https://api.kite.trade/quote/ltp" +
      "?i=" +
      encodeURIComponent(`NSE:${symbol}`);

    const response = await fetch(url, {
      method: "GET",

      headers: {
        "X-Kite-Version": "3",
        "Authorization":
          `token ${KITE_API_KEY}:${accessToken}`
      }
    });

    const result = await response.json();

    if (!response.ok || result.status !== "success") {

      console.error(
        "Kite quote error:",
        result
      );

      return res.status(
        response.status || 500
      ).json({
        success: false,
        error: result.error_type || "KITE_QUOTE_ERROR",
        message:
          result.message ||
          "Unable to retrieve NSE quote."
      });
    }

    // ----------------------------------------------
    // Extract price
    // ----------------------------------------------

    const instrument =
      result.data?.[`NSE:${symbol}`];

    if (!instrument) {
      return res.status(404).json({
        success: false,
        error: "SYMBOL_NOT_FOUND",
        message:
          `NSE symbol ${symbol} was not found.`
      });
    }

    // ----------------------------------------------
    // RRE response
    // ----------------------------------------------

    res.json({
      success: true,

      exchange: "NSE",

      symbol,

      last_price:
        instrument.last_price,

      timestamp:
        new Date().toISOString(),

      source: "Kite Connect"
    });

  } catch (error) {

    console.error(
      "Live NSE quote error:",
      error
    );

    res.status(500).json({
      success: false,
      error: "MARKET_DATA_ERROR",
      message: error.message
    });
  }
});
startServer();