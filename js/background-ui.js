// background-ui.js — lets you pick a custom background for the Bureau (the
// home screen): a few dark presets, or your own photo. Stored locally only
// (IndexedDB's generic `cache` store, see db.js) — the choice itself under
// 'bureauBackground', an uploaded photo's bytes as a Blob under
// 'bureauBackgroundImage' (IndexedDB stores Blobs natively, no base64
// round-trip and its ~33% size bloat).
//
// The actual backdrop is #bureauBackdrop, a position:fixed div in
// index.html itself — deliberately NOT part of renderDesktop's own
// returned HTML. .bento-hive (desktop-ui.js/style.css) uses
// will-change:transform for its levitation animation, and that creates a
// new containing block for any fixed-position descendant (same as an
// actual transform would, per spec) — a backdrop nested inside it would
// end up fixed *to the hive*, not the viewport, and visibly drift with
// that animation instead of staying full-screen. render.js toggles its
// visibility to match state.view instead of this module owning any DOM
// placement.

import * as db from './db.js';
import { openModal, toast } from './ui-kit.js';

// Dark, low-saturation gradients — chosen to stay readable behind the
// Bureau's own translucent, blurred tiles (see .bento-pent in style.css)
// the same way the plain --bg backdrop they replace already is.
const PRESETS = [
  { id: 'nebula', label: 'Nebula', css: 'radial-gradient(circle at 30% 20%, #2A2450 0%, #0D1114 65%)' },
  { id: 'ember', label: 'Ember', css: 'radial-gradient(circle at 70% 15%, #4A2418 0%, #0D1114 65%)' },
  { id: 'abyss', label: 'Abyss', css: 'radial-gradient(circle at 50% 0%, #123047 0%, #0D1114 70%)' },
  { id: 'forest', label: 'Forest', css: 'radial-gradient(circle at 25% 85%, #163425 0%, #0D1114 65%)' },
  { id: 'aurora', label: 'Aurora', css: 'linear-gradient(160deg, #1B2A45 0%, #2A1B3D 45%, #0D1114 85%)' },
];

// Object URL for the currently-applied uploaded photo, if any — tracked so
// it can be revoked when replaced (URLs.createObjectURL leaks otherwise).
let currentImageUrl = null;

function backdropEl() {
  return document.getElementById('bureauBackdrop');
}

function applyNone() {
  const el = backdropEl();
  if (el) el.style.backgroundImage = '';
}
function applyPreset(preset) {
  const el = backdropEl();
  if (el) el.style.backgroundImage = preset.css;
}
function applyImage(url) {
  const el = backdropEl();
  if (!el) return;
  // A dark scrim under the photo keeps tile text/icons readable regardless
  // of how bright the photo is — the same contrast concern .bento-pent's
  // own gradient already accounts for against the plain --bg backdrop.
  el.style.backgroundImage = `linear-gradient(rgba(0,0,0,.4), rgba(0,0,0,.55)), url("${url}")`;
}

// Downscaled + re-encoded before storage: background-size:cover never
// benefits from more pixels than the viewport has, and a raw phone photo
// (10+ MB) would otherwise dominate this app's whole local footprint (see
// index.html's "Local footprint" stat) just for a background image.
async function downscaleImage(file, maxDim = 1920, quality = 0.85) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

async function selectPreset(preset) {
  applyPreset(preset);
  if (currentImageUrl) { URL.revokeObjectURL(currentImageUrl); currentImageUrl = null; }
  await db.put('cache', { key: 'bureauBackground', value: { type: 'preset', presetId: preset.id } });
  toast(`Background set: ${preset.label}`);
}

async function selectImage(file) {
  const blob = await downscaleImage(file);
  if (currentImageUrl) URL.revokeObjectURL(currentImageUrl);
  currentImageUrl = URL.createObjectURL(blob);
  applyImage(currentImageUrl);
  await db.put('cache', { key: 'bureauBackgroundImage', value: blob });
  await db.put('cache', { key: 'bureauBackground', value: { type: 'image' } });
  toast('Background updated');
}

async function selectNone() {
  applyNone();
  if (currentImageUrl) { URL.revokeObjectURL(currentImageUrl); currentImageUrl = null; }
  await db.put('cache', { key: 'bureauBackground', value: { type: 'none' } });
}

// Loads whatever was chosen last time, on boot — mirrors app.js's own
// "resume search live" pattern (a preference from before reload isn't
// meant to reset itself just because the page reloaded).
export async function loadBureauBackground() {
  const pref = await db.get('cache', 'bureauBackground');
  if (!pref?.value || pref.value.type === 'none') return;
  if (pref.value.type === 'preset') {
    const preset = PRESETS.find((p) => p.id === pref.value.presetId);
    if (preset) applyPreset(preset);
    return;
  }
  if (pref.value.type === 'image') {
    const row = await db.get('cache', 'bureauBackgroundImage');
    if (row?.value) {
      currentImageUrl = URL.createObjectURL(row.value);
      applyImage(currentImageUrl);
    }
  }
}

function pickerBodyHtml() {
  const swatches = PRESETS.map((p) => `
    <button type="button" class="bg-swatch" data-preset="${p.id}" style="background:${p.css}">
      <span>${p.label}</span>
    </button>`).join('');
  return `
    <p style="font-size:12.5px;color:var(--mid);margin-bottom:10px">
      Shows full-screen behind the Bureau's tiles. Stored on this device only.
    </p>
    <div class="bg-swatches">
      <button type="button" class="bg-swatch bg-swatch-none" data-preset="none"><span>None</span></button>
      ${swatches}
    </div>
    <button type="button" class="btn ghost" id="bgUploadBtn" style="margin-top:12px;width:100%">Upload a photo…</button>
    <input type="file" id="bgUploadFile" accept="image/*" style="display:none">
  `;
}

export function openBackgroundPicker() {
  return openModal('Bureau background', pickerBodyHtml(), {
    noSubmit: true,
    onOpen: (dlg) => {
      dlg.querySelectorAll('.bg-swatch[data-preset]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.preset;
          if (id === 'none') await selectNone();
          else {
            const preset = PRESETS.find((p) => p.id === id);
            if (preset) await selectPreset(preset);
          }
          dlg.close();
        });
      });
      const uploadFile = dlg.querySelector('#bgUploadFile');
      dlg.querySelector('#bgUploadBtn').addEventListener('click', () => uploadFile.click());
      uploadFile.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) { toast('Pick an image file.'); return; }
        await selectImage(file);
        dlg.close();
      });
    },
  });
}
