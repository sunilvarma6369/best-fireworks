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
