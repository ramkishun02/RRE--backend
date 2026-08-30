"use strict";

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = Number(
  process.env.PORT || 10000
);

const KITE_API_KEY =
  process.env.KITE_API_KEY || "";

const KITE_API_SECRET =
  process.env.KITE_API_SECRET || "";

const BASE_URL =
  process.env.BASE_URL ||
  "https://rre-backend-1.onrender.com";

const CALLBACK_URL =
  process.env.KITE_REDIRECT_URL ||
  BASE_URL + "/kite/callback";

const DASHBOARD_URL =
  process.env.DASHBOARD_URL ||
  BASE_URL + "/dashboard";

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

  db.on("error", function (error) {
    console.error(
      "Unexpected PostgreSQL error:",
      error
    );
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderPage(title, content) {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>",
    escapeHtml(title),
    "</title>",
    "<style>",
    "body{margin:0;padding:20px;font-family:Arial;background:#f4f6f8;color:#222}",
    ".card{max-width:850px;margin:auto;padding:25px;background:#fff;border-radius:14px}",
    ".button{display:inline-block;margin:8px 4px;padding:11px 16px;background:#1976d2;color:#fff;border:0;border-radius:7px;cursor:pointer;text-decoration:none}",
    "input{box-sizing:border-box;width:100%;padding:12px;margin:7px 0;font-size:16px}",
    "pre{white-space:pre-wrap;background:#f1f3f5;padding:15px;border-radius:8px}",
    ".stock-button{display:block;width:100%;text-align:left}",
    ".ok{color:green;font-weight:bold}",
    "</style>",
    "</head>",
    "<body>",
    '<main class="card">',
    content,
    "</main>",
    "</body>",
    "</html>"
  ].join("");
}

async function initializeDatabase() {
  if (!db) {
    console.log(
      "DATABASE_URL is not configured."
    );

    return;
  }

  await db.query(
    "CREATE TABLE IF NOT EXISTS kite_tokens (" +
    "id SERIAL PRIMARY KEY," +
    "access_token TEXT NOT NULL," +
    "user_id TEXT," +
    "login_time TIMESTAMP," +
    "expires_at TIMESTAMP," +
    "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" +
    ")"
  );

  await db.query(
    "ALTER TABLE kite_tokens " +
    "ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ"
  );

  console.log(
    "Database initialized."
  );
}

async function saveAccessToken(
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
    "DELETE FROM kite_tokens"
  );

  await db.query(
    "INSERT INTO kite_tokens " +
    "(access_token, user_id, login_time, expires_at, updated_at) " +
    "VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP)",
    [
      accessToken,
      userId || null,
      loginTime
        ? new Date(loginTime)
        : new Date()
    ]
  );
}

async function getStoredKiteToken() {
  if (!db) {
    return null;
  }

  const result = await db.query(
    "SELECT access_token " +
    "FROM kite_tokens " +
    "WHERE expires_at IS NULL " +
    "OR expires_at > CURRENT_TIMESTAMP " +
    "ORDER BY id DESC LIMIT 1"
  );

  if (!result.rows.length) {
    return null;
  }

  return result.rows[0].access_token;
}

function createChecksum(
  apiKey,
  requestToken,
  apiSecret
) {
  return crypto
    .createHash("sha256")
    .update(
      apiKey +
      requestToken +
      apiSecret
    )
    .digest("hex");
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const character = line[i];

    if (character === '"') {
      if (
        quoted &&
        line[i + 1] === '"'
      ) {
        value += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (
      character === "," &&
      !quoted
    ) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }

  values.push(value);

  return values.map(function (item) {
    return item.trim();
  });
}

app.get("/", async function (req, res) {
  let token = null;

  try {
    token =
      await getStoredKiteToken();
  } catch (error) {
    console.error(error);
  }

  const content = [
    "<h1>RRE Backend</h1>",
    "<p>Backend: <strong>RUNNING</strong></p>",
    "<p>Database: <strong>",
    DATABASE_URL
      ? "CONFIGURED"
      : "NOT CONFIGURED",
    "</strong></p>",
    "<p>Kite API: <strong>",
    KITE_API_KEY && KITE_API_SECRET
      ? "CONFIGURED"
      : "NOT CONFIGURED",
    "</strong></p>",
    "<p>Access token: <strong>",
    token
      ? "CONNECTED"
      : "NOT CONNECTED",
    "</strong></p>",
    '<a class="button" href="/kite/login">Connect Kite</a>',
    '<a class="button" href="/dashboard">Dashboard</a>',
    '<a class="button" href="/health">Health</a>'
  ].join("");

  res.send(
    renderPage(
      "RRE Backend",
      content
    )
  );
});

app.get("/health", async function (req, res) {
  let databaseReady = false;
  let token = null;

  if (db) {
    try {
      await db.query("SELECT 1");
      databaseReady = true;
      token =
        await getStoredKiteToken();
    } catch (error) {
      console.error(
        "Health check error:",
        error.message
      );
    }
  }

  res.json({
    backend: true,
    databaseConfigured: Boolean(
      DATABASE_URL
    ),
    databaseReady,
    kiteConfigured: Boolean(
      KITE_API_KEY &&
      KITE_API_SECRET
    ),
    accessTokenConfigured: Boolean(
      token
    ),
    timestamp: new Date().toISOString()
  });
});

app.get("/status", async function (req, res) {
  let token = null;

  try {
    token =
      await getStoredKiteToken();
  } catch (error) {
    console.error(
      "Status error:",
      error.message
    );
  }

  res.json({
    backend: true,
    databaseConfigured: Boolean(
      DATABASE_URL
    ),
    apiKeyConfigured: Boolean(
      KITE_API_KEY
    ),
    apiSecretConfigured: Boolean(
      KITE_API_SECRET
    ),
    accessTokenConfigured: Boolean(
      token
    ),
    timestamp: new Date().toISOString()
  });
});

app.get("/kite/login", function (req, res) {
  if (!KITE_API_KEY) {
    return res.status(500).send(
      renderPage(
        "Configuration Error",
        "<h1>KITE_API_KEY is missing.</h1>"
      )
    );
  }

  const loginUrl =
    "https://kite.zerodha.com/connect/login" +
    "?v=3&api_key=" +
    encodeURIComponent(KITE_API_KEY);

  return res.redirect(loginUrl);
});

app.get(
  "/kite/callback",
  async function (req, res) {
    const requestToken =
      req.query.request_token;

    const status =
      req.query.status;

    if (status === "error") {
      return res.status(400).send(
        renderPage(
          "Kite Login Failed",
          "<h1>Kite login failed.</h1>"
        )
      );
    }

    if (!requestToken) {
      return res.status(400).send(
        renderPage(
          "Request Token Missing",
          "<h1>Request token is missing.</h1>"
        )
      );
    }

    if (
      !KITE_API_KEY ||
      !KITE_API_SECRET
    ) {
      return res.status(500).send(
        renderPage(
          "Kite Configuration Error",
          "<h1>Kite API credentials are missing.</h1>"
        )
      );
    }

    try {
      const checksum =
        createChecksum(
          KITE_API_KEY,
          requestToken,
          KITE_API_SECRET
        );

      const body =
        new URLSearchParams();

      body.set(
        "api_key",
        KITE_API_KEY
      );

      body.set(
        "request_token",
        requestToken
      );

      body.set(
        "checksum",
        checksum
      );

      const response =
        await fetch(
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

      const result =
        await response.json();

      if (
        !response.ok ||
        result.status !== "success"
      ) {
        return res.status(400).send(
          renderPage(
            "Authentication Failed",
            "<h1>" +
            escapeHtml(
              result.message ||
              "Token exchange failed."
            ) +
            "</h1>"
          )
        );
      }

      const data =
        result.data || {};

      await saveAccessToken(
        data.access_token,
        data.user_id,
        data.login_time
      );

      return res.redirect(
        DASHBOARD_URL
      );
    } catch (error) {
      console.error(
        "Callback error:",
        error
      );

      return res.status(500).send(
        renderPage(
          "Callback Error",
          "<h1>" +
          escapeHtml(error.message) +
          "</h1>"
        )
      );
    }
  }
);

app.get(
  "/api/stocks/search",
  async function (req, res) {
    try {
      const query =
        String(req.query.q || "")
          .trim()
          .toUpperCase();

      if (!query) {
        return res.json({
          success: true,
          results: []
        });
      }

      const token =
        await getStoredKiteToken();

      if (!token) {
        return res.status(401).json({
          success: false,
          message: "Connect Kite first."
        });
      }

      const response =
        await fetch(
          "https://api.kite.trade/instruments/NSE",
          {
            headers: {
              "X-Kite-Version": "3",
              Authorization:
                "token " +
                KITE_API_KEY +
                ":" +
                token
            }
          }
        );

      const csv =
        await response.text();

      if (!response.ok) {
        return res.status(
          response.status
        ).json({
          success: false,
          message: csv
        });
      }

      const lines =
        csv.split(/
?
/);

      const headers =
        parseCsvLine(
          lines.shift() || ""
        );

      const symbolIndex =
        headers.indexOf(
          "tradingsymbol"
        );

      const nameIndex =
        headers.indexOf("name");

      const tokenIndex =
        headers.indexOf(
          "instrument_token"
        );

      const results = [];

      lines.forEach(function (line) {
        if (
          results.length >= 20 ||
          !line.trim()
        ) {
          return;
        }

        const columns =
          parseCsvLine(line);

        const symbol =
          columns[symbolIndex] || "";

        const name =
          columns[nameIndex] || "";

        if (
          symbol.toUpperCase()
            .includes(query) ||
          name.toUpperCase()
            .includes(query)
        ) {
          results.push({
            exchange: "NSE",
            symbol,
            name,
            instrument_token:
              columns[tokenIndex] || ""
          });
        }
      });

      return res.json({
        success: true,
        results
      });
    } catch (error) {
      console.error(
        "Stock search error:",
        error
      );

      return res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

app.get(
  "/api/market/quote",
  async function (req, res) {
    try {
      const symbol =
        String(req.query.symbol || "")
          .trim()
          .toUpperCase();

      if (!symbol) {
        return res.status(400).json({
          success: false,
          message:
            "Use ?symbol=INFY"
        });
      }

      const token =
        await getStoredKiteToken();

      if (!token) {
        return res.status(401).json({
          success: false,
          message: "Connect Kite first."
        });
      }

      const instrument =
        "NSE:" + symbol;

      const quoteUrl =
        "https://api.kite.trade/quote/ltp" +
        "?i=" +
        encodeURIComponent(instrument);

      const response =
        await fetch(
          quoteUrl,
          {
            headers: {
              "X-Kite-Version": "3",
              Authorization:
                "token " +
                KITE_API_KEY +
                ":" +
                token
            }
          }
        );

      const result =
        await response.json();

      if (
        !response.ok ||
        result.status !== "success"
      ) {
        return res.status(
          response.status || 500
        ).json({
          success: false,
          message:
            result.message ||
            "Unable to retrieve quote."
        });
      }

      const quote =
        result.data &&
        result.data[instrument];

      if (!quote) {
        return res.status(404).json({
          success: false,
          message:
            "Symbol was not found."
        });
      }

      return res.json({
        success: true,
        exchange: "NSE",
        symbol,
        last_price:
          quote.last_price,
        timestamp:
          new Date().toISOString()
      });
    } catch (error) {
      console.error(
        "Quote error:",
        error
      );

      return res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

app.get(
  "/dashboard",
  async function (req, res) {
    try {
      const token =
        await getStoredKiteToken();

      if (!token) {
        return res.redirect(
          "/kite/login"
        );
      }

      const content = [
        "<h1>RRE Dashboard</h1>",
        '<p class="ok">Kite authentication is active.</p>',
        "<h2>Search Stock</h2>",
        '<input id="stockSearch" placeholder="INFY">',
        '<button class="button" id="searchButton">Search</button>',
        '<div id="searchResults"></div>',
        "<h2>Current Price</h2>",
        '<input id="symbol" placeholder="INFY">',
        '<button class="button" id="quoteButton">Get Current Price</button>',
        '<pre id="result">Enter a symbol.</pre>',
        '<a class="button" href="/">Home</a>',
        "<script>",
        "const searchInput=document.getElementById('stockSearch');",
        "const searchButton=document.getElementById('searchButton');",
        "const searchResults=document.getElementById('searchResults');",
        "const symbolInput=document.getElementById('symbol');",
        "const quoteButton=document.getElementById('quoteButton');",
        "const result=document.getElementById('result');",
        "searchButton.addEventListener('click',searchStocks);",
        "quoteButton.addEventListener('click',loadQuote);",
        "async function searchStocks(){",
        "const query=searchInput.value.trim();",
        "if(!query){searchResults.textContent='Enter a stock symbol.';return;}",
        "searchResults.textContent='Searching...';",
        "try{",
        "const response=await fetch('/api/stocks/search?q='+encodeURIComponent(query));",
        "const data=await response.json();",
        "if(!response.ok||data.success!==true){searchResults.textContent=data.message||'Search failed.';return;}",
        "searchResults.innerHTML='';",
        "if(!data.results||data.results.length===0){searchResults.textContent='No stock found.';return;}",
        "data.results.forEach(function(stock){",
        "const button=document.createElement('button');",
        "button.className='button stock-button';",
        "button.type='button';",
        "button.textContent=(stock.exchange||'NSE')+':'+stock.symbol+' '+(stock.name||'');",
        "button.addEventListener('click',function(){symbolInput.value=stock.symbol;loadQuote();});",
        "searchResults.appendChild(button);",
        "});",
        "}catch(error){searchResults.textContent='Search failed: '+error.message;}",
        "}",
        "async function loadQuote(){",
        "const symbol=symbolInput.value.trim().toUpperCase();",
        "if(!symbol){result.textContent='Enter an NSE symbol.';return;}",
        "result.textContent='Loading...';",
        "try{",
        "const response=await fetch('/api/market/quote?symbol='+encodeURIComponent(symbol));",
        "const data=await response.json();",
        "if(!response.ok||data.success!==true){result.textContent=data.message||'Price unavailable.';return;}",
        "result.textContent='Symbol: '+data.symbol+'\
Current price: Rs. '+Number(data.last_price).toFixed(2);",
        "}catch(error){result.textContent='Request failed: '+error.message;}",
        "}",
        "</script>"
      ].join("");

      return res.send(
        renderPage(
          "RRE Dashboard",
          content
        )
      );
    } catch (error) {
      console.error(
        "Dashboard error:",
        error
      );

      return res.status(500).send(
        renderPage(
          "Dashboard Error",
          "<h1>" +
          escapeHtml(error.message) +
          "</h1>"
        )
      );
    }
  }
);

app.use(function (req, res) {
  res.status(404).json({
    success: false,
    error: "NOT_FOUND",
    message:
      req.method +
      " " +
      req.originalUrl +
      " was not found."
  });
});

app.use(function (
  error,
  req,
  res,
  next
) {
  console.error(
    "Unhandled server error:",
    error
  );

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    message: error.message
  });
});

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(
      PORT,
      "0.0.0.0",
      function () {
        console.log(
          "RRE backend running on port " +
          PORT
        );
      }
    );
  } catch (error) {
    console.error(
      "Server startup error:",
      error
    );

    process.exit(1);
  }
}

startServer();