const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { Store } = require('./store');
const QRCode = require('qrcode');
const { parseRows, parseCsv, normalize, TEMPLATE_CSV } = require('./menu');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };
const PAGES = { '/menu': 'menu.html', '/admin': 'admin.html', ...(config.demo ? { '/demo': 'demo.html' } : {}) };

// Neutralise spreadsheet formula injection (=,+,-,@) in exported guest-supplied text.
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s) && !/^\+91\d{10}$/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function toCsv(rows) {
  const cols = ['name', 'phone', 'consentReview', 'consentOffers', 'visits', 'spent', 'lastVisit', 'reviewRequestedAt'];
  const date = (t) => (t ? new Date(t).toISOString() : '');
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(c.endsWith('Visit') || c.endsWith('At') ? date(r[c]) : r[c])).join(','))].join('\n') + '\n';
}

async function parseUpload(buf, kind) {
  try {
    let rows;
    if (kind === 'csv') rows = parseCsv(buf.toString('utf8'));
    else {
      const ExcelJS = require('exceljs'); // loaded lazily: only staff imports need it
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const ws = wb.worksheets[0];
      if (!ws) return { errors: ['The workbook is empty'] };
      rows = [];
      ws.eachRow({ includeEmpty: false }, (row, n) => {
        if (n > 2001) return; // sanity cap; parseRows also rejects > 1000 dishes
        const vals = row.values.slice(1).map((v) => (v && typeof v === 'object' ? (v.result ?? v.text ?? (v.richText ? v.richText.map((x) => x.text).join('') : '')) : v));
        rows.push(vals);
      });
    }
    return parseRows(rows);
  } catch {
    return { errors: ['Could not read the file. Upload an .xlsx or .csv exported from Excel.'] };
  }
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** Fixed-window counter keyed by string; good enough to blunt brute force and floods on one instance. */
function limiter(max, windowMs, now = Date.now) {
  const hits = new Map();
  return {
    hit(key) {
      const t = now();
      let e = hits.get(key);
      if (!e || e.reset <= t) { e = { n: 0, reset: t + windowMs }; hits.set(key, e); }
      if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
      e.n++;
      return e.n > max ? Math.ceil((e.reset - t) / 1000) : 0; // seconds to wait, or 0 if allowed
    },
    /** Seconds left if `key` has already used up its allowance (without counting a new hit). */
    blocked(key) {
      const e = hits.get(key);
      return e && e.reset > now() && e.n >= max ? Math.ceil((e.reset - now()) / 1000) : 0;
    },
    clear(key) { hits.delete(key); },
  };
}

const TOKEN_TTL = 12 * 3600e3;

function createServer(store = new Store(), opts = {}) {
  const now = opts.now || Date.now;
  const loginFails = limiter(8, 10 * 60e3, now);
  const guestPosts = limiter(300, 60e3, now);
  const scans = limiter(40, 60e3, now);
  const resets = limiter(6, 60e3, now);

  // Admin sessions are stateless signed tokens (work across serverless instances); changing the password revokes them all.
  const tokenKey = crypto.createHash('sha256').update(`admin:${store.state.secret}:${config.adminPassword}`).digest();
  const sign = (exp) => crypto.createHmac('sha256', tokenKey).update(String(exp)).digest('hex');
  const issueToken = () => { const exp = now() + TOKEN_TTL; return { token: `${exp}.${sign(exp)}`, expiresAt: exp }; };
  function isAdmin(req) {
    const m = /^Bearer (\d+)\.([a-f0-9]{64})$/.exec(req.headers.authorization || '');
    if (!m || Number(m[1]) < now()) return false;
    return crypto.timingSafeEqual(Buffer.from(sign(m[1])), Buffer.from(m[2]));
  }
  const passwordOk = (given) => {
    const a = crypto.createHash('sha256').update(String(given)).digest();
    const b = crypto.createHash('sha256').update(config.adminPassword).digest();
    return crypto.timingSafeEqual(a, b);
  };

  const clientIp = (req) => (config.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';

  /** Where QR codes should point: BASE_URL if configured, else the address the staff member is using right now. */
  function origin(req) {
    if (config.baseUrlSet) return config.baseUrl;
    const host = String(req.headers['x-forwarded-host'] && config.trustProxy ? req.headers['x-forwarded-host'] : req.headers.host || '');
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return config.baseUrl;
    const proto = config.trustProxy ? String(req.headers['x-forwarded-proto'] || 'https').split(',')[0] : 'http';
    return `${proto === 'https' ? 'https' : 'http'}://${host}`;
  }

  const send = (res, code, body, headers = {}) => {
    const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
    res.writeHead(code, {
      ...SECURITY_HEADERS,
      'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(config.cookieSecure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
      ...headers,
    });
    res.end(isObj ? JSON.stringify(body) : body);
  };

  const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));

  // Each device gets a random token; it is only meaningful while the table session it joined is alive.
  function deviceToken(req, res) {
    let tok = parseCookies(req).dt;
    if (!/^[a-f0-9]{48}$/.test(tok || '')) {
      tok = crypto.randomBytes(24).toString('hex');
      const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}${config.cookieSecure ? '; Secure' : ''}`;
      res.setHeader('Set-Cookie', `dt=${tok}; ${flags}`);
    }
    return tok;
  }

  async function readBuffer(req, max) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error('File too large (max 3 MB)'), { status: 413 }); chunks.push(c); }
    return Buffer.concat(chunks);
  }

  async function readJson(req) {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) throw Object.assign(new Error('JSON required'), { status: 415 });
    let body;
    try { body = JSON.parse((await readBuffer(req, 50e3)).toString() || '{}'); } catch (e) { throw e.status ? e : Object.assign(new Error('Bad JSON'), { status: 400 }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('JSON object required'), { status: 400 });
    return body;
  }

  const reply = (res, r) => (r.ok === false ? send(res, r.status || 400, { error: r.error }) : send(res, 200, r));

  function serveFile(res, file) {
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
  }

  const qrSvg = (url) => QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });

  async function admin(req, res, url) {
    const p = url.pathname;
    let m;
    if (req.method === 'POST' && p === '/api/admin/login') return login(res, clientIp(req), await readJson(req));
    if (!isAdmin(req)) return send(res, 401, { error: 'Please sign in' });
    if (config.demo && req.method === 'POST' && (p === '/api/admin/settings' || p === '/api/admin/menu/import')) return send(res, 403, { error: 'Disabled in the demo' });

    if (req.method === 'GET' && p === '/api/admin/settings') {
      const base = origin(req);
      const host = new URL(base).hostname;
      return send(res, 200, {
        tableCount: store.tableCount, maxTables: config.maxTables, baseUrl: base, baseUrlSet: config.baseUrlSet,
        hostKind: /^(localhost|127\.|10\.|192\.168\.)/.test(host) ? 'local' : /\.vercel\.app$/.test(host) ? 'vercel' : 'custom',
        ...store.qrHealth(),
      });
    }
    if (req.method === 'POST' && p === '/api/admin/settings') {
      const body = await readJson(req);
      return reply(res, store.setTableCount(Number(body.tableCount)));
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/admin\/qr\/(counter|\d+)\.svg$/))) {
      const base = origin(req);
      if (m[1] === 'counter') return send(res, 200, await qrSvg(`${base}/menu`), { 'Content-Type': 'image/svg+xml' });
      if (!store.table(m[1])) return send(res, 404, { error: 'No such table' });
      return send(res, 200, await qrSvg(`${base}/t/${m[1]}?s=${store.sign(m[1])}`), { 'Content-Type': 'image/svg+xml' });
    }
    if (req.method === 'GET' && p === '/api/admin/menu') return send(res, 200, store.adminMenu());
    if (req.method === 'GET' && p === '/api/admin/menu-template.csv') return send(res, 200, TEMPLATE_CSV, { 'Content-Type': 'text/csv; charset=utf-8' });
    if (req.method === 'POST' && p === '/api/admin/menu/availability') {
      const body = await readJson(req);
      return reply(res, store.setAvailability(String(body.itemId), body.available === true));
    }
    if (req.method === 'POST' && p === '/api/admin/menu/restock') {
      const body = await readJson(req);
      return reply(res, store.answerRestock(String(body.itemId), body.bringBack === true));
    }
    if (req.method === 'POST' && p === '/api/admin/menu/import') {
      const kind = url.searchParams.get('type') === 'csv' ? 'csv' : 'xlsx';
      const apply = url.searchParams.get('apply') === '1';
      const r = await parseUpload(await readBuffer(req, 3e6), kind);
      if (r.errors.length) return send(res, 422, { error: r.errors.slice(0, 10).join('\n'), errors: r.errors.slice(0, 50) });
      if (apply) store.setMenu(normalize(r.menu));
      return send(res, 200, { ok: true, applied: apply, dishes: r.menu.items.length, categories: r.menu.categories.map((c) => c.name), sample: r.menu.items.slice(0, 5).map((i) => i.name) });
    }
    if (req.method === 'GET' && p === '/api/admin/orders') return send(res, 200, store.adminOrders());
    if (req.method === 'GET' && p === '/api/admin/customers') return send(res, 200, { customers: store.customers(), reviewUrl: config.googleReviewUrl, restaurant: config.restaurantName });
    if (req.method === 'GET' && p === '/api/admin/customers.csv') {
      const only = url.searchParams.get('for'); // 'offers' | 'review' | all
      const rows = store.customers().filter((c) => (only === 'offers' ? c.consentOffers : only === 'review' ? c.consentReview : true));
      return send(res, 200, toCsv(rows), { 'Content-Type': 'text/csv; charset=utf-8' });
    }
    if (req.method === 'GET' && p === '/api/admin/tables') return send(res, 200, { tables: store.adminTables() });
    if (req.method === 'POST' && (m = p.match(/^\/api\/admin\/orders\/(\d+)\/([a-f0-9]+)\/status$/))) {
      const body = await readJson(req);
      return reply(res, store.setOrderStatus(m[1], m[2], body.status));
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/admin\/customers\/(\+91\d{10})\/(review-sent|delete)$/))) {
      await readJson(req);
      return reply(res, m[2] === 'delete' ? store.deleteCustomer(m[1]) : store.markReviewRequested(m[1]));
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/admin\/tables\/(\d+)\/(seat|close|reopen|void|bill)$/))) {
      const body = await readJson(req);
      const [, id, act] = m;
      if (act === 'seat') return reply(res, store.seat(id, body.pairing));
      if (act === 'bill') return reply(res, store.generateBill(id));
      if (act === 'close') return reply(res, store.closeTable(id));
      if (act === 'reopen') return reply(res, store.reopen(id));
      return reply(res, store.voidOrder(id, body.orderId));
    }
    return send(res, 404, { error: 'Not found' });
  }

  function login(res, ip, body) {
    const key = `ip:${ip}`;
    const locked = (wait) => send(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` }, { 'Retry-After': String(wait) });
    if (loginFails.blocked(key)) return locked(loginFails.blocked(key)); // even the right password is refused while locked out
    if (!passwordOk(body.password)) {
      loginFails.hit(key);
      return loginFails.blocked(key) ? locked(loginFails.blocked(key)) : send(res, 401, { error: 'Wrong password' });
    }
    loginFails.clear(key);
    return send(res, 200, issueToken());
  }

  return http.createServer(async (req, res) => {
    try {
      if (config.missingEnv.length) {
        return send(res, 503, `Server is not configured yet. Set these environment variables in the hosting dashboard and redeploy: ${config.missingEnv.join(', ')}`);
      }
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      let m;

      // Browsers send Origin on cross-site POSTs; refuse any that isn't this site.
      if (req.method === 'POST' && req.headers.origin) {
        let ok = false;
        try { ok = new URL(req.headers.origin).host === req.headers.host; } catch { /* malformed -> refuse */ }
        if (!ok) return send(res, 403, { error: 'Cross-site request refused' });
      }

      if (req.method === 'GET' && p === '/') { res.writeHead(302, { ...SECURITY_HEADERS, Location: config.demo ? '/demo' : '/menu' }); return res.end(); }
      if (req.method === 'GET' && p === '/api/info') return send(res, 200, { demo: config.demo });
      if (config.demo && p.startsWith('/api/demo/')) {
        // Public on purpose: the demo has no real data. Only available when DEMO_MODE=1.
        if (req.method === 'GET' && p === '/api/demo/info') return send(res, 200, { password: config.demoPassword, tables: Array.from({ length: Math.min(store.tableCount, 4) }, (_, i) => ({ id: i + 1, url: `/t/${i + 1}?s=${store.sign(i + 1)}` })) });
        if (req.method === 'GET' && (m = p.match(/^\/api\/demo\/qr\/(counter|\d+)\.svg$/))) {
          const target = m[1] === 'counter' ? '/menu' : store.table(m[1]) ? `/t/${m[1]}?s=${store.sign(m[1])}` : null;
          return target ? send(res, 200, await qrSvg(origin(req) + target), { 'Content-Type': 'image/svg+xml' }) : send(res, 404, { error: 'No such table' });
        }
        if (req.method === 'POST' && p === '/api/demo/reset') {
          if (resets.hit(clientIp(req))) return send(res, 429, { error: 'Slow down' });
          store.seedDemo();
          return send(res, 200, { ok: true });
        }
      }
      if (req.method === 'GET' && PAGES[p]) return serveFile(res, PAGES[p]);
      if (req.method === 'GET' && (m = p.match(/^\/t\/(\d+)$/))) {
        // Static table QR: must carry a valid signature, otherwise it's a made-up URL.
        if (!store.table(m[1]) || !store.verify(m[1], url.searchParams.get('s'))) return send(res, 404, 'Invalid table link');
        deviceToken(req, res);
        return serveFile(res, 'table.html');
      }
      if (req.method === 'GET' && p.startsWith('/static/')) return serveFile(res, p.slice(8));
      if (req.method === 'GET' && p === '/api/menu') return send(res, 200, store.publicMenu());

      // ---- guest table API ----
      if ((m = p.match(/^\/api\/table\/(\d+)\/(enter|join|state|order|bill)$/))) {
        const [, id, action] = m;
        const tok = deviceToken(req, res);
        if (action === 'state' && req.method === 'GET') return send(res, 200, store.view(id, tok));
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
        const ip = clientIp(req);
        if (guestPosts.hit(ip) || (action === 'enter' && scans.hit(ip))) return send(res, 429, { error: 'Too many requests. Please wait a moment.' }, { 'Retry-After': '30' });
        const body = await readJson(req);
        if (action === 'enter') {
          if (!store.verify(id, body.s)) return send(res, 403, { error: 'Invalid table link' });
          return send(res, 200, store.enter(id, tok));
        }
        if (action === 'join') return reply(res, store.join(id, tok, body.code));
        if (action === 'order') return reply(res, store.placeOrder(id, tok, body.items));
        if (action === 'bill') {
          if (body.contact) { const c = store.setContact(id, tok, body.contact); if (c.ok === false) return reply(res, c); }
          return reply(res, store.requestBill(id, tok));
        }
      }

      if (p.startsWith('/api/admin/')) return await admin(req, res, url);
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
      if (!e.status) console.error(e);
    }
  });
}

if (require.main === module) {
  createServer().listen(config.port, () => {
    console.log(`Menu:  ${config.baseUrl}/menu\nStaff: ${config.baseUrl}/admin`);
    if (config.adminPasswordGenerated) console.warn(`No ADMIN_PASSWORD set. Temporary staff password for this run: ${config.adminPassword}`);
  });
}
module.exports = { createServer, limiter };
