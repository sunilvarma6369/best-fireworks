// Shows new-order push notifications on the shop's devices, even when the admin page is closed.
// The Cloud Function (functions/index.js) sends data-only messages: { title, body, tag, link, phone }.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { data: { body: event.data?.text() } };
  }
  const data = payload.data || {};
  const note = payload.notification || {};
  const phone = data.phone || '';
  event.waitUntil(
    self.registration.showNotification(data.title || note.title || 'New order – Best FireWorks', {
      body: data.body || note.body || 'Open the shop admin to see it.',
      tag: data.tag || 'order',
      renotify: true,
      requireInteraction: true,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      vibrate: [300, 120, 300, 120, 600],
      actions: phone ? [{ action: 'call', title: '📞 Call customer' }, { action: 'open', title: 'Open order' }] : [],
      data: { link: data.link || '/admin', phone },
    }),
  );
});

async function openAdmin(link) {
  const url = new URL(link, self.location.origin).href;
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const admin = wins.find((w) => new URL(w.url).pathname.startsWith('/admin'));
  if (admin) {
    const w = await admin.navigate(url).catch(() => null);
    return (w || admin).focus();
  }
  return self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { link = '/admin', phone = '' } = event.notification.data || {};
  if (event.action === 'call' && phone) {
    // Try the phone dialer directly; browsers that refuse open the order with a big Call button instead.
    event.waitUntil(
      self.clients.openWindow(`tel:+91${phone}`).then(
        (w) => w || openAdmin(`${link}&call=1`),
        () => openAdmin(`${link}&call=1`),
      ),
    );
    return;
  }
  event.waitUntil(openAdmin(link));
});
