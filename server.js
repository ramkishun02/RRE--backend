/**
 * Zerodha Kite Connect Trading Backend + AlgoIP Static Egress Engine
 * -----------------------------------------------------------------
 * Node.js (Express) + undici + PostgreSQL
 *
 * Every outbound call to api.kite.trade is dispatched through the AlgoIP
 * authenticated CONNECT proxy so Zerodha sees the whitelisted static IP.
 *
 * Run:  node server.js
 * Deps: express pg undici
 */

'use strict';

const path = require('path');
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const { ProxyAgent, Agent, request } = require('undici');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 10000;

const KITE_API_KEY = process.env.KITE_API_KEY || '';
const KITE_API_SECRET = process.env.KITE_API_SECRET || '';
const KITE_BASE = 'https://api.kite.trade';
const KITE_LOGIN_BASE = 'https://kite.zerodha.com/connect/login';

const ALGOIP_HOST = process.env.ALGOIP_HOST || '';
const ALGOIP_PORT = process.env.ALGOIP_PORT || '';
const ALGOIP_USER = process.env.ALGOIP_USER || '';
const ALGOIP_PASSWORD = process.env.ALGOIP_PASSWORD || '';
const ALGOIP_EXPECTED_IP = process.env.ALGOIP_EXPECTED_IP || '';

const DATABASE_URL = process.env.DATABASE_URL || '';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+05:30, India has no DST
const SESSION_RESET_HOUR_IST = 6;           // regulatory daily invalidation ~06:00 IST
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;   // profile probe every 15 minutes

// ---------------------------------------------------------------------------
// Tiny logger
// ---------------------------------------------------------------------------

function log(level, msg, extra) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// PHASE 1 FIX #2 — AlgoIP dispatcher
//
// The `fetch failed` / `SocketError: other side closed` failures came from
// undici holding a pooled socket in the CONNECT tunnel longer than the proxy
// keeps it alive. Short idle keep-alive + pipelining disabled means we never
// hand a half-dead socket to a new request.
// ---------------------------------------------------------------------------

const DISPATCHER_OPTS = {
  keepAliveTimeout: 10000,     // drop idle sockets after 10s (proxy closes ~15-30s)
  keepAliveMaxTimeout: 15000,  // hard ceiling regardless of server hints
  pipelining: 0,               // one in-flight request per socket, no pipelining
  connections: 8,
  connectTimeout: 15000,
  headersTimeout: 30000,
  bodyTimeout: 30000,
};

function buildDispatcher() {
  if (!ALGOIP_HOST || !ALGOIP_PORT) {
    log('WARN', 'AlgoIP proxy not configured — using DIRECT egress (Kite will reject non-whitelisted IPs)');
    return new Agent(DISPATCHER_OPTS);
  }

  const token =
    ALGOIP_USER || ALGOIP_PASSWORD
      ? 'Basic ' + Buffer.from(`${ALGOIP_USER}:${ALGOIP_PASSWORD}`).toString('base64')
      : undefined;

  return new ProxyAgent({
    uri: `http://${ALGOIP_HOST}:${ALGOIP_PORT}`,
    token,
    ...DISPATCHER_OPTS,
    // options applied to the tunnelled connection pool as well
    proxyTls: { timeout: 15000 },
    requestTls: { timeout: 15000 },
  });
}

let dispatcher = buildDispatcher();

/** Tear down the poisoned pool and build a clean one (used by the retry path). */
async function recycleDispatcher(reason) {
  log('WARN', `Recycling AlgoIP dispatcher: ${reason}`);
  const old = dispatcher;
  dispatcher = buildDispatcher();
  try {
    await old.close();
  } catch (_) {
    try { await old.destroy(); } catch (_) { /* noop */ }
  }
}

const TRANSIENT_CODES = new Set([
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

function isTransient(err) {
  if (!err) return false;
  const code = err.code || (err.cause && err.cause.code);
  if (code && TRANSIENT_CODES.has(code)) return true;
  const msg = String(err.message || '');
  return /fetch failed|other side closed|socket hang up|terminated/i.test(msg);
}

/**
 * Single funnel for every Kite HTTP call.
 * Retries transient socket failures on a freshly built dispatcher.
 */
async function kiteRequest(method, urlPath, { query, form, accessToken, retries = 2 } = {}) {
  const url = new URL(urlPath.startsWith('http') ? urlPath : KITE_BASE + urlPath);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
      else url.searchParams.set(k, String(v));
    }
  }

  const headers = { 'X-Kite-Version': '3', Accept: 'application/json' };
  if (accessToken) headers.Authorization = `token ${KITE_API_KEY}:${accessToken}`;

  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(
      Object.fromEntries(Object.entries(form).filter(([, v]) => v !== undefined && v !== null))
    ).toString();
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await request(url, { method, headers, body, dispatcher });
      const text = await res.body.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = { raw: text }; }
      return { status: res.statusCode, body: parsed, text };
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isTransient(err)) {
        await recycleDispatcher(err.code || err.message);
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      break;
    }
  }

  const wrapped = new Error(`Upstream request failed: ${lastErr && lastErr.message}`);
  wrapped.code = 'UPSTREAM_UNREACHABLE';
  wrapped.cause = lastErr;
  throw wrapped;
}

// ---------------------------------------------------------------------------
// Kite error mapping
// ---------------------------------------------------------------------------

function loginUrl() {
  return `${KITE_LOGIN_BASE}?api_key=${encodeURIComponent(KITE_API_KEY)}&v=3`;
}

/**
 * Normalizes a Kite response into either the payload or a thrown ApiError with
 * a standardized HTTP status. `TokenException` always surfaces as
 * KITE_SESSION_EXPIRED / 401 with the login URL so the UI can re-auth.
 */
function unwrapKite(res) {
  if (res.status >= 200 && res.status < 300 && res.body && res.body.status === 'success') {
    return res.body.data;
  }

  const errType = (res.body && res.body.error_type) || 'GeneralException';
  const message = (res.body && res.body.message) || `Kite responded ${res.status}`;

  const err = new Error(message);
  if (errType === 'TokenException' || res.status === 403 || res.status === 401) {
    err.status = 401;
    err.code = 'KITE_SESSION_EXPIRED';
    err.loginUrl = loginUrl();
  } else if (errType === 'InputException') {
    err.status = 400;
    err.code = 'KITE_INVALID_INPUT';
  } else if (errType === 'NetworkException' || errType === 'GatewayException') {
    err.status = 502;
    err.code = 'KITE_UPSTREAM_ERROR';
  } else if (errType === 'OrderException') {
    err.status = 422;
    err.code = 'KITE_ORDER_REJECTED';
  } else if (res.status === 429) {
    err.status = 429;
    err.code = 'KITE_RATE_LIMITED';
  } else {
    err.status = 502;
    err.code = 'KITE_ERROR';
  }
  err.errorType = errType;
  throw err;
}

// ---------------------------------------------------------------------------
// PostgreSQL token persistence (single tenant, primary record id = 1)
// ---------------------------------------------------------------------------

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
  : null;

async function initDb() {
  if (!pool) {
    log('WARN', 'DATABASE_URL not set — token persistence disabled (memory only)');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kite_tokens (
      id            INTEGER PRIMARY KEY,
      user_id       TEXT,
      user_name     TEXT,
      access_token  TEXT NOT NULL,
      public_token  TEXT,
      login_time    TIMESTAMPTZ NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  log('INFO', 'kite_tokens table ready');
}

/** In-memory cache mirror of the single DB row. */
let tokenCache = null;

/** Kite returns login_time as "YYYY-MM-DD HH:MM:SS" in IST with no offset. */
function normalizeIstLoginTime(raw) {
  if (!raw) return new Date();
  if (raw instanceof Date) return raw;
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? new Date() : d;
  }
  const [, y, mo, d, h, mi, s] = m.map(Number);
  // Interpret the wall-clock as IST, store as a true UTC instant.
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - IST_OFFSET_MS);
}

async function saveToken(session) {
  const record = {
    id: 1,
    user_id: session.user_id || null,
    user_name: session.user_name || null,
    access_token: session.access_token,
    public_token: session.public_token || null,
    login_time: normalizeIstLoginTime(session.login_time),
  };

  if (pool) {
    await pool.query(
      `INSERT INTO kite_tokens (id, user_id, user_name, access_token, public_token, login_time, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         user_name = EXCLUDED.user_name,
         access_token = EXCLUDED.access_token,
         public_token = EXCLUDED.public_token,
         login_time = EXCLUDED.login_time,
         updated_at = NOW()`,
      [record.user_id, record.user_name, record.access_token, record.public_token, record.login_time]
    );
  }

  tokenCache = record;
  log('INFO', `Token stored for user ${record.user_id}`);
  return record;
}

async function loadToken() {
  if (tokenCache) return tokenCache;
  if (!pool) return null;
  const { rows } = await pool.query('SELECT * FROM kite_tokens WHERE id = 1');
  if (!rows.length) return null;
  tokenCache = rows[0];
  return tokenCache;
}

async function clearToken(reason) {
  log('WARN', `Clearing Kite session: ${reason}`);
  tokenCache = null;
  if (pool) await pool.query('DELETE FROM kite_tokens WHERE id = 1');
}

/** Throws KITE_SESSION_EXPIRED if there is no usable token. */
async function requireToken() {
  const row = await loadToken();
  if (!row || !row.access_token) {
    const err = new Error('No active Kite session. Please log in.');
    err.status = 401;
    err.code = 'KITE_SESSION_EXPIRED';
    err.loginUrl = loginUrl();
    throw err;
  }
  return row.access_token;
}

// ---------------------------------------------------------------------------
// Session lifetime helpers — next 06:00 IST boundary
// ---------------------------------------------------------------------------

function nextIstResetInstant(from = new Date()) {
  const ist = new Date(from.getTime() + IST_OFFSET_MS);
  const boundary = new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), SESSION_RESET_HOUR_IST, 0, 0)
  );
  if (boundary.getTime() <= ist.getTime()) boundary.setUTCDate(boundary.getUTCDate() + 1);
  return new Date(boundary.getTime() - IST_OFFSET_MS);
}

// ---------------------------------------------------------------------------
// PHASE 1 FIX #1 — sendPage signature
//
// Was called inconsistently as sendPage(res, html) and sendPage(res, code, html)
// across the /kite/callback error branches, so the status code was rendered as
// the page body. One signature, everywhere:
//     sendPage(res, statusCode, title, message, redirectTo?)
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function sendPage(res, statusCode, title, message, redirectTo) {
  const code = Number.isInteger(statusCode) ? statusCode : 500;
  const ok = code < 400;
  const redirectMeta = redirectTo
    ? `<meta http-equiv="refresh" content="2;url=${escapeHtml(redirectTo)}">`
    : '';

  res.status(code).type('html').send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>${redirectMeta}
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;
       color:#e2e8f0;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif}
  .card{max-width:520px;padding:36px 40px;border:1px solid #1e293b;border-radius:14px;
        background:#111c33;box-shadow:0 24px 60px rgba(0,0,0,.45)}
  h1{margin:0 0 10px;font-size:19px;letter-spacing:-.01em;color:${ok ? '#4ade80' : '#f87171'}}
  p{margin:0;color:#94a3b8}
  code{color:#7dd3fc}
  a{display:inline-block;margin-top:22px;color:#38bdf8;text-decoration:none;font-weight:600}
</style></head>
<body><div class="card">
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <a href="${escapeHtml(redirectTo || '/dashboard')}">Continue &rarr;</a>
</div></body></html>`);
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true }));

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- Health & proxy verification -------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    proxyConfigured: Boolean(ALGOIP_HOST && ALGOIP_PORT),
    dbConfigured: Boolean(pool),
    kiteConfigured: Boolean(KITE_API_KEY && KITE_API_SECRET),
  });
});

/**
 * GET /api/proxy-check
 * Confirms outbound traffic egresses from the whitelisted AlgoIP address.
 */
app.get('/api/proxy-check', asyncRoute(async (req, res) => {
  const started = Date.now();
  try {
    const r = await request('https://api.ipify.org?format=json', { dispatcher, method: 'GET' });
    const data = JSON.parse(await r.body.text());
    const egressIp = data.ip;
    const matches = ALGOIP_EXPECTED_IP ? egressIp === ALGOIP_EXPECTED_IP : null;

    res.status(matches === false ? 409 : 200).json({
      egressIp,
      expectedIp: ALGOIP_EXPECTED_IP || null,
      matches,
      proxyConfigured: Boolean(ALGOIP_HOST && ALGOIP_PORT),
      proxyHost: ALGOIP_HOST ? `${ALGOIP_HOST}:${ALGOIP_PORT}` : null,
      latencyMs: Date.now() - started,
    });
  } catch (err) {
    res.status(502).json({
      code: 'PROXY_UNREACHABLE',
      message: err.message,
      proxyHost: ALGOIP_HOST ? `${ALGOIP_HOST}:${ALGOIP_PORT}` : null,
      latencyMs: Date.now() - started,
    });
  }
}));

// --- OAuth flow -------------------------------------------------------------

app.get('/kite/login', (req, res) => {
  if (!KITE_API_KEY) {
    return sendPage(res, 500, 'Configuration missing', 'KITE_API_KEY is not set on this server.', '/dashboard');
  }
  res.redirect(loginUrl());
});

/**
 * GET /kite/callback?request_token=...&status=success
 * Exchanges the request token through the AlgoIP proxy and persists the session.
 */
app.get('/kite/callback', asyncRoute(async (req, res) => {
  const { request_token: requestToken, status } = req.query;

  if (status && status !== 'success') {
    return sendPage(res, 400, 'Login cancelled',
      'Zerodha reported a non-success status for this login attempt. Please try again.', '/dashboard?kite=failed');
  }
  if (!requestToken) {
    return sendPage(res, 400, 'Missing request token',
      'The callback did not include a request_token parameter.', '/dashboard?kite=failed');
  }
  if (!KITE_API_KEY || !KITE_API_SECRET) {
    return sendPage(res, 500, 'Configuration missing',
      'KITE_API_KEY / KITE_API_SECRET are not configured on this server.', '/dashboard?kite=failed');
  }

  const checksum = crypto
    .createHash('sha256')
    .update(KITE_API_KEY + requestToken + KITE_API_SECRET)
    .digest('hex');

  let session;
  try {
    const raw = await kiteRequest('POST', '/session/token', {
      form: { api_key: KITE_API_KEY, request_token: requestToken, checksum },
    });
    session = unwrapKite(raw);
  } catch (err) {
    log('ERROR', 'Token exchange failed', err.message);
    const code = err.status === 401 ? 401 : err.code === 'UPSTREAM_UNREACHABLE' ? 502 : (err.status || 502);
    return sendPage(res, code, 'Token exchange failed', err.message, '/dashboard?kite=failed');
  }

  await saveToken(session);
  return res.redirect('/dashboard?kite=connected');
}));

/** GET /api/session — session state + remaining lifetime for the health pill. */
app.get('/api/session', asyncRoute(async (req, res) => {
  const row = await loadToken();
  const expiresAt = nextIstResetInstant();
  if (!row) {
    return res.json({
      connected: false,
      userId: null,
      userName: null,
      loginTime: null,
      expiresAt: expiresAt.toISOString(),
      secondsRemaining: 0,
      loginUrl: loginUrl(),
    });
  }
  return res.json({
    connected: true,
    userId: row.user_id,
    userName: row.user_name,
    loginTime: new Date(row.login_time).toISOString(),
    expiresAt: expiresAt.toISOString(),
    secondsRemaining: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    loginUrl: loginUrl(),
  });
}));

app.post('/api/session/logout', asyncRoute(async (req, res) => {
  await clearToken('manual logout');
  res.json({ connected: false });
}));

// --- Instrument master cache -----------------------------------------------

const INSTRUMENT_TTL_MS = 6 * 60 * 60 * 1000; // refresh twice a day
let instrumentCache = { at: 0, rows: [] };
let instrumentInFlight = null; // in-flight dedup: concurrent callers share one download

function parseInstrumentCsv(csv) {
  const lines = csv.split('\n');
  const header = lines[0].split(',').map((h) => h.trim());
  const idx = {
    token: header.indexOf('instrument_token'),
    symbol: header.indexOf('tradingsymbol'),
    name: header.indexOf('name'),
    exchange: header.indexOf('exchange'),
    segment: header.indexOf('segment'),
    type: header.indexOf('instrument_type'),
  };
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.split(',');
    if (c[idx.exchange] !== 'NSE' || c[idx.type] !== 'EQ') continue;
    out.push({
      instrumentToken: Number(c[idx.token]),
      tradingsymbol: c[idx.symbol],
      name: (c[idx.name] || '').replace(/^"|"$/g, ''),
      exchange: c[idx.exchange],
      segment: c[idx.segment],
    });
  }
  return out;
}

async function getInstruments() {
  if (Date.now() - instrumentCache.at < INSTRUMENT_TTL_MS && instrumentCache.rows.length) {
    return instrumentCache.rows;
  }
  if (instrumentInFlight) return instrumentInFlight;

  instrumentInFlight = (async () => {
    try {
      const r = await request(`${KITE_BASE}/instruments/NSE`, { dispatcher, method: 'GET' });
      if (r.statusCode !== 200) throw new Error(`instrument dump returned ${r.statusCode}`);
      const rows = parseInstrumentCsv(await r.body.text());
      instrumentCache = { at: Date.now(), rows };
      log('INFO', `Instrument cache loaded: ${rows.length} NSE equities`);
      return rows;
    } finally {
      instrumentInFlight = null;
    }
  })();

  return instrumentInFlight;
}

app.get('/api/stocks/search', asyncRoute(async (req, res) => {
  const q = String(req.query.q || req.query.query || '').trim().toUpperCase();
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  if (q.length < 1) return res.json({ query: q, count: 0, results: [] });

  const rows = await getInstruments();
  const starts = [];
  const contains = [];
  for (const row of rows) {
    const sym = row.tradingsymbol;
    if (sym.startsWith(q)) starts.push(row);
    else if (sym.includes(q) || row.name.toUpperCase().includes(q)) contains.push(row);
    if (starts.length >= limit) break;
  }
  const results = starts.concat(contains).slice(0, limit);
  res.json({ query: q, count: results.length, results });
}));

// --- Market data ------------------------------------------------------------

app.get('/api/market/quote', asyncRoute(async (req, res) => {
  const symbol = String(req.query.symbol || '').trim().toUpperCase();
  if (!symbol) {
    return res.status(400).json({ code: 'INVALID_INPUT', message: 'symbol query parameter is required' });
  }
  const exchange = String(req.query.exchange || 'NSE').toUpperCase();
  const instrument = `${exchange}:${symbol}`;

  const accessToken = await requireToken();
  const raw = await kiteRequest('GET', '/quote/ltp', { query: { i: instrument }, accessToken });
  const data = unwrapKite(raw);
  const entry = data[instrument];
  if (!entry) {
    return res.status(404).json({ code: 'SYMBOL_NOT_FOUND', message: `No quote for ${instrument}` });
  }
  res.json({
    symbol,
    exchange,
    instrumentToken: entry.instrument_token,
    lastPrice: entry.last_price,
    fetchedAt: new Date().toISOString(),
  });
}));

// --- Orders -----------------------------------------------------------------

const PRODUCTS = new Set(['MIS', 'CNC', 'NRML']);
const ORDER_TYPES = new Set(['LIMIT', 'MARKET', 'SL', 'SL-M']);
const VALIDITIES = new Set(['DAY', 'IOC']);
const SIDES = new Set(['BUY', 'SELL']);

function validateOrder(b) {
  const errors = [];
  const symbol = String(b.symbol || b.tradingsymbol || '').trim().toUpperCase();
  const exchange = String(b.exchange || 'NSE').toUpperCase();
  const side = String(b.side || b.transaction_type || '').toUpperCase();
  const product = String(b.product || 'MIS').toUpperCase();
  const orderType = String(b.orderType || b.order_type || 'MARKET').toUpperCase();
  const validity = String(b.validity || 'DAY').toUpperCase();
  const quantity = Number(b.quantity);
  const price = b.price === undefined || b.price === null || b.price === '' ? null : Number(b.price);

  if (!symbol) errors.push('symbol is required');
  if (!SIDES.has(side)) errors.push('side must be BUY or SELL');
  if (!PRODUCTS.has(product)) errors.push('product must be one of MIS, CNC, NRML');
  if (!ORDER_TYPES.has(orderType)) errors.push('orderType must be one of LIMIT, MARKET, SL, SL-M');
  if (!VALIDITIES.has(validity)) errors.push('validity must be DAY or IOC');
  if (!Number.isInteger(quantity) || quantity <= 0) errors.push('quantity must be a positive integer');
  if (orderType === 'LIMIT' && (price === null || !(price > 0))) errors.push('price is required for a LIMIT order');
  if (orderType === 'MARKET' && price !== null) errors.push('price must be omitted for a MARKET order');

  return { errors, order: { symbol, exchange, side, product, orderType, validity, quantity, price } };
}

app.post('/api/orders', asyncRoute(async (req, res) => {
  const { errors, order } = validateOrder(req.body || {});
  if (errors.length) {
    return res.status(400).json({ code: 'INVALID_ORDER', message: 'Order validation failed', errors });
  }

  const accessToken = await requireToken();
  const raw = await kiteRequest('POST', '/orders/regular', {
    accessToken,
    form: {
      tradingsymbol: order.symbol,
      exchange: order.exchange,
      transaction_type: order.side,
      order_type: order.orderType,
      quantity: order.quantity,
      product: order.product,
      validity: order.validity,
      price: order.orderType === 'LIMIT' ? order.price : undefined,
    },
  });
  const data = unwrapKite(raw);

  log('INFO', `Order placed ${order.side} ${order.quantity} ${order.symbol} -> ${data.order_id}`);
  res.status(201).json({ orderId: data.order_id, ...order, submittedAt: new Date().toISOString() });
}));

app.get('/api/orders/:orderId/status', asyncRoute(async (req, res) => {
  const accessToken = await requireToken();
  const raw = await kiteRequest('GET', `/orders/${encodeURIComponent(req.params.orderId)}`, { accessToken });
  const history = unwrapKite(raw);
  if (!Array.isArray(history) || !history.length) {
    return res.status(404).json({ code: 'ORDER_NOT_FOUND', message: 'No history for this order id' });
  }
  const latest = history[history.length - 1];
  res.json({
    orderId: latest.order_id,
    status: latest.status,
    statusMessage: latest.status_message,
    symbol: latest.tradingsymbol,
    side: latest.transaction_type,
    quantity: latest.quantity,
    filledQuantity: latest.filled_quantity,
    pendingQuantity: latest.pending_quantity,
    averagePrice: latest.average_price,
    price: latest.price,
    orderTimestamp: latest.order_timestamp,
    history,
  });
}));

app.get('/api/orders', asyncRoute(async (req, res) => {
  const accessToken = await requireToken();
  const data = unwrapKite(await kiteRequest('GET', '/orders', { accessToken }));
  res.json({
    count: data.length,
    orders: data.map((o) => ({
      orderId: o.order_id,
      status: o.status,
      symbol: o.tradingsymbol,
      side: o.transaction_type,
      quantity: o.quantity,
      filledQuantity: o.filled_quantity,
      averagePrice: o.average_price,
      orderTimestamp: o.order_timestamp,
    })),
  });
}));

// --- Static frontend --------------------------------------------------------

const CLIENT_DIR = path.join(__dirname, 'client', 'dist');
app.use(express.static(CLIENT_DIR));
app.get(/^\/(?!api\/|kite\/).*/, (req, res) => {
  res.sendFile(path.join(CLIENT_DIR, 'index.html'), (err) => {
    if (err) res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
  });
});

// --- Central error handler --------------------------------------------------

app.use((err, req, res, _next) => {
  const status = err.status || (err.code === 'UPSTREAM_UNREACHABLE' ? 502 : 500);
  if (status >= 500) log('ERROR', `${req.method} ${req.path} -> ${status}: ${err.message}`);

  const payload = { code: err.code || 'INTERNAL_ERROR', message: err.message || 'Unexpected error' };
  if (err.loginUrl) payload.loginUrl = err.loginUrl;
  res.status(status).json(payload);
});

// ---------------------------------------------------------------------------
// Regulatory session sweeper — probes /user/profile every 15 minutes
// ---------------------------------------------------------------------------

let sweepTimer = null;

async function sweepSession() {
  try {
    const row = await loadToken();
    if (!row || !row.access_token) return;

    // Fast path: the token predates the most recent 06:00 IST boundary.
    const lastReset = new Date(nextIstResetInstant().getTime() - 24 * 60 * 60 * 1000);
    if (new Date(row.login_time).getTime() < lastReset.getTime()) {
      await clearToken('login_time precedes the last 06:00 IST reset');
      return;
    }

    const raw = await kiteRequest('GET', '/user/profile', { accessToken: row.access_token, retries: 1 });
    if (raw.body && raw.body.error_type === 'TokenException') {
      await clearToken('Kite returned TokenException on /user/profile');
      return;
    }
    if (raw.status >= 200 && raw.status < 300) log('INFO', 'Session sweep: token healthy');
  } catch (err) {
    // A network blip must never nuke a valid session.
    log('WARN', `Session sweep skipped: ${err.message}`);
  }
}

function startSweeper() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = setInterval(sweepSession, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  setTimeout(sweepSession, 10000).unref?.();
  log('INFO', `Session sweeper started (every ${SWEEP_INTERVAL_MS / 60000} min)`);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  try {
    await initDb();
    await loadToken();
  } catch (err) {
    log('ERROR', `Database init failed: ${err.message}`);
  }

  startSweeper();

  const server = app.listen(PORT, '0.0.0.0', () => {
    log('INFO', `Server listening on :${PORT}`);
    log('INFO', `AlgoIP egress: ${ALGOIP_HOST ? `${ALGOIP_HOST}:${ALGOIP_PORT}` : 'DIRECT (not configured)'}`);
    log('INFO', `Expected whitelisted IP: ${ALGOIP_EXPECTED_IP || '(unset)'}`);
  });

  const shutdown = async (signal) => {
    log('INFO', `${signal} received, shutting down`);
    if (sweepTimer) clearInterval(sweepTimer);
    server.close();
    try { await dispatcher.close(); } catch (_) { /* noop */ }
    if (pool) await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (r) => log('ERROR', 'Unhandled rejection', r));

main();

module.exports = app;
