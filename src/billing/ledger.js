// Counter bills from every phone, kept on this device for the Bills list and the Sales dashboard.
//
// Reads stay low: each bill is downloaded once, then again only if someone corrects it. The newest `updatedAt`
// seen so far is kept as a bookmark, and later syncs ask only for bills updated after it. Admins get every bill;
// sales staff only their own (the security rules enforce the same). While the Bills list or Sales tab is open a
// live listener adds new bills as other counters save them; it is closed again when they close.
import {
  collection, deleteField, doc, getDocs, onSnapshot, orderBy, query, serverTimestamp, Timestamp, updateDoc, where,
} from 'firebase/firestore';
import { isAdminRole, SALES_EDIT_MINUTES } from '../lib/staff.js';
import { allBills, allItems, clearStore, getItem, putItem, putMany, saveBill } from './store.js';

const L = {
  db: null,
  staff: null,
  server: new Map(), // billNo → bill as stored in Firestore (normalised)
  local: new Map(), // billNo → bill saved on this phone (pending until uploaded)
  cursor: null, // { seconds, nanoseconds } of the newest updatedAt downloaded
  users: 0, // open views that want live updates
  unsub: null,
  status: 'idle', // idle | syncing | live | error
  error: '',
  listeners: new Set(),
  ready: Promise.resolve(), // finishes when this login's saved bills are loaded
};

const istDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(ms));
const tsMs = (t) => {
  if (!t) return null;
  if (typeof t === 'number') return t;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (t.seconds != null) return t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
  return null;
};
const cmpTs = (a, b) => (a.seconds - b.seconds) || (a.nanoseconds - b.nanoseconds);

/** One shape for bills from Firestore, from this phone's outbox, and from older app versions. */
export function normalizeBill(raw, { pending = false } = {}) {
  const billedAt = raw.billedAt ?? new Date(tsMs(raw.createdAt) ?? Date.now()).toISOString();
  const u = raw.updatedAt;
  return {
    billNo: raw.billNo,
    billedAt,
    day: raw.day ?? istDay(Date.parse(billedAt)),
    device: raw.device ?? String(raw.billNo ?? '').split('-')[0],
    cashierUid: raw.cashierUid ?? '',
    cashierName: raw.cashierName ?? raw.cashier ?? '',
    customer: { name: raw.customer?.name ?? '', phone: raw.customer?.phone ?? '' },
    payment: raw.payment ?? 'cash',
    items: raw.items ?? [],
    totals: raw.totals ?? {},
    status: raw.status === 'void' ? 'void' : 'ok',
    voidReason: raw.voidReason ?? '',
    voidedByName: raw.voidedByName ?? '',
    voidedAtMs: tsMs(raw.voidedAt) ?? raw.voidedAtMs ?? null,
    editedByName: raw.editedByName ?? '',
    editedAtMs: tsMs(raw.editedAt) ?? raw.editedAtMs ?? null,
    createdAtMs: tsMs(raw.createdAt) ?? raw.createdAtMs ?? null,
    updatedAt: u && u.seconds != null ? { seconds: u.seconds, nanoseconds: u.nanoseconds ?? 0 } : null,
    pending,
  };
}

// ── Change notifications for the UI ─────────────────────
let emitQueued = false;
function emit() {
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => {
    emitQueued = false;
    L.listeners.forEach((fn) => fn());
  });
}
/** Calls fn whenever bills change. Returns an unsubscribe function. */
export function onLedger(fn) {
  L.listeners.add(fn);
  return () => L.listeners.delete(fn);
}

// ── Loading and syncing ─────────────────────────────────
const scopeOf = (staff) => (isAdminRole(staff.role) ? 'all' : 'own');

async function saveMeta() {
  await putItem('kv', 'ledgerMeta', { owner: L.staff.uid, scope: scopeOf(L.staff), cursor: L.cursor }).catch(() => {});
}

/** Loads what this phone already has. Another login on the same phone starts from scratch. */
export function initLedger({ db, staff }) {
  stopLive();
  L.db = db;
  L.staff = staff;
  L.cursor = null;
  L.server = new Map();
  L.ready = (async () => {
    const meta = await getItem('kv', 'ledgerMeta').catch(() => null);
    if (!meta || meta.owner !== staff.uid || meta.scope !== scopeOf(staff)) {
      await clearStore('ledger').catch(() => {});
      await saveMeta();
    } else {
      L.cursor = meta.cursor ?? null;
      L.server = new Map((await allItems('ledger').catch(() => [])).map((b) => [b.billNo, b]));
    }
    await reloadLocal();
  })();
  return L.ready.then(() => {
    if (L.users) startLive();
    emit();
  });
}

/** Re-reads the bills saved on this phone (call after saving or uploading one). */
export async function reloadLocal() {
  const list = await allBills().catch(() => []);
  L.local = new Map(list.map((b) => [b.billNo, normalizeBill(b, { pending: !b.synced })]));
  emit();
}

async function absorb(raws) {
  const entries = [];
  for (const raw of raws) {
    if (!raw?.billNo) continue;
    const b = normalizeBill(raw);
    L.server.set(b.billNo, b);
    entries.push([b.billNo, b]);
    if (b.updatedAt && (!L.cursor || cmpTs(b.updatedAt, L.cursor) > 0)) L.cursor = b.updatedAt;
  }
  if (entries.length) await putMany('ledger', entries).catch(() => {});
  await saveMeta();
  emit();
}

async function startLive() {
  if (!L.db || !L.staff || L.unsub || L.status === 'syncing') return;
  L.status = 'syncing';
  L.error = '';
  emit();
  try {
    await L.ready;
    if (L.unsub) return;
    const base = collection(L.db, 'sales');
    const mine = isAdminRole(L.staff.role) ? [] : [where('cashierUid', '==', L.staff.uid)];
    if (!L.cursor) {
      // First time on this phone: everything once (this also picks up bills from older app versions).
      const snap = await getDocs(query(base, ...mine));
      await absorb(snap.docs.map((d) => d.data()));
      L.cursor ??= { seconds: 0, nanoseconds: 0 };
      await saveMeta();
    }
    if (!L.users) {
      L.status = 'idle';
      return emit();
    }
    const since = new Timestamp(L.cursor.seconds, L.cursor.nanoseconds);
    L.unsub = onSnapshot(
      query(base, ...mine, where('updatedAt', '>', since), orderBy('updatedAt')),
      (snap) => {
        // Our own corrections show up first with a pending time; the server's copy follows a moment later.
        const docs = snap.docChanges().filter((c) => c.type !== 'removed' && !c.doc.metadata.hasPendingWrites).map((c) => c.doc.data());
        L.status = 'live';
        L.error = '';
        if (docs.length) absorb(docs);
        else emit();
      },
      (err) => {
        console.warn('Bills sync stopped', err);
        L.unsub = null;
        L.status = 'error';
        L.error = err.code === 'failed-precondition' ? 'The server is still preparing. Try again in a few minutes.' : err.message;
        emit();
      },
    );
  } catch (err) {
    console.warn('Bills sync failed', err);
    L.status = 'error';
    L.error = err.code === 'unavailable' ? 'No internet. Showing the bills this phone already has.' : err.message;
    emit();
  }
}

function stopLive() {
  L.unsub?.();
  L.unsub = null;
  if (L.status !== 'error') L.status = 'idle';
}

/** Keeps bills live while a view is open. Returns the function that closes it again. */
export function watchLedger() {
  L.users++;
  if (L.users === 1 || L.status === 'error') startLive();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    L.users = Math.max(0, L.users - 1);
    if (!L.users) stopLive();
  };
}

/** Try again after an error (e.g. back online). */
export function retryLedger() {
  if (L.users && !L.unsub) {
    L.status = 'idle';
    startLive();
  }
}

export const ledgerStatus = () => ({ status: L.status, error: L.error });

// ── Reading ─────────────────────────────────────────────
/** Every bill this login may see, newest first. The server copy wins; bills not uploaded yet come from this phone. */
export function ledgerBills() {
  const map = new Map(L.local);
  for (const [k, b] of L.server) map.set(k, b);
  let list = [...map.values()];
  if (L.staff && !isAdminRole(L.staff.role)) list = list.filter((b) => b.cashierUid === L.staff.uid);
  return list.sort((a, b) => b.billedAt.localeCompare(a.billedAt));
}

export const findBill = (billNo) => L.server.get(billNo) ?? L.local.get(billNo) ?? null;

/** The most recent customer name used with this phone number (to fill in the checkout form). */
export function nameForPhone(phone) {
  if (!/^\d{10}$/.test(phone)) return '';
  return ledgerBills().find((b) => b.customer.phone === phone && b.customer.name)?.customer.name ?? '';
}

// ── Corrections (one write each) ────────────────────────
/** Whether this login may cancel or correct a bill now, and if not, why. */
export function canChange(b, staff = L.staff) {
  if (!b || !staff) return { ok: false, why: '' };
  if (isAdminRole(staff.role)) return { ok: true };
  if (b.cashierUid !== staff.uid) return { ok: false, why: 'Only an admin can change another person’s bill.' };
  if (b.status === 'void') return { ok: false, why: 'Only an admin can restore a cancelled bill.' };
  if (b.pending) return { ok: true };
  const t0 = b.createdAtMs ?? Date.parse(b.billedAt);
  const left = t0 + SALES_EDIT_MINUTES * 60_000 - Date.now();
  return left > 0
    ? { ok: true, minutesLeft: Math.max(1, Math.round(left / 60_000)) }
    : { ok: false, why: `Bills can be changed for ${SALES_EDIT_MINUTES} minutes. Ask an admin to change this one.` };
}

/** A bill not uploaded yet is changed on this phone; it uploads with the change. */
async function changeLocal(billNo, patch) {
  const raw = await getItem('bills', billNo);
  if (!raw) throw new Error('Bill not found on this phone.');
  await saveBill({ ...raw, ...patch });
  await reloadLocal();
}

async function changeServer(billNo, patch, optimistic) {
  if (!navigator.onLine) throw new Error('Connect to the internet to change an uploaded bill.');
  await updateDoc(doc(L.db, 'sales', billNo), { ...patch, updatedAt: serverTimestamp() });
  const cur = L.server.get(billNo);
  if (cur) {
    L.server.set(billNo, { ...cur, ...optimistic });
    emit();
  }
}

const who = () => ({ uid: L.staff.uid, name: L.staff.name });

export async function voidBill(billNo, reason) {
  const b = findBill(billNo);
  const why = String(reason ?? '').trim().slice(0, 120) || 'Cancelled';
  const { uid, name } = who();
  if (b?.pending) return changeLocal(billNo, { status: 'void', voidReason: why, voidedBy: uid, voidedByName: name, voidedAtMs: Date.now() });
  return changeServer(
    billNo,
    { status: 'void', voidReason: why, voidedAt: serverTimestamp(), voidedBy: uid, voidedByName: name },
    { status: 'void', voidReason: why, voidedByName: name, voidedAtMs: Date.now() },
  );
}

export async function restoreBill(billNo) {
  const b = findBill(billNo);
  const { uid, name } = who();
  if (b?.pending) return changeLocal(billNo, { status: 'ok', voidReason: '', voidedByName: '', voidedAtMs: null, editedByName: name, editedAtMs: Date.now() });
  return changeServer(
    billNo,
    { status: 'ok', voidReason: deleteField(), voidedAt: deleteField(), voidedBy: deleteField(), voidedByName: deleteField(),
      editedAt: serverTimestamp(), editedBy: uid, editedByName: name },
    { status: 'ok', voidReason: '', voidedByName: '', voidedAtMs: null, editedByName: name, editedAtMs: Date.now() },
  );
}

export async function editBill(billNo, { payment, customer }) {
  const b = findBill(billNo);
  const { uid, name } = who();
  const cust = { name: String(customer?.name ?? '').trim().slice(0, 60), phone: String(customer?.phone ?? '').trim() };
  if (b?.pending) return changeLocal(billNo, { payment, customer: cust, editedByName: name, editedAtMs: Date.now() });
  return changeServer(
    billNo,
    { payment, customer: cust, editedAt: serverTimestamp(), editedBy: uid, editedByName: name },
    { payment, customer: cust, editedByName: name, editedAtMs: Date.now() },
  );
}
