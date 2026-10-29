process.env.TABLE_COUNT = '3';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../src/store');
const { createServer } = require('../src/server');

const mk = () => new Store('/dev/null', { persist: false });
const order = [{ id: 1, qty: 2 }];

test('guest cannot order until staff seats the table', () => {
  const s = mk();
  assert.equal(s.enter('1', 'A').state, 'pending');
  assert.equal(s.placeOrder('1', 'A', order).ok, false);
  assert.ok(s.seat('1').ok);
  assert.equal(s.view('1', 'A').state, 'active');
  assert.ok(s.placeOrder('1', 'A', order).ok);
});

test('after payment the old device cannot reorder or see the new party', () => {
  const s = mk();
  s.enter('1', 'A'); s.seat('1'); s.placeOrder('1', 'A', order); s.requestBill('1', 'A');
  s.closeTable('1');
  assert.equal(s.placeOrder('1', 'A', order).ok, false);
  // New party sits down.
  s.enter('1', 'B'); s.seat('1');
  // Old device is still not a member of the new session: no orders land on B's bill.
  assert.equal(s.placeOrder('1', 'A', order).ok, false);
  assert.equal(s.view('1', 'A').state, 'needs_code');
  assert.equal(s.view('1', 'B').bill.items.length, 0);
});

test('departed guest rescanning the static QR cannot open a table without staff', () => {
  const s = mk();
  s.enter('2', 'A'); s.seat('2'); s.closeTable('2');
  assert.equal(s.enter('2', 'A').state, 'pending');
  assert.equal(s.placeOrder('2', 'A', order).ok, false);
});

test('second device needs the table code; wrong codes lock out', () => {
  const s = mk();
  s.enter('1', 'A'); s.seat('1');
  assert.equal(s.enter('1', 'C').state, 'needs_code');
  for (let i = 0; i < 5; i++) assert.equal(s.join('1', 'C', 'xxxx').ok, false);
  assert.match(s.join('1', 'C', s.table('1').session.code).error, /Too many/);
  const s2 = mk();
  s2.enter('1', 'A'); s2.seat('1');
  assert.ok(s2.join('1', 'C', s2.table('1').session.code).ok);
  assert.ok(s2.placeOrder('1', 'C', order).ok);
});

test('billing locks ordering; totals use server prices', () => {
  const s = mk();
  s.enter('1', 'A'); s.seat('1');
  s.placeOrder('1', 'A', [{ id: 1, qty: 2 }, { id: 1, qty: 1 }]);
  const { bill } = s.requestBill('1', 'A');
  assert.equal(bill.items[0].qty, 3);
  assert.equal(bill.subtotal, bill.items[0].price * 3);
  assert.equal(bill.total, bill.subtotal + Math.round(bill.subtotal * 0.05));
  assert.equal(s.placeOrder('1', 'A', order).status, 409);
  assert.equal(s.placeOrder('1', 'A', [{ id: 9999, qty: 1 }]).ok, false);
});

test('idle sessions expire', () => {
  let now = 0;
  const s = new Store('/dev/null', { persist: false, now: () => now });
  s.enter('1', 'A'); s.seat('1');
  now += 5 * 3600e3;
  assert.equal(s.placeOrder('1', 'A', order).ok, false);
});

test('http: signed table link, cookies and admin auth', async () => {
  const store = mk();
  const srv = createServer(store).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(`${base}/t/1?s=bad`)).status, 404);
    const page = await fetch(`${base}/t/1?s=${store.sign(1)}`);
    assert.equal(page.status, 200);
    const cookie = page.headers.get('set-cookie').split(';')[0];
    const post = (p, b, h = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie, ...h }, body: JSON.stringify(b) });
    assert.equal((await (await post('/api/table/1/enter', { s: store.sign(1) })).json()).state, 'pending');
    assert.equal((await post('/api/table/1/enter', { s: 'nope' })).status, 403);
    assert.equal((await post('/api/admin/tables/1/seat', {})).status, 401);
    assert.equal((await post('/api/admin/tables/1/seat', {}, { 'x-admin-password': 'admin123' })).status, 200);
    const r = await post('/api/table/1/bill', { items: order });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).bill.items.length, 1);
    assert.equal((await fetch(`${base}/api/table/1/order`, { method: 'POST', body: '{}' })).status, 415);
  } finally { srv.close(); }
});
