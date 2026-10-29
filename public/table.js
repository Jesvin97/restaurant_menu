const tableId = location.pathname.split('/').pop();
const sig = new URLSearchParams(location.search).get('s') || '';
const app = document.getElementById('app'), dock = document.getElementById('dock');
document.getElementById('title').textContent = 'Table ' + tableId;
const cart = new Map();
let menu, view = { state: 'loading' }, poll, drawn = '', firstLoad = true;

const message = (title, text, ...extra) => { dock.hidden = true; app.replaceChildren(h('div', { class: 'msg' }, h('h2', {}, title), h('p', { class: 'sub' }, text), ...extra)); };

function codeForm() {
  const err = h('div', { class: 'err' });
  const inp = h('input', { inputmode: 'numeric', maxlength: 4, autocomplete: 'off', placeholder: '••••' });
  message('Table already open', 'Someone is already ordering at this table. Ask them for the 4-digit table code (or ask our staff).', inp,
    h('div', {}, h('button', { class: 'btn', style: 'margin-top:12px;max-width:240px', onclick: async () => {
      try { await api(`/api/table/${tableId}/join`, { code: inp.value.trim() }); refresh(); } catch (e) { err.textContent = e.message; }
    } }, 'Join table')), err);
}

function cartLines() { return [...cart].map(([id, qty]) => ({ id, qty })); }
function cartTotal() { return [...cart].reduce((a, [id, q]) => a + menu.items.find((i) => i.id === id).price * q, 0); }

function billCard(bill, final) {
  return h('div', { class: 'bill' }, h('h2', { style: 'margin-top:0' }, final ? 'Your bill' : 'Ordered so far'),
    h('table', {}, ...bill.items.map((l) => h('tr', {}, h('td', {}, dot(l.veg), ' ', `${l.qty} × ${l.name}`), h('td', {}, rupee(l.amount)))),
      h('tr', { class: 'tot' }, h('td', {}, 'Subtotal'), h('td', {}, rupee(bill.subtotal))),
      h('tr', {}, h('td', {}, `GST ${bill.taxPercent}%`), h('td', {}, rupee(bill.tax))),
      h('tr', { class: 'tot' }, h('td', {}, 'Total'), h('td', {}, rupee(bill.total)))));
}

function paintDock() {
  dock.hidden = view.state !== 'active';
  if (dock.hidden) return;
  const n = [...cart.values()].reduce((a, b) => a + b, 0);
  const busy = async (fn) => { try { await fn(); } catch (e) { alert(e.message); } refresh(); };
  const ordered = view.orders.length > 0;
  dock.replaceChildren(
    h('button', { class: 'btn sec', disabled: !n, onclick: () => busy(async () => { await api(`/api/table/${tableId}/order`, { items: cartLines() }); cart.clear(); }) }, n ? `Order now (${n})` : 'Select dishes'),
    h('button', { class: 'btn', disabled: !n && !ordered, onclick: () => {
      if (confirm('Generate the final bill? You can\'t order more after this.')) busy(async () => { await api(`/api/table/${tableId}/bill`, { items: cartLines() }); cart.clear(); });
    } }, n ? `Order & get bill · ${rupee(cartTotal())}` : 'Get bill'));
}

async function refresh() {
  try { view = await api(`/api/table/${tableId}/state`); } catch { return; }
  if (view.state !== 'closed') firstLoad = false;
  const key = JSON.stringify([view.state, view.orders, cart.size]);
  clearTimeout(poll);
  if (view.state === 'pending' || view.state === 'active' || view.state === 'needs_code') poll = setTimeout(refresh, 4000);
  if (view.state === 'active') {
    document.getElementById('sub').textContent = `Table code ${view.code} — share with others at your table`;
    if (drawn !== 'active') { renderMenu(app, menu, { cart, onChange: paintDock }); app.prepend(h('div', { id: 'ordered' })); drawn = 'active'; }
    const o = document.getElementById('ordered');
    o.replaceChildren(...(view.orders.length ? [billCard(view.bill, false)] : []));
    return paintDock();
  }
  drawn = view.state;
  document.getElementById('sub').textContent = '';
  if (view.state === 'billed') { dock.hidden = true; return app.replaceChildren(billCard(view.bill, true), h('div', { class: 'msg' }, h('p', {}, 'Please pay at the counter or show this to our staff. Thank you!'))); }
  if (view.state === 'pending') return message('Waiting for staff', 'A staff member will open your table in a moment. This page updates automatically.');
  if (view.state === 'needs_code') return codeForm();
  // Only a fresh page load (a real scan) may request a table; a page left open after payment must not.
  if (view.state === 'closed' && firstLoad) { firstLoad = false; return enter(); }
  message('Session ended', 'Please scan the QR code on your table again to start ordering.');
}

async function enter() {
  try { await api(`/api/table/${tableId}/enter`, { s: sig }); refresh(); } catch (e) { message('Invalid link', e.message); }
}

api('/api/menu').then((m) => { menu = m; refresh(); });
