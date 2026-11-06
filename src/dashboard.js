// Renders the "Sales" tab. Plain HTML bars: one series each, so no legend; every bar is labelled with its name
// and value, and has a hover/focus tooltip.
//   All sales  counter bills + online bookings      Counter  counter bills only, by salesperson
//   Online     online bookings (the original view)  Mine     a salesperson's own counter sales
import { escapeHtml } from './lib/catalog.js';
import { formatDate, formatPaise } from './lib/money.js';
import { BASES, buildDaySeries, mergeTotals, RANGES } from './lib/sales.js';
import { STATUS } from './lib/status.js';

export const CHANNELS = { all: 'All sales', counter: '🧾 Counter', online: '🌐 Online' };
const PAY = { upi: 'UPI', cash: 'Cash', card: 'Card' };

const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
const hourName = (h) => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;

function tile(label, value, sub = '') {
  return `<div class="kpi"><small>${label}</small><strong>${value}</strong>${sub ? `<span>${sub}</span>` : ''}</div>`;
}

function hbars(rows, { value, label, detail }) {
  const max = Math.max(1, ...rows.map(value));
  return `<ol class="hbars">${rows.map((r) => {
    const tip = `${label(r)}: ${detail(r)}`;
    return `<li class="hbar" tabindex="0" data-tip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">
        <span class="hbar-label">${escapeHtml(label(r))}</span>
        <span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(2, (value(r) / max) * 100)}%"></span></span>
        <span class="hbar-val">${detail(r)}</span>
      </li>`;
  }).join('')}</ol>`;
}

function vbars(cols, { value, label, tip, labelEvery = 1 }) {
  const max = Math.max(1, ...cols.map(value));
  return `<div class="vbars" role="list">${cols.map((c, i) => {
    const t = tip(c);
    return `<div class="vcol" role="listitem" tabindex="0" data-tip="${escapeHtml(t)}" aria-label="${escapeHtml(t)}">
        <span class="vbar-wrap"><span class="vbar" style="height:${value(c) ? Math.max(3, (value(c) / max) * 100) : 0}%"></span></span>
        <span class="vlabel">${i % labelEvery === 0 ? escapeHtml(label(c)) : ''}</span>
      </div>`;
  }).join('')}</div>`;
}

function split(title, parts) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return `<div class="split"><h4>${title}</h4>${parts.map((p) => `<div class="split-row">
      <span>${p.label}</span><span class="split-track"><span style="width:${pct(p.value, total)}%"></span></span>
      <strong>${p.text ?? p.value} <small>${pct(p.value, total)}%</small></strong></div>`).join('')}</div>`;
}

export function renderChips(el, options, current, attr) {
  el.innerHTML = Object.entries(options)
    .map(([id, label]) => `<button type="button" data-${attr}="${id}" aria-pressed="${current === id}">${label}</button>`)
    .join('');
}

// ── Shared sections ─────────────────────────────────────
function itemsSection(items, itemSort, { csv = true } = {}) {
  const top = [...items].sort((a, b) => (itemSort === 'revenue' ? b.revenue - a.revenue : b.boxes - a.boxes)).slice(0, 10);
  return `<section class="dash-card">
      <div class="dash-head">
        <h3>Best-selling items</h3>
        <div class="status-chips" id="item-sort">
          <button type="button" data-sort="boxes" aria-pressed="${itemSort !== 'revenue'}">By boxes</button>
          <button type="button" data-sort="revenue" aria-pressed="${itemSort === 'revenue'}">By ₹</button>
        </div>
      </div>
      ${top.length ? hbars(top, {
        value: (i) => (itemSort === 'revenue' ? i.revenue : i.boxes),
        label: (i) => `${i.name}${i.brand ? ` (${i.brand})` : ''}`,
        detail: (i) => (itemSort === 'revenue'
          ? `${formatPaise(i.revenue)} · ${plural(i.boxes, 'box', 'boxes')}`
          : `${plural(i.boxes, 'box', 'boxes')} · ${formatPaise(i.revenue)}`),
      }) : '<p class="muted">No items in this view.</p>'}
      ${csv ? '<button type="button" class="btn btn-sm btn-soft" id="item-csv">⬇ All item sales (CSV)</button>' : ''}
    </section>`;
}

function categoriesSection(categories) {
  return `<section class="dash-card">
      <h3>Sales by category</h3>
      ${categories.length ? hbars(categories, {
        value: (c) => c.revenue,
        label: (c) => c.name,
        detail: (c) => `${formatPaise(c.revenue)} · ${plural(c.boxes, 'box', 'boxes')}`,
      }) : '<p class="muted">No items in this view.</p>'}
    </section>`;
}

function dailySection(days, { counted = 'order', split: showSplit = false } = {}) {
  if (days.length < 2) return ''; // one day: the hours chart says more
  const best = days.reduce((a, b) => (b.revenue > a.revenue ? b : a), days[0] ?? { revenue: 0 });
  return `<section class="dash-card">
      <h3>Daily sales</h3>
      ${vbars(days, {
        value: (d) => d.revenue,
        label: (d) => formatDate(d.date).replace(/^\w+, /, ''),
        tip: (d) => `${formatDate(d.date)}: ${formatPaise(d.revenue)}${showSplit
          ? ` (counter ${formatPaise(d.counter)}, online ${formatPaise(d.online)})`
          : ` · ${plural(d.orders, counted)}`}`,
        labelEvery: days.length > 10 ? 3 : 1,
      })}
      ${best?.revenue ? `<p class="fine">Best day: ${formatDate(best.date)} · ${formatPaise(best.revenue)}</p>` : ''}
    </section>`;
}

function hoursSection(hours, { title = 'Busiest hours', counted = 'sale' } = {}) {
  const total = hours.reduce((s, n) => s + n, 0);
  const busiest = hours.indexOf(Math.max(...hours));
  return `<section class="dash-card">
      <h3>${title}</h3>
      ${vbars(hours.map((n, h) => ({ h, n })), {
        value: (c) => c.n,
        label: (c) => hourName(c.h),
        tip: (c) => `${hourName(c.h)}–${hourName((c.h + 1) % 24)}: ${plural(c.n, counted)}`,
        labelEvery: 6,
      })}
      ${total ? `<p class="fine">Busiest around ${hourName(busiest)}.</p>` : ''}
    </section>`;
}

const payParts = (c) => Object.entries(PAY).map(([k, label]) => ({
  label: { upi: '📱 UPI', cash: '💵 Cash', card: '💳 Card' }[k] ?? label,
  value: c.pay[k].amount,
  text: `${formatPaise(c.pay[k].amount)} · ${c.pay[k].bills}`,
}));

function peopleSection(c, { online = null } = {}) {
  if (!c.people.length && !online) return '';
  const max = Math.max(1, ...c.people.map((p) => p.collected), online?.revenue ?? 0);
  const bar = (v) => `<span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(2, (v / max) * 100)}%"></span></span>`;
  return `<section class="dash-card">
      <div class="dash-head"><h3>By salesperson</h3><button type="button" class="link" data-act="bills">See all bills →</button></div>
      <div class="people">
        ${c.people.map((p) => `<button type="button" class="person" data-person="${escapeHtml(p.key)}" aria-label="${escapeHtml(`${p.name}: ${formatPaise(p.collected)}, open their bills`)}">
            <span class="person-top"><strong>${escapeHtml(p.name)}</strong><span>${formatPaise(p.collected)}</span></span>
            ${bar(p.collected)}
            <small>${plural(p.bills, 'bill')} · UPI ${formatPaise(p.upi)} · Cash ${formatPaise(p.cash)} · Card ${formatPaise(p.card)}${p.voids ? ` · <span class="warn-text">${p.voids} cancelled</span>` : ''}</small>
          </button>`).join('')}
        ${online ? `<div class="person online">
            <span class="person-top"><strong>🌐 Online bookings</strong><span>${formatPaise(online.revenue)}</span></span>
            ${bar(online.revenue)}
            <small>${plural(online.orders, 'order')} · customers booked themselves</small>
          </div>` : ''}
      </div>
    </section>`;
}

function actionsRow({ csv = true, report = true, mine = false } = {}) {
  return `<div class="dash-actions">
      <button type="button" class="btn btn-sm btn-primary" data-act="bills">📒 ${mine ? 'My bills' : 'All bills'}</button>
      ${csv ? '<button type="button" class="btn btn-sm btn-soft" data-act="bills-csv">⬇ Bills (CSV)</button>' : ''}
      ${report ? `<button type="button" class="btn btn-sm btn-soft" data-act="report">💬 Share ${mine ? 'my day' : 'report'}</button>` : ''}
    </div>`;
}

const emptyNote = (range, what) =>
  `<p class="muted dash-empty">No ${what} ${range === 'all' ? 'yet' : `for ${RANGES[range].toLowerCase()}`}.</p>`;

// ── Views ───────────────────────────────────────────────
/** Counter bills + online bookings. */
export function renderAllSales(el, { c, o, range, basis, itemSort }) {
  if (!c.bills && !c.voids.bills && !o.orders && !Object.values(o.statusCounts).some(Boolean)) {
    el.innerHTML = emptyNote(range, 'sales') + actionsRow({ csv: false, report: false });
    return;
  }
  const total = c.collected + o.revenue;
  const discounts = c.itemDiscount + c.bulkDiscount + c.adjustDown + o.savings + o.bulkDiscount;
  const hours = c.hours.map((n, i) => n + o.hours[i]);
  el.innerHTML = `
    <div class="kpis">
      ${tile('Total sales', formatPaise(total), `counter ${formatPaise(c.collected)} + online ${formatPaise(o.revenue)}`)}
      ${tile('🧾 Counter billing', formatPaise(c.collected), `${plural(c.bills, 'bill')} · average ${formatPaise(c.avgBill)}`)}
      ${tile('🌐 Online bookings', formatPaise(o.revenue), `${plural(o.orders, 'order')} ${basis === 'completed' ? 'completed' : 'booked'}`)}
      ${tile('Boxes sold', (c.boxes + o.boxes).toLocaleString('en-IN'), `${c.boxes.toLocaleString('en-IN')} at the counter · ${o.boxes.toLocaleString('en-IN')} online`)}
      ${tile('Discounts given', formatPaise(discounts), `includes ${formatPaise(c.adjustDown)} counter adjustments`)}
      ${tile('Online still to collect', formatPaise(o.toCollect), 'orders not completed yet')}
    </div>
    <p class="fine dash-note">${RANGES[range]} · online counts ${basis === 'completed' ? 'completed orders' : 'all orders except cancelled'} · cancelled bills are left out${c.pending ? ` · ${plural(c.pending, 'bill')} not uploaded yet` : ''}.</p>
    <section class="dash-card dash-splits">
      ${split('Where sales came from', [
        { label: '🧾 Counter', value: c.collected, text: formatPaise(c.collected) },
        { label: '🌐 Online', value: o.revenue, text: formatPaise(o.revenue) },
      ])}
      ${split('Counter payments', payParts(c))}
    </section>
    ${peopleSection(c, { online: o })}
    ${actionsRow()}
    <div class="dash-grid">
      ${dailySection(buildDaySeries([c.dayMap, o.dayMap], { from: c.from, to: c.to }), { split: true })}
      ${hoursSection(hours)}
    </div>
    ${itemsSection(mergeTotals(c.items, o.items), itemSort)}
    ${categoriesSection(mergeTotals(c.categories, o.categories))}`;
}

/** Counter bills only. `mine` = a salesperson looking at their own sales. */
export function renderCounterSales(el, { c, range, itemSort, mine = false }) {
  if (!c.bills && !c.voids.bills) {
    el.innerHTML = emptyNote(range, mine ? 'bills by you' : 'counter bills') + actionsRow({ csv: false, report: false, mine });
    return;
  }
  const kpis = mine
    ? `${tile('My sales', formatPaise(c.collected), plural(c.bills, 'bill'))}
       ${tile('Cash to hand over', formatPaise(c.pay.cash.amount), plural(c.pay.cash.bills, 'cash bill'))}
       ${tile('UPI', formatPaise(c.pay.upi.amount), plural(c.pay.upi.bills, 'bill'))}
       ${tile('Card', formatPaise(c.pay.card.amount), plural(c.pay.card.bills, 'bill'))}
       ${tile('Average bill', formatPaise(c.avgBill), `${plural(c.boxes, 'box', 'boxes')} sold`)}
       ${tile('Cancelled', plural(c.voids.bills, 'bill'), c.voids.bills ? `worth ${formatPaise(c.voids.amount)}` : 'none')}`
    : `${tile('Collected at the counter', formatPaise(c.collected), plural(c.bills, 'bill'))}
       ${tile('Average bill', formatPaise(c.avgBill), `${plural(c.customers, 'customer')} gave a phone number`)}
       ${tile('Boxes sold', c.boxes.toLocaleString('en-IN'), `${c.items.length} different items`)}
       ${tile('Item and bulk discounts', formatPaise(c.itemDiscount + c.bulkDiscount), 'from the price list')}
       ${tile('Counter adjustments', `−${formatPaise(c.adjustDown)}`, c.adjustUp ? `and +${formatPaise(c.adjustUp)} rounded up` : 'given off the bill total')}
       ${tile('Cancelled bills', plural(c.voids.bills, 'bill'), c.voids.bills ? `worth ${formatPaise(c.voids.amount)}` : 'none')}`;
  el.innerHTML = `
    <div class="kpis">${kpis}</div>
    <p class="fine dash-note">${RANGES[range]} · cancelled bills are left out${c.pending ? ` · ${plural(c.pending, 'bill')} not uploaded yet` : ''}.</p>
    ${mine ? '' : `<section class="dash-card dash-splits">${split('Payments', payParts(c))}</section>`}
    ${mine ? '' : peopleSection(c)}
    ${actionsRow({ csv: !mine, mine })}
    <div class="dash-grid">
      ${dailySection(c.days, { counted: 'bill' })}
      ${hoursSection(c.hours, { counted: 'bill' })}
    </div>
    ${itemsSection(c.items, itemSort, { csv: !mine })}
    ${mine ? '' : categoriesSection(c.categories)}`;
}

/** Online bookings only (the original dashboard). */
export function renderDashboard(el, s, { range, basis, itemSort }) {
  if (!s.orders && !Object.values(s.statusCounts).some(Boolean)) {
    el.innerHTML = `<p class="muted dash-empty">No orders ${range === 'all' ? 'yet' : `for ${RANGES[range].toLowerCase()}`}. Sales show here as customers book.</p>`;
    return;
  }
  const basisNote = basis === 'completed' ? 'completed orders' : 'all orders except cancelled';

  el.innerHTML = `
    <div class="kpis">
      ${tile(basis === 'completed' ? 'Revenue collected' : 'Sales booked', formatPaise(s.revenue), plural(s.orders, 'order'))}
      ${tile('Average order', formatPaise(s.avgOrder), plural(s.customers, 'customer'))}
      ${tile('Boxes sold', s.boxes.toLocaleString('en-IN'), `${s.items.length} different items`)}
      ${tile('Still to collect', formatPaise(s.toCollect), 'new, confirmed and ready orders')}
      ${tile('Collected', formatPaise(s.collected), plural(s.statusCounts.completed, 'completed order'))}
      ${tile('Bulk 10% given', formatPaise(s.bulkDiscount), `customers also saved ${formatPaise(s.savings)} in item discounts`)}
    </div>
    <p class="fine dash-note">${RANGES[range]} · counting ${basisNote}. Category and item totals are before the 10% bulk discount.</p>

    ${categoriesSection(s.categories)}
    ${itemsSection(s.items, itemSort)}

    <div class="dash-grid">
      ${dailySection(s.days)}
      ${hoursSection(s.hours, { title: 'Busiest booking hours', counted: 'order' })}
    </div>

    <section class="dash-card">
      <h3>Orders by status <small class="muted">(${RANGES[range].toLowerCase()})</small></h3>
      <div class="status-grid">${Object.entries(s.statusCounts).map(([k, n]) =>
        `<div><span class="badge status-${k}">${STATUS[k]?.admin ?? k}</span><strong>${n}</strong></div>`).join('')}</div>
      ${s.statusCounts.cancelled ? `<p class="fine">Cancelled orders were worth ${formatPaise(s.cancelledValue)}.</p>` : ''}
    </section>

    <section class="dash-card dash-splits">
      ${split('Pickup or delivery', [
        { label: '🏪 Pickup', value: s.fulfilment.pickup },
        { label: '🚚 Delivery', value: s.fulfilment.delivery },
      ])}
      ${split('Booked from', [
        { label: '🌐 Website', value: s.source.web },
        { label: '📱 Android app', value: s.source.android },
      ])}
      ${split('Sales by section', [
        { label: 'Other Brands', value: s.sections.others, text: formatPaise(s.sections.others) },
        { label: 'Standard', value: s.sections.standard, text: formatPaise(s.sections.standard) },
      ])}
    </section>`;
}

// ── Exports and sharing ─────────────────────────────────
const csvText = (rows) => rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');

export function itemSalesCsv(items) {
  const rows = [['Item', 'Brand', 'Category', 'Boxes', 'Orders / bills', 'Sales (Rs, before bulk discount)']];
  for (const i of [...items].sort((a, b) => b.boxes - a.boxes)) {
    rows.push([i.name, i.brand, i.category, i.boxes, i.orders, (i.revenue / 100).toFixed(2)]);
  }
  return csvText(rows);
}

export function billsCsv(bills) {
  const rows = [['Bill', 'Date', 'Time', 'Salesperson', 'Counter', 'Customer', 'Phone', 'Payment', 'Boxes', 'Bill total',
    'Adjustment', 'Paid', 'Status', 'Cancel reason', 'Items']];
  for (const b of bills) {
    const t = b.totals ?? {};
    rows.push([
      b.billNo, b.day, new Date(b.billedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
      b.cashierName, b.device, b.customer?.name, b.customer?.phone, PAY[b.payment] ?? b.payment, t.itemCount, t.netPayable,
      t.adjustment, t.paid, b.status === 'void' ? 'Cancelled' : b.pending ? 'Not uploaded yet' : 'Paid', b.voidReason,
      (b.items ?? []).map((i) => `${i.name}${i.brand ? ` (${i.brand})` : ''} x${i.qty}`).join('; '),
    ]);
  }
  return csvText(rows);
}

/** WhatsApp text for the owner (or a salesperson's own day). */
export function salesReportText({ c, o = null, range, today, mine = false, name = '' }) {
  const label = range === 'today' ? `Today (${formatDate(today)})` : range === 'yesterday' ? 'Yesterday' : RANGES[range];
  const lines = [
    `*Best FireWorks · ${mine ? `Sales by ${name}` : 'Sales report'}* 🎆`,
    label,
    '',
    `${mine ? 'My counter sales' : 'Counter billing'}: *${formatPaise(c.collected)}* (${plural(c.bills, 'bill')})`,
    `  UPI ${formatPaise(c.pay.upi.amount)} · Cash ${formatPaise(c.pay.cash.amount)} · Card ${formatPaise(c.pay.card.amount)}`,
  ];
  if (o) {
    lines.push(`Online bookings: *${formatPaise(o.revenue)}* (${plural(o.orders, 'order')}), ${formatPaise(o.collected)} collected`);
    lines.push('', `*Total: ${formatPaise(c.collected + o.revenue)}*`);
  }
  if (!mine && c.people.length) {
    lines.push('', 'By salesperson:');
    for (const p of c.people.filter((x) => x.bills)) lines.push(`• ${p.name}: ${formatPaise(p.collected)} (${plural(p.bills, 'bill')})`);
  }
  if (c.adjustDown) lines.push('', `Counter adjustments given: ${formatPaise(c.adjustDown)}`);
  if (c.voids.bills) lines.push(`Cancelled bills: ${c.voids.bills} (${formatPaise(c.voids.amount)})`);
  return lines.join('\n');
}
