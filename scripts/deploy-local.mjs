// Manual deploy from this PC (normally GitHub does it on every push).
// Hosting deploys replace the whole site, and the APK is only built on GitHub, so this first copies the APK
// that is live right now into dist/ to keep the "Android app" download working.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { SITE_URL } from '../src/config.js';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

run('npm run build');

const res = await fetch(`${SITE_URL}/download/BestFireWorks.apk`, { cache: 'no-store' });
const isApk = res.ok && !(res.headers.get('content-type') ?? '').includes('text/html');
if (isApk) {
  mkdirSync('dist/download', { recursive: true });
  writeFileSync('dist/download/BestFireWorks.apk', Buffer.from(await res.arrayBuffer()));
  console.log('Kept the live APK in this deploy.');
} else {
  console.warn('No APK on the live site yet; deploying without it (GitHub adds it on the next push).');
}

run('firebase deploy --only hosting,firestore');
