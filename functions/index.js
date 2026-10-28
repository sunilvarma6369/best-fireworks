// Push notification to every shop device when a new order is booked:
//   - the "BFW Admin" Android app (platform: 'android') gets a real Android notification; tapping it opens the order
//   - the admin web page (other tokens) gets a data-only web push, shown by public/firebase-messaging-sw.js
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
  const appTokens = tokensSnap.docs.filter((d) => d.get('platform') === 'android').map((d) => d.id);
  const webTokens = tokensSnap.docs.filter((d) => d.get('platform') !== 'android').map((d) => d.id);
  if (!appTokens.length && !webTokens.length) {
    logger.info('No shop devices registered for push yet');
    return;
  }

  const code = event.params.code;
  const t = order.totals || {};
  const when = order.pickupDate ? ` · ${order.fulfilment === 'delivery' ? 'delivery' : 'pickup'} ${order.pickupDate}` : '';
  const title = `🔔 New order ${code}${order.fulfilment === 'delivery' ? ' 🚚' : ''}`;
  const body = `${order.customer?.name || 'Customer'} · ${order.customer?.phone || ''} · ${rupees(t.netPayable)} · ${t.itemCount || 0} boxes${when}`;
  const data = { code, title, body, tag: code, link: `/admin?order=${code}`, phone: order.customer?.phone || '' };

  const sends = [];
  if (appTokens.length) {
    sends.push(getMessaging().sendEachForMulticast({
      tokens: appTokens,
      notification: { title, body },
      data,
      android: {
        priority: 'high',
        notification: { channelId: 'orders', tag: code, sound: 'default', defaultVibrateTimings: true, visibility: 'public' },
      },
    }).then((res) => ({ res, tokens: appTokens })));
  }
  if (webTokens.length) {
    sends.push(getMessaging().sendEachForMulticast({
      tokens: webTokens,
      data,
      webpush: { headers: { Urgency: 'high', TTL: '86400' } },
    }).then((res) => ({ res, tokens: webTokens })));
  }

  // Forget devices that uninstalled the app / revoked permission.
  let sent = 0;
  const stale = [];
  for (const { res, tokens } of await Promise.all(sends)) {
    sent += res.successCount;
    res.responses.forEach((r, i) => {
      const errCode = r.error?.code ?? '';
      if (errCode.includes('registration-token-not-registered') || errCode.includes('invalid-argument')) stale.push(tokens[i]);
    });
  }
  await Promise.all(stale.map((tok) => db.collection('adminTokens').doc(tok).delete()));
  logger.info(`Order ${code}: notified ${sent} devices (${appTokens.length} app, ${webTokens.length} web), removed ${stale.length} stale`);
});
