// Builds public/data/price-list.json from data/best_fire_works_price_list_2026.csv + data/store.json.
// Edit the CSV (Excel is fine, keep the header row), then run: npm run prices
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const csvPath = resolve(root, 'data/best_fire_works_price_list_2026.csv');
const storePath = resolve(root, 'data/store.json');
const outPath = resolve(root, 'public/data/price-list.json');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const num = (s) => (s.trim() === '' ? null : Number(s));
const round2 = (n) => Math.round(n * 100) / 100;

const meta = JSON.parse(readFileSync(storePath, 'utf8'));
const [header, ...lines] = parseCsv(readFileSync(csvPath, 'utf8'));
const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));

const errors = [];
const categories = [];
const products = lines.map((cells) => {
  const get = (k) => (cells[col[k]] ?? '').trim();
  const id = get('id');
  const section = get('section');
  const category = get('category');
  const categoryId = `${section === 'standard' ? 'std' : 'oth'}-${slug(category)}`;
  if (!categories.some((c) => c.id === categoryId)) {
    const sortOrder = categories.filter((c) => c.section === section).length + 1;
    const note = meta.categoryNotes?.[categoryId];
    categories.push({ id: categoryId, section, name: category, sortOrder, ...(note ? { note } : {}) });
  }
  const amount = num(get('amount'));
  const discount = num(get('discount'));
  const finalPrice = num(get('finalPrice'));
  if (!id || !get('name')) errors.push(`Row missing id or name: ${cells.join(',')}`);
  if (!(finalPrice > 0)) errors.push(`${id}: finalPrice must be > 0`);
  if (amount != null && discount != null && Math.abs(amount - discount - finalPrice) > 0.01) {
    errors.push(`${id}: amount - discount (${round2(amount - discount)}) != finalPrice (${finalPrice})`);
  }
  return {
    id,
    sku: id,
    listNo: Number(id.split('-')[1]),
    section,
    categoryId,
    category,
    name: get('name'),
    brand: get('brand') || null,
    box: num(get('box')),
    pcsPerBox: num(get('pcsPerBox')),
    amount,
    discount,
    finalPrice,
    discountPercent: amount ? round2((discount / amount) * 100) : 0,
    currency: 'INR',
    active: true,
    bulkOfferEligible: /^true$/i.test(get('bulkOfferEligible')),
  };
});

const dupes = products.map((p) => p.id).filter((id, i, a) => a.indexOf(id) !== i);
if (dupes.length) errors.push(`Duplicate ids: ${dupes.join(', ')}`);
if (errors.length) {
  console.error('Price list has problems:\n - ' + errors.join('\n - '));
  process.exit(1);
}

const out = {
  schemaVersion: meta.schemaVersion,
  generatedOn: new Date().toISOString().slice(0, 10),
  season: meta.season,
  currency: meta.currency,
  store: meta.store,
  pricing: meta.pricing,
  offers: meta.offers,
  sections: meta.sections.map((s) => ({ ...s, productCount: products.filter((p) => p.section === s.id).length })),
  categories,
  products,
  removedProducts: meta.removedProducts,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${products.length} products in ${categories.length} categories -> public/data/price-list.json`);
