// End-to-end check against the local Firebase emulators: customer booking -> tracking -> shop admin -> rules ->
// counter bills -> shop users and roles (Cloud Function).
// Needs `npm run emulators` running and `npm run seed` done once.   usage: npm run test:e2e
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import {
  collection, connectFirestoreEmulator, deleteDoc, deleteField, doc, getDoc, getDocs, getFirestore, query,
  serverTimestamp, setDoc, updateDoc, where, writeBatch,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';

process.env.BFW_EMULATORS = '1';
const { placeOrder, fetchTracking, fetchPublicSettings } = await import('../src/lib/orders.js');
const { computeTotals } = await import('../src/lib/pricing.js');
const { applyCatalogOverrides, indexPriceList } = await import('../src/lib/catalog.js');
const { loginEmail } = await import('../src/lib/staff.js');

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

// 6. Home delivery only while the shop has switched it on
const deliveryOrder = () => placeOrder({
  customer: { name: 'Delivery Customer', phone: '9876543212' }, fulfilment: 'delivery',
  address: 'Flat 101, Test Residency, Bachupally', totals, priceListDate: data.generatedOn,
});
await setDoc(doc(shop, 'settings', 'public'), { deliveryEnabled: false }, { merge: true });
let deliveryBlocked = false;
try { await deliveryOrder(); } catch { deliveryBlocked = true; }
check(deliveryBlocked, 'delivery order refused while home delivery is off');
await setDoc(doc(shop, 'settings', 'public'), { deliveryEnabled: true }, { merge: true });
const del = await deliveryOrder();
check(/^BFW-/.test(del.code) && (await fetchTracking(del.code))?.fulfilment === 'delivery', `delivery order accepted once switched on (${del.code})`);
await setDoc(doc(shop, 'settings', 'public'), { deliveryEnabled: false }, { merge: true });

// 7. Shop edits prices / adds / hides items from the admin page -> customers see it on next load
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

// 8. Counter billing: one write per bill, shop staff only
const shopUid = shopAuth.currentUser.uid;
const billNo = `E2E-${String(Date.now()).slice(-5)}`;
const bill = (over = {}) => ({
  billNo, billedAt: new Date().toISOString(), day: '2026-11-06', payment: 'upi', source: 'counter', status: 'ok',
  cashierUid: shopUid, cashierName: 'Shop owner', customer: { name: '', phone: '' },
  items: [{ id: 'STD-020', name: 'Test', qty: 1, finalPrice: 3200, lineTotal: 3200 }],
  totals: { itemCount: 1, netPayable: 3200, paid: 3150, adjustment: -50 },
  createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over,
});
check(await denied(() => setDoc(doc(stranger, 'sales', billNo), bill())), 'stranger cannot save a counter bill');
check(await denied(() => setDoc(doc(shop, 'sales', billNo), bill({ payment: 'cheque' }))), 'bill with an unknown payment mode is refused');
check(await denied(() => setDoc(doc(shop, 'sales', 'OTHER-1'), bill())), 'bill saved under a different number is refused');
check(await denied(() => setDoc(doc(shop, 'sales', billNo), bill({ updatedAt: null }))), 'bill without the server time is refused');
await setDoc(doc(shop, 'sales', billNo), bill());
check((await getDoc(doc(shop, 'sales', billNo))).data()?.totals.paid === 3150, `shop saved counter bill ${billNo} in one write`);
check(await denied(() => getDocs(collection(stranger, 'sales'))), 'stranger cannot list counter bills');
check(await denied(() => deleteDoc(doc(shop, 'sales', billNo))), 'bills can never be deleted, only cancelled');

// 9. Shop users and roles (Users tab → staffUsers Cloud Function; needs the functions emulator)
const CFG = { apiKey: 'demo-key', projectId: 'demo-best-fireworks' };
const errorCode = async (fn) => {
  try {
    await fn();
    return 'ok';
  } catch (e) {
    return e.code;
  }
};
function login(name) {
  const a = initializeApp(CFG, `${name}-${Date.now()}`);
  const fdb = getFirestore(a);
  connectFirestoreEmulator(fdb, '127.0.0.1', 8080);
  const fauth = getAuth(a);
  connectAuthEmulator(fauth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const fns = getFunctions(a, 'asia-south1');
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  return { db: fdb, auth: fauth, users: (data) => httpsCallable(fns, 'staffUsers')(data).then((r) => r.data) };
}
const owner = login('owner');
await signInWithEmailAndPassword(owner.auth, 'admin@bestfireworks.test', 'diwali2026');
const tag = String(Date.now()).slice(-5);
const salesUser = `ravi${tag}`;
const adminUser = `meena${tag}`;
const ravi = await owner.users({ action: 'create', name: 'Ravi Test', username: salesUser, password: 'counter1', role: 'sales' });
check(!!ravi.uid, `super admin added salesperson @${salesUser}`);
const meena = await owner.users({ action: 'create', name: 'Meena Test', username: adminUser, password: 'admin123', role: 'admin' });
check(!!meena.uid, `super admin added admin @${adminUser}`);
check(await errorCode(() => owner.users({ action: 'create', name: 'Copy', username: salesUser, password: 'xxxxxx', role: 'sales' })) === 'functions/already-exists',
  'a username cannot be used twice');
check(await errorCode(() => owner.users({ action: 'create', name: 'Bad', username: 'Has Space', password: 'xxxxxx', role: 'sales' })) === 'functions/invalid-argument',
  'usernames with spaces are refused');
const listed = (await owner.users({ action: 'list' })).users;
check(listed.find((u) => u.uid === ravi.uid)?.role === 'sales' && listed.find((u) => u.uid === meena.uid)?.role === 'admin', 'user list shows both with their roles');

// Salesperson: signs in with just the username
const sales = login('sales');
await signInWithEmailAndPassword(sales.auth, loginEmail(salesUser), 'counter1');
check(sales.auth.currentUser?.uid === ravi.uid, 'salesperson signs in with username and password');
check(!(await denied(() => getDocs(collection(sales.db, 'orders')))), 'salesperson can see online orders');
check(await denied(() => setDoc(doc(sales.db, 'settings', 'public'), { notice: 'x' }, { merge: true })), 'salesperson cannot change prices or shop settings');
const rBill = `E2S-${tag}`;
const salesBill = (over = {}) => bill({ billNo: rBill, cashierUid: ravi.uid, cashierName: 'Ravi Test', ...over });
check(await denied(() => setDoc(doc(sales.db, 'sales', rBill), salesBill({ cashierUid: shopUid }))), 'salesperson cannot save a bill in someone else’s name');
await setDoc(doc(sales.db, 'sales', rBill), salesBill());
check(true, `salesperson saved their own bill ${rBill}`);
check(await denied(() => getDocs(collection(sales.db, 'sales'))), 'salesperson cannot list everyone’s bills');
check(await denied(() => getDoc(doc(sales.db, 'sales', billNo))), 'salesperson cannot open the owner’s bill');
const mine = await getDocs(query(collection(sales.db, 'sales'), where('cashierUid', '==', ravi.uid)));
check(mine.size === 1 && mine.docs[0].id === rBill, 'salesperson sees only their own bills');
check(await denied(() => updateDoc(doc(sales.db, 'sales', rBill), { 'totals.paid': 1, updatedAt: serverTimestamp() })), 'nobody can change the amount of a saved bill');
await updateDoc(doc(sales.db, 'sales', rBill), { payment: 'cash', editedByName: 'Ravi Test', updatedAt: serverTimestamp() });
check((await getDoc(doc(sales.db, 'sales', rBill))).data()?.payment === 'cash', 'salesperson fixed the payment mode of their own bill');
await updateDoc(doc(sales.db, 'sales', rBill), { status: 'void', voidReason: 'Test bill', voidedByName: 'Ravi Test', updatedAt: serverTimestamp() });
check(true, 'salesperson cancelled their own bill (allowed for 30 minutes)');
check(await denied(() => updateDoc(doc(sales.db, 'sales', rBill), { status: 'ok', updatedAt: serverTimestamp() })), 'only an admin can restore a cancelled bill');
check(await errorCode(() => sales.users({ action: 'list' })) === 'functions/permission-denied', 'salesperson cannot manage users');

// Admin: everyone's bills, no Users tab
const admin = login('admin');
await signInWithEmailAndPassword(admin.auth, loginEmail(adminUser), 'admin123');
check((await getDocs(collection(admin.db, 'sales'))).size >= 2, 'admin sees every bill');
await updateDoc(doc(admin.db, 'sales', rBill), { status: 'ok', voidReason: deleteField(), editedByName: 'Meena Test', updatedAt: serverTimestamp() });
check((await getDoc(doc(admin.db, 'sales', rBill))).data()?.status === 'ok', 'admin restored the cancelled bill');
check(!(await denied(() => setDoc(doc(admin.db, 'settings', 'public'), { notice: '' }, { merge: true }))), 'admin can change shop settings');
check(await errorCode(() => admin.users({ action: 'list' })) === 'functions/permission-denied', 'admin cannot manage users (super admin only)');

// Super admin: passwords, switching off, guards
await owner.users({ action: 'password', uid: ravi.uid, password: 'newpass9' });
const fresh = login('fresh');
check(await errorCode(() => signInWithEmailAndPassword(fresh.auth, loginEmail(salesUser), 'counter1')) !== 'ok', 'old password stops working');
check(await errorCode(() => signInWithEmailAndPassword(fresh.auth, loginEmail(salesUser), 'newpass9')) === 'ok', 'new password set by the owner works');
await owner.users({ action: 'update', uid: ravi.uid, active: false });
check(await denied(() => getDocs(collection(sales.db, 'orders'))), 'a switched-off login loses access straight away');
check(await errorCode(() => signInWithEmailAndPassword(login('again').auth, loginEmail(salesUser), 'newpass9')) === 'auth/user-disabled',
  'a switched-off login cannot sign in');
check(await errorCode(() => owner.users({ action: 'update', uid: shopUid, role: 'admin' })) === 'functions/failed-precondition',
  'the super admin cannot remove their own super admin access');
check(await errorCode(() => owner.users({ action: 'delete', uid: shopUid })) === 'functions/failed-precondition', 'the super admin cannot delete their own login');
await owner.users({ action: 'delete', uid: ravi.uid });
await owner.users({ action: 'delete', uid: meena.uid });
const left = (await owner.users({ action: 'list' })).users;
check(!left.some((u) => u.uid === ravi.uid || u.uid === meena.uid), 'deleted users are gone (their bills stay)');
check((await getDoc(doc(shop, 'sales', rBill))).exists(), 'a deleted salesperson’s bills stay in the records');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
