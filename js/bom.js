/**
 * Stücklisten (BOM) — „Lager - Stückliste“ PDFs → BEAK-Nr → Lagerplatz.
 * Columns: Artikel-Beschreibung | BEAK EDV-Nr. | Lagerplatz | Bedarf Stck | …
 * Primary: pdf.js text items bucketed by header x-positions (per page).
 * Fallback: per-line regex when no header columns are found.
 */

/** BEAK-Nr key: digits only („3.192“ → „3192“). */
export function beakKey(s) {
  return String(s ?? '').replace(/\D+/g, '');
}

const BEAK_RE = /^(\d{1,3}\.\d{3})(?:\s+(.*))?$/;
const ROW_Y_TOL = 2.5;

function cleanStr(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Group text items into rows by y (top → bottom), items sorted by x. */
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

function rowText(items) {
  return items.map((it) => cleanStr(it.str)).filter(Boolean).join(' ');
}

/** Locate header columns on a page: EDV-Nr., Lagerplatz, Bedarf/Stck. */
function findHeader(items) {
  const find = (re) => items.find((it) => re.test(cleanStr(it.str)));
  const edv = find(/^EDV-?Nr\.?$/i) || find(/EDV-?Nr\.?/i);
  const lager = find(/^Lagerplatz$/i) || find(/Lagerplatz/i);
  const stck = find(/^Stck\.?$/i);
  const bedarf = find(/^Bedarf$/i);
  if (!edv || !lager || (!stck && !bedarf)) return null;
  // Header row y = Lagerplatz line (EDV-Nr. sits on the same line, BEAK above).
  const headerY = Math.min(lager.y, edv.y);
  const qtyX = Math.min(stck ? stck.x : Infinity, bedarf ? bedarf.x : Infinity);
  return {
    headerY,
    // BEAK values are right-aligned under „EDV-Nr.“; wide ones (101.186) start a bit left.
    beakStart: edv.x - 22,
    // Lagerplatz is left-aligned slightly left of its header; ends before Bedarf.
    qtyStart: qtyX - 3,
    qtyEnd: (stck ? stck.x + (stck.w || 20) : bedarf.x + (bedarf.w || 25)) + 4,
  };
}

/** Fallback for one text line: Beschreibung  BEAK  Lagerplatz  Bedarf … */
export function parseBomLine(line) {
  const s = cleanStr(line);
  const m = s.match(
    /^(.*?\S)\s+(\d{1,3}\.\d{3})\s+([A-ZÄÖÜ][A-ZÄÖÜ0-9]*(?:-[A-ZÄÖÜ0-9]+)*(?:\s\d{1,4})?)\s+(\d+)(?:\s|$)/,
  );
  if (!m) return null;
  return { beschreibung: m[1].trim(), beak: m[2], lagerplatz: m[3].trim(), bedarf: Number(m[4]) };
}

/**
 * Parse BOM pages.
 * @param {Array<{ items: Array<{ str: string, x: number, y: number, w?: number }> }>} pages
 * @returns {{ title: string, edv: string, entries: Array<{ beak: string, key: string, lagerplatz: string, beschreibung: string }>, skipped: string[] }}
 */
export function parseBomPages(pages) {
  let title = '';
  let edv = '';
  const entries = [];
  const skipped = [];
  const seen = new Map();

  for (const page of pages || []) {
    const items = (page.items || []).map((it) => ({ ...it, str: String(it.str ?? '') }));
    const rows = groupRows(items);
    const hdr = findHeader(items);

    for (const r of rows) {
      const text = rowText(r.items);
      if (!title || !edv) {
        const tm = text.match(/^(\d+\s*x\s+.+?)\s*\(\s*EDV-?Nr:?\s*([\d.]+)\s*\)/i);
        if (tm) {
          if (!title) title = tm[1].trim();
          if (!edv) edv = tm[2];
          continue;
        }
      }
      if (hdr && r.y >= hdr.headerY - 1) continue; // header / title area
      if (/^Gedruckt (von|am)/i.test(text) || /Seite \d+ von \d+/i.test(text)) continue;

      let rec = null;
      if (hdr) {
        const desc = [];
        const mid = [];
        let qty = '';
        for (const it of r.items) {
          const s = cleanStr(it.str);
          if (!s) continue;
          if (it.x < hdr.beakStart) desc.push(s);
          else if (it.x < hdr.qtyStart) mid.push(s);
          else if (it.x < hdr.qtyEnd && !qty) qty = s;
        }
        let midText = mid.join(' ');
        let descText = desc.join(' ');
        // Description item merged with the BEAK number (no x split) → peel it off.
        if (!BEAK_RE.test(midText)) {
          const dm = descText.match(/^(.*\S)\s+(\d{1,3}\.\d{3})(?:\s+(.*))?$/);
          if (dm) {
            descText = dm[1];
            midText = [dm[2], dm[3], midText].filter(Boolean).join(' ');
          }
        }
        const bm = midText.match(BEAK_RE);
        if (bm && descText) {
          let lager = cleanStr(bm[2] || '');
          // Lagerplatz merged with Bedarf („FB 2“) and no separate qty item → strip.
          if (!qty) {
            const qm = lager.match(/^(.*\S)\s+(\d+)$/);
            if (qm && /[A-Za-zÄÖÜ]/.test(qm[1]) && !/\d$/.test(qm[1])) lager = qm[1];
          }
          rec = { beschreibung: descText, beak: bm[1], lagerplatz: lager };
        }
      }
      if (!rec) rec = parseBomLine(text);
      if (!rec) {
        if (/\d{1,3}\.\d{3}/.test(text)) skipped.push(text);
        continue;
      }
      const key = beakKey(rec.beak);
      if (!key) continue;
      const entry = { beak: rec.beak, key, lagerplatz: rec.lagerplatz, beschreibung: rec.beschreibung };
      if (seen.has(key)) {
        // Same article twice → keep first, but fill missing Lagerplatz
        const prev = seen.get(key);
        if (!prev.lagerplatz && entry.lagerplatz) prev.lagerplatz = entry.lagerplatz;
        continue;
      }
      seen.set(key, entry);
      entries.push(entry);
    }
  }
  return { title, edv, entries, skipped };
}

/** Extract text items from a PDF via pdf.js and parse. */
export async function parseBomPdf(pdfjsLib, bytes) {
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
    return parseBomPages(pages);
  } finally {
    try { await doc.destroy(); } catch (_) {}
  }
}

/** Fallback for CSV text (semicolon/comma/tab) with BEAK + Lagerplatz columns. */
export function parseBomCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { title: '', edv: '', entries: [], skipped: [] };
  const sep = [';', '\t', ','].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
  const split = (l) => l.split(sep).map((c) => c.replace(/^"|"$/g, '').trim());
  const head = split(lines[0]).map((h) => h.toLowerCase());
  const iBeak = head.findIndex((h) => /edv|beak/.test(h));
  const iLager = head.findIndex((h) => /lagerplatz/.test(h));
  const iDesc = head.findIndex((h) => /beschreibung|bezeichnung/.test(h));
  const entries = [];
  const seen = new Set();
  if (iBeak < 0 || iLager < 0) return { title: '', edv: '', entries, skipped: [] };
  for (const l of lines.slice(1)) {
    const c = split(l);
    const key = beakKey(c[iBeak]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    entries.push({ beak: c[iBeak], key, lagerplatz: c[iLager] || '', beschreibung: iDesc >= 0 ? c[iDesc] || '' : '' });
  }
  return { title: '', edv: '', entries, skipped: [] };
}

/** Normalize a stored list (localStorage / .BSU) → { name, title, edv, entries } | null. */
export function normalizeBomList(raw) {
  if (!raw || !Array.isArray(raw.entries)) return null;
  const entries = raw.entries
    .map((e) => ({
      beak: String(e.beak || ''),
      key: beakKey(e.key || e.beak),
      lagerplatz: String(e.lagerplatz || ''),
      beschreibung: String(e.beschreibung || ''),
    }))
    .filter((e) => e.key);
  return {
    name: String(raw.name || ''),
    title: String(raw.title || ''),
    edv: String(raw.edv || ''),
    entries,
  };
}

/**
 * Lookup map key → { lagerplatz, beschreibung, source } from { smd, bg } lists.
 * SMD wins over BG on duplicates (SMD sub-assembly row in BG list has its own number).
 */
export function buildBomLookup(boms) {
  const map = new Map();
  for (const source of ['smd', 'bg']) {
    const list = boms?.[source];
    if (!list?.entries) continue;
    for (const e of list.entries) {
      if (!e.key || map.has(e.key)) continue;
      map.set(e.key, { lagerplatz: e.lagerplatz, beschreibung: e.beschreibung, source });
    }
  }
  return map;
}
