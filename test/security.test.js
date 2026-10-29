process.env.TABLE_COUNT = '4';
process.env.ADMIN_PASSWORD = 'test-pass-123';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { createServer, limiter } = require('../src/server');
const { parseRows, parseCsv } = require('../src/menu');

const mk = (o) => new Store('/dev/null', { persist: false, ...o });
const J = { 'Content-Type': 'application/json' };

async function withServer(fn, { store = mk(), opts } = {}) {
  const srv = createServer(store, opts).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const login = async (password = 'test-pass-123') => fetch(`${base}/api/admin/login`, { method: 'POST', headers: J, body: JSON.stringify({ password }) });
  const auth = async () => ({ Authorization: `Bearer ${(await (await login()).json()).token}` });
  try { await fn({ base, store, login, auth }); } finally { srv.close(); }
}

test('every response carries security headers; CSP forbids inline script', async () => {
  await withServer(async ({ base, store }) => {
    for (const p of ['/menu', '/admin', '/static/common.js', '/api/menu', '/nope', `/t/1?s=${store.sign(1)}`]) {
      const r = await fetch(base + p, { redirect: 'manual' });
      assert.match(r.headers.get('content-security-policy'), /script-src 'self'/, p);
      assert.doesNotMatch(r.headers.get('content-security-policy'), /unsafe-inline|unsafe-eval/, p);
      assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
    }
  });
});

test('no page ships inline scripts or style attributes (CSP-clean)', () => {
  const dir = path.join(__dirname, '..', 'web');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (f.endsWith('.html')) {
      assert.doesNotMatch(src, /<script(?![^>]*\bsrc=)/i, `${f}: inline <script>`);
      assert.doesNotMatch(src, /<[^>]+\sstyle=/i, `${f}: style attribute`);
    }
    if (f.endsWith('.js')) {
      assert.doesNotMatch(src, /\bstyle:\s*['"]/, `${f}: style attribute set from JS`);
      assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(/, `${f}: unsafe DOM sink`);
    }
  }
});

test('all admin endpoints reject missing, malformed, tampered and expired tokens', async () => {
  let now = 1_700_000_000_000;
  await withServer(async ({ base, auth }) => {
    const routes = [['GET', '/api/admin/orders'], ['GET', '/api/admin/tables'], ['GET', '/api/admin/menu'], ['GET', '/api/admin/customers'], ['GET', '/api/admin/customers.csv'],
      ['GET', '/api/admin/settings'], ['GET', '/api/admin/qr/1.svg'], ['GET', '/api/admin/qr/counter.svg'], ['GET', '/api/admin/menu-template.csv'],
      ['POST', '/api/admin/settings'], ['POST', '/api/admin/tables/1/seat'], ['POST', '/api/admin/tables/1/bill'], ['POST', '/api/admin/tables/1/close'],
      ['POST', '/api/admin/menu/import'], ['POST', '/api/admin/menu/availability'], ['POST', '/api/admin/customers/+919876543210/delete']];
    const good = (await auth()).Authorization;
    const [exp, mac] = good.replace('Bearer ', '').split('.');
    const bad = [undefined, 'Bearer', 'Bearer x', `Bearer ${exp}.${'0'.repeat(64)}`, `Bearer ${Number(exp) + 99999}.${mac}`, `Basic ${mac}`, 'Bearer 1.' + mac];
    for (const [method, p] of routes) for (const a of bad) {
      const r = await fetch(base + p, { method, headers: { ...J, ...(a ? { Authorization: a } : {}) }, body: method === 'POST' ? '{}' : undefined });
      assert.equal(r.status, 401, `${method} ${p} with ${a}`);
    }
    assert.equal((await fetch(`${base}/api/admin/orders`, { headers: { Authorization: good } })).status, 200);
    now += 13 * 3600e3;                                                          // token lifetime is 12h
    assert.equal((await fetch(`${base}/api/admin/orders`, { headers: { Authorization: good } })).status, 401);
  }, { opts: { now: () => now } });
});

test('login: wrong password rejected, 8 failures lock out even the right password', async () => {
  await withServer(async ({ login }) => {
    for (let i = 0; i < 7; i++) assert.equal((await login('guess' + i)).status, 401);
    const eighth = await login('guess7');
    assert.equal(eighth.status, 429);
    assert.ok(Number(eighth.headers.get('retry-after')) > 0);
    assert.equal((await login()).status, 429);                                   // correct password still refused while locked
  });
});

test('login: success clears earlier failures; no password / junk body is a 401/400, not a crash', async () => {
  await withServer(async ({ base, login }) => {
    for (let i = 0; i < 5; i++) await login('nope');
    assert.equal((await login()).status, 200);
    for (const body of ['{}', '{"password":null}', '{"password":{"$ne":1}}', '{"password":["a"]}', '[]']) {
      const r = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: J, body });
      assert.ok([400, 401, 429].includes(r.status), `${body} -> ${r.status}`);
    }
    assert.equal((await fetch(`${base}/api/admin/login`, { method: 'POST', headers: J, body: '{bad' })).status, 400);
  });
});

test('cross-site POSTs are refused; same-site and non-browser calls work', async () => {
  await withServer(async ({ base }) => {
    const post = (origin) => fetch(`${base}/api/admin/login`, { method: 'POST', headers: { ...J, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ password: 'x' }) });
    assert.equal((await post('https://evil.example')).status, 403);
    assert.equal((await post('null')).status, 403);
    assert.equal((await post(base)).status, 401);
    assert.equal((await post()).status, 401);
    const form = await fetch(`${base}/api/table/1/enter`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(form.status, 415);                                             // simple-request content types can't reach JSON handlers
  });
});

test('path traversal and odd URLs never leak files', async () => {
  await withServer(async ({ base }) => {
    for (const p of ['/static/../src/store.js', '/static/%2e%2e/src/store.js', '/static/..%2fsrc%2fstore.js', '/static/%2e%2e%2f%2e%2e%2fpackage.json', '/static//etc/passwd', '/static/', '/static/style.css%00.js']) {
      const r = await fetch(base + p);
      const body = await r.text();
      assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
      assert.doesNotMatch(body, /require\(|"dependencies"|root:/, p);
    }
  });
});

test('table links are signed per table and cannot be transplanted', async () => {
  await withServer(async ({ base, store }) => {
    assert.equal((await fetch(`${base}/t/2?s=${store.sign(1)}`)).status, 404);
    assert.equal((await fetch(`${base}/t/99?s=${store.sign(99)}`)).status, 404);
    assert.equal((await fetch(`${base}/t/1`)).status, 404);
    assert.equal((await fetch(`${base}/t/1?s=${store.sign(1).toUpperCase()}`)).status, 404);
    assert.equal((await fetch(`${base}/t/1?s=${store.sign(1)}`)).status, 200);
  });
});

test('a session on one table gives no rights on another', () => {
  const s = mk();
  s.enter('1', 'A'); s.seat('1'); s.enter('2', 'B'); s.seat('2');
  assert.equal(s.placeOrder('2', 'A', [{ id: 'idli-3-pcs', qty: 1 }]).ok, false);
  assert.equal(s.view('2', 'A').state, 'needs_code');
  assert.equal(s.requestBill('2', 'A').ok, false);
  assert.equal(s.setContact('2', 'A', { name: 'x', phone: '9876543210' }).ok, false);
});

test('seating: pairing code decides the host; a remote flood cannot capture the table', () => {
  const s = mk();
  for (let i = 0; i < 30; i++) s.enter('1', 'attacker' + i);
  assert.equal(s.table('1').pending.length, 8);                                  // capped
  s.enter('1', 'realGuest');
  const label = s.view('1', 'realGuest').pairing;
  assert.match(label, /^[0-9A-F]{3}$/);
  assert.equal(s.seat('1').ok, false);                                           // several waiting: staff must choose
  assert.equal(s.seat('1', 'ZZZ').ok, false);
  assert.ok(s.seat('1', label.toLowerCase()).ok);
  assert.equal(s.view('1', 'realGuest').state, 'active');
  assert.equal(s.view('1', 'attacker29').state, 'needs_code');
});

test('number of tables: grow, bounds, shrink only when free, persists across restarts', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tbl-')), 'state.json');
  let s = new Store(file);
  assert.equal(s.tableCount, 4);
  for (const bad of [0, -1, 201, 1.5, NaN, '3', null, undefined]) assert.equal(s.setTableCount(bad).ok, false, String(bad));
  assert.ok(s.setTableCount(10).ok);
  assert.equal(s.tableCount, 10);
  s.enter('9', 'A'); s.seat('9');
  const blocked = s.setTableCount(5);
  assert.equal(blocked.status, 409);
  assert.match(blocked.error, /Table 9 is in use/);
  assert.equal(s.tableCount, 10);                                                 // nothing removed on failure
  s.closeTable('9');
  assert.ok(s.setTableCount(6).ok);
  assert.equal(s.table('7'), null);
  const sig = s.sign(3);
  s = new Store(file);
  assert.equal(s.tableCount, 6);                                                  // survived restart
  assert.equal(s.sign(3), sig);                                                   // QR signatures survived too
  assert.equal(fs.statSync(file).mode & 0o077, 0);                                // state file is private (phone numbers)
});

test('a corrupt state file is preserved, not overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cor-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"customers": {"+91');
  const origError = console.error; console.error = () => {};
  try { new Store(file); } finally { console.error = origError; }
  const kept = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), '{"customers": {"+91');
});

test('http: settings and QR endpoints', async () => {
  await withServer(async ({ base, store, auth }) => {
    const A = await auth();
    let r = await fetch(`${base}/api/admin/settings`, { headers: A });
    assert.equal((await r.json()).tableCount, 4);
    r = await fetch(`${base}/api/admin/settings`, { method: 'POST', headers: { ...J, ...A }, body: JSON.stringify({ tableCount: 7 }) });
    assert.equal(r.status, 200);
    assert.equal(store.tableCount, 7);
    r = await fetch(`${base}/api/admin/settings`, { method: 'POST', headers: { ...J, ...A }, body: JSON.stringify({ tableCount: 'lots' }) });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/admin/qr/7.svg`, { headers: A });
    assert.equal(r.headers.get('content-type'), 'image/svg+xml');
    assert.match(await r.text(), /^<svg/);
    assert.equal((await fetch(`${base}/api/admin/qr/8.svg`, { headers: A })).status, 404);
  });
});

test('fuzz: junk input to every guest endpoint never produces a 500', async () => {
  await withServer(async ({ base, store }) => {
    const bodies = ['{}', '[]', 'null', '"x"', '123', '{"items":"x"}', '{"items":[null]}', '{"items":[{"id":{"a":1},"qty":"9"}]}', '{"items":[{"id":"idli-3-pcs","qty":1e999}]}',
      '{"code":{"$gt":""}}', '{"contact":"x"}', '{"contact":{"name":{},"phone":[]}}', '{"s":[]}', '{"__proto__":{"polluted":1}}', '{"items":' + '['.repeat(500), '\u0000', ''];
    const cookie = (await fetch(`${base}/t/1?s=${store.sign(1)}`)).headers.get('set-cookie').split(';')[0];
    for (const action of ['enter', 'join', 'order', 'bill']) for (const b of bodies) {
      const r = await fetch(`${base}/api/table/1/${action}`, { method: 'POST', headers: { ...J, cookie }, body: b });
      assert.ok(r.status < 500, `${action} ${b.slice(0, 30)} -> ${r.status}`);
    }
    for (const p of ['/api/table/abc/state', '/api/table/1/nope', '/api/table/99999999999999999999/state', '/api/table//state', '/t/1e3', '/t/-1']) {
      assert.ok((await fetch(base + p)).status < 500, p);
    }
    assert.equal({}.polluted, undefined);
  });
});

test('oversized and malformed bodies are rejected cleanly', async () => {
  await withServer(async ({ base, auth }) => {
    assert.equal((await fetch(`${base}/api/table/1/order`, { method: 'POST', headers: J, body: 'x'.repeat(60_000) })).status, 413);
    const A = await auth();
    const big = await fetch(`${base}/api/admin/menu/import?apply=1`, { method: 'POST', headers: { ...A, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(3_100_000) });
    assert.equal(big.status, 413);
    const zip = await fetch(`${base}/api/admin/menu/import`, { method: 'POST', headers: { ...A, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('PK\u0003\u0004garbage') });
    assert.equal(zip.status, 422);
  });
});

test('order quantities: strict integer bounds, merged lines, 60-line cap', () => {
  const s = mk();
  s.enter('1', 'A'); s.seat('1');
  for (const qty of [0, -1, 21, 1.5, '2', NaN, Infinity, null, undefined, true, [1]]) assert.equal(s.placeOrder('1', 'A', [{ id: 'idli-3-pcs', qty }]).ok, false, String(qty));
  assert.equal(s.placeOrder('1', 'A', Array.from({ length: 61 }, () => ({ id: 'idli-3-pcs', qty: 1 }))).ok, false);
  assert.equal(s.placeOrder('1', 'A', 'idli').ok, false);
  assert.equal(s.placeOrder('1', 'A', [{ id: '__proto__', qty: 1 }]).ok, false);
  assert.equal(s.placeOrder('1', 'A', [{ id: 'idli-3-pcs', qty: 20 }]).ok, true);
  assert.equal(s.table('1').session.orders.length, 1);
});

test('concurrent orders from one table are all recorded, totals add up', async () => {
  await withServer(async ({ base, store }) => {
    const res = await fetch(`${base}/t/1?s=${store.sign(1)}`);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const post = (p, b) => fetch(base + p, { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify(b) });
    await post('/api/table/1/enter', { s: store.sign(1) });
    store.seat('1');
    const rs = await Promise.all(Array.from({ length: 50 }, () => post('/api/table/1/order', { items: [{ id: 'masala-chai', qty: 1 }] })));
    assert.ok(rs.every((r) => r.status === 200));
    const { bill } = store.generateBill('1');
    assert.equal(bill.items[0].qty, 50);
    assert.equal(bill.subtotal, 25 * 50);
  });
});

test('guest POST flood is rate limited per client IP', async () => {
  await withServer(async ({ base, store }) => {
    const cookie = (await fetch(`${base}/t/1?s=${store.sign(1)}`)).headers.get('set-cookie').split(';')[0];
    let limited = 0;
    for (let i = 0; i < 60; i++) {
      const r = await fetch(`${base}/api/table/1/enter`, { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify({ s: store.sign(1) }) });
      if (r.status === 429) limited++;
    }
    assert.ok(limited > 0);
    assert.equal((await fetch(`${base}/api/table/1/state`, { headers: { cookie } })).status, 200); // polling stays unaffected
  });
});

test('limiter: window resets, blocked() does not count', () => {
  let t = 0;
  const l = limiter(2, 1000, () => t);
  assert.equal(l.hit('a'), 0); assert.equal(l.hit('a'), 0);
  assert.ok(l.hit('a') > 0);
  assert.ok(l.blocked('a') > 0);
  assert.equal(l.hit('b'), 0);
  t = 1001;
  assert.equal(l.blocked('a'), 0);
  assert.equal(l.hit('a'), 0);
});

test('guest-supplied text is stripped of markup and control chars', () => {
  const s = mk();
  s.enter('1', 'A'); s.seat('1');
  s.setContact('1', 'A', { name: '<img src=x onerror=alert(1)>\u0007Bob', phone: '+91 98765 43210' });
  assert.equal(s.table('1').session.customer.name, 'img src=x onerror=alert(1)Bob');
  assert.equal(s.setContact('1', 'A', { name: '<>', phone: '9876543210' }).ok, false);
  assert.equal(s.setContact('1', 'A', { name: 'Bob', phone: '98765' }).ok, false);
});

test('phone numbers: accepted formats normalise, junk is refused', () => {
  const ok = { '9876543210': '+919876543210', '+91 98765-43210': '+919876543210', '09876543210': '+919876543210', '919876543210': '+919876543210', '(98765) 43210': '+919876543210' };
  for (const [raw, want] of Object.entries(ok)) assert.equal(Store.normalizePhone(raw), want, raw);
  for (const bad of ['', '12345', '5876543210', '98765432101', 'abcdefghij', null, undefined, {}, [], '+1 202 555 0100']) assert.equal(Store.normalizePhone(bad), null, String(bad));
});

test('menu import: hostile and edge-case sheets', () => {
  const parse = (csv) => parseRows(parseCsv(csv));
  const hdr = 'Category,Name,Description,Type,Half,Full,Allergens\n';
  let r = parse(hdr + 'A,=cmd|\' /C calc\'!A0,,Veg,,10,\n');
  assert.equal(r.menu.items[0].name.startsWith('='), true);                      // stored as text; CSV export neutralises it (see flow tests)
  r = parse(hdr + 'A,Dup,,Veg,,10,\nA,Dup,,Veg,,20,\nB,Dup,,Veg,,30,\n');
  assert.deepEqual(r.menu.items.map((i) => i.id), ['dup', 'dup-2', 'dup-3']);
  assert.equal(parse(hdr + 'A,Neg,,Veg,,-5,\n').errors.length, 1);
  assert.equal(parse(hdr + 'A,Zero,,Veg,,0,\n').errors.length, 1);
  assert.equal(parse(hdr + 'A,Huge,,Veg,,1e9,\n').errors.length, 1);
  assert.equal(parse(hdr + 'A,Text,,Veg,,abc,\n').errors.length, 1);
  assert.equal(parse(hdr + ',NoCat,,Veg,,5,\n').errors.length, 1);
  assert.equal(parse(hdr + 'A,Maybe,,Egg-ish,,5,\n').errors.length, 1);
  r = parse(hdr + 'A,Rupee,,Veg,,"₹1,250",\nA,Dec,,Veg,,99.5,\n');
  assert.deepEqual(r.menu.items.map((i) => i.options[0].price), [1250, 99.5]);
  r = parse('﻿category,ITEM,type,price\r\nA,Bom,veg,5\r\n');                 // BOM, CRLF, other header names/case
  assert.equal(r.menu.items.length, 1);
  assert.equal(parse('').errors.length > 0, true);
  assert.equal(parse(hdr).errors[0], 'No dishes found in the file');
  const many = hdr + Array.from({ length: 1001 }, (_, i) => `A,D${i},,Veg,,5,`).join('\n');
  assert.match(parse(many).errors.join(), /Too many/);
  r = parse(hdr + 'A,Long,' + 'x'.repeat(500) + ',Veg,,5,' + 'a,'.repeat(40).slice(0, -1) + '\n');
  assert.equal(r.menu.items[0].description.length, 200);
  assert.ok(r.menu.items[0].allergens.length <= 12);
});

test('importing a menu drops availability flags for dishes that no longer exist', () => {
  const s = mk();
  s.setAvailability('paneer-tikka', false);
  s.setMenu(parseRows(parseCsv('Category,Name,Type,Price\nA,Soup,Veg,50\n')).menu);
  assert.deepEqual(s.state.unavailable, {});
  assert.equal(s.publicMenu().items.length, 1);
});

test('idle expiry also clears stale pairing requests', () => {
  let now = 0;
  const s = new Store('/dev/null', { persist: false, now: () => now });
  s.enter('1', 'A');
  now += 16 * 60e3;
  assert.equal(s.view('1', 'A').state, 'closed');
  assert.equal(s.adminTables().find((t) => t.id === '1').pending.length, 0);
});

test('tax and totals: integer rupees, rounding half up, no float drift', () => {
  const s = mk();
  s.enter('1', 'A'); s.seat('1');
  s.placeOrder('1', 'A', [{ id: 'masala-chai', qty: 3 }, { id: 'idli-3-pcs', qty: 1 }]);   // 3*25 + 60 = 135 -> 5% = 6.75 -> 7
  const b = s.generateBill('1').bill;
  assert.deepEqual([b.subtotal, b.tax, b.total], [135, 7, 142]);
  assert.ok(Number.isInteger(b.tax));
});

test('an unwritable state path does not crash startup or requests', () => {
  const origError = console.error; const logs = [];
  console.error = (m) => logs.push(m);
  try {
    const s = new Store('/etc/hostname/data/state.json');        // parent is a file -> mkdir fails, like a read-only serverless disk
    s.enter('1', 'A'); s.seat('1');
    assert.ok(s.placeOrder('1', 'A', [{ id: 'idli-3-pcs', qty: 1 }]).ok);   // still works from memory
    assert.equal(logs.filter((l) => /cannot save state/.test(l)).length, 1); // warned once, not per request
  } finally { console.error = origError; }
});

test('printed QR codes keep working: same secret -> same links, even with all data wiped', () => {
  const config = require('../src/config');
  const before = config.qrSecret;
  config.qrSecret = 'a-long-fixed-secret-for-printing';
  try {
    const a = new Store('/dev/null', { persist: false });
    const link = a.sign(5);
    a.setTableCount(1);                                           // table 5 removed...
    a.setTableCount(8);                                           // ...and re-added later
    assert.equal(a.sign(5), link);
    const b = new Store('/dev/null', { persist: false });         // fresh server, no state at all
    assert.equal(b.sign(5), link);
    assert.ok(b.verify(5, link));
    assert.equal(b.qrHealth().secretFromEnv, true);
  } finally { config.qrSecret = before; }
});

test('changing the QR secret is detected and reported', () => {
  const config = require('../src/config');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrs-')), 'state.json');
  const origError = console.error; console.error = () => {};
  const before = config.qrSecret;
  try {
    config.qrSecret = 'first-secret-value';
    const s1 = new Store(file);
    assert.equal(s1.qrHealth().secretChangedAt, null);
    new Store(file);                                              // restart, same secret: no alarm
    assert.equal(new Store(file).qrHealth().secretChangedAt, null);
    config.qrSecret = 'second-secret-value';
    const s2 = new Store(file);
    assert.ok(s2.qrHealth().secretChangedAt);
    assert.equal(s2.verify(1, s1.sign(1)), false);                // old printed code is now invalid...
    assert.ok(new Store(file).qrHealth().secretChangedAt);        // ...and the warning persists across restarts
  } finally { config.qrSecret = before; console.error = origError; }
});

test('http: settings reports whether the QR setup is safe to print', async () => {
  await withServer(async ({ base, auth }) => {
    const s = await (await fetch(`${base}/api/admin/settings`, { headers: await auth() })).json();
    assert.equal(s.hostKind, 'local');
    assert.match(s.fingerprint, /^[0-9a-f]{6}$/);
    assert.equal(s.secretChangedAt, null);
  });
});

test('serverless entry: start-up failures become readable responses, not opaque 500s', async () => {
  const config = require('../src/config');
  const { makeHandler } = require('../src/vercel');
  const call = async (handler) => {
    const srv = require('http').createServer(handler).listen(0);
    try { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/menu`); return { status: r.status, body: await r.text() }; } finally { srv.close(); }
  };
  const origError = console.error; console.error = () => {};
  try {
    const crashed = await call(makeHandler(() => { throw Object.assign(new Error('boom'), { code: 'EROFS' }); }));
    assert.equal(crashed.status, 500);
    assert.match(crashed.body, /Startup failed: EROFS: boom/);
    const ok = await call(makeHandler(() => createServer(mk())));
    assert.equal(ok.status, 200);
    assert.match(ok.body, /categories/);
    config.missingEnv.push('ADMIN_PASSWORD');
    try {
      const unconfigured = await call(makeHandler());
      assert.equal(unconfigured.status, 503);
      assert.match(unconfigured.body, /ADMIN_PASSWORD/);
    } finally { config.missingEnv.pop(); }
  } finally { console.error = origError; }
});
