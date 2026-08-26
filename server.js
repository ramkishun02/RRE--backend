"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 5000;
const KITE_API_KEY = process.env.KITE_API_KEY;
const KITE_API_SECRET = process.env.KITE_API_SECRET;

let kiteSession = {
  accessToken: null,
  userId: null,
  userName: null,
};

const stocks = [
  {
    symbol: "INFY",
    name: "Infosys Limited",
    exchange: "NSE",
    price: 1520,
  },
  {
    symbol: "TCS",
    name: "Tata Consultancy Services",
    exchange: "NSE",
    price: 3420,
  },
  {
    symbol: "RELIANCE",
    name: "Reliance Industries",
    exchange: "NSE",
    price: 2880,
  },
  {
    symbol: "ITC",
    name: "ITC Limited",
    exchange: "NSE",
    price: 470,
  },
  {
    symbol: "HDFCBANK",
    name: "HDFC Bank Limited",
    exchange: "NSE",
    price: 1710,
  },
  {
    symbol: "SBIN",
    name: "State Bank of India",
    exchange: "NSE",
    price: 820,
  },
];

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve index.html, style.css, and app.js
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Basic health check
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "Server is running",
  });
});

// Start Kite login
app.get("/kite/login", (req, res) => {
  if (!KITE_API_KEY) {
    return res.status(500).send("KITE_API_KEY is missing");
  }

  const loginUrl =
    `https://kite.zerodha.com/connect/login?v=3&api_key=` +
    encodeURIComponent(KITE_API_KEY);

  res.redirect(loginUrl);
});

// Kite callback
app.get("/kite/callback", async (req, res) => {
  try {
    const { request_token, status } = req.query;

    if (status !== "success" || !request_token) {
      return res.status(400).send("Kite login was not completed");
    }

    if (!KITE_API_KEY || !KITE_API_SECRET) {
      return res.status(500).send("Kite credentials are missing");
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

    const result = await response.json();

    if (!response.ok || !result.data?.access_token) {
      console.error("Kite token error:", result);
      return res.status(502).send("Could not create Kite session");
    }

    kiteSession.accessToken = result.data.access_token;
    kiteSession.userId = result.data.user_id || null;
    kiteSession.userName = result.data.user_name || null;

    res.redirect("/?login=success");
  } catch (error) {
    console.error("Kite callback error:", error);
    res.status(500).send("Kite authentication failed");
  }
});

// Check whether Kite session is active
app.get("/api/auth/status", async (req, res) => {
  if (!kiteSession.accessToken) {
    return res.json({
      connected: false,
      message: "Kite is not connected",
    });
  }

  try {
    const response = await fetch("https://api.kite.trade/user/profile", {
      method: "GET",
      headers: {
        "X-Kite-Version": "3",
        Authorization: `token ${KITE_API_KEY}:${kiteSession.accessToken}`,
      },
    });

    const result = await response.json();

    if (!response.ok || !result.data) {
      kiteSession = {
        accessToken: null,
        userId: null,
        userName: null,
      };

      return res.status(401).json({
        connected: false,
        message: "Kite session expired",
      });
    }

    kiteSession.userId = result.data.user_id || kiteSession.userId;
    kiteSession.userName = result.data.user_name || kiteSession.userName;

    res.json({
      connected: true,
      userId: kiteSession.userId,
      userName: kiteSession.userName,
      email: result.data.email || "",
      message: "Kite session is active",
    });
  } catch (error) {
    console.error("Kite status error:", error);

    res.status(500).json({
      connected: false,
      message: "Could not check Kite session",
    });
  }
});

// Logout
app.post("/api/auth/logout", async (req, res) => {
  try {
    if (kiteSession.accessToken && KITE_API_KEY) {
      await fetch(
        `https://api.kite.trade/session/token?api_key=${encodeURIComponent(
          KITE_API_KEY
        )}`,
        {
          method: "DELETE",
          headers: {
            "X-Kite-Version": "3",
            Authorization: `token ${KITE_API_KEY}:${kiteSession.accessToken}`,
          },
        }
      );
    }
  } catch (error) {
    console.error("Kite logout error:", error);
  }

  kiteSession = {
    accessToken: null,
    userId: null,
    userName: null,
  };

  res.json({
    success: true,
    message: "Logged out",
  });
});

// Stock search
app.get("/api/stocks/search", (req, res) => {
  if (!kiteSession.accessToken) {
    return res.status(401).json({
      error: "Please connect Kite first",
    });
  }

  const query = String(req.query.q || "").trim().toUpperCase();

  if (!query) {
    return res.json([]);
  }

  const results = stocks.filter((stock) => {
    const searchableText =
      `${stock.symbol} ${stock.name} ${stock.exchange}`.toUpperCase();

    return searchableText.includes(query);
  });

  res.json(results);
});

// Dashboard data
app.get("/api/dashboard", (req, res) => {
  res.json({
    totalInvested: 0,
    currentValue: 0,
    profitLoss: 0,
    activeStrategy: null,
    recentActivity: [],
  });
});

// Paper order preview
app.post("/api/orders/preview", (req, res) => {
  if (!kiteSession.accessToken) {
    return res.status(401).json({
      error: "Please connect Kite first",
    });
  }

  const {
    symbol,
    exchange = "NSE",
    quantity,
    price,
  } = req.body;

  if (!symbol || !quantity || Number(quantity) <= 0) {
    return res.status(400).json({
      error: "Symbol and valid quantity are required",
    });
  }

  const orderPrice = Number(price || 0);
  const qty = Number(quantity);

  res.json({
    symbol: String(symbol).toUpperCase(),
    exchange,
    quantity: qty,
    price: orderPrice,
    total: Number((qty * orderPrice).toFixed(2)),
    mode: "PAPER",
    message: "Order preview created",
  });
});

// Paper order confirmation
app.post("/api/orders/confirm", (req, res) => {
  if (!kiteSession.accessToken) {
    return res.status(401).json({
      error: "Please connect Kite first",
    });
  }

  const {
    symbol,
    exchange = "NSE",
    quantity,
    price,
  } = req.body;

  if (!symbol || !quantity || Number(quantity) <= 0) {
    return res.status(400).json({
      error: "Symbol and valid quantity are required",
    });
  }

  res.json({
    success: true,
    mode: "PAPER",
    orderId: `PAPER-${Date.now()}`,
    symbol: String(symbol).toUpperCase(),
    exchange,
    quantity: Number(quantity),
    price: Number(price || 0),
    status: "COMPLETE",
  });
});

// Unknown route
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});