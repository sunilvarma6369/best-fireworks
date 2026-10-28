// Order codes look like BFW-K7Q2M: 5 characters from 32 easy-to-read ones (no 0/O, 1/I),
// about 33 million combinations, so nobody can guess someone else's code.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;
export const CODE_RE = /^BFW-[A-HJ-NP-Z2-9]{5}$/;

const randomFrom = (alphabet, n) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => alphabet[b % alphabet.length]).join('');

export const newOrderCode = () => `BFW-${randomFrom(CODE_ALPHABET, CODE_LENGTH)}`;

// 4-digit code the customer tells the shop when collecting. Kept private (never on the public tracking record).
export const newPickupCode = () => randomFrom('0123456789', 4);

/** Accepts "bfwk7q2m", "BFW-K7Q2M", "k7q2m", "K7Q 2M" … and returns "BFW-K7Q2M", or null. */
export function normalizeOrderCode(raw) {
  let s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length === CODE_LENGTH + 3 && s.startsWith('BFW')) s = s.slice(3);
  const code = `BFW-${s}`;
  return CODE_RE.test(code) ? code : null;
}

/** Keeps only the characters an order code can contain, for live-formatting an input box. */
export const cleanCodeInput = (raw) =>
  String(raw ?? '').toUpperCase().replace(/^BFW-?/, '').replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, CODE_LENGTH);
