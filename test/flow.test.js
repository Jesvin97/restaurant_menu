process.env.TABLE_COUNT = '3';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../src/store');
const { createServer } = require('../src/server');

const mk = () => new Store('/dev/null', { persist: false });
const order = [{ id: 'idli-3-pcs', qty: 2 }];

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
  s.enter('1', 'A'); s.seat('1'); s.placeOrder('1', 'A', order); s.requestBill('1', 'A'); s.generateBill('1');
  s.closeTable('1');
  assert.equal(s.placeOrder('1', 'A', order).ok, false);
  // New party sits down.
  s.enter('1', 'B'); s.seat('1');
  // Old device is still not a member of the new session: no orders land on B's bill.
  assert.equal(s.placeOrder('1', 'A', order).ok, false);
  assert.equal(s.view('1', 'A').state, 'needs_code');
  assert.equal(s.view('1', 'B').orders.length, 0);
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

test('guest never sees prices or totals until the counter generates the bill', () => {
  const s = mk();
  s.enter('1', 'A'); s.seat('1');
  s.placeOrder('1', 'A', [{ id: 'idli-3-pcs', qty: 2 }, { id: 'idli-3-pcs', qty: 1 }]);
  let v = s.view('1', 'A');
  assert.equal(v.bill, undefined);
  assert.equal(JSON.stringify(v).includes('price'), false);
  assert.equal(v.orders[0].items[0].qty, 3);
  assert.ok(s.requestBill('1', 'A').ok);               // guest asks -> counter is notified
  v = s.view('1', 'A');
  assert.equal(v.state, 'closing');
  assert.equal(v.bill, undefined);
  assert.equal(s.adminOrders().billRequests[0].tableId, '1');
  assert.equal(s.placeOrder('1', 'A', order).status, 409);
  const { bill } = s.generateBill('1');                 // counter reveals the total
  assert.equal(bill.items[0].qty, 3);
  assert.equal(bill.total, bill.subtotal + Math.round(bill.subtotal * 0.05));
  v = s.view('1', 'A');
  assert.equal(v.state, 'billed');
  assert.equal(v.bill.total, bill.total);
  assert.equal(s.placeOrder('1', 'A', [{ id: 'nope', qty: 1 }]).ok, false);
});

test('half/full options are priced by the server', () => {
  const s = mk();
  s.enter('1', 'A'); s.seat('1');
  assert.ok(s.placeOrder('1', 'A', [{ id: 'chicken-dum-biryani', opt: 'half', qty: 1 }, { id: 'chicken-dum-biryani', opt: 'full', qty: 2 }]).ok);
  const b = s.generateBill('1').bill;
  assert.deepEqual(b.items.map((i) => [i.name, i.qty, i.price]), [['Chicken Dum Biryani (Half)', 1, 160], ['Chicken Dum Biryani (Full)', 2, 240]]);
  assert.equal(s.placeOrder('1', 'A', [{ id: 'chicken-dum-biryani', opt: 'jumbo', qty: 1 }]).ok, false);
});

test('unavailable dishes vanish, cannot be ordered, and staff are asked next day', () => {
  let now = Date.parse('2026-01-10T10:00:00Z');
  const s = new Store('/dev/null', { persist: false, now: () => now });
  s.enter('1', 'A'); s.seat('1');
  s.setAvailability('paneer-tikka', false);
  assert.equal(s.publicMenu().items.some((i) => i.id === 'paneer-tikka'), false);
  assert.equal(s.adminMenu().items.find((i) => i.id === 'paneer-tikka').available, false);
  assert.equal(s.placeOrder('1', 'A', [{ id: 'paneer-tikka', qty: 1 }]).status, 409);
  assert.equal(s.restockNotices().length, 0);            // same day: no prompt
  now += 24 * 3600e3;
  assert.equal(s.restockNotices()[0].name, 'Paneer Tikka');
  s.answerRestock('paneer-tikka', false);                // "no" -> stays hidden, no more prompts
  assert.equal(s.restockNotices().length, 0);
  assert.equal(s.publicMenu().items.some((i) => i.id === 'paneer-tikka'), false);
  s.setAvailability('chilli-paneer', false); now += 24 * 3600e3;
  s.answerRestock('chilli-paneer', true);                // "yes" -> back on the list
  assert.equal(s.publicMenu().items.some((i) => i.id === 'chilli-paneer'), true);
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
    assert.equal((await r.json()).bill, undefined);       // guests get no total from this call
    assert.equal((await fetch(`${base}/api/table/1/order`, { method: 'POST', body: '{}' })).status, 415);
  } finally { srv.close(); }
});

test('order feed: new orders appear for staff with status workflow', () => {
  const s = mk();
  s.enter('1', 'A'); s.seat('1'); s.enter('2', 'B'); s.seat('2');
  s.placeOrder('1', 'A', order); s.placeOrder('2', 'B', [{ id: 'poori-bhaji', qty: 1 }]);
  const f = s.adminOrders();
  assert.deepEqual(f.orders.map((o) => [o.tableId, o.status]), [['1', 'new'], ['2', 'new']]);
  assert.ok(s.setOrderStatus('1', f.orders[0].id, 'kitchen').ok);
  assert.equal(s.view('1', 'A').orders[0].status, 'kitchen');
  assert.equal(s.setOrderStatus('1', f.orders[0].id, 'bogus').ok, false);
});

test('contact details: validated, consent-gated, saved on payment, deletable', () => {
  const s = mk();
  s.enter('1', 'A'); s.seat('1'); s.placeOrder('1', 'A', order);
  assert.equal(s.setContact('1', 'A', { name: 'Asha', phone: '12345' }).ok, false);
  assert.ok(s.setContact('1', 'A', { name: 'Asha <b>', phone: '+91 98765-43210', review: true }).ok);
  assert.equal(s.requestBill('1', 'A').ok, true);
  assert.equal(s.view('1', 'A').customer.name, 'Asha b');
  s.generateBill('1'); s.closeTable('1');
  const [c] = s.customers();
  assert.equal(c.phone, '+919876543210');
  assert.equal(c.consentReview, true);
  assert.equal(c.consentOffers, false); // never defaulted on
  assert.equal(c.visits, 1);
  s.deleteCustomer(c.phone);
  assert.equal(s.customers().length, 0);
  assert.equal(s.state.history[0].customerPhone, undefined);
});

test('http: customers CSV needs staff auth and neutralises formulas', async () => {
  const store = mk();
  store.state.customers['+919876543210'] = { phone: '+919876543210', name: '=HYPERLINK("x")', consentOffers: true, consentReview: false, visits: 1, spent: 100, lastVisit: 0 };
  const srv = createServer(store).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api/admin/customers.csv?for=offers`;
  try {
    assert.equal((await fetch(base)).status, 401);
    const txt = await (await fetch(base, { headers: { 'x-admin-password': 'admin123' } })).text();
    assert.match(txt, /"'=HYPERLINK/);
    assert.match(txt, /\+919876543210/);
  } finally { srv.close(); }
});

const { parseRows, parseCsv } = require('../src/menu');

test('menu import: half/full, veg/non-veg, allergens, and clear errors', () => {
  const csv = 'Category,Name,Description,Type,Half,Full,Allergens\nBiryani,Chicken Biryani,"Spicy, dum",Non-Veg,160,240,"dairy; Tree Nut"\nBreads,Naan,,veg,,40,gluten\nBreads,Bad,,maybe,,40,\nBreads,Free,,veg,,,\n';
  const r = parseRows(parseCsv(csv));
  assert.equal(r.menu.items.length, 2);
  const b = r.menu.items[0];
  assert.deepEqual(b.options.map((o) => [o.label, o.price]), [['Half', 160], ['Full', 240]]);
  assert.deepEqual(b.allergens, ['dairy', 'tree-nut']);
  assert.equal(b.description, 'Spicy, dum');
  assert.deepEqual(r.menu.items[1].options, [{ id: 'full', label: '', price: 40 }]);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /Row 4/);
  assert.match(parseRows([['Name']]).errors.join(), /Missing column/);
});

test('http: xlsx upload previews, then applies; guests see the new menu', async () => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Menu');
  ws.addRow(['Category', 'Name', 'Description', 'Type', 'Half', 'Full', 'Allergens']);
  ws.addRow(['Special', 'Kerala Fish Fry', 'Crisp', 'Non-Veg', 120, 200, 'fish']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const store = mk();
  const srv = createServer(store).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const H = { 'x-admin-password': 'admin123', 'Content-Type': 'application/octet-stream' };
  try {
    assert.equal((await fetch(`${base}/api/admin/menu/import`, { method: 'POST', body: buf })).status, 401);
    let r = await fetch(`${base}/api/admin/menu/import`, { method: 'POST', headers: H, body: buf });
    assert.equal((await r.json()).applied, false);
    assert.equal((await (await fetch(`${base}/api/menu`)).json()).items.length, 44);   // preview changed nothing
    r = await fetch(`${base}/api/admin/menu/import?apply=1`, { method: 'POST', headers: H, body: buf });
    assert.equal((await r.json()).applied, true);
    const m = await (await fetch(`${base}/api/menu`)).json();
    assert.equal(m.items.length, 1);
    assert.equal(m.items[0].options.length, 2);
    r = await fetch(`${base}/api/admin/menu/import`, { method: 'POST', headers: H, body: Buffer.from('not an xlsx') });
    assert.equal(r.status, 422);
  } finally { srv.close(); }
});
