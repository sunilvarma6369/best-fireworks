import { toPaise, todayIST } from './money.js';

export function isBulkEligible(product, offer) {
  if (!product.bulkOfferEligible) return false;
  if (!offer) return true;
  return !offer.excludedProductIds?.includes(product.id) && !offer.excludedCategoryIds?.includes(product.categoryId);
}

/**
 * Totals for a cart. Uses the stored discount/finalPrice of each product (never re-derives 20%).
 * @param {Map<string, number>} qtyById
 * @param {Map<string, object>} productsById
 * @param {object|undefined} offer   the BULK10 offer from the price list
 * @param {Set<string>} unavailable  ids that are sold out / inactive (left out of totals)
 * @param {string} date              YYYY-MM-DD in India time, used for offer validity
 * All returned amounts are in paise.
 */
export function computeTotals(qtyById, productsById, offer, unavailable = new Set(), date = todayIST()) {
  const lines = [];
  const skipped = [];
  let amountTotal = 0, discountTotal = 0, cartTotal = 0, eligibleTotal = 0, itemCount = 0;

  for (const [id, qty] of qtyById) {
    const p = productsById.get(id);
    if (!p || qty <= 0) continue;
    if (unavailable.has(id) || p.active === false) { skipped.push({ product: p, qty }); continue; }
    const finalP = toPaise(p.finalPrice);
    const amountP = toPaise(p.amount ?? p.finalPrice);
    const lineTotal = finalP * qty;
    const eligible = isBulkEligible(p, offer);
    lines.push({ product: p, qty, lineTotal, eligible });
    amountTotal += amountP * qty;
    discountTotal += (amountP - finalP) * qty;
    cartTotal += lineTotal;
    if (eligible) eligibleTotal += lineTotal;
    itemCount += qty;
  }

  const offerLive = !!offer && (!offer.validUntil || date <= offer.validUntil);
  const minBill = offer ? toPaise(offer.minBillAmount) : Infinity;
  const qualifies = offerLive && cartTotal > minBill;
  const bulkDiscount = qualifies ? Math.round((eligibleTotal * offer.value) / 100) : 0;

  return {
    lines,
    skipped,
    itemCount,
    amountTotal,
    discountTotal,
    cartTotal,
    eligibleTotal,
    bulkDiscount,
    netPayable: cartTotal - bulkDiscount,
    offerLive,
    qualifies,
    // How much more to spend to unlock the bulk offer (0 when already unlocked or not running).
    moreForOffer: offerLive && !qualifies ? Math.max(0, minBill - cartTotal) : 0,
    hasIneligible: lines.some((l) => !l.eligible),
  };
}
