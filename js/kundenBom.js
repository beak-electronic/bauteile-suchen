/**
 * Kunden-Stückliste (sortiert: Referenz) — PDF → Referenz → Artikel-Beschreibung + BEAK EDV-Nr.
 * Different from Lager-Stückliste (bom.js): no Lagerplatz; first column is the designator.
 *
 * Columns: Referenz | Bemerkung | Artikel-Beschreibung | Bauform | BEAK EDV-Nr.
 * Handles spaced refs („C 17“), comma lists, numeric ranges („KL151-154“), page headers.
 */

import { normalizeRef } from './pnp.js';
import { beakKey } from './bom.js';

const ROW_Y_TOL = 2.5;
const BEAK_TAIL_RE = /(\d{1,3}\.\d{3})\s*$/;

function cleanStr(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function looksLikeBauform(s) {
  const t = cleanStr(s);
  if (!t || t.length > 22) return false;
  return /^(?:RM\s*[\d,.]+|[\d,.]+\s*mm|DIP[-\s]?\d*|TO-\d+|0207|axial|THT|SIP[-\s]?\d*|PR\s*\d+|M[\d,.]+|PT\s*[\w-]+|ID-[\w-]+)$/i.test(
    t,
  );
}

function looksLikeArtikelValue(s) {
  return /[/µμ]|\bnF\b|\bpF\b|\byF\b|\bµF\b|\bElko\b|\bTrimmer\b|\bDraht|\bPrint|\bHEF\b|\bLM\b|\bTL\b|\bMC\b|\bBZX\b|\bCNY\b|\bWAGO\b|\bKühl|\bUnterleg|\bBlindniete|\bWannen|\bFlachstecker|\bLötöse|\bLP\b|\bFK\b|\bICM\b|\bSB\b|\bCD\s*\d|\d\s*[KkRr]\b|\d\s*%|\d\s*W\b|\d\s*V\b|\bpol\b/i.test(
    s,
  );
}

/** Expand „R1, R2, R5“, „KL151-154“, „C 17“ → normalized refs. */
export function expandKundenRefs(raw) {
  const s = cleanStr(raw);
  if (!s) return [];
  const tokens = s.split(',').map((t) => t.trim()).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    const range = t.match(/^([A-Za-zÄÖÜäöü]+)[\s]*(\d+)\s*[-–]\s*(\d+)$/i);
    if (range) {
      const prefix = range[1];
      let a = Number(range[2]);
      let b = Number(range[3]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        out.push(normalizeRef(t));
        continue;
      }
      if (a > b) [a, b] = [b, a];
      if (b - a > 500) {
        out.push(normalizeRef(t));
        continue;
      }
      for (let i = a; i <= b; i++) out.push(normalizeRef(prefix + i));
      continue;
    }
    out.push(normalizeRef(t));
  }
  return [...new Set(out.filter(Boolean))];
}

/** Digits-only BEAK for Pick&Place Description (formatBeak / Lagerplatz). */
export function kundenBeakDigits(beak) {
  const d = beakKey(beak);
  if (!d || /^0+$/.test(d)) return '';
  return d;
}

function isNoiseLine(text) {
  const t = cleanStr(text);
  if (!t) return true;
  if (/^Kunden\s*-?\s*Stückliste/i.test(t)) return true;
  if (/^Gedruckt\s+(von|am)/i.test(t)) return true;
  if (/Seite\s+\d+\s+von\s+\d+/i.test(t)) return true;
  if (/^\d+\s*x\s+/i.test(t) && /EDV/i.test(t)) return true;
  if (/^BEAK$/i.test(t)) return true;
  if (/Referenz/i.test(t) && /Artikel-Beschreibung/i.test(t)) return true;
  if (/^EDV-?Nr\.?$/i.test(t)) return true;
  return false;
}

/**
 * Parse one layout line (pdftotext -layout). Splits on 2+ spaces into fields.
 * @param {string} line
 * @param {object|null} [_cols]
 */
export function parseKundenBomLayoutLine(line, _cols) {
  if (!line || isNoiseLine(line)) return null;
  const beakM = line.match(BEAK_TAIL_RE);
  if (!beakM) return null;
  const beak = beakM[1];
  const left = line.slice(0, beakM.index).trimEnd();
  const fields = left.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
  if (fields.length < 2) return null;
  const ref = fields[0];
  if (!ref || /^(Referenz|BEAK)$/i.test(ref)) return null;
  if (/Stückliste/i.test(ref) || /Baugruppe/i.test(ref)) return null;

  let rest = fields.slice(1);
  if (rest.length >= 2 && looksLikeBauform(rest[rest.length - 1])) {
    rest = rest.slice(0, -1);
  }
  let beschreibung;
  if (rest.length === 1) {
    beschreibung = rest[0];
  } else if (rest.length >= 2) {
    if (!looksLikeArtikelValue(rest[0])) beschreibung = rest.slice(1).join(' ');
    else beschreibung = rest.join(' ');
  } else {
    return null;
  }
  beschreibung = cleanStr(beschreibung);
  if (!beschreibung) return null;
  return {
    refRaw: ref,
    refs: expandKundenRefs(ref),
    value: beschreibung,
    beak,
    key: kundenBeakDigits(beak),
  };
}

/** Detect column char offsets from a header line (kept for callers / future use). */
export function detectKundenHeaderCols(line) {
  if (!line || !/Referenz/i.test(line) || !/Artikel-Beschreibung/i.test(line)) return null;
  const artikel = line.search(/Artikel-Beschreibung/i);
  const bemerkung = line.search(/Bemerkung/i);
  const bauform = line.search(/Bauform/i);
  const edv = line.search(/EDV-?Nr/i);
  if (artikel < 0 || edv < 0) return null;
  return {
    bemerkung: bemerkung >= 0 ? bemerkung : artikel,
    artikel,
    bauform: bauform >= 0 ? bauform : edv,
    edv,
  };
}

/**
 * Parse pdftotext -layout (or similarly aligned) full text.
 * @returns {{ title: string, edv: string, entries: Array<object>, byRef: Map<string,{value:string,beak:string,key:string}>, skipped: string[] }}
 */
export function parseKundenBomLayoutText(text) {
  const lines = String(text || '').split(/\r?\n/);
  let title = '';
  let edv = '';
  let cols = null;
  const entries = [];
  const skipped = [];
  const byRef = new Map();

  for (const line of lines) {
    if (!title || !edv) {
      const tm = cleanStr(line).match(/^(\d+\s*x\s+.+?)\s*\(\s*EDV-?Nr:?\s*([\d.]+)\s*\)/i);
      if (tm) {
        if (!title) title = tm[1].trim();
        if (!edv) edv = tm[2];
        continue;
      }
    }
    const hdr = detectKundenHeaderCols(line);
    if (hdr) {
      cols = hdr;
      continue;
    }
    if (isNoiseLine(line)) continue;
    // Require a header seen at least once (format marker)
    if (!cols && !BEAK_TAIL_RE.test(line)) continue;
    const rec = parseKundenBomLayoutLine(line, cols);
    if (!rec) {
      if (BEAK_TAIL_RE.test(line) && line.trim()) skipped.push(line.trim());
      continue;
    }
    entries.push(rec);
    for (const r of rec.refs) {
      byRef.set(r, { value: rec.value, beak: rec.beak, key: rec.key });
    }
  }
  return { title, edv, entries, byRef, skipped };
}

function groupRows(items) {
  const sorted = items
    .filter((it) => cleanStr(it.str))
    .slice()
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= ROW_Y_TOL);
    if (row) row.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  rows.sort((a, b) => b.y - a.y);
  return rows;
}

function findKundenHeader(items) {
  const find = (re) => items.find((it) => re.test(cleanStr(it.str)));
  const ref = find(/^Referenz$/i);
  const artikel = find(/^Artikel-Beschreibung$/i) || find(/Artikel-Beschreibung/i);
  const edv = find(/^EDV-?Nr\.?$/i) || find(/EDV-?Nr/i);
  const bemerkung = find(/^Bemerkung$/i);
  const bauform = find(/^Bauform$/i);
  if (!ref || !artikel || !edv) return null;
  return {
    headerY: Math.min(ref.y, artikel.y, edv.y),
    bemerkungX: bemerkung ? bemerkung.x : artikel.x,
    artikelX: artikel.x,
    bauformX: bauform ? bauform.x : edv.x,
    edvX: edv.x - 18,
  };
}

/**
 * Parse pdf.js pages (same item shape as bom.js).
 * Uses x-columns when header found; falls back to field-split on joined row text.
 */
export function parseKundenBomPages(pages) {
  let title = '';
  let edv = '';
  const entries = [];
  const skipped = [];
  const byRef = new Map();

  for (const page of pages || []) {
    const items = (page.items || []).map((it) => ({ ...it, str: String(it.str ?? '') }));
    const rows = groupRows(items);
    const hdr = findKundenHeader(items);

    for (const r of rows) {
      const text = r.items.map((it) => cleanStr(it.str)).filter(Boolean).join(' ');
      if (!title || !edv) {
        const tm = text.match(/^(\d+\s*x\s+.+?)\s*\(\s*EDV-?Nr:?\s*([\d.]+)\s*\)/i);
        if (tm) {
          if (!title) title = tm[1].trim();
          if (!edv) edv = tm[2];
          continue;
        }
      }
      if (isNoiseLine(text)) continue;
      if (hdr && r.y >= hdr.headerY - 1) continue;

      let rec = null;
      if (hdr) {
        const refParts = [];
        const midParts = [];
        const beakParts = [];
        for (const it of r.items) {
          const s = cleanStr(it.str);
          if (!s) continue;
          if (it.x < hdr.bemerkungX - 2) refParts.push(s);
          else if (it.x < hdr.edvX) midParts.push(s);
          else beakParts.push(s);
        }
        let refRaw = refParts.join(' ').trim();
        // Bemerkung sits between bemerkungX and a soft artikel zone — keep mid as bem+desc+bauform
        let mid = midParts.join(' ').trim();
        let beakText = beakParts.join(' ').trim();
        if (!beakText) {
          const bm = mid.match(BEAK_TAIL_RE);
          if (bm) {
            beakText = bm[1];
            mid = mid.slice(0, bm.index).trim();
          }
        } else {
          const bm = beakText.match(BEAK_TAIL_RE);
          if (bm) beakText = bm[1];
        }
        // Split mid into fields on single spaces carefully: peel bauform, drop bemerkung
        const bits = mid.split(/\s+/).filter(Boolean);
        if (bits.length >= 2 && looksLikeBauform(bits[bits.length - 1])) {
          mid = bits.slice(0, -1).join(' ');
        } else if (bits.length >= 3 && looksLikeBauform(`${bits[bits.length - 2]} ${bits[bits.length - 1]}`)) {
          mid = bits.slice(0, -2).join(' ');
        }
        // Drop leading Bemerkung tokens until we hit something value-like (or keep all)
        const midBits = mid.split(/\s+/).filter(Boolean);
        let desc = mid;
        if (midBits.length >= 2 && !looksLikeArtikelValue(midBits[0]) && !looksLikeArtikelValue(midBits.slice(0, 2).join(' '))) {
          // find first value-like span
          let cut = -1;
          for (let i = 0; i < midBits.length; i++) {
            const span = midBits.slice(i).join(' ');
            if (looksLikeArtikelValue(span) || looksLikeArtikelValue(midBits[i])) {
              cut = i;
              break;
            }
          }
          if (cut > 0) desc = midBits.slice(cut).join(' ');
        }
        desc = cleanStr(desc);
        if (!refRaw && r.items.length) {
          // Ref may share x with bemerkung when header drifted — take leftmost item(s)
          const left = r.items.filter((it) => it.x < hdr.artikelX - 10);
          if (left.length) refRaw = left.map((it) => cleanStr(it.str)).join(' ').trim();
        }
        if (refRaw && desc && beakText) {
          rec = {
            refRaw,
            refs: expandKundenRefs(refRaw),
            value: desc,
            beak: beakText,
            key: kundenBeakDigits(beakText),
          };
        }
      }
      if (!rec) {
        // Fallback: pad spaces between items by x gap to recreate layout, then field-split
        let layout = '';
        let prevEnd = 0;
        for (const it of r.items) {
          const s = String(it.str ?? '');
          if (!s.trim()) continue;
          const gap = Math.max(1, Math.round((it.x - prevEnd) / 3.5));
          if (layout) layout += ' '.repeat(Math.min(gap, 12));
          layout += s;
          prevEnd = it.x + (it.w || s.length * 3.5);
        }
        rec = parseKundenBomLayoutLine(layout, null);
      }
      if (!rec) {
        if (BEAK_TAIL_RE.test(text)) skipped.push(text);
        continue;
      }
      entries.push(rec);
      for (const rf of rec.refs) {
        byRef.set(rf, { value: rec.value, beak: rec.beak, key: rec.key });
      }
    }
  }
  return { title, edv, entries, byRef, skipped };
}

/** Extract text items via pdf.js and parse. */
export async function parseKundenBomPdf(pdfjsLib, bytes) {
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
  const doc = await pdfjsLib.getDocument({ data }).promise;
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      pages.push({
        items: tc.items
          .filter((it) => typeof it.str === 'string')
          .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })),
      });
    }
    let parsed = parseKundenBomPages(pages);
    if ((parsed.entries?.length || 0) < 20) {
      // Reconstruct approximate layout lines from x gaps and re-parse
      const layoutLines = [];
      for (const page of pages) {
        const rows = groupRows(page.items || []);
        for (const r of rows) {
          let layout = '';
          let prevEnd = 0;
          for (const it of r.items) {
            const s = String(it.str ?? '');
            if (!cleanStr(s)) continue;
            const gap = layout ? Math.max(1, Math.round((it.x - prevEnd) / 3.2)) : 0;
            layout += ' '.repeat(Math.min(Math.max(gap, 0), 16)) + s;
            prevEnd = it.x + (it.w || s.length * 3.2);
          }
          if (layout.trim()) layoutLines.push(layout);
        }
        layoutLines.push('');
      }
      const alt = parseKundenBomLayoutText(layoutLines.join('\n'));
      if ((alt.entries?.length || 0) > (parsed.entries?.length || 0)) parsed = alt;
    }
    return parsed;
  } finally {
    try {
      await doc.destroy();
    } catch (_) {}
  }
}

/**
 * Apply Kunden-Stückliste map to Pick&Place parts.
 * Sets value = Artikel-Beschreibung, description = BEAK digits (for label + Lagerplatz).
 * @param {object[]} parts
 * @param {Map|Record} byRef
 * @returns {{ replaced: number, total: number }}
 */
export function applyKundenValuesToParts(parts, byRef) {
  const map =
    byRef instanceof Map
      ? byRef
      : new Map(Object.entries(byRef || {}).map(([k, v]) => [normalizeRef(k), v]));
  let replaced = 0;
  const total = (parts || []).length;
  for (const p of parts || []) {
    const hit = map.get(normalizeRef(p.id));
    if (!hit) continue;
    const key = hit.key || kundenBeakDigits(hit.beak);
    p.value = hit.value || p.value;
    if (key) {
      p.description = key;
      p.beakNr = key;
    }
    replaced++;
  }
  return { replaced, total };
}

/** Serialize byRef Map for projekt.json */
export function serializeKundenByRef(byRef) {
  const out = {};
  const map = byRef instanceof Map ? byRef : new Map(Object.entries(byRef || {}));
  for (const [k, v] of map) {
    out[k] = { value: v.value, beak: v.beak, key: v.key || kundenBeakDigits(v.beak) };
  }
  return out;
}

export function deserializeKundenByRef(obj) {
  const map = new Map();
  for (const [k, v] of Object.entries(obj || {})) {
    if (!v || typeof v !== 'object') continue;
    map.set(normalizeRef(k), {
      value: String(v.value || ''),
      beak: String(v.beak || ''),
      key: String(v.key || kundenBeakDigits(v.beak)),
    });
  }
  return map;
}
