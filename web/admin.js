const app = document.getElementById('app');
let token = null, tab = 'orders', seen = null, timer, sound = true;
try { token = sessionStorage.getItem('tok'); } catch { /* storage blocked: sign in each load */ }

const auth = () => ({ Authorization: `Bearer ${token}` });
const call = (path, body) => api(path, body, auth());
const post = (path, body = {}) => call(path, body);
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const stash = (v) => { token = v; try { v ? sessionStorage.setItem('tok', v) : sessionStorage.removeItem('tok'); } catch { /* ignore */ } };

function beep() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)(), o = c.createOscillator();
    o.connect(c.destination); o.frequency.value = 880; o.start(); o.stop(c.currentTime + 0.25);
  } catch { /* audio is blocked until the page has been tapped */ }
}

const tools = document.getElementById('tools');
function paintTools() {
  tools.replaceChildren(...(token ? [h('label', { class: 'snd sub' }, h('input', { type: 'checkbox', checked: sound ? '' : null, onchange: (e) => { sound = e.target.checked; } }), '🔔 sound'),
    h('button', { class: 'chip small', onclick: () => { stash(null); login(); } }, 'Sign out')] : []));
}

function login(msg) {
  clearInterval(timer);
  paintTools();
  const err = h('div', { class: 'err', role: 'alert' }, msg || '');
  const inp = h('input', { type: 'password', placeholder: 'Staff password', autocomplete: 'current-password', 'aria-label': 'Staff password' });
  const go = async () => {
    try { stash((await api('/api/admin/login', { password: inp.value })).token); start(); } catch (e) { err.textContent = e.message; }
  };
  inp.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  app.replaceChildren(h('div', { class: 'msg' }, h('h2', {}, 'Sign in'), inp, err, h('button', { class: 'btn narrow mt12', onclick: go }, 'Sign in')));
}

const run = (fn) => async () => { try { await fn(); } catch (e) { alert(e.message); } load(); };

function nav() {
  const tabs = [['orders', 'Orders'], ['tables', 'Tables'], ['menu', 'Menu'], ['guests', 'Guests'], ['setup', 'Setup']];
  return h('div', { class: 'tabs' },
    ...tabs.map(([k, l]) => h('button', { class: 'chip' + (tab === k ? ' on' : ''), onclick: () => { tab = k; load(); } }, l)));
}

async function orders() {
  const d = await call('/api/admin/orders');
  const newest = Math.max(0, ...d.orders.map((o) => o.seq), ...d.billRequests.map((b) => b.seq || 0));
  if (seen !== null && newest > seen && sound) beep();
  const prevSeen = seen; seen = d.lastSeq;
  const btn = (o, status, text) => h('button', { class: 'btn small', onclick: run(() => post(`/api/admin/orders/${o.tableId}/${o.id}/status`, { status })) }, text);
  const card = (o) => h('div', { class: 'card' + (o.status === 'new' ? ' hot' : '') + (prevSeen !== null && o.seq > prevSeen ? ' new' : '') },
    h('h3', {}, `Table ${o.tableId}`, o.customer && ` · ${o.customer}`, h('span', { class: 'tag' }, time(o.at))),
    ...o.items.map((i) => h('div', {}, dot(i.veg), ` ${i.qty} × ${i.name}`)),
    h('div', { class: 'actions' }, o.status === 'new' ? btn(o, 'kitchen', '✓ Sent to kitchen') : null, o.status !== 'served' ? btn(o, 'served', 'Served') : null));
  const col = (title, st) => {
    const xs = d.orders.filter((o) => o.status === st);
    return xs.length || st === 'new' ? [h('h2', {}, `${title} (${xs.length})`), h('div', { class: 'grid' }, ...xs.map(card))] : [];
  };
  return [
    ...d.billRequests.map((b) => h('div', { class: 'notice' }, h('span', {}, `🧾 Table ${b.tableId}${b.customer ? ' (' + b.customer + ')' : ''} asked for the bill · ${rupee(b.total)}`),
      h('button', { class: 'btn small warn', onclick: run(() => post(`/api/admin/tables/${b.tableId}/bill`)) }, 'Generate bill'))),
    ...d.restock.map((r) => h('div', { class: 'notice' }, h('span', {}, `🍽 ${r.name} was marked unavailable on ${r.since}. Show it on the menu again?`),
      h('button', { class: 'btn small', onclick: run(() => post('/api/admin/menu/restock', { itemId: r.itemId, bringBack: true })) }, 'Yes, bring back'),
      h('button', { class: 'chip small', onclick: run(() => post('/api/admin/menu/restock', { itemId: r.itemId, bringBack: false })) }, 'No, keep hidden'))),
    d.waiting.length ? h('div', { class: 'notice' }, h('span', {}, `🔔 Guest waiting at table ${d.waiting.join(', ')}`), h('button', { class: 'btn small', onclick: () => { tab = 'tables'; load(); } }, 'Open tables')) : null,
    ...col('New — tell the kitchen', 'new'), ...col('In kitchen', 'kitchen'), ...col('Served', 'served')];
}

async function tables() {
  const data = await call('/api/admin/tables');
  return [h('div', { class: 'grid' }, ...data.tables.map((t) => {
    const s = t.session;
    const title = h('h3', {}, `Table ${t.id}`, s ? h('span', { class: 'tag' }, `code ${s.code}`) : null, s ? h('span', { class: 'tag' }, `${s.devices} device${s.devices > 1 ? 's' : ''}`) : null);
    if (!s) {
      return h('div', { class: 'card' + (t.pending.length ? ' hot' : ' off') }, title,
        h('div', { class: 'sub' }, t.pending.length ? 'Guest waiting — seat the pairing code they show you:' : 'Free'),
        h('div', { class: 'actions' }, ...t.pending.map((label) => h('button', { class: 'btn small', onclick: run(() => post(`/api/admin/tables/${t.id}/seat`, { pairing: label })) }, `Seat ${label}`))));
    }
    const st = { open: 'Ordering', closing: '🧾 Bill requested', billed: 'Bill shown to guest' }[s.status];
    return h('div', { class: 'card' + (s.status === 'closing' ? ' hot' : '') }, title, h('div', {}, st),
      ...s.orders.map((o) => h('div', { class: 'sub' }, time(o.at) + ' · ' + o.items.map((i) => `${i.qty}× ${i.name}`).join(', '), ' ',
        h('button', { class: 'chip small', onclick: () => confirm('Void this order?') && run(() => post(`/api/admin/tables/${t.id}/void`, { orderId: o.id }))() }, 'void'))),
      h('b', {}, 'Total ' + rupee(s.bill.total)),
      h('div', { class: 'actions' },
        s.status !== 'billed' && s.orders.length ? h('button', { class: 'btn small warn', onclick: run(() => post(`/api/admin/tables/${t.id}/bill`)) }, 'Generate bill') : null,
        s.status !== 'open' ? h('button', { class: 'chip small', onclick: run(() => post(`/api/admin/tables/${t.id}/reopen`)) }, 'Reopen') : null,
        h('button', { class: 'btn small', onclick: () => confirm(`Mark table ${t.id} paid & close? Guests will no longer be able to order.`) && run(() => post(`/api/admin/tables/${t.id}/close`))() }, 'Paid & close')));
  }))];
}

async function downloadCsv(path, name) {
  const r = await fetch(path, { headers: auth() });
  if (!r.ok) return alert('Download failed');
  const a = h('a', { href: URL.createObjectURL(await r.blob()), download: name });
  document.body.append(a); a.click(); a.remove();
}

async function menuTab() {
  const m = await call('/api/admin/menu');
  const result = h('div');
  const file = h('input', { type: 'file', accept: '.xlsx,.csv', class: 'file', 'aria-label': 'Menu file' });
  const send = async (apply) => {
    const f = file.files[0];
    if (!f) { result.textContent = 'Choose an .xlsx or .csv file first.'; return; }
    const kind = /\.csv$/i.test(f.name) ? 'csv' : 'xlsx';
    const r = await fetch(`/api/admin/menu/import?type=${kind}&apply=${apply ? 1 : 0}`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/octet-stream' }, body: f });
    const j = await r.json();
    if (!r.ok) { result.replaceChildren(h('div', { class: 'err' }, j.error)); return; }
    if (apply) { alert(`Menu replaced: ${j.dishes} dishes.`); return load(); }
    result.replaceChildren(h('p', {}, `✔ ${j.dishes} dishes in ${j.categories.length} sections (${j.categories.join(', ')}). e.g. ${j.sample.join(', ')}…`),
      h('button', { class: 'btn warn', onclick: () => confirm('Replace the whole current menu with this file?') && send(true) }, 'Replace my menu with this'));
  };
  const toggle = (i) => h('label', { class: 'chk' + (i.available ? '' : ' off') },
    h('input', { type: 'checkbox', checked: i.available ? '' : null, onchange: run(() => post('/api/admin/menu/availability', { itemId: i.id, available: !i.available })) }),
    h('span', {}, dot(i.veg), ` ${i.name} `, h('span', { class: 'sub' }, i.options.map((o) => (o.label ? o.label + ' ' : '') + rupee(o.price)).join(' / '))));
  return [h('div', { class: 'card' }, h('h3', {}, 'Upload menu (Excel)'),
      h('div', { class: 'sub' }, 'Columns: Category, Name, Description, Type (Veg / Non-Veg), Half, Full (or a single Price), Allergens.'),
      h('button', { class: 'chip', onclick: () => downloadCsv('/api/admin/menu-template.csv', 'menu-template.csv') }, '⬇ Download template (opens in Excel)'),
      file, h('button', { class: 'btn narrow', onclick: () => send(false) }, 'Check file'), result),
    h('p', { class: 'sub' }, 'Untick a dish when it runs out — it disappears from guests\' menus straight away. Tomorrow you will be asked whether to bring it back.'),
    ...m.categories.flatMap((c) => [h('h2', {}, c.name), ...m.items.filter((i) => i.category === c.id).map(toggle)])];
}

async function guests() {
  const d = await call('/api/admin/customers');
  const review = (c) => {
    const msg = `Hi ${c.name}, thanks for dining at ${d.restaurant}! If you enjoyed it, we'd love a quick Google review: ${d.reviewUrl}`;
    return h('a', { class: 'chip small', target: '_blank', rel: 'noopener noreferrer', href: `https://wa.me/${c.phone.slice(1)}?text=${encodeURIComponent(msg)}`,
      onclick: () => { post(`/api/admin/customers/${encodeURIComponent(c.phone)}/review-sent`).then(load); } }, c.reviewRequestedAt ? 'Resend review link' : 'Send review link');
  };
  return [h('p', { class: 'sub' }, 'Only guests who ticked a box can be contacted for that purpose. Review links open WhatsApp with the message pre-filled; you press send.'),
    h('div', { class: 'row wrap' }, h('button', { class: 'chip', onclick: () => downloadCsv('/api/admin/customers.csv?for=offers', 'offers-consented.csv') }, '⬇ Offers (for ads)'),
      h('button', { class: 'chip', onclick: () => downloadCsv('/api/admin/customers.csv?for=review', 'review-consented.csv') }, '⬇ Review'),
      h('button', { class: 'chip', onclick: () => downloadCsv('/api/admin/customers.csv', 'all-guests.csv') }, '⬇ All (billing)')),
    d.reviewUrl ? null : h('p', { class: 'err' }, 'Set GOOGLE_REVIEW_URL on the server to enable review links.'),
    h('div', { class: 'grid mt12' }, ...d.customers.map((c) => h('div', { class: 'card' },
      h('h3', {}, c.name), h('div', { class: 'sub' }, c.phone), h('div', {}, `${c.visits} visit${c.visits > 1 ? 's' : ''} · ${rupee(c.spent)}`),
      h('div', {}, c.consentReview ? h('span', { class: 'tag' }, 'review') : null, c.consentOffers ? h('span', { class: 'tag' }, 'offers') : null, !c.consentReview && !c.consentOffers ? h('span', { class: 'sub' }, 'bill only') : null),
      h('div', { class: 'actions' }, c.consentReview && d.reviewUrl ? review(c) : null,
        h('button', { class: 'chip small', onclick: () => confirm('Delete this guest\'s details?') && run(() => post(`/api/admin/customers/${encodeURIComponent(c.phone)}/delete`))() }, 'Delete')))))];
}

let draftCount = null;
async function setup() {
  const s = await call('/api/admin/settings');
  if (draftCount === null) draftCount = s.tableCount;
  const count = h('b', {}, String(draftCount));
  const save = h('button', { class: 'btn small', onclick: run(async () => { await post('/api/admin/settings', { tableCount: draftCount }); draftCount = null; }) }, 'Save');
  const bump = (d) => () => { draftCount = Math.min(s.maxTables, Math.max(1, draftCount + d)); count.textContent = draftCount; save.disabled = draftCount === s.tableCount; };
  save.disabled = draftCount === s.tableCount;
  const grid = h('div', { class: 'qrgrid' });
  const addQr = async (label, file) => {
    const r = await fetch(`/api/admin/qr/${file}.svg`, { headers: auth() });
    if (!r.ok) return;
    grid.append(h('div', { class: 'qrcard' }, h('div', { class: 'qrtitle' }, label), h('img', { src: URL.createObjectURL(await r.blob()), alt: `QR code for ${label}` }), h('div', { class: 'qrcap' }, file === 'counter' ? 'Scan to see our menu' : 'Scan to order from your table')));
  };
  addQr('Counter menu', 'counter');
  for (let i = 1; i <= s.tableCount; i++) addQr(`Table ${i}`, String(i));
  const check = (good, text) => h('div', { class: good ? 'ok' : 'err' }, (good ? '✓ ' : '⚠ ') + text);
  const health = h('div', { class: 'card' }, h('h3', {}, 'Before you print (QR codes are permanent)'),
    check(s.secretFromEnv, s.secretFromEnv ? 'QR_SECRET is set on the server, so these codes survive restarts and redeploys.' : 'QR_SECRET is not set. The secret is only stored in the server\'s data file; if that is lost, every printed QR stops working. Set QR_SECRET first.'),
    check(!s.secretChangedAt, s.secretChangedAt ? `The QR secret changed on ${new Date(s.secretChangedAt).toLocaleDateString()}. QR codes printed before then no longer work.` : `Secret fingerprint ${s.fingerprint} — if this ever changes, printed codes break.`),
    check(s.hostKind === 'custom' || (s.baseUrlSet && s.hostKind !== 'local'), s.hostKind === 'local' ? `Codes point to ${s.baseUrl}, which only works on your own network. Use your public address.` : s.hostKind === 'vercel' && !s.baseUrlSet ? `Codes point to ${s.baseUrl}. A temporary address is fine for testing, but print only after you have a permanent domain (set BASE_URL) — the address is baked into every code.` : `Codes point to ${s.baseUrl}. Keep this address working for as long as the prints are in use.`),
    check(s.persisted, s.persisted ? 'Server can save its data.' : 'Server cannot save data, so orders and settings reset on restart (printed QR codes still work).'));
  return [health, h('div', { class: 'card mt8' }, h('h3', {}, 'Number of tables'),
      h('div', { class: 'stepper' }, h('button', { class: 'add', 'aria-label': 'Fewer tables', onclick: bump(-1) }, '−'), count, h('button', { class: 'add', 'aria-label': 'More tables', onclick: bump(1) }, '+'), save),
      h('div', { class: 'sub' }, 'Adding tables is instant. Removing only works for free tables, from the highest number down. New tables need their QR printed below.')),
    h('h2', {}, 'QR codes'), h('div', { class: 'sub' }, `Links point to ${s.baseUrl}. Set BASE_URL on the server if that's not your public address.`),
    h('button', { class: 'btn narrow mt8', onclick: () => window.print() }, 'Print all'), h('div', { class: 'mt12' }, grid)];
}

async function load() {
  try {
    const body = await ({ orders, tables, menu: menuTab, guests, setup }[tab])();
    // Keep a half-filled file picker / scroll position stable during the 3s refresh by only auto-refreshing live tabs.
    app.replaceChildren(nav(), ...body.filter(Boolean));
  } catch (e) {
    if (e.status === 401) { stash(null); login(token ? 'Session expired — please sign in again' : ''); } else console.error(e);
  }
}
function start() { clearInterval(timer); paintTools(); load(); timer = setInterval(() => (tab === 'orders' || tab === 'tables') && document.visibilityState === 'visible' && load(), 3000); }
token ? start() : login();
