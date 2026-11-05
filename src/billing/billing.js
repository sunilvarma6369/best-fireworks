// Counter billing in the admin page / Best FireWorks app.
// Works offline: the price list, photos and recognition data live on the phone (store.js, vision.js).
// Firestore is touched only to upload a finished bill: one write per bill, retried until it gets through.
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { escapeHtml, indexPriceList, waLink } from '../lib/catalog.js';
import { formatPaise, formatRupees, toPaise, toRupees, todayIST } from '../lib/money.js';
import { computeTotals } from '../lib/pricing.js';
import {
  allBills, deviceCode, getItem, loadCatalog, nextBillNo, photoBlobs, putItem, saveBill, saveCatalog, syncPhotos,
} from './store.js';
import { isConfident, loadIndex, loadScanner, matchFrame, SURE_POINTS, syncVectors } from './vision.js';

const $ = (sel) => document.querySelector(sel);
const PAY = { upi: 'UPI', cash: 'Cash', card: 'Card' };
const AUTO_INTERVAL = 700;

const B = {
  ctx: null, // { db, toast, getUser, openExternal }
  catalog: null,
  catalogSavedAt: null,
  photos: new Map(),
  urls: new Map(),
  bills: [],
  active: null,
  view: 'scan',
  q: '',
  cat: 'all',
  opened: false,
  syncing: false,
  scanReady: 0,
  stream: null,
  auto: false,
  autoTimer: null,
  lockId: null,
  lastTop: null,
  lastAdded: null,
  uploading: new Set(),
};

// ── Small helpers ──────────────────────────────────────────
let audio;
function feedback() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 1320;
    g.gain.setValueAtTime(0.25, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.12);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.13);
  } catch { /* no sound */ }
  navigator.vibrate?.(35);
}

const activeBill = () => B.bills.find((b) => b.id === B.active);
const product = (id) => B.catalog?.productsById.get(id);
const thumb = (id) => B.urls.get(id) ?? product(id)?.image ?? null;
const istTime = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const istDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso));

function billTotals(bill) {
  const qty = new Map(Object.entries(bill?.lines ?? {}).map(([id, n]) => [id, Number(n)]));
  return computeTotals(qty, B.catalog?.productsById ?? new Map(), B.catalog?.offer, new Set(), todayIST());
}

// Open bills are saved on every change (a tiny local write), so nothing is lost if the app is closed right after a tap.
let savePending = false;
function saveOpenBills() {
  if (savePending) return;
  savePending = true;
  queueMicrotask(() => {
    savePending = false;
    putItem('kv', 'openBills', { bills: B.bills, active: B.active }).catch(() => {});
  });
}

function newBill() {
  const n = Math.max(0, ...B.bills.map((b) => b.n)) + 1;
  const bill = { id: crypto.randomUUID(), n, lines: {}, createdAt: new Date().toISOString() };
  B.bills.push(bill);
  B.active = bill.id;
  saveOpenBills();
  return bill;
}

// ── Price list, photos and scan data ───────────────────────
function useCatalog(data, savedAt) {
  B.catalog = data.productsById ? data : indexPriceList(data);
  B.catalogSavedAt = savedAt ?? B.catalogSavedAt;
}

async function refreshPhotoUrls() {
  B.photos = await photoBlobs();
  for (const url of B.urls.values()) URL.revokeObjectURL(url);
  B.urls = new Map([...B.photos].map(([id, p]) => [id, URL.createObjectURL(p.blob)]));
}

function syncStatus(text, busy = false) {
  const el = $('#bl-sync');
  el.textContent = text;
  el.classList.toggle('busy', busy);
}

function idleStatus() {
  const when = B.catalogSavedAt ? new Date(B.catalogSavedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : 'never';
  const withPhotos = B.catalog?.products.filter((p) => p.image).length ?? 0;
  syncStatus(`${navigator.onLine ? '✓' : '⚠ Offline ·'} Prices from ${when} · ${B.scanReady}/${withPhotos} scannable`);
}

/** Downloads changed photos and prepares them for scanning. Costs no Firestore reads. */
export async function syncNow() {
  if (B.syncing || !B.catalog) return;
  B.syncing = true;
  try {
    syncStatus('Downloading photos…', true);
    const res = await syncPhotos(B.catalog.products, (d, n) => syncStatus(`Downloading photos ${d}/${n}`, true));
    await refreshPhotoUrls();
    syncStatus('Preparing scan…', true);
    B.scanReady = await syncVectors(B.photos, (d, n) => syncStatus(`Preparing scan ${d}/${n}`, true));
    await loadIndex();
    if (res.failed) B.ctx.toast(`${res.failed} photo${res.failed > 1 ? 's' : ''} could not be downloaded. Try Sync again.`);
  } catch (err) {
    console.error(err);
    B.ctx.toast(`Sync failed: ${err.message}`);
  } finally {
    B.syncing = false;
    idleStatus();
    camHint();
    renderAll();
  }
}

/** Called by the admin page whenever the live price list (Firestore settings) arrives or changes. */
export async function billingCatalogChanged(catalog) {
  const { changed, savedAt } = await saveCatalog(catalog).catch(() => ({ changed: true, savedAt: new Date().toISOString() }));
  useCatalog(catalog, savedAt);
  if (B.opened) {
    renderAll();
    if (changed || B.photos.size !== catalog.products.filter((p) => p.image).length) syncNow();
  }
}

// ── Rendering ──────────────────────────────────────────────
function renderBills() {
  $('#bl-bills').innerHTML = B.bills.map((b) => {
    const t = billTotals(b);
    const on = b.id === B.active;
    return `<button type="button" class="bl-bill${on ? ' on' : ''}" data-bill="${b.id}">
        <strong>Bill ${b.n}</strong><small>${t.itemCount ? `${t.itemCount} · ${formatPaise(t.netPayable)}` : 'empty'}</small>
      </button>`;
  }).join('') + '<button type="button" class="bl-bill bl-new" data-bill="new">＋ New bill</button>';
}

function renderCart() {
  const bill = activeBill();
  const t = billTotals(bill);
  $('#bl-count').textContent = t.itemCount ? `${t.itemCount} box${t.itemCount > 1 ? 'es' : ''}` : '';
  $('#bl-cart').innerHTML = t.lines.length
    ? t.lines.slice().reverse().map(({ product: p, qty, lineTotal }) => `<div class="bl-line${B.lastAdded === p.id ? ' flash' : ''}" data-id="${p.id}">
        ${thumb(p.id) ? `<img src="${escapeHtml(thumb(p.id))}" alt="" />` : '<span class="bl-noimg"></span>'}
        <div class="bl-line-info"><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.brand ?? '')} · ${formatRupees(p.finalPrice)}</small></div>
        <div class="bl-step">
          <button type="button" data-q="-1" aria-label="One less">−</button>
          <input type="number" inputmode="numeric" min="0" value="${qty}" data-q="set" aria-label="Quantity" />
          <button type="button" data-q="1" aria-label="One more">+</button>
        </div>
        <strong class="bl-line-total">${formatPaise(lineTotal)}</strong>
      </div>`).join('')
    : '<p class="muted bl-empty">Scan a box or search to add items.</p>';
  $('#bl-total').textContent = formatPaise(t.netPayable);
  $('#bl-meta').textContent = t.itemCount
    ? `${t.lines.length} item${t.lines.length > 1 ? 's' : ''} · saves ${formatPaise(t.discountTotal + t.bulkDiscount)}`
    : 'No items yet';
  $('#bl-checkout').disabled = !t.itemCount;
}

function renderSearch() {
  if (B.view !== 'search' || !B.catalog) return;
  const cats = B.catalog.categories;
  $('#bl-cats').innerHTML = [{ id: 'all', name: 'All' }, ...cats]
    .map((c) => `<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${B.cat === c.id}">${escapeHtml(c.name)}</button>`).join('');
  const tokens = B.q.toLowerCase().split(/\s+/).filter(Boolean);
  const lines = activeBill()?.lines ?? {};
  const list = B.catalog.products.filter((p) => (B.cat === 'all' || p.categoryId === B.cat)
    && tokens.every((t) => `${p.name} ${p.brand ?? ''} ${p.listNo} ${p.category}`.toLowerCase().includes(t)));
  $('#bl-grid').innerHTML = list.slice(0, 200).map((p) => `<button type="button" class="bl-item" data-add="${p.id}">
      ${thumb(p.id) ? `<img src="${escapeHtml(thumb(p.id))}" alt="" loading="lazy" />` : '<span class="bl-noimg"></span>'}
      <span class="bl-item-info"><strong>${escapeHtml(p.name)}</strong><small>#${p.listNo} · ${escapeHtml(p.brand ?? '')}</small></span>
      <span class="bl-item-price">${formatRupees(p.finalPrice)}${lines[p.id] ? `<em>×${lines[p.id]}</em>` : ''}</span>
    </button>`).join('') || '<p class="muted bl-empty">No items match.</p>';
}

function renderMatches(matches, note = '') {
  const el = $('#bl-matches');
  if (!matches.length) {
    el.innerHTML = note ? `<p class="muted">${escapeHtml(note)}</p>` : '';
    return;
  }
  el.innerHTML = (note ? `<p class="bl-note">${escapeHtml(note)}</p>` : '<p class="muted bl-pick">Tap the right item:</p>')
    + matches.map((m) => {
      const p = product(m.id);
      if (!p) return '';
      return `<button type="button" class="bl-match" data-add="${p.id}">
          ${thumb(p.id) ? `<img src="${escapeHtml(thumb(p.id))}" alt="" />` : ''}
          <span><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.brand ?? '')} · ${formatRupees(p.finalPrice)}</small></span>
          <em>${m.score >= SURE_POINTS ? 'strong' : m.score > 0 ? 'possible' : 'by colour'}</em>
        </button>`;
    }).join('');
}

function renderAll() {
  if (!B.opened) return;
  renderBills();
  renderCart();
  renderSearch();
  document.querySelectorAll('[data-bl-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.blView === B.view)));
  $('#bl-scan').hidden = B.view !== 'scan';
  $('#bl-search').hidden = B.view !== 'search';
}

// ── Cart actions ───────────────────────────────────────────
function addItem(id, n = 1, { quiet = false } = {}) {
  const p = product(id);
  if (!p) return;
  const bill = activeBill() ?? newBill();
  bill.lines[id] = (bill.lines[id] ?? 0) + n;
  if (bill.lines[id] <= 0) delete bill.lines[id];
  B.lastAdded = id;
  saveOpenBills();
  renderBills();
  renderCart();
  renderSearch();
  if (!quiet) {
    feedback();
    showUndo(p);
  }
}

let undoTimer;
function showUndo(p) {
  const el = $('#bl-added');
  const host = B.view === 'scan' ? $('.bl-camera') : $('#tab-billing');
  if (el.parentElement !== host) host.appendChild(el);
  el.innerHTML = `<span>✓ Added <strong>${escapeHtml(p.name)}</strong></span><button type="button" data-undo="${p.id}">Undo</button>`;
  el.hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

function setQty(id, qty) {
  const bill = activeBill();
  if (!bill) return;
  const n = Math.max(0, Math.floor(Number(qty) || 0));
  if (n) bill.lines[id] = n;
  else delete bill.lines[id];
  saveOpenBills();
  renderBills();
  renderCart();
}

// ── Camera scanning ────────────────────────────────────────
const NO_PHOTOS = 'No item photos are ready for scanning yet. Add photos in Items & prices, then tap Sync.';
/** Hint over the live camera: empty once photos are ready to scan. */
function camHint() {
  if (B.stream) $('#bl-cam-msg').textContent = B.scanReady ? '' : NO_PHOTOS;
}

async function startCamera() {
  if (B.stream || B.view !== 'scan' || !B.opened || document.hidden) return;
  const msg = $('#bl-cam-msg');
  if (!navigator.mediaDevices?.getUserMedia) {
    msg.textContent = 'This device has no camera access. Use Search.';
    return;
  }
  try {
    msg.textContent = 'Starting camera…';
    B.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const v = $('#bl-video');
    v.srcObject = B.stream;
    await v.play();
    camHint();
    if (B.auto) startAuto();
  } catch (err) {
    B.stream = null;
    msg.textContent = err?.name === 'NotAllowedError'
      ? 'Camera permission is off. Allow it in Android Settings → Apps → Best FireWorks → Permissions.'
      : `Camera could not start: ${err.message}`;
  }
}

function stopCamera() {
  stopAuto();
  B.stream?.getTracks().forEach((t) => t.stop());
  B.stream = null;
  const v = $('#bl-video');
  if (v) v.srcObject = null;
}

async function scanOnce({ auto = false } = {}) {
  if (!B.stream) return startCamera();
  if (!B.scanReady) return renderMatches([], 'No item photos are ready for scanning yet.');
  const shutter = $('#bl-shutter');
  if (!auto) shutter.disabled = true;
  try {
    const matches = await matchFrame($('#bl-video'), 4);
    if (auto) {
      const top = matches[0];
      if (!top || top.score < 6) B.lockId = null; // camera moved away: the same item may be added again
      if (isConfident(matches) && top.id === B.lastTop && top.id !== B.lockId) {
        B.lockId = top.id;
        addItem(top.id);
        renderMatches(matches.slice(0, 3), `Added ${product(top.id)?.name}. Show the next box.`);
      } else {
        renderMatches(matches.slice(0, 3), isConfident(matches) ? 'Hold steady…' : 'Looking…');
      }
      B.lastTop = top?.id ?? null;
    } else if (isConfident(matches)) {
      addItem(matches[0].id);
      renderMatches(matches.slice(1, 3), `Added ${product(matches[0].id)?.name}. Wrong item? Tap Undo or pick below.`);
    } else {
      renderMatches(matches, matches.length ? '' : 'Nothing recognised. Try again closer, or use Search.');
    }
  } catch (err) {
    console.error(err);
    renderMatches([], `Scanner error: ${err.message}`);
  } finally {
    shutter.disabled = false;
  }
}

function startAuto() {
  stopAuto();
  if (!B.auto || !B.stream) return;
  const tick = async () => {
    if (!B.auto || !B.stream) return;
    await scanOnce({ auto: true });
    B.autoTimer = setTimeout(tick, AUTO_INTERVAL);
  };
  B.autoTimer = setTimeout(tick, 300);
}

function stopAuto() {
  clearTimeout(B.autoTimer);
  B.autoTimer = null;
}

// ── Checkout ───────────────────────────────────────────────
let lastPayment = 'cash';

function checkoutHtml(t) {
  return `<div class="d-head"><h2>Checkout · Bill ${activeBill().n}</h2>
      <button class="close" type="button" data-act="close" aria-label="Close">✕</button></div>
    <form class="d-body a-form" id="bl-pay-form" novalidate>
      <div class="bl-sum">
        <div><span>${plural(t.itemCount, 'box')} · ${plural(t.lines.length, 'item')}</span><span></span></div>
        <div><span>Amount</span><span>${formatPaise(t.amountTotal)}</span></div>
        <div class="save"><span>Discount</span><span>−${formatPaise(t.discountTotal)}</span></div>
        ${t.bulkDiscount ? `<div class="save"><span>Bulk offer</span><span>−${formatPaise(t.bulkDiscount)}</span></div>` : ''}
        <div class="net"><span>Bill total</span><span>${formatPaise(t.netPayable)}</span></div>
      </div>
      <label>Amount collected ₹
        <input name="paid" type="number" inputmode="decimal" step="0.01" min="0" value="${toRupees(t.netPayable)}" required />
      </label>
      <div class="quick-off">
        <button type="button" class="btn btn-sm btn-soft" data-paid="exact">Exact</button>
        <button type="button" class="btn btn-sm btn-soft" data-paid="r10">Round ↓ 10</button>
        <button type="button" class="btn btn-sm btn-soft" data-paid="r50">Round ↓ 50</button>
        <button type="button" class="btn btn-sm btn-soft" data-paid="p5">−5%</button>
        <button type="button" class="btn btn-sm btn-soft" data-paid="p10">−10%</button>
      </div>
      <p class="bl-adjust" id="bl-adjust"></p>
      <fieldset class="bl-pay">
        <legend>Paid by</legend>
        ${Object.entries(PAY).map(([k, v]) => `<label><input type="radio" name="payment" value="${k}" ${k === lastPayment ? 'checked' : ''} /> ${v}</label>`).join('')}
      </fieldset>
      <div class="two-col">
        <label>Customer name <small>(optional)</small><input name="name" maxlength="60" autocomplete="off" /></label>
        <label>Mobile <small>(for WhatsApp)</small><input name="phone" inputmode="numeric" maxlength="10" autocomplete="off" /></label>
      </div>
      <label class="switch"><input type="checkbox" name="wa" checked /> Send the bill on WhatsApp after saving</label>
      <p class="a-error" id="bl-pay-error" hidden></p>
      <button class="btn btn-primary btn-block bl-save" type="submit">Save bill</button>
    </form>`;
}

function updateAdjust(t) {
  const f = $('#bl-pay-form');
  const paid = toPaise(f.paid.value || 0);
  const adj = paid - t.netPayable;
  $('#bl-adjust').textContent = adj === 0 ? 'No adjustment.' : `Adjustment: ${adj < 0 ? '−' : '+'}${formatPaise(Math.abs(adj))}`;
  $('#bl-adjust').className = `bl-adjust${adj < 0 ? ' minus' : adj > 0 ? ' plus' : ''}`;
  f.querySelector('.bl-save').textContent = `Save bill · ${formatPaise(paid)}`;
}

function openCheckout() {
  const bill = activeBill();
  const t = billTotals(bill);
  if (!t.itemCount) return;
  stopAuto();
  const dlg = $('#bl-checkout-dialog');
  dlg.innerHTML = checkoutHtml(t);
  dlg.showModal();
  const f = $('#bl-pay-form');
  updateAdjust(t);
  f.addEventListener('input', (e) => {
    if (e.target.name === 'phone') e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10);
    updateAdjust(t);
  });
  f.addEventListener('click', (e) => {
    const b = e.target.closest('[data-paid]');
    if (!b) return;
    const net = t.netPayable;
    const v = {
      exact: net,
      r10: Math.floor(net / 1000) * 1000,
      r50: Math.floor(net / 5000) * 5000,
      p5: Math.round((net * 0.95) / 100) * 100,
      p10: Math.round((net * 0.9) / 100) * 100,
    }[b.dataset.paid];
    f.paid.value = toRupees(v);
    updateAdjust(t);
  });
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    saveCurrentBill(t, f);
  });
}

function billMessage(bill) {
  const t = bill.totals;
  const lines = bill.items.map((it, i) => `${i + 1}. ${it.name}${it.brand ? ` (${it.brand})` : ''} × ${it.qty} = ${formatRupees(it.lineTotal)}`);
  const when = new Date(bill.billedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  return [
    '*Best FireWorks* 🎆',
    `Bill ${bill.billNo} · ${when}`,
    bill.customer.name ? `Customer: ${bill.customer.name}` : null,
    '',
    ...lines,
    '',
    `Items: ${plural(t.itemCount, 'box')}`,
    `Amount: ${formatRupees(t.amountTotal)}`,
    `Discount: −${formatRupees(t.discountTotal)}`,
    t.bulkDiscount ? `Bulk offer: −${formatRupees(t.bulkDiscount)}` : null,
    `Bill total: ${formatRupees(t.netPayable)}`,
    t.adjustment ? `Adjusted: ${t.adjustment < 0 ? '−' : '+'}${formatRupees(Math.abs(t.adjustment))}` : null,
    `*Total paid: ${formatRupees(t.paid)}* (${PAY[bill.payment]})`,
    `You saved ${formatRupees(t.amountTotal - t.paid > 0 ? t.amountTotal - t.paid : 0)} today!`,
    '',
    'Thank you for shopping with Best FireWorks! Wishing you and your family a very Happy Diwali 🪔✨',
  ].filter((l) => l !== null).join('\n');
}

const whatsappUrl = (bill) => {
  const text = billMessage(bill);
  const phone = bill.customer.phone;
  return phone ? waLink(`+91${phone}`, text) : `https://wa.me/?text=${encodeURIComponent(text)}`;
};

async function saveCurrentBill(t, f) {
  const err = $('#bl-pay-error');
  err.hidden = true;
  const paid = toPaise(f.paid.value || 0);
  const phone = f.phone.value.trim();
  if (!(paid > 0)) {
    err.textContent = 'Enter the amount collected.';
    err.hidden = false;
    return f.paid.focus();
  }
  if (phone && !/^[6-9]\d{9}$/.test(phone)) {
    err.textContent = 'Enter a valid 10-digit mobile number, or leave it empty.';
    err.hidden = false;
    return f.phone.focus();
  }
  if (paid < t.netPayable * 0.8 && !confirm(`Collected amount is ${formatPaise(t.netPayable - paid)} less than the bill. Save anyway?`)) return;

  const btn = f.querySelector('.bl-save');
  btn.disabled = true;
  const payment = f.payment.value || 'cash';
  lastPayment = payment;
  const user = B.ctx.getUser();
  const bill = {
    billNo: await nextBillNo(),
    billedAt: new Date().toISOString(),
    device: await deviceCode(),
    cashier: user?.email ?? '',
    customer: { name: f.name.value.trim().slice(0, 60), phone },
    payment,
    items: t.lines.map(({ product: p, qty, lineTotal }) => ({
      id: p.id, listNo: p.listNo, name: p.name, brand: p.brand ?? '', qty,
      amount: p.amount, finalPrice: p.finalPrice, lineTotal: toRupees(lineTotal),
    })),
    totals: {
      itemCount: t.itemCount,
      amountTotal: toRupees(t.amountTotal),
      discountTotal: toRupees(t.discountTotal),
      cartTotal: toRupees(t.cartTotal),
      bulkDiscount: toRupees(t.bulkDiscount),
      netPayable: toRupees(t.netPayable),
      adjustment: toRupees(paid - t.netPayable),
      paid: toRupees(paid),
    },
    synced: false,
  };
  try {
    await saveBill(bill); // safe on the phone first, even with no internet
  } catch (e) {
    btn.disabled = false;
    err.textContent = `Could not save the bill: ${e.message}`;
    err.hidden = false;
    return;
  }
  // Close this bill and move to the next open one (or a fresh one)
  B.bills = B.bills.filter((b) => b.id !== B.active);
  B.active = B.bills[0]?.id ?? newBill().id;
  saveOpenBills();
  $('#bl-checkout-dialog').close();
  renderAll();
  upload(bill);
  if (f.wa.checked) B.ctx.openExternal(whatsappUrl(bill));
  showDone(bill);
  if (B.auto) startAuto();
}

function showDone(bill) {
  const dlg = $('#bl-done-dialog');
  dlg.innerHTML = `<div class="d-head"><h2>Bill saved ✓</h2><button class="close" type="button" data-act="close" aria-label="Close">✕</button></div>
    <div class="d-body">
      <div class="bl-done">
        <small>Bill ${escapeHtml(bill.billNo)}</small>
        <strong>${formatRupees(bill.totals.paid)}</strong>
        <span>${PAY[bill.payment]} · ${plural(bill.totals.itemCount, 'box')}${bill.totals.adjustment ? ` · adjusted ${bill.totals.adjustment < 0 ? '−' : '+'}${formatRupees(Math.abs(bill.totals.adjustment))}` : ''}</span>
      </div>
      <p class="muted" id="bl-done-sync">${bill.synced ? 'Uploaded.' : 'Saved on this phone. Uploads automatically when online.'}</p>
      <div class="d-row-btns">
        <a class="btn btn-wa" href="${whatsappUrl(bill)}" target="_blank" rel="noopener">💬 Send on WhatsApp</a>
        <button type="button" class="btn btn-primary" data-act="close">Next bill</button>
      </div>
    </div>`;
  dlg.showModal();
}

// ── Upload (one Firestore write per bill) ──────────────────
function upload(bill) {
  if (B.uploading.has(bill.billNo)) return;
  B.uploading.add(bill.billNo);
  const { synced, ...data } = bill;
  void synced;
  // If offline, Firestore keeps this write and sends it when the internet is back (while the app stays open).
  setDoc(doc(B.ctx.db, 'sales', bill.billNo), { ...data, source: 'counter', createdAt: serverTimestamp() })
    .then(async () => {
      bill.synced = true;
      await saveBill(bill);
      const note = $('#bl-done-sync');
      if (note && $('#bl-done-dialog').open) note.textContent = 'Uploaded.';
      if ($('#bl-today-dialog').open) renderToday();
    })
    .catch((e) => console.warn('Bill upload failed, will retry', bill.billNo, e))
    .finally(() => B.uploading.delete(bill.billNo));
}

/** Uploads bills saved while offline (or before the app was closed). */
export async function flushPending() {
  const pending = (await allBills()).filter((b) => !b.synced);
  pending.forEach(upload);
  return pending.length;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : word === 'box' ? 'es' : 's'}`;

// ── Today's bills ──────────────────────────────────────────
async function renderToday() {
  const today = todayIST();
  const bills = (await allBills()).filter((b) => istDay(b.billedAt) === today).sort((a, b) => b.billedAt.localeCompare(a.billedAt));
  const sum = (list) => list.reduce((s, b) => s + toPaise(b.totals.paid), 0);
  const byMode = Object.keys(PAY).map((k) => [k, bills.filter((b) => b.payment === k)]);
  const pending = bills.filter((b) => !b.synced).length;
  $('#bl-today-dialog').innerHTML = `<div class="d-head"><h2>Today's bills</h2><button class="close" type="button" data-act="close" aria-label="Close">✕</button></div>
    <div class="d-body">
      <div class="kpis">
        <div class="kpi"><small>Collected</small><strong>${formatPaise(sum(bills))}</strong><span>${plural(bills.length, 'bill')} on this phone</span></div>
        ${byMode.map(([k, list]) => `<div class="kpi"><small>${PAY[k]}</small><strong>${formatPaise(sum(list))}</strong><span>${plural(list.length, 'bill')}</span></div>`).join('')}
      </div>
      <p class="${pending ? 'hint' : 'ok'}">${pending ? `${pending} bill${pending > 1 ? 's' : ''} waiting to upload (they upload by themselves when online).` : '✓ All bills uploaded.'}</p>
      <div class="bl-history">${bills.map((b) => `<div class="bl-hrow">
          <div><strong>${escapeHtml(b.billNo)}</strong><small>${istTime(b.billedAt)} · ${plural(b.totals.itemCount, 'box')} · ${PAY[b.payment]}${b.customer.name ? ` · ${escapeHtml(b.customer.name)}` : ''}</small></div>
          <div class="bl-hright"><strong>${formatRupees(b.totals.paid)}</strong><small>${b.synced ? '✓ uploaded' : '⏳ on phone'}</small></div>
          <a class="btn btn-sm btn-soft" href="${whatsappUrl(b)}" target="_blank" rel="noopener" aria-label="Send on WhatsApp">💬</a>
        </div>`).join('') || '<p class="muted">No bills yet today.</p>'}</div>
    </div>`;
}

// ── Setup ──────────────────────────────────────────────────
export async function openBilling() {
  if (!B.opened) {
    B.opened = true;
    if (!B.catalog) {
      const cached = await loadCatalog().catch(() => null);
      if (cached) useCatalog(cached.data, cached.savedAt);
    }
    await refreshPhotoUrls().catch(() => {});
    B.scanReady = await loadIndex().catch(() => 0);
    camHint();
    if (!B.bills.length) newBill();
    idleStatus();
    renderAll();
    flushPending().catch(() => {});
    if (B.catalog && B.photos.size !== B.catalog.products.filter((p) => p.image).length) syncNow();
    loadScanner().catch(() => {}); // warm up the scanner in the background
  }
  renderAll();
  startCamera();
}

export function closeBilling() {
  stopCamera();
}

export async function setupBilling(ctx) {
  B.ctx = ctx;
  const open = await getItem('kv', 'openBills').catch(() => null);
  if (open?.bills?.length) {
    B.bills = open.bills;
    B.active = open.bills.some((b) => b.id === open.active) ? open.active : open.bills[0].id;
  }
  B.auto = localStorage.getItem('bfw.billing.auto') === '1';
  $('#bl-auto').checked = B.auto;

  const panel = $('#tab-billing');
  panel.addEventListener('click', (e) => {
    const t = e.target;
    const billBtn = t.closest('[data-bill]');
    if (billBtn) {
      if (billBtn.dataset.bill === 'new') newBill();
      else if (billBtn.dataset.bill === B.active && !Object.keys(activeBill().lines).length && B.bills.length > 1) {
        B.bills = B.bills.filter((b) => b.id !== B.active); // tapping an empty selected bill closes it
        B.active = B.bills[0].id;
        saveOpenBills();
      } else B.active = billBtn.dataset.bill;
      saveOpenBills();
      renderAll();
      return;
    }
    const view = t.closest('[data-bl-view]');
    if (view) {
      B.view = view.dataset.blView;
      renderAll();
      if (B.view === 'scan') startCamera();
      else stopCamera();
      if (B.view === 'search') setTimeout(() => $('#bl-q').focus(), 50);
      return;
    }
    const add = t.closest('[data-add]');
    if (add) return addItem(add.dataset.add);
    const cat = t.closest('[data-cat]');
    if (cat && t.closest('#bl-cats')) {
      B.cat = cat.dataset.cat;
      return renderSearch();
    }
    const q = t.closest('[data-q]');
    if (q && q.tagName === 'BUTTON') {
      const id = q.closest('[data-id]').dataset.id;
      return setQty(id, (activeBill().lines[id] ?? 0) + Number(q.dataset.q));
    }
    const undo = t.closest('[data-undo]');
    if (undo) {
      addItem(undo.dataset.undo, -1, { quiet: true });
      $('#bl-added').hidden = true;
      return;
    }
    if (t.closest('#bl-shutter')) return scanOnce();
    if (t.closest('#bl-checkout')) return openCheckout();
    if (t.closest('#bl-sync')) return syncNow();
    if (t.closest('#bl-today-btn')) {
      renderToday().then(() => $('#bl-today-dialog').showModal());
      return;
    }
    if (t.closest('#bl-clear') && activeBill() && confirm('Remove all items from this bill?')) {
      activeBill().lines = {};
      saveOpenBills();
      renderAll();
    }
  });
  panel.addEventListener('change', (e) => {
    if (e.target.dataset.q === 'set') setQty(e.target.closest('[data-id]').dataset.id, e.target.value);
    if (e.target.id === 'bl-auto') {
      B.auto = e.target.checked;
      localStorage.setItem('bfw.billing.auto', B.auto ? '1' : '0');
      B.lockId = null;
      if (B.auto) startAuto();
      else stopAuto();
    }
  });
  $('#bl-q').addEventListener('input', (e) => {
    B.q = e.target.value.trim();
    renderSearch();
  });
  for (const id of ['#bl-checkout-dialog', '#bl-done-dialog', '#bl-today-dialog']) {
    const dlg = $(id);
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-act="close"]')) dlg.close();
    });
    dlg.addEventListener('close', () => { if (B.auto && B.stream) startAuto(); });
  }
  document.addEventListener('visibilitychange', () => {
    if (!B.opened || $('#tab-billing').hidden) return;
    if (document.hidden) stopCamera();
    else startCamera();
  });
  window.addEventListener('online', () => { flushPending().catch(() => {}); if (B.opened) idleStatus(); });
  window.addEventListener('offline', () => { if (B.opened) idleStatus(); });
}
