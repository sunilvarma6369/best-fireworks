// Local testing only: creates a shop admin login in the Firebase emulators (`npm run emulators` must be running).
// usage: npm run seed            -> admin@bestfireworks.test / diwali2026
const PROJECT = 'demo-best-fireworks';
const EMAIL = process.argv[2] ?? 'admin@bestfireworks.test';
const PASSWORD = process.argv[3] ?? 'diwali2026';
const AUTH = 'http://127.0.0.1:9099';
const FIRESTORE = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;

async function call(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json };
}

let r = await call(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, { email: EMAIL, password: PASSWORD, returnSecureToken: true });
if (!r.ok && r.json.error?.message === 'EMAIL_EXISTS') {
  r = await call(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, { email: EMAIL, password: PASSWORD, returnSecureToken: true });
}
if (!r.ok) {
  console.error('Could not create the admin user. Is `npm run emulators` running?', r.json);
  process.exit(1);
}
const uid = r.json.localId;

// "Bearer owner" bypasses security rules in the emulator, like editing in the Firebase console.
const w = await call(`${FIRESTORE}/admins?documentId=${uid}`, { fields: { name: { stringValue: 'Shop owner (local test)' } } }, { Authorization: 'Bearer owner' });
if (!w.ok && w.json.error?.status !== 'ALREADY_EXISTS') {
  console.error('Could not create admins doc', w.json);
  process.exit(1);
}
console.log(`Admin login ready:\n  email:    ${EMAIL}\n  password: ${PASSWORD}\n  uid:      ${uid}`);
