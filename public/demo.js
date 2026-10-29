const root = document.getElementById('app');
const step = (title, hint, ...kids) => h('div', { class: 'card step' }, h('h2', {}, title), h('div', { class: 'sub' }, hint), ...kids);
const link = (href, text, cls = 'btn') => h('a', { class: cls, href }, text);

api('/api/demo/info').then((d) => {
  const reset = h('button', { class: 'btn sec', onclick: async () => { await api('/api/demo/reset', {}); location.reload(); } }, 'Reset demo');
  const staff = h('button', { class: 'btn', onclick: async () => {
    const r = await api('/api/admin/login', { password: d.password });
    try { sessionStorage.setItem('tok', r.token); } catch { /* storage blocked: staff page will ask for the password */ }
    location.href = '/admin';
  } }, 'Open staff dashboard');
  root.replaceChildren(
    step('1. Be a guest', 'Scan a table QR or tap a table. The table opens instantly in the demo (a real restaurant has staff seat you).',
      h('div', { class: 'btns' }, ...d.tables.map((t) => link(t.url, `Table ${t.id}`)), link('/menu', 'Counter menu', 'btn sec'))),
    step('2. Be the counter', `Signs you in as staff (demo password: ${d.password}). Tables 2 and 3 already have orders and a bill request.`, h('div', { class: 'btns' }, staff)),
    step('3. Scan from a screen', 'Showing this page on a laptop? Scan these with your phone.',
      h('div', { class: 'qrs' }, ...[['counter', 'Counter menu'], ['1', 'Table 1']].map(([f, label]) => h('div', { class: 'qrcard' }, h('div', { class: 'qrtitle' }, label), h('img', { src: `/api/demo/qr/${f}.svg`, alt: `QR code: ${label}` }))))),
    step('Start over', 'Clears all demo orders and restores the sample ones.', h('div', { class: 'btns' }, reset)));
});
