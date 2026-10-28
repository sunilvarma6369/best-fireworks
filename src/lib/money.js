// All money math is done in paise (integers) so 110.20 + 742.50 never turns into 852.6999.
export const toPaise = (rupees) => Math.round(Number(rupees) * 100);
export const toRupees = (paise) => Math.round(paise) / 100;

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatPaise(paise) {
  const r = toRupees(paise);
  return '₹' + (Number.isInteger(r) ? inr.format(r) : inr2.format(r));
}

export const formatRupees = (rupees) => formatPaise(toPaise(rupees));

// Shop dates follow India time, whatever the phone's timezone.
export function todayIST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

export function formatDate(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', weekday: 'short', timeZone: 'UTC',
  });
}

export function formatDateTime(date) {
  if (!date) return '';
  return date.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });
}
