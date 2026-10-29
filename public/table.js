const tableId = location.pathname.split('/').pop();
const sig = new URLSearchParams(location.search).get('s') || '';
const app = document.getElementById('app'), dock = document.getElementById('dock');
document.getElementById('title').textContent = 'Table ' + tableId;
const cart = new Map();   // "dishId|optionId" -> qty
let menu, view = { state: 'loading' }, poll, drawn = '', firstLoad = true, busy = false;

const message = (title, text, ...extra) => { dock.hidden = true; drawn = ''; app.replaceChildren(h('div', { class: 'msg' }, h('h2', {}, title), h('p', { class: 'sub' }, text), ...extra)); };
const label = { new: 'Received', kitchen: 'Being prepared', served: 'Served' };
const lookup = (key) => { const [id, opt] = key.split('|'); const item = menu.items.find((i) => i.id === id); return item && { item, opt: item.options.find((o) => o.id === opt) }; };
const cartCount = () => [...cart.values()].reduce((a, b) => a + b, 0);
const act = async (fn) => {
  if (busy) return; busy = true;
  try { await fn(); } catch (e) {
    alert(e.message);
    if (e.status === 409) await reloadMenu(); // a dish was just taken off the menu
  }
  busy = false; refresh();
};
async function reloadMenu() {
  menu = await api('/api/menu');
  for (const k of [...cart.keys()]) if (!lookup(k)) cart.delete(k);
  drawn = '';
}

function codeForm() {
  const err = h('div', { class: 'err' });
  const inp = h('input', { inputmode: 'numeric', maxlength: 4, autocomplete: 'off', placeholder: '••••' });
  message('Table already open', 'Someone is already ordering at this table. Ask them for the 4-digit table code (or ask our staff).', inp,
    h('div', {}, h('button', { class: 'btn', style: 'margin-top:12px;max-width:240px', onclick: async () => {
      try { await api(`/api/table/${tableId}/join`, { code: inp.value.trim() }); refresh(); } catch (e) { err.textContent = e.message; }
    } }, 'Join table')), err);
}

// Quantities only - guests never see prices or totals until the counter prepares the bill.
const itemList = (rows) => rows.map((r) => h('div', { class: 'line' }, h('span', {}, dot(r.veg), ' ', r.name), h('b', {}, '× ' + r.qty), r.extra));

function orderedCard() {
  const rows = view.orders.flatMap((o) => o.items.map((i) => ({ ...i, extra: h('span', { class: 'tag' }, label[o.status] || o.status) })));
  return h('details', { class: 'bill', open: '' }, h('summary', {}, h('b', {}, `Ordered so far (${rows.reduce((a, r) => a + r.qty, 0)} items)`)), ...itemList(rows));
}

function billCard(bill) {
  return h('div', { class: 'bill' }, h('h2', { style: 'margin-top:0' }, 'Your bill'), view.customer && h('div', { class: 'sub' }, 'Billed to ' + view.customer.name),
    h('table', {}, ...bill.items.map((l) => h('tr', {}, h('td', {}, dot(l.veg), ' ', `${l.qty} × ${l.name}`), h('td', {}, rupee(l.amount)))),
      h('tr', { class: 'tot' }, h('td', {}, 'Subtotal'), h('td', {}, rupee(bill.subtotal))),
      h('tr', {}, h('td', {}, `GST ${bill.taxPercent}%`), h('td', {}, rupee(bill.tax))),
      h('tr', { class: 'tot' }, h('td', {}, 'Total'), h('td', {}, rupee(bill.total)))));
}

function reviewSheet() {
  const body = h('div');
  const ov = sheet(h('h2', { style: 'margin-top:0' }, 'Your order'), body);
  const draw = () => {
    if (!cart.size) { ov.remove(); return paintDock(); }
    body.replaceChildren(...[...cart].map(([key, qty]) => {
      const { item, opt } = lookup(key);
      return h('div', { class: 'line' }, h('span', {}, dot(item.veg), ' ', item.name + (opt.label ? ` (${opt.label})` : '')),
        h('div', { class: 'qty' }, h('button', { onclick: () => { qty > 1 ? cart.set(key, qty - 1) : cart.delete(key); draw(); } }, '−'), h('b', {}, String(qty)), h('button', { onclick: () => { qty < 20 && cart.set(key, qty + 1); draw(); } }, '+')));
    }), h('button', { class: 'btn', style: 'width:100%;margin-top:14px', onclick: () => act(async () => {
      await api(`/api/table/${tableId}/order`, { items: [...cart].map(([k, qty]) => { const [id, opt] = k.split('|'); return { id, opt, qty }; }) });
      cart.clear(); ov.remove();
    }) }, 'Send to kitchen'));
    paintDock();
  };
  draw();
}

function billSheet() {
  const name = h('input', { placeholder: 'Your name', autocomplete: 'name', maxlength: 60 });
  const phone = h('input', { placeholder: 'Mobile number', type: 'tel', inputmode: 'numeric', autocomplete: 'tel', maxlength: 15 });
  const review = h('input', { type: 'checkbox' }), offers = h('input', { type: 'checkbox' });
  const err = h('div', { class: 'err' });
  const submit = (skip) => {
    if (skip && view.requireContact) { err.textContent = 'Name and mobile number are needed for the bill.'; return; }
    if (!skip && (!name.value.trim() || !/^\D*(91|0)?\D*[6-9](\D*\d){9}\D*$/.test(phone.value))) { err.textContent = 'Please enter your name and a valid 10-digit mobile number.'; return; }
    ov.remove();
    act(() => api(`/api/table/${tableId}/bill`, { contact: skip ? undefined : { name: name.value, phone: phone.value, review: review.checked, offers: offers.checked } }));
  };
  const ov = sheet(h('h2', { style: 'margin-top:0' }, 'Ask for the bill'),
    h('p', { class: 'sub' }, 'Our staff will bring your bill. Add your details to have it in your name.'), view.customer ? h('p', {}, 'Billed to ' + view.customer.name) : [name, phone,
    h('label', { class: 'chk' }, review, ' Message me later to ask for a Google review (optional)'),
    h('label', { class: 'chk' }, offers, ' Send me occasional offers (optional)'),
    h('p', { class: 'sub' }, 'We use your number only for what you tick, otherwise just for your bill. Ask staff to delete it any time.')],
    err, h('div', { class: 'row', style: 'margin-top:8px' }, view.customer || view.requireContact ? null : h('button', { class: 'btn sec', onclick: () => submit(true) }, 'Skip'), h('button', { class: 'btn', onclick: () => (view.customer ? (ov.remove(), act(() => api(`/api/table/${tableId}/bill`, {}))) : submit(false)) }, 'Ask for bill')));
}

// One obvious next step at a time: review the cart, or (once ordered) ask for the bill.
function paintDock() {
  dock.hidden = view.state !== 'active';
  if (dock.hidden) return;
  const n = cartCount();
  dock.replaceChildren(n
    ? h('button', { class: 'btn', onclick: reviewSheet }, `Review order · ${n} item${n > 1 ? 's' : ''}`)
    : view.orders.length ? h('button', { class: 'btn sec', onclick: billSheet }, 'Ask for bill') : h('div', { class: 'sub', style: 'width:100%;text-align:center' }, 'Tap ADD on a dish to start your order'));
}

async function refresh() {
  try { view = await api(`/api/table/${tableId}/state`); } catch { return; }
  if (view.state !== 'closed') firstLoad = false;
  clearTimeout(poll);
  if (['pending', 'active', 'needs_code', 'closing'].includes(view.state)) poll = setTimeout(refresh, 4000);
  if (view.state === 'active') {
    document.getElementById('sub').textContent = `Table code ${view.code} — share with others at your table`;
    if (drawn !== 'active') { renderMenu(app, menu, { cart, onChange: paintDock }); app.prepend(h('div', { id: 'ordered' })); drawn = 'active'; }
    document.getElementById('ordered').replaceChildren(...(view.orders.length ? [orderedCard()] : []));
    return paintDock();
  }
  drawn = view.state;
  document.getElementById('sub').textContent = '';
  dock.hidden = true;
  if (view.state === 'closing') return app.replaceChildren(h('div', { class: 'msg' }, h('h2', {}, 'Bill requested'), h('p', { class: 'sub' }, 'Our staff are preparing your bill. It will appear here.')), orderedCard());
  if (view.state === 'billed') return app.replaceChildren(billCard(view.bill), h('div', { class: 'msg' }, h('p', {}, 'Please pay at the counter. Thank you!')));
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
