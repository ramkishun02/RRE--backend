require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const session = require("express-session");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 5000;

const KITE_API_KEY = process.env.KITE_API_KEY;
const KITE_API_SECRET = process.env.KITE_API_SECRET;
const KITE_REDIRECT_URL = process.env.KITE_REDIRECT_URL;

if (!KITE_API_KEY || !KITE_API_SECRET || !KITE_REDIRECT_URL) {
  console.error("Missing Kite settings in .env");
  process.exit(1);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "development-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: "lax"
    }
  })
);

app.use(express.static(__dirname));

function kiteHeaders(req) {
  if (!req.session.accessToken) {
    return null;
  }

  return {
    Authorization: `token ${KITE_API_KEY}:${req.session.accessToken}`,
    "X-Kite-Version": "3"
  };
}

function requireKiteLogin(req, res, next) {
  if (!req.session.accessToken) {
    return res.status(401).json({
      error: "Kite authentication required"
    });
  }

  next();
}

/*
  Main page
*/
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/*
  Start Kite login
*/
app.get("/auth/kite/login", (req, res) => {
  const loginUrl =
    `https://kite.zerodha.com/connect/login?v=3` +
    `&api_key=${encodeURIComponent(KITE_API_KEY)}`;

  res.redirect(loginUrl);
});

/*
  Kite redirects here after login
*/
app.get("/auth/kite/callback", async (req, res) => {
  const { request_token, status } = req.query;

  if (status !== "success" || !request_token) {
    return res.status(400).send("Kite login was not completed.");
  }

  try {
    const checksum = crypto
      .createHash("sha256")
      .update(KITE_API_KEY + request_token + KITE_API_SECRET)
      .digest("hex");

    const response = await axios.post(
      "https://api.kite.trade/session/token",
      new URLSearchParams({
        api_key: KITE_API_KEY,
        request_token,
        checksum
      }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Kite-Version": "3"
        }
      }
    );

    req.session.accessToken = response.data.data.access_token;
    req.session.user = response.data.data.user_id;

    res.redirect("/?kite=connected");
  } catch (error) {
    const message =
      error.response?.data?.message || error.message || "Kite login failed";

    console.error("Kite authentication error:", message);
    res.status(500).send(`Kite authentication failed: ${message}`);
  }
});

/*
  Check whether Kite is connected
*/
app.get("/api/auth/status", (req, res) => {
  res.json({
    connected: Boolean(req.session.accessToken),
    userId: req.session.user || null
  });
});

/*
  Logout
*/
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

/*
  Search stocks using Kite instruments
*/
app.get("/api/stocks/search", requireKiteLogin, async (req, res) => {
  const query = String(req.query.q || "").trim().toUpperCase();

  if (!query) {
    return res.json([]);
  }

  try {
    const response = await axios.get(
      "https://api.kite.trade/instruments",
      {
        headers: kiteHeaders(req),
        responseType: "text"
      }
    );

const lines = response.data.split("");
    const headings = lines.shift().split(",");
    const symbolIndex = headings.indexOf("tradingsymbol");
    const nameIndex = headings.indexOf("name");
    const exchangeIndex = headings.indexOf("exchange");
    const tokenIndex = headings.indexOf("instrument_token");

    const results = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      const columns = line.split(",");
      const symbol = columns[symbolIndex] || "";
      const name = columns[nameIndex] || "";
      const exchange = columns[exchangeIndex] || "";

      if (
        symbol.toUpperCase().includes(query) ||
        name.toUpperCase().includes(query)
      ) {
        results.push({
          symbol,
          name,
          exchange,
          instrumentToken: columns[tokenIndex] || null
        });
      }

      if (results.length >= 20) break;
    }

    res.json(results);
  } catch (error) {
    const message =
      error.response?.data?.message || error.message || "Stock search failed";

    console.error("Stock search error:", message);
    res.status(500).json({ error: message });
  }
});

/*
  Get live quote
  Example:
  /api/stocks/quote?instrument=NSE:INFY
*/
app.get("/api/stocks/quote", requireKiteLogin, async (req, res) => {
  const instrument = String(req.query.instrument || "").trim();

  if (!instrument) {
    return res.status(400).json({
      error: "instrument is required, for example NSE:INFY"
    });
  }

  try {
    const response = await axios.get(
      "https://api.kite.trade/quote",
      {
        headers: kiteHeaders(req),
        params: {
          i: instrument
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    const message =
      error.response?.data?.message || error.message || "Quote failed";

    console.error("Quote error:", message);
    res.status(500).json({ error: message });
  }
});

/*
  Get profile after login
*/
app.get("/api/profile", requireKiteLogin, async (req, res) => {
  try {
    const response = await axios.get(
      "https://api.kite.trade/user/profile",
      {
        headers: kiteHeaders(req)
      }
    );

    res.json(response.data);
  } catch (error) {
    const message =
      error.response?.data?.message || error.message || "Profile request failed";

    res.status(500).json({ error: message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
