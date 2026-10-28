import {
  connectAuthEmulator, getAuth, onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword, signOut,
} from 'firebase/auth';
import {
  arrayRemove, arrayUnion, collection, connectFirestoreEmulator, doc, getDoc, getFirestore, limit, onSnapshot, orderBy,
  query, serverTimestamp, setDoc, Timestamp, writeBatch,
} from 'firebase/firestore';
import { getMessaging, getToken, isSupported } from 'firebase/messaging';
import { SITE_URL, vapidKey } from './config.js';
import { escapeHtml, indexPriceList, loadPriceList, prettyPhone, telLink, waLink } from './lib/catalog.js';
import { cleanCodeInput, normalizeOrderCode } from './lib/codes.js';
import { app, EMULATOR_HOST, useEmulators } from './lib/firebase-app.js';
import { formatDate, formatDateTime, formatPaise, formatRupees, toPaise } from './lib/money.js';
import { computeTotals } from './lib/pricing.js';
import { STATUS } from './lib/status.js';

const $ = (sel, root = document) => root.querySelector(sel);
const db = app ? getFirestore(app) : null;
const auth = app ? getAuth(app) : null;
if (useEmulators) {
  connectFirestoreEmulator(db, EMULATOR_HOST, 8080);
  connectAuthEmulator(auth, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
}

const PREFS_KEY = 'bfw.admin.prefs.v1';
const prefs = { sound: true, repeat: true, wake: false, ...readJson(PREFS_KEY) };

const state = {
  user: null,
  catalog: null,
  orders: new Map(),
  settings: { soldOut: [], ordersOpen: true, notice: '' },
  filter: 'active',
  search: '',
  productSearch: '',
  firstSnapshot: true,
  openCode: null,
  fresh: new Set(),
  // Set when the shop taps a notification: /admin?order=BFW-K7Q2M (&call=1 from its "Call" button)
  deepLinkCode: normalizeOrderCode(new URLSearchParams(location.search).get('order')),
  deepLinkCall: new URLSearchParams(location.search).get('call') === '1',
  pulseCall: false,
};
let unsubs = [];
let swReg = null;
let audioCtx = null;

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? {};
  } catch {
    return {};
  }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch { /* ignore */ }
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

function show(viewId) {
  for (const id of ['setup-view', 'login-view', 'denied-view', 'app-view']) $(`#${id}`).hidden = id !== viewId;
}

const trackUrl = (code) =>
  import.meta.env.DEV || SITE_URL.includes('YOUR-') ? `${location.origin}/track.html?code=${code}` : `${SITE_URL}/track?code=${code}`;
const customerWa = (o, text) => waLink(`+91${o.customer.phone}`, text);
const firstName = (o) => String(o.customer?.name ?? '').split(' ')[0];
const istDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
const sortedOrders = () =>
  [...state.orders.values()].sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));

// ── Auth ─────────────────────────────────────────────────
function setupAuth() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.hidden = true;
    unlockAudio();
    try {
      await signInWithEmailAndPassword(auth, e.target.email.value.trim(), e.target.password.value);
    } catch (ex) {
      err.textContent = /invalid|wrong|not-found|credential/i.test(ex.code ?? '') ? 'Wrong email or password.' : ex.message;
      err.hidden = false;
    }
  });
  $('#forgot').addEventListener('click', async () => {
    const email = $('#login-form').email.value.trim();
    if (!email) return toast('Type your email first, then tap “Forgot password?”');
    try {
      await sendPasswordResetEmail(auth, email);
      toast('Password reset email sent.');
    } catch (ex) {
      toast(ex.message);
    }
  });
  $('#sign-out').addEventListener('click', () => signOut(auth));
  $('#copy-uid').addEventListener('click', () => navigator.clipboard?.writeText($('#my-uid').textContent).then(() => toast('Copied')));

  onAuthStateChanged(auth, async (user) => {
    unsubs.forEach((u) => u());
    unsubs = [];
    state.orders.clear();
    state.firstSnapshot = true;
    $('#top-right').hidden = !user;
    if (!user) return show('login-view');

    let isAdmin = false;
    try {
      isAdmin = (await getDoc(doc(db, 'admins', user.uid))).exists();
    } catch { /* rules deny -> not an admin */ }
    if (!isAdmin) {
      $('#my-uid').textContent = user.uid;
      return show('denied-view');
    }
    state.user = user;
    show('app-view');
    startApp();
  });
}

// ── App ──────────────────────────────────────────────────
async function startApp() {
  if (!state.catalog) {
    try {
      state.catalog = indexPriceList(await loadPriceList());
    } catch {
      toast('Could not load the price list. Price checks are off.');
    }
  }

  unsubs.push(
    onSnapshot(
      query(collection(db, 'orders'), orderBy('createdAt', 'desc'), limit(500)),
      (snap) => {
        const added = [];
        for (const ch of snap.docChanges()) {
          if (ch.type === 'removed') state.orders.delete(ch.doc.id);
          else state.orders.set(ch.doc.id, ch.doc.data());
          if (ch.type === 'added' && !state.firstSnapshot) added.push(ch.doc.data());
        }
        state.firstSnapshot = false;
        renderOrders();
        if (added.length) announce(added);
        if (state.openCode && $('#order-dialog').open) renderDetail(state.openCode);
        if (state.deepLinkCode && state.orders.has(state.deepLinkCode)) {
          state.pulseCall = state.deepLinkCall;
          openOrder(state.deepLinkCode);
          state.deepLinkCode = null;
          history.replaceState(null, '', location.pathname);
        }
      },
      (err) => {
        console.error(err);
        $('#order-list').innerHTML = `<p class="a-error">Could not load orders: ${escapeHtml(err.message)}</p>`;
      },
    ),
  );

  unsubs.push(
    onSnapshot(doc(db, 'settings', 'public'), (snap) => {
      state.settings = { soldOut: [], ordersOpen: true, notice: '', ...(snap.data() ?? {}) };
      fillSettingsForm();
      renderProducts();
    }),
  );

  setupAlerts();
}

// ── Orders list ──────────────────────────────────────────
const FILTERS = [
  ['active', 'Active', (o) => ['new', 'confirmed', 'ready'].includes(o.status)],
  ['new', 'New', (o) => o.status === 'new'],
  ['confirmed', 'Confirmed', (o) => o.status === 'confirmed'],
  ['ready', 'Ready', (o) => o.status === 'ready'],
  ['completed', 'Completed', (o) => o.status === 'completed'],
  ['cancelled', 'Cancelled', (o) => o.status === 'cancelled'],
  ['all', 'All', () => true],
];

function filteredOrders() {
  const test = FILTERS.find(([id]) => id === state.filter)[2];
  // Hyphens and spaces are ignored, so "k7q2m", "bfwk7q2m" and "BFW-K7Q2M" all find the same order.
  const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const q = squash(state.search);
  return sortedOrders().filter(
    (o) => test(o) && (!q || squash(`${o.code}|${o.customer?.name}|${o.customer?.phone}`).includes(q)),
  );
}

function renderOrders() {
  const all = [...state.orders.values()];
  $('#status-chips').innerHTML = FILTERS.map(([id, label, test]) => {
    const n = all.filter(test).length;
    return `<button type="button" data-filter="${id}" aria-pressed="${state.filter === id}">${label} (${n})</button>`;
  }).join('');

  const newCount = all.filter((o) => o.status === 'new').length;
  const badge = $('#new-count');
  badge.textContent = newCount;
  badge.hidden = !newCount;
  document.title = `${newCount ? `(${newCount}) ` : ''}Shop Admin – Best FireWorks`;

  const list = filteredOrders();
  $('#order-list').innerHTML = list.length
    ? list.map(orderCard).join('')
    : `<p class="muted">${state.orders.size ? 'No orders in this view.' : 'No orders yet. New orders appear here instantly.'}</p>`;
}

function orderCard(o) {
  const created = o.createdAt?.toDate?.();
  return `<div role="button" tabindex="0" class="o-card st-${o.status}${state.fresh.has(o.code) ? ' fresh' : ''}" data-code="${o.code}">
      <span class="o-code">${o.code}</span>
      <span class="o-amt">${formatRupees(o.totals?.netPayable ?? 0)}</span>
      <span>${escapeHtml(o.customer?.name)} · ${escapeHtml(o.customer?.phone)}</span>
      <span><span class="badge status-${o.status}">${STATUS[o.status]?.admin ?? o.status}</span></span>
      <span class="o-sub">${formatDateTime(created)} · ${o.totals?.itemCount ?? 0} boxes${o.pickupDate ? ` · pickup ${formatDate(o.pickupDate)}` : ''}${o.fulfilment === 'delivery' ? ' · 🚚 delivery' : ''}</span>
      <span class="o-actions">
        <a class="btn btn-sm btn-wa" href="${telLink(`+91${o.customer?.phone}`)}">📞 Call</a>
        <a class="btn btn-sm btn-soft" href="${customerWa(o, `Hi ${firstName(o)}, this is Best FireWorks about your order *${o.code}*.`)}" target="_blank" rel="noopener">💬 WhatsApp</a>
      </span>
    </div>`;
}

// ── Order detail ─────────────────────────────────────────
function openOrder(code) {
  state.openCode = code;
  state.fresh.delete(code);
  renderDetail(code);
  const dlg = $('#order-dialog');
  if (!dlg.open) dlg.showModal();
}

function priceCheckHtml(o) {
  if (!state.catalog) return '';
  const { productsById, offer } = state.catalog;
  const qty = new Map(o.items.map((i) => [i.id, i.qty]));
  const date = o.createdAt?.toDate ? istDate(o.createdAt.toDate()) : undefined;
  const expected = computeTotals(qty, productsById, offer, new Set(), date);
  const changed = o.items.filter((i) => {
    const p = productsById.get(i.id);
    return !p || toPaise(p.finalPrice) !== toPaise(i.finalPrice);
  });
  if (!changed.length && expected.netPayable === toPaise(o.totals.netPayable)) {
    return '<p class="ok">✓ Prices match the current price list.</p>';
  }
  return `<p class="warn">⚠ This order does not match the current price list (expected ${formatPaise(expected.netPayable)}).
    ${changed.length ? `Changed: ${changed.map((i) => escapeHtml(i.name)).join(', ')}.` : ''} Check before billing.</p>`;
}

function itemsTableHtml(o) {
  const t = o.totals;
  return `<table class="items">
      <thead><tr><th>#</th><th>Item</th><th class="num">Rate</th><th class="num">Qty</th><th class="num">Total</th></tr></thead>
      <tbody>${o.items.map((i) => `<tr>
          <td>${i.id.startsWith('STD') ? 'S' : ''}${i.listNo ?? ''}</td>
          <td>${escapeHtml(i.name)}<br /><small class="muted">${escapeHtml(i.brand)}${i.bulkOfferEligible ? '' : ' · no bulk offer'}</small></td>
          <td class="num">${formatRupees(i.finalPrice)}</td>
          <td class="num">${i.qty}</td>
          <td class="num">${formatRupees(i.lineTotal)}</td>
        </tr>`).join('')}</tbody>
      <tfoot>
        <tr><td colspan="4">Amount</td><td class="num">${formatRupees(t.amountTotal)}</td></tr>
        <tr><td colspan="4">Discount</td><td class="num">−${formatRupees(t.discountTotal)}</td></tr>
        <tr><td colspan="4">Subtotal</td><td class="num">${formatRupees(t.cartTotal)}</td></tr>
        ${t.bulkDiscount ? `<tr><td colspan="4">Bulk offer (extra 10%)</td><td class="num">−${formatRupees(t.bulkDiscount)}</td></tr>` : ''}
        <tr class="net"><td colspan="4">To pay</td><td class="num">${formatRupees(t.netPayable)}</td></tr>
      </tfoot>
    </table>`;
}

function renderDetail(code) {
  const o = state.orders.get(code);
  if (!o) return;
  const c = o.customer;
  const created = o.createdAt?.toDate?.();
  const hist = (o.statusHistory ?? [])
    .map((h) => `<li>${STATUS[h.status]?.admin ?? h.status} · ${formatDateTime(h.at?.toDate?.())}${h.by ? ` · ${escapeHtml(h.by)}` : ''}</li>`)
    .join('');
  const actions = [
    ['confirmed', '✅ Confirm'],
    ['ready', '📦 Ready for pickup'],
    ['completed', '🎉 Completed'],
    ['cancelled', '✖ Cancel'],
  ];

  $('#order-detail').innerHTML = `
    <div class="d-head">
      <h2>${o.code} <span class="badge status-${o.status}">${STATUS[o.status]?.admin ?? o.status}</span></h2>
      <button class="close" type="button" data-act="close" aria-label="Close">✕</button>
    </div>
    <div class="d-body">
      <div class="d-cust">
        <span class="name">${escapeHtml(c.name)}</span>
        <span>📱 ${escapeHtml(c.phone)}${c.area ? ` · ${escapeHtml(c.area)}` : ''}</span>
        <span>${o.fulfilment === 'delivery' ? `🚚 Delivery: ${escapeHtml(o.address ?? '')}` : '🏪 Pickup at stall'}${o.pickupDate ? ` · ${formatDate(o.pickupDate)}` : ''}</span>
        ${o.note ? `<span>📝 ${escapeHtml(o.note)}</span>` : ''}
        <span class="o-sub">Booked ${formatDateTime(created)} from ${o.source === 'android' ? 'Android app' : 'website'}</span>
        <div class="d-row-btns">
          <a class="btn btn-sm btn-wa${state.pulseCall ? ' call-pulse' : ''}" href="${telLink(`+91${c.phone}`)}">📞 Call ${escapeHtml(c.phone)}</a>
          <a class="btn btn-sm btn-soft" href="${customerWa(o, `Hi ${firstName(o)}, this is Best FireWorks about your order *${o.code}*.`)}" target="_blank" rel="noopener">💬 WhatsApp</a>
          <button class="btn btn-sm btn-soft" type="button" data-act="print">🖨 Print</button>
        </div>
      </div>

      ${o.status === 'new' ? `<p class="hint">Before confirming, check that the customer's WhatsApp message came from ${escapeHtml(c.phone)} and shows pickup code <strong>${escapeHtml(o.pickupCode ?? '—')}</strong>, or call them. This stops fake bookings made with someone else's number.</p>` : ''}

      ${itemsTableHtml(o)}
      ${priceCheckHtml(o)}

      <div class="pickup-box">
        <strong>Pickup code check</strong>
        <span class="o-sub">Ask the customer for their 4-digit pickup code before handing over the order.</span>
        <div class="row">
          <input id="d-pin" inputmode="numeric" maxlength="4" placeholder="••••" autocomplete="off" aria-label="Pickup code from customer" />
          <span class="pin-result" id="d-pin-result"></span>
        </div>
        <button type="button" class="link" data-act="reveal-pin">Show code</button>
      </div>

      <div class="d-status">
        <h3>Update status</h3>
        <label class="switch"><input type="checkbox" id="d-send-wa" checked /> Also send the customer a WhatsApp update</label>
        <label>Message to customer <small class="muted">(shown on their tracking page and added to the WhatsApp text)</small>
          <textarea id="d-message" rows="2" maxlength="300" placeholder="e.g. Collect from counter 2 after 6 pm">${escapeHtml(o.shopMessage ?? '')}</textarea>
        </label>
        <div class="d-status-btns">
          ${actions.map(([s, label]) => `<button type="button" class="btn ${s === 'cancelled' ? 'btn-danger' : 'btn-soft'}${o.status === s ? ' current' : ''}" data-status="${s}">${label}</button>`).join('')}
        </div>
        <button type="button" class="btn btn-sm btn-soft" data-act="save-msg">Save message only</button>
        ${hist ? `<ol class="d-hist">${hist}</ol>` : ''}
      </div>
    </div>`;
}

function customerMessage(o, status, extra) {
  const name = firstName(o);
  const pay = formatRupees(o.totals.netPayable);
  const store = state.catalog?.store;
  const lines = {
    confirmed: `Hi ${name}, your Best FireWorks order *${o.code}* is confirmed ✅\nAmount to pay at the stall: *${pay}* (Cash / UPI / Card).\nWe will message you when it is packed and ready.`,
    ready: `Hi ${name}, your order *${o.code}* is packed and ready for pickup 🎆\nAmount to pay: *${pay}* (Cash / UPI / Card).\nPlease bring your 4-digit pickup code.${store ? `\nStall: ${store.address.display}\nDirections: ${store.directionsUrl}` : ''}`,
    completed: `Thank you ${name} for shopping with Best FireWorks! Wishing you and your family a very Happy Diwali 🪔`,
    cancelled: `Hi ${name}, your order *${o.code}* has been cancelled.${store ? ` Please call us on ${prettyPhone(store.phones[0])} if you have any questions.` : ''}`,
  };
  let text = lines[status] ?? `Hi ${name}, this is Best FireWorks about your order *${o.code}*.`;
  if (extra) text += `\n\n${extra}`;
  if (status !== 'completed') text += `\n\nTrack your order: ${trackUrl(o.code)}`;
  return text;
}

function changeStatus(code, status) {
  const o = state.orders.get(code);
  if (!o) return;
  if (status === 'cancelled' && !confirm(`Cancel order ${code}?`)) return;
  const message = $('#d-message').value.trim();
  // Open WhatsApp first, inside the tap, so the browser does not block it as a pop-up.
  if ($('#d-send-wa').checked) window.open(customerWa(o, customerMessage(o, status, message)), '_blank', 'noopener');

  const batch = writeBatch(db);
  batch.update(doc(db, 'orders', code), {
    status,
    shopMessage: message,
    updatedAt: serverTimestamp(),
    statusHistory: arrayUnion({ status, at: Timestamp.now(), by: state.user.email ?? '' }),
  });
  batch.set(doc(db, 'tracking', code), { status, message, updatedAt: serverTimestamp() }, { merge: true });
  batch
    .commit()
    .then(() => toast(`${code} marked ${STATUS[status].admin}`))
    .catch((err) => toast(`Could not save: ${err.message}`));
}

function saveMessage(code) {
  const message = $('#d-message').value.trim();
  const batch = writeBatch(db);
  batch.update(doc(db, 'orders', code), { shopMessage: message, updatedAt: serverTimestamp() });
  batch.set(doc(db, 'tracking', code), { message, updatedAt: serverTimestamp() }, { merge: true });
  batch.commit().then(() => toast('Message saved')).catch((err) => toast(`Could not save: ${err.message}`));
}

function printOrder(code) {
  const o = state.orders.get(code);
  const store = state.catalog?.store;
  $('#print-area').innerHTML = `
    <h2>Best FireWorks · Order ${o.code}</h2>
    <p>${escapeHtml(o.customer.name)} · ${escapeHtml(o.customer.phone)}${o.customer.area ? ` · ${escapeHtml(o.customer.area)}` : ''}<br />
      ${o.fulfilment === 'delivery' ? `Delivery: ${escapeHtml(o.address ?? '')}` : 'Pickup at stall'}${o.pickupDate ? ` · ${formatDate(o.pickupDate)}` : ''}<br />
      Booked ${formatDateTime(o.createdAt?.toDate?.())} · Status: ${STATUS[o.status]?.admin}</p>
    ${o.note ? `<p>Note: ${escapeHtml(o.note)}</p>` : ''}
    ${itemsTableHtml(o)}
    ${store ? `<p>${escapeHtml(store.address.display)} · ${store.phones.map(prettyPhone).join(', ')}</p>` : ''}`;
  window.print();
}

function setupOrderUi() {
  $('#status-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    state.filter = b.dataset.filter;
    renderOrders();
  });
  $('#order-search').addEventListener('input', (e) => {
    state.search = e.target.value.trim();
    renderOrders();
  });
  $('#order-list').addEventListener('click', (e) => {
    if (e.target.closest('a')) return; // Call / WhatsApp buttons on the card
    const card = e.target.closest('[data-code]');
    if (card) openOrder(card.dataset.code);
  });
  $('#order-list').addEventListener('keydown', (e) => {
    const card = e.target.closest('[data-code]');
    if (card && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openOrder(card.dataset.code);
    }
  });

  // Quick find: the shop types only the 5 characters after "BFW-"; the order opens as soon as it matches.
  const qc = $('#quick-code');
  const qMsg = $('#quick-msg');
  const tryOpen = () => {
    const code = normalizeOrderCode(qc.value);
    if (!code) return false;
    if (!state.orders.has(code)) {
      qMsg.textContent = `No order ${code} in the last 500 orders.`;
      return false;
    }
    qMsg.textContent = '';
    openOrder(code);
    qc.value = '';
    return true;
  };
  qc.addEventListener('input', () => {
    qc.value = cleanCodeInput(qc.value);
    qMsg.textContent = '';
    if (qc.value.length === 5) tryOpen();
  });
  $('#quick-find').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!tryOpen() && !qMsg.textContent) qMsg.textContent = 'Type the 5 letters/numbers after BFW-';
  });

  const dlg = $('#order-dialog');
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-act="close"]')) return dlg.close();
    const s = e.target.closest('[data-status]');
    if (s) return changeStatus(state.openCode, s.dataset.status);
    if (e.target.closest('[data-act="save-msg"]')) return saveMessage(state.openCode);
    if (e.target.closest('[data-act="print"]')) return printOrder(state.openCode);
    const reveal = e.target.closest('[data-act="reveal-pin"]');
    if (reveal) reveal.textContent = `Pickup code: ${state.orders.get(state.openCode)?.pickupCode ?? '—'}`;
  });
  dlg.addEventListener('input', (e) => {
    if (e.target.id !== 'd-pin') return;
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
    const out = $('#d-pin-result');
    const expected = state.orders.get(state.openCode)?.pickupCode;
    if (e.target.value.length < 4) {
      out.textContent = '';
      out.className = 'pin-result';
    } else {
      const ok = e.target.value === expected;
      out.textContent = ok ? '✓ Correct, hand over the order' : '✗ Wrong code, do not hand over';
      out.className = `pin-result ${ok ? 'good' : 'bad'}`;
    }
  });
  dlg.addEventListener('close', () => {
    state.openCode = null;
    state.pulseCall = false;
    renderOrders();
  });

  $('#export-csv').addEventListener('click', exportCsv);
}

function exportCsv() {
  const rows = [['Code', 'Booked', 'Status', 'Name', 'Phone', 'Area', 'Collect', 'Pickup date', 'Items', 'Boxes',
    'Subtotal', 'Bulk discount', 'To pay', 'Note', 'Source']];
  for (const o of filteredOrders()) {
    rows.push([
      o.code, formatDateTime(o.createdAt?.toDate?.()), STATUS[o.status]?.admin ?? o.status, o.customer?.name,
      o.customer?.phone, o.customer?.area, o.fulfilment, o.pickupDate,
      o.items.map((i) => `${i.name}${i.brand ? ` (${i.brand})` : ''} x${i.qty}`).join('; '),
      o.totals?.itemCount, o.totals?.cartTotal, o.totals?.bulkDiscount, o.totals?.netPayable, o.note, o.source,
    ]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `best-fireworks-orders-${istDate(new Date())}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ── Sold out ─────────────────────────────────────────────
function renderProducts() {
  if (!state.catalog) return;
  const out = new Set(state.settings.soldOut ?? []);
  const q = state.productSearch.toLowerCase();
  const { categories, products, sections } = state.catalog;
  let html = '';
  for (const section of sections) {
    for (const cat of categories.filter((c) => c.section === section.id)) {
      const list = products.filter(
        (p) => p.categoryId === cat.id && (!q || `${p.name} ${p.brand ?? ''}`.toLowerCase().includes(q)),
      );
      if (!list.length) continue;
      html += `<div class="p-group"><h3>${escapeHtml(section.id === 'standard' ? section.name : `${cat.name}`)}</h3>
        ${list.map((p) => `<label class="p-row${out.has(p.id) ? ' is-out' : ''}">
            <input type="checkbox" data-id="${p.id}" ${out.has(p.id) ? 'checked' : ''} />
            <span class="p-name">${p.listNo}. ${escapeHtml(p.name)} <small>${escapeHtml(p.brand ?? '')}</small></span>
            <small>${formatRupees(p.finalPrice)}</small>
          </label>`).join('')}</div>`;
    }
  }
  const outCount = out.size;
  $('#product-list').innerHTML =
    (outCount ? `<p class="warn">${outCount} item${outCount > 1 ? 's' : ''} marked sold out.</p>` : '') +
    (html || '<p class="muted">No items match.</p>');
}

function setupProductUi() {
  $('#product-search').addEventListener('input', (e) => {
    state.productSearch = e.target.value.trim();
    renderProducts();
  });
  $('#product-list').addEventListener('change', (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    setDoc(doc(db, 'settings', 'public'), { soldOut: e.target.checked ? arrayUnion(id) : arrayRemove(id) }, { merge: true })
      .then(() => toast(e.target.checked ? 'Marked sold out' : 'Back in stock'))
      .catch((err) => toast(`Could not save: ${err.message}`));
  });
}

// ── Settings ─────────────────────────────────────────────
function fillSettingsForm() {
  const f = $('#settings-form');
  if (f.contains(document.activeElement)) return;
  f.ordersOpen.checked = state.settings.ordersOpen !== false;
  f.notice.value = state.settings.notice ?? '';
}

function setupSettingsUi() {
  $('#settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    setDoc(doc(db, 'settings', 'public'), {
      ordersOpen: f.ordersOpen.checked,
      notice: f.notice.value.trim(),
      updatedAt: serverTimestamp(),
    }, { merge: true })
      .then(() => toast('Settings saved'))
      .catch((err) => toast(`Could not save: ${err.message}`));
  });

  for (const [id, key] of [['opt-sound', 'sound'], ['opt-repeat', 'repeat'], ['opt-wake', 'wake']]) {
    const box = $(`#${id}`);
    box.checked = prefs[key];
    box.addEventListener('change', () => {
      prefs[key] = box.checked;
      savePrefs();
      if (key === 'wake') keepAwake();
    });
  }
  $('#test-alert').addEventListener('click', () => {
    unlockAudio();
    chime(true);
    notify({ title: '🔔 Test alert', body: 'New orders will look like this, with a Call button.', tag: 'test', phone: '9876543210' });
  });
}

// ── Alerts: sound, notifications, push ───────────────────
function unlockAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no audio support */ }
  updateAlertUi();
}

function chime(force = false) {
  if ((!prefs.sound && !force) || !audioCtx || audioCtx.state !== 'running') return;
  const t0 = audioCtx.currentTime;
  [988, 1319, 1568, 1319, 1568, 2093].forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const t = t0 + i * 0.16;
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.6, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.35);
  });
}

// Same shape as the Cloud Function's push, so the service worker shows the same "Call" / "Open" buttons.
function notify({ title, body, tag, phone = '' }) {
  if (!swReg || Notification.permission !== 'granted') return;
  swReg.showNotification(title, {
    body,
    tag,
    renotify: true,
    requireInteraction: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [300, 120, 300, 120, 600],
    actions: phone ? [{ action: 'call', title: '📞 Call customer' }, { action: 'open', title: 'Open order' }] : [],
    data: { link: `/admin?order=${tag}`, phone },
  });
}

const orderNotice = (o) => ({
  title: `🔔 New order ${o.code}`,
  body: `${o.customer?.name} · ${o.customer?.phone} · ${formatRupees(o.totals?.netPayable ?? 0)} · ${o.totals?.itemCount} boxes`,
  tag: o.code,
  phone: o.customer?.phone ?? '',
});

function announce(added) {
  added.forEach((o) => state.fresh.add(o.code));
  renderOrders();
  chime();
  const first = added[0];
  const text = added.length === 1
    ? `🔔 New order ${first.code} · ${first.customer?.name} · ${formatRupees(first.totals?.netPayable ?? 0)}`
    : `🔔 ${added.length} new orders`;
  $('#new-banner-text').textContent = text;
  $('#new-banner').hidden = false;
  const call = $('#new-banner-call');
  call.hidden = added.length !== 1;
  call.href = telLink(`+91${first.customer?.phone}`);
  $('#new-banner-open').onclick = () => {
    $('#new-banner').hidden = true;
    openOrder(first.code);
  };
  // One system notification per order. The Cloud Function's push uses the same tag, so it replaces this one
  // instead of showing twice.
  for (const o of added) notify(orderNotice(o));
}

function updateAlertUi() {
  const soundOn = audioCtx?.state === 'running';
  const notifOn = 'Notification' in window && Notification.permission === 'granted';
  $('#alert-setup').hidden = soundOn && (notifOn || !('Notification' in window));
  const pill = $('#alert-pill');
  pill.textContent = soundOn ? (notifOn ? '🔔 Alerts on' : '🔔 Sound on') : '🔕 Alerts off';
  pill.classList.toggle('on', soundOn);
}

async function registerPush({ ask }) {
  const status = $('#push-status');
  if (!('serviceWorker' in navigator) || !('Notification' in window)) {
    status.textContent = 'This browser cannot show notifications. Keep this page open to hear the sound.';
    return;
  }
  try {
    swReg ??= await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    let perm = Notification.permission;
    if (perm === 'default' && ask) perm = await Notification.requestPermission();
    updateAlertUi();
    if (perm !== 'granted') {
      status.textContent = perm === 'denied'
        ? 'Notifications are blocked for this site. Allow them in the browser’s site settings.'
        : 'Tap “Turn on alerts” to allow notifications.';
      return;
    }
    if (vapidKey.startsWith('YOUR-') || !(await isSupported())) {
      status.textContent = 'Notifications show while this page is open. To get them when it is closed, finish push setup (README step 6).';
      return;
    }
    const token = await getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration: swReg });
    await setDoc(doc(db, 'adminTokens', token), {
      uid: state.user.uid,
      email: state.user.email ?? '',
      device: navigator.userAgent.slice(0, 200),
      updatedAt: serverTimestamp(),
    });
    status.textContent = '✓ Push notifications are on for this device, even when this page is closed.';
  } catch (err) {
    console.error(err);
    status.textContent = `Push setup failed: ${err.message}`;
  }
}

let wakeLock = null;
async function keepAwake() {
  try {
    if (prefs.wake && !document.hidden && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!prefs.wake && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not allowed right now */ }
}

let alertsSetUp = false;
function setupAlerts() {
  updateAlertUi();
  registerPush({ ask: false });
  keepAwake();
  if (alertsSetUp) return;
  alertsSetUp = true;

  $('#enable-alerts').addEventListener('click', () => {
    unlockAudio();
    chime(true);
    registerPush({ ask: true });
  });
  // Browsers only allow sound after a tap, so any tap on the page unlocks it.
  document.addEventListener('pointerdown', unlockAudio, { capture: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) keepAwake();
  });
  // Reminder chime while orders are waiting for confirmation.
  setInterval(() => {
    if (prefs.repeat && [...state.orders.values()].some((o) => o.status === 'new')) chime();
  }, 60_000);
}

// ── Boot ─────────────────────────────────────────────────
document.querySelectorAll('.a-tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.a-tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    for (const id of ['orders', 'products', 'settings']) $(`#tab-${id}`).hidden = id !== tab.dataset.tab;
  }),
);

if (!app) {
  show('setup-view');
} else {
  setupOrderUi();
  setupProductUi();
  setupSettingsUi();
  setupAuth();
}
