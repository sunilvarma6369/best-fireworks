// Copies OpenCV.js (used by counter billing's scanner) into public/vendor, so the website and the Android app
// serve it themselves and scanning works offline.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/@techstark/opencv-js/dist/opencv.js');
const dst = resolve(root, 'public/vendor/opencv.js');
mkdirSync(dirname(dst), { recursive: true });
if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) copyFileSync(src, dst);
console.log('OpenCV ready in public/vendor/opencv.js');
