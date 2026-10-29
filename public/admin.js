const app = document.getElementById('app');
let pw = sessionStorage.getItem('pw') || '';
const call = (path, body) => api(path, body, { 'x-admin-password': pw });

function login(msg) {
  const inp = h('input', { type: 'password', placeholder: 'Staff password' });
  app.replaceChildren(h('div', { class: 'msg' }, h('p', { class: 'err' }, msg || ''), inp, h('p', {}, h('button', { class: 'btn', style: 'max-width:200px', onclick: () => { pw = inp.value; sessionStorage.setItem('pw', pw); load(); } }, 'Sign in'))));
}

const act = (id, name, body = {}) => async () => { try { await call(`/api/admin/tables/${id}/${name}`, body); } catch (e) { alert(e.message); } load(); };

async function load() {
  let data;
  try { data = await call('/api/admin/tables'); } catch (e) { return e.status === 401 ? login(pw ? 'Wrong password' : '') : undefined; }
  app.replaceChildren(h('table', { class: 'a' }, h('tr', {}, ['Table', 'Status', 'Orders', 'Actions'].map((t) => h('th', {}, t))),
    ...data.tables.map((t) => {
      const s = t.session;
      const status = s ? [s.status === 'billed' ? 'Bill generated' : 'Ordering', h('span', { class: 'tag' }, 'code ' + s.code), h('span', { class: 'tag' }, s.devices + ' device(s)')] : [t.pending ? '🔔 Guest waiting' : 'Free'];
      const orders = s ? [...s.orders.map((o) => h('div', {}, h('small', {}, new Date(o.at).toLocaleTimeString() + ' '), o.items.map((i) => `${i.qty}× ${i.name}`).join(', '),
        h('button', { class: 'chip small', onclick: () => confirm('Void this order?') && act(t.id, 'void', { orderId: o.id })() }, 'void'))), h('b', {}, 'Total ' + rupee(s.bill.total))] : [];
      return h('tr', {}, h('td', {}, h('b', {}, t.id)), h('td', {}, status), h('td', {}, orders), h('td', {},
        !s && t.pending ? h('button', { class: 'btn small', onclick: act(t.id, 'seat') }, 'Seat guest') : null,
        s && s.status === 'billed' ? h('button', { class: 'chip small', onclick: act(t.id, 'reopen') }, 'Reopen') : null,
        s ? h('button', { class: 'btn small', onclick: () => confirm(`Mark table ${t.id} paid & close? Guests will no longer be able to order.`) && act(t.id, 'close')() }, 'Paid & close') : null));
    })));
}
load(); setInterval(() => pw && load(), 5000);
