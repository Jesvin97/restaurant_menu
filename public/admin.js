const app = document.getElementById('app');
let pw = sessionStorage.getItem('pw') || '', tab = 'orders', seen = null, timer, sound = true;
const call = (path, body) => api(path, body, { 'x-admin-password': pw });
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function beep() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)(), o = c.createOscillator();
    o.connect(c.destination); o.frequency.value = 880; o.start(); o.stop(c.currentTime + 0.25);
  } catch { /* audio blocked until the user interacts */ }
}

function login(msg) {
  clearInterval(timer);
  const inp = h('input', { type: 'password', placeholder: 'Staff password' });
  app.replaceChildren(h('div', { class: 'msg' }, h('p', { class: 'err' }, msg || ''), inp, h('p', {}, h('button', { class: 'btn', style: 'max-width:200px', onclick: () => { pw = inp.value; sessionStorage.setItem('pw', pw); start(); } }, 'Sign in'))));
}

const run = (fn) => async () => { try { await fn(); } catch (e) { alert(e.message); } load(); };
const post = (path, body = {}) => call(path, body);

function nav() {
  return h('div', { class: 'tabs' },
    ...[['orders', 'Live orders'], ['tables', 'Tables'], ['menu', 'Menu'], ['customers', 'Customers']].map(([k, l]) => h('button', { class: 'chip' + (tab === k ? ' on' : ''), onclick: () => { tab = k; load(); } }, l)),
    h('label', { class: 'sub', style: 'margin-left:auto;align-self:center' }, h('input', { type: 'checkbox', checked: sound ? '' : null, onchange: (e) => { sound = e.target.checked; } }), ' 🔔 sound'));
}

async function orders() {
  const d = await call('/api/admin/orders');
  const newest = Math.max(0, ...d.orders.map((o) => o.seq), ...d.billRequests.map((b) => b.seq || 0));
  if (seen !== null && newest > seen && sound) beep();
  const prevSeen = seen; seen = d.lastSeq;
  const btn = (o, status, text) => h('button', { class: 'btn small', onclick: run(() => post(`/api/admin/orders/${o.tableId}/${o.id}/status`, { status })) }, text);
  const card = (o) => h('div', { class: `ord s-${o.status}` + (prevSeen !== null && o.seq > prevSeen ? ' new' : '') },
    h('div', {}, h('b', {}, `Table ${o.tableId}`), o.customer && ` · ${o.customer}`, h('span', { class: 'tag' }, time(o.at))),
    ...o.items.map((i) => h('div', {}, dot(i.veg), ` ${i.qty} × ${i.name}`)),
    h('div', { class: 'row', style: 'margin-top:8px' }, o.status === 'new' ? btn(o, 'kitchen', '✓ Sent to kitchen') : null, o.status !== 'served' ? btn(o, 'served', 'Served') : null));
  const col = (title, st) => { const xs = d.orders.filter((o) => o.status === st); return xs.length || st !== 'served' ? [h('h2', {}, `${title} (${xs.length})`), ...xs.map(card)] : []; };
  return [
    ...d.billRequests.map((b) => h('div', { class: 'notice' }, h('span', {}, `🧾 Table ${b.tableId}${b.customer ? ' (' + b.customer + ')' : ''} asked for the bill · ${rupee(b.total)}`),
      h('button', { class: 'btn small warn', onclick: run(() => post(`/api/admin/tables/${b.tableId}/bill`)) }, 'Generate bill'))),
    ...d.restock.map((r) => h('div', { class: 'notice' }, h('span', {}, `🍽 ${r.name} was marked unavailable on ${r.since}. Show it on the menu again?`),
      h('button', { class: 'btn small', onclick: run(() => post('/api/admin/menu/restock', { itemId: r.itemId, bringBack: true })) }, 'Yes, bring back'),
      h('button', { class: 'chip small', onclick: run(() => post('/api/admin/menu/restock', { itemId: r.itemId, bringBack: false })) }, 'No, keep hidden'))),
    d.waiting.length ? h('div', { class: 'notice' }, `🔔 Guest waiting at table ${d.waiting.join(', ')} — open Tables to seat`) : null,
    ...col('New — tell the kitchen', 'new'), ...col('In kitchen', 'kitchen'), ...col('Served', 'served')];
}

async function tables() {
  const data = await call('/api/admin/tables');
  return [h('table', { class: 'a' }, h('tr', {}, ['Table', 'Status', 'Orders', 'Actions'].map((t) => h('th', {}, t))),
    ...data.tables.map((t) => {
      const s = t.session;
      const st = s && ({ open: 'Ordering', closing: '🧾 Bill requested', billed: 'Bill shown to guest' })[s.status];
      const status = s ? [st, h('span', { class: 'tag' }, 'code ' + s.code), h('span', { class: 'tag' }, s.devices + ' device(s)')] : [t.pending ? '🔔 Guest waiting' : 'Free'];
      const ords = s ? [...s.orders.map((o) => h('div', {}, h('small', {}, time(o.at) + ' '), o.items.map((i) => `${i.qty}× ${i.name}`).join(', '),
        h('button', { class: 'chip small', onclick: () => confirm('Void this order?') && run(() => post(`/api/admin/tables/${t.id}/void`, { orderId: o.id }))() }, 'void'))), h('b', {}, 'Total ' + rupee(s.bill.total))] : [];
      return h('tr', {}, h('td', {}, h('b', {}, t.id)), h('td', {}, status), h('td', {}, ords), h('td', {},
        !s && t.pending ? h('button', { class: 'btn small', onclick: run(() => post(`/api/admin/tables/${t.id}/seat`)) }, 'Seat guest') : null,
        s && s.status !== 'billed' && s.orders.length ? h('button', { class: 'btn small warn', onclick: run(() => post(`/api/admin/tables/${t.id}/bill`)) }, 'Generate bill') : null,
        s && s.status !== 'open' ? h('button', { class: 'chip small', onclick: run(() => post(`/api/admin/tables/${t.id}/reopen`)) }, 'Reopen') : null,
        s ? h('button', { class: 'btn small', onclick: () => confirm(`Mark table ${t.id} paid & close? Guests will no longer be able to order.`) && run(() => post(`/api/admin/tables/${t.id}/close`))() }, 'Paid & close') : null));
    }))];
}

async function menuTab() {
  const m = await call('/api/admin/menu');
  const result = h('div');
  const file = h('input', { type: 'file', accept: '.xlsx,.csv', class: 'file' });
  const send = async (apply) => {
    const f = file.files[0];
    if (!f) { result.textContent = 'Choose an .xlsx or .csv file first.'; return; }
    const kind = /\.csv$/i.test(f.name) ? 'csv' : 'xlsx';
    const r = await fetch(`/api/admin/menu/import?type=${kind}&apply=${apply ? 1 : 0}`, { method: 'POST', headers: { 'x-admin-password': pw, 'Content-Type': 'application/octet-stream' }, body: f });
    const j = await r.json();
    if (!r.ok) { result.replaceChildren(h('pre', { class: 'err', style: 'white-space:pre-wrap' }, j.error)); return; }
    if (apply) { alert(`Menu replaced: ${j.dishes} dishes.`); return load(); }
    result.replaceChildren(h('p', {}, `✔ ${j.dishes} dishes in ${j.categories.length} sections (${j.categories.join(', ')}). e.g. ${j.sample.join(', ')}…`),
      h('button', { class: 'btn warn', style: 'max-width:280px', onclick: () => confirm('Replace the whole current menu with this file?') && send(true) }, 'Replace my menu with this'));
  };
  const toggle = (i) => h('label', { class: 'chk' + (i.available ? '' : ' off') }, h('input', { type: 'checkbox', checked: i.available ? '' : null, onchange: run(() => post('/api/admin/menu/availability', { itemId: i.id, available: !i.available })) }),
    dot(i.veg), ` ${i.name}`, h('span', { class: 'sub' }, ' ' + i.options.map((o) => (o.label ? o.label + ' ' : '') + rupee(o.price)).join(' / ')));
  return [h('div', { class: 'bill', style: 'margin:0 0 16px' }, h('b', {}, 'Upload menu (Excel)'),
      h('p', { class: 'sub' }, 'Columns: Category, Name, Description, Type (Veg / Non-Veg), Half, Full (or a single Price), Allergens.'),
      h('a', { href: '#', onclick: async (e) => { e.preventDefault(); const r = await fetch('/api/admin/menu-template.csv', { headers: { 'x-admin-password': pw } }); h('a', { href: URL.createObjectURL(await r.blob()), download: 'menu-template.csv' }).click(); } }, 'Download template (opens in Excel)'),
      file, h('button', { class: 'btn', style: 'max-width:200px', onclick: () => send(false) }, 'Check file'), result),
    h('p', { class: 'sub' }, 'Untick a dish when it runs out — it disappears from guests\' menus straight away. Tomorrow you will be asked whether to bring it back.'),
    ...m.categories.flatMap((c) => [h('h2', {}, c.name), ...m.items.filter((i) => i.category === c.id).map(toggle)])];
}

async function customers() {
  const d = await call('/api/admin/customers');
  const download = (which) => async () => {
    const r = await fetch('/api/admin/customers.csv?for=' + which, { headers: { 'x-admin-password': pw } });
    const a = h('a', { href: URL.createObjectURL(await r.blob()), download: `customers-${which}.csv` }); a.click();
  };
  const review = (c) => {
    const msg = `Hi ${c.name}, thanks for dining at ${d.restaurant}! If you enjoyed it, we'd love a quick Google review: ${d.reviewUrl}`;
    return h('a', { class: 'chip small', target: '_blank', rel: 'noopener', href: `https://wa.me/${c.phone.slice(1)}?text=${encodeURIComponent(msg)}`, onclick: () => { post(`/api/admin/customers/${encodeURIComponent(c.phone)}/review-sent`).then(load); } }, c.reviewRequestedAt ? 'Resend review link' : 'Send review link');
  };
  return [h('p', { class: 'sub' }, 'Only guests who ticked a box can be contacted for that purpose. Review links open WhatsApp with the message pre-filled; you press send.'),
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('button', { class: 'chip', onclick: download('offers') }, '⬇ Offers-consented CSV (for ads)'), h('button', { class: 'chip', onclick: download('review') }, '⬇ Review-consented CSV'), h('button', { class: 'chip', onclick: download('all') }, '⬇ All (billing records)')),
    d.reviewUrl ? null : h('p', { class: 'err' }, 'Set GOOGLE_REVIEW_URL on the server to enable review links.'),
    h('table', { class: 'a' }, h('tr', {}, ['Guest', 'Visits', 'Consent', 'Actions'].map((t) => h('th', {}, t))),
      ...d.customers.map((c) => h('tr', {}, h('td', {}, h('b', {}, c.name), h('div', { class: 'sub' }, c.phone)), h('td', {}, `${c.visits} · ${rupee(c.spent)}`),
        h('td', {}, c.consentReview ? h('span', { class: 'tag' }, 'review') : null, c.consentOffers ? h('span', { class: 'tag' }, 'offers') : null, !c.consentReview && !c.consentOffers ? 'bill only' : null),
        h('td', {}, c.consentReview && d.reviewUrl ? review(c) : null, h('button', { class: 'chip small', onclick: () => confirm('Delete this guest\'s details?') && run(() => post(`/api/admin/customers/${encodeURIComponent(c.phone)}/delete`))() }, 'delete')))))];
}

async function load() {
  try {
    const body = await ({ orders, tables, menu: menuTab, customers }[tab])();
    app.replaceChildren(nav(), ...body.filter(Boolean));
  } catch (e) { if (e.status === 401) login(pw ? 'Wrong password' : ''); }
}
function start() { clearInterval(timer); load(); timer = setInterval(() => pw && (tab === 'orders' || tab === 'tables') && load(), 3000); }
start();
