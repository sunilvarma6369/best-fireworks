// Sales numbers for the admin dashboard: online bookings (computeSales, from the orders the admin page has loaded)
// and counter bills (computeCounter, from the bills ledger). All money is in paise.
import { toPaise } from './money.js';

const istDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
const istHour = (d) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(d));

export function shiftDate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export const RANGES = { today: 'Today', yesterday: 'Yesterday', week: 'Last 7 days', all: 'Whole season' };
export const BASES = { booked: 'All booked', completed: 'Completed only' };
const MAX_DAYS = 21;

/** First and last day (YYYY-MM-DD, India time) of a range; from = null means since the start. */
export function rangeBounds(range, today) {
  const from = { today, yesterday: shiftDate(today, -1), week: shiftDate(today, -6) }[range] ?? null;
  const to = range === 'yesterday' ? shiftDate(today, -1) : today;
  return { from, to };
}

/**
 * Every day of the range (or the latest MAX_DAYS of the season), zeros included, from one or more day maps
 * (Map date → { revenue, orders }). With two maps, the first is counter sales and the second online sales.
 */
export function buildDaySeries(dayMaps, { from, to }) {
  const keys = dayMaps.flatMap((m) => [...m.keys()]).sort();
  const start = from ?? (keys[0] && keys[0] > shiftDate(to, -(MAX_DAYS - 1)) ? keys[0] : shiftDate(to, -(MAX_DAYS - 1)));
  const out = [];
  for (let d = start; d <= to; d = shiftDate(d, 1)) {
    const row = { date: d, revenue: 0, orders: 0, counter: 0, online: 0 };
    dayMaps.forEach((m, i) => {
      const v = m.get(d);
      if (!v) return;
      row.revenue += v.revenue;
      row.orders += v.orders;
      row[i === 0 ? 'counter' : 'online'] += v.revenue;
    });
    out.push(row);
  }
  return out;
}

/**
 * @param {object[]} orders    Firestore order documents
 * @param {object} opts
 * @param {'today'|'yesterday'|'week'|'all'} opts.range
 * @param {'booked'|'completed'} opts.basis  booked = everything except cancelled
 * @param {(item) => {id: string, name: string, section: string}} opts.categoryOf
 * @param {string} opts.today  YYYY-MM-DD (India time)
 */
export function computeSales(orders, { range = 'all', basis = 'booked', categoryOf, today }) {
  const { from, to } = rangeBounds(range, today);
  const inRange = orders.filter((o) => {
    const d = o.createdAt?.toDate?.();
    if (!d) return false;
    const day = istDate(d);
    return (!from || day >= from) && day <= to;
  });

  const statusCounts = { new: 0, confirmed: 0, ready: 0, completed: 0, cancelled: 0 };
  let toCollect = 0, collected = 0, cancelledValue = 0;
  for (const o of inRange) {
    statusCounts[o.status] = (statusCounts[o.status] ?? 0) + 1;
    const net = toPaise(o.totals?.netPayable ?? 0);
    if (o.status === 'completed') collected += net;
    else if (o.status === 'cancelled') cancelledValue += net;
    else toCollect += net;
  }

  const counted = inRange.filter((o) => (basis === 'completed' ? o.status === 'completed' : o.status !== 'cancelled'));
  const categories = new Map();
  const items = new Map();
  const days = new Map();
  const hours = Array(24).fill(0);
  const fulfilment = { pickup: 0, delivery: 0 };
  const source = { web: 0, android: 0 };
  const sections = { others: 0, standard: 0 };
  const customers = new Set();
  let revenue = 0, boxes = 0, bulkDiscount = 0, savings = 0;

  for (const o of counted) {
    const created = o.createdAt.toDate();
    const net = toPaise(o.totals?.netPayable ?? 0);
    revenue += net;
    boxes += o.totals?.itemCount ?? 0;
    bulkDiscount += toPaise(o.totals?.bulkDiscount ?? 0);
    savings += toPaise(o.totals?.discountTotal ?? 0);
    fulfilment[o.fulfilment === 'delivery' ? 'delivery' : 'pickup']++;
    source[o.source === 'android' ? 'android' : 'web']++;
    hours[istHour(created)]++;
    if (o.customer?.phone) customers.add(o.customer.phone);
    const day = istDate(created);
    const dayRow = days.get(day) ?? { date: day, revenue: 0, orders: 0 };
    dayRow.revenue += net;
    dayRow.orders++;
    days.set(day, dayRow);

    for (const it of o.items ?? []) {
      const line = toPaise(it.lineTotal ?? 0);
      const cat = categoryOf(it);
      const c = categories.get(cat.id) ?? { id: cat.id, name: cat.name, revenue: 0, boxes: 0 };
      c.revenue += line;
      c.boxes += it.qty;
      categories.set(cat.id, c);
      const i = items.get(it.id) ?? { id: it.id, name: it.name, brand: it.brand, category: cat.name, revenue: 0, boxes: 0, orders: 0 };
      i.revenue += line;
      i.boxes += it.qty;
      i.orders++;
      items.set(it.id, i);
      sections[cat.section === 'standard' ? 'standard' : 'others'] += line;
    }
  }

  return {
    orders: counted.length,
    revenue,
    avgOrder: counted.length ? Math.round(revenue / counted.length) : 0,
    boxes,
    bulkDiscount,
    savings,
    customers: customers.size,
    toCollect,
    collected,
    cancelledValue,
    statusCounts,
    categories: [...categories.values()].sort((a, b) => b.revenue - a.revenue),
    items: [...items.values()],
    // Every day in the range (or the most recent MAX_DAYS for the whole season), zeros included.
    days: buildDaySeries([days], { from, to }).map(({ date, revenue: r, orders: n }) => ({ date, revenue: r, orders: n })),
    dayMap: days,
    hours,
    fulfilment,
    source,
    sections,
    from,
    to,
  };
}

const PAY_MODES = ['upi', 'cash', 'card'];

/**
 * Counter bills (see billing/ledger.js) for one range. Cancelled bills are left out of every total and counted
 * separately. Bill amounts are stored in rupees; everything returned is in paise.
 */
export function computeCounter(bills, { range = 'all', categoryOf, today }) {
  const { from, to } = rangeBounds(range, today);
  const inRange = bills.filter((b) => (!from || b.day >= from) && b.day <= to);
  const paid = inRange.filter((b) => b.status !== 'void');
  const voided = inRange.filter((b) => b.status === 'void');

  const pay = Object.fromEntries(PAY_MODES.map((k) => [k, { bills: 0, amount: 0 }]));
  const people = new Map();
  const person = (b) => {
    const key = b.cashierUid || b.cashierName || 'unknown';
    if (!people.has(key)) {
      people.set(key, {
        key, uid: b.cashierUid, name: b.cashierName || 'Unknown', bills: 0, collected: 0, boxes: 0, voids: 0, voidValue: 0,
        upi: 0, cash: 0, card: 0,
      });
    }
    return people.get(key);
  };
  const items = new Map();
  const categories = new Map();
  const days = new Map();
  const hours = Array(24).fill(0);
  const customers = new Set();
  const sections = { others: 0, standard: 0 };
  let collected = 0, boxes = 0, itemDiscount = 0, bulkDiscount = 0, adjustDown = 0, adjustUp = 0, pending = 0;

  for (const b of paid) {
    const t = b.totals ?? {};
    const amt = toPaise(t.paid ?? 0);
    const adj = toPaise(t.adjustment ?? 0);
    collected += amt;
    boxes += t.itemCount ?? 0;
    itemDiscount += toPaise(t.discountTotal ?? 0);
    bulkDiscount += toPaise(t.bulkDiscount ?? 0);
    if (adj < 0) adjustDown -= adj;
    else adjustUp += adj;
    if (b.pending) pending++;
    const mode = PAY_MODES.includes(b.payment) ? b.payment : 'cash';
    pay[mode].bills++;
    pay[mode].amount += amt;
    const p = person(b);
    p.bills++;
    p.collected += amt;
    p.boxes += t.itemCount ?? 0;
    p[mode] += amt;
    if (b.customer?.phone) customers.add(b.customer.phone);
    hours[istHour(new Date(b.billedAt))]++;
    const dayRow = days.get(b.day) ?? { date: b.day, revenue: 0, orders: 0 };
    dayRow.revenue += amt;
    dayRow.orders++;
    days.set(b.day, dayRow);

    for (const it of b.items ?? []) {
      const line = toPaise(it.lineTotal ?? 0);
      const cat = categoryOf(it);
      const c = categories.get(cat.id) ?? { id: cat.id, name: cat.name, revenue: 0, boxes: 0 };
      c.revenue += line;
      c.boxes += it.qty;
      categories.set(cat.id, c);
      const i = items.get(it.id) ?? { id: it.id, name: it.name, brand: it.brand, category: cat.name, revenue: 0, boxes: 0, orders: 0 };
      i.revenue += line;
      i.boxes += it.qty;
      i.orders++;
      items.set(it.id, i);
      sections[cat.section === 'standard' ? 'standard' : 'others'] += line;
    }
  }
  let voidValue = 0;
  for (const b of voided) {
    const amt = toPaise(b.totals?.paid ?? 0);
    voidValue += amt;
    const p = person(b);
    p.voids++;
    p.voidValue += amt;
  }

  return {
    bills: paid.length,
    collected,
    avgBill: paid.length ? Math.round(collected / paid.length) : 0,
    boxes,
    itemDiscount,
    bulkDiscount,
    adjustDown,
    adjustUp,
    pending,
    customers: customers.size,
    pay,
    people: [...people.values()].sort((a, b) => b.collected - a.collected),
    voids: { bills: voided.length, amount: voidValue },
    items: [...items.values()],
    categories: [...categories.values()].sort((a, b) => b.revenue - a.revenue),
    days: buildDaySeries([days], { from, to }),
    dayMap: days,
    hours,
    sections,
    from,
    to,
  };
}

/** Item or category totals from both channels, for the "All sales" view. */
export function mergeTotals(a, b) {
  const map = new Map();
  for (const i of [...a, ...b]) {
    const cur = map.get(i.id) ?? { ...i, revenue: 0, boxes: 0, orders: 0 };
    cur.revenue += i.revenue;
    cur.boxes += i.boxes;
    cur.orders += i.orders ?? 0;
    map.set(i.id, cur);
  }
  return [...map.values()].sort((x, y) => y.revenue - x.revenue);
}
