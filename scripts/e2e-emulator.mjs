// End-to-end check against the local Firebase emulators: customer booking -> tracking -> shop admin -> rules.
// Needs `npm run emulators` running and `npm run seed` done once.   usage: npm run test:e2e
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import {
  collection, connectFirestoreEmulator, doc, getDoc, getDocs, getFirestore, setDoc, updateDoc, writeBatch,
} from 'firebase/firestore';

process.env.BFW_EMULATORS = '1';
const { placeOrder, fetchTracking, fetchPublicSettings } = await import('../src/lib/orders.js');
const { computeTotals } = await import('../src/lib/pricing.js');
const { applyCatalogOverrides, indexPriceList } = await import('../src/lib/catalog.js');

const data = indexPriceList(JSON.parse(readFileSync(new URL('../public/data/price-list.json', import.meta.url), 'utf8')));
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? '✔' : '✘'} ${label}`);
  if (!ok) failures++;
};
const denied = async (fn) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return e.code === 'permission-denied';
  }
};

// Separate Firebase apps for "a stranger" and "the shop".
const strangerApp = initializeApp({ apiKey: 'demo-key', projectId: 'demo-best-fireworks' }, 'stranger');
const stranger = getFirestore(strangerApp);
connectFirestoreEmulator(stranger, '127.0.0.1', 8080);
const shopApp = initializeApp({ apiKey: 'demo-key', projectId: 'demo-best-fireworks' }, 'shop');
const shop = getFirestore(shopApp);
connectFirestoreEmulator(shop, '127.0.0.1', 8080);
const shopAuth = getAuth(shopApp);
connectAuthEmulator(shopAuth, 'http://127.0.0.1:9099', { disableWarnings: true });

// 1. Customer books (same code path as the website)
const cart = new Map([['STD-020', 2], ['OTH-120', 1], ['OTH-091', 1], ['OTH-102', 2]]);
const totals = computeTotals(cart, data.productsById, data.offer, new Set(), '2026-11-01');
const order = await placeOrder({
  customer: { name: 'Test Customer', phone: '9876543210', area: 'Bachupally' },
  fulfilment: 'pickup', pickupDate: '2026-11-06', note: 'Automated test', totals, priceListDate: data.generatedOn,
});
check(/^BFW-[A-HJ-NP-Z2-9]{5}$/.test(order.code), `customer booked order ${order.code} · to pay ₹${order.totals.netPayable} (bulk −₹${order.totals.bulkDiscount})`);
check(/^\d{4}$/.test(order.pickupCode), `customer got a private 4-digit pickup code (${order.pickupCode})`);
check(order.totals.netPayable === 6400 + 11000 + 420 + 240 - 1740, 'totals: bulk 10% applied only to eligible items');

// 2. Customer tracks with the code, sees no personal details
const t = await fetchTracking(order.code);
check(t?.status === 'new' && t.netPayable === order.totals.netPayable, 'tracking page shows status "new" and amount');
check(!('customer' in t) && !('pickupCode' in t), 'tracking record has no name/phone/pickup code');

// 3. Strangers cannot read or tamper with orders
check(await denied(() => getDoc(doc(stranger, 'orders', order.code))), 'stranger cannot read the order');
check(await denied(() => getDocs(collection(stranger, 'orders'))), 'stranger cannot list orders');
check(await denied(() => getDocs(collection(stranger, 'tracking'))), 'stranger cannot list tracking codes');
check(await denied(() => updateDoc(doc(stranger, 'tracking', order.code), { status: 'completed' })), 'stranger cannot change status');
check(await denied(async () => {
  const b = writeBatch(stranger);
  b.set(doc(stranger, 'orders', 'BFW-FAKE2'), { code: 'BFW-FAKE2', status: 'confirmed' });
  await b.commit();
}), 'malformed order is rejected');

// 4. Shop signs in, sees the order, confirms it
await signInWithEmailAndPassword(shopAuth, 'admin@bestfireworks.test', 'diwali2026');
const list = await getDocs(collection(shop, 'orders'));
check(list.docs.some((d) => d.id === order.code), `shop sees the order (${list.size} total)`);
check(list.docs.find((d) => d.id === order.code)?.data().pickupCode === order.pickupCode, 'shop sees the pickup code to verify at handover');
const b = writeBatch(shop);
b.update(doc(shop, 'orders', order.code), { status: 'confirmed', shopMessage: 'Collect at counter 2' });
b.set(doc(shop, 'tracking', order.code), { status: 'confirmed', message: 'Collect at counter 2' }, { merge: true });
await b.commit();
const t2 = await fetchTracking(order.code);
check(t2.status === 'confirmed' && t2.message === 'Collect at counter 2', 'customer tracking shows "confirmed" + shop message');

// 5. Shop pauses orders -> customers are blocked; sold-out list is public
await setDoc(doc(shop, 'settings', 'public'), { ordersOpen: false, soldOut: ['OTH-121'] }, { merge: true });
const s = await fetchPublicSettings();
check(s.ordersOpen === false && s.soldOut.includes('OTH-121'), 'customers can read sold-out list and paused flag');
let blocked = false;
try {
  await placeOrder({ customer: { name: 'Late Customer', phone: '9876543211' }, fulfilment: 'pickup', totals, priceListDate: data.generatedOn });
} catch (e) {
  blocked = /not accepting/.test(e.message);
}
check(blocked, 'booking is refused while orders are paused');
await setDoc(doc(shop, 'settings', 'public'), { ordersOpen: true, soldOut: [] }, { merge: true });

// 6. Shop edits prices / adds / hides items from the admin page -> customers see it on next load
await setDoc(doc(shop, 'settings', 'public'), {
  catalog: {
    'OTH-001': { finalPrice: 35, amount: 45 },
    'OTH-002': { hidden: true },
    'ADD-TEST2': { custom: true, categoryId: 'oth-sounds', name: 'NEW TEST BOMB', brand: 'TEST', pcsPerBox: 5,
      amount: 100, finalPrice: 80, bulkOfferEligible: true, createdAt: '2026-10-28T00:00:00Z' },
  },
}, { merge: true });
const seen = indexPriceList(applyCatalogOverrides(JSON.parse(readFileSync(new URL('../public/data/price-list.json', import.meta.url), 'utf8')), (await fetchPublicSettings()).catalog));
const edited = seen.productsById.get('OTH-001');
const added = seen.productsById.get('ADD-TEST2');
check(edited.finalPrice === 35 && edited.discount === 10 && edited.discountPercent === 22.22, 'edited price shows to customers (₹45 → ₹35, 22% off)');
check(!seen.productsById.has('OTH-002'), 'hidden item is gone from the customer price list');
check(added?.category === 'Sounds' && added.listNo === 146 && added.finalPrice === 80, `shop-added item appears in Sounds as #${added?.listNo}`);
check(await denied(() => setDoc(doc(stranger, 'settings', 'public'), { catalog: { 'OTH-001': { finalPrice: 1 } } }, { merge: true })), 'stranger cannot change prices');
await setDoc(doc(shop, 'settings', 'public'), { catalog: {} }, { mergeFields: ['catalog'] });

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
