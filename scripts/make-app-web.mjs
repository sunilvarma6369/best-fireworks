// The Android app is the shop's admin tool, so it opens the admin page: copy the built site to dist-app/
// and make admin.html its start page (Capacitor always loads index.html).
import { cpSync, copyFileSync, rmSync } from 'node:fs';

rmSync('dist-app', { recursive: true, force: true });
cpSync('dist', 'dist-app', { recursive: true });
copyFileSync('dist/admin.html', 'dist-app/index.html');
console.log('dist-app ready (start page: admin)');
