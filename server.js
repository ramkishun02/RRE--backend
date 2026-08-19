const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { KiteConnect } = require("kiteconnect");

const app = express();
const PORT = process.env.PORT || 10000;
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const env = (name) => (process.env[name] || "").trim();

const pool = new Pool({
  connectionString: env("DATABASE_URL"),
  ssl: env("DATABASE_URL") ? { rejectUnauthorized: false } : false
});

let dbReady = false;

async function initDatabase() {
  if (!env("DATABASE_URL")) {
    console.warn("DATABASE_URL is not configured.");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kite_session (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token TEXT NOT NULL,
      user_id TEXT,
      user_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  dbReady = true;
  console.log("RRE database initialized.");
}

async function saveKiteSession(session) {
  if (!dbReady) throw new Error("Database is not ready.");

  await pool.query(
    `INSERT INTO kite_session
      (id, access_token, user_id, user_name)
     VALUES (1, $1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      user_id = EXCLUDED.user_id,
      user_name = EXCLUDED.user_name,
      updated_at = NOW()`,
    [session.access_token, session.user_id || null, session.user_name || null]
  );
}

async function getStoredAccessToken() {
  if (!dbReady) return null;
  const result = await pool.query(
    "SELECT access_token FROM kite_session WHERE id = 1"
  );
  return result.rows[0]?.access_token || null;
}

async function getKite() {
  const apiKey = env("KITE_API_KEY");
  if (!apiKey) throw new Error("KITE_API_KEY is missing");

  const kite = new KiteConnect({ api_key: apiKey });
  const token = await getStoredAccessToken();
  if (token) kite.setAccessToken(token);
  return kite;
}

app.get("/", (req, res) => {
  res.type("html").send(`
    <h1>RRE Backend v3</h1>
    <p>Status: <b>RUNNING</b></p>
    <p><a href="/health">Health check</a></p>
    <p><a href="/api/status">Configuration status</a></p>
    <p><a href="/kite/login">Connect Kite</a></p>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "RRE Node.js Backend v3",
    databaseConfigured: !!env("DATABASE_URL"),
    databaseReady: dbReady,
    time: new Date().toISOString()
  });
});

app.get("/api/status", async (req, res) => {
  let token = false;
  try {
    token = !!(await getStoredAccessToken());
  } catch (e) {
    console.error("Status DB error:", e.message);
  }

  res.json({
    backend: true,
    kitePackage: true,
    apiKeyConfigured: !!env("KITE_API_KEY"),
    databaseConfigured: !!env("DATABASE_URL"),
    databaseReady: dbReady,
    accessTokenConfigured: token
  });
});

app.get("/kite/login", (req, res) => {
  try {
    const kite = new KiteConnect({ api_key: env("KITE_API_KEY") });
    res.redirect(kite.getLoginURL());
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.get("/kite/callback", async (req, res) => {
  const requestToken = String(req.query.request_token || "").trim();

  if (!requestToken) {
    return res.status(400).send(
      "<h2>RRE Kite Callback</h2><p>No request_token received.</p>"
    );
  }

  try {
    const apiKey = env("KITE_API_KEY");
    const apiSecret = env("KITE_API_SECRET");

    if (!apiKey) throw new Error("KITE_API_KEY is missing");
    if (!apiSecret) throw new Error("KITE_API_SECRET is missing");
    if (!dbReady) throw new Error("Database is not ready");

    const kite = new KiteConnect({ api_key: apiKey });
    const session = await kite.generateSession(requestToken, {
      api_secret: apiSecret
    });

    await saveKiteSession(session);

    res.send(`
      <h2>RRE Kite Authentication Successful</h2>
      <p>User: ${String(session.user_name || session.user_id || "Connected")}</p>
      <p>Access token securely stored on the RRE server.</p>
      <p>You can return to RRE.</p>
    `);
  } catch (e) {
    console.error("Kite callback error:", e);
    res.status(500).send(`<h2>Kite Authentication Failed</h2><p>${e.message}</p>`);
  }
});

app.get("/api/kite/profile", async (req, res) => {
  try {
    const token = await getStoredAccessToken();
    if (!token) throw new Error("No stored Kite access token");

    const profile = await (await getKite()).getProfile();

    res.json({
      ok: true,
      connected: true,
      user_id: profile.user_id,
      user_name: profile.user_name,
      email: profile.email
    });
  } catch (e) {
    res.status(401).json({ ok: false, connected: false, message: e.message });
  }
});

app.get("/api/market/quote", async (req, res) => {
  const symbol = String(req.query.symbol || "").trim().toUpperCase();

  if (!symbol) {
    return res.status(400).json({ ok: false, message: "Symbol is required." });
  }

  try {
    const token = await getStoredAccessToken();
    if (!token) throw new Error("Kite is not connected. Authorize Kite first.");

    const key = `NSE:${symbol}`;
    const data = await (await getKite()).getLTP([key]);
    const quote = data[key];

    if (!quote) {
      return res.status(404).json({ ok: false, message: "No quote returned." });
    }

    res.json({
      ok: true,
      exchange: "NSE",
      tradingsymbol: symbol,
      last_price: quote.last_price,
      instrument_token: quote.instrument_token
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.get("/api/market/search", async (req, res) => {
  const q = String(req.query.q || "").trim().toUpperCase();

  if (!q) return res.json({ ok: true, stocks: [] });

  try {
    const token = await getStoredAccessToken();
    if (!token) throw new Error("Kite is not connected.");

    const kite = await getKite();
    const instruments = await kite.getInstruments("NSE");

    const matches = instruments.filter(x =>
      String(x.tradingsymbol || "").toUpperCase().includes(q) ||
      String(x.name || "").toUpperCase().includes(q)
    ).slice(0, 25);

    let quotes = {};
    if (matches.length) {
      try {
        quotes = await kite.getLTP(
          matches.map(x => `NSE:${x.tradingsymbol}`)
        );
      } catch (e) {
        console.warn("LTP unavailable:", e.message);
      }
    }

    res.json({
      ok: true,
      stocks: matches.map(x => ({
        exchange: "NSE",
        tradingsymbol: x.tradingsymbol,
        name: x.name || x.tradingsymbol,
        instrument_token: String(x.instrument_token),
        last_price: quotes[`NSE:${x.tradingsymbol}`]?.last_price || null
      }))
    });
  } catch (e) {
    res.status(500).json({ ok: false, stocks: [], message: e.message });
  }
});

/* Decision layer only: no order execution */
app.post("/api/rre/decision", (req, res) => {
  const symbol = String(req.body?.symbol || "").trim().toUpperCase();

  if (!symbol) {
    return res.status(400).json({ ok: false, message: "Symbol is required." });
  }

  res.json({
    ok: true,
    stage: "DECISION_PENDING",
    symbol,
    aiAssist: true,
    userConfirmationRequired: true,
    executionEnabled: false,
    message: "No order was placed."
  });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not Found", path: req.path });
});

async function start() {
  try {
    await initDatabase();
  } catch (e) {
    console.error("Database initialization failed:", e.message);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`RRE backend v3 running on port ${PORT}`);
  });
}

start();
