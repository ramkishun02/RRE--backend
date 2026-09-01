"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

const app = express();

const PORT = Number(process.env.PORT || 10000);
const KITE_API_KEY = process.env.KITE_API_KEY || "";
const KITE_API_SECRET = process.env.KITE_API_SECRET || "";
const BASE_URL =
  process.env.BASE_URL || "https://rre-backend-1.onrender.com";
const CALLBACK_URL =
  process.env.KITE_REDIRECT_URL || `${BASE_URL}/kite/callback`;
const DASHBOARD_URL =
  process.env.DASHBOARD_URL || `${BASE_URL}/dashboard`;
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
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sendPage(res, title, message, success = false) {
  const color = success ? "#16a34a" : "#dc2626";
  const icon = success ? "✓" : "!";

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

        h1 {
          font-size: 22px;
          margin: 0 0 12px;
        }

        p {
          color: #c1ccdc;
          line-height: 1.5;
          white-space: pre-wrap;
        }

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
        ${
          success
            ? `<a href="${escapeHtml(DASHBOARD_URL)}">Continue to Dashboard</a>`
            : `<a href="/kite/login">Try Again</a>`
        }
      </div>
    </body>
    </html>
  `);
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
  if (!KITE_API_KEY) {
    return [];
  }

  const token = await getKiteToken();

  if (!token || !token.accesstoken) {
    return [];
  }

  const response = await fetch(
    "https://api.kite.trade/instruments/NSE",
    {
      method: "GET",
      headers: {
        "X-Kite-Version": "3",
        "Authorization": `token ${KITE_API_KEY}:${token.accesstoken}`
      }
    }
  );

  const csv = await response.text();

  if (!response.ok) {
    throw new Error(
      csv || "Unable to download NSE instruments."
    );
  }

  const lines = csv.split(/\?/);

  return lines;
}


/*
async function downloadInstruments() {
  if (!KITE_API_KEY) return [];

  const token = await getKiteToken();

  if (!token?.accesstoken) {
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
  const csv = await response.text();

if (!response.ok) {
  throw new Error(csv || "Unable to download NSE instruments.");
}
  
  const lines = csv.split(/?/)
 .filter((line) => line.trim());

  if (lines.length < 2) {
    return [];
  }
*/
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
    })).filter((item) => item.symbol);


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

    if (!token?.accesstoken) {
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

    if (!token?.accesstoken) {
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

    if (
      !response.ok ||
      result.status !== "success"
    ) {
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
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

startServer();
