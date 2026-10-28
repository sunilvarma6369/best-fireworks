import { escapeHtml, extTarget, loadPriceList, telLink, waLink } from './lib/catalog.js';
import { cleanCodeInput, normalizeOrderCode } from './lib/codes.js';
import { formatDate, formatDateTime, formatRupees } from './lib/money.js';
import { customerStatus, fetchTracking, getMyOrder, STATUS_FLOW } from './lib/orders.js';

const $ = (sel) => document.querySelector(sel);
const REFRESH_MS = 30_000;

let store = null;
let currentCode = null;
let refreshTimer;

function timelineHtml(status, fulfilment) {
  if (status === 'cancelled') {
    return `<ol class="timeline"><li class="done">Received</li><li class="current">Cancelled</li></ol>`;
  }
  const idx = STATUS_FLOW.indexOf(status);
  return `<ol class="timeline">${STATUS_FLOW.map((s, i) => {
    const cls = i < idx ? 'done' : i === idx ? 'done current' : '';
    return `<li class="${cls}">${customerStatus(s, fulfilment).label}</li>`;
  }).join('')}</ol>`;
}

// Full order details exist only on the phone/browser that booked it (never on the server for public view).
function savedOrderHtml(mine) {
  if (!mine) return '';
  const t = mine.totals ?? {};
  return `<div class="card track-result saved">
      <h2>Your order details</h2>
      <p class="muted">Saved on this phone when you booked.</p>
      <div class="codes">
        <div class="done-code"><small>Order code</small><strong>${escapeHtml(mine.code)}</strong></div>
        <div class="done-code pin"><small>Pickup code</small><strong>${escapeHtml(mine.pickupCode ?? '—')}</strong><small>Tell the shop when you collect</small></div>
      </div>
      <p><strong>${escapeHtml(mine.customer?.name ?? '')}</strong> · ${escapeHtml(mine.customer?.phone ?? '')}<br />
        ${mine.fulfilment === 'delivery' ? `Delivery: ${escapeHtml(mine.address ?? '')}` : 'Pickup at stall'}${mine.pickupDate ? ` · ${formatDate(mine.pickupDate)}` : ''}</p>
      <ul class="saved-items">${(mine.items ?? []).map((i) => `<li>
          <span>${escapeHtml(i.name)}${i.brand ? ` <small>(${escapeHtml(i.brand)})</small>` : ''} × ${i.qty}</span>
          <span>${formatRupees(i.lineTotal)}</span></li>`).join('')}</ul>
      <div class="saved-totals">
        <div><span>Subtotal</span><span>${formatRupees(t.cartTotal ?? 0)}</span></div>
        ${t.bulkDiscount ? `<div class="save"><span>Bulk offer</span><span>−${formatRupees(t.bulkDiscount)}</span></div>` : ''}
        <div class="net"><span>${mine.fulfilment === 'delivery' ? 'To pay on delivery' : 'To pay at stall'}</span><span>${formatRupees(t.netPayable ?? 0)}</span></div>
      </div>
      ${mine.note ? `<p class="fine">Note: ${escapeHtml(mine.note)}</p>` : ''}
    </div>`;
}

function render(code, t) {
  const el = $('#result');
  const mine = getMyOrder(code);
  if (!t) {
    el.innerHTML = (mine
      ? `<div class="card track-result"><h2>${escapeHtml(code)}</h2><p class="muted">Status is not available right now. Check your internet connection, or call the shop.</p></div>`
      : `<div class="card track-result"><h2>Order not found</h2>
          <p class="muted">Check the code (it looks like BFW-K7Q2M). If you just booked, wait a moment and try again.</p></div>`)
      + savedOrderHtml(mine);
    return;
  }
  const s = customerStatus(t.status, t.fulfilment);
  const updated = t.updatedAt?.toDate?.();
  const wa = store ? waLink(store.whatsapp, `Hi Best FireWorks, I am asking about my order ${code}.`) : null;
  el.innerHTML = `<div class="card track-result">
      <div class="track-head"><h1>${escapeHtml(code)}</h1><span class="badge status-${escapeHtml(t.status)}">${escapeHtml(s.label)}</span></div>
      <p class="track-help">${escapeHtml(s.help)}</p>
      ${t.message ? `<p class="shop-msg"><strong>Message from the shop:</strong><br />${escapeHtml(t.message)}</p>` : ''}
      ${timelineHtml(t.status, t.fulfilment)}
      <div class="track-facts">
        <div><small>${t.fulfilment === 'delivery' ? 'To pay on delivery' : 'To pay at stall'}</small><strong>${formatRupees(t.netPayable)}</strong></div>
        <div><small>Boxes</small><strong>${t.itemCount}</strong></div>
        ${t.pickupDate ? `<div><small>Preferred date</small><strong>${formatDate(t.pickupDate)}</strong></div>` : ''}
        <div><small>Last update</small><strong>${updated ? formatDateTime(updated) : '—'}</strong></div>
      </div>
      <div class="track-actions">
        ${store ? `<a class="btn btn-primary" href="${store.directionsUrl}" ${extTarget}>📍 Directions to the stall</a>` : ''}
        ${wa ? `<a class="btn btn-wa" href="${wa}" ${extTarget}>💬 WhatsApp the shop</a>` : ''}
        ${store ? `<a class="btn btn-soft" href="${telLink(store.phones[0])}">📞 Call the shop</a>` : ''}
      </div>
      <p class="fine">This page refreshes on its own every 30 seconds.</p>
    </div>
    ${savedOrderHtml(mine)}`;
}

async function track(code, { quiet = false } = {}) {
  currentCode = code;
  if (!quiet) $('#result').innerHTML = '<p class="loading">Looking up your order…</p>';
  let t = null;
  try {
    t = await fetchTracking(code);
  } catch (err) {
    if (quiet) return scheduleRefresh(code);
  }
  if (code === currentCode) render(code, t);
  scheduleRefresh(code);
}

function scheduleRefresh(code) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => !document.hidden && track(code, { quiet: true }), REFRESH_MS);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentCode) track(currentCode, { quiet: true });
});

const codeBox = $('#track-form [data-code-input]');
codeBox.addEventListener('input', () => (codeBox.value = cleanCodeInput(codeBox.value)));
$('#track-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = normalizeOrderCode(codeBox.value);
  if (!code) {
    $('#result').innerHTML = '<div class="card track-result"><p>Type the 5 letters/numbers after <strong>BFW-</strong>, for example <strong>K7Q2M</strong>.</p></div>';
    return;
  }
  history.replaceState(null, '', `?code=${code}`);
  track(code);
});

loadPriceList()
  .then((d) => { store = d.store; })
  .catch(() => {})
  .finally(() => {
    const code = normalizeOrderCode(new URLSearchParams(location.search).get('code'));
    if (code) {
      codeBox.value = code.slice(4);
      track(code);
    }
  });
