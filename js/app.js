import { parsePkpCsv, findPart, suggestParts, normalizeRef, resolveBeakList, partSearchLabel as formatPartSearchLabel, decodePnpBytes } from './pnp.js';
import {
  emptyCal,
  normalizeCal,
  isCalibrated,
  cadToImage,
  pickBestFlips,
} from './calibration.js';
import {
  buildBsuZip,
  loadBsuZip,
  suggestedBsuFilename,
  isBsuFilename,
  isProjectFilename,
  downloadBlob,
} from './projectBsu.js';
import { parseBomPdf, parseBomCsv, normalizeBomList, buildBomLookup, beakKey } from './bom.js';
import {
  parseKundenBomPdf,
  applyKundenValuesToParts,
  serializeKundenByRef,
  deserializeKundenByRef,
} from './kundenBom.js';
import {
  readEncryptedManifest,
  getStoredMasterKey,
  storeMasterKey,
  forgetMasterKey,
  deriveMasterKey,
  verifyMasterKey,
  ensureDeviceVerifier,
  getDeviceVerifier,
  verifyDeviceVerifier,
  encryptProjectZip,
  decryptProjectZip,
  isValidCode,
  sanitizeCodeInput,
} from './projectCrypto.js';

const VERSION = 'V1.5.8';
const ACCENT = '#dd007a'; // Bestückungsplan Sichern / --accent
const WARN_ORANGE = '#f59e0b'; // wie Kalibrierungs-Banner / --warn-Familie
const CURSOR_GRAY = '#9ca3af'; // manual click/tap crosshair (distinct from search pink)
const PART_DOT = 'rgba(249, 168, 212, 0.85)'; // light pink — all parts after calibration
/** Pre-invert multiply color: after canvas difference+white → PART_DOT pink.
 *  Drawing dots with multiply *before* invert mirrors light mode so plan ink stays on top. */
const PART_DOT_PRE_INVERT = 'rgba(6, 87, 43, 0.85)'; // 255 - PART_DOT RGB
const CURSOR_HIDE_MS = 5000;
const REFS_ONLY_ID = '__refs_only__';
const REFS_ONLY_LABEL = 'Nur Bauteil Referenzen';
const STORAGE_KEY = 'plan-suche-v1';

const el = {
  app: document.getElementById('app'),
  menuBtn: document.getElementById('menuBtn'),
  chrome: document.getElementById('chrome'),
  menuBackdrop: document.getElementById('menuBackdrop'),
  drawer: document.getElementById('drawer'),
  drawerMain: document.getElementById('drawerMain'),
  drawerEdit: document.getElementById('drawerEdit'),
  drawerStack: document.getElementById('drawerStack'),
  search: document.getElementById('searchInput'),
  suggestions: document.getElementById('suggestions'),
  boardWrap: document.getElementById('boardWrap'),
  canvas: document.getElementById('boardCanvas'),
  overlay: document.getElementById('boardOverlay'),
  empty: document.getElementById('emptyState'),
  pdfInput: document.getElementById('pdfInput'),
  pnpInput: document.getElementById('pnpInput'),
  variantInput: document.getElementById('variantInput'),
  bsuInput: document.getElementById('bsuInput'),
  bomInput: document.getElementById('bomInput'),
  pnpReplaceInput: document.getElementById('pnpReplaceInput'),
  toast: document.getElementById('appToast'),
  searchLager: document.getElementById('searchLager'),
  menuSetRef: document.getElementById('menuSetRef'),
  docTitle: document.getElementById('docTitle'),
  calBanner: document.getElementById('calNeededBanner'),
  calSetBtn: document.getElementById('calSetBtn'),
  welcome: document.getElementById('welcomeScreen'),
  welcomeOpenBtn: document.getElementById('welcomeOpenBtn'),
  welcomeNewBtn: document.getElementById('welcomeNewBtn'),
  welcomeVersion: document.getElementById('welcomeVersion'),
  variantBar: document.getElementById('variantBar'),
  variantCurrentBtn: document.getElementById('variantCurrentBtn'),
  variantPicker: document.getElementById('variantPicker'),
  variantPickerTitle: document.getElementById('variantPickerTitle'),
  variantPickerSub: document.getElementById('variantPickerSub'),
  variantPickerActions: document.getElementById('variantPickerActions'),
  flipPanel: document.getElementById('flipPanel'),
  flipXBtn: document.getElementById('flipXBtn'),
  flipYBtn: document.getElementById('flipYBtn'),
  flipPanelDone: document.getElementById('flipPanelDone'),
  boardZoomBtns: document.getElementById('boardZoomBtns'),
  btnZoomFit: document.getElementById('btnZoomFit'),
};

/** 'add' | 'renew' — how variantInput applies the chosen P&P file */
let variantFileMode = 'add';
/** 'smd' | 'bg' — which Stückliste bomInput loads */
let bomFileSource = 'smd';
const BOM_LABEL = { smd: 'SMD BG Stückl. (Lager-Stückl. Artikel-Bez.)', bg: 'BG Stückl. (Lager-Stückl. Artikel-Bez.)' };

const state = {
  parts: [],
  pdfName: '',
  pnpName: '',
  projectName: '',
  openFileName: '',
  /** @type {FileSystemFileHandle|null} in-memory only (FS Access API) */
  openFileHandle: null,
  pdfBytes: null, // Uint8Array of plan PDF/image for project .zip
  pnpText: '', // raw Pick&Place text for project .zip
  /** @type {Array<{ id: string, name: string, pnpName: string, pnpText: string, parts: object[] }>} */
  variants: [],
  activeVariantId: null,
  pageBitmap: null, // ImageBitmap | HTMLCanvasElement — cropped board in image space
  pageW: 0,
  pageH: 0,
  /** Uncropped base-render size (PDF at PDF_BASE_SCALE or natural image). */
  fullW: 0,
  fullH: 0,
  /** Content crop in full-page base pixels: {x,y,w,h}. Display/cal use cropped space. */
  crop: null,
  /** True when board came from PDF (vector re-render on zoom). PNG/JPEG stay raster. */
  isPdfSource: false,
  /** pageBitmap device-px per image-space unit (PDF hi-res tiles; 1 for raster). */
  pdfBmpScale: 1,
  /** Sharp viewport tile over the base bitmap: { canvas, x, y, w, h (image space), scale } */
  pdfTile: null,
  zoom: 1,
  pan: { x: 0, y: 0 },
  cal: emptyCal(),
  cursorPos: null, // last click in image pixels
  searchHit: null,
  crosshair: null, // {x,y} image px for searched part
  menuOpen: false,
  editMenuOpen: false,
  pendingFit: true,
  welcomeDismissed: false,
  variantPickerOpen: false,
  flipPanelOpen: false,
  /** 'pick' | 'remove' — mode for the big-button variant overlay */
  variantPickerMode: 'pick',
  /** After load, show picker once board+variants are ready (unless user already picked). */
  pendingVariantPick: false,
  /** Stücklisten: { name, title, edv, entries:[{beak,key,lagerplatz,beschreibung}] } per source */
  boms: { smd: null, bg: null },
  /** @type {Map<string, {lagerplatz:string, beschreibung:string, source:'smd'|'bg'}>} BEAK key → Lager */
  bomLookup: new Map(),
  /** @type {{ sourceName?: string, byRef: Record<string,{value:string,beak:string,key:string}> }|null} */
  pnpValueReplace: null,
};

let pdfjsLib = null;
let pdfDoc = null;
/** @type {import('../vendor/pdfjs/pdf.min.mjs').PDFPageProxy | null} */
let pdfPage = null;
let pdfRenderGen = 0;
/** pdf.js RenderTask in flight (cancelable). */
let pdfRenderTask = null;
/** Debounce for detail renders after programmatic (non-gesture) view changes. */
const PROGRAMMATIC_DETAIL_MS = 60;
let pdfRerenderTimer = null;
let pdfDetailBusy = false;
let pdfRerenderPending = false;
let pdfDetailErrorAt = -Infinity;
/** Plan currently being rendered by refreshPdfDetail (for the idle stale check). */
let pdfInflightPlan = null;

const PDF_BASE_SCALE = 2;
/** Cap bitmap resolution (device px per image-space unit) to limit memory. */
const PDF_MAX_BMP_SCALE = 6;
const ZOOM_MAX = 16;
/**
 * Device perf profile. iPhone/iPad (html.ios-touch, incl. iPadOS desktop UA) have tight
 * canvas memory (~16.7 MP per canvas in Safari) and slow full-screen re-blur, so:
 * - base page bitmap is capped by a pixel budget (not just by scale)
 * - deep zoom sharpness comes from a viewport tile (visible region + margin) rendered on settle
 */
const IS_IOS_TOUCH = document.documentElement.classList.contains('ios-touch');
const PERF = IS_IOS_TOUCH
  ? { baseMaxPx: 3e6, tileMaxPx: 7e6, tileMargin: 0.2, settleMs: 220, lowSmoothingWhileMoving: true }
  : { baseMaxPx: 16e6, tileMaxPx: 24e6, tileMargin: 0.5, settleMs: 140, lowSmoothingWhileMoving: false };

/** Touch UI (iPhone/iPad / coarse pointer). */
function isTouchUi() {
  return IS_IOS_TOUCH || window.matchMedia('(pointer: coarse)').matches;
}
function orientBucket() {
  const typ = screen.orientation?.type;
  if (typ) return String(typ).includes('landscape') ? 'landscape' : 'portrait';
  return window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait';
}
let lastOrientBucket = orientBucket();
let touchOrientFitTimer = 0;
function scheduleTouchOrientFit(_reason) {
  if (!isTouchUi()) return;
  clearTimeout(touchOrientFitTimer);
  touchOrientFitTimer = setTimeout(() => {
    touchOrientFitTimer = 0;
    invalidateBoardLayout();
    syncShellToViewport();
    syncChromeOffset();
    lastOrientBucket = orientBucket();
    if (state.pageBitmap) {
      state.pendingFit = true;
      draw(); // remasures canvas + applies fit
      updateFitBtnVisibility();
      fitDocTitle();
      fitSearchLabelFont();
    }
  }, 280);
}

const PDF_WHITE_THR = 245; // RGB >= thr → margin white
const PDF_CROP_PAD = 4;

let drag = null;
const pointers = new Map();
/** Wheel zoom counts as "interacting" until this time (performance.now()). */
let wheelActiveUntil = 0;
let wheelSettleTimer = null;
let drawRaf = 0;
/** Last measured board CSS size — reused during gestures (no layout reads per frame). */
let lastBoardSize = null;
/** ?perfdebug → draw timings for automated perf tests */
const perfDebug = /[?&]perfdebug\b/.test(location.search) ? { drawMs: [] } : null;

function isInteracting() {
  return pointers.size > 0 || performance.now() < wheelActiveUntil;
}

/** Coalesce redraws to one per animation frame (pointer/wheel events fire faster). */
function requestDraw() {
  if (drawRaf) return;
  drawRaf = requestAnimationFrame(() => {
    drawRaf = 0;
    draw();
  });
}
let pinch = null;
let sugActiveIndex = -1;
let cursorHideTimer = null;

function setStatus(_msg) {
  /* Statusbar entfernt */
}

let toastTimer = null;
/** Short visible message (status bar was removed) — used for Stückliste load results. */
function showToast(msg, ms = 4000) {
  if (!el.toast) return;
  el.toast.textContent = msg;
  el.toast.hidden = !msg;
  clearTimeout(toastTimer);
  if (msg) toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}


function stemName(name) {
  const base = (name || '').split(/[/\\]/).pop() || '';
  return base.replace(/\.[^.]+$/, '') || 'Variante';
}

/** Label = Pick&Place basename without extension (.txt/.csv/…). */
function variantDisplayName(v) {
  if (!v) return 'Variante';
  return stemName(v.pnpName) || v.name || 'Variante';
}

function newVariantId() {
  return `v${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function hasProjectContent() {
  return !!(state.pageBitmap || state.pdfBytes || state.parts.length || state.variants.length);
}

function showWelcome(show) {
  if (!el.welcome) return;
  el.welcome.hidden = !show;
  el.app?.classList.toggle('welcome-open', !!show);
  if (el.empty) {
    // empty-state only when welcome is closed and nothing loaded
    el.empty.hidden = show || hasProjectContent();
  }
}

function updateWelcome() {
  const open = !hasProjectContent() && !state.welcomeDismissed;
  showWelcome(open);
  if (el.welcomeVersion) {
    el.welcomeVersion.textContent = `Bauteile Suchen · ${VERSION}`;
  }
}

function isRefsOnlyMode() {
  return state.activeVariantId === REFS_ONLY_ID;
}

/** Merge parts from all loaded P&P variants (unique by designator, first wins). */
function mergeAllVariantParts() {
  const byId = new Map();
  for (const v of state.variants) {
    for (const p of v.parts || []) {
      const key = normalizeRef(p.id);
      if (!key || byId.has(key)) continue;
      byId.set(key, p);
    }
  }
  return [...byId.values()];
}

function syncActiveVariantParts() {
  if (!state.variants.length) {
    state.parts = [];
    state.pnpText = '';
    state.pnpName = '';
    state.activeVariantId = null;
    return null;
  }
  if (isRefsOnlyMode()) {
    state.parts = mergeAllVariantParts();
    const first = state.variants[0];
    state.pnpText = first?.pnpText || '';
    state.pnpName = first?.pnpName || '';
    return { id: REFS_ONLY_ID, name: REFS_ONLY_LABEL, parts: state.parts };
  }
  const v = state.variants.find((x) => x.id === state.activeVariantId) || state.variants[0] || null;
  if (!v) {
    state.parts = [];
    state.pnpText = '';
    state.pnpName = '';
    state.activeVariantId = null;
    return null;
  }
  state.activeVariantId = v.id;
  state.parts = v.parts || [];
  state.pnpText = v.pnpText || '';
  state.pnpName = v.pnpName || '';
  return v;
}

function currentVariantLabel() {
  if (!state.variants.length) return '';
  if (isRefsOnlyMode() || !state.activeVariantId) return REFS_ONLY_LABEL;
  const v = state.variants.find((x) => x.id === state.activeVariantId);
  return v ? variantDisplayName(v) : REFS_ONLY_LABEL;
}

function updateVariantBar() {
  if (!el.variantBar) return;
  const list = state.variants;
  // Main-page variant bar stays hidden after pick; switch via menu only.
  el.variantBar.hidden = true;
  if (!list.length) {
    if (el.variantCurrentBtn) el.variantCurrentBtn.textContent = '';
    syncChromeOffset();
    return;
  }
  if (state.activeVariantId !== REFS_ONLY_ID && !list.some((v) => v.id === state.activeVariantId)) {
    state.activeVariantId = REFS_ONLY_ID;
  }
  if (!state.activeVariantId) state.activeVariantId = REFS_ONLY_ID;
  if (el.variantCurrentBtn) {
    el.variantCurrentBtn.textContent = currentVariantLabel();
  }
  syncChromeOffset();
}

function renderVariantPickerButtons() {
  if (!el.variantPickerActions) return;
  el.variantPickerActions.innerHTML = '';
  const mode = state.variantPickerMode || 'pick';
  const cur = state.activeVariantId || REFS_ONLY_ID;

  if (el.variantPickerTitle) {
    el.variantPickerTitle.textContent =
      mode === 'remove' ? 'Variante entfernen' : 'Bestückungsvariante wählen';
  }
  if (el.variantPickerSub) {
    el.variantPickerSub.textContent =
      mode === 'remove'
        ? 'Welche Bestückungsvariante soll gelöscht werden?'
        : 'Welche Baugruppe soll angezeigt werden?';
  }

  const mk = (id, label, { primary = false, onClick } = {}) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn welcome-btn variant-picker-btn' + (primary ? ' primary' : '');
    if (mode === 'pick' && id === cur) btn.classList.add('active');
    if (mode === 'remove' && id) btn.classList.add('danger');
    btn.dataset.variantId = id || '';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    el.variantPickerActions.appendChild(btn);
  };

  if (mode === 'remove') {
    for (const v of state.variants) {
      const label = variantDisplayName(v);
      mk(v.id, label, {
        onClick: () => {
          removeVariant(v.id);
          hideVariantPicker();
          setStatus(`Variante entfernt: ${label}`);
        },
      });
    }
    mk('', 'Abbrechen', {
      primary: true,
      onClick: () => hideVariantPicker(),
    });
    return;
  }

  // Always first: Nur Bauteil Referenzen (same neutral style as other variants)
  mk(REFS_ONLY_ID, REFS_ONLY_LABEL, {
    onClick: () => {
      applyVariant(REFS_ONLY_ID);
      hideVariantPicker();
      setStatus(`Variante: ${REFS_ONLY_LABEL}`);
    },
  });
  for (const v of state.variants) {
    const label = variantDisplayName(v);
    mk(v.id, label, {
      onClick: () => {
        applyVariant(v.id);
        hideVariantPicker();
        setStatus(`Variante: ${label}`);
      },
    });
  }
}

function showVariantPicker(mode = 'pick') {
  if (!el.variantPicker) return;
  if (!state.variants.length) {
    hideVariantPicker();
    return;
  }
  state.variantPickerMode = mode === 'remove' ? 'remove' : 'pick';
  // Close welcome if somehow still open
  showWelcome(false);
  if (el.suggestions) el.suggestions.hidden = true;
  sugActiveIndex = -1;
  state.variantPickerOpen = true;
  if (state.variantPickerMode === 'pick') state.pendingVariantPick = false;
  renderVariantPickerButtons();
  el.variantPicker.hidden = false;
  el.app?.classList.toggle('variant-picker-open', true);
  openMenu(false);
}

function hideVariantPicker() {
  state.variantPickerOpen = false;
  state.variantPickerMode = 'pick';
  if (el.variantPicker) el.variantPicker.hidden = true;
  el.app?.classList.toggle('variant-picker-open', false);
}

function updateFlipButtons() {
  if (el.flipXBtn) el.flipXBtn.classList.toggle('active', !!state.cal.flipX);
  if (el.flipYBtn) el.flipYBtn.classList.toggle('active', !!state.cal.flipY);
}

function showFlipPanel() {
  if (!el.flipPanel) return;
  showWelcome(false);
  hideVariantPicker();
  if (el.suggestions) el.suggestions.hidden = true;
  sugActiveIndex = -1;
  state.flipPanelOpen = true;
  updateFlipButtons();
  el.flipPanel.hidden = false;
  el.app?.classList.toggle('flip-panel-open', true);
  openMenu(false);
}

function hideFlipPanel() {
  state.flipPanelOpen = false;
  if (el.flipPanel) el.flipPanel.hidden = true;
  el.app?.classList.toggle('flip-panel-open', false);
}

function toggleCalFlip(axis) {
  if (axis !== 'flipX' && axis !== 'flipY') return;
  state.cal = {
    ...state.cal,
    cal1: { ...state.cal.cal1 },
    cal2: { ...state.cal.cal2 },
    [axis]: !state.cal[axis],
  };
  persist();
  updateFlipButtons();
  updateBadges();
  if (state.searchHit) updateCrosshairFromSearch();
  draw();
  setStatus(
    `Spiegelung: X=${state.cal.flipX ? 'an' : 'aus'} Y=${state.cal.flipY ? 'an' : 'aus'}`,
  );
}

function removeVariant(id) {
  if (!id || id === REFS_ONLY_ID) return;
  const idx = state.variants.findIndex((v) => v.id === id);
  if (idx < 0) return;
  const wasActive = state.activeVariantId === id;
  state.variants.splice(idx, 1);
  if (!state.variants.length) {
    state.activeVariantId = null;
    state.parts = [];
    state.pnpText = '';
    state.pnpName = '';
    state.crosshair = null;
    clearCursorPos();
    state.searchHit = null;
    if (el.search) el.search.value = '';
  } else if (wasActive || state.activeVariantId === REFS_ONLY_ID) {
    // Stay on refs-only if that was selected; else fall back to refs-only after delete
    state.activeVariantId = REFS_ONLY_ID;
    syncActiveVariantParts();
  } else if (!state.variants.some((v) => v.id === state.activeVariantId)) {
    state.activeVariantId = REFS_ONLY_ID;
    syncActiveVariantParts();
  } else {
    syncActiveVariantParts();
  }
  // Drop cal if refs no longer exist in active parts
  if (state.cal.cal1.calId && !state.parts.some((p) => p.id === state.cal.cal1.calId)) {
    if (!state.parts.some((p) => p.id === state.cal.cal2.calId)) {
      state.cal = emptyCal();
    }
  }
  if (wasActive || isRefsOnlyMode()) {
    state.crosshair = null;
    clearCursorPos();
    state.searchHit = null;
    if (el.search) el.search.value = '';
  }
  updateVariantBar();
  updateBadges();
  updateWelcome();
  persist();
  draw();
}

function requestVariantPick() {
  state.pendingVariantPick = true;
  if (!state.variants.length) return;
  if (state.pageBitmap) showVariantPicker();
}

function applyVariant(id, { keepSearch = false } = {}) {
  if (id === REFS_ONLY_ID) {
    if (!state.variants.length) return;
    state.activeVariantId = REFS_ONLY_ID;
    state.parts = mergeAllVariantParts();
    const first = state.variants[0];
    state.pnpText = first?.pnpText || '';
    state.pnpName = first?.pnpName || '';
  } else {
    const v = state.variants.find((x) => x.id === id);
    if (!v) return;
    state.activeVariantId = v.id;
    state.parts = v.parts || [];
    state.pnpText = v.pnpText || '';
    state.pnpName = v.pnpName || '';
  }
  // Drop cal IDs that no longer exist in this variant
  if (state.cal.cal1.calId && !state.parts.some((p) => p.id === state.cal.cal1.calId)) {
    // keep board cal geometrically but clear missing IDs → force re-cal if both gone
    if (!state.parts.some((p) => p.id === state.cal.cal2.calId)) {
      state.cal = emptyCal();
    }
  }
  state.crosshair = null;
  clearCursorPos();
  if (!keepSearch) {
    state.searchHit = null;
    if (el.search) el.search.value = '';
  } else if (el.search?.value) {
    onSearch();
  }
  updateVariantBar();
  updateBadges();
  updateWelcome();
  persist();
  draw();
}

function setPartsAsVariant(fileName, text, parts, { replaceActive = true, add = false } = {}) {
  const name = stemName(fileName) || 'Variante';
  const realActive = state.activeVariantId !== REFS_ONLY_ID ? state.activeVariantId : null;
  if (add || (!replaceActive && state.variants.length)) {
    const id = newVariantId();
    state.variants.push({ id, name, pnpName: fileName || `${name}.csv`, pnpText: text, parts });
    state.activeVariantId = id;
  } else if (replaceActive && realActive && state.variants.length) {
    const idx = state.variants.findIndex((v) => v.id === realActive);
    if (idx >= 0) {
      state.variants[idx] = {
        ...state.variants[idx],
        name,
        pnpName: fileName || state.variants[idx].pnpName,
        pnpText: text,
        parts,
      };
    } else {
      const id = newVariantId();
      state.variants = [{ id, name, pnpName: fileName || `${name}.csv`, pnpText: text, parts }];
      state.activeVariantId = id;
    }
  } else if (replaceActive && state.variants.length && state.activeVariantId === REFS_ONLY_ID) {
    // Replace first real variant while in refs-only, then select the updated variant
    state.variants[0] = {
      ...state.variants[0],
      name,
      pnpName: fileName || state.variants[0].pnpName,
      pnpText: text,
      parts,
    };
    state.activeVariantId = state.variants[0].id;
  } else {
    const id = state.variants[0]?.id || newVariantId();
    state.variants = [{ id, name, pnpName: fileName || `${name}.csv`, pnpText: text, parts }];
    // First load: default to refs-only display mode
    state.activeVariantId = REFS_ONLY_ID;
  }
  syncActiveVariantParts();
  updateVariantBar();
}


/** Reload P&P data into the active variant slot; keep id / name / pnpName. */
function renewActiveVariant(text, parts) {
  const id = state.activeVariantId;
  if (!id || id === REFS_ONLY_ID) return false;
  const idx = state.variants.findIndex((v) => v.id === id);
  if (idx < 0) return false;
  state.variants[idx] = {
    ...state.variants[idx],
    pnpText: text,
    parts,
  };
  state.parts = parts;
  state.pnpText = text;
  // Keep state.pnpName / display name / id (slot identity).
  updateVariantBar();
  return true;
}


function imageToScreen(x, y) {
  return {
    x: x * state.zoom + state.pan.x,
    y: y * state.zoom + state.pan.y,
  };
}

function clearCursorPos() {
  state.cursorPos = null;
  if (cursorHideTimer) {
    clearTimeout(cursorHideTimer);
    cursorHideTimer = null;
  }
  updateCalSetBtn();
}

function armCursorHide() {
  if (cursorHideTimer) clearTimeout(cursorHideTimer);
  cursorHideTimer = setTimeout(() => {
    cursorHideTimer = null;
    state.cursorPos = null;
    updateCalSetBtn();
    draw();
  }, CURSOR_HIDE_MS);
}

function setCursorPos(pos) {
  state.cursorPos = pos;
  armCursorHide();
  updateCalSetBtn();
}

/** Orange "Kalibrierung setzen" button above click crosshair when not calibrated + part selected. */
function updateCalSetBtn() {
  if (!el.calSetBtn) return;
  const show =
    !!state.cursorPos &&
    !!state.pageBitmap &&
    !!state.searchHit &&
    !isCalibrated(state.cal, state.parts);
  if (!show) {
    el.calSetBtn.hidden = true;
    return;
  }
  const scr = imageToScreen(state.cursorPos.x, state.cursorPos.y);
  el.calSetBtn.hidden = false;
  el.calSetBtn.style.left = `${Math.round(scr.x)}px`;
  el.calSetBtn.style.top = `${Math.round(scr.y)}px`;
}

function lagerForBeak(beak) {
  if (!state.bomLookup.size) return '';
  return state.bomLookup.get(beakKey(beak))?.lagerplatz || '';
}

function partSearchLabel(p) {
  // Shared with suggestions + confirm field (pnp.partSearchLabel).
  return formatPartSearchLabel(p, { refsOnly: isRefsOnlyMode() });
}

/** Lagerplatz text for a part from SMD + BG Stückliste ('' when none found). */
function lagerTextForPart(p) {
  if (!p || !state.bomLookup.size) return '';
  const places = [];
  for (const b of resolveBeakList(p)) {
    const lager = lagerForBeak(b);
    if (lager && !places.includes(lager)) places.push(lager);
  }
  return places.join(' · ');
}

/** Right-aligned Lagerplatz in the search field for the current hit. */
let lagerMeasuredVp = '';
function updateSearchLager() {
  const lab = el.searchLager;
  if (!lab) return;
  const places = lagerTextForPart(state.searchHit);
  const text = places ? `Lagerplatz: ${places}` : '';
  // Re-measure padding when viewport size changes (font/layout).
  const vp = `${window.innerWidth}x${window.innerHeight}`;
  if (lab.textContent === text && lab.hidden === !text && lagerMeasuredVp === vp) return; // unchanged (draw runs per frame)
  lagerMeasuredVp = vp;
  lab.replaceChildren();
  if (places) {
    const pre = document.createElement('span');
    pre.className = 'search-lager-prefix';
    pre.textContent = 'Lagerplatz: ';
    const val = document.createElement('span');
    val.className = 'search-lager-value';
    val.textContent = places;
    lab.append(pre, val);
  }
  lab.title = text;
  lab.hidden = !text;
  // Keep typed/label text clear of the overlay (input text is clipped with ellipsis)
  if (el.search) el.search.style.paddingRight = text ? `${Math.ceil(lab.offsetWidth) + 20}px` : '';
  fitSearchLabelFont();
}

function setBoms(boms) {
  state.boms = {
    smd: normalizeBomList(boms?.smd),
    bg: normalizeBomList(boms?.bg),
  };
  state.bomLookup = buildBomLookup(state.boms);
}

async function onBomFile(file, source) {
  if (!file) return;
  const label = BOM_LABEL[source] || 'Stückliste';
  try {
    let parsed;
    if (/\.csv$/i.test(file.name)) {
      parsed = parseBomCsv(decodePnpBytes(await file.arrayBuffer()));
    } else {
      const lib = await ensurePdfJs();
      parsed = await parseBomPdf(lib, new Uint8Array(await file.arrayBuffer()));
    }
    if (!parsed.entries.length) {
      showToast(`${label}: keine Positionen erkannt (${file.name})`, 6000);
      return;
    }
    if (parsed.skipped?.length) console.warn(`${label}: nicht erkannte Zeilen`, parsed.skipped);
    setBoms({
      ...state.boms,
      [source]: { name: file.name, title: parsed.title, edv: parsed.edv, entries: parsed.entries },
    });
    persist();
    updateSearchLager();
    const msg = `${label} geladen: ${parsed.entries.length} Positionen` + (parsed.edv ? ` (${parsed.edv})` : '');
    setStatus(msg);
    showToast(msg);
  } catch (e) {
    console.error(e);
    showToast(`${label} konnte nicht geladen werden: ` + (e.message || e), 6000);
  }
}


function applyPnpValueReplaceMap(byRef, { sync = true } = {}) {
  const map = byRef instanceof Map ? byRef : deserializeKundenByRef(byRef);
  for (const v of state.variants) {
    if (v.parts?.length) applyKundenValuesToParts(v.parts, map);
  }
  if (sync) {
    // Refresh visible parts from active variant / refs-only merge
    if (state.activeVariantId === REFS_ONLY_ID) {
      state.parts = mergeAllVariantParts();
    } else {
      const v = state.variants.find((x) => x.id === state.activeVariantId);
      if (v) state.parts = v.parts || [];
    }
  }
}

async function onPnpReplaceFile(file) {
  if (!file) return;
  if (!state.variants.length && !state.parts.length) {
    showToast('Bitte zuerst Pick & Place laden.', 5000);
    return;
  }
  try {
    const lib = await ensurePdfJs();
    const parsed = await parseKundenBomPdf(lib, new Uint8Array(await file.arrayBuffer()));
    if (!parsed.byRef?.size) {
      showToast(`Keine Referenzen in Stückliste erkannt (${file.name})`, 6000);
      return;
    }
    // Apply to all variants (Kunden-Stückliste is board-level); toast counts current view
    applyPnpValueReplaceMap(parsed.byRef, { sync: true });
    state.pnpValueReplace = {
      sourceName: file.name,
      byRef: serializeKundenByRef(parsed.byRef),
    };
    let replaced = 0;
    const total = state.parts.length;
    for (const part of state.parts) {
      if (parsed.byRef.has(normalizeRef(part.id))) replaced++;
    }
    updateSearchLager();
    draw();
    const msg = `${replaced} von ${total} Werten ersetzt`;
    setStatus(msg + (parsed.title ? ` — ${parsed.title}` : ''));
    showToast(msg);
  } catch (e) {
    console.error(e);
    showToast('Stückliste konnte nicht geladen werden: ' + (e.message || e), 6000);
  }
}

function positionSuggestions() {
  if (!el.suggestions || el.suggestions.hidden || !el.search) return;
  const r = el.search.getBoundingClientRect();
  el.suggestions.style.left = `${Math.round(r.left)}px`;
  el.suggestions.style.top = `${Math.round(r.bottom + 4)}px`;
  el.suggestions.style.width = `${Math.round(r.width)}px`;
}

function sugItems() {
  return [...el.suggestions.querySelectorAll('.sug-item')];
}

function setSugActive(idx) {
  const items = sugItems();
  if (!items.length) {
    sugActiveIndex = -1;
    return;
  }
  if (idx < 0) idx = items.length - 1;
  if (idx >= items.length) idx = 0;
  sugActiveIndex = idx;
  items.forEach((item, i) => item.classList.toggle('active', i === sugActiveIndex));
  items[sugActiveIndex].scrollIntoView({ block: 'nearest' });
}

function confirmSuggestion(p, { center = true } = {}) {
  el.search.value = partSearchLabel(p);
  el.suggestions.hidden = true;
  sugActiveIndex = -1;
  state.searchHit = p;
  updateCrosshairFromSearch({ center });
  draw();
}

function openedDocStem() {
  const raw = state.openFileName || state.projectName || state.pdfName || '';
  return raw ? stemName(raw) : '';
}

function updateDocTitle() {
  // Closed → app name. Open → selected Bestückungsvariante; refs-only → open file stem.
  let title = 'Bauteile Suchen';
  const docOpen = !!(state.openFileName || state.projectName || state.pdfName || state.pageBitmap || state.pdfBytes);
  if (docOpen) {
    if (state.variants.length && state.activeVariantId && !isRefsOnlyMode()) {
      const v = state.variants.find((x) => x.id === state.activeVariantId);
      title = v ? variantDisplayName(v) : (openedDocStem() || title);
    } else {
      title = openedDocStem() || title;
    }
  }
  if (el.docTitle) {
    el.docTitle.textContent = title;
    el.docTitle.title = title;
    fitDocTitle();
  }
}

/** Shrink title font to fit available width (min 12px), then ellipsis if still needed. */
function fitDocTitle() {
  const node = el.docTitle;
  if (!node) return;
  node.style.fontSize = '';
  const base = parseFloat(getComputedStyle(node).fontSize) || 16;
  let size = base;
  const min = 12;
  // Allow layout to use full flex width first
  while (node.scrollWidth > node.clientWidth + 0.5 && size > min) {
    size = Math.max(min, size - 0.5);
    node.style.fontSize = `${size}px`;
  }
}

/**
 * When the search field shows a confirmed part label (not focused), shrink the
 * part + Lagerplatz fonts together so „Lagerplatz: …“ stays fully visible
 * (never ellipsized). Min 12px; then the part label may ellipsize. Focused/typing stays ≥16px.
 */
function fitSearchLabelFont() {
  const input = el.search;
  const lab = el.searchLager;
  if (!input) return;
  if (document.activeElement === input) {
    input.style.fontSize = '';
    if (lab) lab.style.fontSize = '';
    return;
  }
  const label = (input.value || '').trim();
  const lagerShown = !!(lab && !lab.hidden && lab.textContent.trim());
  if (!label || !state.searchHit) {
    input.style.fontSize = '';
    if (lab) lab.style.fontSize = '';
    return;
  }
  const min = 12;
  let size = 16;
  input.style.fontSize = '16px';
  if (lab) lab.style.fontSize = '16px';
  const cs = getComputedStyle(input);
  const family = cs.fontFamily || 'system-ui';
  const weight = cs.fontWeight || '400';
  const canvas = fitSearchLabelFont._c || (fitSearchLabelFont._c = document.createElement('canvas'));
  const ctx = canvas.getContext('2d');
  const gap = 20; // padding between part text and Lagerplatz overlay
  while (true) {
    input.style.fontSize = `${size}px`;
    if (lab) lab.style.fontSize = `${size}px`;
    // Lagerplatz must stay fully visible — size padding from its natural width
    const lagerW = lagerShown ? Math.ceil(lab.offsetWidth) : 0;
    input.style.paddingRight = lagerW ? `${lagerW + gap}px` : '';
    const padL = parseFloat(getComputedStyle(input).paddingLeft) || 0;
    const padR = parseFloat(getComputedStyle(input).paddingRight) || 0;
    const avail = Math.max(8, input.clientWidth - padL - padR);
    ctx.font = `${weight} ${size}px ${family}`;
    const labelW = ctx.measureText(label).width;
    // Also ensure Lagerplatz itself fits in the field (never clip it)
    const fieldW = input.clientWidth;
    const lagerFits = !lagerShown || lagerW + 24 <= fieldW * 0.7 || size <= min;
    if (labelW <= avail && lagerFits) break;
    if (size <= min) break;
    size -= 0.5;
  }
  input.style.fontSize = `${size}px`;
  if (lab) lab.style.fontSize = `${size}px`;
  if (lagerShown) {
    input.style.paddingRight = `${Math.ceil(lab.offsetWidth) + gap}px`;
  }
}

function updateBadges() {
  const ok = isCalibrated(state.cal, state.parts);
  if (el.menuSetRef) el.menuSetRef.classList.toggle('warn', !ok);
  // Banner on board when PDF/image loaded but not fully calibrated (2 refs)
  if (el.calBanner) {
    const needCal = !!state.pageBitmap && !ok;
    el.calBanner.hidden = !needCal;
  }
  updateDocTitle();
  updateVariantBar();
  updateWelcome();
}

function persist() {
  try {
    const data = {
      cal: normalizeCal(state.cal),
      pdfName: state.pdfName,
      pnpName: state.pnpName,
      stuecklisten: state.boms.smd || state.boms.bg ? state.boms : null,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (_) {}
}

function restoreMeta() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data?.cal) state.cal = normalizeCal(data.cal);
    if (data?.stuecklisten) setBoms(data.stuecklisten);
  } catch (_) {}
}

function showEditMenu(edit) {
  state.editMenuOpen = !!edit;
  el.drawer?.classList.toggle('edit-open', state.editMenuOpen);
  if (el.drawerEdit) el.drawerEdit.setAttribute('aria-hidden', state.editMenuOpen ? 'false' : 'true');
  if (el.drawerMain) el.drawerMain.setAttribute('aria-hidden', state.editMenuOpen ? 'true' : 'false');
  if (state.editMenuOpen && el.drawerEdit) {
    el.drawerEdit.scrollTop = 0;
  } else if (el.drawerMain) {
    el.drawerMain.scrollTop = 0;
  }
}

function openMenu(open) {
  state.menuOpen = open;
  el.drawer.hidden = !open;
  el.menuBackdrop.hidden = !open;
  el.menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open) showEditMenu(false);
  else showEditMenu(false); // always open on main menu
}

async function ensurePdfJs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import('../vendor/pdfjs/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjsLib;
}

/** Near-white / transparent → margin for auto-crop. */
function isMarginPixel(r, g, b, a, thr = PDF_WHITE_THR) {
  if (a < 8) return true;
  return r >= thr && g >= thr && b >= thr;
}

/**
 * Detect content bounding box on a canvas (trim mostly-white margins).
 * Returns {x,y,w,h} in source pixel space; full canvas if no content / all ink.
 */
function detectContentCrop(canvas, { thr = PDF_WHITE_THR, pad = PDF_CROP_PAD } = {}) {
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return { x: 0, y: 0, w: Math.max(1, w), h: Math.max(1, h) };
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      if (!isMarginPixel(data[i], data[i + 1], data[i + 2], data[i + 3], thr)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w, h };
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function cropCanvas(src, crop) {
  const out = document.createElement('canvas');
  out.width = Math.max(1, crop.w);
  out.height = Math.max(1, crop.h);
  out.getContext('2d').drawImage(
    src,
    crop.x,
    crop.y,
    crop.w,
    crop.h,
    0,
    0,
    crop.w,
    crop.h,
  );
  return out;
}

/**
 * Remap calibration from a previously saved page size into current cropped image space.
 * - Same size as crop → already cropped coords (V1.6.29+).
 * - Same size as full (uncropped) base → legacy V1.6.28 and earlier; subtract crop origin.
 * - Else → uniform scale fallback.
 */
function remapCalToCroppedSpace(cal, savedPageW, savedPageH) {
  const c = normalizeCal(cal);
  if (!state.crop || !savedPageW || !savedPageH) return c;
  const near = (a, b) => Math.abs(a - b) <= 2;
  if (near(savedPageW, state.pageW) && near(savedPageH, state.pageH)) return c;
  if (near(savedPageW, state.fullW) && near(savedPageH, state.fullH)) {
    c.cal1.calX = Math.round(c.cal1.calX - state.crop.x);
    c.cal1.calY = Math.round(c.cal1.calY - state.crop.y);
    c.cal2.calX = Math.round(c.cal2.calX - state.crop.x);
    c.cal2.calY = Math.round(c.cal2.calY - state.crop.y);
    return c;
  }
  const sx = state.pageW / savedPageW;
  const sy = state.pageH / savedPageH;
  c.cal1.calX = Math.round(c.cal1.calX * sx);
  c.cal1.calY = Math.round(c.cal1.calY * sy);
  c.cal2.calX = Math.round(c.cal2.calX * sx);
  c.cal2.calY = Math.round(c.cal2.calY * sy);
  return c;
}

function neededPdfBmpScale() {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(1, state.zoom * dpr);
}

/** Largest whole-page bitmap scale within the device pixel budget. */
function baseBmpScaleCap() {
  const area = Math.max(1, state.pageW * state.pageH);
  return Math.max(1, Math.min(PDF_MAX_BMP_SCALE, Math.sqrt(PERF.baseMaxPx / area)));
}

/** Free canvas memory now (Safari keeps detached canvas backing stores until GC). */
function releaseCanvas(c) {
  if (c && typeof c.width === 'number' && c !== el.canvas) {
    c.width = 0;
    c.height = 0;
  }
}

function dropPdfTile() {
  if (state.pdfTile) releaseCanvas(state.pdfTile.canvas);
  state.pdfTile = null;
}

/** Cancel pending/in-flight PDF detail renders (new gesture, new document). */
function cancelPdfDetail() {
  pdfRenderGen += 1;
  clearTimeout(pdfRerenderTimer);
  pdfRerenderPending = false;
  pdfDetailBusy = false;
  if (pdfRenderTask) {
    try { pdfRenderTask.cancel(); } catch (_) {}
    pdfRenderTask = null;
  }
}

function schedulePdfRerender(delay = PERF.settleMs) {
  if (!state.isPdfSource || !pdfPage || !state.crop) return;
  clearTimeout(pdfRerenderTimer);
  pdfRerenderPending = true;
  pdfRerenderTimer = setTimeout(() => {
    pdfRerenderPending = false;
    // Never render while fingers are down / wheel is spinning — wait for settle.
    if (isInteracting()) {
      schedulePdfRerender(delay);
      return;
    }
    refreshPdfDetail().catch((e) => console.error(e));
  }, delay);
}

/**
 * Render an image-space rect of the cropped page at s device-px per image unit.
 * Returns the canvas, or null when superseded/cancelled.
 */
async function renderPdfRegion(rect, s, gen) {
  const crop = state.crop;
  const viewport = pdfPage.getViewport({ scale: PDF_BASE_SCALE * s });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.w * s));
  canvas.height = Math.max(1, Math.round(rect.h * s));
  const ctx = canvas.getContext('2d');
  // Shift so rect's top-left (crop origin + rect origin) lands at (0,0).
  const transform = [1, 0, 0, 1, -(crop.x + rect.x) * s, -(crop.y + rect.y) * s];
  const task = pdfPage.render({ canvasContext: ctx, viewport, transform });
  pdfRenderTask = task;
  try {
    await task.promise;
  } catch (e) {
    releaseCanvas(canvas);
    if (e && e.name === 'RenderingCancelledException') return null;
    throw e;
  } finally {
    if (pdfRenderTask === task) pdfRenderTask = null;
  }
  if (gen !== pdfRenderGen) {
    releaseCanvas(canvas);
    return null;
  }
  return canvas;
}

/**
 * Draw only the visible part of a bitmap that maps to image-space rect `r`
 * (source-rect drawImage — far less resampling work at deep zoom).
 */
function drawBitmapVisible(ctx, bmp, r, vis) {
  if (!bmp || !bmp.width || !bmp.height) return;
  const pad = 2 / Math.max(state.zoom, 1e-6);
  const x0 = Math.max(r.x, vis.x - pad);
  const y0 = Math.max(r.y, vis.y - pad);
  const x1 = Math.min(r.x + r.w, vis.x + vis.w + pad);
  const y1 = Math.min(r.y + r.h, vis.y + vis.h + pad);
  if (x1 <= x0 || y1 <= y0) return;
  const kx = bmp.width / r.w;
  const ky = bmp.height / r.h;
  ctx.drawImage(bmp, (x0 - r.x) * kx, (y0 - r.y) * ky, (x1 - x0) * kx, (y1 - y0) * ky, x0, y0, x1 - x0, y1 - y0);
}

/** Visible board region in image space (uncropped by page bounds). */
function visibleImageRect() {
  const size = lastBoardSize || boardCssSize();
  return {
    x: -state.pan.x / state.zoom,
    y: -state.pan.y / state.zoom,
    w: size.cssW / state.zoom,
    h: size.cssH / state.zoom,
  };
}

function clipToPage(r) {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(state.pageW, r.x + r.w);
  const y1 = Math.min(state.pageH, r.y + r.h);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0) };
}

function rectContains(o, i) {
  return i.x >= o.x - 0.5 && i.y >= o.y - 0.5 && i.x + i.w <= o.x + o.w + 0.5 && i.y + i.h <= o.y + o.h + 0.5;
}

/**
 * After zoom/pan settles: (1) whole-page base bitmap within pixel budget,
 * (2) sharp viewport tile when the needed scale exceeds the base.
 */
/**
 * What the current view needs (shared by refreshPdfDetail and the stale check in draw,
 * so a satisfied plan never re-triggers itself).
 * Returns null when nothing is to do, else { baseTarget|null, tile: {rect,s}|null, dropTile }.
 */
function planPdfDetail() {
  if (!pdfPage || !state.crop || !state.pageW || !state.pageBitmap) return null;
  const need = neededPdfBmpScale();
  const baseTarget = Math.min(need, baseBmpScaleCap());
  const baseOk = !(state.pdfBmpScale < baseTarget * 0.88 || state.pdfBmpScale > baseTarget * 1.45);
  const baseScale = baseOk ? state.pdfBmpScale : baseTarget;
  const plan = { baseTarget: baseOk ? null : baseTarget, tile: null, dropTile: false };
  if (need <= baseScale * 1.12) {
    plan.dropTile = !!state.pdfTile;
  } else {
    const vis = clipToPage(visibleImageRect());
    if (vis) {
      let s = need;
      let m = PERF.tileMargin;
      const px = (mm, ss) => vis.w * (1 + 2 * mm) * vis.h * (1 + 2 * mm) * ss * ss;
      while (m > 0 && px(m, s) > PERF.tileMaxPx) m = Math.max(0, m - 0.05);
      if (px(0, s) > PERF.tileMaxPx) s = Math.sqrt(PERF.tileMaxPx / (vis.w * vis.h));
      const cur = state.pdfTile;
      // Coverage is checked against the CURRENT pan/zoom (programmatic jumps included).
      const curOk = cur && Math.abs(cur.scale - s) / s < 0.12 && rectContains(cur, vis);
      if (!curOk && s > baseScale * 1.05) {
        const rect = clipToPage({ x: vis.x - vis.w * m, y: vis.y - vis.h * m, w: vis.w * (1 + 2 * m), h: vis.h * (1 + 2 * m) });
        if (rect) plan.tile = { rect, s };
      }
    }
  }
  return plan.baseTarget || plan.tile || plan.dropTile ? plan : null;
}


/**
 * After zoom/pan settles: (1) whole-page base bitmap within pixel budget,
 * (2) sharp viewport tile when the needed scale exceeds the base.
 */
async function refreshPdfDetail() {
  cancelPdfDetail();
  const gen = pdfRenderGen;
  pdfDetailBusy = true;
  try {
    let plan = planPdfDetail();
    pdfInflightPlan = plan;
    if (!plan) return;
    // 1) Base bitmap (whole cropped page)
    if (plan.baseTarget) {
      const c = await renderPdfRegion({ x: 0, y: 0, w: state.pageW, h: state.pageH }, plan.baseTarget, gen);
      if (!c) return;
      const old = state.pageBitmap;
      state.pageBitmap = c;
      state.pdfBmpScale = plan.baseTarget;
      if (old && old !== c) releaseCanvas(old);
      requestDraw();
      plan = planPdfDetail();
      pdfInflightPlan = plan;
      if (!plan) return;
    }
    // 2) Viewport tile for deep zoom
    if (plan.dropTile) {
      dropPdfTile();
      requestDraw();
    }
    if (plan.tile) {
      const c = await renderPdfRegion(plan.tile.rect, plan.tile.s, gen);
      if (!c) return;
      dropPdfTile();
      const r = plan.tile.rect;
      state.pdfTile = { canvas: c, x: r.x, y: r.y, w: r.w, h: r.h, scale: plan.tile.s };
      requestDraw();
    }
  } catch (e) {
    pdfDetailErrorAt = performance.now(); // avoid a retry loop from the idle draw hook
    throw e;
  } finally {
    if (gen === pdfRenderGen) {
      pdfDetailBusy = false;
      pdfInflightPlan = null;
      // View may have changed programmatically while rendering → re-check on next frame.
      requestDraw();
    }
  }
}

/** Idle draw hook: any view change (search jump, Einpassen, resize, open…) gets detail. */
function ensurePdfDetailForView() {
  // A pending gesture-settle timer is kept (never shortened); in-flight renders re-check when done.
  if (!state.isPdfSource || pdfRerenderPending || isInteracting()) return;
  if (performance.now() - pdfDetailErrorAt < 2000) return;
  const plan = planPdfDetail();
  if (!plan) return;
  if (pdfDetailBusy) {
    // Keep the in-flight render if it will still cover the (possibly jumped) view.
    const f = pdfInflightPlan;
    const vis = clipToPage(visibleImageRect());
    const stillGood = f && (!plan.tile || (f.tile && vis
      && Math.abs(f.tile.s - plan.tile.s) / plan.tile.s < 0.12 && rectContains(f.tile.rect, vis)));
    if (stillGood) return;
    cancelPdfDetail();
  }
  schedulePdfRerender(PROGRAMMATIC_DETAIL_MS);
}

async function renderPdfPage(fileOrUrl, pageNum = 1) {
  const lib = await ensurePdfJs();
  let data;
  if (typeof fileOrUrl === 'string') {
    const res = await fetch(fileOrUrl);
    data = new Uint8Array(await res.arrayBuffer());
  } else {
    data = new Uint8Array(await fileOrUrl.arrayBuffer());
  }
  if (pdfDoc) {
    try { await pdfDoc.destroy(); } catch (_) {}
  }
  pdfPage = null;
  cancelPdfDetail();
  dropPdfTile();
  pdfDoc = await lib.getDocument({ data }).promise;
  pdfPage = await pdfDoc.getPage(pageNum);
  state.isPdfSource = true;

  // Base render for crop detection + initial display (image space = cropped @ PDF_BASE_SCALE).
  const viewport = pdfPage.getViewport({ scale: PDF_BASE_SCALE });
  const full = document.createElement('canvas');
  full.width = Math.floor(viewport.width);
  full.height = Math.floor(viewport.height);
  await pdfPage.render({ canvasContext: full.getContext('2d'), viewport }).promise;

  state.fullW = full.width;
  state.fullH = full.height;
  state.crop = detectContentCrop(full);
  state.pageW = state.crop.w;
  state.pageH = state.crop.h;
  const prevBitmap = state.pageBitmap;
  state.pageBitmap = cropCanvas(full, state.crop);
  releaseCanvas(full);
  if (prevBitmap && prevBitmap !== state.pageBitmap) releaseCanvas(prevBitmap);
  state.pdfBmpScale = 1;
  state.pendingFit = true;
  el.empty.hidden = true;
  draw();
  schedulePdfRerender(0);
}

async function loadImageFile(fileOrUrl) {
  const url = typeof fileOrUrl === 'string' ? fileOrUrl : URL.createObjectURL(fileOrUrl);
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('Bild nicht ladbar'));
    i.src = url;
  });
  const off = document.createElement('canvas');
  off.width = img.naturalWidth;
  off.height = img.naturalHeight;
  off.getContext('2d').drawImage(img, 0, 0);
  if (typeof fileOrUrl !== 'string') URL.revokeObjectURL(url);

  // Raster stays bitmap; still auto-crop white margins so cal/fit use cropped space.
  pdfPage = null;
  state.isPdfSource = false;
  cancelPdfDetail();
  dropPdfTile();
  state.fullW = off.width;
  state.fullH = off.height;
  state.crop = detectContentCrop(off);
  state.pageBitmap = cropCanvas(off, state.crop);
  state.pageW = state.crop.w;
  state.pageH = state.crop.h;
  state.pdfBmpScale = 1;
  state.pendingFit = true;
  el.empty.hidden = true;
  draw();
}


function chromeHeight() {
  const c = el.chrome;
  return c ? c.getBoundingClientRect().height : 0;
}


/** Safari: force frosted surfaces to re-sample canvas after paint / pan / zoom. */
let _bfTickOn = false;
function nudgeChromeBackdrop() {
  _bfTickOn = !_bfTickOn;
  const on = _bfTickOn;
  if (el.chrome) el.chrome.classList.toggle('bf-tick', on);
  if (el.drawer) el.drawer.classList.toggle('bf-tick', on);
  if (el.search) el.search.classList.toggle('bf-tick', on);
  document.querySelectorAll('.board-h-btn').forEach((b) => b.classList.toggle('bf-tick', on));
}

let lastChromeH = -1;
function syncChromeOffset() {
  const h = Math.round(chromeHeight());
  // Writing a custom property on <html> restyles the whole page — only when it changes.
  if (h !== lastChromeH) {
    lastChromeH = h;
    document.documentElement.style.setProperty('--chrome-h', h + 'px');
  }
  return h;
}

/** Visible board height in CSS px (clamped to visual viewport). */
function visibleBoardCssH(cssH) {
  const wrap = el.boardWrap;
  const vv = window.visualViewport;
  const visBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const wrapTop = wrap.getBoundingClientRect().top;
  const visibleH = Math.ceil(visBottom - wrapTop);
  if (!(visibleH > 0)) return cssH;
  return Math.max(1, Math.min(cssH, visibleH));
}

/** Compute the default fit transform (does not apply it). */
let fitCache = null;
function computeFitTransform() {
  // During pinch/pan/wheel the layout is stable — reuse the last fit (no layout reads per frame).
  if (fitCache && isInteracting() && fitCache.pageW === state.pageW && fitCache.pageH === state.pageH) {
    return fitCache.fit;
  }
  const fit = computeFitTransformUncached();
  fitCache = { pageW: state.pageW, pageH: state.pageH, fit };
  return fit;
}

function computeFitTransformUncached() {
  const wrap = el.boardWrap;
  if (!state.pageW || !wrap.clientWidth) return null;
  const pad = 16;
  const topInset = syncChromeOffset();
  const { cssW, cssH } = boardCssSize();
  if (wrap.style.height !== cssH + 'px') wrap.style.height = cssH + 'px';
  // Fit into the *visible* area below chrome. Shell/canvas may extend past the
  // visual viewport on iOS (home-indicator fill); on desktop Mac, shellBottomPx
  // used to overshoot via screen.height — never size the fit into that excess.
  const fitH = visibleBoardCssH(cssH);
  const availW = cssW - pad * 2;
  const availH = Math.max(80, fitH - topInset - pad * 2);
  const zx = availW / state.pageW;
  const zy = availH / state.pageH;
  const zoom = Math.max(0.05, Math.min(zx, zy));
  return {
    zoom,
    pan: {
      x: (cssW - state.pageW * zoom) / 2,
      y: topInset + (availH - state.pageH * zoom) / 2 + pad,
    },
  };
}

function isViewAtFit() {
  const fit = computeFitTransform();
  if (!fit) return true;
  const EPS_Z = 1e-4;
  const EPS_P = 0.75;
  return (
    Math.abs(state.zoom - fit.zoom) < EPS_Z &&
    Math.abs(state.pan.x - fit.pan.x) < EPS_P &&
    Math.abs(state.pan.y - fit.pan.y) < EPS_P
  );
}

/** Show Einpassen only when zoomed or panned away from the fitted view. */
function updateFitBtnVisibility() {
  const show = !!(state.pageBitmap && state.pageW && !isViewAtFit());
  if (el.boardZoomBtns) el.boardZoomBtns.hidden = !show;
  if (el.btnZoomFit) el.btnZoomFit.hidden = !show;
}

function fitView() {
  const fit = computeFitTransform();
  if (!fit) return;
  state.zoom = fit.zoom;
  state.pan = { x: fit.pan.x, y: fit.pan.y };
  state.pendingFit = false;
  updateFitBtnVisibility();
  schedulePdfRerender(40);
}


function isDarkUi() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (_) { return false; }
}

function drawCrosshair(ctx, x, y, color) {
  // Constant on-screen size (CSS px): draw in a local space that undoes ctx.scale(zoom).
  // Matches the Einpassen (fit) look at every zoom level. Same in light and dark (no halo).
  const z = state.zoom || 1;
  const arm = 28;
  const gap = 6;
  const ring = 5;
  const lw = 2.5;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1 / z, 1 / z);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(-arm, 0);
  ctx.lineTo(-gap, 0);
  ctx.moveTo(gap, 0);
  ctx.lineTo(arm, 0);
  ctx.moveTo(0, -arm);
  ctx.lineTo(0, -gap);
  ctx.moveTo(0, gap);
  ctx.lineTo(0, arm);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, ring, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Parts with finite CAD XY (skip incomplete / no-position rows). */
function partsWithPositions() {
  return (state.parts || []).filter(
    (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y),
  );
}

/**
 * Light-pink dots at every calibrated part — board image space (pan/zoom with PDF).
 * Drawn under the board bitmap (see draw): multiply compositing lets white PDF
 * areas show the dots while black ink sits on top.
 */
/** Cached part-dot image positions — recomputed only when parts / calibration change. */
let partDotCache = { parts: null, calKey: '', pts: null };
function partDotPositions() {
  const calKey = JSON.stringify(state.cal);
  if (partDotCache.parts === state.parts && partDotCache.calKey === calKey) return partDotCache.pts;
  let pts = null;
  if (isCalibrated(state.cal, state.parts)) {
    const list = [];
    for (const p of partsWithPositions()) {
      const pos = cadToImage(p, state.cal, state.parts);
      if (pos) list.push(pos.x, pos.y);
    }
    pts = list.length ? Float64Array.from(list) : null;
  }
  partDotCache = { parts: state.parts, calKey, pts };
  return pts;
}

/** Drawn part-dot radius in image space (visual size). Screen radius = this × zoom. */
function partDotRadiusImage() {
  return Math.max(2, 3.2 / state.zoom);
}

function drawPartDots(ctx, fillStyle = PART_DOT) {
  const pts = partDotPositions();
  if (!pts) return;
  const r = partDotRadiusImage();
  // Only dots in the visible region, one path + one fill (single composite).
  const vis = lastBoardSize ? visibleImageRect() : null;
  ctx.fillStyle = fillStyle;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    if (vis && (x < vis.x - r || y < vis.y - r || x > vis.x + vis.w + r || y > vis.y + vis.h + r)) continue;
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fill();
}

/** Base minimum hit radius in CSS screen px. Desktop 14, touch 22. */
function partHitBaseCssPx() {
  try {
    if (IS_IOS_TOUCH || window.matchMedia('(pointer: coarse)').matches) return 22;
  } catch (_) {
    if (IS_IOS_TOUCH) return 22;
  }
  return 14;
}

/**
 * Hit radius in CSS screen px: at least the base minimum, and always covering the
 * drawn dot plus margin so zoomed-in dots stay fully clickable.
 * formula: max(baseMin, dotScreen×1.5, dotScreen+8) where dotScreen = partDotRadiusImage()×zoom
 */
function partHitRadiusCssPx() {
  const base = partHitBaseCssPx();
  const dotScreen = partDotRadiusImage() * state.zoom; // = max(2×zoom, 3.2)
  return Math.max(base, dotScreen * 1.5, dotScreen + 8);
}

/** Nearest part under image-space point within the screen-space hit radius. */
function hitTestPartAt(imgX, imgY) {
  if (!isCalibrated(state.cal, state.parts)) return null;
  const parts = partsWithPositions();
  if (!parts.length) return null;
  const maxDist = partHitRadiusCssPx() / state.zoom; // screen CSS px → image space
  let best = null;
  let bestD = maxDist;
  for (const p of parts) {
    const pos = cadToImage(p, state.cal, state.parts);
    if (!pos) continue;
    const d = Math.hypot(pos.x - imgX, pos.y - imgY);
    if (d < bestD || (d === bestD && !best)) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** Safe-area bottom inset in CSS px (probe — more reliable than --sab on iOS). */
function readSafeAreaBottom() {
  let h = 0;
  try {
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:fixed;left:0;bottom:0;width:1px;height:env(safe-area-inset-bottom,0px);' +
      'visibility:hidden;pointer-events:none;z-index:-1';
    document.body.appendChild(probe);
    h = probe.getBoundingClientRect().height;
    probe.remove();
  } catch (_) {
    h = 0;
  }
  if (!(h > 0)) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--sab').trim();
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0) h = n;
  }
  return h;
}

/** Read a CSS length custom property as px (e.g. --vv-lvh: 100lvh). */
function readCssPx(name) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Fixed inset:0 sentinel — true CSS fill bottom with viewport-fit=cover. */
function fixedViewportBottom() {
  if (!fixedViewportBottom._el) {
    const p = document.createElement('div');
    p.setAttribute('aria-hidden', 'true');
    p.style.cssText =
      'position:fixed;inset:0;visibility:hidden;pointer-events:none;z-index:-1';
    document.body.appendChild(p);
    fixedViewportBottom._el = p;
  }
  return fixedViewportBottom._el.getBoundingClientRect().bottom;
}

/**
 * Bottom edge of the shell in layout coordinates.
 * iPhone portrait + iPad (any orientation): layout/visual viewport often stop
 * short of the home-indicator strip. Take the max of vv/lvh/screen-edge and
 * always extend by at least the home-indicator pad so the canvas paints to the
 * true screen bottom. (iPhone landscape already fine — indicator on the side.)
 */
function shellBottomPx() {
  const vv = window.visualViewport;
  const vvBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const sab = readSafeAreaBottom();
  const fixedBottom = fixedViewportBottom();
  const lvh = readCssPx('--vv-lvh');
  const dvh = readCssPx('--vv-dvh');
  const svh = readCssPx('--vv-svh');
  const appBottom = el.app ? el.app.getBoundingClientRect().bottom : 0;
  const iw = window.innerWidth || 0;
  const ih = window.innerHeight || 0;
  const landscape = iw > ih;
  const ua = navigator.userAgent || '';
  const isIphone = /iPhone/.test(ua);
  const isIpad =
    /iPad/.test(ua) ||
    (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  const isIosFamily = isIphone || isIpad;

  // Desktop (Mac/Windows): use layout/visual viewport only. screen.height is the
  // full display and made the shell taller than a windowed browser — Einpassen
  // then fitted into the oversized canvas and cropped the board at the bottom.
  let bottom = Math.max(
    ih,
    document.documentElement.clientHeight || 0,
    vvBottom,
    fixedBottom,
    lvh,
    dvh,
    svh,
    appBottom,
  );

  if (isIosFamily) {
    // iOS/iPadOS: layout/visual viewport often stop short of the home-indicator
    // strip. screen.width/height are portrait-absolute CSS px — pick the edge
    // for the current orientation, then pad so the canvas paints to the true bottom.
    const sw = window.screen?.width || 0;
    const sh = window.screen?.height || 0;
    const screenEdge = landscape ? Math.min(sw, sh) : Math.max(sw, sh);
    if (screenEdge > 0) bottom = Math.max(bottom, screenEdge);
    const HOME_PAD = 34;
    // Skip forced pad on iPhone landscape (indicator is on the side).
    const forceHomePad = !landscape || isIpad;
    const pad = forceHomePad ? Math.max(sab, HOME_PAD) : sab;
    if (pad > 0) {
      bottom = Math.max(
        bottom,
        vvBottom + pad,
        ih + pad,
        fixedBottom + pad,
        lvh > 0 ? lvh + Math.max(0, pad - sab) : 0,
      );
    }
  } else if (sab > 0) {
    // Rare desktop env() safe-area: extend by the real inset only (no forced 34).
    bottom = Math.max(bottom, vvBottom + sab, ih + sab, fixedBottom + sab);
  }
  return Math.ceil(bottom);
}

/**
 * Drive .app height from measured shell bottom (no max-height clamp, no
 * inset-bottom fight). Explicit px height covers the home-indicator strip.
 */
function syncShellToViewport() {
  const h = Math.max(1, shellBottomPx());
  document.documentElement.style.setProperty('--app-h', h + 'px');
  if (el.app) {
    el.app.style.top = '0';
    el.app.style.left = '0';
    el.app.style.right = '0';
    el.app.style.bottom = 'auto';
    el.app.style.height = h + 'px';
    el.app.style.minHeight = h + 'px';
    el.app.style.maxHeight = 'none';
  }
  return h;
}

/** After rotate/resize: drop cached board size, kill stray scroll, remasure wrap. */
function invalidateBoardLayout() {
  lastBoardSize = null;
  try {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    if (window.visualViewport && typeof window.visualViewport.offsetTop === 'number') {
      // no-op read — some WebKit builds settle offset after access
      void window.visualViewport.offsetTop;
    }
  } catch (_) {}
  if (el.boardWrap) el.boardWrap.style.height = '';
}

/** Canvas/wrap CSS size — cover down to true shell bottom (no green letterbox). */
function boardCssSize() {
  const wrap = el.boardWrap;
  // Drop prior JS height so CSS inset fill can contribute to the measurement.
  const prevH = wrap.style.height;
  wrap.style.height = '';
  const rect = wrap.getBoundingClientRect();
  const cssW = Math.max(1, Math.round(wrap.clientWidth || rect.width || window.innerWidth));
  const layoutH = Math.round(rect.height || wrap.clientHeight || 0);
  const shellBottom = shellBottomPx();
  const toShellBottom = Math.ceil(shellBottom - rect.top);
  // Prefer shell span; layoutH alone can undershoot when .app was short last frame.
  const cssH = Math.max(1, toShellBottom, layoutH);
  // Restore so callers that depend on an explicit height still see one after measure.
  if (prevH) wrap.style.height = prevH;
  return { cssW, cssH };
}

function draw() {
  const t0 = perfDebug ? performance.now() : 0;
  drawInner();
  if (perfDebug) perfDebug.drawMs.push(performance.now() - t0);
}

function syncCanvasCssSize(canvas, cssW, cssH, dpr) {
  if (!canvas) return null;
  const bw = Math.max(1, Math.floor(cssW * dpr));
  const bh = Math.max(1, Math.floor(cssH * dpr));
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;
  if (canvas.style.width !== cssW + 'px') canvas.style.width = cssW + 'px';
  if (canvas.style.height !== cssH + 'px') canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function drawInner() {
  if (drawRaf) {
    cancelAnimationFrame(drawRaf);
    drawRaf = 0;
  }
  updateSearchLager();
  const canvas = el.canvas;
  const overlay = el.overlay;
  const wrap = el.boardWrap;
  const dpr = window.devicePixelRatio || 1;
  const moving = isInteracting();
  // Layout measure only when idle; gestures reuse the last size (no forced layout per frame).
  const size = moving && lastBoardSize ? lastBoardSize : boardCssSize();
  lastBoardSize = size;
  const { cssW, cssH } = size;
  // Keep wrap tall enough for hit-testing / pan math to match painted area
  if (wrap.style.height !== cssH + 'px') {
    wrap.style.height = cssH + 'px';
  }
  const ctx = syncCanvasCssSize(canvas, cssW, cssH, dpr);
  const octx = syncCanvasCssSize(overlay, cssW, cssH, dpr);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#ffffff'; // white letterboxing; dark mode inverts via difference → near-black
  ctx.fillRect(0, 0, cssW, cssH);
  if (octx) {
    octx.globalCompositeOperation = 'source-over';
    octx.clearRect(0, 0, cssW, cssH);
  }

  if (!state.pageBitmap) return;
  if (state.pendingFit) fitView();

  ctx.save();
  ctx.translate(state.pan.x, state.pan.y);
  ctx.scale(state.zoom, state.zoom);
  // Hi-res PDF tiles are larger than pageW×pageH; always map into image space.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = moving && PERF.lowSmoothingWhileMoving ? 'low' : 'high';
  const vis = visibleImageRect();
  const tile = state.pdfTile && state.pdfTile.scale > state.pdfBmpScale ? state.pdfTile : null;
  // Base is skipped when the sharp tile already covers the whole visible area.
  if (!tile || !rectContains(tile, clipToPage(vis) || vis)) {
    drawBitmapVisible(ctx, state.pageBitmap, { x: 0, y: 0, w: state.pageW, h: state.pageH }, vis);
  }
  // Sharp viewport tile (deep zoom) over the base in its region (pdf.js tiles are opaque).
  if (tile) {
    const ratio = tile.scale / (state.zoom * dpr);
    const oneToOne = ratio > 0.97 && ratio < 1.03;
    if (oneToOne) ctx.imageSmoothingEnabled = false;
    drawBitmapVisible(ctx, tile.canvas, tile, vis);
    ctx.imageSmoothingEnabled = true;
  }
  // Dots under plan ink via multiply (same path light + dark, including sharp tiles).
  // Dark: use PART_DOT_PRE_INVERT so after difference+white the dots read as PART_DOT pink
  // while white/black plan ink stays on top — mirrors light multiply. No source-over halo
  // (that painted over white labels). No CSS filter (iOS memory).
  const darkUi = isDarkUi();
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  drawPartDots(ctx, darkUi ? PART_DOT_PRE_INVERT : PART_DOT);
  ctx.restore();

  ctx.restore(); // back to CSS-pixel space (dpr transform only)

  if (darkUi) {
    // Plain invert via difference+white (no hue pass): fine for B/W assembly drawings.
    ctx.save();
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.restore();
  }

  // Overlay: crosshair / cal markers only (same in light and dark — not under plan ink).
  const mctx = octx || ctx;
  mctx.save();
  mctx.translate(state.pan.x, state.pan.y);
  mctx.scale(state.zoom, state.zoom);
  mctx.globalCompositeOperation = 'source-over';

  // Calibration markers: only while placing reference points (not after cal is complete)
  if (!isCalibrated(state.cal, state.parts)) {
    if (state.cal.cal1.calId) {
      mctx.fillStyle = '#e11d48';
      mctx.beginPath();
      mctx.arc(state.cal.cal1.calX, state.cal.cal1.calY, 4 / state.zoom, 0, Math.PI * 2);
      mctx.fill();
    }
    if (state.cal.cal2.calId) {
      mctx.fillStyle = '#e11d48';
      mctx.beginPath();
      mctx.arc(state.cal.cal2.calX, state.cal.cal2.calY, 4 / state.zoom, 0, Math.PI * 2);
      mctx.fill();
    }
  }

  if (state.cursorPos) {
    drawCrosshair(mctx, state.cursorPos.x, state.cursorPos.y, CURSOR_GRAY);
  }
  if (state.crosshair) {
    drawCrosshair(mctx, state.crosshair.x, state.crosshair.y, ACCENT);
  }
  mctx.restore();
  updateCalSetBtn();
  // Safari backdrop re-sample hack: skip while moving (re-blur per frame is costly); settle draw does it.
  if (!moving) {
    nudgeChromeBackdrop();
    ensurePdfDetailForView();
  }
}

/**
 * Map viewport client coords → board CSS px (pan/zoom space).
 * Always uses a live getBoundingClientRect and scales by the canvas logical
 * size vs displayed size — after iPhone rotate, rect can briefly disagree with
 * style/backing-store width, which used to offset taps far from the finger.
 */
function clientToBoardCss(clientX, clientY) {
  const canvas = el.canvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const logicalW = (canvas.width / dpr) || rect.width || 1;
  const logicalH = (canvas.height / dpr) || rect.height || 1;
  const dispW = rect.width || logicalW;
  const dispH = rect.height || logicalH;
  const scaleX = logicalW / dispW;
  const scaleY = logicalH / dispH;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

function screenToImage(clientX, clientY) {
  const { x: sx, y: sy } = clientToBoardCss(clientX, clientY);
  return {
    x: (sx - state.pan.x) / state.zoom,
    y: (sy - state.pan.y) / state.zoom,
  };
}

function updateCrosshairFromSearch({ center = false } = {}) {
  state.crosshair = null;
  const hit = state.searchHit;
  if (!hit) {
    return;
  }
  if (!isCalibrated(state.cal, state.parts)) {
    setStatus(
      `${hit.id} gefunden — bitte auf dem Plan anklicken und im Menü „Referenzpunkt setzen“ (2 Referenzen nötig).`,
    );
    return;
  }
  const pos = cadToImage(hit, state.cal, state.parts);
  if (!pos) {
    setStatus('Kalibrierung ungültig — Referenzen neu setzen.');
    return;
  }
  state.crosshair = pos;
  setStatus(`${hit.id} → Bild ${pos.x}, ${pos.y}`);
  // Confirm: center only when Einpassen is visible (user zoomed/panned away from fit).
  // At fitted view (Einpassen hidden) keep pan unchanged — just show the crosshair.
  if (center && !isViewAtFit()) {
    const wrap = el.boardWrap;
    const topInset = syncChromeOffset();
    const { cssW, cssH } = boardCssSize();
    if (wrap.style.height !== cssH + 'px') wrap.style.height = cssH + 'px';
    state.pan = {
      x: cssW / 2 - pos.x * state.zoom,
      y: topInset + (cssH - topInset) / 2 - pos.y * state.zoom,
    };
    updateFitBtnVisibility();
  }
  draw();
}

function onSearch({ center = false } = {}) {
  const q = el.search.value.trim();
  const suggestions = suggestParts(state.parts, q);
  el.suggestions.innerHTML = '';
  sugActiveIndex = -1;
  if (q && suggestions.length) {
    el.suggestions.hidden = false;
    positionSuggestions();
    for (const p of suggestions) {
      const li = document.createElement('button');
      li.type = 'button';
      li.className = 'sug-item';
      li.textContent = partSearchLabel(p);
      li.addEventListener('click', () => confirmSuggestion(p));
      el.suggestions.appendChild(li);
    }
  } else {
    el.suggestions.hidden = true;
  }

  const hit = findPart(state.parts, q);
  state.searchHit = hit;
  if (!q) {
    state.crosshair = null;
    setStatus('');
    draw();
    return;
  }
  if (!hit) {
    state.crosshair = null;
    if (state.parts.length) setStatus(`Kein Bauteil „${q}“`);
    draw();
    return;
  }
  updateCrosshairFromSearch({ center });
  draw();
}

function saveReferencePoint() {
  openMenu(false);
  const hit = state.searchHit || findPart(state.parts, el.search.value);
  if (!hit) {
    setStatus('Zuerst im Suchfeld ein Referenz-Bauteil eingeben (z. B. FID1).');
    return;
  }
  if (!state.cursorPos) {
    setStatus('Zuerst auf dem Plan die Position dieses Bauteils anklicken.');
    return;
  }
  if (!state.pageBitmap) {
    setStatus('Bitte zuerst ein PDF laden.');
    return;
  }

  const pt = {
    calX: Math.round(state.cursorPos.x),
    calY: Math.round(state.cursorPos.y),
    calId: hit.id,
  };

  let next = {
    ...state.cal,
    cal1: { ...state.cal.cal1 },
    cal2: { ...state.cal.cal2 },
  };

  // Fill Cal1 then Cal2; if both set, replace Cal1 and clear Cal2 (start over) unless same id as Cal1 → overwrite Cal1
  if (!next.cal1.calId) {
    next.cal1 = pt;
  } else if (!next.cal2.calId) {
    if (next.cal1.calId === pt.calId) {
      setStatus('Referenz 2 muss ein anderes Bauteil sein.');
      return;
    }
    next.cal2 = pt;
  } else if (next.cal1.calId === pt.calId) {
    next.cal1 = pt;
  } else if (next.cal2.calId === pt.calId) {
    next.cal2 = pt;
  } else {
    // Both filled with other IDs → restart with this as Cal1
    next.cal1 = pt;
    next.cal2 = { calX: 0, calY: 0, calId: '' };
    next.flipX = false;
    next.flipY = false;
  }

  if (isCalibrated(next, state.parts) && state.pageW) {
    const sideParts = state.parts.filter((p) => p.side === hit.side);
    const best = pickBestFlips(next, state.parts, sideParts.length ? sideParts : state.parts, state.pageW, state.pageH);
    next = { ...next, flipX: best.flipX, flipY: best.flipY };
  }

  state.cal = next;
  clearCursorPos();
  persist();
  updateBadges();

  if (isCalibrated(state.cal, state.parts)) {
    setStatus(
      `Kalibriert: ${state.cal.cal1.calId} + ${state.cal.cal2.calId} (X-Spiegel=${state.cal.flipX ? 'an' : 'aus'}, Y=${state.cal.flipY ? 'an' : 'aus'})`,
    );
    updateCrosshairFromSearch();
  } else if (state.cal.cal1.calId) {
    setStatus(`Referenz 1 gespeichert (${state.cal.cal1.calId}). Zweites Bauteil suchen, anklicken, erneut setzen.`);
  }
  draw();
}

function clearCalibration() {
  openMenu(false);
  hideFlipPanel();
  state.cal = emptyCal();
  state.crosshair = null;
  persist();
  updateBadges();
  setStatus('Kalibrierung gelöscht.');
  if (state.searchHit) updateCrosshairFromSearch();
  draw();
}


/** Clear loaded plan / P&P / cal — leaves welcome/empty handling to the caller. */
async function clearLoadedDocument() {
  hideVariantPicker();
  hideFlipPanel();
  if (pdfDoc) {
    try { await pdfDoc.destroy(); } catch (_) {}
    pdfDoc = null;
  }
  state.parts = [];
  state.pdfName = '';
  state.pnpName = '';
  state.projectName = '';
  state.openFileName = '';
  state.openFileHandle = null;
  state.pdfBytes = null;
  state.pnpText = '';
  state.variants = [];
  state.activeVariantId = null;
  state.pnpValueReplace = null;
  state.pageBitmap = null;
  state.pageW = 0;
  state.pageH = 0;
  state.fullW = 0;
  state.fullH = 0;
  state.crop = null;
  state.isPdfSource = false;
  state.pdfBmpScale = 1;
  cancelPdfDetail();
  dropPdfTile();
  pdfPage = null;
  state.zoom = 1;
  state.pan = { x: 0, y: 0 };
  state.cal = emptyCal();
  clearCursorPos();
  state.searchHit = null;
  state.crosshair = null;
  state.pendingFit = true;
  state.pendingVariantPick = false;
  setBoms(null);
  if (el.search) el.search.value = '';
  if (el.suggestions) {
    el.suggestions.hidden = true;
    el.suggestions.innerHTML = '';
  }
  sugActiveIndex = -1;
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  updateBadges();
  draw();
  updateFitBtnVisibility();
}

async function closeDocument() {
  openMenu(false);
  await clearLoadedDocument();
  state.welcomeDismissed = false;
  showWelcome(true);
  setStatus('Dokument geschlossen.');
}

/** Fresh empty workspace (same as welcome „Neu“): clear any open doc, hide welcome. */
async function startNewDocument() {
  openMenu(false);
  // Nothing open (e.g. welcome „Neu“) → keep restored Stücklisten / cal from localStorage
  if (hasProjectContent()) await clearLoadedDocument();
  state.welcomeDismissed = true;
  showWelcome(false);
  if (el.empty) el.empty.hidden = hasProjectContent();
  setStatus('Neu — Menü → Öffnen oder Erstellen → Editiermenü → Bestückungsplan PDF / Pick & Place CSV laden. Optional im Editiermenü: Stücklisten laden (zeigt Lagerplatz).');
}


async function onPdfFile(file) {
  if (!file) return;
  state.pdfName = file.name;
  if (!state.openFileName || !isProjectFilename(state.openFileName)) state.openFileName = file.name;
  state.pdfBytes = new Uint8Array(await file.arrayBuffer());
  if (!state.projectName) state.projectName = file.name.replace(/\.[^.]+$/, '');
  try {
    const lower = file.name.toLowerCase();
    if (/\.(png|jpe?g|webp|gif)$/i.test(lower)) {
      await loadImageFile(file);
    } else {
      await renderPdfPage(file);
    }
    state.welcomeDismissed = false;
    setStatus(`Plan geladen: ${file.name}`);
    updateBadges();
    updateCrosshairFromSearch();
    if (state.variants.length) requestVariantPick();
  } catch (e) {
    console.error(e);
    setStatus('Plan konnte nicht geladen werden: ' + (e.message || e));
  }
}

async function onPnpFile(file, { asNewVariant = false, renewVariant = false } = {}) {
  if (!file) return;
  const text = decodePnpBytes(await file.arrayBuffer());
  const { parts, errors } = parsePkpCsv(text);
  if (!parts.length) {
    setStatus(errors[0] || 'Keine Bauteile in der Datei.');
    return;
  }
  if (renewVariant) {
    const label = currentVariantLabel();
    if (!renewActiveVariant(text, parts)) {
      setStatus('Keine aktive Variante zum Erneuern — zuerst Variante wählen.');
      return;
    }
    if (state.pnpValueReplace?.byRef) {
      applyPnpValueReplaceMap(state.pnpValueReplace.byRef, { sync: true });
    }
    if (state.cal.cal1.calId && !parts.some((p) => p.id === state.cal.cal1.calId)) {
      if (!state.cal.cal2.calId || !parts.some((p) => p.id === state.cal.cal2.calId)) {
        state.cal = emptyCal();
      }
    }
    state.crosshair = null;
    clearCursorPos();
    state.searchHit = null;
    if (el.search) el.search.value = '';
    persist();
    updateBadges();
    updateWelcome();
    draw();
    setStatus(
      `Variante erneuert: ${parts.length} Bauteile` +
        (errors.length ? ` (${errors.length} Warnungen)` : '') +
        ` · ${label}`,
    );
    onSearch();
    return;
  }
  setPartsAsVariant(file.name, text, parts, {
    replaceActive: !asNewVariant,
    add: asNewVariant,
  });
  // Drop cal IDs that no longer exist
  if (state.cal.cal1.calId && !parts.some((p) => p.id === state.cal.cal1.calId)) {
    if (!state.cal.cal2.calId || !parts.some((p) => p.id === state.cal.cal2.calId)) {
      state.cal = emptyCal();
    }
  }
  state.welcomeDismissed = false;
  persist();
  updateBadges();
  setStatus(
    (asNewVariant ? `Variante hinzugefügt: ` : `Pick & Place: `) +
      `${parts.length} Bauteile` +
      (errors.length ? ` (${errors.length} Warnungen)` : '') +
      ` · ${stemName(file.name)}`,
  );
  onSearch();
  requestVariantPick();
}




/** Open picker: .zip only (legacy .bsu still readable if opened another way). Save: .zip only. */
const PROJECT_OPEN_TYPES = [
  {
    description: 'Bauteile Suchen Projekt (.zip)',
    accept: { 'application/zip': ['.zip'] },
  },
];
const PROJECT_SAVE_TYPES = [
  {
    description: 'Bauteile Suchen Projekt (.zip)',
    accept: { 'application/zip': ['.zip'] },
  },
];

function canOpenFilePicker() {
  return typeof window.showOpenFilePicker === 'function';
}

function canSaveFilePicker() {
  return typeof window.showSaveFilePicker === 'function';
}

/** @param {FileSystemFileHandle} handle @param {Blob} blob */
async function writeBlobToHandle(handle, blob) {
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
}

async function pickAndOpenProject() {
  openMenu(false);
  if (canOpenFilePicker()) {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: PROJECT_OPEN_TYPES,
        excludeAcceptAllOption: false,
      });
      const file = await handle.getFile();
      await openProjectFile(file, { handle });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.error(e);
      setStatus('Öffnen fehlgeschlagen: ' + (e.message || e));
      return;
    }
  }
  el.bsuInput.click();
}

async function saveProject() {
  openMenu(false);
  if (!state.pdfBytes && !state.pnpText) {
    setStatus('Nichts zu sichern — bitte PDF und/oder Pick & Place CSV laden.');
    return;
  }
  try {
    // Always save protected: get (or set) this device's master key first — Abbrechen = don't save.
    let master = await getStoredMasterKey();
    if (!master) {
      const code = await showCodeSetDialog({
        text: 'Code für geschützte Dateien eingeben',
        confirmText: 'Code zur Bestätigung wiederholen',
        showHint: true,
      });
      if (!code) {
        setStatus('Sichern abgebrochen.');
        return;
      }
      master = await deriveMasterKey(code);
      await storeMasterKey(master);
    }
    const innerZip = await buildBsuZip({
      name: state.projectName || state.pdfName?.replace(/\.[^.]+$/, '') || 'Bauteile_Suchen',
      pdfName: state.pdfName || 'board.pdf',
      pnpName: state.pnpName || 'PKP.csv',
      pdfBytes: state.pdfBytes,
      pnpText: state.pnpText,
      variants: state.variants.map((v) => ({
        id: v.id,
        name: v.name,
        pnpName: v.pnpName,
        pnpText: v.pnpText,
      })),
      activeVariantId: state.activeVariantId,
      cal: normalizeCal(state.cal),
      pageW: state.pageW,
      pageH: state.pageH,
      stuecklisten: state.boms.smd || state.boms.bg ? state.boms : null,
      pnpValueReplace: state.pnpValueReplace,
    });
    const blob = await encryptProjectZip(innerZip, master);
    const fname = suggestedBsuFilename({
      name: state.projectName,
      pdfName: state.pdfName,
    });

    // Legacy .bsu opened → never write .bsu again; Save-As / download as .zip instead.
    if (state.openFileHandle && isBsuFilename(state.openFileHandle.name)) {
      state.openFileHandle = null;
    }
    if (isBsuFilename(state.openFileName)) state.openFileName = fname;

    // Prefer overwrite of the file that was opened (File System Access API).
    if (state.openFileHandle) {
      try {
        await writeBlobToHandle(state.openFileHandle, blob);
        const name = state.openFileHandle.name || state.openFileName || fname;
        state.openFileName = name;
        setStatus(`Gesichert: ${name}`);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') {
          setStatus('Sichern abgebrochen.');
          return;
        }
        console.warn('Overwrite via handle failed, falling back', e);
        state.openFileHandle = null;
      }
    }

    // New project / no handle: let user choose path (Windows/Chrome), else download.
    if (canSaveFilePicker()) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: fname,
          types: PROJECT_SAVE_TYPES,
          excludeAcceptAllOption: false,
        });
        await writeBlobToHandle(handle, blob);
        state.openFileHandle = handle;
        state.openFileName = handle.name || fname;
        setStatus(`Gesichert: ${state.openFileName}`);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') {
          setStatus('Sichern abgebrochen.');
          return;
        }
        console.warn('showSaveFilePicker failed, falling back to download', e);
      }
    }

    downloadBlob(fname, blob);
    setStatus(`Gesichert: ${fname}`);
  } catch (e) {
    console.error(e);
    setStatus('Sichern fehlgeschlagen: ' + (e.message || e));
  }
}

/**
 * Decrypt a protected project: stored device key first (silent), else ask for the code.
 * @returns {Promise<Uint8Array|null>} inner ZIP bytes, or null when cancelled
 */
async function unlockEncryptedProject(outer, manifest) {
  let master = await getStoredMasterKey();
  if (!master || !(await verifyMasterKey(master, manifest))) {
    master = null;
    const ok = await showCodeDialog({
      title: 'Datei ist geschützt.',
      text: 'Bitte Code eingeben.',
      onSuccess: () => {
        // Hide welcome under the dialog before it closes — avoids a flash of the
        // welcome screen between dialog dismiss and project load completing.
        state.welcomeDismissed = true;
        showWelcome(false);
      },
      verify: async (code) => {
        const m = await deriveMasterKey(code);
        if (!(await verifyMasterKey(m, manifest))) return false;
        master = m;
        return true;
      },
    });
    if (!ok || !master) return null;
    await storeMasterKey(master);
  }
  return decryptProjectZip(outer, manifest, master);
}

// ---------------------------------------------------------------- Code dialog
let codeFailCount = 0; // brute-force friction (per session): 1s, 2s, 4s … max 30s after wrong codes
let codeDialogBusy = false;
const CODE_SUCCESS_MS = 700; // green success hold (Schaltkreise-style) before dialog closes

function paintCodeSuccess(form, okBtn) {
  form.classList.remove('shake');
  form.classList.add('success');
  okBtn.classList.add('success');
  okBtn.textContent = '✓ OK';
  okBtn.disabled = true;
  const input = document.getElementById('codeInput');
  if (input) {
    input.disabled = true;
    try { input.blur(); } catch (_) {}
  }
}

function clearCodeSuccess(form, okBtn) {
  form.classList.remove('success');
  okBtn.classList.remove('success');
  okBtn.textContent = 'OK';
}

/**
 * Modal code dialog (6–10 alphanumeric). `verify(code)` → true closes with OK, false = „Code falsch“.
 * Optional `onSuccess()` runs after verify OK, before the green hold (e.g. hide welcome).
 * @returns {Promise<boolean>} true = OK & verified, false = Abbrechen
 */
function showCodeDialog({ title, text, verify, onSuccess, showHint = false, successHold = true }) {
  const dlg = document.getElementById('codeDialog');
  const form = document.getElementById('codeForm');
  const input = document.getElementById('codeInput');
  const err = document.getElementById('codeError');
  const okBtn = document.getElementById('codeOk');
  const cancelBtn = document.getElementById('codeCancel');
  const titleEl = document.getElementById('codeDialogTitle');
  const textEl = document.getElementById('codeDialogText');
  const hintEl = document.getElementById('codeHint');
  if (title) {
    titleEl.textContent = title;
    titleEl.hidden = false;
    textEl.textContent = text || '';
    textEl.hidden = !text;
    form.classList.toggle('title-only', !text);
  } else {
    titleEl.textContent = '';
    titleEl.hidden = true;
    textEl.textContent = text || '';
    textEl.hidden = !text;
    form.classList.add('title-only');
  }
  if (hintEl) hintEl.hidden = !showHint;
  if (codeDialogBusy) return Promise.resolve(false);
  codeDialogBusy = true;
  input.value = '';
  err.textContent = '';
  input.disabled = false;
  okBtn.disabled = false;
  const prevFocus = document.activeElement;
  dlg.hidden = false;
  input.focus();

  return new Promise((resolve) => {
    let checking = false;
    let lockTimer = 0;
    const setBusy = (b) => {
      input.disabled = b;
      okBtn.disabled = b;
    };
    const finish = (result) => {
      clearTimeout(lockTimer);
      form.removeEventListener('submit', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('keydown', onKey);
      input.removeEventListener('input', onInput);
      clearCodeSuccess(form, okBtn);
      cancelBtn.disabled = false;
      dlg.hidden = true;
      input.value = '';
      err.textContent = '';
      codeDialogBusy = false;
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus({ preventScroll: true });
      resolve(result);
    };
    const fail = (msg) => {
      err.textContent = msg;
      const card = form;
      card.classList.remove('shake');
      void card.offsetWidth; // restart animation
      card.classList.add('shake');
      input.value = '';
    };
    const onInput = () => {
      const cleaned = sanitizeCodeInput(input.value);
      if (cleaned !== input.value) input.value = cleaned;
      if (err.textContent && !input.disabled && input.value) err.textContent = '';
    };
    const onSubmit = async (ev) => {
      ev.preventDefault();
      if (checking || input.disabled) return;
      const code = sanitizeCodeInput(input.value);
      input.value = code;
      if (!isValidCode(code)) {
        fail('Bitte 6–10 Zeichen (Buchstaben und Zahlen) eingeben');
        input.focus();
        return;
      }
      checking = true;
      setBusy(true);
      let ok = false;
      try {
        ok = await verify(code);
      } catch (e) {
        console.error(e);
      }
      checking = false;
      if (ok) {
        codeFailCount = 0;
        try {
          if (typeof onSuccess === 'function') onSuccess();
        } catch (e) {
          console.warn(e);
        }
        if (successHold) {
          paintCodeSuccess(form, okBtn);
          cancelBtn.disabled = true;
          await new Promise((r) => { lockTimer = setTimeout(r, CODE_SUCCESS_MS); });
          cancelBtn.disabled = false;
          clearCodeSuccess(form, okBtn);
        }
        finish(true);
        return;
      }
      codeFailCount += 1;
      fail('Code falsch');
      const wait = Math.min(30000, 1000 * 2 ** (codeFailCount - 1));
      lockTimer = setTimeout(() => {
        setBusy(false);
        input.focus();
      }, wait);
    };
    const onCancel = () => finish(false);
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      }
    };
    form.addEventListener('submit', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('keydown', onKey);
    input.addEventListener('input', onInput);
  });
}

/**
 * Two-step code entry (enter + repeat). Never persists the code itself — caller derives a key.
 * @returns {Promise<string|null>} matching code, or null if Abbrechen
 */
function showCodeSetDialog({ title, text, confirmText, mismatchText, showHint = true } = {}) {
  const step1Text = text || 'Neuen Code eingeben';
  const step2Text = confirmText || 'Code zur Bestätigung wiederholen';
  const mismatch = mismatchText || 'Codes stimmen nicht überein';
  const dlg = document.getElementById('codeDialog');
  const form = document.getElementById('codeForm');
  const input = document.getElementById('codeInput');
  const err = document.getElementById('codeError');
  const okBtn = document.getElementById('codeOk');
  const cancelBtn = document.getElementById('codeCancel');
  const titleEl = document.getElementById('codeDialogTitle');
  const textEl = document.getElementById('codeDialogText');
  const hintEl = document.getElementById('codeHint');
  const applyPrompt = (prompt, { hint } = {}) => {
    if (title) {
      titleEl.textContent = title;
      titleEl.hidden = false;
      textEl.textContent = prompt;
      textEl.hidden = false;
      form.classList.remove('title-only');
    } else {
      titleEl.textContent = '';
      titleEl.hidden = true;
      textEl.textContent = prompt;
      textEl.hidden = false;
      form.classList.add('title-only');
    }
    if (hintEl) hintEl.hidden = !hint;
  };
  applyPrompt(step1Text, { hint: !!showHint });
  if (codeDialogBusy) return Promise.resolve(null);
  codeDialogBusy = true;
  input.value = '';
  err.textContent = '';
  input.disabled = false;
  okBtn.disabled = false;
  const prevFocus = document.activeElement;
  dlg.hidden = false;
  input.focus();

  return new Promise((resolve) => {
    let first = null; // only in memory for this dialog session
    const finish = (result) => {
      first = null;
      form.removeEventListener('submit', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('keydown', onKey);
      input.removeEventListener('input', onInput);
      clearCodeSuccess(form, okBtn);
      cancelBtn.disabled = false;
      dlg.hidden = true;
      input.value = '';
      err.textContent = '';
      codeDialogBusy = false;
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus({ preventScroll: true });
      resolve(result);
    };
    const shake = (msg) => {
      err.textContent = msg;
      form.classList.remove('shake');
      void form.offsetWidth;
      form.classList.add('shake');
      input.value = '';
    };
    const onInput = () => {
      const cleaned = sanitizeCodeInput(input.value);
      if (cleaned !== input.value) input.value = cleaned;
      if (err.textContent && input.value) err.textContent = '';
    };
    const onSubmit = (ev) => {
      ev.preventDefault();
      if (input.disabled) return;
      const code = sanitizeCodeInput(input.value);
      input.value = code;
      if (!isValidCode(code)) {
        shake('Bitte 6–10 Zeichen (Buchstaben und Zahlen) eingeben');
        input.focus();
        return;
      }
      if (first === null) {
        first = code;
        input.value = '';
        err.textContent = '';
        applyPrompt(step2Text, { hint: false });
        input.focus();
        return;
      }
      if (code !== first) {
        first = null;
        shake(mismatch);
        applyPrompt(step1Text, { hint: !!showHint });
        input.focus();
        return;
      }
      const matched = first;
      first = null;
      input.disabled = true;
      okBtn.disabled = true;
      cancelBtn.disabled = true;
      paintCodeSuccess(form, okBtn);
      setTimeout(() => {
        cancelBtn.disabled = false;
        clearCodeSuccess(form, okBtn);
        finish(matched);
      }, CODE_SUCCESS_MS);
    };
    const onCancel = () => finish(null);
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(null);
      }
    };
    form.addEventListener('submit', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('keydown', onKey);
    input.addEventListener('input', onInput);
  });
}


async function openProjectFile(file, { handle = null } = {}) {
  if (!file) return;
  try {
    if (!isProjectFilename(file.name)) {
      setStatus('Bitte eine Projektdatei (.zip) öffnen.');
      return;
    }
    const outer = await globalThis.JSZip.loadAsync(file);
    const manifest = await readEncryptedManifest(outer);
    let source = outer; // unencrypted .zip / legacy .bsu → open as before
    if (manifest) {
      const inner = await unlockEncryptedProject(outer, manifest);
      if (!inner) {
        setStatus('Öffnen abgebrochen.');
        return;
      }
      source = inner;
    }
    const loaded = await loadBsuZip(source);
    state.openFileHandle = handle || null;
    state.openFileName = file.name;
    state.projectName =
      loaded.meta?.name ||
      file.name.replace(/\.bsu$/i, '').replace(/\.zip$/i, '') ||
      '';
    // Cal remapped after board load (crop may shift image space vs legacy full-page).
    const savedCal = normalizeCal(loaded.cal);
    const savedPageW = loaded.pageW || loaded.meta?.pageW || 0;
    const savedPageH = loaded.pageH || loaded.meta?.pageH || 0;
    state.cal = savedCal;
    state.crosshair = null;
    clearCursorPos();
    state.searchHit = null;
    el.search.value = '';
    
    // Variants (multi P&P) — fall back to single legacy pnp
    const rawVariants =
      (loaded.variants && loaded.variants.length
        ? loaded.variants
        : loaded.pnpText
          ? [{ id: 'v1', name: stemName(loaded.pnpName), pnpName: loaded.pnpName, pnpText: loaded.pnpText }]
          : []);
    state.variants = rawVariants.map((v, i) => {
      const { parts, errors } = parsePkpCsv(v.pnpText || '');
      if (errors?.length) console.warn(v.pnpName, errors);
      return {
        id: v.id || `v${i + 1}`,
        name: stemName(v.pnpName) || v.name || `Variante ${i + 1}`,
        pnpName: v.pnpName || `variante_${i + 1}.csv`,
        pnpText: v.pnpText || '',
        parts,
      };
    });
    if (loaded.activeVariantId === REFS_ONLY_ID) {
      state.activeVariantId = REFS_ONLY_ID;
    } else if (loaded.activeVariantId && state.variants.some((v) => v.id === loaded.activeVariantId)) {
      state.activeVariantId = loaded.activeVariantId;
    } else {
      // Default: first dropdown entry = Nur Bauteil Referenzen
      state.activeVariantId = state.variants.length ? REFS_ONLY_ID : null;
    }
    // Stücklisten from project .zip replace current ones; older projects without → keep loaded lists
    if (loaded.stuecklisten) setBoms(loaded.stuecklisten);
    if (loaded.pnpValueReplace?.byRef) {
      state.pnpValueReplace = loaded.pnpValueReplace;
      applyPnpValueReplaceMap(loaded.pnpValueReplace.byRef, { sync: false });
    } else {
      state.pnpValueReplace = null;
    }
    syncActiveVariantParts();
    updateVariantBar();
    state.welcomeDismissed = true;
    showWelcome(false);

    if (loaded.pdfBytes) {
      state.pdfName = loaded.pdfName;
      state.pdfBytes = loaded.pdfBytes;
      const lower = loaded.pdfName.toLowerCase();
      const mime = /\.(png)$/i.test(lower)
        ? 'image/png'
        : /\.(jpe?g)$/i.test(lower)
          ? 'image/jpeg'
          : /\.webp$/i.test(lower)
            ? 'image/webp'
            : 'application/pdf';
      const f = new File([loaded.pdfBytes], loaded.pdfName, { type: mime });
      if (/\.(png|jpe?g|webp|gif)$/i.test(lower)) {
        await loadImageFile(f);
      } else {
        await renderPdfPage(f);
      }
      state.cal = remapCalToCroppedSpace(savedCal, savedPageW, savedPageH);
    } else {
      state.pdfName = '';
      state.pdfBytes = null;
      state.pageBitmap = null;
      el.empty.hidden = false;
    }

    persist();
    updateBadges();
    updateCrosshairFromSearch();
    const flipHint =
      state.cal.flipX || state.cal.flipY
        ? ` · Spiegel X=${state.cal.flipX ? 'an' : 'aus'} Y=${state.cal.flipY ? 'an' : 'aus'}`
        : '';
    setStatus(
      `Geöffnet: ${file.name}` +
        (state.parts.length ? ` · ${state.parts.length} Bauteile` : '') +
        (isCalibrated(state.cal, state.parts) ? ' · kalibriert' : '') +
        flipHint,
    );
    draw();
    if (state.variants.length) requestVariantPick();
  } catch (e) {
    console.error(e);
    setStatus('Öffnen fehlgeschlagen: ' + (e.message || e));
    if (!hasProjectContent()) {
      state.welcomeDismissed = false;
      updateWelcome();
    }
  }
}

// Pointer / pan / zoom
el.canvas.addEventListener('pointerdown', (ev) => {
  cancelPdfDetail();
  el.canvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      zoom: state.zoom,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      panX: state.pan.x,
      panY: state.pan.y,
    };
    drag = null;
    return;
  }
  drag = { ox: ev.clientX, oy: ev.clientY, px: state.pan.x, py: state.pan.y, moved: false };
});

el.canvas.addEventListener('pointermove', (ev) => {
  if (!pointers.has(ev.pointerId)) return;
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const factor = dist / (pinch.dist || 1);
    const newZoom = Math.min(ZOOM_MAX, Math.max(0.05, pinch.zoom * factor));
    const origin = clientToBoardCss(pinch.midX, pinch.midY);
    // Recompute origin in the *current* display mapping for the moving midpoint
    const now = clientToBoardCss(midX, midY);
    const imgX = (origin.x - pinch.panX) / pinch.zoom;
    const imgY = (origin.y - pinch.panY) / pinch.zoom;
    // Use board-css of current midpoint for pan (same scale as logical canvas)
    const midBoard = now;
    state.zoom = newZoom;
    state.pan = {
      x: midBoard.x - imgX * newZoom,
      y: midBoard.y - imgY * newZoom,
    };
    updateFitBtnVisibility();
    requestDraw();
    return;
  }
  if (!drag) return;
  const dx = ev.clientX - drag.ox;
  const dy = ev.clientY - drag.oy;
  if (Math.hypot(dx, dy) > 4) drag.moved = true;
  if (drag.moved) {
    state.pan = { x: drag.px + dx, y: drag.py + dy };
    updateFitBtnVisibility();
    requestDraw();
  }
});

function endPointer(ev) {
  if (drag && !drag.moved && state.pageBitmap) {
    const img = screenToImage(ev.clientX, ev.clientY);
    const hitPart = hitTestPartAt(img.x, img.y);
    if (hitPart) {
      // Tap on a part dot → fill search + pink crosshair; do NOT pan/center the view
      clearCursorPos();
      confirmSuggestion(hitPart, { center: false });
      // confirmSuggestion already draws; still need to fall through to pointer cleanup
    } else {
      setCursorPos(img);
      setStatus(
        `Klick @ ${Math.round(state.cursorPos.x)}, ${Math.round(state.cursorPos.y)}` +
          (state.searchHit ? ` — Kalibrierung setzen (${state.searchHit.id})` : ''),
      );
      draw();
    }
  }
  pointers.delete(ev.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) {
    drag = null;
    // Settle: full draw (layout + backdrop re-sample), then sharp re-render
    requestDraw();
    updateFitBtnVisibility();
  }
  schedulePdfRerender();
}

el.canvas.addEventListener('pointerup', endPointer);
el.canvas.addEventListener('pointercancel', endPointer);

// Desktop: pointer cursor when hovering a part within the hit radius (visual dots unchanged).
el.canvas.addEventListener('pointermove', (ev) => {
  if (ev.pointerType === 'touch') return;
  if (pointers.size > 0 || pinch) return; // dragging / pinching
  if (!state.pageBitmap || !isCalibrated(state.cal, state.parts)) {
    el.canvas.style.cursor = '';
    return;
  }
  const img = screenToImage(ev.clientX, ev.clientY);
  el.canvas.style.cursor = hitTestPartAt(img.x, img.y) ? 'pointer' : '';
}, { passive: true });
el.canvas.addEventListener('pointerleave', () => {
  el.canvas.style.cursor = '';
});

el.canvas.addEventListener(
  'wheel',
  (ev) => {
    if (!state.pageBitmap) return;
    ev.preventDefault();
    const { x: mx, y: my } = clientToBoardCss(ev.clientX, ev.clientY);
    const imgX = (mx - state.pan.x) / state.zoom;
    const imgY = (my - state.pan.y) / state.zoom;
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    state.zoom = Math.min(ZOOM_MAX, Math.max(0.05, state.zoom * factor));
    state.pan = { x: mx - imgX * state.zoom, y: my - imgY * state.zoom };
    if (performance.now() >= wheelActiveUntil) cancelPdfDetail();
    wheelActiveUntil = performance.now() + 180;
    clearTimeout(wheelSettleTimer);
    wheelSettleTimer = setTimeout(() => {
      updateFitBtnVisibility();
      requestDraw(); // settle draw (layout + backdrop re-sample)
    }, 200);
    updateFitBtnVisibility();
    requestDraw();
    schedulePdfRerender();
  },
  { passive: false },
);

window.addEventListener('resize', () => {
  invalidateBoardLayout();
  syncShellToViewport();
  syncChromeOffset();
  fitDocTitle();
  fitSearchLabelFont();
  if (isTouchUi()) {
    const next = orientBucket();
    if (next !== lastOrientBucket) {
      lastOrientBucket = next;
      scheduleTouchOrientFit('resize-orient');
      return;
    }
  }
  if (state.pageBitmap) {
    // Desktop / same-orientation resize: keep pan/zoom (no auto-fit)
    if (!touchOrientFitTimer) state.pendingFit = false;
    draw();
    updateFitBtnVisibility();
  }
});

function onVisualViewportChange() {
  invalidateBoardLayout();
  syncShellToViewport();
  syncChromeOffset();
  if (isTouchUi()) {
    const next = orientBucket();
    if (next !== lastOrientBucket) {
      lastOrientBucket = next;
      scheduleTouchOrientFit('visualViewport');
      return;
    }
  }
  if (state.pageBitmap) draw();
  fitDocTitle();
  fitSearchLabelFont();
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', onVisualViewportChange);
  window.visualViewport.addEventListener('scroll', onVisualViewportChange);
}

// UI wiring
el.menuBtn.addEventListener('click', () => openMenu(!state.menuOpen));
el.menuBackdrop.addEventListener('click', () => openMenu(false));
document.getElementById('menuEdit')?.addEventListener('click', () => {
  showEditMenu(true);
});
document.getElementById('menuEditBack')?.addEventListener('click', () => {
  showEditMenu(false);
});
document.addEventListener('pointerdown', (ev) => {
  if (!state.menuOpen) return;
  const t = ev.target;
  if (el.drawer?.contains(t) || el.menuBtn?.contains(t)) return;
  openMenu(false);
}, true);
document.getElementById('menuOpen').addEventListener('click', () => {
  void pickAndOpenProject();
});
document.getElementById('menuNew')?.addEventListener('click', () => {
  void startNewDocument();
});
document.getElementById('menuSave').addEventListener('click', () => {
  void saveProject();
});
document.getElementById('menuClose').addEventListener('click', () => {
  void closeDocument();
});
document.getElementById('menuPdf').addEventListener('click', () => {
  openMenu(false);
  el.pdfInput.click();
});
document.getElementById('menuPnp').addEventListener('click', () => {
  openMenu(false);
  el.pnpInput.click();
});
document.getElementById('menuSetRef').addEventListener('click', saveReferencePoint);
if (el.calSetBtn) el.calSetBtn.addEventListener('click', (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  saveReferencePoint();
});
document.getElementById('menuMirrorCal').addEventListener('click', () => {
  showFlipPanel();
});
document.getElementById('menuClearCal').addEventListener('click', clearCalibration);
if (el.flipXBtn) el.flipXBtn.addEventListener('click', () => toggleCalFlip('flipX'));
if (el.flipYBtn) el.flipYBtn.addEventListener('click', () => toggleCalFlip('flipY'));
if (el.flipPanelDone) el.flipPanelDone.addEventListener('click', hideFlipPanel);
if (el.flipPanel) el.flipPanel.addEventListener('click', (ev) => {
  if (ev.target === el.flipPanel) hideFlipPanel();
});
document.getElementById('menuChangeCode')?.addEventListener('click', async () => {
  openMenu(false);
  try {
    const existing = await getStoredMasterKey();
    if (existing) {
      // Legacy keys without verifier: create verifier from the stored non-extractable master
      // (PBKDF2 uses a fixed app-wide salt, so a later code entry can be checked the same way).
      await ensureDeviceVerifier(existing);
      const okCurrent = await showCodeDialog({
        title: 'Code ändern',
        text: 'Aktuellen Code eingeben',
        showHint: false,
        successHold: false, // green success only after new code is confirmed
        verify: async (code) => {
          const candidate = await deriveMasterKey(code);
          const verifier = await getDeviceVerifier();
          return verifyDeviceVerifier(candidate, verifier);
        },
      });
      if (!okCurrent) {
        showToast('Code ändern abgebrochen.');
        return;
      }
    }
    const code = await showCodeSetDialog({
      title: 'Code ändern',
      text: 'Neuen Code eingeben',
      confirmText: 'Code zur Bestätigung wiederholen',
      showHint: true,
    });
    if (!code) {
      showToast('Code ändern abgebrochen.');
      return;
    }
    const master = await deriveMasterKey(code);
    await storeMasterKey(master); // also replaces device verifier
    showToast('Neuer Code gespeichert. Gilt ab dem nächsten Sichern.');
  } catch (e) {
    console.error(e);
    showToast('Code konnte nicht geändert werden: ' + (e.message || e));
  }
});
document.getElementById('menuForgetCode')?.addEventListener('click', async () => {
  openMenu(false);
  try {
    await forgetMasterKey();
    showToast('Code auf diesem Gerät vergessen. Beim nächsten Öffnen/Sichern wird er abgefragt.');
  } catch (e) {
    console.error(e);
    showToast('Code konnte nicht entfernt werden: ' + (e.message || e));
  }
});

document.getElementById('menuAbout').addEventListener('click', () => {
  openMenu(false);
  alert(`Bauteile Suchen ${VERSION}

© BEAK electronic engineering GmbH & Co. KG

Menü → Datei öffnen (Projekt .zip)
oder Erstellen → Editiermenü → Bestückungsplan PDF / Pick & Place CSV laden
Bestückungsvarianten: weitere Pick & Place CSV-Dateien hinzufügen
Stücklisten (optional): Lagerplatz zur BEAK-Nr. im Suchfeld`);
});
if (el.btnZoomFit) {
  el.btnZoomFit.addEventListener('click', () => {
    state.pendingFit = true;
    draw();
    updateFitBtnVisibility();
  });
}

el.pdfInput.addEventListener('change', () => {
  const f = el.pdfInput.files?.[0];
  el.pdfInput.value = '';
  onPdfFile(f);
});
el.pnpInput.addEventListener('change', () => {
  const f = el.pnpInput.files?.[0];
  el.pnpInput.value = '';
  onPnpFile(f);
});
el.bsuInput.addEventListener('change', () => {
  const f = el.bsuInput.files?.[0];
  el.bsuInput.value = '';
  void openProjectFile(f, { handle: null });
});

el.search.addEventListener('input', onSearch);
el.search.addEventListener('focus', () => {
  // Select all so the next keystroke replaces the previous hit
  requestAnimationFrame(() => {
    try { el.search.select(); } catch (_) {}
  });
});
el.search.addEventListener('pointerup', (ev) => {
  if (!el.search.value) return;
  // Prevent caret placement from clearing the selection on click
  ev.preventDefault();
  try { el.search.select(); } catch (_) {}
});
el.search.addEventListener('keydown', (ev) => {
  const open = el.suggestions && !el.suggestions.hidden;
  const items = open ? sugItems() : [];

  if (ev.key === 'Escape') {
    el.suggestions.hidden = true;
    sugActiveIndex = -1;
    el.search.blur();
    return;
  }
  if (ev.key === 'ArrowDown' && items.length) {
    ev.preventDefault();
    setSugActive(sugActiveIndex < 0 ? 0 : sugActiveIndex + 1);
    return;
  }
  if (ev.key === 'ArrowUp' && items.length) {
    ev.preventDefault();
    setSugActive(sugActiveIndex < 0 ? items.length - 1 : sugActiveIndex - 1);
    return;
  }
  if (ev.key === 'Enter') {
    if (items.length && sugActiveIndex >= 0 && items[sugActiveIndex]) {
      ev.preventDefault();
      items[sugActiveIndex].click();
      return;
    }
    el.suggestions.hidden = true;
    sugActiveIndex = -1;
    onSearch({ center: true });
  }
});

document.addEventListener('click', (ev) => {
  if (!el.suggestions.contains(ev.target) && ev.target !== el.search) {
    el.suggestions.hidden = true;
  }
});

// Welcome + variants wiring
if (el.welcomeOpenBtn) {
  el.welcomeOpenBtn.addEventListener('click', () => {
    void pickAndOpenProject();
  });
}
if (el.welcomeNewBtn) {
  el.welcomeNewBtn.addEventListener('click', () => {
    void startNewDocument();
  });
}
document.getElementById('menuVariantAdd')?.addEventListener('click', () => {
  openMenu(false);
  variantFileMode = 'add';
  el.variantInput?.click();
});
document.getElementById('menuVariantPick')?.addEventListener('click', () => {
  openMenu(false);
  if (!state.variants.length) {
    setStatus('Noch keine Pick & Place CSV-Variante geladen.');
    return;
  }
  showVariantPicker('pick');
});
document.getElementById('menuVariantRenew')?.addEventListener('click', () => {
  openMenu(false);
  if (!state.variants.length) {
    setStatus('Noch keine Pick & Place CSV-Variante geladen.');
    return;
  }
  if (isRefsOnlyMode() || !state.activeVariantId || state.activeVariantId === REFS_ONLY_ID) {
    setStatus('Zuerst eine Bestückungsvariante wählen (nicht „Nur Bauteil Referenzen“).');
    return;
  }
  variantFileMode = 'renew';
  el.variantInput?.click();
});
document.getElementById('menuVariantRemove')?.addEventListener('click', () => {
  openMenu(false);
  if (!state.variants.length) {
    setStatus('Keine Variante zum Entfernen vorhanden.');
    return;
  }
  showVariantPicker('remove');
});
document.getElementById('menuPnpReplace')?.addEventListener('click', () => {
  openMenu(false);
  if (!state.variants.length && !state.parts.length) {
    setStatus('Bitte zuerst Pick & Place laden.');
    showToast('Bitte zuerst Pick & Place laden.', 4000);
    return;
  }
  el.pnpReplaceInput?.click();
});
if (el.pnpReplaceInput) {
  el.pnpReplaceInput.addEventListener('change', () => {
    const f = el.pnpReplaceInput.files?.[0];
    el.pnpReplaceInput.value = '';
    void onPnpReplaceFile(f);
  });
}
document.getElementById('menuBomSmd')?.addEventListener('click', () => {
  openMenu(false);
  bomFileSource = 'smd';
  el.bomInput?.click();
});
document.getElementById('menuBomBg')?.addEventListener('click', () => {
  openMenu(false);
  bomFileSource = 'bg';
  el.bomInput?.click();
});
if (el.bomInput) {
  el.bomInput.addEventListener('change', () => {
    const f = el.bomInput.files?.[0];
    el.bomInput.value = '';
    void onBomFile(f, bomFileSource);
  });
}
if (el.variantInput) {
  el.variantInput.addEventListener('change', () => {
    const f = el.variantInput.files?.[0];
    el.variantInput.value = '';
    const mode = variantFileMode;
    variantFileMode = 'add';
    if (mode === 'renew') void onPnpFile(f, { renewVariant: true });
    else void onPnpFile(f, { asNewVariant: true });
  });
}
if (el.variantCurrentBtn) {
  el.variantCurrentBtn.addEventListener('click', () => {
    if (!state.variants.length) return;
    showVariantPicker();
  });
}

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (state.menuOpen && state.editMenuOpen) {
    showEditMenu(false);
    ev.preventDefault();
    return;
  }
  if (state.menuOpen) {
    openMenu(false);
    ev.preventDefault();
    return;
  }
  if (state.flipPanelOpen) {
    hideFlipPanel();
    ev.preventDefault();
  }
});

// Perf test hook (only with ?perfdebug in the URL)
if (perfDebug) window.__planDebug = Object.assign(perfDebug, { state, PERF });

// Boot
restoreMeta();
syncShellToViewport();
updateBadges();
updateWelcome();
setStatus('Projekt öffnen (.zip) oder Bestückungsplan PDF und Pick & Place CSV laden (Menü).');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('./sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      reg.update().catch(() => {});
    })
    .catch(() => {});
}

syncChromeOffset();


// Live appearance switch: re-draw (canvas invert + dot blend); reuse/free existing bitmaps
try {
  const mqDark = window.matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => {
    try { if (typeof window.__syncThemeChrome === 'function') window.__syncThemeChrome(); } catch (_) {}
    draw();
  };
  if (mqDark.addEventListener) mqDark.addEventListener('change', onScheme);
  else if (mqDark.addListener) mqDark.addListener(onScheme);
} catch (_) {}

window.addEventListener('orientationchange', () => {
  scheduleTouchOrientFit('orientationchange');
});
if (screen.orientation && typeof screen.orientation.addEventListener === 'function') {
  screen.orientation.addEventListener('change', () => scheduleTouchOrientFit('screen.orientation'));
}

window.addEventListener('resize', positionSuggestions);
window.addEventListener('scroll', positionSuggestions, true);
