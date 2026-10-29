// Shared helpers. All DOM is built with textContent, never innerHTML, so menu/user strings can't inject markup.
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const rupee = (n) => '₹' + n.toLocaleString('en-IN');
const api = async (path, body, headers = {}) => {
  const r = await fetch(path, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Request failed'), { status: r.status });
  return j;
};
const dot = (veg) => h('span', { class: 'dot ' + (veg ? 'v' : 'n'), title: veg ? 'Veg' : 'Non-veg' });

/** Renders category chips + veg filter + search + sections. `opts.qty` (optional) adds +/- controls. */
function renderMenu(root, menu, opts = {}) {
  const st = { cat: 'all', diet: 'all', q: '' };
  const bar = h('div', { class: 'bar' });
  const cats = h('div', { class: 'row' });
  const filters = h('div', { class: 'row filters' });
  const list = h('main');
  const chip = (label, on, fn) => h('button', { class: 'chip' + (on ? ' on' : ''), onclick: fn }, label);
  const draw = () => {
    cats.replaceChildren(chip('All', st.cat === 'all', () => { st.cat = 'all'; draw(); }),
      ...menu.categories.map((c) => chip(c.name, st.cat === c.id, () => { st.cat = c.id; draw(); })));
    filters.replaceChildren(
      ...[['all', 'All'], ['veg', '🟢 Veg'], ['nonveg', '🔴 Non-veg']].map(([k, l]) => chip(l, st.diet === k, () => { st.diet = k; draw(); })),
      h('input', { type: 'search', placeholder: 'Search dishes', value: st.q, oninput: (e) => { st.q = e.target.value; drawList(); } }));
    drawList();
  };
  const drawList = () => {
    const q = st.q.trim().toLowerCase();
    const out = [];
    for (const c of menu.categories) {
      if (st.cat !== 'all' && st.cat !== c.id) continue;
      const items = menu.items.filter((i) => i.category === c.id
        && (st.diet === 'all' || (st.diet === 'veg') === i.veg)
        && (!q || (i.name + ' ' + i.description).toLowerCase().includes(q)));
      if (!items.length) continue;
      out.push(h('h2', {}, c.name), ...items.map((i) => itemRow(i)));
    }
    list.replaceChildren(...(out.length ? out : [h('p', { class: 'sub' }, 'No dishes match.')]));
  };
  const itemRow = (i) => h('div', { class: 'item', 'data-id': i.id }, dot(i.veg),
    h('div', { class: 'info' }, h('div', { class: 'name' }, i.name), i.description && h('div', { class: 'desc' }, i.description), h('div', { class: 'price' }, rupee(i.price))),
    opts.cart && qtyControl(i));
  const qtyControl = (i) => {
    const box = h('div', { class: 'qty' });
    const paint = () => {
      const n = opts.cart.get(i.id) || 0;
      box.replaceChildren(...(n ? [h('button', { onclick: () => { opts.cart.set(i.id, n - 1); if (n - 1 === 0) opts.cart.delete(i.id); paint(); opts.onChange(); } }, '−'), h('b', {}, String(n)),
        h('button', { onclick: () => { if (n < 20) { opts.cart.set(i.id, n + 1); paint(); opts.onChange(); } } }, '+')]
        : [h('button', { class: 'add', onclick: () => { opts.cart.set(i.id, 1); paint(); opts.onChange(); } }, 'ADD')]));
    };
    paint();
    return box;
  };
  bar.append(cats, filters);
  root.replaceChildren(bar, list);
  draw();
}
