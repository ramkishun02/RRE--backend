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
const fs = require('fs');
const net = require('net');
const dns = require('dns').promises;
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
const ALGOIP_PORT = process.env.ALGOIP_ID || '';
const ALGOIP_USER = process.env.ALGOIP_NODE || '';
const ALGOIP_PASSWORD = process.env.ALGOIP_PASSWORD || '';
const ALGOIP_EXPECTED_IP = process.env.ALGOIP_PI || '';
// Optional override: "http" or "https". If unset we infer from the port —
// 443/8443 imply the CONNECT hop itself is TLS-wrapped.
const ALGOIP_PROTOCOL = (process.env.ALGOIP_PROTOCOL || '').replace(/[:/]/g, '').toLowerCase();

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
  connectTimeout: 8000,
  headersTimeout: 20000,
  bodyTimeout: 20000,
};

// Per-attempt wall-clock ceiling. undici's connectTimeout applies PER RESOLVED
// ADDRESS, so a hostname with several A/AAAA records can stack up to ~95s of
// connect attempts — long enough for Render's edge to time out the request
// first. An AbortSignal caps the whole attempt regardless of DNS fan-out.
const ATTEMPT_DEADLINE_MS = Number(process.env.REQUEST_DEADLINE_MS || 12000);
const PROBE_DEADLINE_MS = Number(process.env.PROBE_DEADLINE_MS || 10000);

// The OAuth exchange gets a longer ceiling on purpose: a Kite request_token is
// SINGLE-USE and short-lived, so timing out mid-exchange burns it permanently
// and the user has to restart the whole login. Better to wait than to lose it.
const OAUTH_DEADLINE_MS = Number(process.env.OAUTH_DEADLINE_MS || 28000);

/**
 * BUGFIX: this used to hardcode `http://host:port`. With ALGOIP_PORT=443 the
 * proxy's CONNECT listener is TLS-wrapped, so plaintext HTTP to it is answered
 * with a dead socket — surfacing as PROXY UNREACHABLE on /api/proxy-check and
 * as "Token exchange failed" in /kite/callback (same dispatcher, same cause).
 *
 * Scheme resolution order: explicit scheme in ALGOIP_HOST > ALGOIP_PROTOCOL >
 * inferred from the port (443/8443 => https).
 */
function inferProxyScheme() {
  if (ALGOIP_PROTOCOL === 'http' || ALGOIP_PROTOCOL === 'https') return ALGOIP_PROTOCOL;
  return String(ALGOIP_PORT) === '443' || String(ALGOIP_PORT) === '8443' ? 'https' : 'http';
}

// The scheme actually in use. Starts as the inferred/configured one and can
// self-negotiate to the other exactly once (see maybeFlipScheme) — AlgoIP
// endpoints on :443 are inconsistent about whether the CONNECT hop is
// TLS-wrapped, and guessing wrong costs the whole OAuth round-trip.
let activeScheme = null;
let schemeLatched = Boolean(ALGOIP_PROTOCOL); // explicit config is never overridden
let schemeFlipTried = false;

/** Build the proxy URI, tolerating a host that already carries a scheme/port. */
function proxyUri(schemeOverride) {
  if (!ALGOIP_HOST) return null;
  const scheme = schemeOverride || activeScheme || inferProxyScheme();

  // Host supplied as a full URL — trust it, only append a port if absent.
  if (/^https?:\/\//i.test(ALGOIP_HOST)) {
    const u = new URL(ALGOIP_HOST);
    if (schemeOverride) u.protocol = `${schemeOverride}:`;
    if (!u.port && ALGOIP_PORT) u.port = String(ALGOIP_PORT);
    return u.origin;
  }

  const port = ALGOIP_PORT || (scheme === 'https' ? '443' : '80');
  return `${scheme}://${ALGOIP_HOST.replace(/\/+$/, '')}:${port}`;
}

function proxyAuthToken() {
  if (!ALGOIP_USER && !ALGOIP_PASSWORD) return undefined;
  return 'Basic ' + Buffer.from(`${ALGOIP_USER}:${ALGOIP_PASSWORD}`).toString('base64');
}

/** Unwraps undici's nested `cause` chain — otherwise the message is often ''. */
function errDetail(err) {
  const parts = [];
  let e = err;
  for (let i = 0; e && i < 5; i++) {
    const bit = [e.code, e.message].filter(Boolean).join(' ');
    if (bit && !parts.includes(bit)) parts.push(bit);
    e = e.cause;
  }
  return parts.join(' <- ') || 'unknown error (no code or message on the exception)';
}

/**
 * A CONNECT rejection is NOT the same as an unreachable proxy: undici reports
 * `Proxy response (401) !== 200 when HTTP Tunneling`, which proves the TLS
 * handshake and the proxy dialogue both succeeded and only auth/ACL failed.
 * Distinguishing the two is the difference between "fix your host" and
 * "fix your password".
 */
function classifyTunnelError(err) {
  const m = /Proxy response \((\d{3})\)/.exec(errDetail(err));
  if (!m) return null;
  const status = Number(m[1]);
  if (status === 401 || status === 407) {
    return {
      code: 'PROXY_AUTH_FAILED',
      status,
      message: `The AlgoIP proxy rejected the credentials (CONNECT returned ${status}).`,
      hint: 'The host and port are correct and TLS negotiated fine — only ALGOIP_USER / ALGOIP_PASSWORD are wrong. Re-copy them from the AlgoIP panel; a trailing space or newline in the Render env var is the usual culprit.',
    };
  }
  if (status === 403) {
    return {
      code: 'PROXY_FORBIDDEN',
      status,
      message: `The AlgoIP proxy refused the tunnel (CONNECT returned ${status}).`,
      hint: 'Reached the proxy, but it declined. Either the credentials lack permission for this destination, or this Render egress IP is not authorised to use the proxy. Check the AlgoIP panel for a source-IP allowlist.',
    };
  }
  return {
    code: 'PROXY_TUNNEL_REFUSED',
    status,
    message: `The AlgoIP proxy refused the CONNECT tunnel with HTTP ${status}.`,
    hint: 'The proxy is reachable but would not open the tunnel. Check the AlgoIP dashboard for account or quota status.',
  };
}

function makeProxyAgent(uri) {
  const host = (() => {
    try { return new URL(uri).hostname; } catch (_) { return undefined; }
  })();
  return new ProxyAgent({
    uri,
    token: proxyAuthToken(),
    ...DISPATCHER_OPTS,
    // TLS to the proxy itself (needed when the CONNECT hop is https).
    proxyTls: { timeout: 15000, servername: host },
    // TLS to the origin, inside the tunnel.
    requestTls: { timeout: 15000 },
  });
}

function buildDispatcher() {
  if (!activeScheme) activeScheme = inferProxyScheme();
  const uri = proxyUri();
  if (!uri) {
    log('WARN', 'AlgoIP proxy not configured — using DIRECT egress (Kite will reject non-whitelisted IPs)');
    return new Agent(DISPATCHER_OPTS);
  }
  log('INFO', `AlgoIP dispatcher -> ${uri}${proxyAuthToken() ? ' (authenticated)' : ' (no credentials)'}`);
  return makeProxyAgent(uri);
}

/**
 * Is this error plausibly a WRONG-SCHEME error?
 *
 * A scheme mismatch produces a TLS/protocol complaint or an immediate reset:
 * the peer answered, it just spoke a different language. A silent ETIMEDOUT is
 * the opposite — nothing answered at all, which means dropped packets (firewall
 * or source-IP allowlist), and no amount of scheme flipping will help. Flipping
 * on a timeout is actively harmful: it doubles the wait and blames the scheme
 * for what is really an allowlist problem.
 */
function isSchemeSuspect(err) {
  const d = errDetail(err);
  if (/ETIMEDOUT|Connect Timeout|DEADLINE_EXCEEDED|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(d)) return false;
  return /EPROTO|ERR_SSL|SSL routines|wrong version number|packet length too long|record layer|ECONNRESET|socket hang up|other side closed|UND_ERR_SOCKET/i.test(
    d
  );
}

/**
 * Self-negotiate the CONNECT scheme, once. A CONNECT rejection (401/403) means
 * the scheme was RIGHT and only auth/ACL failed. A timeout means nothing
 * answered. Only a genuine protocol mismatch justifies a flip.
 * Returns true if a flip happened.
 */
async function maybeFlipScheme(err) {
  if (schemeLatched || schemeFlipTried) return false;
  if (!proxyUri()) return false;
  if (classifyTunnelError(err)) return false; // proxy answered — scheme is fine

  if (!isSchemeSuspect(err)) {
    if (/ETIMEDOUT|Connect Timeout|DEADLINE_EXCEEDED/i.test(errDetail(err))) {
      log(
        'WARN',
        `CONNECT to ${proxyUri()} timed out with no response — NOT a scheme problem. ` +
          'Packets are being dropped, which means the proxy is not allowlisting this server. ' +
          'Open /api/diagnostics to see the egress IP to allowlist at AlgoIP.'
      );
    }
    return false;
  }

  schemeFlipTried = true;
  const from = activeScheme;
  activeScheme = from === 'https' ? 'http' : 'https';
  log('WARN', `CONNECT failed over ${from.toUpperCase()} with a protocol error (${errDetail(err)}) — retrying over ${activeScheme.toUpperCase()}`);

  const old = dispatcher;
  dispatcher = buildDispatcher();
  try { old.destroy(); } catch (_) { /* noop */ }
  return true;
}

let dispatcher = buildDispatcher();

/** Tear down the poisoned pool and build a clean one (used by the retry path). */
async function recycleDispatcher(reason) {
  log('WARN', `Recycling AlgoIP dispatcher: ${reason}`);
  const old = dispatcher;
  dispatcher = buildDispatcher();
  // destroy() is immediate; close() would await a stalled socket.
  try { old.destroy(); } catch (_) { /* noop */ }
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
  'DEADLINE_EXCEEDED',
]);

function isTransient(err) {
  if (!err) return false;
  // A CONNECT rejection is a config problem, not a blip — never retry it.
  if (classifyTunnelError(err)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const code = err.code || (err.cause && err.cause.code);
  if (code && TRANSIENT_CODES.has(code)) return true;
  const msg = String(err.message || '');
  return /fetch failed|other side closed|socket hang up|terminated|timeout/i.test(msg);
}

/**
 * Single funnel for every Kite HTTP call.
 * Retries transient socket failures on a freshly built dispatcher.
 */
async function kiteRequest(
  method,
  urlPath,
  { query, form, accessToken, retries = 2, deadlineMs, budgetMs } = {}
) {
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
  // budgetMs caps the WHOLE sequence (attempts + backoff + scheme flip). A
  // per-attempt deadline alone still stacks: 3 attempts x 12s + a flip
  // overshot Render's edge timeout on a blackholed proxy.
  const startedAll = Date.now();
  const remainingBudget = () => (budgetMs ? budgetMs - (Date.now() - startedAll) : Infinity);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const left = remainingBudget();
    if (left <= 250) {
      if (!lastErr) {
        lastErr = new Error(`request budget of ${budgetMs}ms exhausted`);
        lastErr.code = 'DEADLINE_EXCEEDED';
      }
      break;
    }
    const attemptMs = Math.min(deadlineMs || ATTEMPT_DEADLINE_MS, left);

    try {
      // withDeadline as well as the signal: undici does NOT honour an
      // AbortSignal while a CONNECT is stalled mid-handshake, so connectTimeout
      // (per resolved address) would otherwise dominate and blow the budget.
      const run = (async () => {
        const res = await request(url, {
          method,
          headers,
          body,
          dispatcher,
          signal: AbortSignal.timeout(attemptMs),
        });
        return { status: res.statusCode, text: await res.body.text() };
      })();
      const got = await withDeadline(run, attemptMs + 500, 'kite request');

      let parsed = null;
      try { parsed = got.text ? JSON.parse(got.text) : null; } catch (_) { parsed = { raw: got.text }; }
      // A completed round trip proves the scheme — stop second-guessing it.
      if (!schemeLatched && proxyUri()) {
        schemeLatched = true;
        log('INFO', `AlgoIP CONNECT scheme latched to ${activeScheme.toUpperCase()}`);
      }
      return { status: got.status, body: parsed, text: got.text };
    } catch (err) {
      lastErr = err;
      if (remainingBudget() <= 250) break;

      // Wrong CONNECT scheme? Flip once and retry immediately (no backoff).
      if (attempt < retries && (await maybeFlipScheme(err))) continue;

      if (attempt < retries && isTransient(err)) {
        await recycleDispatcher(err.code || err.message);
        const backoff = Math.min(250 * (attempt + 1), Math.max(0, remainingBudget() - 250));
        if (backoff > 0) await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      break;
    }
  }

  const wrapped = new Error(`Upstream request failed: ${errDetail(lastErr)}`);
  wrapped.code = 'UPSTREAM_UNREACHABLE';
  wrapped.detail = errDetail(lastErr);
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

function sendPage(res, statusCode, title, message, redirectTo, links) {
  const code = Number.isInteger(statusCode) ? statusCode : 500;
  const ok = code < 400;
  const redirectMeta = redirectTo
    ? `<meta http-equiv="refresh" content="2;url=${escapeHtml(redirectTo)}">`
    : '';
  const linkList = (links && links.length ? links : [{ href: redirectTo || '/dashboard', label: 'Continue &rarr;' }])
    .map((l) => `<a href="${escapeHtml(l.href)}">${l.label}</a>`)
    .join('');

  res.status(code).type('html').send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>${redirectMeta}
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;
       color:#e2e8f0;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:20px}
  .card{max-width:560px;padding:36px 40px;border:1px solid #1e293b;border-radius:14px;
        background:#111c33;box-shadow:0 24px 60px rgba(0,0,0,.45)}
  h1{margin:0 0 10px;font-size:19px;letter-spacing:-.01em;color:${ok ? '#4ade80' : '#f87171'}}
  p{margin:0;color:#94a3b8}
  code{color:#7dd3fc;font-family:ui-monospace,Menlo,monospace}
  .acts{margin-top:24px;display:flex;flex-wrap:wrap;gap:18px}
  a{color:#38bdf8;text-decoration:none;font-weight:600}
  a:hover{text-decoration:underline}
</style></head>
<body><div class="card">
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <div class="acts">${linkList}</div>
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
    proxyConfigured: Boolean(proxyUri()),
    proxyUri: proxyUri(),
    dbConfigured: Boolean(pool),
    kiteConfigured: Boolean(KITE_API_KEY && KITE_API_SECRET),
  });
});

// --- Low-level reachability probes ------------------------------------------
//
// ETIMEDOUT on a CONNECT is ambiguous from inside undici: it cannot tell you
// whether DNS was wrong, the TCP handshake was silently dropped (firewall /
// source-IP allowlist), or the proxy accepted the socket and then stalled.
// These probes separate those cases so the answer is not guesswork.

/** Raw TCP handshake, no TLS, no HTTP. Distinguishes DROPPED from REFUSED. */
function tcpProbe(host, port, ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, ms: Date.now() - started });
    };
    socket.setTimeout(ms);
    socket.once('connect', () => done({ reachable: true, verdict: 'TCP handshake completed' }));
    socket.once('timeout', () =>
      done({
        reachable: false,
        code: 'ETIMEDOUT',
        verdict:
          'No response at all — SYN packets are being dropped. This is a firewall or source-IP allowlist, not a wrong password.',
      })
    );
    socket.once('error', (err) =>
      done({
        reachable: false,
        code: err.code || 'ERR',
        verdict:
          err.code === 'ECONNREFUSED'
            ? 'Host reachable but nothing is listening on that port — check ALGOIP_PORT.'
            : err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN'
              ? 'Hostname does not resolve — check ALGOIP_HOST spelling.'
              : `Socket error: ${err.code || err.message}`,
      })
    );
    socket.connect(Number(port), host);
  });
}

/** Direct (non-proxied) egress IP — the address AlgoIP must allowlist. */
async function directEgressIp() {
  const agent = new Agent({ ...DISPATCHER_OPTS, connections: 2 });
  try {
    const r = await withDeadline(
      request('https://api.ipify.org?format=json', {
        dispatcher: agent,
        method: 'GET',
        signal: AbortSignal.timeout(PROBE_DEADLINE_MS),
      }).then(async (res) => JSON.parse(await res.body.text()).ip),
      PROBE_DEADLINE_MS + 1500,
      'direct egress probe'
    );
    return { ip: r, error: null };
  } catch (err) {
    return { ip: null, error: errDetail(err) };
  } finally {
    try { agent.destroy(); } catch (_) { /* noop */ }
  }
}

/**
 * GET /api/diagnostics
 * The endpoint to reach for when /kite/callback reports ETIMEDOUT. Answers, in
 * order: does the name resolve, does raw TCP connect, does the tunnel work, and
 * what IP does this server actually egress from.
 */
app.get('/api/diagnostics', asyncRoute(async (req, res) => {
  const uri = proxyUri();
  const out = {
    proxyConfigured: Boolean(uri),
    proxyUri: uri,
    scheme: uri ? new URL(uri).protocol.replace(':', '') : null,
    credentialsSupplied: Boolean(proxyAuthToken()),
    dns: null,
    tcp: null,
    tunnel: null,
    directEgressIp: null,
    expectedIp: ALGOIP_EXPECTED_IP || null,
    hints: [],
  };

  // 1. What IP does Render actually leave from? This is what to allowlist.
  const direct = await directEgressIp();
  out.directEgressIp = direct.ip;
  if (direct.error) out.hints.push(`Could not determine this server's own egress IP: ${direct.error}`);

  if (!uri) {
    out.hints.push('ALGOIP_HOST is not set, so nothing is proxied and Zerodha will reject this IP.');
    return res.json(out);
  }

  // URL.port is '' when the port equals the scheme default (443 for https,
  // 80 for http) — so never read it bare, or a :443 proxy gets probed on port 0.
  const parsed = new URL(uri);
  const hostname = parsed.hostname;
  const port = parsed.port || ALGOIP_PORT || (parsed.protocol === 'https:' ? '443' : '80');

  // 2. DNS
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    out.dns = { resolved: true, addresses: addrs.map((a) => `${a.address} (IPv${a.family})`) };
    if (addrs.length > 1) {
      out.hints.push(
        `${hostname} resolves to ${addrs.length} addresses; undici applies its connect timeout to each one, which is why a bad proxy used to hang for ~95s.`
      );
    }
  } catch (err) {
    out.dns = { resolved: false, error: err.code || err.message };
    out.hints.push(`ALGOIP_HOST does not resolve (${err.code}). Check the spelling.`);
    return res.json(out);
  }

  // 3. Raw TCP — the decisive test for ETIMEDOUT
  out.tcp = await tcpProbe(hostname, port, PROBE_DEADLINE_MS);
  if (!out.tcp.reachable) {
    if (out.tcp.code === 'ETIMEDOUT') {
      out.hints.push(
        `TCP to ${hostname}:${port} timed out with no response. Your credentials are NOT the problem — the connection never got far enough to send them. AlgoIP is dropping traffic from this server. Add this server's egress IP (${out.directEgressIp || 'see directEgressIp above'}) to the allowlist in the AlgoIP panel. On Render, outbound IPs are listed under your service's Connect / Outbound settings and there are usually several — add them all.`
      );
    }
    out.hints.push('Because raw TCP failed, no tunnel test was attempted.');
    return res.json(out);
  }

  // 4. Full tunnel through the configured proxy
  try {
    const { ip, latencyMs } = await probeEgress(dispatcher);
    out.tunnel = { ok: true, egressIp: ip, latencyMs };
    if (ALGOIP_EXPECTED_IP && ip !== ALGOIP_EXPECTED_IP) {
      out.hints.push(
        `The tunnel works but egresses from ${ip}, not the expected ${ALGOIP_EXPECTED_IP}. Update ALGOIP_EXPECTED_IP, or the whitelist in the Kite console, so the two agree.`
      );
    } else if (ip === ALGOIP_EXPECTED_IP) {
      out.hints.push('Everything checks out — tunnel works and egress matches the whitelisted address.');
    } else {
      out.hints.push(`Tunnel works, egressing from ${ip}. Set ALGOIP_EXPECTED_IP=${ip} and whitelist it in the Kite console.`);
    }
  } catch (err) {
    const tunnel = classifyTunnelError(err);
    out.tunnel = { ok: false, error: errDetail(err), classified: tunnel ? tunnel.code : null };
    out.hints.push(
      tunnel
        ? `${tunnel.message} ${tunnel.hint}`
        : `Raw TCP succeeded but the CONNECT tunnel did not complete: ${errDetail(err)}. This usually means the wrong scheme — try ALGOIP_PROTOCOL=${out.scheme === 'https' ? 'http' : 'https'}.`
    );
  }

  res.json(out);
}));

/**
 * GET /api/proxy-check
 * Confirms outbound traffic egresses from the whitelisted AlgoIP address.
 *
 * If the configured scheme fails, we probe the OTHER scheme too and report
 * which one works — an http/https mismatch on the CONNECT hop is the single
 * most common AlgoIP misconfiguration and is otherwise invisible.
 */
/**
 * Hard wall-clock ceiling. Belt-and-braces over AbortSignal: undici does not
 * reliably abort a CONNECT that is stalled mid-handshake, so a stuck proxy can
 * otherwise hold the response open past Render's edge timeout.
 */
function withDeadline(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} exceeded ${ms}ms`);
      e.code = 'DEADLINE_EXCEEDED';
      reject(e);
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function probeEgress(agent) {
  const started = Date.now();
  const run = (async () => {
    const r = await request('https://api.ipify.org?format=json', {
      dispatcher: agent,
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_DEADLINE_MS),
    });
    return JSON.parse(await r.body.text()).ip;
  })();
  const ip = await withDeadline(run, PROBE_DEADLINE_MS + 1500, 'egress probe');
  return { ip, latencyMs: Date.now() - started };
}

app.get('/api/proxy-check', asyncRoute(async (req, res) => {
  const configuredUri = proxyUri();

  // No proxy configured — report direct egress.
  if (!configuredUri) {
    try {
      const { ip, latencyMs } = await probeEgress(dispatcher);
      return res.json({
        egressIp: ip,
        expectedIp: ALGOIP_EXPECTED_IP || null,
        matches: ALGOIP_EXPECTED_IP ? ip === ALGOIP_EXPECTED_IP : null,
        proxyConfigured: false,
        proxyUri: null,
        scheme: null,
        latencyMs,
        hint: 'ALGOIP_HOST is not set, so traffic egresses directly from Render. Zerodha will reject this IP.',
      });
    } catch (err) {
      return res.status(502).json({
        code: 'DIRECT_EGRESS_FAILED',
        message: errDetail(err),
        proxyConfigured: false,
      });
    }
  }

  const primaryScheme = new URL(configuredUri).protocol.replace(':', '');
  const altScheme = primaryScheme === 'https' ? 'http' : 'https';
  const altUri = proxyUri(altScheme);

  // Attempt 1: the configured scheme.
  try {
    const { ip, latencyMs } = await probeEgress(dispatcher);
    const matches = ALGOIP_EXPECTED_IP ? ip === ALGOIP_EXPECTED_IP : null;
    return res.status(matches === false ? 409 : 200).json({
      egressIp: ip,
      expectedIp: ALGOIP_EXPECTED_IP || null,
      matches,
      proxyConfigured: true,
      proxyUri: configuredUri,
      scheme: primaryScheme,
      latencyMs,
      hint:
        matches === false
          ? 'Traffic is tunnelling correctly, but this egress IP is not the one you whitelisted. Update App Settings in the Kite console.'
          : matches === null
            ? 'Set ALGOIP_EXPECTED_IP so this endpoint can assert the whitelisted address.'
            : 'Egress matches the whitelisted address.',
    });
  } catch (primaryErr) {
    // A CONNECT rejection means the proxy WAS reached — do not probe the
    // alternate scheme, and do not tell the user their host is wrong.
    const tunnel = classifyTunnelError(primaryErr);
    if (tunnel) {
      return res.status(502).json({
        code: tunnel.code,
        message: tunnel.message,
        proxyReached: true,
        connectStatus: tunnel.status,
        proxyConfigured: true,
        proxyUri: configuredUri,
        scheme: primaryScheme,
        credentialsSupplied: Boolean(proxyAuthToken()),
        detail: errDetail(primaryErr),
        hint: tunnel.hint,
      });
    }

    // A timeout means nothing answered — probing the other scheme just doubles
    // the wait and points the blame in the wrong direction. Answer immediately.
    if (!isSchemeSuspect(primaryErr)) {
      const timedOut = /ETIMEDOUT|Connect Timeout|DEADLINE_EXCEEDED/i.test(errDetail(primaryErr));
      return res.status(502).json({
        code: timedOut ? 'PROXY_PACKETS_DROPPED' : 'PROXY_UNREACHABLE',
        message: errDetail(primaryErr),
        proxyReached: false,
        proxyConfigured: true,
        proxyUri: configuredUri,
        scheme: primaryScheme,
        schemeProbed: false,
        credentialsSupplied: Boolean(proxyAuthToken()),
        hint: timedOut
          ? 'The connection timed out with NO response, so this is neither a scheme nor a credentials problem — the proxy never answered. Your packets are being dropped, which almost always means AlgoIP is not allowlisting this server. Open /api/diagnostics to see the exact egress IP to add to the AlgoIP panel (Render has several outbound IPs — add them all).'
          : 'The proxy could not be reached and the failure is not a protocol mismatch. Check ALGOIP_HOST and ALGOIP_PORT. Open /api/diagnostics for a DNS and raw-TCP breakdown.',
      });
    }

    // Attempt 2: the opposite scheme, on a throwaway agent.
    let altAgent = null;
    try {
      altAgent = makeProxyAgent(altUri);
      const { ip, latencyMs } = await probeEgress(altAgent);
      return res.status(409).json({
        code: 'PROXY_SCHEME_MISMATCH',
        message: `The proxy is reachable over ${altScheme.toUpperCase()}, not ${primaryScheme.toUpperCase()}.`,
        egressIp: ip,
        expectedIp: ALGOIP_EXPECTED_IP || null,
        matches: ALGOIP_EXPECTED_IP ? ip === ALGOIP_EXPECTED_IP : null,
        proxyReached: true,
        proxyConfigured: true,
        proxyUri: configuredUri,
        workingProxyUri: altUri,
        scheme: primaryScheme,
        workingScheme: altScheme,
        latencyMs,
        hint: `Set ALGOIP_PROTOCOL=${altScheme} in Render and redeploy. Configured scheme failed with: ${errDetail(primaryErr)}`,
      });
    } catch (altErr) {
      const altTunnel = classifyTunnelError(altErr);
      if (altTunnel) {
        return res.status(502).json({
          code: altTunnel.code,
          message: `${altTunnel.message} (over ${altScheme.toUpperCase()})`,
          proxyReached: true,
          connectStatus: altTunnel.status,
          proxyConfigured: true,
          proxyUri: configuredUri,
          workingScheme: altScheme,
          credentialsSupplied: Boolean(proxyAuthToken()),
          detail: errDetail(altErr),
          hint: `${altTunnel.hint} Also set ALGOIP_PROTOCOL=${altScheme}, since ${primaryScheme.toUpperCase()} failed with: ${errDetail(primaryErr)}`,
        });
      }
      return res.status(502).json({
        code: 'PROXY_UNREACHABLE',
        message: errDetail(primaryErr),
        proxyReached: false,
        proxyConfigured: true,
        proxyUri: configuredUri,
        scheme: primaryScheme,
        triedAlternate: altUri,
        alternateError: errDetail(altErr),
        credentialsSupplied: Boolean(proxyAuthToken()),
        hint: /timeout|exceeded/i.test(errDetail(primaryErr))
          ? 'Both schemes timed out before the proxy answered — the TCP connection never completed. Either ALGOIP_HOST/ALGOIP_PORT is wrong, or AlgoIP is dropping traffic from this server\'s IP. AlgoIP panels commonly restrict which source addresses may use the proxy, so add your Render outbound IPs there. Repeated probes can also get you temporarily rate-limited, so wait a minute before retrying.'
          : 'Neither http nor https reached the proxy at all. Check ALGOIP_HOST/ALGOIP_PORT spelling and that AlgoIP allows connections from this Render region.',
      });
    } finally {
      // destroy(), not close(): close() waits for a stalled CONNECT to settle.
      if (altAgent) { try { altAgent.destroy(); } catch (_) { /* noop */ } }
    }
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
      // One retry only: a request_token is single-use, so hammering it is
      // pointless. budgetMs caps the entire sequence.
      retries: 1,
      deadlineMs: Math.min(14000, OAUTH_DEADLINE_MS),
      budgetMs: OAUTH_DEADLINE_MS,
    });
    session = unwrapKite(raw);
  } catch (err) {
    log('ERROR', 'Token exchange failed', errDetail(err));
    const code = err.status === 401 ? 401 : err.code === 'UPSTREAM_UNREACHABLE' ? 502 : (err.status || 502);
    const tunnel = classifyTunnelError(err);
    let hint = '';
    if (tunnel) {
      hint = ` — ${tunnel.message} ${tunnel.hint}`;
    } else if (/ETIMEDOUT|Connect Timeout|DEADLINE_EXCEEDED/i.test(errDetail(err))) {
      hint =
        ' — the AlgoIP proxy never answered. This is not a credentials or scheme problem: the connection timed out before anything was sent. Your packets are being dropped, which almost always means AlgoIP is not allowlisting this server. Run diagnostics below to get the exact egress IP to allowlist.';
    } else if (err.code === 'UPSTREAM_UNREACHABLE') {
      hint =
        ' — api.kite.trade was not reachable through the AlgoIP tunnel. Run diagnostics below to see whether DNS, TCP, the scheme or the credentials are at fault.';
    }
    return sendPage(
      res,
      code,
      'Token exchange failed',
      (err.message || 'Unknown error') + hint,
      null,
      [
        { href: '/api/diagnostics', label: 'Run diagnostics &rarr;' },
        { href: '/kite/login', label: 'Try login again' },
        { href: '/dashboard?kite=failed', label: 'Back to dashboard' },
      ]
    );
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

// --- Built-in dashboard markup ----------------------------------------------
// Self-contained: no build step, no CDN, no framework. Talks to this server's
// own /api endpoints. Written with string concatenation only (no nested
// template placeholders) so it survives being embedded in a template literal.

const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kite Terminal — AlgoIP Egress</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#0f172a;color:#e2e8f0;
       font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  a{color:#38bdf8}
  .wrap{max-width:1080px;margin:0 auto;padding:28px 20px 64px}
  header{display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin-bottom:26px}
  h1{margin:0;font-size:18px;font-weight:600;letter-spacing:-.01em}
  h1 span{color:#64748b;font-weight:400}
  .pill{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:999px;
        font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;
        border:1px solid #334155;background:#111c33;color:#94a3b8}
  .pill.ok{border-color:rgba(16,185,129,.35);background:rgba(16,185,129,.1);color:#6ee7b7}
  .pill.bad{border-color:rgba(244,63,94,.35);background:rgba(244,63,94,.1);color:#fda4af}
  .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
  .spacer{flex:1}
  .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
  .card{border:1px solid #1e293b;border-radius:12px;background:#111c33;padding:18px}
  .card h2{margin:0 0 14px;font-size:11px;font-weight:600;text-transform:uppercase;
           letter-spacing:.14em;color:#64748b}
  label{display:block;font-size:11px;color:#94a3b8;margin:0 0 5px}
  input,select{width:100%;padding:9px 11px;border-radius:8px;border:1px solid #334155;
       background:#0b1424;color:#e2e8f0;font-size:13px;font-family:inherit;outline:none;
       transition:border-color .18s ease}
  input:focus,select:focus{border-color:#38bdf8}
  button{padding:9px 15px;border-radius:8px;border:1px solid #334155;background:#1e293b;
         color:#e2e8f0;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer;
         transition:background-color .18s ease,border-color .18s ease,transform .12s ease}
  button:hover{background:#27364d;border-color:#475569}
  button:active{transform:translateY(1px)}
  button.primary{background:#0284c7;border-color:#0ea5e9;color:#fff}
  button.primary:hover{background:#0369a1}
  button.sell{background:#9f1239;border-color:#be123c;color:#fff}
  button.sell:hover{background:#881337}
  button:disabled{opacity:.5;cursor:not-allowed}
  .row{display:flex;gap:10px;align-items:flex-end}
  .row>*{flex:1}
  .row>.narrow{flex:0 0 96px}
  .fields{display:grid;gap:11px;grid-template-columns:1fr 1fr}
  .big{font-size:30px;font-weight:600;letter-spacing:-.02em;color:#fff}
  .muted{color:#64748b;font-size:12px}
  .out{margin-top:12px;padding:11px;border-radius:8px;background:#0b1424;border:1px solid #1e293b;
       font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:190px;overflow:auto}
  .ok{color:#6ee7b7}.bad{color:#fda4af}.warn{color:#fcd34d}
  ul.res{list-style:none;margin:12px 0 0;padding:0;max-height:200px;overflow:auto}
  ul.res li{padding:8px 10px;border-radius:7px;cursor:pointer;display:flex;gap:10px;
            align-items:baseline;transition:background-color .15s ease}
  ul.res li:hover{background:#1c2942}
  ul.res .sym{font-weight:600;font-size:13px}
  ul.res .nm{color:#64748b;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{text-align:left;color:#64748b;font-weight:500;padding:7px 8px;border-bottom:1px solid #1e293b;
     font-size:10px;text-transform:uppercase;letter-spacing:.08em}
  td{padding:8px;border-bottom:1px solid #16202f}
  .overlay{position:fixed;inset:0;background:rgba(2,6,16,.72);display:none;place-items:center;
           padding:20px;z-index:50}
  .overlay.show{display:grid}
  .modal{max-width:430px;width:100%;border:1px solid #1e293b;border-radius:14px;background:#111c33;
         padding:24px;box-shadow:0 30px 70px rgba(0,0,0,.5)}
  .modal h3{margin:0 0 12px;font-size:16px}
  .modal .acts{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}
  .kv{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #16202f;font-size:13px}
  .kv b{font-weight:600}
  .banner{margin-bottom:18px;padding:12px 14px;border-radius:10px;font-size:13px;
          border:1px solid rgba(252,211,77,.3);background:rgba(252,211,77,.08);color:#fcd34d;display:none}
  .banner.show{display:block}
</style></head>
<body><div class="wrap">

<header>
  <h1>Kite Terminal <span>/ AlgoIP egress</span></h1>
  <span id="pill" class="pill"><span class="dot"></span><span id="pillText">Checking…</span></span>
  <span class="spacer"></span>
  <a id="loginBtn" href="/kite/login"><button class="primary" data-testid="login-button">Connect Zerodha</button></a>
  <button id="logoutBtn" data-testid="logout-button" style="display:none">Log out</button>
</header>

<div id="banner" class="banner"></div>

<div class="grid">

  <div class="card">
    <h2>Token health</h2>
    <div class="big mono" id="countdown" data-testid="token-countdown">--:--:--</div>
    <div class="muted" id="tokenMeta" data-testid="token-meta">No active session</div>
    <div class="muted" style="margin-top:8px">Until the next 06:00 IST regulatory reset</div>
  </div>

  <div class="card">
    <h2>AlgoIP egress check</h2>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button id="proxyBtn" data-testid="proxy-check-button">Run /api/proxy-check</button>
      <button id="diagBtn" data-testid="diagnostics-button">Full diagnostics</button>
    </div>
    <div class="out mono" id="proxyOut" data-testid="proxy-check-output">Not run yet.</div>
  </div>

  <div class="card">
    <h2>Instrument search</h2>
    <div class="row">
      <div><label for="q">NSE symbol or name</label>
        <input id="q" data-testid="search-input" placeholder="INFY" autocomplete="off"></div>
      <div class="narrow"><button id="searchBtn" data-testid="search-button">Search</button></div>
    </div>
    <ul class="res" id="searchRes" data-testid="search-results"></ul>
  </div>

  <div class="card">
    <h2>Live quote</h2>
    <div class="row">
      <div><label for="qsym">Symbol</label>
        <input id="qsym" data-testid="quote-input" placeholder="INFY" autocomplete="off"></div>
      <div class="narrow"><button id="quoteBtn" data-testid="quote-button">Fetch</button></div>
    </div>
    <div class="big mono" id="ltp" data-testid="quote-ltp" style="margin-top:14px">—</div>
    <div class="muted" id="quoteMeta" data-testid="quote-meta"></div>
  </div>

  <div class="card" style="grid-column:1/-1">
    <h2>Order ticket</h2>
    <div class="fields">
      <div><label for="oSym">Symbol</label><input id="oSym" data-testid="order-symbol" placeholder="INFY"></div>
      <div><label for="oQty">Quantity</label><input id="oQty" data-testid="order-quantity" type="number" min="1" value="1"></div>
      <div><label for="oProduct">Product</label><select id="oProduct" data-testid="order-product">
        <option>MIS</option><option>CNC</option><option>NRML</option></select></div>
      <div><label for="oType">Order type</label><select id="oType" data-testid="order-type">
        <option>MARKET</option><option>LIMIT</option></select></div>
      <div><label for="oValidity">Validity</label><select id="oValidity" data-testid="order-validity">
        <option>DAY</option><option>IOC</option></select></div>
      <div><label for="oPrice">Price (LIMIT only)</label>
        <input id="oPrice" data-testid="order-price" type="number" step="0.05" placeholder="—" disabled></div>
    </div>
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="primary" id="buyBtn" data-testid="order-buy-button">Buy</button>
      <button class="sell" id="sellBtn" data-testid="order-sell-button">Sell</button>
    </div>
    <div class="out mono" id="orderOut" data-testid="order-output" style="display:none"></div>
  </div>

  <div class="card" style="grid-column:1/-1">
    <h2>Orders</h2>
    <div class="row" style="margin-bottom:14px">
      <div><label for="oid">Order id</label>
        <input id="oid" data-testid="order-status-input" placeholder="250101000000001"></div>
      <div class="narrow"><button id="statusBtn" data-testid="order-status-button">Status</button></div>
      <div class="narrow"><button id="refreshBtn" data-testid="orders-refresh-button">Refresh</button></div>
    </div>
    <table><thead><tr><th>Order id</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Status</th></tr></thead>
      <tbody id="ordersBody" data-testid="orders-body">
        <tr><td colspan="5" class="muted">No orders loaded.</td></tr></tbody></table>
    <div class="out mono" id="statusOut" data-testid="order-status-output" style="display:none"></div>
  </div>

</div>
</div>

<div class="overlay" id="overlay">
  <div class="modal">
    <h3 id="mTitle">Confirm order</h3>
    <div id="mBody"></div>
    <div class="acts">
      <button id="mCancel" data-testid="modal-cancel-button">Cancel</button>
      <button class="primary" id="mConfirm" data-testid="modal-confirm-button">Confirm</button>
    </div>
  </div>
</div>

<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var pendingOrder = null;

  function api(url, opts){
    return fetch(url, opts || {}).then(function(r){
      return r.text().then(function(t){
        var b = null; try { b = t ? JSON.parse(t) : null; } catch(e){ b = { raw: t }; }
        return { status: r.status, ok: r.ok, body: b };
      });
    });
  }
  function show(el, cls, text){
    el.style.display = 'block';
    el.className = 'out mono ' + (cls || '');
    el.textContent = text;
  }
  function banner(msg){
    var b = $('banner');
    if (!msg) { b.className = 'banner'; b.textContent = ''; return; }
    b.className = 'banner show';
    b.innerHTML = msg;
  }
  function handleAuth(res){
    if (res.status === 401 && res.body && res.body.code === 'KITE_SESSION_EXPIRED'){
      banner('Kite session expired or not established. <a href="/kite/login">Connect Zerodha</a> to continue.');
      return true;
    }
    return false;
  }

  // ---- session + countdown -------------------------------------------------
  var expiresAt = null;
  function pad(n){ return (n < 10 ? '0' : '') + n; }
  function tick(){
    if (!expiresAt){ $('countdown').textContent = '--:--:--'; return; }
    var s = Math.max(0, Math.floor((expiresAt - Date.now())/1000));
    var h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
    $('countdown').textContent = pad(h) + ':' + pad(m) + ':' + pad(s%60);
  }
  function loadSession(){
    return api('/api/session').then(function(res){
      var d = res.body || {};
      var pill = $('pill'), txt = $('pillText');
      if (d.connected){
        pill.className = 'pill ok';
        txt.textContent = 'Connected' + (d.userId ? ' · ' + d.userId : '');
        $('loginBtn').style.display = 'none';
        $('logoutBtn').style.display = '';
        $('tokenMeta').textContent = 'Login ' + (d.loginTime || '—') + (d.userName ? ' · ' + d.userName : '');
        expiresAt = d.expiresAt ? new Date(d.expiresAt).getTime() : null;
        banner('');
      } else {
        pill.className = 'pill bad';
        txt.textContent = 'Disconnected';
        $('loginBtn').style.display = '';
        $('logoutBtn').style.display = 'none';
        $('tokenMeta').textContent = 'No active session';
        expiresAt = d.expiresAt ? new Date(d.expiresAt).getTime() : null;
      }
      tick();
    }).catch(function(){
      $('pill').className = 'pill bad';
      $('pillText').textContent = 'Backend unreachable';
    });
  }
  $('logoutBtn').onclick = function(){
    api('/api/session/logout', { method: 'POST' }).then(loadSession);
  };

  // ---- proxy check ---------------------------------------------------------
  $('proxyBtn').onclick = function(){
    var out = $('proxyOut'); var btn = this;
    btn.disabled = true; show(out, '', 'Checking egress IP…');
    api('/api/proxy-check').then(function(res){
      var d = res.body || {};
      if (d.code === 'PROXY_SCHEME_MISMATCH'){
        show(out, 'warn', 'SCHEME MISMATCH\\n' + d.message +
          '\\n\\nconfigured ' + d.proxyUri + '\\nworking    ' + d.workingProxyUri +
          '\\negress ' + d.egressIp + '\\n\\n' + (d.hint || ''));
      } else if (d.code){
        var head = d.code.replace(/_/g, ' ');
        show(out, 'bad', head + '\\n' + (d.message || '') +
          (d.proxyUri ? '\\n\\nvia ' + d.proxyUri : '') +
          (d.connectStatus ? '\\nCONNECT returned ' + d.connectStatus + ' (proxy WAS reached)' : '') +
          (d.triedAlternate ? '\\nalso tried ' + d.triedAlternate + '\\n  ' + (d.alternateError || '') : '') +
          '\\ncredentials sent: ' + (d.credentialsSupplied ? 'yes' : 'NO') +
          (d.detail ? '\\n\\n' + d.detail : '') +
          '\\n\\n' + (d.hint || ''));
      } else if (d.matches === true){
        show(out, 'ok', 'MATCH\\negress ' + d.egressIp + '\\nexpected ' + d.expectedIp +
          '\\nvia ' + (d.proxyUri || 'direct') + '\\n' + d.latencyMs + 'ms');
      } else if (d.matches === false){
        show(out, 'bad', 'MISMATCH — Zerodha will reject\\negress ' + d.egressIp +
          '\\nexpected ' + d.expectedIp + '\\nvia ' + (d.proxyUri || 'direct') +
          '\\n\\n' + (d.hint || ''));
      } else {
        show(out, 'warn', 'egress ' + d.egressIp +
          '\\nvia ' + (d.proxyUri || 'DIRECT — no proxy configured') +
          '\\n\\n' + (d.hint || ''));
      }
    }).catch(function(e){ show(out, 'bad', 'Request failed: ' + e.message); })
      .then(function(){ btn.disabled = false; });
  };

  // ---- full diagnostics ----------------------------------------------------
  $('diagBtn').onclick = function(){
    var out = $('proxyOut'); var btn = this;
    btn.disabled = true; show(out, '', 'Running DNS, TCP and tunnel probes…');
    api('/api/diagnostics').then(function(res){
      var d = res.body || {};
      var L = [];
      L.push('THIS SERVER EGRESSES FROM: ' + (d.directEgressIp || 'unknown'));
      L.push('  (allowlist this in the AlgoIP panel)');
      L.push('');
      L.push('proxy      ' + (d.proxyUri || 'NOT CONFIGURED'));
      L.push('creds sent ' + (d.credentialsSupplied ? 'yes' : 'NO'));
      if (d.dns){
        L.push('dns        ' + (d.dns.resolved ? d.dns.addresses.join(', ') : 'FAILED ' + d.dns.error));
      }
      if (d.tcp){
        L.push('tcp        ' + (d.tcp.reachable ? 'OK in ' + d.tcp.ms + 'ms' : 'FAILED ' + d.tcp.code + ' after ' + d.tcp.ms + 'ms'));
        L.push('           ' + d.tcp.verdict);
      }
      if (d.tunnel){
        L.push('tunnel     ' + (d.tunnel.ok ? 'OK egress ' + d.tunnel.egressIp + ' in ' + d.tunnel.latencyMs + 'ms'
                                            : 'FAILED ' + (d.tunnel.classified || '') + ' ' + d.tunnel.error));
      }
      if (d.hints && d.hints.length){
        L.push('');
        d.hints.forEach(function(h){ L.push('* ' + h); });
      }
      var good = d.tunnel && d.tunnel.ok;
      show(out, good ? 'ok' : 'warn', L.join('\\n'));
    }).catch(function(e){ show(out, 'bad', 'Diagnostics failed: ' + e.message); })
      .then(function(){ btn.disabled = false; });
  };

  // ---- instrument search ---------------------------------------------------
  function doSearch(){
    var q = $('q').value.trim();
    var ul = $('searchRes');
    if (!q){ ul.innerHTML = ''; return; }
    ul.innerHTML = '<li class="muted">Searching…</li>';
    api('/api/stocks/search?q=' + encodeURIComponent(q) + '&limit=15').then(function(res){
      if (handleAuth(res)){ ul.innerHTML = '<li class="bad">Session expired</li>'; return; }
      var d = res.body || {};
      if (!d.results || !d.results.length){ ul.innerHTML = '<li class="muted">No matches.</li>'; return; }
      ul.innerHTML = '';
      d.results.forEach(function(r){
        var li = document.createElement('li');
        li.setAttribute('data-testid', 'search-result-' + r.tradingsymbol);
        var s = document.createElement('span'); s.className = 'sym mono'; s.textContent = r.tradingsymbol;
        var n = document.createElement('span'); n.className = 'nm'; n.textContent = r.name || '';
        li.appendChild(s); li.appendChild(n);
        li.onclick = function(){
          $('qsym').value = r.tradingsymbol;
          $('oSym').value = r.tradingsymbol;
          doQuote();
        };
        ul.appendChild(li);
      });
    }).catch(function(e){ ul.innerHTML = '<li class="bad">' + e.message + '</li>'; });
  }
  $('searchBtn').onclick = doSearch;
  $('q').addEventListener('keydown', function(e){ if (e.key === 'Enter') doSearch(); });

  // ---- quote ---------------------------------------------------------------
  function doQuote(){
    var sym = $('qsym').value.trim().toUpperCase();
    if (!sym) return;
    $('ltp').textContent = '…'; $('quoteMeta').textContent = '';
    api('/api/market/quote?symbol=' + encodeURIComponent(sym)).then(function(res){
      if (handleAuth(res)){ $('ltp').textContent = '—'; $('quoteMeta').textContent = 'Session expired'; return; }
      var d = res.body || {};
      if (!res.ok){ $('ltp').textContent = '—'; $('quoteMeta').textContent = d.message || ('HTTP ' + res.status); return; }
      $('ltp').textContent = '\\u20b9 ' + d.lastPrice;
      $('quoteMeta').textContent = d.exchange + ':' + d.symbol + ' · token ' + d.instrumentToken +
        ' · ' + new Date(d.fetchedAt).toLocaleTimeString();
    }).catch(function(e){ $('ltp').textContent = '—'; $('quoteMeta').textContent = e.message; });
  }
  $('quoteBtn').onclick = doQuote;
  $('qsym').addEventListener('keydown', function(e){ if (e.key === 'Enter') doQuote(); });

  // ---- order ticket --------------------------------------------------------
  $('oType').onchange = function(){
    var limit = this.value === 'LIMIT';
    $('oPrice').disabled = !limit;
    if (!limit) $('oPrice').value = '';
  };

  function buildOrder(side){
    return {
      symbol: $('oSym').value.trim().toUpperCase(),
      side: side,
      quantity: parseInt($('oQty').value, 10),
      product: $('oProduct').value,
      orderType: $('oType').value,
      validity: $('oValidity').value,
      price: $('oType').value === 'LIMIT' && $('oPrice').value ? parseFloat($('oPrice').value) : undefined
    };
  }
  function kv(k, v){
    return '<div class="kv"><span class="muted">' + k + '</span><b class="mono">' + v + '</b></div>';
  }
  function confirmOrder(side){
    var o = buildOrder(side);
    if (!o.symbol){ show($('orderOut'), 'bad', 'Symbol is required.'); return; }
    pendingOrder = o;
    $('mTitle').textContent = side + ' ' + o.symbol;
    $('mBody').innerHTML = kv('Symbol', o.symbol) + kv('Side', o.side) + kv('Quantity', o.quantity) +
      kv('Product', o.product) + kv('Type', o.orderType) + kv('Validity', o.validity) +
      (o.price ? kv('Price', o.price) : '');
    $('mConfirm').className = side === 'SELL' ? 'sell' : 'primary';
    $('overlay').className = 'overlay show';
  }
  $('buyBtn').onclick = function(){ confirmOrder('BUY'); };
  $('sellBtn').onclick = function(){ confirmOrder('SELL'); };
  $('mCancel').onclick = function(){ $('overlay').className = 'overlay'; pendingOrder = null; };
  $('mConfirm').onclick = function(){
    if (!pendingOrder) return;
    var btn = this; btn.disabled = true;
    api('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pendingOrder)
    }).then(function(res){
      $('overlay').className = 'overlay';
      btn.disabled = false;
      var d = res.body || {};
      if (handleAuth(res)){ show($('orderOut'), 'bad', 'Session expired — reconnect to place orders.'); return; }
      if (res.status === 201){
        show($('orderOut'), 'ok', 'ACCEPTED\\norderId ' + d.orderId + '\\n' +
          d.side + ' ' + d.quantity + ' ' + d.symbol + ' ' + d.orderType + '/' + d.product);
        $('oid').value = d.orderId;
        loadOrders();
      } else if (d.errors){
        show($('orderOut'), 'bad', 'REJECTED (validation)\\n- ' + d.errors.join('\\n- '));
      } else {
        show($('orderOut'), 'bad', 'REJECTED\\n' + (d.message || ('HTTP ' + res.status)));
      }
      pendingOrder = null;
    }).catch(function(e){
      $('overlay').className = 'overlay'; btn.disabled = false;
      show($('orderOut'), 'bad', e.message);
    });
  };

  // ---- orders --------------------------------------------------------------
  function loadOrders(){
    var body = $('ordersBody');
    api('/api/orders').then(function(res){
      if (handleAuth(res)){
        body.innerHTML = '<tr><td colspan="5" class="bad">Session expired.</td></tr>'; return;
      }
      var d = res.body || {};
      if (!d.orders || !d.orders.length){
        body.innerHTML = '<tr><td colspan="5" class="muted">No orders today.</td></tr>'; return;
      }
      body.innerHTML = '';
      d.orders.forEach(function(o){
        var tr = document.createElement('tr');
        tr.setAttribute('data-testid', 'order-row-' + o.orderId);
        tr.innerHTML = '<td class="mono">' + o.orderId + '</td><td class="mono">' + (o.symbol||'') +
          '</td><td>' + (o.side||'') + '</td><td>' + (o.quantity||0) + '</td><td>' + (o.status||'') + '</td>';
        tr.onclick = function(){ $('oid').value = o.orderId; doStatus(); };
        body.appendChild(tr);
      });
    }).catch(function(e){
      body.innerHTML = '<tr><td colspan="5" class="bad">' + e.message + '</td></tr>';
    });
  }
  function doStatus(){
    var id = $('oid').value.trim();
    if (!id) return;
    var out = $('statusOut');
    show(out, '', 'Loading…');
    api('/api/orders/' + encodeURIComponent(id) + '/status').then(function(res){
      if (handleAuth(res)){ show(out, 'bad', 'Session expired'); return; }
      var d = res.body || {};
      if (!res.ok){ show(out, 'bad', d.message || ('HTTP ' + res.status)); return; }
      show(out, d.status === 'COMPLETE' ? 'ok' : (d.status === 'REJECTED' ? 'bad' : 'warn'),
        d.status + '\\n' + d.side + ' ' + d.symbol +
        '\\nfilled ' + d.filledQuantity + '/' + d.quantity +
        '\\navg ' + d.averagePrice +
        (d.statusMessage ? '\\n' + d.statusMessage : ''));
    }).catch(function(e){ show(out, 'bad', e.message); });
  }
  $('statusBtn').onclick = doStatus;
  $('refreshBtn').onclick = loadOrders;

  // ---- boot ----------------------------------------------------------------
  loadSession();
  setInterval(tick, 1000);
  setInterval(loadSession, 60000);
  if (/[?&]kite=connected/.test(location.search)) loadOrders();
})();
</script>
</body></html>`;

// --- Static frontend / built-in dashboard -----------------------------------
//
// BUGFIX: this block previously did `res.sendFile(client/dist/index.html)` and
// answered `{"code":"NOT_FOUND"}` from the sendFile error callback whenever that
// build was absent. On a backend-only deploy (no client build) that meant EVERY
// non-API route 404'd — including /dashboard, which is exactly where
// /kite/callback redirects after a successful login, so OAuth dead-ended.
//
// Now: if a client build exists we serve it; if not we serve the built-in
// terminal below. The backend is never dependent on a frontend build existing.

const CLIENT_DIR = path.join(__dirname, 'client', 'dist');
const CLIENT_INDEX = path.join(CLIENT_DIR, 'index.html');
const hasClientBuild = fs.existsSync(CLIENT_INDEX);

if (hasClientBuild) {
  app.use(express.static(CLIENT_DIR));
  log('INFO', `Serving client build from ${CLIENT_DIR}`);
} else {
  log('INFO', 'No client build found — serving the built-in dashboard');
}

// Unknown /api/* routes must answer JSON 404, never fall through to HTML.
app.all(/^\/api\//, (req, res) => {
  res.status(404).json({ code: 'NOT_FOUND', message: `No API route for ${req.method} ${req.path}` });
});

// Everything else renders the SPA (if built) or the built-in dashboard.
app.get(/^\/(?!api\/).*/, (req, res) => {
  if (hasClientBuild) {
    return res.sendFile(CLIENT_INDEX, (err) => {
      if (err) res.status(200).type('html').send(DASHBOARD_HTML);
    });
  }
  res.status(200).type('html').send(DASHBOARD_HTML);
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
  };  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (r) => log('ERROR', 'Unhandled rejection', r));

main();

module.exports = app;
