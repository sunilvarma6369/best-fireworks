// Push notification to every shop device when a new order is booked.
// Needs the Firebase Blaze (pay-as-you-go) plan; normal shop volume stays inside the free monthly quota.
const { setGlobalOptions } = require('firebase-functions/v2');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();

// Must match your Firestore database location (Firebase console → Firestore → top of the page).
// asia-south1 = Mumbai. Change this if you created the database somewhere else.
setGlobalOptions({ region: 'asia-south1', maxInstances: 5 });

const rupees = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

exports.notifyShopOnNewOrder = onDocumentCreated('orders/{code}', async (event) => {
  const order = event.data?.data();
  if (!order) return;

  const db = getFirestore();
  const tokensSnap = await db.collection('adminTokens').get();
  const tokens = tokensSnap.docs.map((d) => d.id);
  if (!tokens.length) {
    logger.info('No shop devices registered for push yet');
    return;
  }

  const code = event.params.code;
  const t = order.totals || {};
  const pickup = order.pickupDate ? ` · pickup ${order.pickupDate}` : '';
  const res = await getMessaging().sendEachForMulticast({
    tokens,
    // Data-only message; public/firebase-messaging-sw.js turns it into a notification with Call / Open buttons.
    data: {
      title: `🔔 New order ${code}`,
      body: `${order.customer?.name || 'Customer'} · ${order.customer?.phone || ''} · ${rupees(t.netPayable)} · ${t.itemCount || 0} boxes${pickup}`,
      tag: code,
      link: `/admin?order=${code}`,
      phone: order.customer?.phone || '',
    },
    webpush: { headers: { Urgency: 'high', TTL: '86400' } },
    android: { priority: 'high' },
  });

  // Forget devices that uninstalled / revoked permission.
  const stale = [];
  res.responses.forEach((r, i) => {
    const errCode = r.error?.code ?? '';
    if (errCode.includes('registration-token-not-registered') || errCode.includes('invalid-argument')) stale.push(tokens[i]);
  });
  await Promise.all(stale.map((tok) => db.collection('adminTokens').doc(tok).delete()));
  logger.info(`Order ${code}: notified ${res.successCount}/${tokens.length} devices, removed ${stale.length} stale`);
});
