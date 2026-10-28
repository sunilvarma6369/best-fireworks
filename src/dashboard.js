// Renders the admin "Sales" tab from computeSales() output. Plain HTML bars: one series each, so no legend;
// every bar is labelled with its name and value, and has a hover/focus tooltip.
import { escapeHtml } from './lib/catalog.js';
import { formatDate, formatPaise } from './lib/money.js';
import { BASES, RANGES } from './lib/sales.js';
import { STATUS } from './lib/status.js';

const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

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

export function renderDashboard(el, s, { range, basis, itemSort }) {
  if (!s.orders && !Object.values(s.statusCounts).some(Boolean)) {
    el.innerHTML = `<p class="muted dash-empty">No orders ${range === 'all' ? 'yet' : `for ${RANGES[range].toLowerCase()}`}. Sales show here as customers book.</p>`;
    return;
  }
  const basisNote = basis === 'completed' ? 'completed orders' : 'all orders except cancelled';
  const topItems = [...s.items].sort((a, b) => (itemSort === 'revenue' ? b.revenue - a.revenue : b.boxes - a.boxes)).slice(0, 10);
  const best = s.days.reduce((a, b) => (b.revenue > a.revenue ? b : a), s.days[0] ?? { revenue: 0 });
  const busiest = s.hours.indexOf(Math.max(...s.hours));
  const hourName = (h) => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;

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

    <section class="dash-card">
      <h3>Sales by category</h3>
      ${s.categories.length ? hbars(s.categories, {
        value: (c) => c.revenue,
        label: (c) => c.name,
        detail: (c) => `${formatPaise(c.revenue)} · ${plural(c.boxes, 'box', 'boxes')}`,
      }) : '<p class="muted">No items in this view.</p>'}
    </section>

    <section class="dash-card">
      <div class="dash-head">
        <h3>Best-selling items</h3>
        <div class="status-chips" id="item-sort">
          <button type="button" data-sort="boxes" aria-pressed="${itemSort !== 'revenue'}">By boxes</button>
          <button type="button" data-sort="revenue" aria-pressed="${itemSort === 'revenue'}">By ₹</button>
        </div>
      </div>
      ${topItems.length ? hbars(topItems, {
        value: (i) => (itemSort === 'revenue' ? i.revenue : i.boxes),
        label: (i) => `${i.name}${i.brand ? ` (${i.brand})` : ''}`,
        detail: (i) => (itemSort === 'revenue'
          ? `${formatPaise(i.revenue)} · ${plural(i.boxes, 'box', 'boxes')}`
          : `${plural(i.boxes, 'box', 'boxes')} · ${formatPaise(i.revenue)}`),
      }) : '<p class="muted">No items in this view.</p>'}
      <button type="button" class="btn btn-sm btn-soft" id="item-csv">⬇ All item sales (CSV)</button>
    </section>

    <div class="dash-grid">
      <section class="dash-card">
        <h3>Daily sales</h3>
        ${vbars(s.days, {
          value: (d) => d.revenue,
          label: (d) => formatDate(d.date).replace(/^\w+, /, ''),
          tip: (d) => `${formatDate(d.date)}: ${formatPaise(d.revenue)} · ${plural(d.orders, 'order')}`,
          labelEvery: s.days.length > 10 ? 3 : 1,
        })}
        ${best?.revenue ? `<p class="fine">Best day: ${formatDate(best.date)} · ${formatPaise(best.revenue)}</p>` : ''}
      </section>
      <section class="dash-card">
        <h3>Busiest booking hours</h3>
        ${vbars(s.hours.map((n, h) => ({ h, n })), {
          value: (c) => c.n,
          label: (c) => hourName(c.h),
          tip: (c) => `${hourName(c.h)}–${hourName((c.h + 1) % 24)}: ${plural(c.n, 'order')}`,
          labelEvery: 6,
        })}
        ${s.orders ? `<p class="fine">Most bookings around ${hourName(busiest)}.</p>` : ''}
      </section>
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

export function itemSalesCsv(items) {
  const rows = [['Item', 'Brand', 'Category', 'Boxes', 'Orders', 'Sales (Rs, before bulk discount)']];
  for (const i of [...items].sort((a, b) => b.boxes - a.boxes)) {
    rows.push([i.name, i.brand, i.category, i.boxes, i.orders, (i.revenue / 100).toFixed(2)]);
  }
  return rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
}
