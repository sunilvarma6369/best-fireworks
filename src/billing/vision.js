// On-device product recognition for counter billing, fully offline.
// Each item photo gets (1) a colour fingerprint and (2) ORB feature points: tiny descriptions of the printed
// artwork that survive tilt, size, light and background. A scan first shortlists items by colour, then matches
// feature points against the shortlist and checks they line up geometrically (RANSAC homography). The number
// of points that line up is the score. Uses OpenCV.js (~11 MB), loaded only when billing first needs it.
import { allItems, deleteItem, putItem } from './store.js';

const OPENCV_URL = '/vendor/opencv.js';
const REF_SIDE = 400; // item photos are analysed at this size
const REF_FEATURES = 300;
const QUERY_SIDE = 600; // camera frames
const QUERY_FEATURES = 650;
const SHORTLIST = 30; // items compared in detail after the colour step
const RATIO = 0.8;
const GUIDE = 0.9; // part of the camera frame inside the on-screen square

let cvPromise;
/** Loads OpenCV once. Its global looks "thenable", so `then` is removed before handing it to a promise. */
export function loadScanner() {
  cvPromise ??= new Promise((resolve, reject) => {
    const ready = () => {
      if (!(window.cv?.Mat && window.cv?.ORB)) return false;
      delete window.cv.then;
      resolve(window.cv);
      return true;
    };
    if (ready()) return;
    const s = document.createElement('script');
    s.src = OPENCV_URL;
    s.async = true;
    s.onerror = () => reject(new Error('The scanner could not load'));
    document.head.appendChild(s);
    const started = Date.now();
    const poll = setInterval(() => {
      if (ready()) clearInterval(poll);
      else if (Date.now() - started > 60000) {
        clearInterval(poll);
        reject(new Error('The scanner took too long to load'));
      }
    }, 100);
  });
  cvPromise.catch(() => { cvPromise = null; });
  return cvPromise;
}

function drawScaled(src, sw, sh, maxSide, crop = 1) {
  const side = Math.min(sw, sh) * crop;
  const w = crop < 1 ? side : sw;
  const h = crop < 1 ? side : sh;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d', { willReadFrequently: true }).drawImage(src, (sw - w) / 2, (sh - h) / 2, w, h, 0, 0, c.width, c.height);
  return c;
}

/** Colour fingerprint: 16 hues × 4 saturations for colourful pixels, plus 4 grey levels. */
function colourHist(canvas) {
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const hist = new Float32Array(68);
  let n = 0;
  for (let i = 0; i < d.length; i += 16) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const s = max ? (max - min) / max : 0;
    if (s > 0.2 && max > 0.15) {
      const dl = max - min;
      let h = max === r ? ((g - b) / dl) % 6 : max === g ? (b - r) / dl + 2 : (r - g) / dl + 4;
      h = (h * 60 + 360) % 360;
      hist[Math.min(15, Math.floor(h / 22.5)) * 4 + Math.min(3, Math.floor((s - 0.2) / 0.2))]++;
    } else {
      hist[64 + Math.min(3, Math.floor(max * 4))]++;
    }
    n++;
  }
  for (let i = 0; i < hist.length; i++) hist[i] /= n || 1;
  return hist;
}

const overlap = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.min(a[i], b[i]);
  return s;
};

function orbFeatures(cv, canvas, count) {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const orb = new cv.ORB(count);
  const kp = new cv.KeyPointVector();
  const des = new cv.Mat();
  const noMask = new cv.Mat();
  try {
    orb.detectAndCompute(gray, noMask, kp, des);
    const pts = new Float32Array(kp.size() * 2);
    for (let i = 0; i < kp.size(); i++) {
      const p = kp.get(i).pt;
      pts[2 * i] = p.x;
      pts[2 * i + 1] = p.y;
    }
    return { pts, des: new Uint8Array(des.data), rows: des.rows };
  } finally {
    [src, gray, orb, kp, des, noMask].forEach((m) => m.delete());
  }
}

/** Brings stored scan data up to date with the stored photos. Returns how many items can be scanned. */
export async function syncVectors(photos, onProgress = () => {}) {
  const stored = new Map((await allItems('vectors')).map((v) => [v.id, v]));
  for (const id of stored.keys()) if (!photos.has(id)) await deleteItem('vectors', id);
  const todo = [...photos.values()].filter((p) => stored.get(p.id)?.url !== p.url || !stored.get(p.id)?.des);
  if (todo.length) {
    const cv = await loadScanner();
    let done = 0;
    for (const p of todo) {
      try {
        const bmp = await createImageBitmap(p.blob);
        const c = drawScaled(bmp, bmp.width, bmp.height, REF_SIDE);
        bmp.close?.();
        await putItem('vectors', p.id, { id: p.id, url: p.url, hist: colourHist(c), ...orbFeatures(cv, c, REF_FEATURES) });
      } catch { /* unreadable photo: the item can still be found by name */ }
      onProgress(++done, todo.length);
      await new Promise((r) => setTimeout(r)); // keep the screen responsive
    }
  }
  return (await allItems('vectors')).length;
}

let index = [];
export async function loadIndex() {
  index = (await allItems('vectors')).filter((v) => v.rows > 0);
  return index.length;
}

/** Feature-point match of the query against a few candidate items; returns [{ id, score }] best first. */
function verify(cv, q, cands) {
  const total = cands.reduce((s, r) => s + r.rows, 0);
  if (!total || !q.rows) return [];
  const all = new Uint8Array(total * 32);
  const owner = new Int32Array(total);
  const local = new Int32Array(total);
  let o = 0;
  cands.forEach((r, ri) => {
    all.set(r.des, o * 32);
    for (let k = 0; k < r.rows; k++) { owner[o + k] = ri; local[o + k] = k; }
    o += r.rows;
  });
  const train = cv.matFromArray(total, 32, cv.CV_8U, all);
  const qm = cv.matFromArray(q.rows, 32, cv.CV_8U, q.des);
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const knn = new cv.DMatchVectorVector();
  const pairsByItem = new Map();
  try {
    bf.knnMatch(qm, train, knn, 2);
    for (let i = 0; i < knn.size(); i++) {
      const m = knn.get(i);
      if (m.size() >= 2) {
        const a = m.get(0);
        const b = m.get(1);
        if (a.distance < RATIO * b.distance) {
          const ri = owner[a.trainIdx];
          if (!pairsByItem.has(ri)) pairsByItem.set(ri, []);
          pairsByItem.get(ri).push([a.queryIdx, local[a.trainIdx]]);
        }
      }
      m.delete();
    }
  } finally {
    [train, qm, bf, knn].forEach((m) => m.delete());
  }
  return [...pairsByItem]
    .sort((x, y) => y[1].length - x[1].length)
    .slice(0, 4)
    .map(([ri, pairs]) => {
      const r = cands[ri];
      if (pairs.length < 6) return { id: r.id, score: 0 };
      const src = [];
      const dst = [];
      for (const [qi, li] of pairs) {
        src.push(r.pts[2 * li], r.pts[2 * li + 1]);
        dst.push(q.pts[2 * qi], q.pts[2 * qi + 1]);
      }
      const s = cv.matFromArray(pairs.length, 1, cv.CV_32FC2, src);
      const d = cv.matFromArray(pairs.length, 1, cv.CV_32FC2, dst);
      const mask = new cv.Mat();
      const H = cv.findHomography(s, d, cv.RANSAC, 6, mask);
      const inliers = H.empty() ? 0 : cv.countNonZero(mask);
      [s, d, mask, H].forEach((m) => m.delete());
      return { id: r.id, score: inliers };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Recognises the box inside the on-screen square. Returns up to `limit` items, best first:
 * score = matching feature points (≥ 12 and twice the next item = sure). When nothing matches well,
 * the closest items by colour are returned with score 0, as suggestions.
 */
export async function matchFrame(video, limit = 4) {
  if (!index.length || !video.videoWidth) return [];
  const cv = await loadScanner();
  const c = drawScaled(video, video.videoWidth, video.videoHeight, QUERY_SIDE, GUIDE);
  const qh = colourHist(c);
  const byColour = index.map((r) => ({ r, s: overlap(qh, r.hist) })).sort((a, b) => b.s - a.s);
  const shortlist = byColour.slice(0, SHORTLIST).map((x) => x.r);
  const q = orbFeatures(cv, c, QUERY_FEATURES);
  const verified = verify(cv, q, shortlist).filter((m) => m.score > 0);
  if (verified.length && verified[0].score >= 6) return verified.slice(0, limit);
  return byColour.slice(0, limit).map((x) => ({ id: x.r.id, score: 0 }));
}

export const SURE_POINTS = 12;
export const isConfident = (m) => m.length > 0 && m[0].score >= SURE_POINTS && m[0].score >= 2 * (m[1]?.score ?? 0);
