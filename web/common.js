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

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: setting just isn't remembered */ } },
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ');
const sheet = (...kids) => { const ov = h('div', { class: 'overlay', onclick: (e) => e.target === ov && ov.remove() }, h('div', { class: 'sheet' }, ...kids)); document.body.append(ov); return ov; };

/**
 * Menu browser. One category at a time (fewer choices per screen), familiar delivery-app patterns:
 * sticky category tabs, veg/non-veg switch, ADD -> stepper, allergy filter behind a single button.
 * opts.cart (Map "dishId|optionId" -> qty) + opts.onChange turn on ordering controls.
 */
function renderMenu(root, menu, opts = {}) {
  const st = { cat: menu.categories[0] && menu.categories[0].id, diet: 'all', q: '', avoid: new Set(store.get('allergens', [])) };
  const allergens = [...new Set(['gluten', 'dairy', 'egg', 'peanut', 'tree-nut', 'soy', 'fish', 'shellfish', 'sesame', ...menu.items.flatMap((i) => i.allergens || [])])];
  const bar = h('div', { class: 'bar' }), top = h('div', { class: 'row filters' }), cats = h('div', { class: 'row mt8' }), list = h('main');
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Search dishes', value: st.q, 'aria-label': 'Search dishes', oninput: (e) => { st.q = e.target.value; drawCats(); drawList(); } });
  const chip = (label, on, fn) => h('button', { class: 'chip' + (on ? ' on' : ''), onclick: fn }, label);
  const draw = () => {
    top.replaceChildren(
      h('div', { class: 'seg' }, ...[['all', 'All'], ['veg', 'Veg'], ['nonveg', 'Non-veg']].map(([k, l]) => h('button', { class: (st.diet === k ? 'on ' : '') + k, onclick: () => { st.diet = k; draw(); } }, l))),
      h('button', { class: 'chip' + (st.avoid.size ? ' on' : ''), onclick: allergyPicker }, st.avoid.size ? `Allergies (${st.avoid.size})` : 'Allergies'));
    drawCats();
    drawList();
  };
  const drawCats = () => cats.replaceChildren(...menu.categories.map((c) => chip(c.name, st.cat === c.id && !st.q.trim(), () => { st.cat = c.id; st.q = ''; search.value = ''; draw(); })));
  const allergyPicker = () => {
    const boxes = allergens.map((a) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: st.avoid.has(a) ? '' : null, 'data-a': a }), ' ' + cap(a)));
    const ov = sheet(h('h2', { class: 'flush' }, 'Hide dishes containing…'), ...boxes,
      h('p', { class: 'sub' }, 'Based on the allergen list the kitchen entered. For severe allergies, please also tell our staff.'),
      h('div', { class: 'row' }, h('button', { class: 'btn sec', onclick: () => { st.avoid.clear(); apply(); } }, 'Clear'), h('button', { class: 'btn', onclick: () => { st.avoid = new Set([...ov.querySelectorAll('input:checked')].map((x) => x.dataset.a)); apply(); } }, 'Apply')));
    const apply = () => { store.set('allergens', [...st.avoid]); ov.remove(); draw(); };
  };
  const visible = (i) => !(i.allergens || []).some((a) => st.avoid.has(a));
  const drawList = () => {
    const q = st.q.trim().toLowerCase();
    let hidden = 0;
    const items = menu.items.filter((i) => (q || i.category === st.cat)
      && (st.diet === 'all' || (st.diet === 'veg') === i.veg)
      && (!q || (i.name + ' ' + i.description).toLowerCase().includes(q))
      && (visible(i) || (hidden++, false)));
    list.replaceChildren(
      ...(st.avoid.size ? [h('p', { class: 'sub note' }, `Hiding dishes with: ${[...st.avoid].map(cap).join(', ')}${hidden ? ` (${hidden} hidden)` : ''}`)] : []),
      ...(items.length ? items.map(itemRow) : [h('p', { class: 'sub' }, 'No dishes here.')]));
  };
  const itemRow = (i) => h('div', { class: 'item' }, dot(i.veg),
    h('div', { class: 'info' }, h('div', { class: 'name' }, i.name), i.description && h('div', { class: 'desc' }, i.description),
      ...(i.options.length > 1 ? i.options.map((o) => h('div', { class: 'opt' }, h('span', {}, `${o.label} · ${rupee(o.price)}`), opts.cart && qtyControl(i, o))) : [h('div', { class: 'price' }, rupee(i.options[0].price))])),
    opts.cart && i.options.length === 1 && qtyControl(i, i.options[0]));
  const qtyControl = (i, o) => {
    const key = `${i.id}|${o.id}`, box = h('div', { class: 'qty' });
    const set = (n) => { n > 0 ? opts.cart.set(key, n) : opts.cart.delete(key); paint(); opts.onChange(); };
    const paint = () => {
      const n = opts.cart.get(key) || 0;
      box.replaceChildren(...(n ? [h('button', { 'aria-label': 'Remove one', onclick: () => set(n - 1) }, '−'), h('b', {}, String(n)), h('button', { 'aria-label': 'Add one', onclick: () => n < 20 && set(n + 1) }, '+')]
        : [h('button', { class: 'add', onclick: () => set(1) }, 'ADD')]));
    };
    paint();
    return box;
  };
  bar.append(top, cats);
  root.replaceChildren(bar, h('div', { class: 'searchrow' }, search), list);
  draw();
}

// Demo builds show a banner on every page so nobody mistakes the sandbox for a real restaurant.
api('/api/info').then((i) => {
  if (!i.demo) return;
  document.body.prepend(h('div', { class: 'demo-banner' }, 'Demo — nothing here is real. Please don\'t enter a real phone number. ', h('a', { href: '/demo' }, 'Demo home')));
}).catch(() => {});
