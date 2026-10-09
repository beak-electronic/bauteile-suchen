/** Project file = plain .zip (legacy: .BSU, same content) for Bauteile Suchen (parity with Bestückungsplan projekt.zip). */

import { normalizeCal } from './calibration.js';
import { decodePnpBytes } from './pnp.js';

export const PROJECT_JSON_NAME = 'projekt.json';
export const BSU_VERSION = '1.3.0-bsu';

function sanitizeName(n, fallback) {
  const s = (n || fallback).replace(/[\\/:*?"<>|]+/g, '_').trim();
  return s || fallback;
}

function stemFromName(name) {
  const base = (name || '').split(/[/\\]/).pop() || '';
  return base.replace(/\.[^.]+$/, '') || 'Bauteile_Suchen';
}

/** @returns {Promise<typeof import('jszip')>} */
function getJSZip() {
  const J = globalThis.JSZip;
  if (!J) throw new Error('JSZip nicht geladen');
  return J;
}

function uniquePnpNames(variants) {
  const used = new Set();
  return variants.map((v, i) => {
    let base = sanitizeName(v.pnpName || `variante_${i + 1}.csv`, `variante_${i + 1}.csv`);
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      const stem = base.replace(/\.[^.]+$/, '') || 'variante';
      const ext = (base.match(/\.[^.]+$/) || ['.csv'])[0];
      name = `${stem}_${n}${ext}`;
      n += 1;
    }
    used.add(name.toLowerCase());
    return { ...v, pnpName: name };
  });
}

/**
 * @param {{
 *   name?: string,
 *   pdfName?: string,
 *   pnpName?: string,
 *   pdfBytes?: ArrayBuffer|Uint8Array|null,
 *   pnpText?: string|null,
 *   variants?: Array<{ id?: string, name?: string, pnpName?: string, pnpText?: string }>,
 *   activeVariantId?: string|null,
 *   cal?: object,
 *   pageW?: number,
 *   pageH?: number,
 * }} project
 */
export async function buildBsuZip(project) {
  const JSZip = getJSZip();
  const zip = new JSZip();
  const pdfName = sanitizeName(project.pdfName || 'board.pdf', 'board.pdf');

  let variants = Array.isArray(project.variants) ? project.variants.slice() : [];
  if (!variants.length && project.pnpText != null && project.pnpText !== '') {
    variants = [
      {
        id: 'v1',
        name: stemFromName(project.pnpName) || 'Standard',
        pnpName: project.pnpName || 'PKP.csv',
        pnpText: project.pnpText,
      },
    ];
  }
  variants = uniquePnpNames(variants);

  const refsOnly = project.activeVariantId === '__refs_only__';
  const activeId =
    refsOnly
      ? null
      : (project.activeVariantId || variants[0]?.id || null);
  const active =
    (activeId && variants.find((v) => v.id === activeId)) ||
    variants[0] ||
    null;
  const pnpName = sanitizeName(
    active?.pnpName || project.pnpName || 'PKP.csv',
    'PKP.csv',
  );

  const meta = {
    version: BSU_VERSION,
    app: 'Bauteile Suchen',
    name: project.name || stemFromName(pdfName) || 'Bauteile_Suchen',
    savedAt: new Date().toISOString(),
    pdfName,
    pnpName,
    activeVariantId: refsOnly ? '__refs_only__' : (active?.id || null),
    variants: variants.map((v) => ({
      id: v.id || v.pnpName,
      name: v.name || stemFromName(v.pnpName) || 'Variante',
      pnpName: v.pnpName,
      file: `source/variants/${v.pnpName}`,
    })),
    cal: normalizeCal(project.cal),
    pageW: project.pageW || 0,
    pageH: project.pageH || 0,
    sourceFiles: {
      pdf: `source/${pdfName}`,
      pnp: `source/${pnpName}`,
    },
  };
  // Stücklisten (parsed BEAK → Lagerplatz), only when loaded
  if (project.stuecklisten && (project.stuecklisten.smd || project.stuecklisten.bg)) {
    meta.stuecklisten = {
      smd: project.stuecklisten.smd || null,
      bg: project.stuecklisten.bg || null,
    };
  }
  // Pick&Place value replacements from Kunden-Stückliste
  if (project.pnpValueReplace && project.pnpValueReplace.byRef) {
    meta.pnpValueReplace = project.pnpValueReplace;
  }
  zip.file(PROJECT_JSON_NAME, JSON.stringify(meta, null, 2));

  if (project.pdfBytes) {
    const bytes =
      project.pdfBytes instanceof Uint8Array
        ? project.pdfBytes
        : new Uint8Array(project.pdfBytes);
    zip.file(`source/${pdfName}`, bytes);
  }

  // Legacy single path = active (or only) variant for older readers
  if (active?.pnpText != null && active.pnpText !== '') {
    zip.file(`source/${pnpName}`, active.pnpText);
  } else if (project.pnpText != null && project.pnpText !== '') {
    zip.file(`source/${pnpName}`, project.pnpText);
  }

  for (const v of variants) {
    if (v.pnpText == null || v.pnpText === '') continue;
    zip.file(`source/variants/${v.pnpName}`, v.pnpText);
  }

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

export function suggestedBsuFilename(project) {
  const base = sanitizeName(
    project?.name || stemFromName(project?.pdfName) || 'Bauteile_Suchen',
    'Bauteile_Suchen',
  );
  return `${base}.zip`;
}

/** Legacy project extension (.BSU) — still opened, never written. */
export function isBsuFilename(name) {
  return /\.bsu$/i.test(name || '');
}

/** Project file: .zip (current) or legacy .bsu. */
export function isProjectFilename(name) {
  return /\.(zip|bsu)$/i.test(name || '');
}

/**
 * @param {File|Blob|Uint8Array|import('jszip')} file
 * @returns {Promise<{
 *   meta: object,
 *   pdfBytes: Uint8Array|null,
 *   pdfName: string,
 *   pnpText: string|null,
 *   pnpName: string,
 *   cal: object|null,
 *   variants: Array<{ id: string, name: string, pnpName: string, pnpText: string }>,
 *   activeVariantId: string|null,
 * }>}
 */
export async function loadBsuZip(file) {
  const JSZip = getJSZip();
  // Accepts File/Blob/bytes or an already loaded JSZip (avoids parsing twice).
  const zip = file instanceof JSZip ? file : await JSZip.loadAsync(file);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const projPath = names.find((n) => /(^|\/)projekt\.json$/i.test(n));
  if (!projPath) {
    throw new Error('Keine projekt.json in der Projekt-ZIP');
  }
  const meta = JSON.parse(await zip.files[projPath].async('string'));

  let pdfName = meta.pdfName || meta.sourceFiles?.pdf?.split('/').pop() || '';
  let pnpName = meta.pnpName || meta.sourceFiles?.pnp?.split('/').pop() || '';

  const findPdf = () =>
    names.find((n) => {
      const low = n.toLowerCase();
      if (meta.sourceFiles?.pdf && n === meta.sourceFiles.pdf) return true;
      if (pdfName && n.endsWith('/' + pdfName)) return true;
      if (pdfName && /(^|\/)/.test(n) && n.split('/').pop() === pdfName) return true;
      return (
        /^source\//i.test(n) &&
        /\.(pdf|png|jpe?g|webp)$/i.test(n) &&
        !/\/variants\//i.test(n)
      );
    }) ||
    names.find((n) => /\.(pdf|png|jpe?g|webp)$/i.test(n) && !/projekt\.json/i.test(n));

  const findPnp = () =>
    names.find((n) => {
      if (meta.sourceFiles?.pnp && n === meta.sourceFiles.pnp) return true;
      if (pnpName && n.split('/').pop() === pnpName && !/\/variants\//i.test(n)) return true;
      return (
        /^source\//i.test(n) &&
        !/\/variants\//i.test(n) &&
        /\.(csv|txt|tsv)$/i.test(n)
      );
    }) ||
    names.find((n) => /pkp\.csv$/i.test(n)) ||
    names.find((n) => /\.(csv|tsv)$/i.test(n) && !/\/variants\//i.test(n)) ||
    names.find((n) => /\.txt$/i.test(n) && !/projekt\.json/i.test(n) && !/\/variants\//i.test(n));

  const pdfPath = findPdf();
  const pnpPath = findPnp();

  let pdfBytes = null;
  if (pdfPath) {
    pdfBytes = new Uint8Array(await zip.files[pdfPath].async('arraybuffer'));
    pdfName = pdfName || pdfPath.split('/').pop() || 'board.pdf';
  }
  let pnpText = null;
  if (pnpPath) {
    pnpText = decodePnpBytes(await zip.files[pnpPath].async('uint8array'));
    pnpName = pnpName || pnpPath.split('/').pop() || 'PKP.csv';
  }

  /** @type {Array<{ id: string, name: string, pnpName: string, pnpText: string }>} */
  const variants = [];
  const metaVariants = Array.isArray(meta.variants) ? meta.variants : [];

  if (metaVariants.length) {
    for (let i = 0; i < metaVariants.length; i++) {
      const mv = metaVariants[i];
      const fileRel =
        mv.file ||
        (mv.pnpName ? `source/variants/${mv.pnpName}` : null) ||
        (mv.pnpName ? `source/${mv.pnpName}` : null);
      let path =
        (fileRel && names.find((n) => n === fileRel || n.endsWith('/' + fileRel.replace(/^source\//, '')))) ||
        (mv.pnpName &&
          names.find(
            (n) =>
              n.split('/').pop() === mv.pnpName &&
              (/\/variants\//i.test(n) || /^source\//i.test(n)),
          )) ||
        null;
      // Fall back to legacy single pnp for first/active
      if (!path && i === 0 && pnpPath) path = pnpPath;
      if (!path) continue;
      const text = decodePnpBytes(await zip.files[path].async('uint8array'));
      const vName = mv.pnpName || path.split('/').pop() || `variante_${i + 1}.csv`;
      variants.push({
        id: String(mv.id || `v${i + 1}`),
        name: mv.name || stemFromName(vName) || `Variante ${i + 1}`,
        pnpName: vName,
        pnpText: text,
      });
    }
  }

  // Also pick up any extra files under source/variants/ not listed in meta
  for (const n of names) {
    if (!/^source\/variants\//i.test(n)) continue;
    if (!/\.(csv|txt|tsv)$/i.test(n)) continue;
    const base = n.split('/').pop();
    if (variants.some((v) => v.pnpName === base)) continue;
    const text = decodePnpBytes(await zip.files[n].async('uint8array'));
    variants.push({
      id: `v_${stemFromName(base)}`,
      name: stemFromName(base) || base,
      pnpName: base,
      pnpText: text,
    });
  }

  // Legacy single P&P → one variant
  if (!variants.length && pnpText) {
    variants.push({
      id: 'v1',
      name: stemFromName(pnpName) || 'Standard',
      pnpName: pnpName || 'PKP.csv',
      pnpText,
    });
  }

  const refsOnly = meta.activeVariantId === '__refs_only__';
  let activeVariantId = refsOnly ? '__refs_only__' : (meta.activeVariantId || null);
  if (!refsOnly && activeVariantId && !variants.some((v) => v.id === activeVariantId)) {
    activeVariantId = null;
  }
  if (!refsOnly && !activeVariantId && variants.length) {
    // Prefer variant matching legacy pnpName
    const byName = variants.find((v) => v.pnpName === pnpName);
    activeVariantId = byName?.id || variants[0].id;
  }

  const active = variants.find((v) => v.id === activeVariantId) || variants[0] || null;
  if (active) {
    pnpText = active.pnpText;
    pnpName = active.pnpName;
  }

  if (!pdfBytes && !pnpText && !variants.length) {
    throw new Error('Weder Plan noch Pick & Place in der Projekt-ZIP gefunden');
  }

  return {
    meta,
    pdfBytes,
    pdfName: pdfName || 'board.pdf',
    pnpText,
    pnpName: pnpName || 'PKP.csv',
    // Always restore flipX/flipY with cal refs (defaults false if missing in older projects)
    cal: normalizeCal(meta.cal),
    pageW: Number(meta.pageW) || 0,
    pageH: Number(meta.pageH) || 0,
    variants,
    activeVariantId: refsOnly ? '__refs_only__' : (active?.id || null),
    stuecklisten: meta.stuecklisten || null,
    pnpValueReplace: meta.pnpValueReplace || null,
  };
}

/** Download blob as filename (project .zip). */
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
