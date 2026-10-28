import { SITE_URL } from '../config.js';

export const isNativeApp = !!globalThis.Capacitor?.isNativePlatform?.();

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Loads the price list. The website reads its own copy. The Android app first tries the live website
 * (so price corrections reach the app without a new APK) and falls back to the copy bundled inside it.
 */
export async function loadPriceList() {
  if (isNativeApp && !SITE_URL.includes('YOUR-')) {
    try {
      return await fetchJson(`${SITE_URL}/data/price-list.json`, 6000);
    } catch (err) {
      console.warn('Live price list unavailable, using bundled copy', err);
    }
  }
  return fetchJson('/data/price-list.json', 15000);
}

const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (v === '' || v == null ? null : Number(v));
// Only photos uploaded to this project's Firebase Storage are shown.
// (Local testing also allows the Storage emulator's links.)
const photo = (url) =>
  typeof url === 'string' &&
  (url.startsWith('https://firebasestorage.googleapis.com/') || (import.meta.env?.DEV && /^http:\/\/[^/]+:9199\//.test(url)))
    ? url
    : null;

function withPrices(p) {
  const finalPrice = round2(Number(p.finalPrice));
  const amount = round2(Math.max(Number(p.amount ?? finalPrice) || finalPrice, finalPrice));
  const discount = round2(amount - finalPrice);
  return { ...p, amount, finalPrice, discount, discountPercent: amount ? round2((discount / amount) * 100) : 0 };
}

/**
 * Applies the shop's edits from the admin page (settings/public.catalog) on top of the price-list file.
 * overrides = { [productId]: { name?, brand?, pcsPerBox?, amount?, finalPrice?, bulkOfferEligible?, hidden?, image?,
 *                              custom?: true, categoryId?, createdAt? } }
 * Edited items keep their place; hidden items disappear; custom (shop-added) items go at the end of their category.
 */
export function applyCatalogOverrides(data, overrides = {}) {
  if (!overrides || !Object.keys(overrides).length) return data;
  const categoriesById = new Map(data.categories.map((c) => [c.id, c]));
  const valid = (o) => o && Number(o.finalPrice ?? 1) > 0;
  const products = [];

  for (const p of data.products) {
    const o = overrides[p.id];
    if (!o || !valid(o)) { products.push(p); continue; }
    if (o.hidden) continue;
    products.push(withPrices({
      ...p,
      ...(o.name ? { name: o.name } : {}),
      ...('brand' in o ? { brand: o.brand || null } : {}),
      ...('pcsPerBox' in o ? { pcsPerBox: num(o.pcsPerBox) } : {}),
      ...(o.amount != null ? { amount: o.amount } : {}),
      ...(o.finalPrice != null ? { finalPrice: o.finalPrice } : {}),
      ...('bulkOfferEligible' in o ? { bulkOfferEligible: !!o.bulkOfferEligible } : {}),
      ...(photo(o.image) ? { image: photo(o.image) } : {}),
      edited: true,
    }));
  }

  const added = Object.entries(overrides)
    .filter(([, o]) => o?.custom && !o.hidden && valid(o) && o.name && categoriesById.has(o.categoryId))
    .sort(([, a], [, b]) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  for (const [id, o] of added) {
    const cat = categoriesById.get(o.categoryId);
    const lastNo = Math.max(0, ...products.filter((p) => p.section === cat.section).map((p) => p.listNo));
    products.push(withPrices({
      id, sku: id, listNo: lastNo + 1, section: cat.section, categoryId: cat.id, category: cat.name,
      name: o.name, brand: o.brand || null, box: 1, pcsPerBox: num(o.pcsPerBox),
      amount: o.amount, finalPrice: o.finalPrice, bulkOfferEligible: o.bulkOfferEligible !== false,
      currency: 'INR', active: true, custom: true, ...(photo(o.image) ? { image: photo(o.image) } : {}),
    }));
  }
  return { ...data, products };
}

export function indexPriceList(data) {
  const productsById = new Map(data.products.map((p) => [p.id, p]));
  const offer = data.offers?.find((o) => o.id === 'BULK10') ?? data.offers?.[0];
  return { ...data, productsById, offer };
}

const CATEGORY_ICONS = {
  'std-standard-fireworks': '⭐',
  'oth-sounds': '💥',
  'oth-flower-pots': '🌋',
  'oth-ground-chakkars': '🌀',
  'oth-sparklers': '🎇',
  'oth-pencils': '✏️',
  'oth-match-boxes': '🔥',
  'oth-thoka-pataakulu-bijili': '🧨',
  'oth-rockets': '🚀',
  'oth-fancy-items': '🎉',
  'oth-fancy-guns-ring-caps-rolls': '🔫',
  'oth-shots': '🎆',
  'oth-comets-sky-shots': '☄️',
  'oth-sand-pots': '🏺',
  'oth-walas': '🎊',
};

export const categoryIcon = (categoryId) => CATEGORY_ICONS[categoryId] ?? '✨';

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const telLink = (phone) => `tel:${phone}`;
export const waLink = (phone, text) => `https://wa.me/${phone.replace(/\D/g, '')}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
export const prettyPhone = (phone) => phone.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2');

// In the Android app, plain links open WhatsApp/maps/dialer outside the app. On the web, open them in a new tab.
export const extTarget = isNativeApp ? '' : 'target="_blank" rel="noopener"';
