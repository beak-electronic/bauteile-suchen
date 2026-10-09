/** Pick & Place parser — CSV (PKP) + Altium fixed-width / quoted CSV, like Bestückungsplan. */

export function normalizeRef(s) {
  return String(s ?? '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

/** Designator from search text that may include " · value (BEAK-Nr)". */
export function designatorFromQuery(query) {
  const s = String(query ?? '').trim();
  const head = s.split(/\s*[·•]\s*|\s+—\s+/)[0] || s;
  return normalizeRef(head);
}

/**
 * Decode Pick&Place file bytes: UTF-8 when valid, else Windows-1252 / latin1.
 * Altium / Windows exports often use cp1252 (µ = 0xB5) — File.text() UTF-8 would yield �.
 * @param {ArrayBuffer|Uint8Array|ArrayLike<number>} buf
 * @returns {string}
 */
export function decodePnpBytes(buf) {
  const u8 =
    buf instanceof Uint8Array
      ? buf
      : buf instanceof ArrayBuffer
        ? new Uint8Array(buf)
        : new Uint8Array(buf);
  let offset = 0;
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    offset = 3;
  }
  const slice = offset ? u8.subarray(offset) : u8;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(slice);
  } catch {
    try {
      // Prefer full buffer (no UTF-8 BOM strip) for legacy single-byte encodings
      return new TextDecoder('windows-1252').decode(u8);
    } catch {
      try {
        return new TextDecoder('iso-8859-1').decode(u8);
      } catch {
        let s = '';
        for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        return s;
      }
    }
  }
}

/**
 * BEAK-Nr display from Pick&Place Description column (not EigerPN).
 * - Ignore empty / `0000` / `BEAK` (case-insensitive trim)
 * - `3192` → `3.192` (thousands dot)
 * - `5764+2071` → `5.764 & 2.071`
 * Returns '' when Description is not a BEAK-Nr pattern (e.g. text desc).
 */
export function formatBeakFromDescription(raw) {
  return beakListFromDescription(raw).join(' & ');
}

/** Format digit string as BEAK display: 3192 → 3.192, 101186 → 101.186. */
export function formatBeakDigits(digits) {
  const d = String(digits ?? '').replace(/\D+/g, '');
  if (!d || /^0+$/.test(d)) return '';
  if (d.length <= 3) return d;
  const parts = [];
  let s = d;
  while (s.length > 3) {
    parts.unshift(s.slice(-3));
    s = s.slice(0, -3);
  }
  if (s) parts.unshift(s);
  return parts.join('.');
}

/** Same as formatBeakFromDescription but as list: `5764+2071` → ['5.764', '2.071']. */
export function beakListFromDescription(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const low = s.toLowerCase();
  if (low === '0000' || low === 'beak') return [];
  const chunks = s.split(/[+&]/).map((c) => c.trim()).filter(Boolean);
  if (!chunks.length) return [];
  const out = [];
  for (const c of chunks) {
    const cl = c.toLowerCase();
    if (cl === '0000' || cl === 'beak') continue;
    // Already dotted (1.277 / 101.186)
    if (/^\d{1,3}(?:\.\d{3})+$/.test(c)) {
      out.push(c);
      continue;
    }
    const digits = c.replace(/\D+/g, '');
    if (!/^\d{4,}$/.test(digits)) return [];
    out.push(formatBeakDigits(digits));
  }
  return out;
}

/**
 * BEAK display for a part: Description first (PKP BEAK codes), then EigerPN / beakNr
 * (Bestückungsplan export "BEAK Nr." / classic EigerPN column).
 */
export function resolveBeakDisplay(p) {
  return resolveBeakList(p).join(' & ');
}

/** BEAK numbers for a part as list (Description, then beakNr / EigerPN). */
export function resolveBeakList(p) {
  if (!p) return [];
  for (const src of [p.description, p.beakNr, p.eigerPN]) {
    const list = beakListFromDescription(src);
    if (list.length) return list;
  }
  return [];
}

/**
 * Search / suggestion label: `R368 · 0R (3.192)`.
 * Value is the middle detail; Description is BEAK source when it matches the
 * numeric pattern (never shown as detail in that case).
 */
export function partSearchLabel(p, { refsOnly = false } = {}) {
  if (!p) return '';
  if (refsOnly) return p.id;
  const beak = resolveBeakDisplay(p);
  const value = (p.value || '').trim();
  const desc = (p.description || '').trim();
  let detail = value;
  // Only fall back to Description as free-text detail when it is NOT a BEAK code.
  if (!detail && desc && !beak && !/^0000$/i.test(desc) && !/^BEAK$/i.test(desc)) {
    detail = desc;
  }
  let label = p.id;
  if (detail) label += ` · ${detail}`;
  if (beak) label += ` (${beak})`;
  return label;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQ = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function normHeader(h) {
  return h.replace(/^\uFEFF/, '').trim().toLowerCase();
}

export function isAltiumPickPlace(text) {
  return /Designator/i.test(text) && /Center-X/i.test(text) && /(TopLayer|BottomLayer)/i.test(text);
}

/** Quoted / comma CSV Altium (not space-aligned fixed-width). */
export function isAltiumCsv(text) {
  if (!isAltiumPickPlace(text)) return false;
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const hdr = lines.find((l) => /Designator/i.test(l) && /Center-X/i.test(l));
  return !!(hdr && /,/.test(hdr));
}

function sliceCols(line, start, end) {
  const raw = end === undefined ? line.slice(start) : line.slice(start, end);
  return raw
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim();
}

function parseSide(layer) {
  return String(layer).toLowerCase().includes('bottom') || String(layer).toUpperCase() === 'BOT'
    ? 'BOT'
    : 'TOP';
}

export function parseAltiumPickPlace(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const errors = [];
  const hdrIdx = lines.findIndex((l) => /Designator/i.test(l) && /Center-X/i.test(l) && /Layer/i.test(l));
  if (hdrIdx < 0) {
    return { parts: [], errors: ['Altium-PnP: keine Designator/Center-X-Kopfzeile gefunden'] };
  }
  const hdr = lines[hdrIdx];
  const col = {
    designator: hdr.search(/Designator/i),
    comment: hdr.search(/Comment/i),
    layer: hdr.search(/Layer/i),
    footprint: hdr.search(/Footprint/i),
    x: hdr.search(/Center-X/i),
    y: hdr.search(/Center-Y/i),
    rot: hdr.search(/Rotation/i),
    desc: hdr.search(/Description/i),
  };
  if (col.designator < 0 || col.x < 0 || col.y < 0 || col.layer < 0) {
    return { parts: [], errors: ['Altium-PnP: Spaltenpositionen unvollständig'] };
  }
  const parts = [];
  for (let i = hdrIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^[=-]{5,}/.test(line) || /^File\s/i.test(line)) continue;
    const id = sliceCols(line, col.designator, col.comment >= 0 ? col.comment : col.layer);
    if (!id || /^designator$/i.test(id)) continue;
    const comment = col.comment >= 0 ? sliceCols(line, col.comment, col.layer) : '';
    const layer = sliceCols(line, col.layer, col.footprint >= 0 ? col.footprint : col.x);
    const footprint = col.footprint >= 0 ? sliceCols(line, col.footprint, col.x) : '';
    const xStr = sliceCols(line, col.x, col.y);
    const yStr = sliceCols(line, col.y, col.rot >= 0 ? col.rot : undefined);
    const rot =
      col.rot >= 0 ? sliceCols(line, col.rot, col.desc >= 0 ? col.desc : undefined) : '0';
    const desc = col.desc >= 0 ? sliceCols(line, col.desc, undefined) : '';
    const x = parseFloat(xStr.replace(',', '.'));
    const y = parseFloat(yStr.replace(',', '.'));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      errors.push(`Altium-PnP Zeile ${i + 1}: ungültige Koordinaten für ${id}`);
      continue;
    }
    parts.push({
      id,
      // Description = BEAK codes; Comment = part value (e.g. 1µ/630V-/nb)
      description: desc,
      value: comment,
      beakNr: '',
      side: parseSide(layer),
      rotation: String(Number(rot) || 0),
      x,
      y,
      package: footprint,
    });
  }
  return { parts, errors };
}

export function parsePkpCsv(text) {
  // Space-aligned Altium stays on fixed-width path; comma/quoted Altium → CSV below.
  if (isAltiumPickPlace(text) && !isAltiumCsv(text)) return parseAltiumPickPlace(text);
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const errors = [];
  // Skip Altium title/banner lines before the real header
  let hdrLineIdx = 0;
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const cells = parseCsvLine(lines[i]).map(normHeader);
    if (
      cells.includes('designator') ||
      cells.includes('partid') ||
      cells.includes('part_id') ||
      cells.includes('refdes')
    ) {
      hdrLineIdx = i;
      break;
    }
  }
  if (lines.length < hdrLineIdx + 2) {
    return { parts: [], errors: ['Datei ist leer oder hat keinen Dateninhalt'] };
  }
  const headers = parseCsvLine(lines[hdrLineIdx]).map(normHeader);
  // Normalize "center-x(mm)" → match via startsWith / includes helpers
  const idx = (names) => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i >= 0) return i;
    }
    // prefix match for Center-X(mm) etc.
    for (const n of names) {
      const i = headers.findIndex((h) => h === n || h.startsWith(n + '(') || h.startsWith(n + ' '));
      if (i >= 0) return i;
    }
    return -1;
  };
  const col = {
    partId: idx(['partid', 'part_id', 'refdes', 'designator']),
    // Description often holds BEAK codes (3192); EigerPN / "BEAK Nr." is the classic fallback
    beakNr: idx(['beak nr.', 'beak-nr', 'beak-nr.', 'beaknr', 'beak nr', 'eigerpn', 'pn', 'partnumber', 'mpn']),
    description: idx(['description', 'desc']),
    // Value column, or Altium Comment (part value like 1µ/630V-/nb)
    value: idx(['value', 'val', 'comment']),
    side: idx(['side', 'layer']),
    rotation: idx(['rotation', 'rot', 'angle']),
    x: idx(['x', 'center-x', 'centerx', 'mid x', 'posx']),
    y: idx(['y', 'center-y', 'centery', 'mid y', 'posy']),
    package: idx(['package', 'footprint']),
  };
  // If both Description and Comment exist, value must come from Comment/Value — not Description.
  // idx(['value','val','comment']) already prefers Value then Comment.
  // Ensure Description is not also used as value when Comment is mapped.
  if (col.description >= 0 && col.value === col.description) {
    col.value = idx(['value', 'val']);
  }
  if (col.partId < 0 || col.x < 0 || col.y < 0) {
    return { parts: [], errors: ['Erforderliche Spalten fehlen (PartID/Designator, X, Y)'] };
  }
  const parts = [];
  for (let r = hdrLineIdx + 1; r < lines.length; r++) {
    const line = lines[r];
    if (/^[=-]{5,}/.test(line) || /^file\s/i.test(line.trim())) continue;
    const cells = parseCsvLine(line);
    const get = (i) => (i >= 0 && i < cells.length ? cells[i] : '');
    const id = get(col.partId);
    if (!id || /^designator$/i.test(id) || /^partid$/i.test(id)) continue;
    const sideRaw = get(col.side).toUpperCase();
    let side = 'TOP';
    if (sideRaw === 'BOT' || sideRaw === 'BOTTOM' || sideRaw.includes('BOTTOM')) side = 'BOT';
    const x = parseFloat(get(col.x).replace(',', '.'));
    const y = parseFloat(get(col.y).replace(',', '.'));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      errors.push(`Zeile ${r + 1}: ungültige Koordinaten`);
      continue;
    }
    parts.push({
      id,
      description: get(col.description),
      value: get(col.value),
      beakNr: get(col.beakNr), // EigerPN / BEAK Nr. — fallback for resolveBeakDisplay
      side,
      rotation: get(col.rotation) || '0',
      x,
      y,
      package: get(col.package) || '',
    });
  }
  return { parts, errors };
}

export function findPart(parts, query) {
  const raw = String(query || '').split(/[·—–|-]/)[0].trim();
  const q = normalizeRef(raw);
  if (!q) return null;
  const exact = parts.find((p) => normalizeRef(p.id) === q);
  if (exact) return exact;
  const starts = parts.filter((p) => normalizeRef(p.id).startsWith(q));
  if (starts.length === 1) return starts[0];
  return null;
}

export function suggestParts(parts, query, limit = 8) {
  const raw = String(query || '').split(/[·—–|-]/)[0].trim();
  const q = normalizeRef(raw);
  if (!q) return [];
  return parts
    .filter((p) => normalizeRef(p.id).includes(q))
    .slice(0, limit);
}
