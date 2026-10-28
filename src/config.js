// ─────────────────────────────────────────────────────────────────────────────
// The one file to edit after creating your Firebase project. See README.md.
// ─────────────────────────────────────────────────────────────────────────────

// Firebase console → Project settings → General → Your apps → Web app → "SDK setup and configuration".
// These values are public by design; security comes from firestore.rules.
export const firebaseConfig = {
  apiKey: 'AIzaSyBotj6t_CWD1U7t5evm0EaMY0sZgvwhNXA',
  authDomain: 'best-fireworks-98d13.firebaseapp.com',
  projectId: 'best-fireworks-98d13',
  storageBucket: 'best-fireworks-98d13.firebasestorage.app',
  messagingSenderId: '961701498818',
  appId: '1:961701498818:web:536732d5ca5a969c8b505b',
};

// Firebase console → Project settings → Cloud Messaging → Web Push certificates → "Key pair".
// Only needed for push notifications to the shop's phone (admin page).
export const vapidKey = 'YOUR-WEB-PUSH-VAPID-KEY';

// Your live website. The Android app downloads the latest price list from here,
// and order-tracking links sent to customers point here.
export const SITE_URL = 'https://bestfireworks.web.app';

// "Download Android app" link shown on the website. The GitHub workflow builds the APK and deploys it with the
// website (see firebase.json: /app redirects here). Leave as '' to hide the link.
export const APK_URL = '/download/BestFireWorks.apk';

// Pickup at the stall is always offered. Home delivery is switched on/off by the shop in admin → Settings.
export const ORDER_OPTIONS = {
  maxQtyPerItem: 500,
};

export const isFirebaseConfigured = !firebaseConfig.apiKey.startsWith('YOUR-');
