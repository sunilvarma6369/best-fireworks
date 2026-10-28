// Sales numbers for the admin dashboard, computed from the orders the admin page already has loaded.
// All money is in paise.
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

/**
 * @param {object[]} orders    Firestore order documents
 * @param {object} opts
 * @param {'today'|'yesterday'|'week'|'all'} opts.range
 * @param {'booked'|'completed'} opts.basis  booked = everything except cancelled
 * @param {(item) => {id: string, name: string, section: string}} opts.categoryOf
 * @param {string} opts.today  YYYY-MM-DD (India time)
 */
export function computeSales(orders, { range = 'all', basis = 'booked', categoryOf, today }) {
  const from = { today, yesterday: shiftDate(today, -1), week: shiftDate(today, -6) }[range] ?? null;
  const to = range === 'yesterday' ? shiftDate(today, -1) : today;
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

  // Daily series: every day in the range (or the most recent MAX_DAYS for the whole season), zeros included.
  const dayKeys = [...days.keys()].sort();
  const start = from ?? (dayKeys[0] && dayKeys[0] > shiftDate(to, -(MAX_DAYS - 1)) ? dayKeys[0] : shiftDate(to, -(MAX_DAYS - 1)));
  const daySeries = [];
  for (let d = start; d <= to; d = shiftDate(d, 1)) daySeries.push(days.get(d) ?? { date: d, revenue: 0, orders: 0 });

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
    days: daySeries,
    hours,
    fulfilment,
    source,
    sections,
  };
}
