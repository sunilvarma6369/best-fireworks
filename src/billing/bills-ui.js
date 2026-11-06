// Bills manager: every counter bill this login may see (admins: all phones; sales staff: their own), with search,
// filters and day totals; tap a bill for the full bill and corrections (cancel, fix payment or customer, re-bill).
// Opened from the Billing tab (📒 Bills) and from the Sales tab.
import { escapeHtml, telLink } from '../lib/catalog.js';
import { formatDate, formatPaise, formatRupees, toPaise, todayIST } from '../lib/money.js';
import { RANGES, rangeBounds } from '../lib/sales.js';
import { isAdminRole } from '../lib/staff.js';
import {
  canChange, editBill, findBill, ledgerBills, ledgerStatus, onLedger, restoreBill, retryLedger, voidBill, watchLedger,
} from './ledger.js';

const $ = (sel) => document.querySelector(sel);
const PAY = { upi: 'UPI', cash: 'Cash', card: 'Card' };
const REASONS = ['Wrong items', 'Customer returned', 'Payment failed', 'Duplicate bill', 'Test bill'];
const PAGE = 60;
const STATUS_FILTERS = { ok: 'Paid bills', void: 'Cancelled', pending: 'Not uploaded', all: 'All bills' };

const M = {
  ctx: null, // { getStaff, toast, whatsappUrl(bill), onRebill(items) }
  f: { range: 'today', person: 'all', pay: 'all', status: 'ok', q: '' },
  shown: PAGE,
  stop: null,
  unsub: null,
  open: null, // billNo shown in the detail dialog
};

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const personKey = (b) => b.cashierUid || b.cashierName || 'unknown';
const timeOf = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const whenOf = (ms) => (ms ? new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '');
const isAdmin = () => isAdminRole(M.ctx.getStaff()?.role);

function statusBadge(b) {
  if (b.status === 'void') return '<span class="badge bill-void">Cancelled</span>';
  if (b.pending) return '<span class="badge bill-pending">Not uploaded</span>';
  return '<span class="badge bill-ok">Paid</span>';
}

// ── List ────────────────────────────────────────────────
function filtered() {
  const q = squash(M.f.q);
  const { from, to } = rangeBounds(M.f.range, todayIST());
  return ledgerBills().filter((b) => {
    // A search looks through every date, so an old bill can be found by phone number.
    if (!q && ((from && b.day < from) || b.day > to)) return false;
    if (M.f.person !== 'all' && personKey(b) !== M.f.person) return false;
    if (M.f.pay !== 'all' && b.payment !== M.f.pay) return false;
    if (M.f.status === 'ok' && b.status === 'void') return false;
    if (M.f.status === 'void' && b.status !== 'void') return false;
    if (M.f.status === 'pending' && !b.pending) return false;
    return !q || squash(`${b.billNo}|${b.customer.name}|${b.customer.phone}`).includes(q);
  });
}

function frameHtml() {
  const people = new Map();
  for (const b of ledgerBills()) if (!people.has(personKey(b))) people.set(personKey(b), b.cashierName || 'Unknown');
  if (M.f.person !== 'all' && !people.has(M.f.person)) people.set(M.f.person, 'Selected person');
  return `<div class="d-head"><h2>${isAdmin() ? 'Bills' : 'My bills'}</h2>
      <button class="close" type="button" data-act="close" aria-label="Close">✕</button></div>
    <div class="d-body bm">
      <input type="search" id="bm-q" placeholder="Bill number, customer name or phone" autocomplete="off" value="${escapeHtml(M.f.q)}" />
      <div class="status-chips" id="bm-range" role="group" aria-label="Dates">
        ${Object.entries(RANGES).map(([k, v]) => `<button type="button" data-range="${k}" aria-pressed="${M.f.range === k}">${v}</button>`).join('')}
      </div>
      <div class="bm-selects">
        ${isAdmin() ? `<select id="bm-person" aria-label="Salesperson"><option value="all">Everyone</option>
          ${[...people].sort((a, b) => a[1].localeCompare(b[1])).map(([k, n]) => `<option value="${escapeHtml(k)}" ${M.f.person === k ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}
        </select>` : ''}
        <select id="bm-pay" aria-label="Payment"><option value="all">All payments</option>
          ${Object.entries(PAY).map(([k, v]) => `<option value="${k}" ${M.f.pay === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <select id="bm-status" aria-label="Status">
          ${Object.entries(STATUS_FILTERS).map(([k, v]) => `<option value="${k}" ${M.f.status === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
      <div id="bm-out"></div>
    </div>`;
}

function syncLine() {
  const { status, error } = ledgerStatus();
  if (status === 'syncing') return '<p class="bm-sync busy">Getting the latest bills…</p>';
  if (status === 'error') return `<p class="bm-sync bad">⚠ ${escapeHtml(error)} <button type="button" class="link" data-act="retry">Try again</button></p>`;
  if (!navigator.onLine) return '<p class="bm-sync bad">⚠ Offline. Showing the bills this phone already has.</p>';
  return `<p class="bm-sync">✓ Up to date${status === 'live' ? ' · new bills appear automatically' : ''}</p>`;
}

function renderOut() {
  const out = $('#bm-out');
  if (!out) return;
  const list = filtered();
  const counted = list.filter((b) => b.status !== 'void');
  const sum = (arr) => arr.reduce((s, b) => s + toPaise(b.totals?.paid ?? 0), 0);
  const byPay = Object.keys(PAY).map((k) => [k, sum(counted.filter((b) => b.payment === k))]);
  const days = new Map();
  for (const b of list.slice(0, M.shown)) {
    if (!days.has(b.day)) days.set(b.day, []);
    days.get(b.day).push(b);
  }
  const dayTotals = new Map();
  for (const b of counted) dayTotals.set(b.day, (dayTotals.get(b.day) ?? [0, 0]).map((v, i) => v + (i ? toPaise(b.totals?.paid ?? 0) : 1)));

  out.innerHTML = `${syncLine()}
    ${M.f.q ? '<p class="fine">Searching all dates.</p>' : ''}
    <div class="bm-sum">
      <div><strong>${formatPaise(sum(counted))}</strong><span>${plural(counted.length, 'bill')}${list.length > counted.length ? ` · ${list.length - counted.length} cancelled` : ''}</span></div>
      <div class="bm-pay">${byPay.map(([k, v]) => `<span>${PAY[k]} <b>${formatPaise(v)}</b></span>`).join('')}</div>
    </div>
    ${list.length ? [...days].map(([day, bills]) => {
      const [n, amt] = dayTotals.get(day) ?? [0, 0];
      return `<h4 class="bm-day">${formatDate(day)} <small>${plural(n, 'bill')} · ${formatPaise(amt)}</small></h4>
        ${bills.map((b) => `<button type="button" class="bm-row${b.status === 'void' ? ' is-void' : ''}" data-bill="${escapeHtml(b.billNo)}">
            <span class="bm-main"><strong>${escapeHtml(b.billNo)}</strong>
              <small>${timeOf(b.billedAt)} · ${escapeHtml(b.cashierName || '—')} · ${plural(b.totals?.itemCount ?? 0, 'box', 'boxes')} · ${PAY[b.payment] ?? b.payment}${b.customer.name ? ` · ${escapeHtml(b.customer.name)}` : b.customer.phone ? ` · ${escapeHtml(b.customer.phone)}` : ''}</small></span>
            <span class="bm-amt"><strong>${formatRupees(b.totals?.paid ?? 0)}</strong>${statusBadge(b)}</span>
          </button>`).join('')}`;
    }).join('') : `<p class="muted bm-empty">No bills ${M.f.q ? 'match your search' : `for ${RANGES[M.f.range].toLowerCase()}`}.</p>`}
    ${list.length > M.shown ? `<button type="button" class="btn btn-soft btn-block" data-act="more">Show ${Math.min(PAGE, list.length - M.shown)} more</button>` : ''}`;
}

function renderList(full = false) {
  const dlg = $('#bills-dialog');
  if (full || !dlg.querySelector('#bm-out')) dlg.innerHTML = frameHtml();
  renderOut();
}

export function openBillsManager(filter = {}) {
  M.f = { ...M.f, ...filter };
  M.shown = PAGE;
  renderList(true);
  const dlg = $('#bills-dialog');
  if (!dlg.open) dlg.showModal();
  M.stop ??= watchLedger();
  M.unsub ??= onLedger(() => {
    renderOut();
    if (M.open && $('#bill-dialog').open) renderDetail(M.open);
  });
}

// ── One bill ────────────────────────────────────────────
function itemsTable(b) {
  const t = b.totals ?? {};
  return `<table class="items">
      <thead><tr><th>Item</th><th class="num">Rate</th><th class="num">Qty</th><th class="num">Total</th></tr></thead>
      <tbody>${(b.items ?? []).map((i) => `<tr>
          <td>${escapeHtml(i.name)}<br /><small class="muted">${escapeHtml(i.brand ?? '')}${i.listNo ? ` · #${i.listNo}` : ''}</small></td>
          <td class="num">${formatRupees(i.finalPrice ?? 0)}</td><td class="num">${i.qty}</td><td class="num">${formatRupees(i.lineTotal ?? 0)}</td>
        </tr>`).join('')}</tbody>
      <tfoot>
        <tr><td colspan="3">Amount</td><td class="num">${formatRupees(t.amountTotal ?? 0)}</td></tr>
        <tr><td colspan="3">Discount</td><td class="num">−${formatRupees(t.discountTotal ?? 0)}</td></tr>
        ${t.bulkDiscount ? `<tr><td colspan="3">Bulk offer</td><td class="num">−${formatRupees(t.bulkDiscount)}</td></tr>` : ''}
        <tr><td colspan="3">Bill total</td><td class="num">${formatRupees(t.netPayable ?? 0)}</td></tr>
        ${t.adjustment ? `<tr><td colspan="3">Adjusted</td><td class="num">${t.adjustment < 0 ? '−' : '+'}${formatRupees(Math.abs(t.adjustment))}</td></tr>` : ''}
        <tr class="net"><td colspan="3">Paid (${PAY[b.payment] ?? b.payment})</td><td class="num">${formatRupees(t.paid ?? 0)}</td></tr>
      </tfoot>
    </table>`;
}

function renderDetail(billNo) {
  const b = findBill(billNo);
  const dlg = $('#bill-dialog');
  if (!b) {
    dlg.innerHTML = '<div class="d-head"><h2>Bill</h2><button class="close" type="button" data-act="close" aria-label="Close">✕</button></div><div class="d-body"><p class="muted">This bill is not on this phone.</p></div>';
    return;
  }
  const t = b.totals ?? {};
  const perm = canChange(b, M.ctx.getStaff());
  const voided = b.status === 'void';
  const admin = isAdmin();
  const notes = [
    voided ? `🚫 Cancelled${b.voidedByName ? ` by ${escapeHtml(b.voidedByName)}` : ''}${b.voidedAtMs ? ` · ${whenOf(b.voidedAtMs)}` : ''}${b.voidReason ? ` · “${escapeHtml(b.voidReason)}”` : ''}` : '',
    b.editedByName ? `✏️ Changed by ${escapeHtml(b.editedByName)}${b.editedAtMs ? ` · ${whenOf(b.editedAtMs)}` : ''}` : '',
    b.pending ? '⏳ Saved on this phone. It uploads by itself when the internet is back.' : '',
  ].filter(Boolean);

  dlg.innerHTML = `<div class="d-head"><h2>Bill ${escapeHtml(b.billNo)}</h2>
      <button class="close" type="button" data-act="close" aria-label="Close">✕</button></div>
    <div class="d-body">
      <div class="bd-hero${voided ? ' is-void' : ''}">
        <span>${statusBadge(b)}</span>
        <strong>${formatRupees(t.paid ?? 0)}</strong>
        <span>${PAY[b.payment] ?? b.payment} · ${plural(t.itemCount ?? 0, 'box', 'boxes')}${t.adjustment ? ` · adjusted ${t.adjustment < 0 ? '−' : '+'}${formatRupees(Math.abs(t.adjustment))}` : ''}</span>
      </div>
      <div class="d-cust">
        <span>🕒 ${new Date(b.billedAt).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })} · counter ${escapeHtml(b.device)}</span>
        <span>🧑‍💼 Billed by ${escapeHtml(b.cashierName || '—')}</span>
        ${b.customer.name || b.customer.phone ? `<span>👤 ${escapeHtml(b.customer.name || 'Customer')}${b.customer.phone ? ` · ${escapeHtml(b.customer.phone)}` : ''}</span>` : '<span class="muted">No customer details</span>'}
        <div class="d-row-btns">
          ${voided ? '' : `<a class="btn btn-sm btn-wa" href="${M.ctx.whatsappUrl(b)}" target="_blank" rel="noopener">💬 WhatsApp bill</a>`}
          ${b.customer.phone ? `<a class="btn btn-sm btn-soft" href="${telLink(`+91${b.customer.phone}`)}">📞 Call</a>` : ''}
        </div>
      </div>
      ${notes.map((n) => `<p class="${voided && n.startsWith('🚫') ? 'warn' : 'hint'}">${n}</p>`).join('')}
      ${itemsTable(b)}
      <div class="bd-actions">
        ${perm.ok && !voided ? `
          <button type="button" class="btn btn-soft" data-act="edit">✏️ Payment or customer</button>
          <button type="button" class="btn btn-soft" data-act="rebill">↺ Cancel &amp; re-bill</button>
          <button type="button" class="btn btn-danger" data-act="void">🚫 Cancel bill</button>` : ''}
        ${voided && admin ? '<button type="button" class="btn btn-soft" data-act="restore">↩ Restore bill</button>' : ''}
      </div>
      ${perm.ok && perm.minutesLeft && !voided ? `<p class="fine">You can change this bill for ${plural(perm.minutesLeft, 'more minute')}.</p>` : ''}
      ${!perm.ok && perm.why ? `<p class="fine">${escapeHtml(perm.why)}</p>` : ''}

      <form class="a-form bd-form" id="bd-edit" hidden>
        <fieldset class="bl-pay"><legend>Paid by</legend>
          ${Object.entries(PAY).map(([k, v]) => `<label><input type="radio" name="payment" value="${k}" ${b.payment === k ? 'checked' : ''} /> ${v}</label>`).join('')}
        </fieldset>
        <div class="two-col">
          <label>Customer name<input name="name" maxlength="60" value="${escapeHtml(b.customer.name)}" autocomplete="off" /></label>
          <label>Mobile<input name="phone" inputmode="numeric" maxlength="10" value="${escapeHtml(b.customer.phone)}" autocomplete="off" /></label>
        </div>
        <p class="a-error" id="bd-edit-error" hidden></p>
        <button type="submit" class="btn btn-primary">Save changes</button>
      </form>

      <form class="a-form bd-form" id="bd-void" hidden>
        <strong>Why is this bill cancelled?</strong>
        <div class="quick-off">${REASONS.map((r) => `<button type="button" class="btn btn-sm btn-soft" data-reason="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join('')}</div>
        <input name="reason" maxlength="120" placeholder="Reason" autocomplete="off" />
        <p class="fine">The bill stays in the list as cancelled and is left out of all totals. ${admin ? 'An admin can restore it.' : 'Only an admin can restore it.'}</p>
        <button type="submit" class="btn btn-danger">Cancel bill ${escapeHtml(b.billNo)}</button>
      </form>
    </div>`;
}

function openDetail(billNo) {
  M.open = billNo;
  renderDetail(billNo);
  const dlg = $('#bill-dialog');
  if (!dlg.open) dlg.showModal();
}

// ── Events ──────────────────────────────────────────────
async function act(promise, done) {
  try {
    await promise;
    M.ctx.toast(done);
    return true;
  } catch (err) {
    console.error(err);
    M.ctx.toast(err?.code === 'permission-denied' ? 'Not allowed. Ask an admin.' : `Could not save: ${err.message}`);
    return false;
  }
}

export function setupBillsManager(ctx) {
  M.ctx = ctx;
  const list = $('#bills-dialog');
  const detail = $('#bill-dialog');

  list.addEventListener('click', (e) => {
    if (e.target === list || e.target.closest('[data-act="close"]')) return list.close();
    const r = e.target.closest('[data-range]');
    if (r) {
      M.f.range = r.dataset.range;
      M.shown = PAGE;
      list.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b === r)));
      return renderOut();
    }
    if (e.target.closest('[data-act="more"]')) {
      M.shown += PAGE;
      return renderOut();
    }
    if (e.target.closest('[data-act="retry"]')) return retryLedger();
    const row = e.target.closest('[data-bill]');
    if (row) openDetail(row.dataset.bill);
  });
  list.addEventListener('input', (e) => {
    if (e.target.id !== 'bm-q') return;
    M.f.q = e.target.value.trim();
    M.shown = PAGE;
    renderOut();
  });
  list.addEventListener('change', (e) => {
    const key = { 'bm-person': 'person', 'bm-pay': 'pay', 'bm-status': 'status' }[e.target.id];
    if (!key) return;
    M.f[key] = e.target.value;
    M.shown = PAGE;
    renderOut();
  });
  list.addEventListener('close', () => {
    M.stop?.();
    M.stop = null;
    M.unsub?.();
    M.unsub = null;
  });

  detail.addEventListener('click', async (e) => {
    if (e.target === detail || e.target.closest('[data-act="close"]')) return detail.close();
    const b = findBill(M.open);
    if (!b) return;
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'edit' || a === 'void') {
      const show = $(a === 'edit' ? '#bd-edit' : '#bd-void');
      $('#bd-edit').hidden = a !== 'edit' || !show.hidden;
      $('#bd-void').hidden = a !== 'void' || !show.hidden;
      if (!show.hidden) show.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const reason = e.target.closest('[data-reason]');
    if (reason) {
      $('#bd-void').reason.value = reason.dataset.reason;
      return;
    }
    if (a === 'restore') {
      if (!confirm(`Restore bill ${b.billNo}? It will count in the totals again.`)) return;
      return act(restoreBill(b.billNo), `Bill ${b.billNo} restored`);
    }
    if (a === 'rebill') {
      if (!confirm(`Cancel bill ${b.billNo} and copy its items into a new bill? Then change the items and check out again.`)) return;
      if (await act(voidBill(b.billNo, 'Re-billed'), `Bill ${b.billNo} cancelled. Fix the new bill and check out.`)) {
        detail.close();
        list.close();
        M.ctx.onRebill(b.items);
      }
    }
  });
  detail.addEventListener('input', (e) => {
    if (e.target.name === 'phone') e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10);
  });
  detail.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const b = findBill(M.open);
    if (!b) return;
    if (f.id === 'bd-edit') {
      const phone = f.phone.value.trim();
      const err = $('#bd-edit-error');
      if (phone && !/^[6-9]\d{9}$/.test(phone)) {
        err.textContent = 'Enter a valid 10-digit mobile number, or leave it empty.';
        err.hidden = false;
        return;
      }
      await act(editBill(b.billNo, { payment: f.payment.value, customer: { name: f.name.value, phone } }), `Bill ${b.billNo} updated`);
    }
    if (f.id === 'bd-void') {
      const reason = f.reason.value.trim();
      if (!reason) {
        f.reason.focus();
        return M.ctx.toast('Pick or type a reason first.');
      }
      if (await act(voidBill(b.billNo, reason), `Bill ${b.billNo} cancelled`)) renderDetail(b.billNo);
    }
  });
  detail.addEventListener('close', () => {
    M.open = null;
  });
  window.addEventListener('online', () => {
    retryLedger();
    if (list.open) renderOut();
  });
}

