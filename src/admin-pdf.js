// Admin "Price list PDF" tab: edit everything printed on the PDF, then export it from the live prices.
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { escapeHtml, isNativeApp } from './lib/catalog.js';
import { PDF_DEFAULTS, PDF_FORM, PDF_IMAGES } from './lib/pdf-config.js';

const IMAGE_MAX_PX = 900;
const IMAGE_MAX_CHARS = 900_000; // Firestore documents are limited to 1 MB

let ctx; // { db, toast, getCatalog, getSoldOut }
let config = { ...PDF_DEFAULTS };
let customImages = {};
let loaded = false;
const $ = (sel) => document.querySelector(sel);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

function fieldHtml(f) {
  const v = config[f.key];
  if (f.type === 'check') {
    return `<label class="switch"><input type="checkbox" name="${f.key}" ${v ? 'checked' : ''} /> ${escapeHtml(f.label)}</label>`;
  }
  const note = f.key === 'note'
    ? `<label class="pdf-date">Or pick a date: <input type="date" id="pdf-note-date" /></label>`
    : '';
  return `<label>${escapeHtml(f.label)}
      <input name="${f.key}" value="${escapeHtml(v)}" maxlength="${f.max ?? 120}" placeholder="${escapeHtml(f.placeholder ?? '')}" autocomplete="off" />
    </label>${note}`;
}

function renderForm() {
  $('#pdf-groups').innerHTML = PDF_FORM.map((g) => `<details class="a-card pdf-group" ${g.open ? 'open' : ''}>
      <summary>${escapeHtml(g.title)}</summary>
      ${g.help ? `<p class="muted pdf-help">${escapeHtml(g.help)}</p>` : ''}
      <div class="a-form">${g.fields.map(fieldHtml).join('')}</div>
    </details>`).join('');
}

function renderImages() {
  $('#pdf-images').innerHTML = PDF_IMAGES.map(({ slot, label, file }) => {
    const c = customImages[slot];
    const src = c?.hidden ? null : c?.data ?? file;
    const state = c?.hidden ? 'Hidden' : c?.data ? 'Your image' : file ? 'Built-in image' : 'Empty';
    return `<div class="pdf-image" data-slot="${slot}">
        <div class="pdf-thumb">${src ? `<img src="${escapeHtml(src)}" alt="" />` : '—'}</div>
        <div class="pdf-image-body">
          <strong>${escapeHtml(label)}</strong>
          <span class="muted">${state}</span>
          <div class="d-row-btns">
            <label class="btn btn-sm btn-soft">Replace<input type="file" accept="image/*" hidden data-img="upload" /></label>
            ${file && !c?.hidden ? '<button type="button" class="btn btn-sm btn-soft" data-img="hide">Hide</button>' : ''}
            ${c ? `<button type="button" class="btn btn-sm btn-soft" data-img="reset">${file ? 'Use built-in' : 'Remove'}</button>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

function readForm() {
  const f = $('#pdf-form');
  const out = {};
  for (const g of PDF_FORM) {
    for (const { key, type } of g.fields) out[key] = type === 'check' ? f[key].checked : f[key].value.trim();
  }
  return out;
}

async function saveConfig() {
  const next = readForm();
  const changed = Object.keys(next).some((k) => next[k] !== config[k]);
  config = { ...config, ...next };
  if (changed) {
    await setDoc(doc(ctx.db, 'settings', 'pdf'), { ...next, updatedAt: serverTimestamp() }, { merge: true });
  }
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(new Error('Could not read the PDF'));
  r.readAsDataURL(blob);
});

/** Android app: saves to Documents/BestFireWorks and opens the share sheet. Browser: normal download. */
async function deliver(files) {
  if (!isNativeApp) {
    for (const { name, blob } of files) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 20000);
      await new Promise((r) => setTimeout(r, 400)); // browsers drop a second download started in the same instant
    }
    return 'Downloaded.';
  }
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
  const uris = [];
  let saved = true;
  for (const { name, blob } of files) {
    const data = await blobToBase64(blob);
    const { uri } = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache });
    uris.push(uri);
    await Filesystem.writeFile({ path: `BestFireWorks/${name}`, data, directory: Directory.Documents, recursive: true })
      .catch(() => { saved = false; });
  }
  await Share.share({ title: 'Best FireWorks price list', files: uris, dialogTitle: 'Send or save the price list' })
    .catch(() => {}); // closing the share sheet counts as an error
  return saved ? 'Saved in your phone’s Documents/BestFireWorks folder.' : 'Ready. Use the share sheet to send or save it.';
}

async function exportPdf(kind, btn) {
  const status = $('#pdf-status');
  const catalog = ctx.getCatalog();
  if (!catalog) return ctx.toast('The price list is still loading. Try again in a moment.');
  document.querySelectorAll('[data-pdf]').forEach((b) => { b.disabled = true; });
  const label = btn.textContent;
  btn.textContent = 'Creating PDF…';
  status.textContent = '';
  try {
    await saveConfig().catch((e) => { throw new Error(`Could not save your changes: ${e.message}`); });
    const { buildPriceListPdf } = await import('./lib/price-pdf.js');
    const opts = {
      config,
      customImages,
      soldOut: new Set(ctx.getSoldOut()),
      hideSoldOut: $('#pdf-hide-soldout').checked,
    };
    const stamp = today();
    const make = async (section, suffix) => ({
      name: `BestFireWorks_PriceList${suffix}_${stamp}.pdf`,
      blob: await buildPriceListPdf(catalog, { ...opts, section }),
    });
    const files = kind === 'two'
      ? [await make('standard', '_Standard'), await make('others', '_OtherBrands')]
      : [await make(kind, { all: '', standard: '_Standard', others: '_OtherBrands' }[kind])];
    const size = files.reduce((n, f) => n + f.blob.size, 0) / 1024;
    const done = await deliver(files);
    status.textContent = `${done} ${files.length > 1 ? `${files.length} files, ` : ''}${size.toFixed(0)} KB in total.`;
  } catch (err) {
    console.error(err);
    status.textContent = `Could not create the PDF: ${err.message}`;
  } finally {
    btn.textContent = label;
    document.querySelectorAll('[data-pdf]').forEach((b) => { b.disabled = false; });
  }
}

/** Shrinks an uploaded header image; keeps PNG when it has transparency, otherwise JPEG. */
async function prepareImage(file) {
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, IMAGE_MAX_PX / Math.max(bmp.width, bmp.height));
  for (let attempt = 0; attempt < 5; attempt++) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let transparent = false;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] < 250) { transparent = true; break; }
    }
    const data = transparent ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.88);
    if (data.length <= IMAGE_MAX_CHARS) return data;
    scale *= 0.75;
  }
  throw new Error('This image is too large. Try a smaller one.');
}

async function loadSaved() {
  const [cfgSnap, ...imgSnaps] = await Promise.all([
    getDoc(doc(ctx.db, 'settings', 'pdf')),
    ...PDF_IMAGES.map(({ slot }) => getDoc(doc(ctx.db, 'settings', `pdfimg-${slot}`))),
  ]);
  config = { ...PDF_DEFAULTS, ...(cfgSnap.data() ?? {}) };
  delete config.updatedAt;
  customImages = {};
  PDF_IMAGES.forEach(({ slot }, i) => {
    if (imgSnaps[i].exists()) customImages[slot] = imgSnaps[i].data();
  });
}

function formatNoteDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const text = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `Prices valid till ${text}`;
}

export async function openPdfTab() {
  if (loaded) return;
  loaded = true;
  $('#pdf-status').textContent = 'Loading your saved settings…';
  try {
    await loadSaved();
    $('#pdf-status').textContent = '';
  } catch (err) {
    loaded = false;
    $('#pdf-status').textContent = `Could not load saved settings: ${err.message}`;
  }
  renderForm();
  renderImages();
}

export function setupPdfTab(context) {
  ctx = context;
  $('#tab-pdf').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pdf]');
    if (b) return exportPdf(b.dataset.pdf, b);
    const act = e.target.closest('[data-img]');
    if (act && act.tagName === 'BUTTON') {
      const { slot } = act.closest('[data-slot]').dataset;
      const ref = doc(ctx.db, 'settings', `pdfimg-${slot}`);
      try {
        if (act.dataset.img === 'hide') {
          await setDoc(ref, { hidden: true });
          customImages[slot] = { hidden: true };
        } else {
          await deleteDoc(ref);
          delete customImages[slot];
        }
        renderImages();
      } catch (err) {
        ctx.toast(`Could not save: ${err.message}`);
      }
    }
  });
  $('#tab-pdf').addEventListener('change', async (e) => {
    if (e.target.id === 'pdf-note-date' && e.target.value) {
      $('#pdf-form').note.value = formatNoteDate(e.target.value);
      return;
    }
    if (e.target.dataset.img !== 'upload') return;
    const file = e.target.files?.[0];
    const { slot } = e.target.closest('[data-slot]').dataset;
    e.target.value = '';
    if (!file) return;
    try {
      const data = await prepareImage(file);
      await setDoc(doc(ctx.db, 'settings', `pdfimg-${slot}`), { data });
      customImages[slot] = { data };
      renderImages();
      ctx.toast('Image saved');
    } catch (err) {
      ctx.toast(err.message);
    }
  });
  $('#pdf-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await saveConfig();
      ctx.toast('PDF settings saved');
    } catch (err) {
      ctx.toast(`Could not save: ${err.message}`);
    }
  });
  $('#pdf-reset').addEventListener('click', () => {
    if (!confirm('Put all the PDF text back to the original wording?')) return;
    config = { ...config, ...PDF_DEFAULTS };
    renderForm();
    ctx.toast('Restored. Tap Save to keep it.');
  });
}
