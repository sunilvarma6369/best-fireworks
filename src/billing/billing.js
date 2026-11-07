// Counter billing in the admin page / Best FireWorks app.
// Works offline: the price list, photos and recognition data live on the phone (store.js, vision.js).
// Firestore is touched only to upload a finished bill: one write per bill, retried until it gets through.
//
// Screen: open bills (chips) · Scan | Search | Bill views · a fixed bar with the total and Checkout.
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { escapeHtml, indexPriceList, waLink } from '../lib/catalog.js';
import { formatPaise, formatRupees, toPaise, toRupees, todayIST } from '../lib/money.js';
import { computeTotals } from '../lib/pricing.js';
import { nameForPhone, reloadLocal } from './ledger.js';
import {
  allBills, deviceCode, getItem, loadCatalog, nextBillNo, photoBlobs, putItem, saveBill, saveCatalog, syncPhotos,
} from './store.js';
import { isConfident, loadIndex, loadScanner, matchFrame, SURE_POINTS, syncVectors } from './vision.js';

const $ = (sel) => document.querySelector(sel);
const PAY = { upi: 'UPI', cash: 'Cash', card: 'Card' };
const VIEWS = ['scan', 'search', 'bill'];
const AUTO_INTERVAL = 700;
const SAME_SCAN_MS = 2000; // the same box seen again this soon is the same box, not a second one
const TAP_GUARD_MS = 450; // taps on a suggestion list that just appeared are ignored (a finger already on the screen)
const RECENT_OTHER_KEY = 'bfw.billing.otherRecent';

const B = {
  ctx: null, // { db, toast, getStaff, openExternal, openBills }
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
  scanning: false,
  lastScanAdd: { id: null, at: 0 },
  matchesAt: 0,
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

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : word === 'box' ? 'es' : 's'}`;
const activeBill = () => B.bills.find((b) => b.id === B.active);
const istDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso));

// "Other" items: not in the price list, typed in at the counter (name + price). They live on the open bill
// (bill.custom) and go into the saved bill with custom: true, so admins can add them to the price list later.
const isOtherId = (id) => id.startsWith('x-');
const otherProduct = (id, c) => ({
  id, custom: true, listNo: '', name: c.name, brand: '', amount: c.price, finalPrice: c.price,
  bulkOfferEligible: false, categoryId: 'custom', category: 'Other items',
});
const product = (id, bill = activeBill()) => B.catalog?.productsById.get(id)
  ?? (bill?.custom?.[id] ? otherProduct(id, bill.custom[id]) : undefined);
const thumb = (id) => B.urls.get(id) ?? product(id)?.image ?? null;
const thumbHtml = (id) => (thumb(id) ? `<img src="${escapeHtml(thumb(id))}" alt="" loading="lazy" />`
  : `<span class="bl-noimg">${isOtherId(id) ? '✍' : ''}</span>`);

function productsFor(bill) {
  const base = B.catalog?.productsById ?? new Map();
  const custom = Object.entries(bill?.custom ?? {});
  if (!custom.length) return base;
  const all = new Map(base);
  for (const [id, c] of custom) all.set(id, otherProduct(id, c));
  return all;
}

function billTotals(bill) {
  const qty = new Map(Object.entries(bill?.lines ?? {}).map(([id, n]) => [id, Number(n)]));
  return computeTotals(qty, productsFor(bill), B.catalog?.offer, new Set(), todayIST());
}

// ── Search: forgiving matching ─────────────────────────────
// "sky shot", "skyshot", "SKY-SHOT" and "shot sky" all find "Sky Shot 30"; an item number finds that item first;
// one wrong letter in a longer word still matches when nothing else does.
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
const searchIndex = new WeakMap();
function haystack(p) {
  let h = searchIndex.get(p);
  if (!h) {
    const text = norm(`${p.name} ${p.brand ?? ''} ${p.category ?? ''}`);
    h = { name: norm(p.name), text, compact: text.replace(/ /g, ''), words: text.split(' '), no: String(p.listNo ?? '') };
    searchIndex.set(p, h);
  }
  return h;
}
function oneEditAway(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
/** Matching products, best first. `fuzzy` is true when only close spellings were found. */
function searchProducts(products, q) {
  const query = norm(q);
  if (!query) return { list: products, fuzzy: false };
  const tokens = query.split(' ');
  const compactQ = query.replace(/ /g, '');
  const score = (p) => {
    const h = haystack(p);
    let s = 0;
    if (/^\d+$/.test(compactQ) && h.no === compactQ) s += 1000;
    else if (/^\d+$/.test(compactQ) && h.no.startsWith(compactQ)) s += 300;
    const textHit = tokens.every((t) => h.text.includes(t) || h.compact.includes(t)) || h.compact.includes(compactQ);
    if (!textHit && s === 0) return 0;
    if (textHit) {
      s += 100;
      if (h.name.startsWith(query)) s += 60;
      else if (h.words.some((w) => w.startsWith(tokens[0]))) s += 30;
    }
    return s;
  };
  let ranked = products.map((p, i) => ({ p, i, s: score(p) })).filter((x) => x.s > 0);
  let fuzzy = false;
  if (!ranked.length) {
    // Nothing found: allow one wrong, missing or extra letter in each word of 4+ letters.
    const ok = (p) => tokens.every((t) => {
      const h = haystack(p);
      if (h.text.includes(t)) return true;
      return t.length >= 4 && h.words.some((w) => oneEditAway(t, w) || (w.length > t.length && oneEditAway(t, w.slice(0, t.length))));
    });
    ranked = products.map((p, i) => ({ p, i, s: 1 })).filter((x) => ok(x.p));
    fuzzy = ranked.length > 0;
  }
  ranked.sort((a, b) => b.s - a.s || a.i - b.i);
  return { list: ranked.map((x) => x.p), fuzzy };
}

/** Bill lines, the most recently added first. */
function recentLines(bill, t = billTotals(bill)) {
  const touched = bill?.touched ?? {};
  return t.lines.map((l, i) => ({ l, i })).sort((a, b) => (touched[b.l.product.id] ?? b.i) - (touched[a.l.product.id] ?? a.i)).map((x) => x.l);
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
  const bill = { id: crypto.randomUUID(), n, lines: {}, touched: {}, createdAt: new Date().toISOString() };
  B.bills.push(bill);
  B.active = bill.id;
  saveOpenBills();
  return bill;
}

function dropBill(id) {
  B.bills = B.bills.filter((b) => b.id !== id);
  if (!B.bills.length) newBill();
  if (!B.bills.some((b) => b.id === B.active)) B.active = B.bills[B.bills.length - 1].id;
  saveOpenBills();
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
  syncStatus(`${navigator.onLine ? '✓' : '⚠ Offline ·'} Prices ${when} · ${B.scanReady}/${withPhotos} scannable`);
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
    return `<button type="button" class="bl-bill${on ? ' on' : ''}" data-bill="${b.id}" aria-pressed="${on}">
        <strong>Bill ${b.n}</strong><small>${t.itemCount ? `${t.itemCount} · ${formatPaise(t.netPayable)}` : 'empty'}</small>
      </button>`;
  }).join('') + '<button type="button" class="bl-bill bl-new" data-bill="new" aria-label="Start another bill">＋ New</button>';
}

const stepperHtml = (qty) => `<div class="bl-step">
    <button type="button" data-q="-1" aria-label="One less">−</button>
    <input type="number" inputmode="numeric" min="0" value="${qty}" data-q="set" aria-label="Quantity" />
    <button type="button" data-q="1" aria-label="One more">+</button>
  </div>`;

function lineHtml({ product: p, qty, lineTotal }) {
  return `<div class="bl-line${B.lastAdded === p.id ? ' flash' : ''}" data-id="${p.id}">
      ${thumbHtml(p.id)}
      <div class="bl-line-info"><strong>${escapeHtml(p.name)}</strong><small>${p.custom ? '<span class="bl-other-tag">Other item</span>' : escapeHtml(p.brand ?? '')} · ${formatRupees(p.finalPrice)}</small></div>
      ${stepperHtml(qty)}
      <strong class="bl-line-total">${formatPaise(lineTotal)}</strong>
    </div>`;
}

/** Bottom bar and the Bill tab's count: always visible, whatever the view. */
function renderBar(t) {
  $('#bl-total').textContent = formatPaise(t.netPayable);
  $('#bl-meta').textContent = t.itemCount
    ? `${plural(t.lines.length, 'item')} · saves ${formatPaise(t.discountTotal + t.bulkDiscount)} · view bill`
    : 'No items yet';
  $('#bl-checkout').disabled = !t.itemCount;
  const badge = $('#bl-seg-count');
  badge.textContent = t.itemCount;
  badge.hidden = !t.itemCount;
}

function renderBillView(bill, t) {
  $('#bl-bill-title').textContent = `Bill ${bill?.n ?? ''}`;
  $('#bl-count').textContent = t.itemCount ? `${plural(t.itemCount, 'box')} · ${plural(t.lines.length, 'item')}` : '';
  $('#bl-cart').innerHTML = t.lines.length
    ? recentLines(bill, t).map(lineHtml).join('')
    : `<div class="bl-empty-bill"><p class="muted">This bill is empty.</p>
        <div class="d-row-btns"><button type="button" class="btn btn-soft" data-bl-view="scan">📷 Scan a box</button>
        <button type="button" class="btn btn-soft" data-bl-view="search">🔍 Search items</button>
        <button type="button" class="btn btn-soft" data-other="">✍ Other item</button></div></div>`;
  $('#bl-sum-mini').innerHTML = t.itemCount ? `<div class="bl-sum">
      <div><span>Amount</span><span>${formatPaise(t.amountTotal)}</span></div>
      <div class="save"><span>Discount</span><span>−${formatPaise(t.discountTotal)}</span></div>
      ${t.bulkDiscount ? `<div class="save"><span>Bulk offer</span><span>−${formatPaise(t.bulkDiscount)}</span></div>` : ''}
      <div class="net"><span>Bill total</span><span>${formatPaise(t.netPayable)}</span></div>
    </div>` : '';
  $('#bl-drop').hidden = B.bills.length < 2 && !t.itemCount;
}

function renderRecent(bill, t) {
  const recent = recentLines(bill, t).slice(0, 3);
  $('#bl-recent').innerHTML = recent.length
    ? `<div class="bl-recent-head"><h3>Last added</h3>
        <button type="button" class="link" data-bl-view="bill">Whole bill · ${plural(t.lines.length, 'item')} →</button></div>
      ${recent.map(lineHtml).join('')}`
    : '';
}

function renderSearch() {
  if (B.view !== 'search' || !B.catalog) return;
  const cats = B.catalog.categories;
  $('#bl-cats').innerHTML = [{ id: 'all', name: 'All' }, ...cats]
    .map((c) => `<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${B.cat === c.id}">${escapeHtml(c.name)}</button>`).join('');
  const lines = activeBill()?.lines ?? {};
  const inCat = B.catalog.products.filter((p) => B.cat === 'all' || p.categoryId === B.cat);
  const { list, fuzzy } = searchProducts(inCat, B.q);
  const otherBtn = `<button type="button" class="bl-other-add" data-other="${escapeHtml(B.q)}">
      <span class="bl-noimg">✍</span>
      <span><strong>${B.q ? `Add “${escapeHtml(B.q)}” as an other item` : 'Item not in the list?'}</strong>
        <small>Type its name and price. Quick, and admins can add it to the price list later.</small></span>
      <span class="bl-plus" aria-hidden="true">＋</span>
    </button>`;
  $('#bl-grid').innerHTML = (fuzzy ? `<p class="bl-fuzzy">No exact match for “${escapeHtml(B.q)}”. Close spellings:</p>` : '')
    + list.slice(0, 200).map((p) => {
    const qty = lines[p.id] ?? 0;
    return `<div class="bl-item${qty ? ' in-bill' : ''}" data-id="${p.id}" data-add="${p.id}" role="button" tabindex="0" aria-label="Add ${escapeHtml(p.name)}">
        ${thumbHtml(p.id)}
        <span class="bl-item-info"><strong>${escapeHtml(p.name)}</strong>
          <small>#${p.listNo} · ${escapeHtml(p.brand ?? '')}</small>
          <b class="bl-price">${formatRupees(p.finalPrice)}${p.amount > p.finalPrice ? ` <s>${formatRupees(p.amount)}</s>` : ''}</b></span>
        ${qty ? stepperHtml(qty) : '<span class="bl-plus" aria-hidden="true">＋</span>'}
      </div>`;
  }).join('')
    // Few or no results for typed text: offer the quick "other item" right there.
    + (B.q && list.length <= 6 ? (list.length ? '' : `<p class="muted bl-empty">No items match “${escapeHtml(B.q)}”.</p>`) + otherBtn : '');
  $('#bl-results-note').textContent = list.length > 200 ? `Showing 200 of ${list.length}. Type more to narrow down.` : '';
}

/**
 * Scan suggestions. Only the small Add / Swap button on each row adds anything (not the whole row), so a thumb
 * resting on the screen does not add items; taps in the first moment after the list appears are ignored.
 * `swapFor` = the item a sure scan just added: the buttons then replace it instead of adding a second item.
 */
function renderMatches(matches, note = '', { swapFor = null, ok = false, other = false } = {}) {
  const el = $('#bl-matches');
  B.matchesAt = Date.now();
  const noteHtml = note ? `<p class="${ok ? 'bl-note' : 'muted'}">${escapeHtml(note)}</p>` : '';
  const otherHtml = other ? '<button type="button" class="btn btn-sm btn-soft bl-other-inline" data-other="">✍ Not found? Add as other item</button>' : '';
  const rows = matches.map((m) => {
    const p = product(m.id);
    if (!p) return '';
    return `<div class="bl-match">
        ${thumb(p.id) ? `<img src="${escapeHtml(thumb(p.id))}" alt="" />` : '<span class="bl-noimg"></span>'}
        <span><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.brand ?? '')} · ${formatRupees(p.finalPrice)} · ${m.score >= SURE_POINTS ? 'strong' : m.score > 0 ? 'possible' : 'by colour'}</small></span>
        ${swapFor
          ? `<button type="button" class="bl-pick-btn" data-swap="${p.id}" data-from="${swapFor}">Swap</button>`
          : `<button type="button" class="bl-pick-btn" data-pick="${p.id}">＋ Add</button>`}
      </div>`;
  }).join('');
  if (!rows) {
    el.innerHTML = noteHtml + otherHtml;
    return;
  }
  el.innerHTML = (noteHtml || '<p class="muted bl-pick">Is it one of these? Tap <strong>＋ Add</strong> on the right one:</p>') + rows + otherHtml;
}

const tooSoon = () => Date.now() - B.matchesAt < TAP_GUARD_MS;

function renderAll() {
  if (!B.opened) return;
  const bill = activeBill();
  const t = billTotals(bill);
  renderBills();
  renderBar(t);
  document.querySelectorAll('.bl-seg [data-bl-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.blView === B.view)));
  $('#bl-scan').hidden = B.view !== 'scan';
  $('#bl-search').hidden = B.view !== 'search';
  $('#bl-billview').hidden = B.view !== 'bill';
  if (B.view === 'scan') renderRecent(bill, t);
  if (B.view === 'search') renderSearch();
  if (B.view === 'bill') renderBillView(bill, t);
}

function setView(view) {
  if (!VIEWS.includes(view)) return;
  const changed = B.view !== view;
  B.view = view;
  renderAll();
  if (view === 'scan') startCamera();
  else stopCamera();
  if (changed) window.scrollTo({ top: $('#tab-billing').offsetTop - 8, behavior: 'instant' });
  if (view === 'search' && changed) setTimeout(() => $('#bl-q').focus(), 50);
}

function renderShutter() {
  const s = $('#bl-shutter');
  // With Auto on, the camera adds boxes by itself; the big button pauses it instead of scanning a second time.
  s.textContent = B.auto ? '⏸ Pause auto' : '📷 Scan item';
  s.classList.toggle('auto-on', B.auto);
  $('#bl-auto').checked = B.auto;
}

function setAuto(on) {
  B.auto = on;
  localStorage.setItem('bfw.billing.auto', on ? '1' : '0');
  B.lockId = null;
  B.lastTop = null;
  renderShutter();
  if (on) {
    renderMatches([], 'Auto: hold one box at a time inside the square.');
    startAuto();
  } else {
    stopAuto();
    renderMatches([], 'Auto paused. Tap 📷 Scan item for each box.');
  }
}

// ── Cart actions ───────────────────────────────────────────
function addItem(id, n = 1, { quiet = false } = {}) {
  const p = product(id);
  if (!p) return;
  const bill = activeBill() ?? newBill();
  bill.lines[id] = (bill.lines[id] ?? 0) + n;
  if (bill.lines[id] <= 0) {
    delete bill.lines[id];
    forgetOther(bill, id);
  } else if (n > 0) (bill.touched ??= {})[id] = Date.now();
  B.lastAdded = n > 0 ? id : null;
  saveOpenBills();
  renderAll();
  if (!quiet) {
    feedback();
    if (B.view === 'scan') showUndo(p, '#bl-added'); // over the camera
  }
}

/** Adds from a scan, unless this same box was just added (Auto and a tap, or two quick taps on one box). */
function addScanned(id) {
  const now = Date.now();
  if (B.lastScanAdd.id === id && now - B.lastScanAdd.at < SAME_SCAN_MS) return false;
  B.lastScanAdd = { id, at: now };
  addItem(id);
  return true;
}

const undoTimers = {};
function showUndo(p, sel) {
  const el = $(sel);
  el.innerHTML = `<span>✓ Added <strong>${escapeHtml(p.name)}</strong></span><button type="button" data-undo="${p.id}">Undo</button>`;
  el.hidden = false;
  clearTimeout(undoTimers[sel]);
  undoTimers[sel] = setTimeout(() => { el.hidden = true; }, sel === '#bl-added' ? 3000 : 4000);
}

/** Removes an other item's name and price once its line is gone. */
function forgetOther(bill, id) {
  if (isOtherId(id) && !bill.lines[id] && bill.custom) delete bill.custom[id];
}

function setQty(id, qty) {
  const bill = activeBill();
  if (!bill) return;
  const n = Math.max(0, Math.min(9999, Math.floor(Number(qty) || 0)));
  if (n) bill.lines[id] = n;
  else {
    delete bill.lines[id];
    forgetOther(bill, id);
  }
  B.lastAdded = null;
  saveOpenBills();
  renderAll();
}

/** After a tap on a typed search result: empty the box (and the category) so the next item can be typed at once. */
function readyForNextSearch(p) {
  if (B.view !== 'search' || !B.q) return;
  const q = $('#bl-q');
  q.value = '';
  B.q = '';
  B.cat = 'all';
  renderSearch();
  showUndo(p, '#bl-s-added');
  q.focus();
  window.scrollTo({ top: $('#tab-billing').offsetTop - 8, behavior: 'instant' });
}

// ── Other items (not in the price list) ────────────────────
const recentOthers = () => {
  try { return JSON.parse(localStorage.getItem(RECENT_OTHER_KEY) || '[]'); } catch { return []; }
};
function rememberOther(name, price) {
  const list = recentOthers().filter((o) => norm(o.name) !== norm(name));
  list.unshift({ name, price });
  try { localStorage.setItem(RECENT_OTHER_KEY, JSON.stringify(list.slice(0, 8))); } catch { /* fine */ }
}

function openOther(prefill = '') {
  const dlg = $('#bl-other-dialog');
  const recent = recentOthers();
  dlg.innerHTML = `<div class="d-head"><h2>✍ Other item</h2><button class="close" type="button" data-act="close" aria-label="Close">✕</button></div>
    <form class="d-body a-form" id="bl-other-form" novalidate autocomplete="off">
      <p class="muted">For a box that is not in the price list or will not scan. It goes on the bill like any item, and admins see it under <strong>Sales → Not in the price list</strong> to add it later.</p>
      ${recent.length ? `<div class="bl-other-recent"><small>Used recently</small><div>${recent.map((o, i) => `<button type="button" class="chip" data-recent="${i}">${escapeHtml(o.name)} · ${formatRupees(o.price)}</button>`).join('')}</div></div>` : ''}
      <label>Item name <input name="name" maxlength="60" required value="${escapeHtml(prefill)}" placeholder="e.g. Gold 1000 wala" /></label>
      <div class="two-col">
        <label>Price ₹ per box <input name="price" type="number" inputmode="decimal" min="1" step="0.01" required /></label>
        <label>Quantity
          <div class="bl-step bl-step-lg"><button type="button" data-oq="-1" aria-label="One less">−</button><input name="qty" type="number" inputmode="numeric" min="1" value="1" /><button type="button" data-oq="1" aria-label="One more">+</button></div>
        </label>
      </div>
      <p class="a-error" id="bl-other-error" hidden></p>
      <button class="btn btn-primary btn-block" type="submit">Add to bill</button>
    </form>`;
  dlg.showModal();
  const f = $('#bl-other-form');
  setTimeout(() => (prefill ? f.price : f.name).focus(), 60);
  f.addEventListener('click', (e) => {
    const r = e.target.closest('[data-recent]');
    if (r) {
      const o = recent[Number(r.dataset.recent)];
      f.name.value = o.name;
      f.price.value = o.price;
      return f.qty.focus();
    }
    const step = e.target.closest('[data-oq]');
    if (step) f.qty.value = Math.max(1, (Number(f.qty.value) || 1) + Number(step.dataset.oq));
  });
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = f.name.value.trim().replace(/\s+/g, ' ');
    const price = Math.round(Number(f.price.value) * 100) / 100;
    const qty = Math.min(9999, Math.max(1, Math.floor(Number(f.qty.value) || 1)));
    const err = $('#bl-other-error');
    if (name.length < 2) {
      err.textContent = 'Type the item name.';
      err.hidden = false;
      return f.name.focus();
    }
    if (!(price > 0)) {
      err.textContent = 'Type the price for one box.';
      err.hidden = false;
      return f.price.focus();
    }
    dlg.close(); // first, so focus can then go to the search box
    addOther(name, price, qty);
  });
}

function addOther(name, price, qty) {
  const bill = activeBill() ?? newBill();
  bill.custom ??= {};
  // Same name and price again on this bill: just more of it.
  let id = Object.keys(bill.custom).find((k) => norm(bill.custom[k].name) === norm(name) && bill.custom[k].price === price);
  if (!id) {
    id = `x-${crypto.randomUUID().slice(0, 8)}`;
    bill.custom[id] = { name, price };
  }
  rememberOther(name, price);
  addItem(id, qty, { quiet: true });
  feedback();
  const p = product(id);
  if (B.view === 'search') {
    if (B.q) readyForNextSearch(p);
    else showUndo(p, '#bl-s-added');
  } else if (B.view === 'scan') showUndo(p, '#bl-added');
  else B.ctx.toast(`Added ${name}`);
}

/** "Cancel & re-bill" from the Bills list: a new open bill with the same items, ready to fix and check out. */
export function startBillFrom(items) {
  const bill = newBill();
  let missing = 0;
  for (const it of items ?? []) {
    if (it.custom) {
      const id = `x-${crypto.randomUUID().slice(0, 8)}`;
      (bill.custom ??= {})[id] = { name: it.name, price: Number(it.finalPrice) };
      bill.lines[id] = Number(it.qty || 0);
      bill.touched[id] = Date.now();
      continue;
    }
    if (!product(it.id)) {
      missing++;
      continue;
    }
    bill.lines[it.id] = (bill.lines[it.id] ?? 0) + Number(it.qty || 0);
    bill.touched[it.id] = Date.now();
  }
  B.view = 'bill';
  saveOpenBills();
  renderAll();
  if (missing) B.ctx.toast(`${plural(missing, 'item')} no longer in the price list ${missing === 1 ? 'was' : 'were'} left out.`);
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
    if (B.view !== 'scan' || $('#tab-billing').hidden) return stopCamera(); // left the screen while it started
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
  if (!B.scanReady) return renderMatches([], 'No item photos are ready for scanning yet.', { other: true });
  if (B.scanning) return; // one scan at a time: a tap during an Auto scan must not add the box twice
  if (auto && (!B.auto || $('dialog[open]'))) return;
  B.scanning = true;
  const shutter = $('#bl-shutter');
  if (!auto) shutter.disabled = true;
  try {
    const matches = await matchFrame($('#bl-video'), 4);
    if (auto) {
      if (!B.auto) return; // paused while this scan ran
      const top = matches[0];
      if (!top || top.score < 6) B.lockId = null; // camera moved away: the same item may be added again
      // Auto shows only a status line: nothing tappable that a finger could hit while the list changes.
      if (isConfident(matches) && top.id === B.lastTop && top.id !== B.lockId) {
        B.lockId = top.id;
        // The lock (cleared only when the camera sees no box) already stops repeats, so a second box of the
        // same item shown after moving the first away is added.
        B.lastScanAdd = { id: top.id, at: Date.now() };
        addItem(top.id);
        renderMatches([], `✓ ${product(top.id)?.name}. Move it away, then show the next box.`, { ok: true });
      } else if (top?.id !== B.lockId || !top) {
        renderMatches([], isConfident(matches) ? 'Hold steady…' : 'Looking… hold one box inside the square.');
      }
      B.lastTop = top?.id ?? null;
    } else if (isConfident(matches)) {
      const id = matches[0].id;
      if (addScanned(id)) renderMatches(matches.slice(1, 3), `✓ Added ${product(id)?.name}. Wrong item? Swap it below or tap Undo.`, { swapFor: id, ok: true });
      else renderMatches([], `${product(id)?.name} was just added. For more boxes of it, use + on the bill.`);
    } else {
      renderMatches(matches, matches.length ? '' : 'Nothing recognised. Try again closer, or use Search.', { other: true });
    }
  } catch (err) {
    console.error(err);
    renderMatches([], `Scanner error: ${err.message}`);
  } finally {
    B.scanning = false;
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
        <label>Mobile <small>(for WhatsApp)</small><input name="phone" inputmode="numeric" maxlength="10" autocomplete="off" /></label>
        <label>Customer name <small>(optional)</small><input name="name" maxlength="60" autocomplete="off" /></label>
      </div>
      <p class="fine" id="bl-returning" hidden></p>
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
    if (e.target.name === 'phone') {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10);
      // A returning customer: fill in the name used last time.
      const known = e.target.value.length === 10 ? nameForPhone(e.target.value) : '';
      if (known && !f.name.value.trim()) f.name.value = known;
      $('#bl-returning').hidden = !known;
      $('#bl-returning').textContent = known ? `Returning customer: ${known}` : '';
    }
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

export function billMessage(bill) {
  const t = bill.totals;
  const lines = bill.items.map((it, i) => `${i + 1}. ${it.name}${it.brand ? ` (${it.brand})` : ''} × ${it.qty} = ${formatRupees(it.lineTotal)}`);
  const when = new Date(bill.billedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  return [
    '*Best FireWorks* 🎆',
    `Bill ${bill.billNo} · ${when}`,
    bill.customer?.name ? `Customer: ${bill.customer.name}` : null,
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

export const whatsappUrl = (bill) => {
  const text = billMessage(bill);
  const phone = bill.customer?.phone;
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
  const staff = B.ctx.getStaff();
  const billedAt = new Date().toISOString();
  const bill = {
    billNo: await nextBillNo(),
    billedAt,
    day: istDay(billedAt),
    device: await deviceCode(),
    cashierUid: staff?.uid ?? '',
    cashierName: staff?.name ?? '',
    customer: { name: f.name.value.trim().slice(0, 60), phone },
    payment,
    status: 'ok',
    items: t.lines.map(({ product: p, qty, lineTotal }) => ({
      id: p.id, listNo: p.listNo, name: p.name, brand: p.brand ?? '', qty,
      amount: p.amount, finalPrice: p.finalPrice, lineTotal: toRupees(lineTotal),
      ...(p.custom ? { custom: true } : {}),
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
  reloadLocal();
  // Close this bill and move to the next open one (or a fresh one)
  dropBill(B.active);
  B.view = B.view === 'bill' ? 'scan' : B.view;
  $('#bl-checkout-dialog').close();
  renderAll();
  if (B.view === 'scan') startCamera();
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
/** What goes to Firestore. Older app versions saved bills without the salesperson's id; fill it in. */
function payloadOf(bill) {
  const { synced, cashier, ...data } = bill;
  void synced;
  const staff = B.ctx.getStaff();
  return {
    ...data,
    cashierUid: data.cashierUid || staff?.uid || '',
    cashierName: data.cashierName || cashier || staff?.name || '',
    day: data.day || istDay(data.billedAt),
    status: data.status === 'void' ? 'void' : 'ok',
    source: 'counter',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function upload(bill) {
  if (B.uploading.has(bill.billNo) || !B.ctx.getStaff()) return;
  B.uploading.add(bill.billNo);
  const ref = doc(B.ctx.db, 'sales', bill.billNo);
  const done = async () => {
    bill.synced = true;
    await saveBill(bill);
    await reloadLocal();
    const note = $('#bl-done-sync');
    if (note && $('#bl-done-dialog').open) note.textContent = 'Uploaded.';
  };
  // If offline, Firestore keeps this write and sends it when the internet is back (while the app stays open).
  setDoc(ref, payloadOf(bill))
    .then(done)
    .catch(async (e) => {
      // Uploaded earlier but the reply never arrived? Then the bill is already there and is done.
      if (e?.code === 'permission-denied') {
        const snap = await getDoc(ref).catch(() => null);
        if (snap?.exists()) return done();
      }
      console.warn('Bill upload failed, will retry', bill.billNo, e);
    })
    .finally(() => B.uploading.delete(bill.billNo));
}

/** Uploads bills saved while offline (or before the app was closed). Returns how many were waiting. */
export async function flushPending() {
  const pending = (await allBills()).filter((b) => !b.synced);
  pending.forEach(upload);
  return pending.length;
}

export async function pendingCount() {
  return (await allBills().catch(() => [])).filter((b) => !b.synced).length;
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
    B.bills = open.bills.map((b) => ({ touched: {}, ...b }));
    B.active = open.bills.some((b) => b.id === open.active) ? open.active : open.bills[0].id;
  }
  B.auto = localStorage.getItem('bfw.billing.auto') === '1';
  renderShutter();

  const panel = $('#tab-billing');
  panel.addEventListener('click', (e) => {
    const t = e.target;
    const billBtn = t.closest('[data-bill]');
    if (billBtn) {
      if (billBtn.dataset.bill === 'new') {
        newBill();
        if (B.view === 'bill') B.view = 'scan';
      } else if (billBtn.dataset.bill === B.active && !Object.keys(activeBill().lines).length && B.bills.length > 1) {
        dropBill(B.active); // tapping an empty selected bill closes it
      } else B.active = billBtn.dataset.bill;
      saveOpenBills();
      renderAll();
      if (B.view === 'scan') startCamera();
      return;
    }
    const view = t.closest('[data-bl-view]');
    if (view) return setView(view.dataset.blView);
    // Quantity steppers come before "add", because they sit inside a search result that adds on tap.
    const q = t.closest('[data-q]');
    if (q && q.tagName === 'BUTTON') {
      const id = q.closest('[data-id]').dataset.id;
      return setQty(id, (activeBill().lines[id] ?? 0) + Number(q.dataset.q));
    }
    if (t.closest('.bl-step')) return; // tapping the number box just edits it
    const other = t.closest('[data-other]');
    if (other) return openOther(other.dataset.other ?? '');
    const add = t.closest('[data-add]');
    if (add) {
      addItem(add.dataset.add);
      return readyForNextSearch(product(add.dataset.add)); // typed search only: clear the box for the next item
    }
    // Scan suggestions: only the Add / Swap buttons count, and not in the first moment after the list appeared.
    const pick = t.closest('[data-pick]');
    if (pick) {
      if (tooSoon()) return;
      addScanned(pick.dataset.pick);
      return renderMatches([], `✓ Added ${product(pick.dataset.pick)?.name}.`, { ok: true });
    }
    const swap = t.closest('[data-swap]');
    if (swap) {
      if (tooSoon()) return;
      addItem(swap.dataset.from, -1, { quiet: true });
      addItem(swap.dataset.swap);
      B.lastScanAdd = { id: swap.dataset.swap, at: Date.now() };
      return renderMatches([], `✓ Swapped to ${product(swap.dataset.swap)?.name}.`, { ok: true });
    }
    const cat = t.closest('[data-cat]');
    if (cat && t.closest('#bl-cats')) {
      B.cat = cat.dataset.cat;
      return renderSearch();
    }
    const undo = t.closest('[data-undo]');
    if (undo) {
      addItem(undo.dataset.undo, -1, { quiet: true });
      undo.parentElement.hidden = true;
      if (B.lastScanAdd.id === undo.dataset.undo) B.lastScanAdd = { id: null, at: 0 };
      return;
    }
    if (t.closest('#bl-shutter')) return B.auto ? setAuto(false) : scanOnce();
    if (t.closest('#bl-checkout')) return openCheckout();
    if (t.closest('#bl-sync')) return syncNow();
    if (t.closest('#bl-bills-btn')) return B.ctx.openBills();
    if (t.closest('#bl-hold')) {
      newBill();
      B.view = 'scan';
      renderAll();
      startCamera();
      return B.ctx.toast('Bill kept on hold. Tap its chip at the top to go back to it.');
    }
    if (t.closest('#bl-clear') && activeBill() && Object.keys(activeBill().lines).length && confirm('Remove all items from this bill?')) {
      activeBill().lines = {};
      activeBill().touched = {};
      activeBill().custom = {};
      saveOpenBills();
      return renderAll();
    }
    if (t.closest('#bl-drop')) {
      const bill = activeBill();
      if (Object.keys(bill?.lines ?? {}).length && !confirm(`Delete Bill ${bill.n} and its items?`)) return;
      dropBill(B.active);
      renderAll();
    }
  });
  panel.addEventListener('keydown', (e) => {
    const row = e.target.closest?.('.bl-item[data-add]');
    if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      addItem(row.dataset.add);
    }
  });
  panel.addEventListener('change', (e) => {
    if (e.target.dataset.q === 'set') setQty(e.target.closest('[data-id]').dataset.id, e.target.value);
    if (e.target.id === 'bl-auto') setAuto(e.target.checked);
  });
  $('#bl-q').addEventListener('input', (e) => {
    B.q = e.target.value.trim();
    renderSearch();
  });
  // Enter in the search box adds the only result (or the top one), then the box is ready for the next item.
  $('#bl-q').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !B.q) return;
    e.preventDefault();
    const first = $('#bl-grid [data-add]');
    if (first) {
      addItem(first.dataset.add);
      readyForNextSearch(product(first.dataset.add));
    } else openOther(B.q);
  });
  for (const id of ['#bl-checkout-dialog', '#bl-done-dialog', '#bl-other-dialog']) {
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
