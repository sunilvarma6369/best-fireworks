import { ORDER_OPTIONS, SITE_URL } from './config.js';
import {
  applyCatalogOverrides, categoryIcon, escapeHtml, extTarget, indexPriceList, isNativeApp, loadPriceList, prettyPhone,
  telLink, waLink,
} from './lib/catalog.js';
import { cleanCodeInput, normalizeOrderCode } from './lib/codes.js';
import { formatDate, formatPaise, formatRupees, todayIST } from './lib/money.js';
import { computeTotals } from './lib/pricing.js';
import { customerStatus, fetchPublicSettings, fetchTracking, getMyOrders, placeOrder, rememberOrder } from './lib/orders.js';

const $ = (sel, root = document) => root.querySelector(sel);
const CART_KEY = 'bfw.cart.v1';
const CUSTOMER_KEY = 'bfw.customer.v1';

const state = {
  data: null,
  settings: { soldOut: [], notice: '', ordersOpen: true },
  soldOut: new Set(),
  cart: loadCart(),
  section: 'others',
  category: 'all',
  query: '',
};

// ── Storage helpers ──────────────────────────────────────
function loadCart() {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(CART_KEY)) ?? {}));
  } catch {
    return new Map();
  }
}
function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(Object.fromEntries(state.cart)));
  } catch { /* private mode: cart lives for this visit only */ }
}
function loadCustomer() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOMER_KEY)) ?? {};
  } catch {
    return {};
  }
}
function saveCustomer(c) {
  try {
    localStorage.setItem(CUSTOMER_KEY, JSON.stringify(c));
  } catch { /* ignore */ }
}

// ── Sheets (dialogs) with Android back-button support ────
let skipHistoryBack = false;
function openSheet(dlg) {
  if (dlg.open) return;
  dlg.showModal();
  history.pushState({ sheet: dlg.id }, '');
}
document.querySelectorAll('dialog.sheet').forEach((dlg) => {
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
  });
  dlg.addEventListener('close', () => {
    if (!skipHistoryBack && history.state?.sheet === dlg.id) history.back();
    skipHistoryBack = false;
  });
});
window.addEventListener('popstate', () => {
  document.querySelectorAll('dialog[open]').forEach((d) => {
    skipHistoryBack = true;
    d.close();
  });
});

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

// ── Store info ───────────────────────────────────────────
function renderStoreInfo() {
  const { store } = state.data;
  const [phone1, phone2] = store.phones;
  $('#tagline').textContent = store.tagline;
  $('#years').textContent = store.yearsInBusiness;
  $('#opening').textContent = formatDate(store.openingDate).replace(/^\w+, /, '') + ' 2026';
  $('#address').textContent = store.address.display;
  $('#footer-address').innerHTML = `${escapeHtml(store.address.display)}${store.sameLocationAsLastYear ? ' (same place as last year)' : ''}
    · <a href="${store.directionsUrl}" ${extTarget}>📍 Directions</a>`;
  $('#footer-phones').innerHTML = store.phones
    .map((p) => `<a href="${telLink(p)}">${prettyPhone(p)}</a>`)
    .join(' · ');

  // Google Maps directions link: opens the Maps app on phones.
  for (const el of [$('#map-link'), $('#hero-directions')]) {
    el.href = store.directionsUrl;
    if (extTarget) { el.target = '_blank'; el.rel = 'noopener'; }
  }
  $('#top-call').href = telLink(phone1 ?? phone2);
  const wa = $('#top-wa');
  wa.href = store.whatsappOrderUrl;
  if (extTarget) { wa.target = '_blank'; wa.rel = 'noopener'; }


  const { offer } = state.data;
  if (offer && (!offer.validUntil || todayIST() <= offer.validUntil)) {
    $('#offer-card').hidden = false;
    $('#offer-fine').textContent =
      `Valid till ${formatDate(offer.validUntil)} 2026. Not applicable on pop pop, guns & ring caps.`;
  }
}

function renderSettings() {
  const { notice, ordersOpen, deliveryEnabled, deliveryNote } = state.settings;
  const n = $('#notice');
  n.textContent = notice ?? '';
  n.hidden = !notice;
  $('#closed-banner').hidden = ordersOpen !== false;
  // Home delivery is switched on/off by the shop (admin → Settings); pickup is always available.
  $('#delivery-option').hidden = !deliveryEnabled;
  $('#delivery-note').textContent = deliveryEnabled ? (deliveryNote || 'Delivery charges confirmed on call') : '';
  $('#hero-collect').textContent = deliveryEnabled ? 'pick up or get it delivered.' : 'pick up at our stall.';
}

// ── Catalog ──────────────────────────────────────────────
function isSoldOut(p) {
  return p.active === false || state.soldOut.has(p.id);
}

function actionHtml(p) {
  if (isSoldOut(p)) return '<span class="soldout-label">Sold out</span>';
  const qty = Number(state.cart.get(p.id) ?? 0);
  if (!qty) return `<button class="add-btn" type="button" data-act="add">ADD</button>`;
  return `<span class="stepper">
      <button type="button" data-act="dec" aria-label="One less">−</button>
      <input type="number" inputmode="numeric" min="0" max="${ORDER_OPTIONS.maxQtyPerItem}" value="${qty}" aria-label="Quantity" data-act="qty" />
      <button type="button" data-act="inc" aria-label="One more">+</button>
    </span>`;
}

function productHtml(p) {
  const pcs = p.pcsPerBox ? `${p.pcsPerBox} pc${p.pcsPerBox > 1 ? 's' : ''}/box` : 'per box';
  const off = Math.round(p.discountPercent);
  const inCart = state.cart.has(p.id) && !isSoldOut(p);
  const excluded = p.bulkOfferEligible ? '' : '<span class="tag" title="Bulk 10% offer does not apply">No bulk offer</span>';
  return `<li class="prod${inCart ? ' in-cart' : ''}${isSoldOut(p) ? ' sold-out' : ''}" data-id="${p.id}">
      <div class="prod-thumb" style="--tint:${categoryTint(p.categoryId)}" aria-hidden="true">
        ${categoryIcon(p.categoryId)}${off > 0 ? `<em class="ribbon">${off}% OFF</em>` : ''}
      </div>
      <div class="prod-info">
        <p class="prod-name">${escapeHtml(p.name)}</p>
        <p class="prod-meta"><span class="prod-no">#${p.listNo}</span> · ${escapeHtml(p.brand ?? '—')} · ${pcs}${excluded ? `<br />${excluded}` : ''}</p>
      </div>
      <div class="prod-price">
        <span class="price-final">${formatRupees(p.finalPrice)}</span>
        ${p.amount > p.finalPrice ? `<span class="price-was">${formatRupees(p.amount)}</span>` : ''}
      </div>
      <div class="prod-action">${actionHtml(p)}</div>
    </li>`;
}

// A soft, stable background colour per category for the product picture tile.
function categoryTint(categoryId) {
  let h = 0;
  for (const ch of categoryId) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 85% 95%)`;
}

function categoryGroupHtml(cat, products) {
  return `<section class="cat-group" id="cat-${cat.id}">
      <h2 class="cat-title"><span>${categoryIcon(cat.id)} ${escapeHtml(cat.name)}</span><small>${products.length} items</small></h2>
      ${cat.note ? `<p class="cat-note">${escapeHtml(cat.note)}</p>` : ''}
      <ul class="plist">${products.map(productHtml).join('')}</ul>
    </section>`;
}

function matches(p, tokens) {
  const hay = `${p.name} ${p.brand ?? ''} ${p.category} ${p.listNo}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

function renderChips() {
  const chips = $('#chips');
  const cats = state.data.categories.filter((c) => c.section === state.section);
  if (cats.length < 2 || state.query) {
    chips.innerHTML = '';
    return;
  }
  chips.innerHTML = [{ id: 'all', name: 'All' }, ...cats]
    .map((c) => `<button class="chip" type="button" data-cat="${c.id}" aria-pressed="${state.category === c.id}">
        ${c.id === 'all' ? '' : categoryIcon(c.id) + ' '}${escapeHtml(c.name)}</button>`)
    .join('');
}

function renderCatalog() {
  const { categories, products } = state.data;
  const tokens = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const el = $('#products');
  let html = '';

  if (tokens.length) {
    for (const section of state.data.sections) {
      let sectionHtml = '';
      for (const cat of categories.filter((c) => c.section === section.id)) {
        const list = products.filter((p) => p.categoryId === cat.id && matches(p, tokens));
        if (list.length) sectionHtml += categoryGroupHtml(cat, list);
      }
      if (sectionHtml) html += `<h2 class="section-title">${escapeHtml(section.name)}</h2>${sectionHtml}`;
    }
    if (!html) html = `<p class="empty">No crackers match “${escapeHtml(state.query)}”. Try a shorter word.</p>`;
  } else {
    for (const cat of categories.filter((c) => c.section === state.section)) {
      if (state.category !== 'all' && state.category !== cat.id) continue;
      html += categoryGroupHtml(cat, products.filter((p) => p.categoryId === cat.id));
    }
  }
  el.innerHTML = html;
}

function refreshRow(id) {
  const p = state.data.productsById.get(id);
  document.querySelectorAll(`.prod[data-id="${id}"]`).forEach((row) => {
    row.querySelector('.prod-action').innerHTML = actionHtml(p);
    row.classList.toggle('in-cart', state.cart.has(id) && !isSoldOut(p));
  });
}

function setQty(id, qty, { focusInput = false } = {}) {
  const p = state.data.productsById.get(id);
  if (!p || isSoldOut(p)) return;
  qty = Math.max(0, Math.min(ORDER_OPTIONS.maxQtyPerItem, Math.floor(Number(qty) || 0)));
  if (qty) state.cart.set(id, qty);
  else state.cart.delete(id);
  saveCart();
  refreshRow(id);
  renderCartBar(true);
  if ($('#cart-sheet').open) renderCart();
  if (focusInput) $(`.prod[data-id="${id}"] .stepper input`)?.focus();
}

function handleQtyEvents(root) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const row = e.target.closest('[data-id]');
    if (!btn || !row || btn.tagName === 'INPUT') return;
    const id = row.dataset.id;
    const cur = Number(state.cart.get(id) ?? 0);
    if (btn.dataset.act === 'add' || btn.dataset.act === 'inc') setQty(id, cur + 1);
    else if (btn.dataset.act === 'dec') setQty(id, cur - 1);
    else if (btn.dataset.act === 'remove') setQty(id, 0);
    else if (btn.dataset.act === 'remove-unavailable') {
      state.cart.delete(id);
      saveCart();
      renderCart();
      renderCartBar();
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.dataset.act !== 'qty') return;
    setQty(e.target.closest('[data-id]').dataset.id, e.target.value);
  });
}

// ── Cart ─────────────────────────────────────────────────
function totals() {
  return computeTotals(
    new Map([...state.cart].map(([id, q]) => [id, Number(q)])),
    state.data.productsById,
    state.data.offer,
    state.soldOut,
  );
}

function renderCartBar(bump = false) {
  const t = totals();
  const bar = $('#cartbar');
  bar.hidden = t.itemCount === 0;
  $('#cartbar-total').textContent = formatPaise(t.netPayable);
  const saved = t.discountTotal + t.bulkDiscount;
  $('#cartbar-meta').textContent =
    `${t.itemCount} box${t.itemCount === 1 ? '' : 'es'} · ${t.lines.length} item${t.lines.length === 1 ? '' : 's'}` +
    (saved > 0 ? ` · you save ${formatPaise(saved)}` : '');
  if (bump) {
    bar.classList.remove('bump');
    void bar.offsetWidth;
    bar.classList.add('bump');
  }
}

function renderCart() {
  const t = totals();
  const { offer } = state.data;
  const linesHtml = t.lines
    .map(({ product: p, qty, lineTotal, eligible }) => `<div class="cart-line" data-id="${p.id}">
        <div>
          <div class="line-name"><strong>${escapeHtml(p.name)}</strong></div>
          <div class="line-sub">${escapeHtml(p.brand ?? '')} · ${formatRupees(p.finalPrice)} × ${qty}${eligible ? '' : ' · no bulk offer'}</div>
        </div>
        <div class="line-total">${formatPaise(lineTotal)}</div>
        <div>${actionHtml(p)}</div>
        <div><button class="link-btn" type="button" data-act="remove">Remove</button></div>
      </div>`)
    .join('');
  const skippedHtml = t.skipped
    .map(({ product: p }) => `<div class="cart-line unavailable" data-id="${p.id}">
        <div><div class="line-name">${escapeHtml(p.name)}</div><div class="line-sub">Sold out, not included</div></div>
        <div><button class="link-btn" type="button" data-act="remove-unavailable">Remove</button></div>
      </div>`)
    .join('');
  $('#cart-lines').innerHTML = linesHtml + skippedHtml || '<p class="empty">Your cart is empty. Add crackers from the price list.</p>';

  let nudge = '';
  if (t.qualifies) {
    nudge = `<p class="offer-nudge won">🎉 Bulk offer unlocked: extra ${offer.value}% off saves you ${formatPaise(t.bulkDiscount)}.</p>`;
  } else if (t.offerLive && t.itemCount) {
    nudge = `<p class="offer-nudge">Add ${formatPaise(t.moreForOffer)} more to get an extra ${offer.value}% off (bill above ${formatRupees(offer.minBillAmount)}).</p>`;
  }
  $('#cart-totals').innerHTML = t.itemCount
    ? `<div class="totals">
        <div class="row"><span>Amount</span><span>${formatPaise(t.amountTotal)}</span></div>
        <div class="row save"><span>Discount</span><span>−${formatPaise(t.discountTotal)}</span></div>
        <div class="row"><span>Subtotal</span><span>${formatPaise(t.cartTotal)}</span></div>
        ${t.qualifies ? `<div class="row save"><span>Bulk offer (extra ${offer.value}%)</span><span>−${formatPaise(t.bulkDiscount)}</span></div>` : ''}
        <div class="row net"><span>To pay at stall</span><span>${formatPaise(t.netPayable)}</span></div>
      </div>
      ${nudge}
      ${t.qualifies && t.hasIneligible ? '<p class="fine">The extra 10% is not applied on pop pop, guns & ring caps.</p>' : ''}`
    : '';

  const closed = state.settings.ordersOpen === false;
  $('#checkout').hidden = t.itemCount === 0;
  $('#submit-order').disabled = closed;
  $('#submit-order').textContent = closed ? 'Online booking paused' : `Book order · ${formatPaise(t.netPayable)}`;
}

// ── Checkout ─────────────────────────────────────────────
function setupCheckout() {
  const form = $('#checkout');
  const saved = loadCustomer();
  form.name.value = saved.name ?? '';
  form.phone.value = saved.phone ?? '';
  form.area.value = saved.area ?? '';

  // Customers can book for any day from today.
  form.pickupDate.min = todayIST();

  form.addEventListener('change', (e) => {
    if (e.target.name !== 'fulfilment') return;
    const delivery = form.fulfilment.value === 'delivery';
    $('#address-field').hidden = !delivery;
    $('#date-label').textContent = delivery ? 'Preferred delivery date' : 'Preferred pickup date';
  });
  form.phone.addEventListener('input', () => {
    form.phone.value = form.phone.value.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '').slice(0, 10);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#form-error');
    const fail = (msg, field) => {
      err.textContent = msg;
      err.hidden = false;
      field?.focus();
    };
    err.hidden = true;

    const name = form.name.value.trim().replace(/\s+/g, ' ');
    const phone = form.phone.value.trim();
    const area = form.area.value.trim();
    const fulfilment = state.settings.deliveryEnabled && form.fulfilment.value === 'delivery' ? 'delivery' : 'pickup';
    const address = form.address.value.trim();
    const pickupDate = form.pickupDate.value;
    const note = form.note.value.trim();

    if (name.length < 2) return fail('Please enter your name.', form.name);
    if (!/^[6-9]\d{9}$/.test(phone)) return fail('Please enter a valid 10-digit mobile number.', form.phone);
    if (fulfilment === 'delivery' && address.length < 8) return fail('Please enter your delivery address.', form.address);
    if (pickupDate && pickupDate < todayIST()) return fail('Please choose today or a later date.', form.pickupDate);

    const t = totals();
    if (!t.lines.length) return fail('Your cart is empty.');

    const btn = $('#submit-order');
    btn.disabled = true;
    btn.textContent = 'Booking…';
    try {
      const customer = { name, phone, ...(area ? { area } : {}) };
      saveCustomer({ name, phone, area });
      const result = await placeOrder({
        customer, fulfilment, address, pickupDate, note, totals: t, priceListDate: state.data.generatedOn,
      });
      rememberOrder({
        code: result.code,
        pickupCode: result.pickupCode,
        placedAt: new Date().toISOString(),
        customer, fulfilment, address, pickupDate, note,
        items: result.items,
        totals: result.totals,
      });
      state.cart.clear();
      saveCart();
      form.note.value = '';
      renderCatalog();
      renderCartBar();
      showDone(result, { customer, fulfilment, address, pickupDate, note });
    } catch (ex) {
      fail(ex.message);
    } finally {
      renderCart();
    }
  });
}

function trackUrl(code) {
  // The live site serves /track (clean URL); the local dev server only knows /track.html.
  if (import.meta.env.DEV || SITE_URL.includes('YOUR-')) return `${location.origin}/track.html?code=${code}`;
  return `${SITE_URL}/track?code=${code}`;
}

function whatsappMessage(result, { customer, fulfilment, address, pickupDate, note }) {
  const MAX_LINES = 40;
  const lines = result.items.slice(0, MAX_LINES).map(
    (it, i) => `${i + 1}. ${it.name}${it.brand ? ` (${it.brand})` : ''} × ${it.qty} = ${formatRupees(it.lineTotal)}`,
  );
  if (result.items.length > MAX_LINES) lines.push(`…and ${result.items.length - MAX_LINES} more items`);
  const t = result.totals;
  // null = optional line that is left out; '' = intentional blank line
  return [
    `Hi Best FireWorks, I booked order *${result.code}*.`,
    `${fulfilment === 'delivery' ? 'Delivery' : 'Pickup'} code: *${result.pickupCode}*`,
    `Name: ${customer.name}`,
    `Mobile: ${customer.phone}`,
    customer.area ? `Area: ${customer.area}` : null,
    fulfilment === 'delivery' ? `Delivery to: ${address}` : 'Pickup at stall',
    pickupDate ? `Preferred date: ${formatDate(pickupDate)}` : null,
    '',
    ...lines,
    '',
    `Subtotal: ${formatRupees(t.cartTotal)}`,
    t.bulkDiscount ? `Bulk offer: −${formatRupees(t.bulkDiscount)}` : null,
    `*To pay: ${formatRupees(t.netPayable)}*`,
    note ? `Note: ${note}` : null,
    '',
    `Track: ${trackUrl(result.code)}`,
  ].filter((l) => l !== null).join('\n');
}

function showDone(result, details) {
  const { store } = state.data;
  const waUrl = waLink(store.whatsapp, whatsappMessage(result, details));
  const delivery = details.fulfilment === 'delivery';
  $('#done-body').innerHTML = `
    <div class="codes">
      <div class="done-code"><small>Order code</small><strong>${result.code}</strong><small>To track your order</small></div>
      <div class="done-code pin"><small>${delivery ? 'Delivery code' : 'Pickup code'}</small><strong>${result.pickupCode}</strong>
        <small>${delivery ? 'Tell the delivery person' : 'Tell the shop when you collect'}. Don't share it.</small></div>
    </div>
    <p>Thank you, ${escapeHtml(details.customer.name)}. <strong>Send your order to the shop on WhatsApp</strong> to confirm it.
       The shop will keep you posted on WhatsApp at <strong>${escapeHtml(details.customer.phone)}</strong>.
       Pay <strong>${formatRupees(result.totals.netPayable)}</strong> ${delivery ? 'when your order is delivered' : 'at the stall when you collect'}.</p>
    <div class="done-actions">
      <a class="btn btn-wa btn-block" href="${waUrl}" ${extTarget}>💬 Send order to shop on WhatsApp</a>
      <a class="btn btn-primary btn-block" href="track.html?code=${result.code}">📦 Track this order</a>
      <a class="btn btn-soft btn-block" href="${store.directionsUrl}" ${extTarget}>📍 Directions to the stall</a>
      <a class="btn btn-soft btn-block" href="${telLink(store.phones[0])}">📞 Call the shop</a>
    </div>
    <p class="fine">This order (with both codes) is saved on this phone under “Orders” until you clear your browser data. Your WhatsApp message is also a copy.</p>`;
  skipHistoryBack = true;
  $('#cart-sheet').close();
  $('#done-sheet').showModal();
  history.replaceState({ sheet: 'done-sheet' }, '');
}

// ── My orders ────────────────────────────────────────────
async function renderMyOrders() {
  const list = getMyOrders();
  const el = $('#my-orders');
  if (!list.length) {
    el.innerHTML = '<p class="fine">Orders you book on this phone will show here.</p>';
    return;
  }
  el.innerHTML = list
    .map((o) => `<a class="order-card" href="track.html?code=${o.code}">
        <strong>${o.code}</strong><span class="badge status-new" data-status-for="${o.code}">…</span>
        <small>${new Date(o.placedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} · ${o.totals?.itemCount ?? 0} boxes · ${formatRupees(o.totals?.netPayable ?? 0)}</small>
        ${o.pickupCode ? `<span class="pin-chip">Pickup ${o.pickupCode}</span>` : '<span></span>'}
      </a>`)
    .join('');
  await Promise.all(
    list.slice(0, 10).map(async (o) => {
      const badge = el.querySelector(`[data-status-for="${o.code}"]`);
      try {
        const t = await fetchTracking(o.code);
        const status = t?.status ?? 'new';
        badge.className = `badge status-${status}`;
        badge.textContent = customerStatus(status, o.fulfilment).label;
      } catch {
        badge.textContent = 'Tap to view';
      }
    }),
  );
}

// ── Wire up ──────────────────────────────────────────────
function setupUi() {
  document.querySelectorAll('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      state.section = tab.dataset.section;
      state.category = 'all';
      document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      renderChips();
      renderCatalog();
    }),
  );
  $('#chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat]');
    if (!chip) return;
    state.category = chip.dataset.cat;
    renderChips();
    renderCatalog();
  });
  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = e.target.value.trim();
      renderChips();
      renderCatalog();
    }, 150);
  });

  handleQtyEvents($('#products'));
  handleQtyEvents($('#cart-lines'));

  $('#cartbar-open').addEventListener('click', () => {
    renderCart();
    openSheet($('#cart-sheet'));
  });
  $('#top-orders').addEventListener('click', () => {
    openSheet($('#orders-sheet'));
    renderMyOrders();
  });
  const codeBox = $('#track-form [data-code-input]');
  codeBox.addEventListener('input', () => (codeBox.value = cleanCodeInput(codeBox.value)));
  $('#track-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeOrderCode(codeBox.value);
    if (!code) return toast('Type the 5 letters/numbers after BFW-, e.g. K7Q2M');
    location.href = `track.html?code=${code}`;
  });
}

async function init() {
  setupUi();
  try {
    const [priceList, settings] = await Promise.all([loadPriceList(), fetchPublicSettings()]);
    // Prices/items edited on the admin page override the price-list file.
    state.data = indexPriceList(applyCatalogOverrides(priceList, settings.catalog));
    state.settings = { ...state.settings, ...settings };
    state.soldOut = new Set(state.settings.soldOut ?? []);
  } catch (err) {
    console.error(err);
    $('#products').innerHTML = '<p class="empty">Could not load the price list. Check your internet connection and refresh.</p>';
    return;
  }
  // Drop cart entries for products that no longer exist.
  for (const id of state.cart.keys()) if (!state.data.productsById.has(id)) state.cart.delete(id);
  saveCart();

  renderStoreInfo();
  renderSettings();
  renderChips();
  renderCatalog();
  renderCartBar();
  setupCheckout();
}

init();
