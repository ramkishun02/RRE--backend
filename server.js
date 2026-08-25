"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 5000;
const KITE_API_KEY = process.env.KITE_API_KEY;
const KITE_API_SECRET = process.env.KITE_API_SECRET;
const PAPER_MODE = String(process.env.PAPER_MODE || "true") === "true";

let kiteSession = {
  accessToken: null,
  userId: null,
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/dashboard", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/auth/status", (req, res) => {
  res.json({
    connected: Boolean(kiteSession.accessToken),
    userId: kiteSession.userId,
    paperMode: PAPER_MODE,
  });
});

app.get("/kite/login", (req, res) => {
  if (!KITE_API_KEY) {
    return res.status(500).send("KITE_API_KEY is missing");
  }

  const loginUrl = `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(
    KITE_API_KEY
  )}`;

  return res.redirect(loginUrl);
});

app.get("/kite/callback", async (req, res) => {
  try {
    const { request_token, status } = req.query;

    if (status !== "success" || !request_token) {
      return res.status(400).send("Kite login failed");
    }

    if (!KITE_API_KEY || !KITE_API_SECRET) {
      return res.status(500).send("Kite credentials missing");
    }

    const checksum = crypto
      .createHash("sha256")
      .update(`${KITE_API_KEY}${request_token}${KITE_API_SECRET}`)
      .digest("hex");

    const response = await fetch("https://api.kite.trade/session/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Kite-Version": "3",
      },
      body: new URLSearchParams({
        api_key: KITE_API_KEY,
        request_token,
        checksum,
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.data || !data.data.access_token) {
      console.error("Kite token exchange failed:", data);
      return res.status(502).send("Could not create Kite session");
    }

    kiteSession.accessToken = data.data.access_token;
    kiteSession.userId = data.data.user_id || null;

    return res.redirect("/dashboard");
  } catch (error) {
    console.error("Kite callback error:", error);
    return res.status(500).send("Kite authentication error");
  }
});

app.get("/api/stocks/search", (req, res) => {
  if (!kiteSession.accessToken) {
    return res.status(401).json({ error: "Kite not connected" });
  }

  const q = String(req.query.q || "").trim().toUpperCase();

  if (!q) {
    return res.json([]);
  }

  const stocks = [
    { symbol: "INFY", name: "Infosys Limited", exchange: "NSE", price: 1520 },
    { symbol: "TCS", name: "Tata Consultancy Services", exchange: "NSE", price: 3420 },
    { symbol: "RELIANCE", name: "Reliance Industries", exchange: "NSE", price: 2880 },
    { symbol: "ITC", name: "ITC Limited", exchange: "NSE", price: 470 },
    { symbol: "HDFCBANK", name: "HDFC Bank", exchange: "NSE", price: 1710 },
    { symbol: "SBIN", name: "State Bank of India", exchange: "NSE", price: 820 },
  ];

  const results = stocks.filter((stock) => {
    const text = `${stock.symbol} ${stock.name} ${stock.exchange}`.toUpperCase();
    return text.includes(q);
  });

  return res.json(results);
});

app.post("/api/orders/preview", (req, res) => {
  const {
    symbol,
    exchange = "NSE",
    quantity,
    price,
    targetPercentage = 8,
  } = req.body;

  if (!symbol || !Number.isInteger(Number(quantity)) || Number(quantity) <= 0) {
    return res.status(400).json({ error: "Invalid order data" });
  }

  const entryPrice = Number(price || 0);
  const tp = Number(targetPercentage) / 100;

  return res.json({
    symbol,
    exchange,
    quantity: Number(quantity),
    purchasePrice: entryPrice,
    stopLoss: entryPrice,
    targetPrice: Number((entryPrice * (1 + tp)).toFixed(2)),
    targetPercentage: Number(targetPercentage),
    mode: PAPER_MODE ? "PAPER" : "LIVE",
  });
});

app.post("/api/orders/confirm", (req, res) => {
  const { symbol, quantity, price } = req.body;

  if (!symbol || !quantity) {
    return res.status(400).json({ error: "Invalid order" });
  }

  if (PAPER_MODE) {
    return res.json({
      mode: "PAPER",
      status: "COMPLETE",
      order_id: `PAPER-${Date.now()}`,
      symbol,
      quantity,
      price: Number(price || 0),
    });
  }

  if (!kiteSession.accessToken) {
    return res.status(401).json({ error: "Kite not connected" });
  }

  return res.json({
    mode: "LIVE",
    status: "NOT_IMPLEMENTED_YET",
    message: "Live order integration will be added next",
  });
});

app.use((req, res) => {
  res.status(404).send("Not found");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});