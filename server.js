'use strict';

/**
 * server.js — Kite Connect session service with AlgoIP static-IP proxy routing.
 *
 * Fixes for the "UND_ERR_CONNECT_TIMEOUT (attempted address: dc46-mum-01.algoip.in:443, timeout: 10000ms)" error:
 *   1. The proxy hostname is resolved to its IPv4 (A record) at runtime and the proxy connection is PINNED to
 *      that IPv4 literal. The hostname dc46-mum-01.algoip.in also publishes an AAAA (IPv6) record; on hosts
 *      whose IPv6 egress is broken/blackholed (common on PaaS containers), a hostname-based connect can stall
 *      until undici's default 10s connect timeout fires. Pinning IPv4 removes that failure mode entirely.
 *      AlgoIP officially supports connecting by raw IPv4 on port 443 (basic HTTP CONNECT mode).
 *   2. The undici ProxyAgent connect timeout is raised from the 10s default to a configurable value
 *      (PROXY_CONNECT_TIMEOUT_MS, default 15000) via proxyTls/requestTls, which plumb into undici's connector.
 *   3. A fallback chain (IPv4 literal first, then hostname) with retries, so a single stale DNS answer or a
 *      transient failure does not kill the request.
 *   4. Precise error classification: proxy 407/401 (bad ALGOIP_USER/ALGOIP_PASSWORD) is reported as an
 *      AUTH problem; connect timeouts / unreachable networks are reported as a NETWORK problem. The old
 *      message incorrectly told you to check credentials for what is actually a TCP-level failure.
 *   5. /api/proxy-check runs a full live egress diagnostic FROM THE SERVER (i.e., from Render's network):
 *      DNS per family, raw TCP probes, proxy CONNECT, egress IP via the proxy, direct egress IP, and a
 *      Kite tunnel test. Open it in a browser for a readable HTML report, or curl it for JSON.
 *
 * Required dependency: undici (npm i undici). Tested with undici ^6 (works on ^7 too).
 * Env vars: see README.md / env.example.
 */

const http = require('http');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const { ProxyAgent, fetch } = require('undici');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3000', 10);
const PROXY_CONNECT_TIMEOUT_MS = parseInt(process.env.PROXY_CONNECT_TIMEOUT_MS || '15000', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '25000', 10);
const DNS_TTL_MS = parseInt(process.env.PROXY_DNS_TTL_MS || '600000', 10); // re-resolve proxy IP every 10 min
const PROXY_MODE = (process.env.ALGOIP_MODE || 'auto').toLowerCase(); // auto | ip | hostname

function normalizeProxyHost(raw) {
  let host = String(raw || '').trim();
  if (!host) return '';
  if (host.includes('://')) {
    try { const u = new URL(host); return u.hostname; } catch { /* fall through */ }
  }
  return host.replace(/^https?:\/\//, '').split(/[/:]/)[0];
}

const ALGOIP_HOST = normalizeProxyHost(process.env.ALGOIP_HOST || 'dc46-mum-01.algoip.in');
const ALGOIP_PORT = parseInt(process.env.ALGOIP_ID || '443', 10) || 443;
const ALGOIP_USER = process.env.ALGOIP_NODE || '';
const ALGOIP_PASSWORD = process.env.ALGOIP_PASSWORD || '';
const ALGOIP_STATIC_IP = process.env.ALGOIP_STATIC_IP || ''; // optional: your assigned AlgoIP IPv4 to verify egress

const KITE_API_KEY = process.env.KITE_API_KEY || '';
const KITE_API_SECRET = process.env.KITE_API_SECRET || '';

const KITE_BASE = 'https://api.kite.trade';
const EGRESS_TEST_URL = 'https://ip64.algoip.in/all?format=json';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

function mask(v) {
  if (!v) return '(not set)';
  const s = String(v);
  if (s.length <= 8) return s.slice(0, 2) + '***';
  return `${s.slice(0, 6)}…${s.slice(-4)} (${s.length} chars)`;
}

// ---------------------------------------------------------------------------
// Error kinds + classification
// ---------------------------------------------------------------------------

function errorChain(err) {
  const chain = [];
  let e = err;
  let guard = 0;
  while (e && guard++ < 8) { chain.push(e); e = e.cause; }
  return chain;
}

/*function classifyProxyError(err) {
  const chain = errorChain(err);
  const flat = chain.map((x) => ({
    name: x.name || '',
    code: x.code || '',
    message: String(x.message || ''),
  }));
  const text = flat.map((f) => `${f.name} ${f.code} ${f.message}`).join(' | ');

  if (/Proxy response \(40[17]\)/i.test(text)) {
    return {
      kind: 'auth',
      title: 'AlgoIP credentials rejected',
      detail: 'The proxy is reachable, but it refused the proxy authentication (HTTP 407/401). This is a credentials problem, not a network problem.',
      hint: 'Open algoip.in -> My IPs and copy the user_id (starts with aip_live_) into ALGOIP_USER and the password (starts with aip_sec_) into ALGOIP_PASSWORD. Watch for trailing spaces or smart quotes when pasting.',
      chain: flat,
    };
  }
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT/i.test(text)) {
    return {
      kind: 'connect-timeout',
      title: 'TCP connection to the AlgoIP proxy timed out',
      detail: 'The server could not even establish a TCP connection to the proxy within the timeout. No request ever reached Zerodha. This is a network/egress problem between this server and the AlgoIP node — NOT a credentials problem.',
      hint: 'Open /api/proxy-check for a live diagnostic. If the raw TCP probe to the proxy IPv4 also times out from here, the problem is on the path (host egress, firewall, or the AlgoIP node itself). Compare by running the same request from your own machine/network.',
      chain: flat,
    };
  }
  if (/ENETUNREACH|EADDRNOTAVAIL|EAFNOSUPPORT/i.test(text)) {
    return {
      kind: 'ipv6-unreachable',
      title: 'IPv6 route unavailable',
      detail: 'The connection attempt went to an IPv6 address but this host has no working IPv6 route. The fix pins the proxy connection to IPv4 automatically.',
      hint: 'This build already prefers IPv4. If you still see this, ensure ALGOIP_HOST is set to the plain hostname and ALGOIP_MODE is auto or ip.',
      chain: flat,
    };
  }
  if (/ECONNREFUSED/i.test(text)) {
    return {
      kind: 'refused',
      title: 'Proxy refused the connection',
      detail: 'The proxy host actively refused the TCP connection (nothing listening on that host:port from your vantage point).',
      hint: 'Double-check ALGOIP_HOST and ALGOIP_PORT (443). If the node was migrated, grab the current hostname from algoip.in -> My IPs.',
      chain: flat,
    };
  }
  if (/EHOSTUNREACH|ENETDOWN/i.test(text)) {
    return {
      kind: 'unreachable',
      title: 'Network unreachable',
      detail: 'The operating system reported no route to the proxy address.',
      hint: 'Check outbound network/firewall rules on the hosting platform. Open /api/proxy-check for per-address-family probes.',
      chain: flat,
    };
  }
  if (/UND_ERR_ABORTED|RequestAbortedError/i.test(text) && !/Proxy response/i.test(text)) {
    return {
      kind: 'aborted',
      title: 'Request aborted',
      detail: 'The request was aborted before completion (possible overall timeout while waiting on the proxy).',
      hint: 'Retry, and open /api/proxy-check. If repeated, raise PROXY_CONNECT_TIMEOUT_MS / REQUEST_TIMEOUT_MS.',
      chain: flat,
    };
  }
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return {
      kind: 'dns',
      title: 'DNS resolution failed for the proxy host',
      detail: 'The proxy hostname could not be resolved to an IP address from this server.',
      hint: 'Check ALGOIP_HOST spelling. You can also set ALGOIP_MODE=ip together with ALGOIP_HOST set directly to your assigned static IPv4 to bypass DNS entirely.',
      chain: flat,
    };
  }
  if (/SELF_SIGNED|CERT|TLS|SecureProxyConnectionError/i.test(text)) {
    return {
      kind: 'tls',
      title: 'TLS problem while talking to the proxy',
      detail: 'A TLS handshake issue occurred on the proxy connection (usually only when forcing https:// scheme to the proxy).',
      hint: 'This build uses plain HTTP CONNECT to the proxy (http:// scheme) which avoids TLS-to-the-proxy entirely; keep ALGOIP_HOST as a bare hostname.',
      chain: flat,
    };
  }
  return {
    kind: 'unknown',
    title: 'Unexpected proxy failure',
    detail: 'The request through the AlgoIP proxy failed in an unrecognized way.',
    hint: 'Open /api/proxy-check and inspect the technical chain below; also check server logs.',
    chain: flat,
  };
}

class ConfigError extends Error {
  constructor(msg) { super(msg); this.name = 'ConfigError'; this.kind = 'config'; }
}
class ProxyAuthError extends Error {
  constructor(report) { super(report.title); this.name = 'ProxyAuthError'; this.kind = 'auth'; this.report = report; }
}
class ProxyNetworkError extends Error {
  constructor(report) { super(report.title); this.name = 'ProxyNetworkError'; this.kind = report.kind; this.report = report; }
}
*/
// ---------------------------------------------------------------------------
// Proxy layer: IPv4 pinning + fallback chain
// ---------------------------------------------------------------------------

let proxyIp4Cache = { ip: null, at: 0, err: null };

async function resolveProxyIp4() {
  const now = Date.now();
  if (now - proxyIp4Cache.at < DNS_TTL_MS) {
    if (proxyIp4Cache.ip) return proxyIp4Cache.ip;
    if (proxyIp4Cache.err) throw proxyIp4Cache.err;
  }
  try {
    let ip = null;
    try {
      const a = await dns.promises.resolve4(ALGOIP_HOST);
      ip = a && a[0];
    } catch {
      const l = await dns.promises.lookup(ALGOIP_HOST, { family: 4 });
      ip = l && l.address;
    }
    if (!ip) throw new Error('No A record found');
    proxyIp4Cache = { ip, at: now, err: null };
    return ip;
  } catch (e) {
    proxyIp4Cache = { ip: null, at: now, err: e };
    throw e;
  }
}

const agentCache = new Map();

function proxyToken() {
  return 'Basic ' + Buffer.from(`${ALGOIP_USER}:${ALGOIP_PASSWORD}`).toString('base64');
}

function getProxyAgent(host) {
  const key = `${host}:${ALGOIP_PORT}`;
  let agent = agentCache.get(key);
  if (!agent) {
    agent = new ProxyAgent({
      uri: `http://${host}:${ALGOIP_PORT}`,
      token: proxyToken(),
      // undici's connector default is 10s; raise it and make it configurable.
      // (Verified: proxyTls.timeout plumbs into the connector for http-scheme proxies too.)
      proxyTls: { timeout: PROXY_CONNECT_TIMEOUT_MS },
      requestTls: { timeout: PROXY_CONNECT_TIMEOUT_MS },
    });
    agentCache.set(key, agent);
    log(`[proxy] new ProxyAgent for ${key} (connect timeout ${PROXY_CONNECT_TIMEOUT_MS}ms)`);
  }
  return agent;
}

async function proxyTargets() {
  const targets = [];
  if (PROXY_MODE !== 'hostname') {
    const ip = await resolveProxyIp4().catch((e) => {
      log(`[proxy] IPv4 resolve failed for ${ALGOIP_HOST}: ${e.code || e.message}`);
      return null;
    });
    if (ip) targets.push({ label: `ipv4:${ip}`, host: ip });
  }
  if (PROXY_MODE !== 'ip' && ALGOIP_HOST && !/^\d+\.\d+\.\d+\.\d+$/.test(ALGOIP_HOST)) {
    targets.push({ label: `host:${ALGOIP_HOST}`, host: ALGOIP_HOST });
  }
  if (targets.length === 0) targets.push({ label: `host:${ALGOIP_HOST}`, host: ALGOIP_HOST });
  return targets;
}

function ensureProxyConfig() {
  if (!ALGOIP_HOST) throw new ConfigError('ALGOIP_HOST is not set (expected your AlgoIP node hostname, e.g. dc46-mum-01.algoip.in)');
  if (!ALGOIP_USER) throw new ConfigError('ALGOIP_USER is not set (expected your aip_live_... user_id from algoip.in -> My IPs)');
  if (!ALGOIP_PASSWORD) throw new ConfigError('ALGOIP_PASSWORD is not set (expected your aip_sec_... password from algoip.in -> My IPs)');
}

/**
 * fetch() through the AlgoIP proxy with IPv4-first fallback + retries.
 * Auth failures fail fast (no retry across targets — same creds everywhere).
 */
async function proxyFetch(url, init = {}, { attempts = 2, label = 'request' } = {}) {
  ensureProxyConfig();
  const targets = await proxyTargets();
  const attemptsLog = [];
  let lastReport = null;
  let lastErr = null;

  for (let round = 1; round <= attempts; round++) {
    for (const t of targets) {
      const started = Date.now();
      try {
        const res = await fetch(url, {
          ...init,
          dispatcher: getProxyAgent(t.host),
          signal: init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        attemptsLog.push({ target: t.label, round, ms: Date.now() - started, ok: true, status: res.status });
        log(`[proxy] ${label} via ${t.label} -> HTTP ${res.status} (${Date.now() - started}ms, round ${round})`);
        return res;
      } catch (err) {
        lastErr = err;
        lastReport = classifyProxyError(err);
        attemptsLog.push({
          target: t.label, round, ms: Date.now() - started, ok: false,
          kind: lastReport.kind, message: String(err.cause?.message || err.message || '').slice(0, 200),
        });
        log(`[proxy] ${label} via ${t.label} FAILED (${Date.now() - started}ms, round ${round}): ${lastReport.kind} — ${lastErr.cause?.message || lastErr.message}`);
        if (lastReport.kind === 'auth') {
          throw new ProxyAuthError(lastReport);
        }
        await new Promise((r) => setTimeout(r, 350 * round));
      }
    }
  }

  const report = lastReport || classifyProxyError(lastErr || new Error('no attempts made'));
  report.attempts = attemptsLog;
  throw new ProxyNetworkError(report);
}

// ---------------------------------------------------------------------------
// Diagnostics (used by /api/proxy-check)
// ---------------------------------------------------------------------------

function tcpProbe(host, port, { family = 0, timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const s = net.connect({ host, port, family });
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      try { s.destroy(); } catch { /* noop */ }
      resolve({ host, port, family: family || 'any', ok, ms: Date.now() - started, error: error || undefined });
    };
    s.setTimeout(timeoutMs, () => finish(false, `timeout after ${timeoutMs}ms`));
    s.once('connect', () => finish(true));
    s.once('error', (e) => finish(false, `${e.code || ''} ${e.message}`.trim()));
  });
}

async function directEgress() {
  const started = Date.now();
  try {
    const res = await fetch(EGRESS_TEST_URL, { signal: AbortSignal.timeout(10000) });
    const body = await res.json();
    return { ok: true, ms: Date.now() - started, ip: body.ip || body.yourIp || body.query || null, raw: body };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: String(e.cause?.message || e.message || e) };
  }
}

async function proxiedEgress() {
  const res = await proxyFetch(EGRESS_TEST_URL, {}, { attempts: 1, label: 'egress-test' });
  const bodyText = await res.text();
  let body = null;
  try { body = JSON.parse(bodyText); } catch { body = { raw: bodyText.slice(0, 300) }; }
  return { status: res.status, body };
}

async function kiteTunnelTest() {
  const res = await proxyFetch(`${KITE_BASE}/session/token`, { method: 'GET' }, { attempts: 1, label: 'kite-tunnel-test' });
  const status = res.status;
  let kiteBody = '';
  try { kiteBody = (await res.text()).slice(0, 300); } catch { /* noop */ }
  // Any HTTP status (even 403/405) proves the CONNECT tunnel to api.kite.trade works through the proxy.
  return { status, bodyPreview: kiteBody, tunnelOk: status > 0 };
}

async function runProxyCheck() {
  const report = {
    when: new Date().toISOString(),
    proxy: {
      host: ALGOIP_HOST,
      port: ALGOIP_PORT,
      mode: PROXY_MODE,
      user: ALGOIP_USER ? mask(ALGOIP_USER) : '(not set)',
      password: ALGOIP_PASSWORD ? mask(ALGOIP_PASSWORD) : '(not set)',
      expectedStaticIp: ALGOIP_STATIC_IP || '(not set)',
      connectTimeoutMs: PROXY_CONNECT_TIMEOUT_MS,
    },
    stages: {},
    verdict: null,
    summary: '',
    advice: [],
  };

  const missing = [];
  if (!ALGOIP_USER) missing.push('ALGOIP_USER');
  if (!ALGOIP_PASSWORD) missing.push('ALGOIP_PASSWORD');
  if (!ALGOIP_HOST) missing.push('ALGOIP_HOST');
  if (missing.length) {
    report.verdict = 'CONFIG_MISSING';
    report.summary = `Missing environment variables: ${missing.join(', ')}. Set them from algoip.in -> My IPs (user_id -> ALGOIP_USER, password -> ALGOIP_PASSWORD).`;
    report.advice.push('Add the missing env vars on Render (Environment) and redeploy, then re-run this check.');
    return report;
  }

  // Stage 1: DNS
  const dnsStage = { host: ALGOIP_HOST, lookup: [], a: [], aaaa: [] };
  try { dnsStage.lookup = await dns.promises.lookup(ALGOIP_HOST, { all: true }); } catch (e) { dnsStage.lookupError = e.code || e.message; }
  dnsStage.a = await dns.promises.resolve4(ALGOIP_HOST).catch(() => []);
  dnsStage.aaaa = await dns.promises.resolve6(ALGOIP_HOST).catch(() => []);
  report.stages.dns = dnsStage;

  // Stage 2: raw TCP probes (per address, family-pinned) + hostname attempt
  const probes = [];
  for (const addr of dnsStage.a) probes.push(await tcpProbe(addr, ALGOIP_PORT, { family: 4, timeoutMs: 6000 }));
  for (const addr of dnsStage.aaaa) probes.push(await tcpProbe(addr, ALGOIP_PORT, { family: 6, timeoutMs: 4000 }));
  probes.push(await tcpProbe(ALGOIP_HOST, ALGOIP_PORT, { timeoutMs: 8000 }));
  report.stages.tcp = probes;

  const ip4Ok = probes.some((p) => p.family === 4 && p.ok);
  const anyOk = probes.some((p) => p.ok);

  // Stage 3: direct egress (what Kite would see WITHOUT the proxy)
  report.stages.directEgress = await directEgress();

  // Stage 4: proxied egress + Kite tunnel test
  let egress = null;
  let egressErr = null;
  try { egress = await proxiedEgress(); } catch (e) { egressErr = e; }

  if (egressErr) {
    const rep = egressErr.report || classifyProxyError(egressErr);
    report.stages.proxyEgress = { ok: false, kind: rep.kind, title: rep.title, chain: rep.chain };
    if (rep.kind === 'auth') {
      report.verdict = 'PROXY_REACHABLE_AUTH_FAILED';
      report.summary = 'The AlgoIP proxy is reachable from this server, but it rejected the proxy credentials (407/401). Fix ALGOIP_USER / ALGOIP_PASSWORD.';
      report.advice.push('algoip.in -> My IPs: copy user_id (aip_live_...) to ALGOIP_USER and password (aip_sec_...) to ALGOIP_PASSWORD. Beware trailing spaces.');
    } else if (!anyOk) {
      report.verdict = 'PROXY_UNREACHABLE';
      report.summary = `This server cannot establish a TCP connection to the AlgoIP proxy at all (${rep.kind}). The request never reaches Zerodha. This is a network/egress issue, not a credentials issue.`;
      report.advice.push('Run the same egress test from a different network (e.g. your laptop): curl -x "http://ALGOIP_USER:ALGOIP_PASSWORD@' + ALGOIP_HOST + ':443" "https://ip64.algoip.in/all?format=json". If it works locally but not from this server, the hosting platform egress path to the AlgoIP node is being filtered.');
      report.advice.push('Check the AlgoIP node status/hostname in your dashboard (nodes can be migrated); update ALGOIP_HOST if it changed.');
      report.advice.push('If you have another AlgoIP allocation/node, try switching ALGOIP_HOST to it.');
      report.advice.push('If nothing helps, share this report with AlgoIP support and your host\'s outbound IP ranges (' + (report.stages.directEgress.ip || 'see directEgress above') + ') so they can check for filtering/blacklisting.');
    } else {
      report.verdict = 'PROXY_TUNNEL_PROBLEM';
      report.summary = `Raw TCP to the proxy succeeds, but the proxied request failed (${rep.kind}). Inspect the chain below.`;
      report.advice.push('Re-run this check a few times — transient proxy-side load can cause this.');
      report.advice.push('If persistent, share this report with AlgoIP support.');
    }
    report.stages.proxyEgress.chain = rep.chain;
    report.stages.kiteTunnel = { skipped: true, reason: 'proxy egress test failed' };
    return report;
  }

  report.stages.proxyEgress = {
    ok: true,
    status: egress.status,
    egressIp: egress.body.ip || egress.body.yourIp || egress.body.query || null,
    body: egress.body,
  };
  const egressIp = report.stages.proxyEgress.egressIp;

  // Stage 5: Kite tunnel test
  try {
    report.stages.kiteTunnel = await kiteTunnelTest();
  } catch (e) {
    const rep = e.report || classifyProxyError(e);
    report.stages.kiteTunnel = { ok: false, kind: rep.kind, title: rep.title, chain: rep.chain };
  }

  if (ALGOIP_STATIC_IP && egressIp) {
    if (egressIp === ALGOIP_STATIC_IP) {
      report.verdict = 'PROXY_OK';
      report.summary = `Proxy works end-to-end. Egress IP ${egressIp} matches your assigned AlgoIP static IP. Whitelist ${egressIp} on the Zerodha developer console.`;
    } else {
      report.verdict = 'PROXY_OK_EGRESS_MISMATCH';
      report.summary = `Proxy works, but the egress IP ${egressIp} does not match ALGOIP_STATIC_IP (${ALGOIP_STATIC_IP}). Verify which IP is whitelisted at Zerodha.`;
      report.advice.push('Whitelist the egress IP shown above on the Zerodha developer console, or check that you are routing through the intended AlgoIP allocation.');
    }
  } else if (egressIp) {
    report.verdict = 'PROXY_OK_EGRESS_UNVERIFIED';
    report.summary = `Proxy works end-to-end. Your API traffic egresses from ${egressIp}. Set ALGOIP_STATIC_IP to your assigned AlgoIP IPv4 to have this check verify it automatically.`;
    report.advice.push(`Ensure ${egressIp} is whitelisted on the Zerodha developer console.`);
  } else {
    report.verdict = 'PROXY_OK_NO_EGRESS_IP';
    report.summary = 'Proxy request succeeded but the egress-IP echo service did not return an IP. Inspect the body below.';
  }

  if (report.stages.kiteTunnel && report.stages.kiteTunnel.tunnelOk) {
    report.summary += ` Tunnel to api.kite.trade verified (HTTP ${report.stages.kiteTunnel.status}).`;
  } else if (report.stages.kiteTunnel && !report.stages.kiteTunnel.ok) {
    report.summary += ` NOTE: tunnel test to api.kite.trade failed (${report.stages.kiteTunnel.kind}) — the proxy may be blocking that destination.`;
  }

  if (!ip4Ok && anyOk) {
    report.advice.push('IPv4 probe failed but some connection succeeded — check the per-family TCP probes; this build pins IPv4 whenever it resolves.');
  }
  return report;
}

// ---------------------------------------------------------------------------
// Kite layer
// ---------------------------------------------------------------------------

function kiteLoginUrl() {
  if (!KITE_API_KEY) throw new ConfigError('KITE_API_KEY is not set');
  return `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(KITE_API_KEY)}`;
}

async function kiteSessionExchange(requestToken) {
  if (!KITE_API_KEY) throw new ConfigError('KITE_API_KEY is not set');
  if (!KITE_API_SECRET) throw new ConfigError('KITE_API_SECRET is not set');
  if (!requestToken || typeof requestToken !== 'string') throw new ConfigError('request_token is required in the JSON body');

  const checksum = crypto.createHash('sha256')
    .update(KITE_API_KEY + requestToken + KITE_API_SECRET)
    .digest('hex');

  const body = new URLSearchParams({
    api_key: KITE_API_KEY,
    request_token: requestToken,
    checksum,
  }).toString();

  const res = await proxyFetch(`${KITE_BASE}/session/token`, {
    method: 'POST',
    headers: {
      'X-Kite-Version': '3',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  }, { attempts: 2, label: 'kite-session' });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* handled below */ }

  if (res.status === 403 || (json && json.status === 'error')) {
    return {
      ok: false,
      httpStatus: res.status,
      kiteError: (json && (json.message || json.error_type)) || text.slice(0, 300),
      note: 'Kite rejected the token exchange. A "Checksum mismatch"/"TokenException" here means KITE_API_SECRET or the request_token was wrong/expired — the proxy path is working.',
    };
  }
  if (!res.ok || !json || json.status !== 'success') {
    return { ok: false, httpStatus: res.status, kiteError: text.slice(0, 300), note: 'Unexpected Kite response.' };
  }
  return { ok: true, httpStatus: res.status, data: json.data };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function wantsHtml(req) {
  const a = req.headers['accept'] || '';
  return a.includes('text/html');
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function proxyCheckHtml(report) {
  const ok = report.verdict === 'PROXY_OK' || report.verdict === 'PROXY_OK_EGRESS_UNVERIFIED';
  const color = report.verdict === 'PROXY_OK' ? '#22c55e'
    : report.verdict === 'PROXY_OK_EGRESS_UNVERIFIED' ? '#eab308'
    : report.verdict === 'PROXY_REACHABLE_AUTH_FAILED' ? '#f97316'
    : '#ef4444';
  const rows = Object.entries(report.stages || {}).map(([k, v]) =>
    `<details open style="margin:6px 0"><summary style="cursor:pointer;font-weight:600;color:#93c5fd">${esc(k)}</summary><pre style="background:#0b1220;color:#dbeafe;padding:10px;border-radius:8px;overflow:auto;font-size:12px">${esc(JSON.stringify(v, null, 2))}</pre></details>`).join('');
  const advice = (report.advice || []).map((a) => `<li style="margin:4px 0">${esc(a)}</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proxy Check — Kite/AlgoIP</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:16px;max-width:760px;margin:0 auto}
.card{background:#111a2e;border:1px solid #1e293b;border-radius:14px;padding:16px;margin:12px 0}
h1{font-size:20px;margin:4px 0} .pill{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700;color:${color};border:1px solid ${color}}
.sum{margin:10px 0;color:#cbd5e1;line-height:1.5}
a.btn{display:inline-block;margin-top:10px;background:#2563eb;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:600}
small{color:#64748b}</style></head><body>
<div class="card"><h1>AlgoIP / Kite egress check</h1>
<span class="pill">${esc(report.verdict || 'UNKNOWN')}</span>
<div class="sum">${esc(report.summary || '')}</div>
${advice ? `<ul style="padding-left:18px;color:#cbd5e1;line-height:1.5">${advice}</ul>` : ''}
<small>Proxy: ${esc(report.proxy?.host || '')}:${esc(String(report.proxy?.port || ''))} · mode=${esc(report.proxy?.mode || '')} · connect timeout=${esc(String(report.proxy?.connectTimeoutMs || ''))}ms · ${esc(report.when || '')}</small>
</div>
<div class="card"><h1 style="font-size:16px">Stage details</h1>${rows || '<small>none</small>'}</div>
<div class="card"><a class="btn" href="/api/proxy-check">Run again</a> <a class="btn" href="/" style="background:#334155">Home</a></div>
</body></html>`;
}

function homeHtml() {
  const cfgRows = [
    ['ALGOIP_HOST', ALGOIP_HOST || '(not set)'],
    ['ALGOIP_PORT', String(ALGOIP_PORT)],
    ['ALGOIP_USER', mask(ALGOIP_USER)],
    ['ALGOIP_PASSWORD', mask(ALGOIP_PASSWORD)],
    ['ALGOIP_STATIC_IP', ALGOIP_STATIC_IP || '(not set)'],
    ['ALGOIP_MODE', PROXY_MODE],
    ['KITE_API_KEY', mask(KITE_API_KEY)],
    ['KITE_API_SECRET', mask(KITE_API_SECRET)],
    ['PROXY_CONNECT_TIMEOUT_MS', String(PROXY_CONNECT_TIMEOUT_MS)],
  ].map(([k, v]) => {
    const bad = v.includes('(not set)');
    return `<tr><td style="padding:4px 10px;color:#94a3b8">${esc(k)}</td><td style="padding:4px 10px;${bad ? 'color:#ef4444' : 'color:#bbf7d0'}">${esc(v)}</td></tr>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kite session service</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:16px;max-width:760px;margin:0 auto}
.card{background:#111a2e;border:1px solid #1e293b;border-radius:14px;padding:16px;margin:12px 0}
h1{font-size:20px;margin:4px 0} table{border-collapse:collapse;width:100%;font-size:13px}
a.btn{display:inline-block;margin:6px 6px 0 0;background:#2563eb;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:600}
code{background:#0b1220;padding:2px 6px;border-radius:6px;color:#93c5fd;font-size:12px}</style></head><body>
<div class="card"><h1>Kite session service</h1>
<div style="color:#94a3b8;line-height:1.6">Zerodha Kite Connect session/token exchange routed through your AlgoIP static-IP proxy. This build pins the proxy connection to IPv4, raises the connect timeout to ${PROXY_CONNECT_TIMEOUT_MS}ms, and falls back from the resolved IPv4 to the hostname automatically.</div></div>
<div class="card"><h1 style="font-size:16px">Configuration</h1><table>${cfgRows}</table></div>
<div class="card"><h1 style="font-size:16px">Actions</h1>
<a class="btn" href="/api/proxy-check">Run live egress test</a>
<a class="btn" href="/api/health" style="background:#334155">Health (JSON)</a>
<div style="margin-top:12px;color:#64748b;font-size:12px;line-height:1.7">
POST <code>/api/kite/session</code> with JSON <code>{"request_token":"..."}</code> to exchange it for an access_token.<br>
GET <code>/api/kite/login-url</code> returns the Kite login URL for your api_key.
</div></div>
</body></html>`;
}

async function readBodyJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new ConfigError('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new ConfigError('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  try {
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(homeHtml());
    }

    if (req.method === 'GET' && path === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'kite-algoip-session',
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
        proxy: {
          host: ALGOIP_HOST, port: ALGOIP_PORT, mode: PROXY_MODE,
          userConfigured: !!ALGOIP_USER, passwordConfigured: !!ALGOIP_PASSWORD,
          resolvedIp4: proxyIp4Cache.ip || null,
        },
        kite: { apiKeyConfigured: !!KITE_API_KEY, apiSecretConfigured: !!KITE_API_SECRET },
      });
    }

    if (req.method === 'GET' && path === '/api/proxy-check') {
      const report = await runProxyCheck();
      if (wantsHtml(req)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(proxyCheckHtml(report));
      }
      return sendJson(res, 200, report);
    }

    if (req.method === 'GET' && path === '/api/kite/login-url') {
      try {
        return sendJson(res, 200, { ok: true, loginUrl: kiteLoginUrl() });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: { kind: 'config', title: 'Configuration error', detail: e.message } });
      }
    }

    if (req.method === 'POST' && path === '/api/kite/session') {
      let body;
      try { body = await readBodyJson(req); } catch (e) {
        return sendJson(res, 400, { ok: false, error: { kind: 'config', title: 'Bad request', detail: e.message } });
      }
      try {
        const result = await kiteSessionExchange(body.request_token);
        return sendJson(res, result.ok ? 200 : 502, result);
      } catch (e) {
        if (e instanceof ConfigError) {
          return sendJson(res, 400, { ok: false, error: { kind: 'config', title: 'Configuration error', detail: e.message } });
        }
        const rep = e.report || classifyProxyError(e);
        return sendJson(res, 502, {
          ok: false,
          error: {
            kind: rep.kind,
            title: rep.title,
            detail: rep.detail,
            hint: rep.hint,
            technical: { chain: rep.chain, attempts: rep.attempts || null },
          },
        });
      }
    }

    return sendJson(res, 404, { ok: false, error: { kind: 'not-found', title: 'Not found', detail: `No route for ${req.method} ${path}` } });
  } catch (e) {
    log('[http] unhandled error:', e);
    return sendJson(res, 500, { ok: false, error: { kind: 'internal', title: 'Internal error', detail: String(e && e.message) } });
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  log(`Kite/AlgoIP session service listening on 0.0.0.0:${PORT}`);
  log(`Proxy: ${ALGOIP_HOST}:${ALGOIP_PORT} mode=${PROXY_MODE} user=${mask(ALGOIP_USER)} connectTimeout=${PROXY_CONNECT_TIMEOUT_MS}ms`);
  if (ALGOIP_HOST) {
    try {
      const ip = await resolveProxyIp4();
      log(`Proxy IPv4 pinned: ${ip} (A record of ${ALGOIP_HOST})`);
    } catch (e) {
      log(`Proxy IPv4 resolve failed at boot (${e.code || e.message}) — will fall back to hostname connect`);
    }
  }
  if (!ALGOIP_USER || !ALGOIP_PASSWORD) log('WARNING: ALGOIP_USER / ALGOIP_PASSWORD not set — proxy calls will fail with a config error.');
  if (!KITE_API_KEY || !KITE_API_SECRET) log('WARNING: KITE_API_KEY / KITE_API_SECRET not set — Kite session exchange is disabled.');
});

process.on('unhandledRejection', (e) => log('[process] unhandledRejection:', e));
