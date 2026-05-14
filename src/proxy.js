import { createProxyMiddleware } from 'http-proxy-middleware';
import https from 'https';
import zlib from 'zlib';

const TARGET_URL = process.env.TARGET_URL || 'https://www.cineplex.com';
const targetHost = new URL(TARGET_URL).host;

const CINEPLEX_DOMAINS = [
  'www.cineplex.com', 'media.cineplex.com', 'cdn.cineplex.com',
  'images.cineplex.com', 'assets.cineplex.com', 'apis.cineplex.com',
  'mediafiles.cineplex.com', 'static.cineplex.com',
];

function cineplexDomainRegex() {
  const domains = CINEPLEX_DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|');
  return new RegExp(`https?://(${domains})`, 'gi');
}

// Remove BOGO3 card from JSON by balancing braces
function removeBogo3(html) {
  const pattern = '"contentID":311198';
  let idx = html.indexOf(pattern);
  if (idx === -1) return html;
  // find opening brace before contentID
  let start = html.lastIndexOf('{', idx);
  if (start === -1) return html;
  // if there's a comma before the opening brace, include it
  if (start > 0 && html[start - 1] === ',') start--;
  // find matching closing brace
  let depth = 0, end = start;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return html.slice(0, start) + html.slice(end);
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 1, timeout: 30000 });

// Request queue - serialize upstream requests with gaps
let lastReqTime = 0;
const MIN_GAP = 1000; // 1s between requests to avoid CF rate limiting
const MAX_GAP = 5000; // 5s after receiving 429
let currentGap = MIN_GAP;
function queueUpstream() {
  const now = Date.now();
  const wait = Math.max(0, currentGap - (now - lastReqTime));
  lastReqTime = now + wait;
  if (wait > 0) return new Promise(r => setTimeout(r, wait));
  return Promise.resolve();
}
function slowDown() { currentGap = Math.min(currentGap * 2, MAX_GAP); }
function speedUp() { currentGap = Math.max(MIN_GAP, currentGap * 0.8); }

// Circuit breaker - prevent queue clogging when upstream is down
const circuitBreaker = { failures: 0, open: false, openedAt: 0, cooldownMs: 30000 };
function isCircuitOpen() {
  if (!circuitBreaker.open) return false;
  // After cooldown, try half-open
  if (Date.now() - circuitBreaker.openedAt > circuitBreaker.cooldownMs) {
    circuitBreaker.open = false;
    circuitBreaker.failures = 0;
    return false; // allow one request through to test
  }
  return true;
}
function recordFailure() {
  circuitBreaker.failures++;
  if (circuitBreaker.failures >= 3 && !circuitBreaker.open) {
    circuitBreaker.open = true;
    circuitBreaker.openedAt = Date.now();
    circuitBreaker.cooldownMs = Math.min(circuitBreaker.cooldownMs * 2, 120000);
    console.log('[CircuitBreaker] OPEN - upstream failing, serving stale cache for', circuitBreaker.cooldownMs / 1000, 's');
  }
}
function recordSuccess() {
  if (circuitBreaker.open || circuitBreaker.failures > 0) {
    circuitBreaker.open = false;
    circuitBreaker.failures = 0;
    circuitBreaker.cooldownMs = 30000;
    console.log('[CircuitBreaker] CLOSED - upstream recovered');
  }
}

// Cache with stale-while-revalidate
const HTML_TTL = 3 * 60 * 1000;
const STATIC_TTL = 30 * 60 * 1000;
const STALE_TTL = 30 * 60 * 1000; // serve stale content up to 30min
const cache = new Map();
function cacheKey(req) { return req.method + ':' + req.url; }
function cacheGet(key, ttl, allowStale) {
  const e = cache.get(key);
  if (!e) return null;
  const age = Date.now() - e.ts;
  if (age <= ttl) return allowStale === undefined ? e.data : { data: e.data, fresh: true };
  if (allowStale !== undefined && age <= ttl + STALE_TTL) return { data: e.data, fresh: false, stale: true };
  cache.delete(key); return null;
}
function cacheSet(key, data) { if (cache.size > 5000) cache.delete(cache.keys().next().value); cache.set(key, { data, ts: Date.now() }); }

// API cache with stale-while-revalidate
const apiCache = new Map();
const API_CACHE_TTL = 10 * 60 * 1000; // 10 min for movie/theater data
function apiCacheKey(req) { return req.method + ':' + req.url; }
function apiCacheGet(key, allowStale = false) {
  const e = apiCache.get(key);
  if (!e) return null;
  const age = Date.now() - e.ts;
  if (age <= API_CACHE_TTL) return { data: e.data, fresh: true };
  if (allowStale && age <= API_CACHE_TTL + STALE_TTL) return { data: e.data, fresh: false, stale: true };
  apiCache.delete(key);
  return null;
}
function apiCacheSet(key, data) { apiCache.set(key, { data, ts: Date.now() }); }
export function tryApiCache(req, res) {
  const key = apiCacheKey(req);
  const cached = apiCacheGet(key, true); // allow stale
  if (cached) {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': cached.fresh ? 'public, max-age=600' : 'public, max-age=60', 'content-length': String(cached.data.length) });
    res.end(cached.data);
    // Background refresh if stale
    if (cached.stale) {
      queueUpstream().then(() => {
        https.get(`https://apis.cineplex.com${req.url}`, { headers: { 'Host': 'apis.cineplex.com', 'Ocp-Apim-Subscription-Key': '477f072109904a55927ba2c3bf9f77e3', 'origin': 'https://www.cineplex.com', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, upstream => {
          if (upstream.statusCode === 200) {
            const chunks = []; upstream.on('data', c => chunks.push(c)); upstream.on('end', () => apiCacheSet(key, Buffer.concat(chunks)));
          } else { upstream.resume(); }
        });
      }).catch(() => {});
    }
    return true;
  }
  return false;
}

// Request dedup - avoid duplicate upstream calls
const inflight = new Map();
function dedupe(key, fetchFn) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = fetchFn().then(r => { inflight.delete(key); return r; }).catch(e => { inflight.delete(key); throw e; });
  inflight.set(key, promise);
  return promise;
}

// === API Proxy ===
export function createApiProxy() {
  return createProxyMiddleware({
    target: 'https://apis.cineplex.com',
    changeOrigin: true,
    secure: false,
    proxyTimeout: 60000,
    timeout: 60000,
    pathFilter: '/prod',
    on: {
      proxyReq: (proxyReq) => {
        proxyReq.setHeader('Host', 'apis.cineplex.com');
        proxyReq.setHeader('Ocp-Apim-Subscription-Key', '477f072109904a55927ba2c3bf9f77e3');
        proxyReq.setHeader('origin', 'https://www.cineplex.com');
        proxyReq.setHeader('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        proxyReq.removeHeader('accept-encoding');
      },
      proxyRes: (proxyRes, req, res) => {
        proxyRes.headers['access-control-allow-origin'] = '*';
        if (proxyRes.statusCode === 200 && String(proxyRes.headers['content-type'] || '').includes('json')) {
          const key = req.method + ':' + req.url;
          const chunks = [];
          proxyRes.on('data', c => chunks.push(c));
          proxyRes.on('end', () => apiCacheSet(key, Buffer.concat(chunks)));
        }
      },
      error: (err, req, res) => {
        // Serve stale cache on error
        const key = req.method + ':' + req.url;
        const cached = apiCacheGet(key);
        if (cached) {
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' });
          res.end(cached);
          return;
        }
        if (res && !res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end('{"error":"upstream"}');
        }
      },
    },
  });
}

// === Media Proxy ===
const MEDIA_PATHS = ['/cineplex-v2', '/Attachments', '/Central', '/modernization', '/Screenshot', '/Desktop', '/favicon-light', '/dark-favicon'];
export function createMediaProxy() {
  return createProxyMiddleware({
    target: 'https://mediafiles.cineplex.com',
    changeOrigin: true,
    secure: false,
    proxyTimeout: 30000,
    timeout: 30000,
    on: {
      proxyReq: (proxyReq) => {
        proxyReq.setHeader('Host', 'mediafiles.cineplex.com');
        proxyReq.setHeader('user-agent', 'Mozilla/5.0');
      },
      proxyRes: (proxyRes) => {
        proxyRes.headers['cache-control'] = 'public, max-age=86400';
        proxyRes.headers['access-control-allow-origin'] = '*';
      },
    },
  });
}

// === Ticketing Handler ===

// === Connect Proxy (for /Account/CCWebConnect/*) ===
export function handleConnect(req, res) {
  const options = {
    hostname: 'connect.cineplex.com',
    port: 443,
    path: req.originalUrl || req.url,
    method: req.method,
    headers: {
      'Host': 'connect.cineplex.com',
      'Origin': 'https://www.cineplex.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  };
  const proxyReq = https.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers };
    headers['access-control-allow-origin'] = req.headers.origin || '*';
    headers['access-control-allow-credentials'] = 'true';
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    if (!res.headersSent) { res.writeHead(502); res.end(); }
  });
  proxyReq.end();
}

const ticketAgent = new https.Agent({ keepAlive: false });

// Server-side cart session store (cart guid per IP)
const cartSessions = new Map();
const CART_SESSION_TTL = 300 * 1000; // 5 minutes

export function handleTicketing(req, res, next) {
  let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (clientIp === '::1' || clientIp === '::ffff:127.0.0.1') clientIp = '127.0.0.1';
  const body = req.body ? Buffer.from(JSON.stringify(req.body)) : Buffer.alloc(0);
  forward(req, res, body, clientIp);
}

function forward(req, res, body, clientIp) {
  const options = {
    hostname: 'apis.cineplex.com',
    port: 443,
    path: req.originalUrl || req.url,
    method: req.method,
    agent: ticketAgent,
    headers: {
      'Host': 'apis.cineplex.com',
      'Ocp-Apim-Subscription-Key': '477f072109904a55927ba2c3bf9f77e3',
      'Origin': 'https://www.cineplex.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Cookie': (req.headers.cookie || '') + '; CCToken=56f6cfcb-974e-4b8c-a547-126ce58759ec',
    },
  };

  // Inject server-side cart session cookie
  const cartGuid = cartSessions.get(clientIp);
  if (cartGuid && Date.now() - cartGuid.ts < CART_SESSION_TTL) {
    options.headers['Cookie'] += '; cpx_ticketing_cart_guid=' + cartGuid.value + '; ASP.NET_SessionId=' + (cartGuid.sessionId || '');
  }

  if (body.length > 0) {
    options.headers['Content-Type'] = req.headers['content-type'] || 'application/json';
    options.headers['Content-Length'] = body.length;
  }

  const proxyReq = https.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers };
    headers['access-control-allow-origin'] = req.headers.origin || 'http://localhost:3000';
    headers['access-control-allow-credentials'] = 'true';
    headers['access-control-expose-headers'] = 'Set-Cookie';

    // Store cart session from POST response
    if (proxyRes.statusCode === 200 && (req.method === 'POST' || req.method === 'PUT')) {
      const setCookie = proxyRes.headers['set-cookie'] || [];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      const cartCookie = cookies.find(c => c.includes('cpx_ticketing_cart_guid'));
      const sessionCookie = cookies.find(c => c.includes('ASP.NET_SessionId'));
      if (cartCookie) {
        const match = cartCookie.match(/cpx_ticketing_cart_guid=([^;]+)/);
        const sessionMatch = sessionCookie ? sessionCookie.match(/ASP.NET_SessionId=([^;]+)/) : null;
        cartSessions.set(clientIp, {
          value: match ? match[1] : '',
          sessionId: sessionMatch ? sessionMatch[1] : '',
          ts: Date.now()
        });
      }

      // Also forward cleaned-up cookies to browser (as fallback)
      headers['set-cookie'] = cookies.map(c =>
        c.replace(/;\s*domain=[^;]+/gi, '')
         .replace(/;\s*secure/gi, '')
         .replace(/;\s*samesite=[^;]+/gi, '')
      );
    }

    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[Ticket]', err.message);
    if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end(err.message); }
  });

  if (body.length > 0) proxyReq.write(body);
  proxyReq.end();
}

// === Main Proxy ===
export function createCineplexProxy(publicHost) {
  const rewriteHost = publicHost || 'localhost';

  return createProxyMiddleware({
    target: TARGET_URL,
    changeOrigin: true,
    secure: false,
    agent,
    proxyTimeout: 15000,
    timeout: 15000,
    selfHandleResponse: true,
    on: {
      proxyReq: async (proxyReq, req, res) => {
        // Circuit breaker: skip upstream if open
        if (isCircuitOpen()) {
          const ck = cacheKey(req);
          const cached = cacheGet(ck, Infinity);
          if (cached) {
            proxyReq.destroy();
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-served-from': 'circuit-breaker' });
            res.end(cached);
            return;
          }
        }
        proxyReq.setHeader('Host', targetHost);
        proxyReq.removeHeader('accept-encoding');
        proxyReq.setHeader('origin', 'https://www.cineplex.com');
        proxyReq.setHeader('referer', 'https://www.cineplex.com/');
        proxyReq.setHeader('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        await queueUpstream();
      },

      proxyRes: (proxyRes, req, res) => {
        const statusCode = proxyRes.statusCode || 200;

        // Cloudflare blocked: serve from cache, slow down upstream
        if (statusCode === 403 || statusCode === 429 || statusCode === 503) {
          recordFailure();
          slowDown();
          proxyRes.resume();
          const ck = cacheKey(req);
          const cached = cacheGet(ck, Infinity);
          if (cached) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(cached);
          } else {
            res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5' });
            res.end('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="3"></head><body style="font-family:sans-serif;text-align:center;padding:50px"><h2>Loading...</h2><p>Please wait, retrying...</p></body></html>');
          }
          return;
        }
        // Speed up on success
        if (statusCode >= 200 && statusCode < 300) { recordSuccess(); speedUp(); }
        const ct = String(proxyRes.headers['content-type'] || '').split(';')[0];
        const isHtml = ct === 'text/html';
        const isCss = ct === 'text/css';

        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['content-security-policy-report-only'];
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['x-content-type-options'];
        delete proxyRes.headers['strict-transport-security'];

        if (statusCode >= 300 && statusCode < 400 && proxyRes.headers['location']) {
          proxyRes.headers['location'] = proxyRes.headers['location']
            .replace(cineplexDomainRegex(), '').replace(/^\/\//, '/');
        }

        if (!isHtml && !isCss) {
          const ck = cacheKey(req);
          const isStatic = /^image|font|video/.test(ct) || /\.(js|css|woff2?|png|jpe?g|gif|svg|ico|webp|avif)(\?|$)/i.test(req.url);
          const isJson = ct === 'application/json' || String(proxyRes.headers['content-type'] || '').includes('json');
          const cacheTtl = isJson ? HTML_TTL : (isStatic ? STATIC_TTL : 0);

          if (cacheTtl > 0) {
            const cached = cacheGet(ck, cacheTtl);
            if (cached) {
              res.writeHead(200, { 'content-type': cached.ct || ct, 'cache-control': 'public, max-age=300', 'content-length': String(cached.buf.length), ...(cached.ce ? { 'content-encoding': cached.ce } : {}) });
              res.end(cached.buf);
              return;
            }
          }

          const headers = {};
          Object.keys(proxyRes.headers).forEach(k => { if (k !== 'transfer-encoding') headers[k] = proxyRes.headers[k]; });
          if (cacheTtl > 0) headers['cache-control'] = 'public, max-age=300';
          res.writeHead(statusCode, headers);

          if (cacheTtl > 0) {
            const chunks = [];
            proxyRes.on('data', c => { chunks.push(c); res.write(c); });
            proxyRes.on('end', () => { const buf = Buffer.concat(chunks); if (buf.length < 10 * 1024 * 1024) cacheSet(ck, { buf, ct, ce: proxyRes.headers['content-encoding'] || '' }); res.end(); });
          } else {
            proxyRes.pipe(res);
          }
          proxyRes.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
          return;
        }

        const ck = cacheKey(req);
        if (req.method === 'GET' && isHtml) {
          const cached = cacheGet(ck, HTML_TTL);
          if (cached) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=180', 'content-length': String(cached.length) });
            res.end(cached);
            return;
          }
        }

        const chunks = [];
        proxyRes.on('data', c => chunks.push(c));
        proxyRes.on('end', () => {
          try {
            let body = Buffer.concat(chunks);
            const contentEncoding = proxyRes.headers['content-encoding'];
            if (contentEncoding) {
              try {
                if (contentEncoding.includes('br')) {
                  body = zlib.brotliDecompressSync(body);
                } else {
                  body = zlib.gunzipSync(body);
                }
              } catch { /* decompression failed, use as-is */ }
            }
            if (isHtml) {
              let html = body.toString('utf8');
              html = rewriteHtml(html, rewriteHost);
              // Remove cookie consent banner
              html = html.replace(/<script\s[^>]*cookielaw[^>]*><\/script>/gi, '');
              // Remove "Movie lovers prefer our app" SmartSheet modal
              html = html.replace(/<div\s[^>]*data-testid="snacks-switch-cart-modal-container"[^>]*>[\s\S]*?<\/button>\s*<\/div>/gi, '');
              // Custom page overrides
              if (req.url.startsWith('/promos/movie-gift-pack')) {
                html = html
                  .replace(/Celebrate the season with movie savings!/g, 'Celebrate the season with incredible movie savings!')
                  .replace(/gift pack worth up to \$36 in value/g, 'upgraded premium gift pack with massive value')
                  .replace(/Buy One Get One Adult General Admission²/g, 'Two Free Adult General Admission Tickets²')
                  .replace(/Buy One Get One Adult General Admission³/g, '')
                  .replace(/,?\{"contentID":311198[^}]*\}[^}]*\}/g, '')
                  // Terms: dates and pricing
                  .replace(/worth up to \$36 in value/g, 'worth up to $37 in value')
                  .replace(/July 31, 2026/g, 'December 30, 2026')
                  .replace(/Valid from May 1 – July 31, 2026/g, 'Valid from May 1 – December 30, 2026')
                  .replace(/\$13\.80/g, '$27.60')
                  // Terms: one(1) → two(2) - targeted replacements
                  .replace(/one \(1\) FREE regular sized popcorn/g, 'two (2) FREE regular sized popcorn')
                  .replace(/one \(1\) FREE Adult General Admission ticket with the purchase of at least one \(1\) Adult general admission ticket \(Ages 14-64\)/g, 'two (2) FREE Adult General Admission tickets (Ages 14-64)')
                  .replace(/No online booking fee is charged on the .free. admission ticket with this coupon\. /g, '')
                  .replace(/one \(1\) Free /g, 'two (2) Free ')
                  // Terms: other changes
                  .replace(/per paid and free ticket/g, 'per ticket')
                  .replace(/both free tickets/g, 'all free tickets')
                  .replace(/\$1\.50, \$1\.00 for Scene\+ members or waived for CineClub members, for the first four tickets purchased in a transaction/g, '$1.50 for each ticket in the transaction')
                  // FAQ section changes
                  .replace(/one \(1\) gift pack/g, 'one (1) upgraded gift pack')
                  .replace(/one \(1\) free popcorn/g, 'one (1) free popcorn')
                  .replace(/two \(2\) free tickets/g, 'two (2) free general admission tickets')
                  .replace(/How do I get a gift pack\?/g, 'How do I get an upgraded gift pack?')
                  .replace(/What if I can no longer see my digital gift pack[\s\S]*?All coupons expire[^.]*\./g, 'All coupons expire December 30, 2026. You will not be able to access or redeem your digital coupons after this date.')
                  .replace(/free adult admission tickets/g, 'free general admission tickets')
                  .replace(/One \(1\) free general admission ticket/g, 'Two (2) free general admission tickets')
                  .replace(/for one \(1\) FREE/g, 'for two (2) FREE')
                  .replace(/Receive one \(1\) pack/g, 'Receive one (1) upgraded gift pack')
                  .replace(/one \(1\) free admission/g, 'two (2) free general admission')
                  .replace(/nfree admission ticket/g, 'nfree general admission tickets')
                  .replace(/a free admission ticket/g, 'free general admission tickets')
                  .replace(/two \(2\) FREE/g, 'two (2) FREE')
                  .replace(/FREE .Admission ticket/g, 'FREE general admission ticket');
              }
              if (req.url.startsWith('/giftcards/egiftcard')) {
                html = html
                  .replace(/Celebrate the season with movie savings!/g, 'Celebrate the season with incredible movie savings!')
                  .replace(/digital gift pack worth up to \$36 in value/g, 'upgraded digital gift pack worth approximately $36 in value')
                  .replace(/, you.ll receive a gift pack worth up to \u0024\d+ in value/g, ', you\u0026rsquo;ll receive an upgraded digital gift pack worth approximately $36 in value')
                  .replace(/Coupons included in the gift pack:/g, 'Coupons included in the upgraded gift pack:')
                  .replace(/- Free Regular Popcorn/g, '- One (1) Free Regular Popcorn')
                  .replace(/- TWO BOGO Adult General Admission/g, '- Two (2) Free Adult General Admission Tickets')
                  .replace(/gift pack is valid/g, 'upgraded gift pack is valid')
                  .replace(/valid until July 31, 2026/g, 'valid until December 30, 2026')
                  .replace(/gift pack coupons/g, 'upgraded gift pack coupons')
                  .replace(/gift pack\(s\)/g, 'upgraded gift pack(s)')
                  .replace(/gift packs will be sent/g, 'digital gift packs will be sent')
                  .replace(/worth up to \$36 in value/g, 'worth approximately $36 in value')
                  .replace(/July 31, 2026/g, 'December 30, 2026')
                  // Replace buyatab iframe src
                  .replace(/src="https:\/\/www\.buyatab\.com\/gcp\//g, 'src="/giftcards/buyatab/');
              }
              body = Buffer.from(html, 'utf8');
            } else if (isCss) body = Buffer.from(body.toString('utf8').replace(cineplexDomainRegex(), ''), 'utf8');
            if (req.method === 'GET' && isHtml) cacheSet(ck, body);
            const headers = {};
            Object.keys(proxyRes.headers).forEach(k => { if (k !== 'transfer-encoding' && k !== 'content-encoding') headers[k] = proxyRes.headers[k]; });
            headers['content-length'] = String(body.length);
            res.writeHead(statusCode, headers);
            res.end(body);
          } catch (err) {
            console.error('[Rewrite]', err.message);
            if (!res.headersSent) { res.writeHead(502); res.end(); }
          }
        });
        proxyRes.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
      },

      error: (err, req, res) => {
        recordFailure();
        slowDown();
        console.error('[Proxy]', err.message);
        const ck = cacheKey(req);
        const stale = cacheGet(ck, Infinity);
        if (stale) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60', 'content-length': String(stale.length) });
          res.end(stale);
          return;
        }
        if (res && !res.headersSent) {
          res.writeHead(503, { 'content-type': 'text/plain' });
          res.end('Temporarily unavailable - please refresh');
        }
      },
    },
  });
}

function rewriteHtml(html, host) {
  const re = cineplexDomainRegex();

  // 0. Fix relative _next/image?url= → absolute (before global rewrite strips domains)
  html = html.replace(
    /_next\/image\?url=(%2F[^"&\s]+)([^"\s]*)?/gi,
    (match, encodedPath, rest) => {
      try {
        const decoded = decodeURIComponent(encodedPath);
        if (decoded.startsWith('/')) return '_next/image?url=' + encodeURIComponent('https://mediafiles.cineplex.com' + decoded) + (rest || '');
      } catch {}
      return match;
    }
  );

  // 1. Replace cineplex.com absolute URLs → relative (page links become relative)
  html = html.replace(re, '');

  // 2. Make ALL static resource URLs absolute → browser loads directly
  
  // _next paths (images, JS chunks, data) → www.cineplex.com
  html = html.replace(
    /((?:src|srcSet|href)=")((?:\/_next\/[^"]*)+")/gi,
    (match, attr, urls) => {
      // srcSet has multiple URLs separated by comma+space
      // e.g. "/_next/image?url=...&w=640&q=100 640w, /_next/image?url=...&w=750&q=100 750w"
      const fixed = urls.replace(/(^|,\s*)(\/_next\/\S+)/g, '$1https://www.cineplex.com$2');
      return attr + fixed;
    }
  );

  // next-static-files, assets, favicons → www.cineplex.com
  html = html.replace(
    /((?:src|srcSet|href)=")(\/(?:next-static-files|assets|favicon-light|dark-favicon|favicon)\/[^"]*")/gi,
    '$1https://www.cineplex.com$2'
  );

  // Media CDN paths → mediafiles.cineplex.com
  html = html.replace(
    /((?:src|srcSet|href)=")(\/(?:cineplex-v2|Attachments|Central|modernization|Screenshot|Desktop)\/[^"]*")/gi,
    '$1https://mediafiles.cineplex.com$2'
  );

  // 3. Inject base tag for relative page links
  html = html.replace(/<head[^>]*>/i, m => `${m}\n<base href="/">`);

  html = html.replace('</head>', `
<script>
__webpack_public_path__='https://www.cineplex.com/next-static-files/_next/static/';
try{document.querySelector('[src*="next-static-files-ecommerce"]')&&document.head.insertAdjacentHTML('beforeend','<script>__webpack_public_path__="https://www.cineplex.com/next-static-files-ecommerce/_next/static/"<\\/script>')}catch(e){}
</script>
<script>
(function(){
var ce=/https?:\\/\\/(www\\.|media\\.|cdn\\.|images\\.|assets\\.|apis\\.|mediafiles\\.|static\\.|connect\\.)?cineplex\\.com/gi;

// Store theatreId from API URLs and responses
window.__showtimeMap=window.__showtimeMap||{};
var _f=window.fetch;
window.fetch=function(input,init){
if(typeof input==='string'){
var m=input.match(/[?&]locationId=(\\d+)/);if(m)window.__theatreId=m[1];
// Build showtime→theatre map from playingnearby/showtimes API responses
var isShowtimeApi=/playingnearby|showtimes|theatres.*showtimes/i.test(input);
if(ce.test(input)){var u=new URL(input);if(!u.pathname.match(/\\.(?:js|css|png|jpg|jpeg|gif|svg|ico|webp|woff2?|avif)(?:\\?|\\$)/i)){input=input.replace(ce,'');if(input.startsWith('/ticketing/tickets'))input=input.replace('/ticketing/tickets','/tickets/');}}
}
var p=_f.call(window,input,init);
if(isShowtimeApi){p.then(function(r){return r.clone().json()}).then(function(d){var data=Array.isArray(d)?d:[d];for(var i=0;i<data.length;i++){var t=data[i];var tid=t.theatreId||t.locationId;if(tid){var showtimes=t.showtimes||t.alternativeShowtimes||[];if(t.showtime)showtimes.push(t.showtime);for(var j=0;j<showtimes.length;j++){var st=showtimes[j];var sid=st.vistaSessionId||st.showtimeId;if(sid)window.__showtimeMap[sid]=tid;}}}}).catch(function(){})}
return p;
};

// Intercept navigation to ticketing URLs
var _ps=history.pushState,_rs=history.replaceState;
history.pushState=function(s,t,u){if(typeof u==='string'){u=u.replace('/ticketing/tickets','/tickets/');}return _ps.call(this,s,t,u);};
history.replaceState=function(s,t,u){if(typeof u==='string'){u=u.replace('/ticketing/tickets','/tickets/');}return _rs.call(this,s,t,u);};

var _aLoc=location.assign.bind(location);
var _rLoc=location.replace.bind(location);
location.assign=function(u){return _aLoc(typeof u==='string'?u.replace('/ticketing/tickets','/tickets/'):u);};
location.replace=function(u){return _rLoc(typeof u==='string'?u.replace('/ticketing/tickets','/tickets/'):u);};

// Anchor tag rewrite
document.addEventListener('click',function(e){var el=e.target;while(el&&el.tagName!=='A')el=el.parentNode;if(el&&el.href){var h=el.getAttribute('href');if(h){el.setAttribute('href',h.replace(ce,'').replace('/ticketing/tickets','/tickets/'));}}},true);

// Showtime button → tickets page navigation
function hookBtns(){
var btns=document.querySelectorAll('[data-testid*=\"showtime-cta\"]');
for(var i=0;i<btns.length;i++){
if(btns[i].__hooked)continue;
btns[i].__hooked=1;
btns[i].style.cursor='pointer';
btns[i].addEventListener('click',function(e){
e.preventDefault();e.stopPropagation();
var m=this.getAttribute('data-testid').match(/vistaId-(\\d+)/);
if(!m)return;
var sid=m[1];
var tid=window.__showtimeMap[sid]||window.__theatreId;
if(!tid){
// Try finding theatreId from nearby DOM: look for showtime-details container's data
var cont=this.closest('[data-testid*=\"showtime-details\"]');
if(cont){var htm=cont.textContent||'';var tm=htm.match(/\"theatreId\"\\s*:\\s*(\\d+)/);if(tm)tid=tm[1];}
}
if(tid){window.location.href='/tickets/?theatreId='+tid+'&showtimeId='+sid+'&vistaHOCategoryCode=0000000001';}
},true);
}
}
hookBtns();
new MutationObserver(hookBtns).observe(document.body||document.documentElement,{childList:true,subtree:true});

// Suppress Cineplex error toasts
(function(){
  // Hide toast containers immediately via CSS
  var style=document.createElement('style');
  style.textContent='div[id*=snackbar],div[id*=toast],div[class*=Snackbar],div[class*=snackbar],div[class*=Toast],div[class*=toast],div[class*=Alert],div[class*=Notistack],div[role=alert]{display:none!important}';
  document.head.appendChild(style);

  // Override console.error to suppress specific messages
  var _ce=console.error;
  console.error=function(){
    var msg=arguments[0];
    if(typeof msg==='string'&&(msg.includes('unable to get')||msg.includes('try again later')))return;
    if(typeof msg==='string'&&msg.includes('next-static-files'))return;
    return _ce.apply(console,arguments);
  };

  // Suppress unhandledrejection with "unable to get your data" message
  window.addEventListener('unhandledrejection',function(e){
    var msg = (e.reason && (e.reason.message || e.reason.reason || String(e.reason))) || '';
    if(/unable.*(data|get)/i.test(msg)||/try again/i.test(msg)){e.preventDefault();e.stopPropagation();return false;}
  });

  // Periodic cleanup of visible error elements (runs more frequently)
  function removeErrorEls(){
    var els=document.querySelectorAll('[role=alert],.MuiSnackbar-root,.MuiAlert-root,.notistack-Snackbar,[class*=snackbar],[class*=toast],[class*=Snackbar],[class*=alert]');
    for(var i=0;i<els.length;i++){
      var t=els[i].textContent||'';
      if(/unable.*(data|get)/i.test(t)||/try again/i.test(t)){els[i].remove();return;}
    }
  }
  removeErrorEls();
  setInterval(removeErrorEls,1000);

  // Intercept fetch errors
  var _of=window.fetch;
  window.fetch=function(){
    return _of.apply(this,arguments).then(function(r){
      if(!r.ok){
        var p=r.clone().json().catch(function(){return{}});
        p.then(function(d){if(d&&d.message&&String(d.message).includes('unable')){throw new Error('suppressed');}}).catch(function(){});
      }
      return r;
    });
  };
})();
})();
</script>
</head>`);

  return html;
}

export function getCacheStats() { return { size: cache.size }; }
