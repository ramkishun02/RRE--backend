

                       
       

"use strict";

/*
 * Kite Connect backend (Render-ready)
 *
 * Stability fixes in this version:
 *  1. AlgoIP proxy config no longer crashes (fixed ALGOIP_PASSWORD typo, unified
 *     env names, graceful degradation when misconfigured).
 *  2. Every outbound Kite call has a timeout + bounded retries with backoff.
 *  3. Kite session expiry (~6 AM IST daily, regulatory) is detected and handled:
 *     dead tokens are cleared automatically and endpoints return a clean
 *     KITE_SESSION_EXPIRED 401 with a loginUrl instead of random failures.
 *  4. /kite/callback is idempotent: replayed/duplicate request_tokens no longer
 *     produce scary errors (request_token is single-use and lives minutes).
 *  5. HTTP server tuned for proxies (keepAliveTimeout) + graceful SIGTERM
 *     shutdown so Render redeploys don't drop in-flight requests.
 *  6. Instrument list is cached with a TTL and in-flight de-duplication, token
 *     lookups are cached briefly, and a lightweight keep-alive pinger reduces
 *     cold-start disruption on the Render free tier.
 */

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");
const { ProxyAgent, setGlobalDispatcher } = require("undici");

/* ------------------------------------------------------------------ */
/* 1. Configuration                                                    */
/* ------------------------------------------------------------------ */

function readEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

const PORT = Number(readEnv("PORT") || 10000);

const KITE_API_KEY = readEnv("KITE_API_KEY");
const KITE_API_SECRET = readEnv("KITE_API_SECRET");

const BASE_URL = readEnv("BASE_URL") || "https://rre-backend-1.onrender.com";
const CALLBACK_URL =
  readEnv("KITE_REDIRECT_URL", "KITE_CALLBACK_URL") || `${BASE_URL}/kite/callback`;
const DASHBOARD_URL = readEnv("DASHBOARD_URL") || `${BASE_URL}/dashboard`;

const DATABASE_URL = readEnv("DATABASE_URL");

/* AlgoIP proxy - canonical names: ALGOIP_* (legacy ALGO_IP_* aliases accepted) */
const ALGOIP_HOST = readEnv("ALGOIP_HOST", "ALGO_IP_PROXY_HOST", "ALGO_IP_HOST");
const ALGOIP_PORT = readEnv("ALGOIP_PORT", "ALGO_IP_PROXY_PORT", "ALGO_IP_PORT");
const ALGOIP_USER = readEnv("ALGOIP_USER", "ALGO_IP_PROXY_USER", "ALGO_IP_USER");
const ALGOIP_PASSWORD = readEnv(
  "ALGOIP_PASSWORD",
  "ALGO_IP_PROXY_PASSWORD",
  "ALGO_IP_PASSWORD"
);
const ALGOIP_ENABLED = readEnv("ALGOIP_ENABLED") !== "false";

const KITE_BASE = "https://api.kite.trade";
const KITE_TIMEOUT_MS = Number(readEnv("KITE_TIMEOUT_MS") || 12000);
const KITE_MAX_RETRIES = Number(readEnv("KITE_MAX_RETRIES") || 2);

const TOKEN_CACHE_TTL_MS = 30 * 1000;
const INSTRUMENTS_TTL_MS = Number(readEnv("INSTRUMENTS_TTL_MS") || 6 * 60 * 60 * 1000);
const SESSION_SWEEP_INTERVAL_MS =
  Number(readEnv("SESSION_SWEEP_INTERVAL_MS") || 15 * 60 * 1000);
const KEEP_ALIVE_ENABLED = readEnv("KEEP_ALIVE") !== "false";
const KEEP_ALIVE_INTERVAL_MS = Number(readEnv("KEEP_ALIVE_INTERVAL_MS") || 4 * 60 * 1000);

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // Kite login_time is IST (UTC+5:30)

/* ------------------------------------------------------------------ */
/* 2. AlgoIP proxy                                                     */
/* ------------------------------------------------------------------ */

function buildProxyUrl() {
  if (!ALGOIP_ENABLED) {
    return { url: "", error: null, reason: "disabled via ALGOIP_ENABLED=false" };
  }
  if (!ALGOIP_HOST || !ALGOIP_PORT || !ALGOIP_USER || !ALGOIP_PASSWORD) {
    return { url: "", error: null, reason: "missing host/port/username/password" };
  }

  const portNumber = Number(ALGOIP_PORT);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    return {
      url: "",
      error: "Invalid AlgoIP proxy port. It must be a number between 1 and 65535.",
      reason: "invalid port"
    };
  }

  try {
    const candidate = new URL(
      `http://${encodeURIComponent(ALGOIP_USER)}:${encodeURIComponent(
        ALGOIP_PASSWORD
      )}@${ALGOIP_HOST}:${portNumber}`
    );
    if (!candidate.hostname) {
      return { url: "", error: "Missing AlgoIP proxy hostname.", reason: "bad host" };
    }
    return { url: candidate.toString(), error: null, reason: "configured" };
  } catch (error) {
    return {
      url: "",
      error:
        "Invalid AlgoIP proxy settings. Check host, port, username, and password.",
      reason: "unparsable"
    };
  }
}

const proxy = buildProxyUrl();
const proxyUrl = proxy.url;

if (proxyUrl) {
  try {
    setGlobalDispatcher(
      new ProxyAgent({
        uri: proxyUrl,
        connect: { timeout: 10000 },
        keepAliveTimeout: 60000,
        keepAliveMaxTimeout: 600000
      })
    );
    console.log(`[proxy] AlgoIP proxy enabled: ${ALGOIP_HOST}:${ALGOIP_PORT}`);
  } catch (error) {
    proxy.error = error.message;
    console.warn(`[proxy] Failed to initialise AlgoIP proxy: ${error.message}`);
    console.warn("[proxy] Continuing WITHOUT the proxy. Fix the credentials in Render.");
  }
} else if (proxy.error) {
  /* Misconfiguration is logged loudly but is NOT fatal: the app still boots,
     serves the dashboard, and /health reports exactly what is wrong. */
  console.warn(`[proxy] ${proxy.error} Continuing WITHOUT the proxy.`);
} else if (ALGOIP_ENABLED) {
  console.warn(
    `[proxy] AlgoIP proxy is not configured (${proxy.reason}). Continuing WITHOUT ` +
      "the proxy. Set ALGOIP_HOST, ALGOIP_PORT, ALGOIP_USER and ALGOIP_PASSWORD in Render."
  );
}

/* ------------------------------------------------------------------ */
/* 3. Express app                                                      */
/* ------------------------------------------------------------------ */

const app = express();
app.set("trust proxy", 1); /* behind Render's reverse proxy */
app.disable("x-powered-by");

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

/* Never serve source/config files through express.static */
const BLOCKED_STATIC_PATH =
  /(^|\/)(server\.js|package(-lock)?\.json|todo\.md|DEPLOYMENT\.md|README\.md|node_modules|\.git|\.env)(\.|$|\/)/i;
app.use((req, res, next) => {
  if (BLOCKED_STATIC_PATH.test(req.path)) {
    return res.status(403).json({ success: false, message: "Forbidden." });
  }
  next();
});

app.use(express.static(__dirname, { dotfiles: "ignore", index: false }));

/* ------------------------------------------------------------------ */
/* 4. Small helpers                                                    */
/* ------------------------------------------------------------------ */

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function sendPage(res, title, message, success = false, redirectAfterSeconds = 0) {
  const color = success ? "#16a34a" : "#dc2626";
  const icon = success ? "✓" : "!";
  const action = success
    ? `<a href="${escapeHtml(DASHBOARD_URL)}">Continue to Dashboard</a>`
    : '<a href="/kite/login">Try Again</a>';
  const refresh = redirectAfterSeconds
    ? `<meta http-equiv="refresh" content="${Number(redirectAfterSeconds)};url=/kite/login">`
    : "";

  return res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      ${refresh}
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

function serveIndex(res) {
  res.sendFile(path.join(__dirname, "index.html"), (error) => {
    if (error) {
      res.status(500).send(
        "index.html was not found next to server.js. Deploy your frontend files " +
          "alongside this backend (index.html, CSS, JS)."
      );
    }
  });
}

/* Kite login_time is IST "YYYY-MM-DD HH:MM:SS". Access tokens expire around
   6 AM IST the following day (regulatory requirement per Kite docs). */
function approximateTokenExpiry(loginTime) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(
    String(loginTime || "")
  );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  const loginUtcMs =
    Date.UTC(year, month - 1, day, hour, minute, second) - IST_OFFSET_MS;
  let expiryUtcMs =
    Date.UTC(year, month - 1, day, 6, 0, 0) - IST_OFFSET_MS;
  if (loginUtcMs >= expiryUtcMs) {
    expiryUtcMs += 24 * 60 * 60 * 1000;
  }
  return new Date(expiryUtcMs).toISOString();
}

class KiteTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "KiteTokenError";
  }
}

/* ------------------------------------------------------------------ */
/* 5. Database                                                         */
/* ------------------------------------------------------------------ */

let db = null;

if (DATABASE_URL) {
  const needsSsl = !/localhost|127\.0\.0\.1/.test(DATABASE_URL);
  db = new Pool({
    connectionString: DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined
  });

  db.on("error", (error) => {
    console.error("[db] Idle client error:", error.message);
  });
}

async function withRetry(label, task, attempts = 3, waitMs = 2000) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      console.error(
        `[db] ${label} attempt ${attempt}/${attempts} failed: ${error.message}`
      );
      if (attempt < attempts) await delay(waitMs);
    }
  }
  throw lastError;
}

async function initializeDatabase() {
  if (!db) {
    console.warn("[db] DATABASE_URL is not configured. Kite tokens cannot be saved.");
    return;
  }

  await withRetry("create kite_tokens table", async () => {
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
  });

  console.log("[db] Database initialized.");
}

let tokenCache = { value: null, fetchedAt: 0 };

function invalidateTokenCache() {
  tokenCache = { value: null, fetchedAt: 0 };
}

async function getStoredToken(force = false) {
  if (!db) return null;
  if (
    !force &&
    tokenCache.value &&
    Date.now() - tokenCache.fetchedAt < TOKEN_CACHE_TTL_MS
  ) {
    return tokenCache.value;
  }

  const result = await db.query(`
    SELECT access_token, user_id, login_time
    FROM kite_tokens
    WHERE id = 1
    LIMIT 1
  `);
  const value = result.rows[0] || null;
  tokenCache = { value, fetchedAt: Date.now() };
  return value;
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
  invalidateTokenCache();
}

async function deleteKiteToken() {
  if (!db) return;
  await db.query("DELETE FROM kite_tokens WHERE id = 1");
  invalidateTokenCache();
}

/* ------------------------------------------------------------------ */
/* 6. Kite HTTP layer (timeout + retry + error mapping)                */
/* ------------------------------------------------------------------ */

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function kiteAuthHeaders(accessToken) {
  return { Authorization: `token ${KITE_API_KEY}:${accessToken}` };
}

/* Returns { ok, status, text, json } and never throws for network problems.
   networkError results carry { networkError: true, code, detail }. */
async function kiteRequest(pathname, { method = "GET", headers = {}, body = null } = {}) {
  let lastNetworkError = null;

  for (let attempt = 0; attempt <= KITE_MAX_RETRIES; attempt += 1) {
    const requestOptions = {
      method,
      headers: { "X-Kite-Version": "3", ...headers },
      signal: AbortSignal.timeout(KITE_TIMEOUT_MS)
    };
    if (body !== null) requestOptions.body = body;

    try {
      const response = await fetch(`${KITE_BASE}${pathname}`, requestOptions);
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (_) {
        json = null; /* CSV responses (instruments) are not JSON */
      }

      if (isRetryableStatus(response.status) && attempt < KITE_MAX_RETRIES) {
        console.warn(
          `[kite] ${method} ${pathname} -> HTTP ${response.status}; retrying ` +
            `(${attempt + 1}/${KITE_MAX_RETRIES})`
        );
        await delay(400 * 2 ** attempt + Math.floor(Math.random() * 250));
        continue;
      }

      return { ok: response.ok, status: response.status, text, json };
    } catch (error) {
      lastNetworkError = error;
      if (attempt < KITE_MAX_RETRIES) {
        const code = error?.cause?.code || error?.code || error?.name || "NETWORK_ERROR";
        console.warn(
          `[kite] ${method} ${pathname} -> network error (${code}); retrying ` +
            `(${attempt + 1}/${KITE_MAX_RETRIES})`
        );
        await delay(400 * 2 ** attempt + Math.floor(Math.random() * 250));
        continue;
      }
    }
  }

  const code =
    lastNetworkError?.cause?.code ||
    lastNetworkError?.code ||
    lastNetworkError?.name ||
    "NETWORK_ERROR";
  const detail =
    lastNetworkError?.cause?.message ||
    lastNetworkError?.message ||
    "Unable to reach Kite.";
  return { ok: false, status: 0, text: "", json: null, networkError: true, code, detail };
}

function isTokenError(kiteJson) {
  const errorType = String(kiteJson?.error_type || "").toLowerCase();
  const message = String(kiteJson?.message || "").toLowerCase();
  return (
    errorType.includes("token") ||
    message.includes("access_token") ||
    message.includes("api_key or") ||
    message.includes("session expired") ||
    message.includes("too many sessions")
  );
}

/* Central error mapping used by the API routes. Returns true when it has
   written a response (so routes can `return`). */
async function handleKiteFailure(res, response, fallbackMessage) {
  if (response.networkError) {
    return res.status(502).json({
      success: false,
      code: response.code,
      message: `${fallbackMessage} (${response.code}). ${response.detail}`
    });
  }

  if (isTokenError(response.json)) {
    try {
      await deleteKiteToken();
    } catch (_) {
      /* best effort */
    }
    return res.status(401).json({
      success: false,
      code: "KITE_SESSION_EXPIRED",
      message: "Your Kite session expired. Log in again.",
      loginUrl: "/kite/login"
    });
  }

  return res.status(response.status || 502).json({
    success: false,
    message: response.json?.message || fallbackMessage,
    errorType: response.json?.error_type || null
  });
}

/* Liveness probe against /user/profile, cached briefly to stay inside
   Kite's rate limits. */
let sessionCheckCache = { key: null, alive: false, checkedAt: 0 };

async function isSessionAlive(accessToken, { force = false } = {}) {
  if (!accessToken) return false;

  const key = accessToken.slice(-12);
  if (
    !force &&
    sessionCheckCache.key === key &&
    Date.now() - sessionCheckCache.checkedAt < TOKEN_CACHE_TTL_MS
  ) {
    return sessionCheckCache.alive;
  }

  const response = await kiteRequest("/user/profile", {
    headers: kiteAuthHeaders(accessToken)
  });
  const alive = Boolean(response.ok && response.json?.status === "success");
  sessionCheckCache = { key, alive, checkedAt: Date.now() };
  return alive;
}

/* --------------------------------------------*/
/* 7. Instruments cache                                                */
/* ------------------------------------------------------------------ */

let instrumentsCache = { items: [], fetchedAt: 0, promise: null };

async function downloadInstruments(accessToken) {
  const response = await kiteRequest("/instruments/NSE", {
    headers: kiteAuthHeaders(accessToken)
  });

  if (response.networkError) {
    throw new Error(
      `Instruments download failed (${response.code}): ${response.detail}`
    );
  }
  if (!response.ok) {
    if (isTokenError(response.json)) {
      throw new KiteTokenError(response.json?.message || "Kite session expired.");
    }
    throw new Error(
      response.json?.message ||
        response.text.slice(0, 200) ||
        "Unable to download NSE instruments."
    );
  }

  const lines = response.text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];

  const headings = parseCsvLine(lines.shift());
  const symbolIndex =

headings.indexOf("instrument_token");

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
async function getInstruments() {
  const token = await getStoredToken();
  if (!KITE_API_KEY || !token?.access_token) return [];

  if (
    instrumentsCache.items.length &&
    Date.now() - instrumentsCache.fetchedAt < INSTRUMENTS_TTL_MS
  ) {
    return instrumentsCache.items;
  }

  /* De-duplicate concurrent downloads (dashboard fires several first-load calls) */
  if (instrumentsCache.promise) {
    return instrumentsCache.promise;
  }

instrumentsCache.promise = downloadInstruments(token.access_token)
    .then((items) => {
      instrumentsCache = { items, fetchedAt: Date.now(), promise: null };
      console.log(`[kite] cached ${items.length} NSE instruments`);
      return items;
    })
    .catch((error) => {
      instrumentsCache.promise = null;
      throw error;
    });

  return instrumentsCache.promise;
}


/* ------------------------------------------------------------------ 8
  Routes                                                           */
/* ------------------------------------------------------------------ */

app.get("/", (req, res) => {
  serveIndex(res);
});

app.get("/health", async (req, res) => {
  try {
    const token = await getStoredToken();
    res.json({
      success: true,
      backend: true,
      uptimeSeconds: Math.floor(process.uptime()),
      kiteConfigured: Boolean(KITE_API_KEY && KITE_API_SECRET),
      databaseConfigured: Boolean(db),
      accessTokenConfigured: Boolean(token?.access_token),

userId: token?.user_id || null,
      loginTime: token?.login_time || null,
      approxTokenExpiry: approximateTokenExpiry(token?.login_time),
      instrumentsCached: instrumentsCache.items.length,
      instrumentsCacheAgeSeconds: instrumentsCache.fetchedAt
        ? Math.floor((Date.now() - instrumentsCache.fetchedAt) / 1000)
        : null,
      callbackUrl: CALLBACK_URL,
      dashboardUrl: DASHBOARD_URL,
      proxyConfigured: Boolean(proxyUrl),
      proxyHost: proxyUrl ? ALGOIP_HOST : null,
      proxyPort: proxyUrl ? Number(ALGOIP_PORT) : null,
      proxyError: proxy.error || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
}
});

app.get("/api/proxy-check", async (req, res) => {
  if (!proxyUrl) {
    const hint = proxy.error
      ? ` ${proxy.error}`
      : " Set ALGOIP_HOST, ALGOIP_PORT, ALGOIP_USER and ALGOIP_PASSWORD in Render.";
    return res
      .status(503)
      .json({ success: false, message: `AlgoIP proxy is not configured.${hint}` });
  }

  try {
    const response = await fetch("https://ip64.algoip.in/all?format=json", {
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json().catch(() => ({}));
    return res.status(response.ok ? 200 : 
502).json({
      success: response.ok,
      proxyConfigured: true,
      routedIp: data.ip || null,
      country: data.country || null,
      city: data.city || null,
      message: response.ok
        ? "AlgoIP proxy routing is working."
        : "AlgoIP proxy verification failed."
    });
  } catch (error) {
    const code = error?.cause?.code || error?.code || "NETWORK_ERROR";
    console.error("[proxy] Proxy check error:", { code, message: error.message });
    return res.status(502).json({
      success: false,
      proxyConfigured: true,
      code,
      message:
        "Render cannot reach the AlgoIP proxy. Check the host, port, username, " +
        "password, and AlgoIP service status."
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

/* Kite redirects here after a successful login. The request_token is
   SINGLE USE and valid for only a few minutes, so this route must survive
   replays, refreshes and double-fires gracefully. */
app.get("/kite/callback", async (req, res) => {
  const requestToken = String(req.query.request_token || "").trim();
  const status = String(req.query.status || "");

  if (status !== "success" || !requestToken) {
    return sendPage(
      res,
      "Authentication Failed",
      "Kite did not return a valid request token.",
      false,
      5
    );
  }
if (!KITE_API_KEY || !KITE_API_SECRET) {
    return sendPage(
      res, "Configuration Error",
"KITE_API_KEY or KITE_API_SECRET ismissing.”
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
    /* Replay guard: if the stored session is still alive, a duplicate or
       reused request_token would fail the exchange anyway - just redirect. */
    const existing = await getStoredToken();
    if (existing?.access_token && (await isSessionAlive(existing.access_token))) {
      console.log(
        "[kite] callback replay detected; existing session is still valid -> dashboard"
      );
return res.redirect(`${DASHBOARD_URL}?kite=connected`);
    }

    const body = new URLSearchParams({
      api_key: KITE_API_KEY,
      request_token: requestToken,
      checksum: checksum(KITE_API_KEY, requestToken, KITE_API_SECRET)
    });

    const response = await kiteRequest("/session/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    if (response.networkError) {
      console.error("[kite] callback network error:", {
        code: response.code,
        detail: response.detail
      });
      return sendPage(
"Authentication Error",
        `Kite session request failed (${response.code}). ${response.detail}. ` +
          "Check the AlgoIP proxy protocol, host, port, username, and password in Render.",
        false,
        8
      );
    }

    const result = response.json;
    if (!response.ok || result?.status !== "success" || !result?.data?.access_token) {
      const message = result?.message || response.text || "Kite token exchange failed.";
      console.error("[kite] token exchange failed:", message);
      return sendPage(
        res,
        "Kite Authentication Failed",
        `${message} Request tokens are single-use and expire within minutes - ` +
          "use the button below to log in again.",
false,
        5
      );
    }

    await saveKiteToken(
      result.data.access_token,
      result.data.user_id,
      result.data.login_time
    );
    console.log(
      `[kite] login OK (user ${result.data.user_id}); token saved and valid until ~` +
        `${approximateTokenExpiry(result.data.login_time)}`
    );
    return res.redirect(`${DASHBOARD_URL}?kite=connected`);
  } catch (error) {
    const code = error?.cause?.code || error?.code || "SERVER_ERROR";
const detail = error?.message || "Unexpected error during Kite login.";
    console.error("[kite] callback error:", { code, detail });
    return sendPage(
      res,
      "Authentication Error",
      `Kite login failed (${code}). ${detail}`,
      false,
      8
    );
  }
});

app.get("/api/auth/status", async (req, res) => {
  try {
    const token = await getStoredToken();
    const connected = Boolean(token?.access_token);
    let alive = false;

    if (connected) {
/* Real liveness check (cached ~30s) so the dashboard learns about the
         daily ~6 AM IST expiry without waiting for a failed trade call. */
      alive = await isSessionAlive(token.access_token);
      if (!alive) {
        try {
          await deleteKiteToken();
        } catch (_) {
          /* best effort */
        }
      }
    }

    res.json({
      success: true,
      connected: connected && alive,
      alive,
      userId: token?.user_id || null,
      loginTime: token?.login_time || null,
      approxTokenExpiry: approximateTokenExpiry(token?.login_time),
      message:
        connected && alive
          ? null
: connected
            ? "Your Kite session expired (tokens expire around 6 AM IST). Log in again."
            : "Not connected. Visit /kite/login to connect Kite.",
      loginUrl: connected && alive ? null : "/kite/login"
    });
  }
  catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/dashboard", async (req, res) => {
  try {
    const token = await getStoredToken();
    if (!token?.access_token) return res.redirect("/kite/login");
    return serveIndex(res);
  } catch (error) {
    return res.status(500).send(`Dashboard error: ${escapeHtml(error.message)}`);
  }
});

app.get("/dashboard", async (req, res) => {
  try {
    const token = await getStoredToken();
    if (!token?.access_token) return res.redirect("/kite/login");
    return serveIndex(res);
  } catch (error) {
    return res.status(500).send(`Dashboard error: ${escapeHtml(error.message)}`);
  }
});

app.get("/api/stocks/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim().toUpperCase();
    if (!query) return res.json({ success: true, results: [] });

    const items = await getInstruments();

    const results = items
      .filter((item) => {
        const symbol = item.symbol.toUpperCase();
const name = item.name.toUpperCase();
        return symbol.includes(query) || name.includes(query);
      })
      .slice(0, 20);

    return res.json({ success: true, results });
  } catch (error) {
    if (error instanceof KiteTokenError) {
      try {
        await deleteKiteToken();
      } catch (_) {
        /* best effort */
      }
      return res.status(401).json({
        success: false,
        code: "KITE_SESSION_EXPIRED",
        message: "Your Kite session expired. Log in again.",
        loginUrl: "/kite/login"
      });
    }
    console.error("Stock search error:", error);
    return res.status(500).json({ success: false, message: error.message });
}
});

app.get("/api/stocks/recommendation", async (req, res) => {
  try {
    const token = await getStoredToken();
    if (!token?.access_token) {
      return res.status(401).json({
        success: false,
        code: "KITE_SESSION_EXPIRED",
        message: "Connect Kite first.",
        loginUrl: "/kite/login"
      });
    }

    const items = await getInstruments();
    const candidates = items.filter(
      (item) => item.symbol && !item.symbol.includes("-")
    );

    if (!candidates.length) {
      return res.status(404).json({
        success: false,
        message: "No NSE instruments are available.”});
    }

const selected=candidates[Math.floor
  (Math.random() * candidates.length)];
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
  }
    catch (error) {
    if (error instanceof KiteTokenError) {
      try {
        await deleteKiteToken();
      } catch (_) {
        /* best effort */
      }
      return res.status(401).json({
        success: false,
        code: "KITE_SESSION_EXPIRED",
        message: "Your Kite session expired. Log in again.",
        loginUrl: "/kite/login"
      });
    }
    console.error("NSE recommendation error:", error);
    return res.status(500).json({ success: false, message: error.message });
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

    const token = await getStoredToken();
    if (!token?.access_token) {
      return res.status(401).json({
        success: false,
        code: "KITE_SESSION_EXPIRED",
        message: "Connect Kite first.",
        loginUrl: "/kite/login"
      });
    }
const instrument = `NSE:${symbol}`;
    const response = await kiteRequest(
      "/quote/ltp" + `?i=${encodeURIComponent(instrument)}`,
      { headers: kiteAuthHeaders(token.access_token) }
    );

    if (!response.ok || response.json?.status !== "success") {
      return handleKiteFailure(res, response, "Kite quote failed.");
    }

    const quote = response.json.data?.[instrument];
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
const token = await getStoredToken();
    if (!token?.access_token) {
      return res.status(401).json({
        success: false,
        code: "KITE_SESSION_EXPIRED",
        message: "Connect Kite before placing an order.",
        loginUrl: "/kite/login"
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
    const normalizedPrice = Number(price ||
0);
    const allowedTransactions = new Set(["BUY", "SELL"]);
    const allowedOrderTypes = new Set(["MARKET", "LIMIT"]);

    if (
      exchange !== "NSE" ||
      !String(tradingsymbol || "").trim() ||
      !allowedTransactions.has(transaction_type) ||
      !Number.isInteger(normalizedQuantity) ||
      normalizedQuantity <= 0 ||
      !allowedOrderTypes.has(order_type) ||
      (order_type === "LIMIT" && normalizedPrice <= 0)
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

    const response = await kiteRequest("/orders/regular", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
kiteAuthHeaders(token.access_token)
      },
      body: orderBody.toString()
    });

    const result = response.json;
    if (!response.ok || result?.status !== "success") {
      return handleKiteFailure(res, response, "Kite rejected the order.");
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
  }
  catch (error) {
    console.error("Order submission error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/orders/:orderId/status", async (req, res) => {
  try {
    const token = await getStoredToken();
    const orderId = String(req.params.orderId || "").trim();

    if (!token?.access_token) {
      return res.status(401).json({
        success: false,
        code: "KITE_SESSION_EXPIRED",
        message: "Connect Kite before checking order status.",
loginUrl: "/kite/login"
      });
    }

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order ID is required."
      });
    }

    const response = await kiteRequest(
      `/orders/${encodeURIComponent(orderId)}`,
      { headers: kiteAuthHeaders(token.access_token) }
    );

    if (!response.ok || response.json?.status !== "success") {
      return handleKiteFailure(res, response, "Unable to read order status.");
}

    const orders = Array.isArray(response.json.data) ? response.json.data : [];
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
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = await getStoredToken();

    /* Best-effort server-side invalidation so the token cannot be reused. */
    if (token?.access_token && KITE_API_KEY) {
      try {
        await kiteRequest(
          `/session/token?api_key=${encodeURIComponent(KITE_API_KEY)}` +
            `&access_token=${encodeURIComponent(token.access_token)}`,
          { method: "DELETE" }
        );
      } catch (_) {
        /* ignore - local cleanup below is what matters */
      }
    }

    await deleteKiteToken();
    instrumentsCache = { items: [], fetchedAt: 0, promise: null };
    sessionCheckCache = { key: null, alive: false, checkedAt: 0 };

    return res.json({ success: true, message: "Logged out." });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/* ------------------------------------------------------------------ */
/* 9. Background helpers                                               */
/* ------------------------------------------------------------------ */

function startSessionSweeper() {
  const timer = setInterval(async () => {
    try {
      const token = await getStoredToken(true);
      if (!token?.access_token) return;
const alive = await isSessionAlive(token.access_token, { force: true });
      if (!alive) {
        console.log(
          "[kite] session sweeper: stored token is no longer valid; clearing it"
        );
        await deleteKiteToken();
}
    } catch (error) {
      console.error("[kite] session sweeper error:", error.message);
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  timer.unref?.();
  console.log(
    `[kite] session sweeper active (every ${Math.round(
      SESSION_SWEEP_INTERVAL_MS / 60000
    )} min; set SESSION_SWEEP_INTERVAL_MS to tune)`
  );
}

function startKeepAlive() {
  if (!KEEP_ALIVE_ENABLED) return;
  if (!BASE_URL || /localhost|127\.0\.0\.1/.test(BASE_URL)) return;

  const ping = async () => {
    try {
      await fetch(`${BASE_URL}/health`, {
signal: AbortSignal.timeout(10000) });
    } catch (_) {
      /* Instance may be asleep or offline - ignore. */
    }
  };

  const timer = setInterval(ping, KEEP_ALIVE_INTERVAL_MS);
  timer.unref?.();
  console.log(
    `[keep-alive] pinging ${BASE_URL}/health every ${Math.round(
      KEEP_ALIVE_INTERVAL_MS / 60000
    )} min (set KEEP_ALIVE=false to disable; an external cron such as ` +
      "UptimeRobot is the most reliable option on the Render free tier)"
  );
}
/* ------------------------------------------------------------------ */
/* 10. Startup & shutdown                                              */
/* ------------------------------------------------------------------ */

let server = null;

function logStartupBanner() {
  console.log("==============================================");
  console.log(" Kite backend starting");
  console.log(`  port:          ${PORT}`);
  console.log(`  base URL:      ${BASE_URL}`);
  console.log(`  callback URL:  ${CALLBACK_URL}`);
  console.log(`  dashboard URL: ${DASHBOARD_URL}`);
  console.log(`  kite api key:  ${KITE_API_KEY ? KITE_API_KEY.slice(0, 4) + "****" : "MISSING"}`);
console.log(`  kite secret:   ${KITE_API_SECRET ? "configured" : "MISSING"}`);
  console.log(`  database:      ${db ? "configured" : "MISSING"}`);
  console.log(
    `  proxy:         ${proxyUrl ? `${ALGOIP_HOST}:${ALGOIP_PORT}` : proxy.error ? "ERROR - " + proxy.error : "not configured"}`
  );
  console.log(`  kite timeout:  ${KITE_TIMEOUT_MS}ms (retries: ${KITE_MAX_RETRIES})`);
  console.log("==============================================");
}

function shutdown(signal) {
  console.log(`\n[server] ${signal} received - shutting down gracefully.`);
  const forceExit = setTimeout(() => process.exit(signal === "uncaughtException" ? 1 : 0), 8000);
forceExit.unref();

  if (server) {
    server.close(async () => {
      try {
        if (db) await db.end();
      } catch (_) {
        /* ignore */
      }
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled rejection:", reason?.message || reason);
});
process.on("uncaughtException", (error) => {
  console.error("[process] Uncaught exception:", error);
  shutdown("uncaughtException");
});

async function startServer() {
  logStartupBanner();

  try {
    await initializeDatabase();
  } catch (error) {
    console.error("[db] Database initialisation failed after retries:", error.message);
    console.error("[db] Render will restart the service; verify DATABASE_URL.");
    process.exit(1);
  }

  server = app.listen(PORT, "0.0.0.0", () => {
    /* Behind Render's proxy the default 5s keep-alive window causes
       ECONNRESETs for clients; keep sockets
open longer than the LB. */
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;

    console.log(`[server] running on port ${PORT}`);
    console.log(`[server] callback URL: ${CALLBACK_URL}`);
    console.log(`[server] dashboard URL: ${DASHBOARD_URL}`);

    startSessionSweeper();
    startKeepAlive();
  });
}

startServer();  