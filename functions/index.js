// Cloud Functions for Best FireWorks (needs the Firebase Blaze plan; normal shop volume stays inside the free quota).
//
// notifyShopOnNewOrder: push notification to every shop device when a new order is booked:
//   - the Android app (platform: 'android') gets a real Android notification; tapping it opens the order
//   - the admin web page (other tokens) gets a data-only web push, shown by public/firebase-messaging-sw.js
// staffUsers: the super admin's Users tab: add logins, set passwords, change roles, switch logins off.
const { setGlobalOptions } = require('firebase-functions/v2');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
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

// ── Shop users (Users tab; super admin only) ───────────────────────────────────────────────────────────
// Each login is a Firebase Auth user plus admins/{uid} = { name, role, username, active }.
// Staff sign in with a username: it becomes <username>@STAFF_DOMAIN behind the scenes (no email is ever sent).
// Keep STAFF_DOMAIN and USERNAME in step with src/lib/staff.js.
const STAFF_DOMAIN = 'staff.bestfireworks.web.app';
const ROLES = ['super', 'admin', 'sales'];
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,23}$/;

const clean = (s, max) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const isActiveSuper = (d) => d && d.active !== false && (d.role ?? 'admin') === 'super';

function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 6 || p.length > 64) {
    throw new HttpsError('invalid-argument', 'The password must be 6 to 64 characters.');
  }
  return p;
}

function checkName(n) {
  const name = clean(n, 60);
  if (name.length < 2) throw new HttpsError('invalid-argument', 'Enter the person’s name.');
  return name;
}

async function activeSuperCount(db) {
  const snap = await db.collection('admins').where('role', '==', 'super').get();
  return snap.docs.filter((d) => d.get('active') !== false).length;
}

// Push tokens of a login that is switched off or deleted, so that phone stops getting order notifications.
async function removeTokens(db, uid) {
  const snap = await db.collection('adminTokens').where('uid', '==', uid).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function listUsers(db, auth) {
  const docs = (await db.collection('admins').get()).docs;
  const authUsers = new Map();
  for (let i = 0; i < docs.length; i += 100) {
    const res = await auth.getUsers(docs.slice(i, i + 100).map((d) => ({ uid: d.id })));
    res.users.forEach((u) => authUsers.set(u.uid, u));
  }
  return docs.map((d) => {
    const v = d.data();
    const u = authUsers.get(d.id);
    return {
      uid: d.id,
      name: v.name ?? '',
      role: ROLES.includes(v.role) ? v.role : 'admin',
      username: v.username ?? '',
      email: u?.email ?? v.email ?? '',
      active: v.active !== false && !u?.disabled,
      noLogin: !u,
      lastSignIn: u?.metadata?.lastSignInTime ?? null,
      lastActive: u?.metadata?.lastRefreshTime ?? null,
      createdAt: u?.metadata?.creationTime ?? null,
    };
  });
}

exports.staffUsers = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in again.');
  const db = getFirestore();
  const auth = getAuth();
  const meSnap = await db.doc(`admins/${req.auth.uid}`).get();
  if (!isActiveSuper(meSnap.data())) throw new HttpsError('permission-denied', 'Only the super admin can manage users.');
  const me = { uid: req.auth.uid, name: meSnap.get('name') ?? '' };
  const d = req.data ?? {};

  try {
    if (d.action === 'list') return { users: await listUsers(db, auth) };

    if (d.action === 'create') {
      const name = checkName(d.name);
      const username = clean(d.username, 24).toLowerCase();
      if (!USERNAME.test(username)) {
        throw new HttpsError('invalid-argument', 'Username: 3 to 24 small letters or numbers (. - _ allowed), no spaces.');
      }
      if (!ROLES.includes(d.role)) throw new HttpsError('invalid-argument', 'Choose a role.');
      const password = checkPassword(d.password);
      let user;
      try {
        user = await auth.createUser({ email: `${username}@${STAFF_DOMAIN}`, password, displayName: name });
      } catch (e) {
        if (e.code === 'auth/email-already-exists') throw new HttpsError('already-exists', `The username “${username}” is already taken.`);
        throw e;
      }
      await db.doc(`admins/${user.uid}`).set({
        name, role: d.role, username, email: user.email, active: true,
        createdAt: FieldValue.serverTimestamp(), createdBy: me.name, updatedAt: FieldValue.serverTimestamp(),
      });
      logger.info(`${me.name} added ${username} (${d.role})`);
      return { uid: user.uid, username };
    }

    // The rest change an existing login.
    const uid = String(d.uid ?? '');
    const ref = db.doc(`admins/${uid}`);
    const cur = uid ? await ref.get() : null;
    if (!cur?.exists) throw new HttpsError('not-found', 'That user no longer exists. Refresh the list.');

    if (d.action === 'update') {
      const patch = { updatedAt: FieldValue.serverTimestamp(), updatedBy: me.name };
      if (d.name !== undefined) patch.name = checkName(d.name);
      if (d.role !== undefined) {
        if (!ROLES.includes(d.role)) throw new HttpsError('invalid-argument', 'Choose a role.');
        patch.role = d.role;
      }
      if (d.active !== undefined) patch.active = d.active === true;
      const after = { ...cur.data(), ...patch };
      if (isActiveSuper(cur.data()) && !isActiveSuper(after)) {
        if (uid === me.uid) throw new HttpsError('failed-precondition', 'You cannot remove your own super admin access.');
        if ((await activeSuperCount(db)) <= 1) throw new HttpsError('failed-precondition', 'There must always be at least one super admin.');
      }
      await ref.update(patch);
      if (patch.name) await auth.updateUser(uid, { displayName: patch.name }).catch(() => {});
      if (patch.active !== undefined) {
        await auth.updateUser(uid, { disabled: !patch.active }).catch((e) => {
          if (e.code !== 'auth/user-not-found') throw e;
        });
        if (!patch.active) {
          await auth.revokeRefreshTokens(uid).catch(() => {});
          await removeTokens(db, uid);
        }
      }
      logger.info(`${me.name} updated ${uid}`, { role: patch.role, active: patch.active });
      return { ok: true };
    }

    if (d.action === 'password') {
      const password = checkPassword(d.password);
      await auth.updateUser(uid, { password });
      if (uid !== me.uid) await auth.revokeRefreshTokens(uid).catch(() => {}); // their other phones must sign in again
      logger.info(`${me.name} set a new password for ${uid}`);
      return { ok: true };
    }

    if (d.action === 'delete') {
      if (uid === me.uid) throw new HttpsError('failed-precondition', 'You cannot delete your own login.');
      if (isActiveSuper(cur.data()) && (await activeSuperCount(db)) <= 1) {
        throw new HttpsError('failed-precondition', 'There must always be at least one super admin.');
      }
      await auth.deleteUser(uid).catch((e) => {
        if (e.code !== 'auth/user-not-found') throw e;
      });
      await ref.delete();
      await removeTokens(db, uid);
      logger.info(`${me.name} deleted ${uid}`);
      return { ok: true };
    }

    throw new HttpsError('invalid-argument', 'Unknown action.');
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error('staffUsers failed', e);
    throw new HttpsError('internal', e.message || 'Something went wrong.');
  }
});
