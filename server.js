const express = require("express");
const { Pool } = require("pg");
const { KiteConnect } = require("kiteconnect");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

const KITE_API_KEY = process.env.KITE_API_KEY;
const KITE_API_SECRET = process.env.KITE_API_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

// --------------------------------------------------
// PostgreSQL
// --------------------------------------------------

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    })
  : null;

// --------------------------------------------------
// Kite client
// --------------------------------------------------

const kite = KITE_API_KEY
  ? new KiteConnect({
      api_key: KITE_API_KEY
    })
  : null;

// --------------------------------------------------
// Database initialization
// --------------------------------------------------

async function initDatabase() {
  if (!pool) {
    console.log("DATABASE_URL is missing");
    return false;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kite_sessions (
      id SERIAL PRIMARY KEY,
      access_token TEXT NOT NULL,
      public_token TEXT,
      user_id TEXT,
      user_name TEXT,
      email TEXT,
      login_time TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("RRE database initialized.");
  return true;
}

// --------------------------------------------------
// Get latest access token
// --------------------------------------------------

async function getStoredAccessToken() {
  if (!pool) return null;

  const result = await pool.query(`
    SELECT *
    FROM kite_sessions
    ORDER BY id DESC
    LIMIT 1
  `);

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

// --------------------------------------------------
// Home page
// --------------------------------------------------

app.get("/", async (req, res) => {
  let databaseConfigured = !!pool;
  let databaseReady = false;
  let accessTokenConfigured = false;

  if (pool) {
    try {
      await pool.query("SELECT 1");
      databaseReady = true;

      const session = await getStoredAccessToken();
      accessTokenConfigured = !!session?.access_token;
    } catch (err) {
      console.error("Database check failed:", err.message);
    }
  }

  const kiteConfigured =
    !!KITE_API_KEY && !!KITE_API_SECRET && !!kite;

  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RRE Backend v3</title>

<style>
body {
  font-family: Arial, sans-serif;
  background: #f4f7fb;
  margin: 0;
  padding: 30px;
}

.card {
  max-width: 700px;
  margin: auto;
  background: white;
  padding: 30px;
  border-radius: 18px;
  box-shadow: 0 8px 30px rgba(0,0,0,.08);
}

h1 {
  margin-top: 0;
}

.status {
  margin: 15px 0;
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

button, a.button {
  display: inline-block;
  padding: 13px 20px;
  margin: 8px 5px 0 0;
  background: #1976d2;
  color: white;
  border: none;
  border-radius: 9px;
  text-decoration: none;
  cursor: pointer;
}

button:hover, a.button:hover {
  background: #125aa0;
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
<span class="${databaseReady ? "ok" : "bad"}">
${databaseReady ? "CONFIGURED" : "NOT READY"}
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
<span class="${accessTokenConfigured ? "ok" : "bad"}">
${accessTokenConfigured ? "CONFIGURED" : "NOT CONFIGURED"}
</span>
</div>

<hr>

<a class="button" href="/health">Health Check</a>

<a class="button" href="/status">Configuration Status</a>

<a class="button" href="/connect/kite">Connect Kite</a>

</div>

</body>
</html>
  `);
});

// --------------------------------------------------
// Health
// --------------------------------------------------

app.get("/health", async (req, res) => {
  let databaseReady = false;
  let accessTokenConfigured = false;

  if (pool) {
    try {
      await pool.query("SELECT 1");
      databaseReady = true;

      const session = await getStoredAccessToken();
      accessTokenConfigured = !!session?.access_token;
    } catch (err) {
      console.error("Health database error:", err.message);
    }
  }

  res.json({
    backend: true,
    databaseConfigured: !!pool,
    databaseReady,
    kitePackage: !!KiteConnect,
    apiKeyConfigured: !!KITE_API_KEY,
    apiSecretConfigured: !!KITE_API_SECRET,
    accessTokenConfigured
  });
});

// --------------------------------------------------
// Status page
// --------------------------------------------------

app.get("/status", async (req, res) => {
  let databaseReady = false;
  let session = null;

  if (pool) {
    try {
      await pool.query("SELECT 1");
      databaseReady = true;
      session = await getStoredAccessToken();
    } catch (err) {
      console.error("Status database error:", err.message);
    }
  }

  res.json({
    backend: "RUNNING",

    database: {
      configured: !!pool,
      ready: databaseReady
    },

    kite: {
      package: !!KiteConnect,
      apiKeyConfigured: !!KITE_API_KEY,
      apiSecretConfigured: !!KITE_API_SECRET
    },

    accessToken: {
      configured: !!session?.access_token,
      userId: session?.user_id || null,
      userName: session?.user_name || null,
      loginTime: session?.login_time || null
    }
  });
});

// --------------------------------------------------
// Start Kite authorization
// --------------------------------------------------

app.get("/connect/kite", (req, res) => {

  if (!KITE_API_KEY) {
    return res.status(500).send(`
      <h2>Kite API key missing</h2>
      <p>Set KITE_API_KEY in Render Environment Variables.</p>
    `);
  }

  if (!KITE_API_SECRET) {
    return res.status(500).send(`
      <h2>Kite API secret missing</h2>
      <p>Set KITE_API_SECRET in Render Environment Variables.</p>
    `);
  }

  if (!kite) {
    return res.status(500).send(`
      <h2>Kite client not initialized</h2>
    `);
  }

  const loginUrl = kite.getLoginURL();

  console.log("Kite authorization started.");

  res.redirect(loginUrl);
});

// --------------------------------------------------
// Kite callback
// --------------------------------------------------

app.get("/kite/callback", async (req, res) => {

  console.log("====================================");
  console.log("KITE CALLBACK RECEIVED");
  console.log("====================================");

  try {

    const {
      request_token,
      status,
      action
    } = req.query;

    console.log("Kite status:", status);
    console.log("Kite action:", action);
    console.log(
      "Request token received:",
      request_token ? "YES" : "NO"
    );

    if (!request_token) {
      return res.status(400).send(`
<!DOCTYPE html>
<html>
<body>
<h2>Kite Login Failed</h2>
<p>No request_token was received.</p>
<p>Please start again from Connect Kite.</p>
</body>
</html>
      `);
    }

    if (!kite) {
      throw new Error("Kite client is not initialized");
    }

    if (!KITE_API_SECRET) {
      throw new Error("KITE_API_SECRET is missing");
    }

    console.log("Exchanging request_token for access_token...");

    // -----------------------------------------------
    // THIS IS THE SAME ALGORITHM YOU PROVIDED
    // -----------------------------------------------

    const data = await kite.generateSession(
      request_token,
      KITE_API_SECRET
    );

    console.log("Kite session generated successfully.");

    if (!data || !data.access_token) {
      throw new Error(
        "Kite returned no access_token."
      );
    }

    const accessToken = data.access_token;

    // Set token in Kite client
    kite.setAccessToken(accessToken);

    // -----------------------------------------------
    // Store token in PostgreSQL
    // -----------------------------------------------

    if (!pool) {
      throw new Error(
        "DATABASE_URL is missing."
      );
    }

    await pool.query(
      `
      INSERT INTO kite_sessions
      (
        access_token,
        public_token,
        user_id,
        user_name,
        email,
        login_time
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      `,
      [
        data.access_token,
        data.public_token || null,
        data.user_id || null,
        data.user_name || null,
        data.email || null,
        data.login_time
          ? new Date(data.login_time)
          : null
      ]
    );

    console.log("Access token stored in PostgreSQL.");

    // -----------------------------------------------
    // Verify token immediately
    // -----------------------------------------------

    console.log("Testing Kite profile request...");

    const profile = await kite.getProfile();

    console.log(
      "Kite profile verified:",
      profile?.user_id || "unknown user"
    );

    res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kite Connected</title>

<style>
body {
  font-family: Arial, sans-serif;
  background: #f4f7fb;
  padding: 30px;
}

.card {
  max-width: 600px;
  margin: auto;
  background: white;
  padding: 30px;
  border-radius: 18px;
  box-shadow: 0 8px 30px rgba(0,0,0,.08);
}

.ok {
  color: green;
  font-weight: bold;
}

a {
  display: inline-block;
  margin-top: 20px;
  padding: 12px 18px;
  background: #1976d2;
  color: white;
  text-decoration: none;
  border-radius: 8px;
}
</style>
</head>

<body>

<div class="card">

<h1>✅ Kite Connected</h1>

<p>
Access Token:
<span class="ok">STORED</span>
</p>

<p>
Kite User:
<b>${profile?.user_name || data.user_name || "Connected"}</b>
</p>

<p>
User ID:
<b>${profile?.user_id || data.user_id || "—"}</b>
</p>

<p>
The access token has been successfully generated,
verified and stored in PostgreSQL.
</p>

<a href="/">Return to RRE</a>

</div>

</body>
</html>
    `);

  } catch (err) {

    console.error("====================================");
    console.error("KITE AUTHENTICATION ERROR");
    console.error(err);
    console.error("====================================");

    res.status(500).send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kite Authentication Error</title>
</head>

<body>

<h2>❌ Kite Authentication Failed</h2>

<p>
The request token could not be exchanged for an access token.
</p>

<p>
Check the Render logs for the exact Kite error.
</p>

<a href="/">Return to RRE</a>

</body>
</html>
    `);
  }
});

// --------------------------------------------------
// Test stored token
// --------------------------------------------------

app.get("/kite/test", async (req, res) => {

  try {

    const session = await getStoredAccessToken();

    if (!session?.access_token) {
      return res.status(401).json({
        success: false,
        message: "No access token stored."
      });
    }

    if (!kite) {
      return res.status(500).json({
        success: false,
        message: "Kite client not initialized."
      });
    }

    kite.setAccessToken(session.access_token);

    const profile = await kite.getProfile();

    res.json({
      success: true,
      message: "Kite access token is working.",
      user: profile
    });

  } catch (err) {

    console.error("Kite token test failed:", err.message);

    res.status(500).json({
      success: false,
      message: "Stored access token is not working.",
      error: err.message
    });
  }
});

// --------------------------------------------------
// RRE market endpoint
// --------------------------------------------------

app.get("/api/rre/eligible-stocks", async (req, res) => {

  try {

    const session = await getStoredAccessToken();

    if (!session?.access_token) {
      return res.status(401).json({
        error: "KITE_ACCESS_TOKEN_NOT_CONFIGURED"
      });
    }

    kite.setAccessToken(session.access_token);

    const exchange =
      req.query.exchange || "NSE";

    const query =
      String(req.query.query || "")
        .trim()
        .toUpperCase();

    // -----------------------------------------------
    // Search exact instruments
    // -----------------------------------------------

    const instruments =
      await kite.getInstruments(exchange);

    let filtered = instruments.filter(item => {

      if (item.instrument_type !== "EQ") {
        return false;
      }

      if (!query) {
        return true;
      }

      return (
        String(item.tradingsymbol)
          .toUpperCase()
          .includes(query) ||
        String(item.name || "")
          .toUpperCase()
          .includes(query)
      );
    });

    // Limit candidate count
    filtered = filtered.slice(0, 50);

    if (!filtered.length) {
      return res.json([]);
    }

    // -----------------------------------------------
    // Get live prices
    // -----------------------------------------------

    const symbols = filtered.map(
      item =>
        `${item.exchange}:${item.tradingsymbol}`
    );

    const ltp =
      await kite.getLTP(symbols);

    const results = filtered
      .map(item => {

        const key =
          `${item.exchange}:${item.tradingsymbol}`;

        const quote = ltp?.[key];

        if (!quote) {
          return null;
        }

        return {
          exchange: item.exchange,
          tradingsymbol: item.tradingsymbol,
          name: item.name,
          instrument_token:
            item.instrument_token,
          last_price:
            quote.last_price,
          change: 0,
          rre_score: null,
          risk: "LIVE",
          day_fit: "LIVE MARKET"
        };
      })
      .filter(Boolean);

    res.json(results);

  } catch (err) {

    console.error(
      "Eligible stocks error:",
      err.message
    );

    res.status(500).json({
      error: "MARKET_DATA_ERROR",
      message: err.message
    });
  }
});

// --------------------------------------------------
// Error handler
// --------------------------------------------------

app.use((err, req, res, next) => {

  console.error("SERVER ERROR:", err);

  res.status(500).json({
    error: "SERVER_ERROR",
    message: err.message
  });
});

// --------------------------------------------------
// Start
// --------------------------------------------------

async function startServer() {

  try {

    await initDatabase();

    app.listen(PORT, () => {

      console.log(
        `RRE backend v3 running on port ${PORT}`
      );

      console.log(
        `Kite API configured: ${
          !!KITE_API_KEY && !!KITE_API_SECRET
        }`
      );

      console.log(
        `Database configured: ${!!pool}`
      );

    });

  } catch (err) {

    console.error(
      "Failed to start RRE backend:",
      err
    );

    process.exit(1);
  }
}

startServer();