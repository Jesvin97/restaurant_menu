const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { Store } = require('./store');
const { parseRows, parseCsv, normalize, TEMPLATE_CSV } = require('./menu');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };
const PAGES = { '/menu': 'menu.html', '/admin': 'admin.html' };

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
      ws.eachRow({ includeEmpty: false }, (row) => {
        const vals = row.values.slice(1).map((v) => (v && typeof v === 'object' ? (v.result ?? v.text ?? (v.richText ? v.richText.map((x) => x.text).join('') : '')) : v));
        rows.push(vals);
      });
    }
    return parseRows(rows);
  } catch {
    return { errors: ['Could not read the file. Upload an .xlsx or .csv exported from Excel.'] };
  }
}

function createServer(store = new Store()) {
  const send = (res, code, body, headers = {}) => {
    const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
    res.writeHead(code, {
      'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
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

  const isAdmin = (req) => {
    const given = Buffer.from(String(req.headers['x-admin-password'] || ''));
    const want = Buffer.from(config.adminPassword);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  };

  async function readJson(req) {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) throw Object.assign(new Error('JSON required'), { status: 415 });
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > 50e3) throw Object.assign(new Error('Too large'), { status: 413 }); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
  }

  async function readBuffer(req, max) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error('File too large (max 3 MB)'), { status: 413 }); chunks.push(c); }
    return Buffer.concat(chunks);
  }

  const reply = (res, r) => (r.ok === false ? send(res, r.status || 400, { error: r.error }) : send(res, 200, r));

  function serveFile(res, file) {
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(full).pipe(res);
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      let m;

      if (req.method === 'GET' && p === '/') { res.writeHead(302, { Location: '/menu' }); return res.end(); }
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
      if ((m = p.match(/^\/api\/table\/(\d+)\/(enter|join|state|order|bill|contact)$/))) {
        const [, id, action] = m;
        const tok = deviceToken(req, res);
        if (action === 'state' && req.method === 'GET') return send(res, 200, store.view(id, tok));
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
        const body = await readJson(req);
        if (action === 'enter') {
          if (!store.verify(id, body.s)) return send(res, 403, { error: 'Invalid table link' });
          return send(res, 200, store.enter(id, tok));
        }
        if (action === 'join') return reply(res, store.join(id, tok, body.code));
        if (action === 'order') return reply(res, store.placeOrder(id, tok, body.items));
        if (action === 'contact') return reply(res, store.setContact(id, tok, body.contact));
        if (action === 'bill') {
          if (body.contact) { const c = store.setContact(id, tok, body.contact); if (c.ok === false) return reply(res, c); }
          if (Array.isArray(body.items) && body.items.length) {
            const o = store.placeOrder(id, tok, body.items);
            if (o.ok === false) return reply(res, o);
          }
          return reply(res, store.requestBill(id, tok));
        }
      }

      // ---- staff API ----
      if (p.startsWith('/api/admin/')) {
        if (!isAdmin(req)) return send(res, 401, { error: 'Unauthorized' });
        if (req.method === 'GET' && p === '/api/admin/tables') return send(res, 200, { tables: store.adminTables(), baseUrl: config.baseUrl });
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
          const r = await parseUpload(await readBuffer(req, 3e6), kind);
          if (r.errors.length) return send(res, 422, { error: r.errors.slice(0, 10).join('\n'), errors: r.errors.slice(0, 50) });
          const summary = { dishes: r.menu.items.length, categories: r.menu.categories.map((c) => c.name), sample: r.menu.items.slice(0, 5).map((i) => i.name) };
          if (url.searchParams.get('apply') === '1') store.setMenu(normalize(r.menu));
          return send(res, 200, { ok: true, applied: url.searchParams.get('apply') === '1', ...summary });
        }
        if (req.method === 'GET' && p === '/api/admin/orders') return send(res, 200, store.adminOrders());
        if (req.method === 'GET' && p === '/api/admin/customers') return send(res, 200, { customers: store.customers(), reviewUrl: config.googleReviewUrl, restaurant: config.restaurantName });
        if (req.method === 'GET' && p === '/api/admin/customers.csv') {
          const only = url.searchParams.get('for'); // 'offers' | 'review' | all
          const rows = store.customers().filter((c) => only === 'offers' ? c.consentOffers : only === 'review' ? c.consentReview : true);
          return send(res, 200, toCsv(rows), { 'Content-Type': 'text/csv; charset=utf-8' });
        }
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
          if (act === 'seat') return reply(res, store.seat(id));
          if (act === 'bill') return reply(res, store.generateBill(id));
          if (act === 'close') return reply(res, store.closeTable(id));
          if (act === 'reopen') return reply(res, store.reopen(id));
          return reply(res, store.voidOrder(id, body.orderId));
        }
      }
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
    if (config.adminPassword === 'admin123') console.warn('WARNING: using default ADMIN_PASSWORD; set ADMIN_PASSWORD in production.');
  });
}
module.exports = { createServer };
