const tableId = location.pathname.split('/').pop();
const sig = new URLSearchParams(location.search).get('s') || '';
const app = document.getElementById('app'), dock = document.getElementById('dock');
document.getElementById('title').textContent = 'Table ' + tableId;
brandHeader('Table ' + tableId, '');
let signoff = '';
info.then((i) => { signoff = i.brand.signoff; });
const cart = new Map();   // "dishId|optionId" -> qty
let menu, menuUI, view = { state: 'loading' }, poll, drawn = '', firstLoad = true, busy = false;

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
  message('Joining friends?', 'This table is already open. Ask the person who started it for the 4-digit table code, or ask any of our team.', inp,
    h('div', {}, h('button', { class: 'btn narrow mt12', onclick: async () => {
      try { await api(`/api/table/${tableId}/join`, { code: inp.value.trim() }); refresh(); } catch (e) { err.textContent = e.message; }
    } }, 'Join table')), err);
}

// Quantities only - guests never see prices or totals until the counter prepares the bill.
const itemList = (rows) => rows.map((r) => h('div', { class: 'line' }, h('span', {}, dot(r.veg), ' ', r.name), h('b', {}, '× ' + r.qty), r.extra));

function orderedCard() {
  const rows = view.orders.flatMap((o) => o.items.map((i) => ({ ...i, extra: h('span', { class: 'tag' }, label[o.status] || o.status) })));
  const count = rows.reduce((a, r) => a + r.qty, 0);
  return h('details', { class: 'bill', open: '' }, h('summary', {}, h('b', {}, `Your table's order (${count} item${count === 1 ? '' : 's'})`)), ...itemList(rows));
}

function billCard(bill) {
  return h('div', { class: 'bill' }, h('h2', { class: 'flush' }, 'Your bill'), view.customer && h('div', { class: 'sub' }, 'Billed to ' + view.customer.name),
    h('table', {}, ...bill.items.map((l) => h('tr', {}, h('td', {}, dot(l.veg), ' ', `${l.qty} × ${l.name}`), h('td', {}, rupee(l.amount)))),
      h('tr', { class: 'tot' }, h('td', {}, 'Subtotal'), h('td', {}, rupee(bill.subtotal))),
      h('tr', {}, h('td', {}, `GST ${bill.taxPercent}%`), h('td', {}, rupee(bill.tax))),
      h('tr', { class: 'tot' }, h('td', {}, 'Total'), h('td', {}, rupee(bill.total)))));
}

function reviewSheet() {
  const body = h('div');
  const ov = sheet(h('h2', { class: 'flush' }, 'Your order'), body);
  const draw = () => {
    menuUI.repaint();
    if (!cart.size) { ov.remove(); return paintDock(); }
    body.replaceChildren(...[...cart].map(([key, qty]) => {
      const { item, opt } = lookup(key);
      return h('div', { class: 'line' }, h('span', {}, dot(item.veg), ' ', item.name + (opt.label ? ` (${opt.label})` : '')),
        h('div', { class: 'qty' }, h('button', { onclick: () => { qty > 1 ? cart.set(key, qty - 1) : cart.delete(key); draw(); } }, '−'), h('b', {}, String(qty)), h('button', { onclick: () => { qty < 20 && cart.set(key, qty + 1); draw(); } }, '+')));
    }), h('button', { class: 'btn wide mt12', onclick: () => act(async () => {
      await api(`/api/table/${tableId}/order`, { items: [...cart].map(([k, qty]) => { const [id, opt] = k.split('|'); return { id, opt, qty }; }) });
      cart.clear(); ov.remove(); menuUI.repaint(); toast('Sent. The kitchen has your order.');
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
  const ov = sheet(h('h2', { class: 'flush' }, 'Ready for the bill?'),
    h('p', { class: 'sub' }, 'No rush. Our team will bring it over. Add your name if you would like it on the bill.'), view.customer ? h('p', {}, 'Billed to ' + view.customer.name) : [name, phone,
    h('label', { class: 'chk' }, review, ' Message me later to ask for a Google review (optional)'),
    h('label', { class: 'chk' }, offers, ' Send me occasional offers (optional)'),
    h('p', { class: 'sub' }, 'We use your number only for what you tick, otherwise just for your bill. Ask staff to delete it any time.')],
    err, h('div', { class: 'row mt8' }, view.customer || view.requireContact ? null : h('button', { class: 'btn sec', onclick: () => submit(true) }, 'Skip'), h('button', { class: 'btn', onclick: () => (view.customer ? (ov.remove(), act(() => api(`/api/table/${tableId}/bill`, {}))) : submit(false)) }, 'Bring the bill')));
}

// One obvious next step at a time: review the cart, or (once ordered) ask for the bill.
function paintDock() {
  dock.hidden = view.state !== 'active';
  if (dock.hidden) return;
  const n = cartCount();
  dock.replaceChildren(n
    ? h('button', { class: 'btn', onclick: reviewSheet }, `Review order · ${n} item${n > 1 ? 's' : ''}`)
    : view.orders.length ? h('button', { class: 'btn sec', onclick: billSheet }, 'Ready for the bill?') : h('div', { class: 'sub hint' }, 'Hungry? Tap ADD on anything that catches your eye.'));
}

async function refresh() {
  try { view = await api(`/api/table/${tableId}/state`); } catch { return; }
  if (view.state !== 'closed') firstLoad = false;
  clearTimeout(poll);
  if (['pending', 'active', 'needs_code', 'closing'].includes(view.state)) poll = setTimeout(refresh, 4000);
  if (view.state === 'active') {
    document.getElementById('sub').textContent = `Table code ${view.code}. Share it with friends joining you.`;
    if (drawn !== 'active') { menuUI = renderMenu(app, menu, { cart, onChange: paintDock }); app.prepend(h('div', { id: 'ordered' })); drawn = 'active'; }
    document.getElementById('ordered').replaceChildren(...(view.orders.length ? [orderedCard()] : []));
    return paintDock();
  }
  drawn = view.state;
  document.getElementById('sub').textContent = '';
  dock.hidden = true;
  if (view.state === 'closing') return app.replaceChildren(h('div', { class: 'msg' }, h('h2', {}, 'Your bill is on its way'), h('p', { class: 'sub' }, view.customer ? `Just a moment, ${view.customer.name}. Our team is getting it ready and it will appear right here.` : 'Just a moment. Our team is getting it ready and it will appear right here.')), orderedCard());
  if (view.state === 'billed') return app.replaceChildren(h('div', { class: 'msg' }, h('h2', {}, view.customer ? `Thank you, ${view.customer.name}` : 'Thank you'), h('p', { class: 'sub' }, 'We hope you enjoyed everything.')), billCard(view.bill), h('div', { class: 'msg' }, h('p', {}, 'You can pay at the counter whenever you are ready.'), h('p', { class: 'sub' }, signoff)));
  if (view.state === 'pending') return message('Welcome! Someone will be right with you', 'Show this code to a team member and they will open your table. This page updates by itself.', h('div', { class: 'pair' }, view.pairing));
  if (view.state === 'needs_code') return codeForm();
  // Only a fresh page load (a real scan) may request a table; a page left open after payment must not.
  if (view.state === 'closed' && firstLoad) { firstLoad = false; return enter(); }
  message('Hope you enjoyed your meal', 'This table is closed. If you would like to order again, scan the QR code on your table.');
}

async function enter() {
  try { await api(`/api/table/${tableId}/enter`, { s: sig }); refresh(); } catch (e) { message('Invalid link', e.message); }
}

api('/api/menu').then((m) => { menu = m; refresh(); });
