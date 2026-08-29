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

/*app.get("/kite/callback", async (req, res)  => {
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
*/
function authenticationPage(success, message) {
  const color = success ? "#16a34a" : "#dc2626";
  const icon = success ? "✓" : "!";
  const title = success
    ? "Authentication Complete"
    : "Authentication Failed";

  const nextUrl = DASHBOARD_URL || "/";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport"
        content="width=device-width, initial-scale=1">
  <title>${title}</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      background: #08111f;
      color: white;
      font-family: Arial, sans-serif;
    }

    .card {
      width: 100%;
      max-width: 390px;
      padding: 30px 22px;
      text-align: center;
      background: #111c2e;
      border: 1px solid #263853;
      border-radius: 18px;
      box-shadow: 0 15px 40px rgba(0, 0, 0, .35);
    }

    .icon {
      width: 64px;
      height: 64px;
      margin: 0 auto 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: ${color};
      color: white;
      font-size: 38px;
      font-weight: bold;
    }

    h1 {
      margin: 0 0 12px;
      font-size: 23px;
    }

    p {
      margin: 0;
      color: #bdc8d8;
      line-height: 1.5;
    }

    button,
    a {
      display: inline-block;
      margin-top: 24px;
      padding: 13px 20px;
      border: 0;
      border-radius: 9px;
      background: #2563eb;
      color: white;
      font-size: 15px;
      text-decoration: none;
      cursor: pointer;
    }

    .status {
      margin-top: 18px;
      color: ${color};
      font-size: 13px;
      font-weight: bold;
    }
  </style>
</head>

<body>
  <main class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>

    ${
      success
        ? `
          <div class="status">
            Kite connection is active
          </div>

          <a href="${nextUrl}">
            Continue to Dashboard
          </a>
        `
        : `
          <a href="/kite/login">
            Try Again
          </a>
        `
    }
  </main>

  ${
    success
      ? `
        <script>
          setTimeout(() => {
            window.location.href =
              ${JSON.stringify(nextUrl)};
          }, 5000);
        </script>
      `
      : ""
  }
</body>
</html>`;
}
//new function added
app.get("/kite/callback", async (req, res) => {
  const requestToken = String(
    req.query.request_token || ""
  ).trim();

  const status = String(req.query.status || "");

  if (status !== "success" || !requestToken) {
    return res.status(400).send(authenticationPage(
      false,
      "Kite did not return a valid request token."
    ));
  }

  if (!KITE_API_KEY || !KITE_API_SECRET) {
    return res.status(500).send(authenticationPage(
      false,
      "Kite API key or API secret is missing."
    ));
  }

  if (!db) {
    return res.status(500).send(authenticationPage(
      false,
      "Database is not configured, so the Kite token cannot be saved."
    ));
  }

  try {
    const requestBody = new URLSearchParams({
      api_key: KITE_API_KEY,
      request_token: requestToken,
      checksum: checksum(
        KITE_API_KEY,
        requestToken,
        KITE_API_SECRET
      )
    });

    const response = await fetch(
      "https://api.kite.trade/session/token",
      {
        method: "POST",
        headers: {
          "X-Kite-Version": "3",
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: requestBody.toString()
      }
    );

    const result = await response.json();

    console.log("Kite authentication response:", {
      status: result.status,
      errorType: result.error_type,
      message: result.message
    });

    if (
      !response.ok ||
      result.status !== "success" ||
      !result.data?.access_token
    ) {
      return res.status(response.status || 400).send(
        authenticationPage(
          false,
          result.message ||
            "Kite token exchange was unsuccessful."
        )
      );
    }

    await saveKiteToken(
      result.data.access_token,
      result.data.user_id,
      result.data.login_time
    );

    console.log(
      "Kite authentication completed for:",
      result.data.user_id
    );

    return res.send(authenticationPage(
      true,
      "Kite authentication completed successfully."
    ));
  } catch (error) {
    console.error("Kite callback error:", error);

    return res.status(500).send(
      authenticationPage(
        false,
        error.message || "Authentication failed."
      )
    );
  }
});
//
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