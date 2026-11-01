process.env.ADMIN_PASSWORD = 'test-pass-123';
process.env.BRAND = 'biryani-house';
process.env.STATE_FILE = require('path').join(require('os').tmpdir(), `brand-test-${process.pid}.json`);
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadBrand, listBrands, brandMenu, brandCss, monogram } = require('../src/brand');
const { Store } = require('../src/store');
const { createServer } = require('../src/server');
const { parseRows, parseCsv, parseTags } = require('../src/menu');
const defaultMenu = require('../src/menu.json');

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every shipped brand is complete, readable and serves a real menu', () => {
  const ids = listBrands();
  assert.ok(ids.length >= 3, 'three instances are shipped');
  for (const id of ids) {
    const b = loadBrand(id, {});
    assert.equal(b.id, id);
    assert.ok(b.name && b.tagline && b.signoff, id);
    assert.match(b.monogram, /^[A-Z]{1,2}$/, id);
    // Button text is white on the light accent and near-black on the dark accent.
    assert.ok(contrast(b.accent, '#ffffff') >= 4.5, `${id}: light accent contrast ${contrast(b.accent, '#ffffff').toFixed(2)}`);
    assert.ok(contrast(b.accentDark, '#1a1109') >= 4.5, `${id}: dark accent contrast`);
    if (b.paper) assert.ok(contrast('#16202c', b.paper) >= 7, `${id}: body text on paper`);
    const menu = brandMenu(defaultMenu, b);
    assert.ok(menu.items.length >= 15, `${id} has enough dishes`);
    assert.ok(menu.items.every((i) => menu.categories.some((c) => c.id === i.category)), `${id}: no orphan dishes`);
    for (const k of Object.keys(b.intros)) assert.ok(typeof b.intros[k] === 'string');
    if (b.categories) for (const c of b.categories) assert.ok(defaultMenu.categories.some((x) => x.id === c), `${id}: unknown section ${c}`);
  }
  assert.equal(new Set(ids.map((i) => loadBrand(i, {}).accent)).size, ids.length, 'instances look different from each other');
});

test('brand selection: unknown or hostile ids fall back safely; env can rename', () => {
  const origError = console.error; console.error = () => {};
  try {
    for (const id of ['nope', '../package', '..\\x', 'a/b', '', 'SPICE-ROUTE', 'spice-route.json%00']) assert.equal(loadBrand(id, {}).id, 'spice-route', id);
  } finally { console.error = origError; }
  assert.equal(loadBrand('tiffin-corner', { RESTAURANT_NAME: 'Lakshmi Tiffins' }).name, 'Lakshmi Tiffins');
  assert.equal(loadBrand('tiffin-corner', { RESTAURANT_NAME: 'Lakshmi Tiffins' }).monogram, 'LT');
  assert.equal(loadBrand('tiffin-corner', { RESTAURANT_NAME: '<script>x</script>' }).name, 'script x /script');
});

test('monograms', () => {
  assert.equal(monogram('The Biryani House'), 'BH');
  assert.equal(monogram('Spice Route'), 'SR');
  assert.equal(monogram('Saffron'), 'S');
  assert.equal(monogram('a b c'), 'AB');
});

test('brand.css only contains colour tokens, even when a profile tries to inject CSS', () => {
  const strict = /^:root\{[^{}<>]*\}\n@media \(prefers-color-scheme:dark\)\{:root\{[^{}<>]*\}\}\n$/;
  for (const id of listBrands()) assert.match(brandCss(loadBrand(id, {})), strict, id);
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'brands-'));
  fs.writeFileSync(path.join(dir, 'evil.json'), JSON.stringify({ name: 'Evil', accent: '#b8400b;} body{display:none', accentDark: 'url(//x)', paper: 'red', categories: 'oops', intros: { biryani: '<img src=x>' } }));
  const evil = loadBrand('evil', {}, dir);
  assert.equal(evil.accent, '#b8400b');                      // invalid colours fall back to the default
  assert.equal(evil.accentDark, '#f0884f');
  assert.equal(evil.paper, null);
  assert.equal(evil.categories, null);
  assert.equal(evil.intros.biryani, 'img src=x');            // markup stripped from copy
  assert.match(brandCss(evil), strict);
});

test('a brand with section limits only serves those sections, in the store too', () => {
  const s = new Store('/dev/null', { persist: false });            // BRAND=biryani-house for this file
  const cats = s.publicMenu().categories.map((c) => c.id);
  assert.deepEqual(cats, ['biryani', 'breads', 'grills', 'desserts', 'beverages']);
  assert.equal(s.publicMenu().items.some((i) => i.category === 'breakfast'), false);
  s.enter('1', 'A'); s.seat('1');
  assert.equal(s.placeOrder('1', 'A', [{ id: 'masala-dosa', qty: 1 }]).ok, false);   // a breakfast dish is not on this menu
  assert.ok(s.placeOrder('1', 'A', [{ id: 'mutton-biryani', opt: 'full', qty: 1 }]).ok);
});

test('http: brand css, info and menu intros reach the browser; pages link the brand sheet', async () => {
  const srv = createServer(new Store('/dev/null', { persist: false })).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const css = await fetch(`${base}/brand.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.match(await css.text(), /--acc:#0f6b4f/);
    const info = await (await fetch(`${base}/api/info`)).json();
    assert.equal(info.brand.name, 'The Biryani House');
    assert.equal(info.brand.monogram, 'BH');
    assert.equal(info.brand.id, 'biryani-house');
    const menu = await (await fetch(`${base}/api/menu`)).json();
    assert.match(menu.categories.find((c) => c.id === 'biryani').intro, /Sealed with dough/);
    assert.ok(menu.categories.every((c) => typeof c.intro === 'string'));
    for (const p of ['/menu', '/admin']) assert.match(await (await fetch(base + p)).text(), /href="\/brand\.css"/, p);
  } finally { srv.close(); }
});

test('every html page links the brand sheet and has a brand header', () => {
  const dir = path.join(__dirname, '..', 'web');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.html'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(src, /\/brand\.css/, f);
    assert.match(src, /id="brand"/, f);
  }
});

test('dish tags: parsed from the spreadsheet, unknown labels ignored', () => {
  assert.deepEqual(parseTags("Chef's pick; POPULAR, spicy, vegan, new"), ['popular', 'spicy', 'new']);
  assert.deepEqual(parseTags('Chef Pick'), ['chef-pick']);
  assert.deepEqual(parseTags(''), []);
  const r = parseRows(parseCsv('Category,Name,Type,Price,Tags\nA,Soup,Veg,50,"popular, chef-pick"\nA,Plain,Veg,40,\n'));
  assert.deepEqual(r.menu.items.map((i) => i.tags), [['popular', 'chef-pick'], []]);
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const login = async (base) => {
  const r = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-pass-123' }) });
  return { Authorization: `Bearer ${(await r.json()).token}` };
};

test('each brand ships a logo file, and the app uses it in place of the initials badge', async () => {
  for (const id of listBrands()) {
    const b = loadBrand(id, {});
    assert.ok(b.logoFile && fs.existsSync(b.logoFile), `${id} has a bundled logo`);
    assert.equal(b.logoType, 'image/svg+xml');
  }
  const srv = createServer(new Store('/dev/null', { persist: false })).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await (await fetch(`${base}/api/info`)).json()).brand.logo, 'file');
    const r = await fetch(`${base}/brand-logo`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/svg+xml');
    assert.match(r.headers.get('content-security-policy'), /sandbox/);       // opened directly, an image cannot run anything
    assert.match(await r.text(), /^<svg/);
  } finally { srv.close(); }
});

test('staff can upload and remove a logo; only real PNG/JPG/WebP images of sane size are accepted', async () => {
  const store = new Store('/dev/null', { persist: false });
  const srv = createServer(store).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const send = (headers, body, p = '/api/admin/logo') => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body });
  try {
    assert.equal((await send({}, PNG)).status, 401);
    const A = await login(base);
    assert.equal((await send(A, 'just text, not an image')).status, 415);
    assert.equal((await send(A, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).status, 415);   // scripts can hide in SVG
    assert.equal((await send(A, Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(301_000)]))).status, 413);
    assert.equal((await send(A, PNG)).status, 200);
    const img = await fetch(`${base}/brand-logo`);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
    const v = (await (await fetch(`${base}/api/info`)).json()).brand.logo;
    assert.match(v, /^\d+$/);                                                // version changes with each upload, so browsers refetch
    const removed = await fetch(`${base}/api/admin/logo/remove`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...A }, body: '{}' });
    assert.equal(removed.status, 200);
    assert.equal((await fetch(`${base}/brand-logo`)).headers.get('content-type'), 'image/svg+xml');   // back to the bundled one
  } finally { srv.close(); }
});

test('logo signatures: png, jpeg and webp pass, lookalikes fail', () => {
  const s = new Store('/dev/null', { persist: false });
  const pad = Buffer.alloc(20);
  assert.ok(s.setLogo(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pad])).ok);
  assert.equal(s.uploadedLogo.type, 'image/jpeg');
  assert.ok(s.setLogo(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), pad])).ok);
  assert.equal(s.uploadedLogo.type, 'image/webp');
  assert.equal(s.setLogo(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), pad])).ok, false);
  assert.equal(s.setLogo(Buffer.from('GIF89a' + 'x'.repeat(30))).ok, false);
  assert.equal(s.setLogo(Buffer.alloc(5)).ok, false);
  s.clearLogo();
  assert.equal(s.uploadedLogo, null);
});
