/** Similarity transform CAD↔image — same math as Bestückungsplan (epicknplace-web). */
export const MIN_CAL_PIXEL_DIST = 8;

export function emptyCal() {
  return {
    cal1: { calX: 0, calY: 0, calId: '' },
    cal2: { calX: 0, calY: 0, calId: '' },
    flipX: false,
    flipY: false,
  };
}

/** Normalize cal from .BSU / localStorage — always includes flipX/flipY booleans. */
export function normalizeCal(raw) {
  const base = emptyCal();
  if (!raw || typeof raw !== 'object') return base;
  const c1 = raw.cal1 && typeof raw.cal1 === 'object' ? raw.cal1 : {};
  const c2 = raw.cal2 && typeof raw.cal2 === 'object' ? raw.cal2 : {};
  return {
    cal1: {
      calX: Number(c1.calX) || 0,
      calY: Number(c1.calY) || 0,
      calId: String(c1.calId || ''),
    },
    cal2: {
      calX: Number(c2.calX) || 0,
      calY: Number(c2.calY) || 0,
      calId: String(c2.calId || ''),
    },
    flipX: !!raw.flipX,
    flipY: !!raw.flipY,
  };
}

function pixelDist(cal) {
  const dx = cal.cal1.calX - cal.cal2.calX;
  const dy = cal.cal1.calY - cal.cal2.calY;
  return Math.hypot(dx, dy);
}

export function isCalibrated(cal, parts) {
  if (!cal?.cal1?.calId || !cal?.cal2?.calId) return false;
  if (cal.cal1.calId === cal.cal2.calId) return false;
  if (
    cal.cal1.calX === 0 &&
    cal.cal1.calY === 0 &&
    cal.cal2.calX === 0 &&
    cal.cal2.calY === 0
  ) {
    return false;
  }
  if (pixelDist(cal) < MIN_CAL_PIXEL_DIST) return false;
  if (parts) {
    const c1 = parts.find((p) => p.id === cal.cal1.calId);
    const c2 = parts.find((p) => p.id === cal.cal2.calId);
    if (!c1 || !c2) return false;
    if (c1.x === c2.x && c1.y === c2.y) return false;
  }
  return true;
}

export function applyCadFlip(x, y, cal) {
  return {
    x: cal.flipX ? -x : x,
    y: cal.flipY ? -y : y,
  };
}

export function getCalTransform(cal, parts) {
  if (!isCalibrated(cal, parts)) return null;
  const c1 = parts.find((p) => p.id === cal.cal1.calId);
  const c2 = parts.find((p) => p.id === cal.cal2.calId);
  if (!c1 || !c2) return null;

  const p1 = applyCadFlip(c1.x, c1.y, cal);
  const p2 = applyCadFlip(c2.x, c2.y, cal);

  const dxCad = p2.x - p1.x;
  const dyCad = p2.y - p1.y;
  const dxPx = cal.cal2.calX - cal.cal1.calX;
  const dyPx = cal.cal2.calY - cal.cal1.calY;
  const lenCad = Math.hypot(dxCad, dyCad);
  const lenPx = Math.hypot(dxPx, dyPx);
  if (lenCad < 1e-9 || lenPx < MIN_CAL_PIXEL_DIST) return null;

  const scale = lenPx / lenCad;
  const angCad = Math.atan2(dyCad, dxCad);
  const angPx = Math.atan2(dyPx, dxPx);
  const rot = angPx - angCad;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);

  const tx = cal.cal1.calX - scale * (cos * p1.x - sin * p1.y);
  const ty = cal.cal1.calY - scale * (sin * p1.x + cos * p1.y);
  return { scale, cos, sin, tx, ty, flipX: !!cal.flipX, flipY: !!cal.flipY };
}

export function cadToImage(part, cal, parts) {
  const t = getCalTransform(cal, parts);
  if (!t) return null;
  const p = applyCadFlip(part.x, part.y, cal);
  return {
    x: Math.round(t.scale * (t.cos * p.x - t.sin * p.y) + t.tx),
    y: Math.round(t.scale * (t.sin * p.x + t.cos * p.y) + t.ty),
  };
}

export function scoreFlipCombo(cal, allParts, sideParts, imgW, imgH, flipX, flipY) {
  const test = {
    ...cal,
    flipX,
    flipY,
    cal1: { ...cal.cal1 },
    cal2: { ...cal.cal2 },
  };
  if (!isCalibrated(test, allParts)) return Number.NEGATIVE_INFINITY;
  const margin = Math.max(4, Math.min(imgW, imgH) * 0.03);
  let score = 0;
  for (const p of sideParts) {
    const pos = cadToImage(p, test, allParts);
    if (!pos) {
      score -= 5;
      continue;
    }
    if (pos.x >= margin && pos.y >= margin && pos.x <= imgW - margin && pos.y <= imgH - margin) {
      score += 10;
    } else if (
      pos.x >= -imgW * 0.15 &&
      pos.y >= -imgH * 0.15 &&
      pos.x <= imgW * 1.15 &&
      pos.y <= imgH * 1.15
    ) {
      score += 1;
    } else {
      score -= 3;
    }
  }
  return score;
}

export function pickBestFlips(cal, allParts, sideParts, imgW, imgH) {
  // Prefer no flip on ties — assembly PDFs usually share CAD axis orientation.
  let best = { flipX: false, flipY: false, score: Number.NEGATIVE_INFINITY };
  for (const flipX of [false, true]) {
    for (const flipY of [false, true]) {
      const score = scoreFlipCombo(cal, allParts, sideParts, imgW, imgH, flipX, flipY);
      if (score > best.score) best = { flipX, flipY, score };
    }
  }
  return best;
}
