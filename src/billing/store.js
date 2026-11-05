// Offline storage for counter billing (IndexedDB on this phone):
//   kv       → cached price list, open bills, device code, bill counter
//   photos   → item photo blobs, so search and scanning work without internet
//   vectors  → image-recognition fingerprints of each photo (see vision.js)
//   bills    → every saved bill; `synced: false` until it reaches Firestore
import { CapacitorHttp } from '@capacitor/core';
import { isNativeApp } from '../lib/catalog.js';

const DB_NAME = 'bfw-billing';
let dbPromise;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const name of ['kv', 'photos', 'vectors', 'bills']) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const getItem = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const putItem = (store, key, value) => run(store, 'readwrite', (s) => s.put(value, key));
export const deleteItem = (store, key) => run(store, 'readwrite', (s) => s.delete(key));
export const allItems = (store) => run(store, 'readonly', (s) => s.getAll());
export const allKeys = (store) => run(store, 'readonly', (s) => s.getAllKeys());

/** Quick fingerprint of what matters for billing, to skip work when nothing changed. */
export function catalogHash(catalog) {
  const s = JSON.stringify(catalog.products.map((p) => [p.id, p.name, p.brand, p.amount, p.finalPrice, p.image ?? '', p.bulkOfferEligible]))
    + JSON.stringify(catalog.offer ?? null);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

export async function saveCatalog(catalog) {
  const hash = catalogHash(catalog);
  const prev = await getItem('kv', 'catalog');
  if (prev?.hash === hash) return { changed: false, savedAt: prev.savedAt };
  const { products, categories, sections, offers, store, generatedOn } = catalog;
  const savedAt = new Date().toISOString();
  await putItem('kv', 'catalog', { hash, savedAt, data: { products, categories, sections, offers, store, generatedOn } });
  return { changed: true, savedAt };
}

export const loadCatalog = () => getItem('kv', 'catalog');

/** Downloads a photo as a Blob. The app uses Android's own network stack (no browser CORS limits). */
async function downloadBlob(url) {
  if (isNativeApp) {
    const res = await CapacitorHttp.get({ url, responseType: 'blob' });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const bin = atob(res.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: res.headers?.['Content-Type'] ?? res.headers?.['content-type'] ?? 'image/webp' });
  }
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/**
 * Makes the photo store match the price list: downloads new or changed photos, drops removed ones.
 * Only items whose photo URL changed are downloaded, so a sync after a small price edit costs nothing.
 */
export async function syncPhotos(products, onProgress = () => {}) {
  const wanted = new Map(products.filter((p) => p.image).map((p) => [p.id, p.image]));
  const stored = new Map((await allItems('photos')).map((p) => [p.id, p]));
  for (const id of await allKeys('photos')) if (!wanted.has(id)) await deleteItem('photos', id);
  const todo = [...wanted].filter(([id, url]) => stored.get(id)?.url !== url);
  let done = 0;
  let failed = 0;
  for (const [id, url] of todo) {
    try {
      await putItem('photos', id, { id, url, blob: await downloadBlob(url) });
    } catch {
      failed++;
    }
    onProgress(++done, todo.length);
  }
  return { total: wanted.size, downloaded: done - failed, failed };
}

export async function photoBlobs() {
  return new Map((await allItems('photos')).map((p) => [p.id, p]));
}

// ── Bills ──────────────────────────────────────────────────
const SAFE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Per-phone code, so bill numbers from different counters never clash (e.g. K7Q-0042). */
export async function deviceCode() {
  let code = await getItem('kv', 'device');
  if (!code) {
    code = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => SAFE[b % SAFE.length]).join('');
    await putItem('kv', 'device', code);
  }
  return code;
}

export async function nextBillNo() {
  const code = await deviceCode();
  const n = ((await getItem('kv', 'billSeq')) ?? 0) + 1;
  await putItem('kv', 'billSeq', n);
  return `${code}-${String(n).padStart(4, '0')}`;
}

export const saveBill = (bill) => putItem('bills', bill.billNo, bill);
export const allBills = () => allItems('bills');
