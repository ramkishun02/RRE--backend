"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");
const { ProxyAgent, setGlobalDispatcher } = require("undici");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const KITE_API_KEY = process.env.KITE_API_KEY || "";
const KITE_API_SECRET = process.env.KITE_API_SECRET || "";
const BASE_URL = process.env.BASE_URL || "https://rre-backend-1.onrender.com";
const CALLBACK_URL = process.env.KITE_REDIRECT_URL || `${BASE_URL}/kite/callback`;
const DASHBOARD_URL = process.env.DASHBOARD_URL || `${BASE_URL}/dashboard`;
const DATABASE_URL = process.env.DATABASE_URL || "";const ALGOIP_PROXY_HOST = String(process.env.ALGO_IP_PROXY_HOST || process.env.ALGOIP_PROXY_HOST || "dc46-mum-01.algoip.in").trim();

const ALGOIP_PROXY_PORT = String(process.env.ALGO_IP_PROXY_PORT || process.env.ALGOIP_PROXY_PORT || "443").trim();
const ALGOIP_PROXY_USER = String(process.env.ALGO_IP_PROXY_USER || process.env.ALGOIP_PROXY_USER || "").trim();
const ALGOIP_PROXY_PASSWORD = String(process.env.ALGO_IP_PROXY_PASSWORD || process.env.ALGOIP_PROXY_IP || "");
String(process.env.ALGO_IP_PROXY_IP || process.env.ALGOIP_IP|| "");


/*
const ALGOIP_HOST = process.env.ALGOIP_HOST || "";
const ALGOIP_PORT = process.env.ALGOIP_PORT || "";
const ALGOIP_USER = process.env.ALGOIP_USER || "";
const ALGOIP_PASSSORD = process.env.ALGOIP_PASSWORD || "";
//const ALGOIP_ENABLED =
// process.env.ALGOIP_ENABLED === "true" || //false;
const ALGOIP_IP = process.env.ALGOIP_IP || "";
function buildProxyUrl() {
  if (!ALGOIP_USER || !ALGOIP_PASSWORD) return "";

  const portNumber = Number(ALGOIP_PORT);
  */
  if (!ALGOIP_PROXY_HOST || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new Error("Invalid AlgoIP proxy settings. Check host and numeric port.");
  }

  const candidate = `http://${encodeURIComponent(ALGOIP_PROXY_USER)}:${encodeURIComponent(ALGOIP_PROXY_PASSWORD)}@${ALGOIP_PROXY_HOST}:${portNumber}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) throw new Error("Missing proxy hostname");
    return parsed.toString();
  } catch (error) {
    throw new Error("Invalid AlgoIP proxy settings. Check host, port, username, and password.");
  }
}

let proxyUrl = "";
try {
  proxyUrl = buildProxyUrl();
  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent({ uri: proxyUrl }));
    console.log(`AlgoIP proxy enabled: ${ALGOIP_HOST}:${ALGOIP_PORT}`);
  } else {
    console.warn("AlgoIP proxy is not configured. Set ALGO_IP_PROXY_USER and ALGO_IP_PROXY_PASSWORD in Render.");
  }
} catch (error) {
  console.error(`Proxy configuration error: ${error.message}`);
  process.exitCode = 1;
}

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
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let insideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      if (insideQuotes && line[index + 1] === '"') {
        value += '"';
        index += 1;
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

function sendPage(res, title, message, success = false) {
  const color = success ? "#16a34a" : "#dc2626";
  const icon = success ? "✓" : "!";
  const action = success
    ? `<a href="${escapeHtml(DASHBOARD_URL)}">Continue to Dashboard</a>`
    : '<a href="/kite/login">Try Again</a>';

  return res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${escapeHtml(title)}</title>
      <style>
        body {
          margin: 0;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #08111f;
          color: white;
          font-family: Arial, sans-serif;
          padding: 20px;
          box-sizing: border-box;
        }
        .card {
          width: 100%;
          max-width: 420px;
          padding: 30px 22px;
          text-align: center;
          background: #111c2e;
          border: 1px solid #263853;
          border-radius: 18px;
        }
        .icon {
          width: 65px;
          height: 65px;
          margin: 0 auto 18px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          background: ${color};
          font-size: 40px;
          font-weight: bold;
        }
        h1 { font-size: 22px; margin: 0 0 12px; }
        p { color: #c1ccdc; line-height: 1.5; white-space: pre-wrap; }
        a {
          display: inline-block;
          margin-top: 22px;
          padding: 12px 18px;
          background: #2563eb;
          color: white;
          text-decoration: none;
          border-radius: 8px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon">${icon}</div>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(message)}</p>
        ${action}
      </div>
    </body>
    </html>
  `);
}

async function initializeDatabase() {
  if (!db) {
    console.log("DATABASE_URL is not configured.");
    return;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS kite_tokens (
      id INTEGER PRIMARY KEY,
      access_token TEXT NOT NULL,
      user_id TEXT,
      login_time TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    ALTER TABLE kite_tokens
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
  `);

  await db.query(`
    UPDATE kite_tokens
    SET updated_at = NOW()
    WHERE updated_at IS NULL
  `);

  console.log("Database initialized.");
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
  await db.query("DELETE FROM kite_tokens WHERE id = 1");
}

async function downloadInstruments() {
  if (!KITE_API_KEY) return [];

  const token = await getKiteToken();
  if (!token?.access_token) return [];

  const response = await fetch("https://api.kite.trade/instruments/NSE", {
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${KITE_API_KEY}:${token.access_token}`
    }
  });

  const csv = await response.text();
  if (!response.ok) {
    throw new Error(csv || "Unable to download NSE instruments.");
  }

  const lines = csv.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];

  const headings = parseCsvLine(lines.shift());
  const symbolIndex = headings.indexOf("tradingsymbol");
  const nameIndex = headings.indexOf("name");
  const tokenIndex = headings.indexOf("instrument_token");

  if (symbolIndex === -1) {
    throw new Error("The NSE instruments response is missing tradingsymbol.");
  }

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
      accessTokenConfigured: Boolean(token?.access_token),
      callbackUrl: CALLBACK_URL,
      dashboardUrl: DASHBOARD_URL,
      proxyConfigured: Boolean(proxyUrl),
      proxyHost: proxyUrl ? ALGOIP_PROXY_HOST : null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
//new function 
app.get("/api/debug/algoip", async (req, res) => {
  const result = {
    host: ALGOIP_PROXY_HOST,
    port: ALGOIP_PROXY_PORT,
    usernameConfigured: Boolean(ALGOIP_PROXY_USER),
    passwordConfigured: Boolean(ALGOIP_PROXY_PASSWORD),
    proxyUrlBuilt: false,
    proxyRequest: false,
    error: null
  };

  try {
    const proxy = buildProxyUrl();

    result.proxyUrlBuilt = Boolean(proxy);

    if (!proxy) {
      result.error = "Proxy URL was not built. Check username/password.";
      return res.json(result);
    }

    const response = await fetch("https://api.ipify.org?format=json");

    const data = await response.json();

    result.proxyRequest = true;
    result.publicIp = data.ip;

    return res.json(result);
  } catch (error) {
    result.error = {
      name: error?.name,
      message: error?.message,
      code: error?.cause?.code || error?.code || null,
      cause: error?.cause?.message || null
    };

    return res.status(500).json(result);
  }
});



app.get("/api/proxy-check", async (req, res) => {
  if (!proxyUrl) {
    return res.status(503).json({ success: false, message: "AlgoIP proxy is not configured." });
  }

  try {
    const response = await fetch("https://ip64.algoip.in/all?format=json");
    const data = await response.json();
    return res.status(response.ok ? 200 : 502).json({
      success: response.ok,
      proxyConfigured: true,
      routedIp: data.ip || null,
      country: data.country || null,
      city: data.city || null,
      message: response.ok ? "AlgoIP proxy routing is working." : "AlgoIP proxy verification failed."
    });
  } catch (error) {
    const code = error?.cause?.code || error?.code || "NETWORK_ERROR";
    console.error("Proxy check error:", { code, message: error.message });
    return res.status(502).json({
      success: false,
      proxyConfigured: true,
      code,
      message: "Render cannot reach the AlgoIP proxy. Check the host, port, username, password, and AlgoIP service status."
    });
  }
});

app.get("/kite/login", (req, res) => {
  if (!KITE_API_KEY) {
    return sendPage(res, "Kite Configuration Error", "KITE_API_KEY is missing.");
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
      checksum: checksum(KITE_API_KEY, requestToken, KITE_API_SECRET)
    });

    const response = await fetch("https://api.kite.trade/session/token", {
      method: "POST",
      headers: {
        "X-Kite-Version": "3",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

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

    return res.redirect(`${DASHBOARD_URL}?kite=connected`);
  } catch (error) {
    const code = error?.cause?.code || error?.code || "NETWORK_ERROR";
    const detail = error?.cause?.message || error?.message || "Unable to reach Kite.";
    console.error("Callback error:", { code, detail });
    return sendPage(
      res,
      "Authentication Error",
      `Kite session request failed (${code}). ${detail}. Check AlgoIP protocol, host, port, username, and password in Render.`
    );
  }
});

app.get("/api/auth/status", async (req, res) => {
  try {
    const token = await getKiteToken();
    res.json({
      success: true,
      connected: Boolean(token?.access_token),
      userId: token?.user_id || null,
      loginTime: token?.login_time || null
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/dashboard", async (req, res) => {
  try {
    const token = await getKiteToken();
    if (!token?.access_token) return res.redirect("/kite/login");
    return res.sendFile(path.join(__dirname, "index.html"));
  } catch (error) {
    return res.status(500).send(`Dashboard error: ${escapeHtml(error.message)}`);
  }
});

app.get("/api/stocks/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim().toUpperCase();
    if (!query) return res.json({ success: true, results: [] });

    if (!cachedInstruments.length) {
      cachedInstruments = await downloadInstruments();
    }

    const results = cachedInstruments
      .filter((item) => {
        const symbol = item.symbol.toUpperCase();
        const name = item.name.toUpperCase();
        return symbol.includes(query) || name.includes(query);
      })
      .slice(0, 20);

    return res.json({ success: true, results });
  } catch (error) {
    console.error("Stock search error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/stocks/recommendation", async (req, res) => {
  try {
    const token = await getKiteToken();
    if (!token?.access_token) {
      return res.status(401).json({
        success: false,
        message: "Connect Kite first."
      });
    }

    if (!cachedInstruments.length) {
      cachedInstruments = await downloadInstruments();
    }

    const candidates = cachedInstruments.filter(
      (item) => item.symbol && !item.symbol.includes("-")
    );

    if (!candidates.length) {
      return res.status(404).json({
        success: false,
        message: "No NSE instruments are available."
      });
    }

    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    const score = 65 + Math.floor(Math.random() * 30);

    return res.json({
      success: true,
      stock: {
        symbol: selected.symbol,
        name: selected.name || selected.symbol,
        exchange: "NSE",
        price: 0,
        score,
        risk: score >= 85 ? "Low" : score >= 75 ? "Medium" : "High",
        reason: "Selected from the currently available NSE instrument list.",
        instrumentToken: selected.instrumentToken
      }
    });
  } catch (error) {
    console.error("NSE recommendation error:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get("/api/market/quote", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").trim().toUpperCase();
    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: "Use ?symbol=RELIANCE"
      });
    }

    const token = await getKiteToken();
    if (!token?.access_token) {
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
          Authorization: `token ${KITE_API_KEY}:${token.access_token}`
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
      instrument,
      last_price: quote.last_price,
      source: "Kite Connect",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Quote error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    if (!KITE_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "KITE_API_KEY is not configured."
      });
    }

    const token = await getKiteToken();
    if (!token?.access_token) {
      return res.status(401).json({
        success: false,
        message: "Connect Kite before placing an order."
      });
    }

    const {
      exchange,
      tradingsymbol,
      transaction_type,
      quantity,
      order_type,
      product,
      validity,
      price
    } = req.body || {};

    const normalizedQuantity = Number(quantity);
    const normalizedPrice = Number(price || 0);
    const allowedTransactions = new Set(["BUY", "SELL"]);
    const allowedOrderTypes = new Set(["MARKET", "LIMIT"]);

    if (
      exchange !== "NSE" ||
      !String(tradingsymbol || "").trim() ||
      !allowedTransactions.has(transaction_type) ||
      !Number.isInteger(normalizedQuantity) ||
      normalizedQuantity <= 0 ||
      !allowedOrderTypes.has(order_type) ||
      order_type === "LIMIT" && normalizedPrice <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid order details."
      });
    }

    const orderBody = new URLSearchParams({
      exchange: "NSE",
      tradingsymbol: String(tradingsymbol).trim().toUpperCase(),
      transaction_type,
      quantity: String(normalizedQuantity),
      order_type,
      product: product === "MIS" ? "MIS" : "CNC",
      validity: validity === "IOC" ? "IOC" : "DAY"
    });

    if (order_type === "LIMIT") {
      orderBody.set("price", normalizedPrice.toString());
    }

    const response = await fetch("https://api.kite.trade/orders/regular", {
      method: "POST",
      headers: {
        "X-Kite-Version": "3",
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `token ${KITE_API_KEY}:${token.access_token}`
      },
      body: orderBody.toString()
    });

    const result = await response.json();
    if (!response.ok || result.status !== "success") {
      return res.status(response.status || 502).json({
        success: false,
        message: result.message || "Kite rejected the order.",
        errorType: result.error_type || null
      });
    }

    const orderId = result.data?.order_id || null;
    if (!orderId) {
      return res.status(502).json({
        success: false,
        message: "Kite accepted the request but returned no order ID."
      });
    }

    return res.json({
      success: true,
      orderId,
      status: "OPEN",
      message: "Order submitted to Kite."
    });
  } catch (error) {
    console.error("Order submission error:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get("/api/orders/:orderId/status", async (req, res) => {
  try {
    const token = await getKiteToken();
    const orderId = String(req.params.orderId || "").trim();

    if (!token?.access_token) {
      return res.status(401).json({
        success: false,
        message: "Connect Kite before checking order status."
      });
    }

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order ID is required."
      });
    }

    const response = await fetch(
      `https://api.kite.trade/orders/${encodeURIComponent(orderId)}`,
      {
        headers: {
          "X-Kite-Version": "3",
          Authorization: `token ${KITE_API_KEY}:${token.access_token}`
        }
      }
    );

    const result = await response.json();
    if (!response.ok || result.status !== "success") {
      return res.status(response.status || 502).json({
        success: false,
        message: result.message || "Unable to read order status."
      });
    }

    const orders = Array.isArray(result.data) ? result.data : [];
    const latest = orders[orders.length - 1];
    if (!latest) {
      return res.status(404).json({
        success: false,
        message: "Order status was not found."
      });
    }

    return res.json({
      success: true,
      orderId: latest.order_id || orderId,
      status: latest.status || "UNKNOWN",
      statusMessage: latest.status_message || "",
      filledQuantity: Number(latest.filled_quantity || 0),
      averagePrice: Number(latest.average_price || 0)
    });
  } catch (error) {
    console.error("Order status error:", error);
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
    return res.json({ success: true, message: "Logged out." });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
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
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

startServer();
