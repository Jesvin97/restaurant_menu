// Menu model: { categories:[{id,name}], items:[{id,category,name,description,veg,allergens:[],options:[{id,label,price}]}] }
// An item has one option (single price) or several (e.g. Half / Full).
const slug = (s) => String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function parseAllergens(v) {
  return [...new Set(String(v ?? '').toLowerCase().split(/[,;/|]+/).map((a) => a.trim().replace(/\s+/g, '-')).filter((a) => a && !['none', 'no', 'nil', 'na', 'n/a', '-'].includes(a)))].slice(0, 12);
}

/** Upgrades the original single-price format to the option-based one (idempotent). */
function normalize(raw) {
  const used = new Set();
  const items = raw.items.map((i) => {
    let id = i.id && typeof i.id === 'string' ? i.id : slug(i.name);
    for (let n = 2; used.has(id); n++) id = `${slug(i.name)}-${n}`;
    used.add(id);
    return {
      id, category: i.category, name: i.name, description: i.description || '', veg: !!i.veg,
      allergens: i.allergens || [],
      options: i.options || [{ id: 'regular', label: '', price: i.price }],
    };
  });
  return { categories: raw.categories, items };
}

const HEADERS = {
  category: ['category', 'section', 'group'],
  name: ['name', 'item', 'dish', 'item name', 'dish name'],
  description: ['description', 'desc', 'details'],
  type: ['type', 'veg/non-veg', 'veg / non veg', 'veg or non veg', 'veg', 'diet', 'veg/nonveg'],
  half: ['half', 'half price', 'half plate'],
  full: ['full', 'full price', 'full plate'],
  price: ['price', 'rate', 'amount', 'mrp'],
  allergens: ['allergens', 'allergen', 'allergy', 'allergies', 'contains'],
};

const toNum = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[₹,\s]|rs\.?/gi, ''));
  return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 100) / 100 : NaN;
};

/**
 * rows: array of arrays (first row = headers). Returns { menu, errors, warnings }.
 * Accepts either a single "Price" column or "Half" and/or "Full" columns.
 */
function parseRows(rows) {
  const errors = [];
  const head = (rows[0] || []).map((c) => String(c ?? '').trim().toLowerCase());
  const col = {};
  for (const [k, names] of Object.entries(HEADERS)) col[k] = head.findIndex((h) => names.includes(h));
  for (const need of ['category', 'name', 'type']) if (col[need] < 0) errors.push(`Missing column: ${need[0].toUpperCase() + need.slice(1)}`);
  if (col.price < 0 && col.half < 0 && col.full < 0) errors.push('Missing price column: add "Price" or "Half"/"Full"');
  if (errors.length) return { errors };

  const cats = new Map(), items = [], used = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const cell = (k) => (col[k] >= 0 ? row[col[k]] : undefined);
    if (row.every((c) => c == null || String(c).trim() === '')) continue;
    const line = r + 1;
    const name = clean(cell('name'), 80), catName = clean(cell('category'), 40);
    if (!name || !catName) { errors.push(`Row ${line}: category and name are required`); continue; }
    const t = String(cell('type') ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    const veg = ['veg', 'v', 'vegetarian', 'yes', 'true'].includes(t) ? true : ['nonveg', 'nv', 'nonvegetarian', 'non', 'no', 'false', 'egg'].includes(t) ? false : null;
    if (veg === null) { errors.push(`Row ${line} (${name}): Type must be Veg or Non-Veg`); continue; }
    const options = [];
    const half = toNum(cell('half')), full = toNum(cell('full')), single = toNum(cell('price'));
    if ([half, full, single].some(Number.isNaN)) { errors.push(`Row ${line} (${name}): price is not a valid number`); continue; }
    if (half) options.push({ id: 'half', label: 'Half', price: half });
    if (full) options.push({ id: 'full', label: 'Full', price: full });
    if (!options.length && single) options.push({ id: 'regular', label: '', price: single });
    if (!options.length) { errors.push(`Row ${line} (${name}): no price`); continue; }
    if (options.length === 1 && options[0].id !== 'regular') options[0] = { ...options[0], label: '' }; // only one size given -> plain price
    let cid = slug(catName);
    if (!cats.has(cid)) cats.set(cid, { id: cid, name: catName });
    let id = slug(name);
    for (let n = 2; used.has(id); n++) id = `${slug(name)}-${n}`;
    used.add(id);
    items.push({ id, category: cid, name, description: clean(cell('description'), 200), veg, allergens: parseAllergens(cell('allergens')), options });
  }
  if (!items.length && !errors.length) errors.push('No dishes found in the file');
  if (items.length > 1000) errors.push('Too many dishes (max 1000)');
  return { menu: { categories: [...cats.values()], items }, errors };
}

/** Minimal CSV parser (quotes, commas, newlines) so the sheet can also be uploaded as .csv. */
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const TEMPLATE_CSV = [
  'Category,Name,Description,Type,Half,Full,Allergens',
  'Biryani,Chicken Dum Biryani,Slow-cooked with raita,Non-Veg,160,240,dairy',
  'Breads,Butter Naan,,Veg,,40,"gluten, dairy"',
  'Starters,Paneer Tikka,Char-grilled paneer,Veg,,210,dairy',
].join('\n') + '\n';

module.exports = { slug, normalize, parseRows, parseCsv, parseAllergens, TEMPLATE_CSV };
