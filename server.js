
"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

const app = express();

// Server
const PORT = Number(process.env.PORT || 10000);

// Kite
const KITE_API_KEY = process.env.KITE_API_KEY || "";
const KITE_API_SECRET = process.env.KITE_API_SECRET || "";
const BASE_URL =
  process.env.BASE_URL || "https://rre-backend-1.onrender.com";
const CALLBACK_URL =
  process.env.KITE_REDIRECT_URL || `${BASE_URL}/kite/callback`;
const DASHBOARD_URL =
  process.env.DASHBOARD_URL || `${BASE_URL}/dashboard`;

// Algo IP service
const ALGOIP_HOST = process.env.ALGOIP_HOST || "";
const ALGOIP_PORT = process.env.ALGOIP_PORT || "";
const ALGOIP_USER = process.env.ALGOIP_USER || "";
const ALGOIP_PASS = process.env.ALGOIP_PASS || "";
const ALGOIP_ENABLED =
  process.env.ALGOIP_ENABLED === "true" || false;

const DATABASE_URL = process.env.DATABASE_URL || "";

let db = null;
let cachedInstruments = [];

if (DATABASE_URL) {
  db = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  db.on("error", (error) => {
    console.error("Database error:", error.message);
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

function checksum(apiKey, requestToken, apiSecret) {
  return crypto
    .createHash("sha256")
    .update(apiKey + requestToken + apiSecret)
    .digest("hex");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sendPage(res, title, message, success) {
  var html = "<!DOCTYPE html>";
  html += '<html lang="en">';
  html += "<head>";
  html += '<meta charset="UTF-8">';
  html += '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
  html += "<title>" + escapeHtml(title) + "</title>";
  html += "</head>";
  html += "<body>";
  html += "<h1>" + escapeHtml(title) + "</h1>";
  html += "<p>" + escapeHtml(message) + "</p>";

  if (success) {
    html += '<a href="' + escapeHtml(DASHBOARD_URL) + '">';
    html += "Continue to Dashboard";
    html += "</a>";
  } else {
    html += '<a href="/kite/login">Try Again</a>';
  }

  html += "</body>";
  html += "</html>";

  return res.send(html);
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];

    if (character === '"') {
      if (insideQuotes && line[i + 1] === '"') {
        value += '"';
        i += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (character === "," && !insideQuotes) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }

  values.push(value.trim());
  return values;
}

async function initializeDatabase() {
  if (!db) {
    console.log("DATABASE_URL is not configured.");
    return;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS kitetokens (
      id INTEGER PRIMARY KEY,
      accesstoken TEXT NOT NULL,
      userid TEXT,
      logintime TEXT,
      updatedat TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log("Database initialized.");
}

async function saveKiteToken(accessToken, userId, loginTime) {
  if (!db) {
    throw new Error("DATABASE_URL is not configured.");
  }

  await db.query(
    `
      INSERT INTO kitetokens
        (id, accesstoken, userid, logintime, updatedat)
      VALUES
        (1, $1, $2, $3, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        accesstoken = EXCLUDED.accesstoken,
        userid = EXCLUDED.userid,
        logintime = EXCLUDED.logintime,
        updatedat = NOW()
    `,
    [accessToken, userId || null, loginTime || null]
  );
}

async function getKiteToken() {
  if (!db) return null;

  const result = await db.query(`
    SELECT accesstoken, userid, logintime
    FROM kitetokens
    WHERE id = 1
    LIMIT 1
  `);

  return result.rows[0] || null;
}

async function deleteKiteToken() {
  if (!db) return;
  await db.query("DELETE FROM kitetokens WHERE id = 1");
}

async function downloadInstruments() {
  if (!KITE_API_KEY) return [];

  const token = await getKiteToken();

  if (!token || !token.accesstoken) {
    return [];
  }

  const response = await fetch(
    "https://api.kite.trade/instruments/NSE",
    {
      headers: {
        "X-Kite-Version": "3",
        Authorization: `token ${KITE_API_KEY}:${token.accesstoken}`
      }
    }
  );

  const csv = await response.text();

  if (!response.ok) {
    throw new Error(csv || "Unable to download NSE instruments.");
  }

  const lines = csv.split(/
?
/);

  if (lines.length < 2) {
    return [];
  }

  const headings = parseCsvLine(lines.shift());

  const symbolIndex = headings.indexOf("tradingsymbol");
  const nameIndex = headings.indexOf("name");
  const tokenIndex = headings.indexOf("instrument_token");

  return lines
    .map(parseCsvLine)
    .map((columns) => ({
      exchange: "NSE",
      symbol: columns[symbolIndex] || "",
      name: columns[nameIndex] || columns[symbolIndex] || "",
      instrumentToken: columns[tokenIndex] || ""
    }))
    .filter((item) => item.symbol);
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", async (req, res) => {
  try {
    const token = await getKiteToken();

    res.json({
      success: true,
      backend: true,
      kiteConfigured: Boolean(KITE_API_KEY && KITE_API_SECRET),
      databaseConfigured: Boolean(DATABASE_URL),
      accessTokenConfigured: Boolean(token?.accesstoken),
      callbackUrl: CALLBACK_URL,
      dashboardUrl: DASHBOARD_URL,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get("/api/auth/status", async (req, res) => {
  try {
    const token = await getKiteToken();

    res.json({
      success: true,
      connected: Boolean(token?.accesstoken),
      userId: token?.userid || null,
      loginTime: token?.logintime || null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get("/kite/login", (req, res) => {
  if (!KITE_API_KEY) {
    return sendPage(
      res,
      "Kite Configuration Error",
      "KITE_API_KEY is missing."
    );
  }

  const loginUrl =
    "https://kite.zerodha.com/connect/login?v=3&api_key=" +
    encodeURIComponent(KITE_API_KEY);

  return res.redirect(loginUrl);
});

app.get("/kite/callback", async (req, res) => {
  const requestToken = String(req.query.request_token || "").trim();
  const status = String(req.query.status || "");

  if (status !== "success" || !requestToken) {
    return sendPage(
      res,
      "Authentication Failed",
      "Kite did not return a valid request token."
    );
  }

  if (!KITE_API_KEY || !KITE_API_SECRET) {
    return sendPage(
      res,
      "Configuration Error",
      "KITE_API_KEY or KITE_API_SECRET is missing."
    );
  }

  if (!db) {
    return sendPage(
      res,
      "Database Error",
      "DATABASE_URL is missing. The Kite token cannot be saved."
    );
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

    const response = await fetch(
      "https://api.kite.trade/session/token",
      {
        method: "POST",
        headers: {
          "X-Kite-Version": "3",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      }
    );

    const result = await response.json();

    if (
      !response.ok ||
      result.status !== "success" ||
      !result.data?.access_token
    ) {
      return sendPage(
        res,
        "Kite Authentication Failed",
        result.message || "Kite token exchange failed."
      );
    }

    await saveKiteToken(
      result.data.access_token,
      result.data.user_id,
      result.data.login_time
    );

    return sendPage(
      res,
      "Authentication Complete",
      "Kite authentication completed successfully.",
      true
    );
  } catch (error) {
    console.error("Callback error:", error);

    return sendPage(
      res,
      "Authentication Error",
      error.message
    );
  }
});

app.get("/dashboard", async (req, res) => {
  try {
    const token = await getKiteToken();

    if (!token || !token.accesstoken) {
      return res.redirect("/kite/login");
    }

    return res.sendFile(path.join(__dirname, "index.html"));
  } catch (error) {
    return res.status(500).send(
      `Dashboard error: ${escapeHtml(error.message)}`
    );
  }
});

app.get("/api/stocks/search", async (req, res) => {
  try {
    const query = String(req.query.q || "")
      .trim()
      .toUpperCase();

    if (!query) {
      return res.json({
        success: true,
        results: []
      });
    }

    if (!cachedInstruments.length) {
      cachedInstruments = await downloadInstruments();
    }

    const results = cachedInstruments
      .filter((item) => {
        const symbol = item.symbol.toUpperCase();
        const name = item.name.toUpperCase();

        return (
          symbol.includes(query) ||
          name.includes(query)
        );
      })
      .slice(0, 20);

    return res.json({
      success: true,
      results
    });
  } catch (error) {
    console.error("Stock search error:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get("/api/market/quote", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "")
      .trim()
      .toUpperCase();

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: "Use ?symbol=RELIANCE"
      });
    }

    const token = await getKiteToken();

    if (!token || !token.accesstoken) {
      return res.status(401).json({
        success: false,
        message: "Connect Kite first."
      });
    }

    const instrument = `NSE:${symbol}`;

    const response = await fetch(
      "https://api.kite.trade/quote/ltp" +
        `?i=${encodeURIComponent(instrument)}`,
      {
        headers: {
          "X-Kite-Version": "3",
          Authorization: `token ${KITE_API_KEY}:${token.accesstoken}`
        }
      }
    );

    const result = await response.json();

    if (!response.ok || result.status !== "success") {
      return res.status(response.status || 500).json({
        success: false,
        message: result.message || "Kite quote failed."
      });
    }

    const quote = result.data?.[instrument];

    if (!quote) {
      return res.status(404).json({
        success: false,
        message: `${instrument} was not found.`
      });
    }

    return res.json({
      success: true,
      exchange: "NSE",
      symbol,
      last_price: quote.last_price,
      source: "Kite Connect",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Quote error:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ---------------------------
// REAL ORDER EXECUTION
// ---------------------------

app.post("/api/orders/execute", async (req, res) => {
  try {
    const {
      exchange,
      tradingsymbol,
      transaction_type,
      quantity,
      order_type,
      product,
      price,
      validity
    } = req.body;

    if (
      !exchange ||
      !tradingsymbol ||
      !transaction_type ||
      !quantity ||
      !order_type ||
      !product
    ) {
      return res.status(400).json({
        success: false,
        message: "Required order fields are missing."
      });
    }

    const orderQuantity = Number(quantity);

    if (!Number.isInteger(orderQuantity) || orderQuantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be a positive whole number."
      });
    }

    const token = await getKiteToken();

    if (!token || !token.accesstoken) {
      return res.status(401).json({
        success: false,
        message: "Connect Kite first."
      });
    }

    const orderData = new URLSearchParams({
      exchange: String(exchange),
      tradingsymbol: String(tradingsymbol),
      transaction_type: String(transaction_type),
      quantity: String(orderQuantity),
      order_type: String(order_type),
      product: String(product),
      validity: String(validity || "DAY")
    });

    if (order_type === "LIMIT") {
      const orderPrice = Number(price);

      if (!Number.isFinite(orderPrice) || orderPrice <= 0) {
        return res.status(400).json({
          success: false,
          message: "A valid limit price is required."
        });
      }

      orderData.set("price", String(orderPrice));
    }

    // Place order with Kite
    const kiteResponse = await fetch(
      "https://api.kite.trade/orders/regular",
      {
        method: "POST",
        headers: {
          "X-Kite-Version": "3",
          Authorization:
            `token ${KITE_API_KEY}:${token.accesstoken}`,
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: orderData.toString()
      }
    );

    const kiteResult = await kiteResponse.json();

    if (
      !kiteResponse.ok ||
      kiteResult.status !== "success"
    ) {
      return res.status(kiteResponse.status || 500).json({
        success: false,
        message:
          kiteResult.message || "Order was rejected by Kite.",
        error: kiteResult.error_type || "ORDER_FAILED",
        kiteResponse: kiteResult
      });
    }

    const orderId = kiteResult.data?.order_id || null;

    // Optionally forward to Algo IP service
    if (
      ALGOIP_ENABLED &&
      ALGOIP_HOST &&
      ALGOIP_PORT
    ) {
      try {
        const algoPayload = {
          action: "ORDER_PLACED",
          orderId,
          exchange,
          tradingsymbol,
          transaction_type,
          quantity: orderQuantity,
          order_type,
          product,
          price: order_type === "LIMIT" ? Number(price) : null,
          validity: validity || "DAY",
          userId: token.userid || null,
          timestamp: new Date().toISOString()
        };

        const algoUrl = `http://${ALGOIP_HOST}:${ALGOIP_PORT}/order`;

        await fetch(algoUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Algo-User": ALGOIP_USER || "",
            "X-Algo-Pass": ALGOIP_PASS || ""
          },
          body: JSON.stringify(algoPayload)
        });

        console.log("Algo IP order notification sent:", orderId);
      } catch (algoError) {
        console.error("Algo IP notification failed:", algoError);
        // Do not fail the main order; just log.
      }
    }

    return res.json({
      success: true,
      orderId,
      message: "Order submitted to Kite."
    });
  } catch (error) {
    console.error("Order execution error:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ---------------------------
// ORDER STATUS (optional)
// ---------------------------

app.get("/api/orders/:orderId", async (req, res) => {
  try {
    const token = await getKiteToken();

    if (!token || !token.accesstoken) {
      return res.status(401).json({
        success: false,
        message: "Connect Kite first."
      });
    }

    const response = await fetch(
      "https://api.kite.trade/orders/regular/" +
        encodeURIComponent(req.params.orderId),
      {
        headers: {
          "X-Kite-Version": "3",
          Authorization:
            `token ${KITE_API_KEY}:${token.accesstoken}`
        }
      }
    );

    const result = await response.json();

    return res.status(response.status).json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    await deleteKiteToken();
    cachedInstruments = [];

    return res.json({
      success: true,
      message: "Logged out."
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} was not found.`
  });
});

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Callback URL: ${CALLBACK_URL}`);
      console.log(`Dashboard URL: ${DASHBOARD_URL}`);
      console.log(`Algo IP enabled: ${ALGOIP_ENABLED}`);
      if (ALGOIP_ENABLED) {
        console.log(
          `Algo IP host: ${ALGOIP_HOST}, port: ${ALGOIP_PORT}`
        );
      }
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

startServer();