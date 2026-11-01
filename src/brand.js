// One codebase, many restaurants: a "brand" is a small JSON profile (name, colours, menu sections, wording).
// Each deployed instance picks one with the BRAND environment variable.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'brands');
const DEFAULT_ID = 'spice-route';
const LOGO_TYPES = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const HEX = /^#[0-9a-f]{6}$/i;

const DEFAULT_INTROS = {
  breakfast: 'Start the day right, hot off the tawa.',
  lunch: 'Full plates and comforting curries.',
  biryani: 'Dum-cooked and sealed, opened just before it reaches you.',
  breads: 'Fresh from the tandoor.',
  grills: 'Charred, smoky and juicy.',
  chinese: 'Wok-fired Indo-Chinese favourites.',
  desserts: 'Save a little room.',
  beverages: 'Something to sip while you wait.',
};

const monogram = (name) => name.replace(/^the\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); // eslint-disable-line no-control-regex

function loadBrand(id = process.env.BRAND || DEFAULT_ID, env = process.env, dir = DIR) {
  let raw;
  if (/^[a-z0-9-]+$/.test(id) && fs.existsSync(path.join(dir, `${id}.json`))) {
    raw = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  } else {
    console.error(`Unknown BRAND "${id}"; using ${DEFAULT_ID}. Available: ${listBrands().join(', ')}`);
    id = DEFAULT_ID;
    raw = JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'));
  }
  const name = text(env.RESTAURANT_NAME || raw.name, 40) || 'Our Restaurant';
  const color = (v, d) => (HEX.test(v || '') ? v : d);
  // A logo is a file named after the brand in brands/logos/ (trusted, committed with the code).
  const ext = Object.keys(LOGO_TYPES).find((e) => fs.existsSync(path.join(dir, 'logos', `${id}.${e}`)));
  return {
    id,
    name,
    logoFile: ext ? path.join(dir, 'logos', `${id}.${ext}`) : null,
    logoType: ext ? LOGO_TYPES[ext] : null,
    tagline: text(raw.tagline, 80),
    monogram: monogram(name),
    accent: color(raw.accent, '#b8400b'),
    accentDark: color(raw.accentDark, '#f0884f'),
    paper: color(raw.paper, null),
    paperDark: color(raw.paperDark, null),
    categories: Array.isArray(raw.categories) ? raw.categories.map(String) : null,
    intros: { ...DEFAULT_INTROS, ...Object.fromEntries(Object.entries(raw.intros || {}).map(([k, v]) => [k, text(v, 120)])) },
    signoff: text(raw.signoff, 100) || 'Thank you for dining with us.',
  };
}

function listBrands() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
}

/** The dishes this brand serves: the default menu, limited to the brand's sections when it names any. */
function brandMenu(menu, brand) {
  if (!brand.categories) return menu;
  const keep = new Set(brand.categories);
  return { categories: menu.categories.filter((c) => keep.has(c.id)), items: menu.items.filter((i) => keep.has(i.category)) };
}

/** Theme tokens for this brand, served as /brand.css so there is no flash of the wrong colours. */
function brandCss(b) {
  const light = [`--acc:${b.accent}`, b.paper && `--bg:${b.paper}`].filter(Boolean).join(';');
  const dark = [`--acc:${b.accentDark}`, b.paperDark && `--bg:${b.paperDark}`].filter(Boolean).join(';');
  return `:root{${light}}\n@media (prefers-color-scheme:dark){:root{${dark}}}\n`;
}

module.exports = { loadBrand, listBrands, brandMenu, brandCss, monogram };
