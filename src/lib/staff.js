// Shop logins and what each role may do. The role lives in Firestore admins/{uid}.role (missing = admin);
// firestore.rules enforces the same rules on the server, this file only shapes the app.
// Keep STAFF_DOMAIN and USERNAME_RE in step with functions/index.js.

export const STAFF_DOMAIN = 'staff.bestfireworks.web.app';
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,23}$/;
/** Minutes a salesperson can still cancel or correct their own bill (same as firestore.rules). */
export const SALES_EDIT_MINUTES = 30;

export const ROLES = {
  sales: { label: 'Sales', blurb: 'Billing and online orders. Sees only their own sales.' },
  admin: { label: 'Admin', blurb: 'Everything except users: all sales, prices, shop settings.' },
  super: { label: 'Super admin', blurb: 'Everything, including adding users and setting passwords.' },
};

export const isAdminRole = (role) => role === 'admin' || role === 'super';

/** "ravi" → "ravi@staff.bestfireworks.web.app"; an email address is used as typed. */
export function loginEmail(input) {
  const v = String(input ?? '').trim().toLowerCase();
  return v.includes('@') ? v : `${v}@${STAFF_DOMAIN}`;
}

/** The username behind a staff login, or '' for logins that use a real email address. */
export function usernameOf(email) {
  const e = String(email ?? '').toLowerCase();
  return e.endsWith(`@${STAFF_DOMAIN}`) ? e.slice(0, -STAFF_DOMAIN.length - 1) : '';
}

/** What the app knows about the signed-in person, from their admins/{uid} document. */
export function staffFromDoc(uid, data, email) {
  const username = data?.username || usernameOf(email);
  return {
    uid,
    name: String(data?.name || username || email || 'Staff'),
    role: ROLES[data?.role] ? data.role : 'admin',
    active: data?.active !== false,
    username,
    email: email ?? '',
  };
}

/** Suggests a username from a name: "Ravi Kumar" → "ravi". */
export function suggestUsername(name) {
  const first = String(name ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  return first.replace(/[^a-z0-9._-]/g, '').slice(0, 24);
}

/** An easy-to-read password for a new login (no 0/O or 1/l look-alikes). */
export function makePassword() {
  const words = ['star', 'rocket', 'diya', 'spark', 'flower', 'chakra', 'bomb', 'light', 'shine', 'glow'];
  const word = words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  const num = 1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000);
  return `${word}${num}`;
}
