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
    ...[['orders', 'Live orders'], ['tables', 'Tables'], ['customers', 'Customers']].map(([k, l]) => h('button', { class: 'chip' + (tab === k ? ' on' : ''), onclick: () => { tab = k; load(); } }, l)),
    h('label', { class: 'sub', style: 'margin-left:auto;align-self:center' }, h('input', { type: 'checkbox', checked: sound ? '' : null, onchange: (e) => { sound = e.target.checked; } }), ' 🔔 sound'));
}

async function orders() {
  const d = await call('/api/admin/orders');
  const fresh = seen !== null && d.orders.some((o) => o.seq > seen);
  const waiting = d.waiting.length;
  if (fresh && sound) beep();
  const prevSeen = seen; seen = d.lastSeq;
  const btn = (o, status, label) => h('button', { class: 'btn small', onclick: run(() => post(`/api/admin/orders/${o.tableId}/${o.id}/status`, { status })) }, label);
  const card = (o) => h('div', { class: `ord s-${o.status}` + (prevSeen !== null && o.seq > prevSeen ? ' new' : '') },
    h('div', {}, h('b', {}, `Table ${o.tableId}`), o.customer && ` · ${o.customer}`, h('span', { class: 'tag' }, time(o.at))),
    ...o.items.map((i) => h('div', {}, dot(i.veg), ` ${i.qty} × ${i.name}`)),
    h('div', { class: 'row', style: 'margin-top:8px' }, o.status === 'new' ? btn(o, 'kitchen', '✓ Sent to kitchen') : null, o.status !== 'served' ? btn(o, 'served', 'Served') : null));
  const col = (title, st) => [h('h2', {}, `${title} (${d.orders.filter((o) => o.status === st).length})`), ...d.orders.filter((o) => o.status === st).map(card)];
  return [waiting ? h('div', { class: 'ord s-new' }, `🔔 Guest waiting at table ${d.waiting.join(', ')} — open the Tables tab to seat`) : null,
    ...col('New — tell the kitchen', 'new'), ...col('In kitchen', 'kitchen'), ...col('Served (until table is closed)', 'served')];
}

async function tables() {
  const data = await call('/api/admin/tables');
  return [h('table', { class: 'a' }, h('tr', {}, ['Table', 'Status', 'Orders', 'Actions'].map((t) => h('th', {}, t))),
    ...data.tables.map((t) => {
      const s = t.session;
      const status = s ? [s.status === 'billed' ? 'Bill generated' : 'Ordering', h('span', { class: 'tag' }, 'code ' + s.code), h('span', { class: 'tag' }, s.devices + ' device(s)')] : [t.pending ? '🔔 Guest waiting' : 'Free'];
      const ords = s ? [...s.orders.map((o) => h('div', {}, h('small', {}, time(o.at) + ' '), o.items.map((i) => `${i.qty}× ${i.name}`).join(', '),
        h('button', { class: 'chip small', onclick: () => confirm('Void this order?') && run(() => post(`/api/admin/tables/${t.id}/void`, { orderId: o.id }))() }, 'void'))), h('b', {}, 'Total ' + rupee(s.bill.total))] : [];
      return h('tr', {}, h('td', {}, h('b', {}, t.id)), h('td', {}, status), h('td', {}, ords), h('td', {},
        !s && t.pending ? h('button', { class: 'btn small', onclick: run(() => post(`/api/admin/tables/${t.id}/seat`)) }, 'Seat guest') : null,
        s && s.status === 'billed' ? h('button', { class: 'chip small', onclick: run(() => post(`/api/admin/tables/${t.id}/reopen`)) }, 'Reopen') : null,
        s ? h('button', { class: 'btn small', onclick: () => confirm(`Mark table ${t.id} paid & close? Guests will no longer be able to order.`) && run(() => post(`/api/admin/tables/${t.id}/close`))() }, 'Paid & close') : null));
    }))];
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
    const body = await ({ orders, tables, customers }[tab])();
    app.replaceChildren(nav(), ...body.filter(Boolean));
  } catch (e) { if (e.status === 401) login(pw ? 'Wrong password' : ''); }
}
function start() { clearInterval(timer); load(); timer = setInterval(() => pw && tab !== 'customers' && load(), 3000); }
start();
