// Builds the printable price list in the browser or the Android app. Text and shapes are vector, so they stay sharp
// at any zoom; each header picture is a separate high-resolution image. Coordinates are A4 points, measured from
// the bottom-left corner, matching the shop's original price list. Loaded only when exporting.
import { jsPDF } from 'jspdf';
import { PDF_DEFAULTS, PDF_IMAGES } from './pdf-config.js';

const W = 595.28;
const H = 841.89;
const MARGIN = 22.68;
const CONTENT_W = 549.92;

const C = {
  dark: [59, 5, 8],
  gold: [255, 201, 60],
  goldSoft: [255, 231, 176],
  sparkA: [255, 216, 107],
  sparkB: [255, 138, 61],
  red: [181, 18, 27],
  ink: [42, 26, 18],
  muted: [122, 94, 80],
  alt: [255, 248, 238],
  finalBg: [255, 241, 194],
  discount: [232, 89, 12],
  rule: [241, 220, 200],
  frame: [227, 180, 138],
  white: [255, 255, 255],
};

const FONTS = {
  R: 'Poppins-Regular',
  M: 'Poppins-Medium',
  B: 'Poppins-Bold',
  I: 'Poppins-Italic',
  S: 'BerkshireSwash-Regular', // shop name in the header
  L: 'BreeSerif-Regular', // pink strip and green line
};

// Layout, from the original PDF
const BAR_H = 28.35;
const BAR_GAP = 3.4;
const HEAD_H = 14.36;
const ROW_H = 17.53;
const GROUP_GAP = 14.17;
const HERO_H = 113.39;
const NOTE_H = 21;
const PAGE_TOP = 782.32; // first content line on pages with the slim top bar
const PAGE1_TOP = 627.02; // first content line under the big page 1 header
const PAGE_BOTTOM = 31;
const KEEP_TOGETHER = 12; // categories up to this many rows never split across pages
const MIN_SPLIT_ROWS = 3;

const COL = {
  no: 35.4, product: 51.4, brand: 252.6, box: 348.65, pcs: 377, amount: 450.3, discount: 509.9, finalRight: 569.4,
  finalLeft: MARGIN + 490.39, finalW: 59.53,
};

const toBase64 = (buf) => {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const fontCache = new Map();
async function loadFont(name) {
  if (!fontCache.has(name)) {
    fontCache.set(name, fetch(`/pdf/fonts/${name}.ttf`).then((r) => {
      if (!r.ok) throw new Error(`Could not load the font ${name}`);
      return r.arrayBuffer();
    }).then(toBase64));
  }
  return fontCache.get(name);
}

/** Loads a picture (URL or data URL) with its pixel size. */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      resolve({ data: src.startsWith('data:') ? src : c.toDataURL('image/png'), w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => reject(new Error('Could not load a header image'));
    img.src = src;
  });
}

/** Header pictures: uploaded replacement → built-in artwork; `hidden` slots are skipped. */
async function loadHeaderImages(custom = {}) {
  const out = {};
  await Promise.all(PDF_IMAGES.map(async ({ slot, file }) => {
    const c = custom[slot];
    if (c?.hidden) return;
    const src = c?.data ?? file;
    if (src) out[slot] = await loadImage(src);
  }));
  return out;
}

function gradientImage(stops, { vertical = false, size = 768 } = {}) {
  const c = document.createElement('canvas');
  c.width = vertical ? 4 : size;
  c.height = vertical ? size : 4;
  const ctx = c.getContext('2d');
  const g = vertical ? ctx.createLinearGradient(0, 0, 0, size) : ctx.createLinearGradient(0, 0, size, 0);
  stops.forEach(([at, color]) => g.addColorStop(at, color));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

/** Soft purple sky behind the page 1 header. Fireworks and everything else are drawn on top as vectors. */
function headerSky() {
  const c = document.createElement('canvas');
  c.width = 1400;
  c.height = 440;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 1400, 440);
  g.addColorStop(0, '#2a0a63');
  g.addColorStop(0.5, '#4a1596');
  g.addColorStop(1, '#2c0a6b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1400, 440);
  const glow = ctx.createRadialGradient(700, 240, 40, 700, 240, 620);
  glow.addColorStop(0, 'rgba(236, 64, 160, 0.55)');
  glow.addColorStop(1, 'rgba(236, 64, 160, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 1400, 440);
  return c.toDataURL('image/jpeg', 0.92);
}

function buildDecor() {
  return {
    band: gradientImage([[0, '#2a0306'], [1, '#5a0710']], { vertical: true }),
    maroon: gradientImage([[0, '#2b0306'], [0.5, '#8a0b13'], [1, '#2b0306']]),
    barStd: gradientImage([[0, '#7a0a10'], [0.5, '#a30f17'], [1, '#7a0a10']]),
    barOth: gradientImage([[0, '#c8151d'], [0.5, '#dc461b'], [1, '#f07a18']]),
    goldCard: gradientImage([[0, '#ffd458'], [1, '#ffbc2e']]),
    pinkPill: gradientImage([[0, '#e0127f'], [0.5, '#f4279a'], [1, '#c60e78']]),
    sky: headerSky(),
  };
}

const money = (n) => {
  const v = Math.round(Number(n) * 100) / 100;
  return Number.isInteger(v)
    ? new Intl.NumberFormat('en-IN').format(v)
    : new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
};

/** Groups the live price list into sections and categories, in list order. */
function buildSections(catalog, { section = 'all', soldOut = new Set(), hideSoldOut = false }) {
  const ids = section === 'all' ? ['standard', 'others'] : [section];
  return ids.map((id) => {
    const groups = catalog.categories
      .filter((c) => c.section === id)
      .map((cat) => ({
        cat,
        rows: catalog.products.filter((p) => p.categoryId === cat.id && p.active !== false && !(hideSoldOut && soldOut.has(p.id))),
      }))
      .filter((g) => g.rows.length);
    return { id, groups, count: groups.reduce((s, g) => s + g.rows.length, 0) };
  }).filter((s) => s.count);
}

class Page {
  constructor(doc, decor, cfg, images) {
    Object.assign(this, { doc, decor, cfg, images });
  }

  setText(font, size, color) {
    this.doc.setFont(FONTS[font], 'normal');
    this.doc.setFontSize(size);
    this.doc.setTextColor(...color);
  }

  /** x from the left, y from the bottom (like the original PDF). align: left | center | right. */
  text(str, x, y, font, size, color, align = 'left') {
    this.setText(font, size, color);
    this.doc.text(String(str ?? ''), x, H - y, { align });
  }

  width(str, font, size) {
    this.doc.setFont(FONTS[font], 'normal');
    this.doc.setFontSize(size);
    return this.doc.getTextWidth(String(str ?? ''));
  }

  /** Largest size (down from `size`) at which the text fits `maxW`, so long admin text never overflows. */
  fit(str, font, size, maxW, min = 5) {
    let s = size;
    while (s > min && this.width(str, font, s) > maxW) s -= 0.25;
    return s;
  }

  rect(x, y, w, h, color) {
    this.doc.setFillColor(...color);
    this.doc.rect(x, H - y - h, w, h, 'F');
  }

  rounded(x, y, w, h, r, color) {
    this.doc.setFillColor(...color);
    this.doc.roundedRect(x, H - y - h, w, h, r, r, 'F');
  }

  gradient(key, x, y, w, h, r = 0) {
    const { doc } = this;
    const type = key === 'sky' ? 'JPEG' : 'PNG';
    if (r) {
      doc.saveGraphicsState();
      doc.roundedRect(x, H - y - h, w, h, r, r, null);
      doc.clip();
      doc.discardPath();
    }
    doc.addImage(this.decor[key], type, x, H - y - h, w, h, `grad-${key}`, 'FAST');
    if (r) doc.restoreGraphicsState();
  }

  sparkle(cx, cy, r1, r2, color, lw = 0.7, dot = 1.2) {
    const { doc } = this;
    doc.setDrawColor(...color);
    doc.setLineWidth(lw);
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      doc.line(cx + Math.cos(a) * r1, H - cy - Math.sin(a) * r1, cx + Math.cos(a) * r2, H - cy - Math.sin(a) * r2);
    }
    doc.setFillColor(...color);
    doc.circle(cx, H - cy, dot, 'F');
  }

  star(cx, cy, outer, inner, points, color) {
    const pts = [];
    for (let i = 0; i < points * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / points;
      const r = i % 2 === 0 ? outer : inner;
      pts.push([cx + Math.cos(a) * r, H - cy + Math.sin(a) * r]);
    }
    const deltas = pts.slice(1).map((p, i) => [p[0] - pts[i][0], p[1] - pts[i][1]]);
    this.doc.setFillColor(...color);
    this.doc.lines(deltas, pts[0][0], pts[0][1], [1, 1], 'F', true);
  }

  picture(slot, x, y, { w, h }) {
    const im = this.images[slot];
    if (!im) return 0;
    const ratio = im.w / im.h;
    let dw = w ?? h * ratio;
    let dh = h ?? w / ratio;
    if (w && h) {
      dw = Math.min(w, h * ratio);
      dh = dw / ratio;
    }
    const format = im.data.startsWith('data:image/jpeg') ? 'JPEG' : 'PNG';
    this.doc.addImage(im.data, format, x, H - y - dh, dw, dh, `img-${slot}`, 'FAST');
    return dw;
  }

  /** Text with a thick outline behind it, for the header lettering. */
  outlined(str, x, y, font, size, fill, stroke, lw, shadow) {
    const { doc } = this;
    doc.setFont(FONTS[font], 'normal');
    doc.setFontSize(size);
    doc.setLineJoin('round');
    if (shadow) {
      doc.setDrawColor(...shadow);
      doc.setLineWidth(lw + 0.9);
      doc.setTextColor(...shadow);
      doc.text(str, x + 0.7, H - y + 0.9, { align: 'center', renderingMode: 'fillThenStroke' });
    }
    doc.setDrawColor(...stroke);
    doc.setLineWidth(lw);
    doc.setTextColor(...stroke);
    doc.text(str, x, H - y, { align: 'center', renderingMode: 'fillThenStroke' });
    doc.setTextColor(...fill);
    doc.text(str, x, H - y, { align: 'center', renderingMode: 'fill' });
    doc.setLineJoin('miter');
  }

  footer(no, total) {
    const { cfg } = this;
    this.rect(0, 0, W, 22.68, C.dark);
    this.rect(0, 22.68, W, 1.7, C.gold);
    const size = this.fit(cfg.footerText, 'R', 7.6, 495);
    this.text(cfg.footerText, MARGIN, 8.5, 'R', size, C.goldSoft);
    this.text(`Page ${no} of ${total}`, 572.6, 8.5, 'M', 7.6, C.gold, 'right');
  }

  /** The big header on the first page: drawn from separate parts, not one flattened picture. */
  bigHeader() {
    const { cfg } = this;
    this.gradient('band', 0, 641.19, W, 200.7);
    this.rect(0, 638.36, W, 2.83, C.gold);

    const x0 = MARGIN;
    const y0 = 655.36; // bottom of the header panel
    const pw = CONTENT_W;
    const ph = 172.35;
    this.gradient('sky', x0, y0, pw, ph);

    // Fireworks in the sky (vector)
    const top = y0 + ph;
    [
      [x0 + 104, top - 22, 3, 19, [255, 222, 89]],
      [x0 + 382, top - 30, 3, 22, [120, 232, 255]],
      [x0 + 26, top - 92, 2.5, 15, [255, 138, 214]],
      [x0 + 512, top - 62, 3, 19, [255, 138, 61]],
      [x0 + 420, top - 88, 2, 13, [255, 222, 89]],
    ].forEach(([x, y, r1, r2, color]) => this.sparkle(x, y, r1, r2, color, 0.6, 1));

    // Products at the bottom corners, under the lettering
    this.picture('productsLeft', x0 + 2, y0 + 1, { h: 82 });
    const gift = this.images.productsRight;
    if (gift) this.picture('productsRight', x0 + pw - 4 - (92 * gift.w) / gift.h, y0 + 1, { h: 92 });

    // Top row: optional image, Diwali badge, Peacock + STANDARD
    let left = x0 + 8;
    if (this.images.extra) left += this.picture('extra', left, top - 54, { w: 58, h: 50 }) + 6;
    if (this.images.badge) this.picture('badge', left, top - 50, { w: 58, h: 46 });
    const logoY = top - 47;
    const peacockW = this.images.peacock ? (42 * this.images.peacock.w) / this.images.peacock.h : 0;
    const wordW = this.images.standard ? (38 * this.images.standard.w) / this.images.standard.h : 0;
    let lx = x0 + pw / 2 - (peacockW + wordW + 8) / 2 - 22;
    if (peacockW) this.picture('peacock', lx, logoY + 1, { h: 42 });
    lx += peacockW + 8;
    if (wordW) this.picture('standard', lx, logoY + 3, { h: 38 });

    // Phone box
    const bx = x0 + pw - 112;
    this.rounded(bx, top - 42, 104, 34, 4, C.white);
    this.text(cfg.stickerLabel, bx + 52, top - 19.5, 'B', 5.6, C.red, 'center');
    const phoneSize = this.fit(cfg.stickerPhone, 'B', 13, 96);
    this.text(cfg.stickerPhone, bx + 52, top - 34, 'B', phoneSize, C.dark, 'center');

    // Lettering
    const cx = x0 + pw / 2;
    const titleSize = this.fit(cfg.headTitle, 'S', 60, 430, 30);
    this.outlined(cfg.headTitle, cx, y0 + 66, 'S', titleSize, [226, 19, 28], C.white, 3.2, [70, 8, 60]);

    const pillSize = this.fit(cfg.headPill, 'L', 15, 250, 9);
    const pillW = this.width(cfg.headPill, 'L', pillSize) + 34;
    this.rounded(cx - pillW / 2 - 1.2, y0 + 37.8, pillW + 2.4, 22.4, 11.2, C.white);
    this.gradient('pinkPill', cx - pillW / 2, y0 + 39, pillW, 20, 10);
    this.text(cfg.headPill, cx, y0 + 44, 'L', pillSize, [255, 240, 60], 'center');

    const lineSize = this.fit(cfg.headLine, 'L', 16.5, 250, 9);
    this.outlined(cfg.headLine, cx, y0 + 20, 'L', lineSize, [14, 140, 62], C.white, 2, null);
    const acceptSize = this.fit(cfg.headAccept, 'B', 10, 290, 7);
    this.text(cfg.headAccept, cx, y0 + 6, 'B', acceptSize, C.white, 'center');
  }

  /** The slim bar on later pages. */
  slimHeader() {
    const { cfg } = this;
    this.gradient('maroon', 0, 796.54, W, 45.35);
    this.rect(0, 793.98, W, 2.55, C.gold);
    this.sparkle(34.02, 819.21, 3.2, 12, C.gold, 0.9, 1.47);
    const nameSize = this.fit(cfg.brandName, 'B', 15, 270, 9);
    this.text(cfg.brandName, 51, 819.8, 'B', nameSize, C.white);
    const lineSize = this.fit(cfg.brandLine, 'R', 7.8, cfg.offerOn ? 280 : 500);
    this.text(cfg.brandLine, 51, 807.3, 'R', lineSize, C.gold);
    if (!cfg.offerOn) return;
    this.star(362.83, 819.21, 20.41, 17, 14, C.gold);
    this.doc.setFillColor(...C.red);
    this.doc.circle(362.83, H - 819.21, 14.74, 'F');
    this.text(cfg.offerValue, 362.83, 819.8, 'B', this.fit(cfg.offerValue, 'B', 8.4, 24), C.white, 'center');
    this.text(cfg.offerBottom, 362.83, 811.3, 'B', 5.4, C.gold, 'center');
    this.rounded(391.18, 807.87, 181.42, 22.68, 11.34, C.gold);
    this.text(cfg.offerPill, 481.9, 816.4, 'B', this.fit(cfg.offerPill, 'B', 8.6, 168), C.red, 'center');
  }

  /** Section title card. `y` is the bottom of the card. */
  hero(y, { label, title, sub, showExclusion }) {
    const { cfg, doc } = this;
    const x = MARGIN;
    this.gradient('maroon', x, y, CONTENT_W, HERO_H, 11.34);

    this.text(label, x + 19.84, y + 85.07, 'M', 8, C.gold);
    const words = String(title).trim().split(/\s+/);
    const split = words.length > 1 ? words.length - 1 : 1;
    const line1 = words.slice(0, split).join(' ');
    const line2 = words.slice(split).join(' ');
    const maxW = cfg.offerOn ? 175 : 500;
    const size = Math.min(this.fit(line1, 'B', 19, maxW, 10), this.fit(line2, 'B', 19, maxW, 10));
    if (line2) {
      this.text(line1, x + 19.84, y + 60.97, 'B', size, C.white);
      this.text(line2, x + 19.84, y + 39.67, 'B', size, C.white);
    } else {
      this.text(line1, x + 19.84, y + 50.3, 'B', size, C.white);
    }
    this.text(sub, x + 19.84, y + 21.27, 'R', 8.5, C.goldSoft);

    if (!cfg.offerOn) return;

    this.sparkle(x + 214.47, y + 90.71, 3, 9.64, C.gold, 0.7, 1.25);
    this.sparkle(x + 335.45, y + 95.24, 2.35, 8.5, C.sparkB, 0.7, 1.11);
    this.sparkle(x + 340.95, y + 18.14, 2.1, 7.38, C.sparkA, 0.7, 0.96);
    this.sparkle(x + 211.72, y + 22.68, 1.87, 6.24, C.sparkB, 0.7, 0.81);

    const cx = x + 274.96;
    const cy = y + 56.69;
    this.star(cx, cy, 52.44, 43.94, 18, C.gold);
    doc.setFillColor(...C.red);
    doc.circle(cx, H - cy, 38.55, 'F');
    doc.setDrawColor(...C.gold);
    doc.setLineWidth(0.8);
    doc.setLineDashPattern([1.5, 1.5], 0);
    doc.circle(cx, H - cy, 35.15, 'S');
    doc.setLineDashPattern([], 0);
    this.text(cfg.offerTop, cx, y + 74.27, 'B', 7.5, C.gold, 'center');
    this.text(cfg.offerValue, cx, y + 51.57, 'B', this.fit(cfg.offerValue, 'B', 21, 58, 10), C.white, 'center');
    this.text(cfg.offerBottom, cx, y + 34.57, 'B', 9.5, C.gold, 'center');

    // Gold card; moves up a little when the exclusions line sits under it
    const lift = showExclusion && cfg.offerExclusion ? 7.1 : 0;
    const left = x + 368.51;
    const width = 164.4;
    this.gradient('goldCard', left, y + 18.43 + lift, width, 76.53, 8.5);
    doc.setDrawColor(...C.red);
    doc.setLineWidth(0.8);
    doc.setLineDashPattern([2, 1.6], 0);
    doc.roundedRect(left + 4.25, H - (y + 90.71 + lift), width - 8.5, 68.03, 5.67, 5.67, 'S');
    doc.setLineDashPattern([], 0);
    const mid = left + width / 2;
    this.text(cfg.offerCardTitle, mid, y + 75.07 + lift, 'B', this.fit(cfg.offerCardTitle, 'B', 7.6, width - 20), C.red, 'center');
    this.text(cfg.offerCardDate, mid, y + 51.07 + lift, 'B', this.fit(cfg.offerCardDate, 'B', 19, width - 16, 9), C.dark, 'center');
    this.text(cfg.offerCardSub, mid, y + 33.17 + lift, 'M', this.fit(cfg.offerCardSub, 'M', 7.4, width - 16), C.red, 'center');
    if (showExclusion && cfg.offerExclusion) {
      this.text(cfg.offerExclusion, mid, y + 9.07, 'I', this.fit(cfg.offerExclusion, 'I', 6.6, width + 4), C.goldSoft, 'center');
    }
  }

  /** Highlighted note strip. `y` is the bottom of the strip. */
  note(y) {
    const { cfg } = this;
    this.rounded(MARGIN, y, CONTENT_W, NOTE_H, 6, [255, 244, 214]);
    this.doc.setDrawColor(...C.gold);
    this.doc.setLineWidth(0.9);
    this.doc.roundedRect(MARGIN, H - y - NOTE_H, CONTENT_W, NOTE_H, 6, 6, 'S');
    const size = this.fit(cfg.note, 'B', 9.5, CONTENT_W - 24, 6);
    this.text(cfg.note, W / 2, y + 7, 'B', size, C.dark, 'center');
  }

  /** Category heading bar. `top` is the top edge of the bar. */
  bar(top, title, note, count, isStandard) {
    const y = top - BAR_H;
    this.gradient(isStandard ? 'barStd' : 'barOth', MARGIN, y, CONTENT_W, BAR_H, 7.09);
    this.rounded(MARGIN, y, 6.24, BAR_H, 2.83, C.gold);
    this.sparkle(MARGIN + 21.26, y + 14.17, 2.2, 8.5, C.gold, 0.9, 1.25);

    const label = `${count} ITEMS`;
    const labelW = this.width(label, 'B', 8);
    const pillW = labelW + 17;
    const pillX = MARGIN + 541.42 - pillW;
    const { doc } = this;
    doc.saveGraphicsState();
    doc.setGState(new doc.GState({ opacity: 0.45 }));
    this.rounded(pillX, y + 6.8, pillW, 14.74, 7.37, C.dark);
    doc.restoreGraphicsState();
    this.text(label, pillX + pillW / 2, y + 11.4, 'B', 8, C.white, 'center');

    const maxTitle = pillX - (MARGIN + 36.8) - 8;
    const size = this.fit(title, 'B', 13, maxTitle, 8);
    this.text(title, MARGIN + 36.8, y + 9.6, 'B', size, C.white);
    if (note) {
      const tw = this.width(title, 'B', size);
      const n = ` · ${note}`;
      const left = maxTitle - tw;
      if (left > 20) this.text(n, MARGIN + 36.8 + tw + 1, y + 9.8, 'I', this.fit(n, 'I', 8.2, left, 5), C.goldSoft);
    }
  }

  /** Column titles + rows. `top` is the top edge. Returns the bottom edge. */
  table(top, rows) {
    const { cfg, doc } = this;
    const h = HEAD_H + rows.length * ROW_H;
    const bottom = top - h;
    this.rect(MARGIN, top - HEAD_H, CONTENT_W, HEAD_H, C.dark);
    this.rect(COL.finalLeft, top - HEAD_H, COL.finalW, HEAD_H, C.gold);
    this.rect(COL.finalLeft, bottom, COL.finalW, rows.length * ROW_H, C.finalBg);

    const hy = top - 10.2;
    const hs = 7.8;
    this.text('#', COL.no, hy, 'M', hs, C.goldSoft, 'center');
    this.text(cfg.colProduct, COL.product, hy, 'M', hs, C.goldSoft);
    this.text(cfg.colBrand, COL.brand, hy, 'M', hs, C.goldSoft);
    this.text(cfg.colBox, COL.box, hy, 'M', hs, C.goldSoft, 'center');
    this.text(cfg.colPcs, COL.pcs, hy, 'M', hs, C.goldSoft, 'center');
    this.text(cfg.colAmount, COL.amount, hy, 'M', hs, C.goldSoft, 'right');
    this.text(cfg.colDiscount, COL.discount, hy, 'M', hs, C.goldSoft, 'right');
    this.text(cfg.colFinal, COL.finalRight, hy, 'B', this.fit(cfg.colFinal, 'B', 8, COL.finalW - 6), C.dark, 'right');

    rows.forEach((p, i) => {
      const rowTop = top - HEAD_H - i * ROW_H;
      const rowBottom = rowTop - ROW_H;
      if (i % 2 === 1) this.rect(MARGIN, rowBottom, 490.39, ROW_H, C.alt);
      doc.setDrawColor(...C.rule);
      doc.setLineWidth(0.4);
      doc.line(MARGIN, H - rowBottom, MARGIN + CONTENT_W, H - rowBottom);

      const base = rowTop - 12.35;
      this.text(p.listNo, COL.no, rowTop - 11.75, 'R', 7.6, C.muted, 'center');
      this.text(p.name, COL.product, base, 'M', this.fit(p.name, 'M', 9.2, COL.brand - COL.product - 6, 6), C.ink);
      const brand = p.brand ?? '–';
      this.text(brand, COL.brand, rowTop - 11.75, 'R', this.fit(brand, 'R', 7.6, 78, 5), C.muted);
      this.text(p.box ?? '–', COL.box, rowTop - 12.25, 'R', 9, C.ink, 'center');
      this.text(p.pcsPerBox ?? '–', COL.pcs, rowTop - 12.25, 'R', 9, C.ink, 'center');
      this.text(money(p.amount), COL.amount, base, 'R', 9.2, C.ink, 'right');
      this.text(`– ${money(p.discount)}`, COL.discount, rowTop - 12.15, 'R', 8.8, C.discount, 'right');
      this.text(money(p.finalPrice), COL.finalRight, rowTop - 12.85, 'B', 10.6, C.red, 'right');
    });

    doc.setDrawColor(...C.frame);
    doc.setLineWidth(0.6);
    doc.rect(MARGIN, H - top, CONTENT_W, h, 'S');
    return bottom;
  }
}

/**
 * Creates one PDF and returns it as a Blob.
 * @param {object} catalog   the live price list (prices and items as edited by the shop)
 * @param {object} opts      { config, section: 'all'|'standard'|'others', soldOut, hideSoldOut, customImages }
 */
export async function buildPriceListPdf(catalog, { config = {}, section = 'all', soldOut, hideSoldOut, customImages } = {}) {
  const cfg = { ...PDF_DEFAULTS, ...config };
  const sections = buildSections(catalog, { section, soldOut, hideSoldOut });
  if (!sections.length) throw new Error('There are no items to print.');

  const doc = new jsPDF({ unit: 'pt', format: [W, H], compress: true });
  await Promise.all(Object.values(FONTS).map(async (name) => {
    doc.addFileToVFS(`${name}.ttf`, await loadFont(name));
    doc.addFont(`${name}.ttf`, name, 'normal');
  }));
  doc.setProperties({ title: `${cfg.headTitle} – Price List`, author: cfg.headTitle, creator: cfg.headTitle });

  const page = new Page(doc, buildDecor(), cfg, await loadHeaderImages(customImages));

  // Footers go on last, once the page count is known.
  let first = true;
  const newPage = () => {
    if (!first) doc.addPage([W, H]);
    if (first) page.bigHeader();
    else page.slimHeader();
    const top = first ? PAGE1_TOP : PAGE_TOP;
    first = false;
    return top;
  };

  for (const s of sections) {
    const isStd = s.id === 'standard';
    let cursor = newPage();
    page.hero(cursor - HERO_H, {
      label: isStd ? cfg.stdLabel : cfg.othLabel,
      title: isStd ? cfg.stdTitle : cfg.othTitle,
      sub: `${s.count} items · ${isStd ? cfg.stdSub : cfg.othSub}`,
      showExclusion: !isStd,
    });
    cursor -= HERO_H;
    if (cfg.note) {
      cursor -= 7;
      page.note(cursor - NOTE_H);
      cursor -= NOTE_H;
    }
    cursor -= GROUP_GAP;

    for (const { cat, rows } of s.groups) {
      const title = isStd ? cfg.stdBar : cat.name.toUpperCase();
      const whole = BAR_H + BAR_GAP + HEAD_H + rows.length * ROW_H;
      const room = cursor - PAGE_BOTTOM;
      const splits = rows.length > KEEP_TOGETHER;
      const minStart = BAR_H + BAR_GAP + HEAD_H + MIN_SPLIT_ROWS * ROW_H;
      if (whole > room && (!splits || room < minStart)) cursor = newPage();

      page.bar(cursor, title, cat.note, rows.length, isStd);
      cursor -= BAR_H + BAR_GAP;

      let rest = rows;
      while (rest.length) {
        const fit = Math.floor((cursor - PAGE_BOTTOM - HEAD_H) / ROW_H);
        if (fit < 1) {
          cursor = newPage();
          continue;
        }
        const part = rest.slice(0, fit);
        cursor = page.table(cursor, part);
        rest = rest.slice(fit);
        if (rest.length) cursor = newPage();
      }
      cursor -= GROUP_GAP;
    }
  }

  const total = doc.getNumberOfPages();
  for (let n = 1; n <= total; n++) {
    doc.setPage(n);
    page.footer(n, total);
  }
  return doc.output('blob');
}
