// Customer-side Firestore access. Uses the small "lite" SDK: no logins, no live listeners needed.
import { connectFirestoreEmulator, doc, getDoc, getFirestore, serverTimestamp, writeBatch } from 'firebase/firestore/lite';
import { app, EMULATOR_HOST, useEmulators } from './firebase-app.js';
import { isNativeApp } from './catalog.js';
import { newOrderCode, newPickupCode } from './codes.js';
import { toRupees } from './money.js';

export { customerStatus, STATUS, STATUS_FLOW } from './status.js';

const db = app ? getFirestore(app) : null;
if (db && useEmulators) connectFirestoreEmulator(db, EMULATOR_HOST, 8080);

export async function fetchPublicSettings() {
  if (!db) return {};
  try {
    const snap = await getDoc(doc(db, 'settings', 'public'));
    return snap.exists() ? snap.data() : {};
  } catch (err) {
    console.warn('Could not load shop settings', err);
    return {};
  }
}

/** Saves the order (private) and its tracking record (public, no personal details) in one write. */
export async function placeOrder({ customer, fulfilment, address, pickupDate, note, totals, priceListDate }) {
  if (!db) throw new Error('Online ordering is not set up yet. Please call or WhatsApp the shop.');

  const items = totals.lines.map(({ product: p, qty, lineTotal, eligible }) => ({
    id: p.id,
    listNo: p.listNo,
    name: p.name,
    brand: p.brand ?? '',
    qty,
    amount: p.amount,
    finalPrice: p.finalPrice,
    lineTotal: toRupees(lineTotal),
    bulkOfferEligible: eligible,
  }));
  const totalsRupees = {
    itemCount: totals.itemCount,
    amountTotal: toRupees(totals.amountTotal),
    discountTotal: toRupees(totals.discountTotal),
    cartTotal: toRupees(totals.cartTotal),
    eligibleTotal: toRupees(totals.eligibleTotal),
    bulkDiscount: toRupees(totals.bulkDiscount),
    netPayable: toRupees(totals.netPayable),
  };
  const pickupCode = newPickupCode();

  // A clash with an existing code is rejected by the security rules, so retry with a fresh code.
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newOrderCode();
    const order = {
      code,
      pickupCode,
      status: 'new',
      createdAt: serverTimestamp(),
      customer,
      fulfilment,
      items,
      totals: totalsRupees,
      source: isNativeApp ? 'android' : 'web',
      priceListDate: priceListDate ?? '',
      ...(address ? { address } : {}),
      ...(pickupDate ? { pickupDate } : {}),
      ...(note ? { note } : {}),
    };
    const tracking = {
      code,
      status: 'new',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      itemCount: totals.itemCount,
      netPayable: totalsRupees.netPayable,
      fulfilment,
      pickupDate: pickupDate ?? '',
    };
    try {
      const batch = writeBatch(db);
      batch.set(doc(db, 'orders', code), order);
      batch.set(doc(db, 'tracking', code), tracking);
      await batch.commit();
      return { code, pickupCode, items, totals: totalsRupees };
    } catch (err) {
      lastError = err;
      if (err?.code !== 'permission-denied') break;
    }
  }
  if (lastError?.code === 'permission-denied') {
    throw new Error('The shop is not accepting online orders right now. Please call or WhatsApp us.');
  }
  throw new Error('Could not send your order. Check your internet connection and try again.');
}

export async function fetchTracking(code) {
  if (!db) throw new Error('Order tracking is not set up yet.');
  const snap = await getDoc(doc(db, 'tracking', code));
  return snap.exists() ? snap.data() : null;
}

// Full copies of orders booked on this phone/browser (items, totals, pickup code), so customers can see
// them again without an account. They stay until the customer clears the browser's site data.
const MY_ORDERS_KEY = 'bfw.myOrders.v2';

export function getMyOrders() {
  try {
    return JSON.parse(localStorage.getItem(MY_ORDERS_KEY)) ?? [];
  } catch {
    return [];
  }
}

export const getMyOrder = (code) => getMyOrders().find((o) => o.code === code) ?? null;

export function rememberOrder(entry) {
  try {
    const list = [entry, ...getMyOrders().filter((o) => o.code !== entry.code)].slice(0, 30);
    localStorage.setItem(MY_ORDERS_KEY, JSON.stringify(list));
    // Ask the browser not to clear this site's storage when the phone is low on space.
    navigator.storage?.persist?.().catch(() => {});
  } catch {
    /* storage blocked: the customer still has both codes on screen and in WhatsApp */
  }
}
