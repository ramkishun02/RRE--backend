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
  process.env.BASE_URL ||
  "https://rre-backend-1.onrender.com";

const CALLBACK_URL =
  process.env.KITE_REDIRECT_URL ||
  `${BASE_URL}/kite/callback`;

const DASHBOARD_URL =
  process.env.DASHBOARD_URL ||
  `${BASE_URL}/dashboard`;

const DATABASE_URL =
  process.env.DATABASE_URL || "";

let db = null;

if (DATABASE_URL) {
  db = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  db.on("error", (error) => {
    console.error("Database error:", error.message);
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/*
  Your files must be in the same folder as server.js:

  server.js
  index.html
  app.js
  style.css
*/
app.use(express.static(__dirname));

function checksum(apiKey, requestToken, apiSecret) {
  return crypto
    .createHash("sha256")
    .update(apiKey + requestToken + apiSecret)
    .digest("hex");
}

function sendPage(res, title, message, success = false) {
  const color = success ? "#16a34a" : "#dc2626";
  const icon = success ? "✓" : "!";

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport"
        content="width=device-width, initial-scale=1">
  <title>${title}</title>

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
    }

    .card {
      width: 100%;
      max-width: 380px;
      padding: 30px 20px;
      text-align: center;
      background: #111c2e;
      border: 1px solid #263853;
      border-radius: 18px;
    }

    .icon {
      width: 65px;
      height: 65px;
      margin: 0 auto 18px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: ${color};
      font-size: 40px;
      font-weight: bold;
    }

    h1 {
      font-size: 22px;
      margin-bottom: 12px;
    }

    p {
      color: #c1ccdc;
      line-height: 1.5;
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

    .connected {
      color: #22c55e;
      font-weight: bold;
      font-size: 14px;
      margin-top: 18px;
    }
  </style>
</head>

<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>

    ${
      success
        ? `
          <div class="connected">
            Kite connection is active
          </div>

          <a href="${DASHBOARD_URL}">
            Continue to Dashboard
          </a>

          <script>
            setTimeout(function () {
              window.location.href =
                ${JSON.stringify(DASHBOARD_URL)};
            }, 5000);
          </script>
        `
        : `
          <a href="/kite/login">
            Try Again
          </a>
        `
    }
  </div>
</body>
</html>
  `);
}

/*
  Database functions


async function initializeDatabase() {
  if (!db) {
    console.log(
      "DATABASE_URL not configured. Token storage unavailable."
    );
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

  console.log("Database initialized");
}
*/

async function initializeDatabase() {
  if (!db) {
    console.log(
      "DATABASE_URL is not configured."
    );
    return;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS kite_tokens (
      id INTEGER PRIMARY KEY,
      access_token TEXT NOT NULL,
      user_id TEXT,
      login_time TEXT
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

  console.log(
    "kite_tokens table is ready"
  );
}
/*

async function saveKiteToken(
  accessToken,
  userId,
  loginTime
) {
  if (!db) {
    throw new Error(
      "DATABASE_URL is not configured."
    );
  }

  await db.query(
    `
    INSERT INTO kite_tokens
      (id, access_token, user_id, login_time)
    VALUES
      (1, $1, $2, $3)
    ON CONFLICT (id)
    DO UPDATE SET
      access_token = EXCLUDED.access_token,
      user_id = EXCLUDED.user_id,
      login_time = EXCLUDED.login_time,
      updated_at = NOW()
    `,
    [
      accessToken,
      userId || null,
      loginTime || null
    ]
  );
}
*/
async function saveKiteToken(
  accessToken,
  userId,
  loginTime
) {
  if (!db) {
    throw new Error(
      "DATABASE_URL is not configured."
    );
  }

  await db.query(
    `
    INSERT INTO kite_tokens
      (
        id,
        access_token,
        user_id,
        login_time,
        updated_at
      )
    VALUES
      (1, $1, $2, $3, NOW())
    ON CONFLICT (id)
    DO UPDATE SET
      access_token = EXCLUDED.access_token,
      user_id = EXCLUDED.user_id,
      login_time = EXCLUDED.login_time,
      updated_at = NOW()
    `,
    [
      accessToken,
      userId || null,
      loginTime || null
    ]
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

  await db.query(`
    DELETE FROM kite_tokens
    WHERE id = 1
  `);
}

/*
  Main page
*/

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/*
  Health check
*/

app.get("/health", async (req, res) => {
  try {
    const token = await getKiteToken();

    res.json({
      success: true,
      backend: true,
      kiteConfigured: Boolean(
        KITE_API_KEY && KITE_API_SECRET
      ),
      databaseConfigured: Boolean(DATABASE_URL),
      accessTokenConfigured: Boolean(
        token?.access_token
      ),
      callbackUrl: CALLBACK_URL,
      dashboardUrl: DASHBOARD_URL
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/*
  Start Kite authentication
*/

app.get("/kite/login", (req, res) => {
  if (!KITE_API_KEY) {
    return sendPage(
      res,
      "Kite Configuration Error",
      "KITE_API_KEY is missing."
    );
  }

  const loginUrl =
    "https://kite.zerodha.com/connect/login?v=3" +
    `&api_key=${encodeURIComponent(KITE_API_KEY)}`;

  res.redirect(loginUrl);
});

/*
  Kite callback
*/

app.get("/kite/callback", async (req, res) => {
  const requestToken = String(
    req.query.request_token || ""
  ).trim();

  const status = String(
    req.query.status || ""
  );

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
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: body.toString()
      }
    );

    const result = await response.json();

    console.log("Kite response:", {
      status: result.status,
      errorType: result.error_type,
      message: result.message
    });

    if (
      !response.ok ||
      result.status !== "success" ||
      !result.data?.access_token
    ) {
      return sendPage(
        res,
        "Kite Authentication Failed",
        result.message ||
          "Kite token exchange failed."
      );
    }

    await saveKiteToken(
      result.data.access_token,
      result.data.user_id,
      result.data.login_time
    );

    console.log(
      "Kite authentication completed:",
      result.data.user_id
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

/*
  Authentication status
*/

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
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/*
  Dashboard
*/

app.get("/dashboard", async (req, res) => {
  try {
    const token = await getKiteToken();

    if (!token?.access_token) {
      return res.redirect("/kite/login");
    }

    res.sendFile(path.join(__dirname, "index.html"));
  } catch (error) {
    res.status(500).send(
      `Dashboard error: ${error.message}`
    );
  }
});

/*
  Live quote

app.get("/api/market/quote", async (req, res) => {
  try {
    const symbol = String(
      req.query.symbol || ""
    ).trim().toUpperCase();

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: "Use ?symbol=INFY"
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

    const quoteUrl =
      "https://api.kite.trade/quote/ltp" +
      `?i=${encodeURIComponent(instrument)}`;

    const response = await fetch(quoteUrl, {
      headers: {
        "X-Kite-Version": "3",
        Authorization:
          `token ${KITE_API_KEY}:${token.access_token}`
      }
    });

    const result = await response.json();

    if (
      !response.ok ||
      result.status !== "success"
    ) {
      return res.status(response.status || 500).json({
        success: false,
        message:
          result.message || "Kite quote failed.",
        kite: result
      });
    }

    const quote = result.data?.[instrument];

    if (!quote) {
      return res.status(404).json({
        success: false,
        message: `${instrument} was not found.`
      });
    }

    res.json({
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

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});
*/
app.get("/api/stocks/search", async (req, res) => {
  try {
    const query = String(
      req.query.q || ""
    ).trim().toUpperCase();

   // if (!query) {
      //return res.json({
        //success: true,
    // results: []
     // });
    //}
// Change this in server_2.js:
return res.json(results); // instead of res.json({ success: true, results })

    const token = await getKiteToken();

    if (!token?.access_token) {
      return res.status(401).json({
        success: false,
        message: "Connect Kite first."
      });
    }

    const response = await fetch(
      "https://api.kite.trade/instruments/NSE",
      {
        headers: {
          "X-Kite-Version": "3",
          Authorization:
            `token ${KITE_API_KEY}:${token.access_token}`
        }
      }
    );

    const csv = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        message: csv
      });
    }

    const lines = csv.split(/\r?\n/);
    const headings = parseCsvLine(lines.shift() || "");

    const symbolIndex =
      headings.indexOf("tradingsymbol");

    const nameIndex =
      headings.indexOf("name");

    const tokenIndex =
      headings.indexOf("instrument_token");

    const results = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      const columns = parseCsvLine(line);

      const symbol = columns[symbolIndex] || "";
      const name = columns[nameIndex] || "";

      if (
        symbol.toUpperCase().includes(query) ||
        name.toUpperCase().includes(query)
      ) {
        results.push({
          exchange: "NSE",
          symbol,
          name,
          instrumentToken: columns[tokenIndex] || ""
        });
      }

      if (results.length >= 20) break;
    }

    return res.json({
      success: true,
      results
    });
  } catch (error) {
    console.error("Search error:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

   /* const lines = csv.split(/\r?\n/);
    const headings =    parseCsvLine(lines.shift() || "");

    const symbolIndex =
      headings.indexOf("tradingsymbol");

    const nameIndex =
      headings.indexOf("name");

    const tokenIndex =
      headings.indexOf("instrument_token");

    const results = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      const columns = parseCsvLine(line);

      const symbol = columns[symbolIndex] || "";
      const name = columns[nameIndex] || "";

      if (
        symbol.toUpperCase().includes(query) ||
        name.toUpperCase().includes(query)
      ) {
        results.push({
          exchange: "NSE",
          symbol,
          name,
          instrumentToken: columns[tokenIndex] || ""
        });
      }

      if (results.length >= 20) break;
    }

    return res.json({
      success: true,
      results
    });
  } catch (error) {
    console.error("Search error:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});*/

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const character = line[i];

    if (character === '"') {
      if (
        insideQuotes &&
        line[i + 1] === '"'
      ) {
        value += '"';
        i++;
      } else {
        insideQuotes =
          !insideQuotes;
      }
    } else if (
      character === "," &&
      !insideQuotes
    ) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }

  values.push(value);

  return values.map((item) =>
    item.trim()
  );
}


/*
  Logout
*/

app.post("/api/auth/logout", async (req, res) => {
  try {
    await deleteKiteToken();

    res.json({
      success: true,
      message: "Logged out"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/*
  Start server once only
*/

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `Server running on port ${PORT}`
      );
      console.log(
        `Callback URL: ${CALLBACK_URL}`
      );
    });
  } catch (error) {
    console.error(
      "Server startup failed:",
      error
    );

    process.exit(1);
  }
}
  
startServer();
  