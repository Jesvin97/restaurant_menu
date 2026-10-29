process.env.DEMO_MODE = '1';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { Store } = require('../src/store');
const { createServer } = require('../src/server');

const J = { 'Content-Type': 'application/json' };
async function run(fn) {
  const store = new Store();
  const srv = createServer(store).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn({ base, store }); } finally { srv.close(); }
}

test('demo: sandbox is seeded, public entry points work, and nothing touches disk', async () => {
  await run(async ({ base, store }) => {
    assert.equal(store.persist, false);
    assert.equal((await (await fetch(`${base}/api/info`)).json()).demo, true);
    assert.equal((await fetch(`${base}/demo`)).status, 200);
    const info = await (await fetch(`${base}/api/demo/info`)).json();
    assert.equal(info.password, 'demo');
    assert.equal(info.tables.length, 4);
    assert.equal((await fetch(`${base}${info.tables[0].url}`)).status, 200);          // signed table link from the demo page
    assert.match(await (await fetch(`${base}/api/demo/qr/counter.svg`)).text(), /^<svg/);
    assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).headers.get('location'), '/demo');
    assert.equal(store.adminOrders().billRequests.length, 1);                           // table 3 asks for the bill
  });
});

test('demo: a guest orders on table 1 with no staff and no code; a second visitor joins the same table', async () => {
  await run(async ({ base, store }) => {
    const sig = store.sign(1);
    const visit = async () => (await fetch(`${base}/t/1?s=${sig}`)).headers.get('set-cookie').split(';')[0];
    const post = (cookie, p, b) => fetch(base + p, { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify(b) });
    const a = await visit(), b = await visit();
    assert.equal((await (await post(a, '/api/table/1/enter', { s: sig })).json()).state, 'active');
    assert.equal((await (await post(b, '/api/table/1/enter', { s: sig })).json()).state, 'active');
    assert.equal((await post(b, '/api/table/1/order', { items: [{ id: 'masala-chai', qty: 1 }] })).status, 200);
  });
});

test('demo: staff can sign in with the public demo password, but import and settings are disabled', async () => {
  await run(async ({ base }) => {
    const { token } = await (await fetch(`${base}/api/admin/login`, { method: 'POST', headers: J, body: JSON.stringify({ password: 'demo' }) })).json();
    const A = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${base}/api/admin/orders`, { headers: A })).status, 200);
    assert.equal((await fetch(`${base}/api/admin/settings`, { method: 'POST', headers: { ...J, ...A }, body: '{"tableCount":50}' })).status, 403);
    assert.equal((await fetch(`${base}/api/admin/menu/import`, { method: 'POST', headers: { ...A, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('x') })).status, 403);
  });
});

test('demo: guest phone numbers are never kept, and reset restores the sample data', async () => {
  await run(async ({ base, store }) => {
    store.enter('1', 'A');
    store.setContact('1', 'A', { name: 'Tester', phone: '9876543210', offers: true });
    store.placeOrder('1', 'A', [{ id: 'masala-chai', qty: 1 }]);
    store.closeTable('1');
    assert.equal(store.customers().length, 0);
    assert.equal(store.state.history.length, 1);
    store.setAvailability('paneer-tikka', false);
    store.closeTable('2');
    assert.equal((await fetch(`${base}/api/demo/reset`, { method: 'POST', headers: J, body: '{}' })).status, 200);
    assert.equal(store.state.history.length, 0);
    assert.equal(store.publicMenu().items.some((i) => i.id === 'paneer-tikka'), true);
    assert.equal(store.table('2').session.orders.length, 2);                              // sample orders are back
    assert.equal(store.table('1').session, null);
    assert.equal(fs.existsSync(store.file) && store.file.includes('data'), false);        // no state file was written
  });
});
