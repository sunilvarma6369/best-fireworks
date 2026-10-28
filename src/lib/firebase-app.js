import { initializeApp } from 'firebase/app';
import { firebaseConfig, isFirebaseConfigured } from '../config.js';

// `npm run dev` talks to the local Firebase emulators (`npm run emulators`) using a throwaway "demo-" project,
// so testing never touches real orders. `npm run dev:live` uses the real Firebase project instead.
// (The process.env fallback lets scripts/e2e-emulator.mjs run this same code under Node.)
const devMode = import.meta.env?.DEV ?? globalThis.process?.env?.BFW_EMULATORS === '1';
export const useEmulators = devMode && (import.meta.env?.VITE_LIVE !== '1' || !isFirebaseConfigured);
export const EMULATOR_HOST = globalThis.location?.hostname || '127.0.0.1';

const demoConfig = {
  apiKey: 'demo-key', authDomain: 'demo-best-fireworks.firebaseapp.com', projectId: 'demo-best-fireworks',
  storageBucket: 'demo-best-fireworks.appspot.com', appId: 'demo',
};

export const app = useEmulators ? initializeApp(demoConfig) : isFirebaseConfigured ? initializeApp(firebaseConfig) : null;
