import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // The shop admin page bundles Firestore + Auth + Messaging; it is only used by staff.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        track: resolve(import.meta.dirname, 'track.html'),
        admin: resolve(import.meta.dirname, 'admin.html'),
      },
    },
  },
});
