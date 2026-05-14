import { clamp01, type Vec2 } from './utils';
import { convexHull } from './colors';

/**
 * Pure geometry builders. Everything in here returns either `Vec2[]` (normalized
 * landmark space) or a `Float32Array` of clip-space triangle vertices (`[-1..1]`,
 * matching what WebGL wants). No GL calls live in this file.
 */

export function normToClip(p: Vec2): [number, number] {
  // Landmarks are normalized [0..1]. Mirror X to match the mirrored webcam.
  const x = 1.0 - p.x;
  const y = p.y;
  return [x * 2 - 1, (1 - y) * 2 - 1];
}

function sortAroundCenter(pts: Vec2[], center: Vec2): Vec2[] {
  return [...pts].sort((a, b) => {
    const aa = Math.atan2(a.y - center.y, a.x - center.x);
    const bb = Math.atan2(b.y - center.y, b.x - center.x);
    return aa - bb;
  });
}

export function buildFan(pts: Vec2[], sortByAngle: boolean = false): Float32Array {
  if (pts.length < 3) return new Float32Array(0);
  let cx = 0, cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  const center: Vec2 = { x: cx, y: cy };

  const contour = sortByAngle ? sortAroundCenter(pts, center) : pts;

  const out: number[] = [];
  const [ccx, ccy] = normToClip(center);
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i];
    const b = contour[(i + 1) % contour.length];
    const [ax, ay] = normToClip(a);
    const [bx, by] = normToClip(b);
    out.push(ccx, ccy, ax, ay, bx, by);
  }
  return new Float32Array(out);
}

export function buildRibbon(
  pts: Vec2[],
  halfWidth: number,
  taper: boolean = false,
): Float32Array {
  // Build a thick polyline "ribbon" as triangles (better eyebrow/eyeliner than filled polygons).
  if (pts.length < 2) return new Float32Array(0);
  const hw = Math.max(0.0005, halfWidth);

  const out: number[] = [];

  const getDir = (a: Vec2, b: Vec2) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  };

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];

    const d0 = getDir(prev, p);
    const d1 = getDir(p, next);
    // Average direction for smoother joints
    let dx = d0.x + d1.x;
    let dy = d0.y + d1.y;
    const dlen = Math.hypot(dx, dy) || 1;
    dx /= dlen;
    dy /= dlen;

    const nx = -dy;
    const ny = dx;

    let w = hw;
    if (taper) {
      const t = pts.length === 1 ? 0.5 : i / (pts.length - 1);
      // Thin at ends, thick in the middle (more hair-like, less blob).
      const s = Math.sin(Math.PI * t);
      w = hw * (0.35 + 0.65 * s);
    }

    const left: Vec2 = { x: clamp01(p.x + nx * w), y: clamp01(p.y + ny * w) };
    const right: Vec2 = { x: clamp01(p.x - nx * w), y: clamp01(p.y - ny * w) };

    const [lx, ly] = normToClip(left);
    const [rx, ry] = normToClip(right);
    out.push(lx, ly, rx, ry);
  }

  const tri: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const i0 = i * 4;
    const i1 = (i + 1) * 4;
    const v0L = [out[i0], out[i0 + 1]];
    const v0R = [out[i0 + 2], out[i0 + 3]];
    const v1L = [out[i1], out[i1 + 1]];
    const v1R = [out[i1 + 2], out[i1 + 3]];
    tri.push(v0L[0], v0L[1], v0R[0], v0R[1], v1L[0], v1L[1]);
    tri.push(v1L[0], v1L[1], v0R[0], v0R[1], v1R[0], v1R[1]);
  }
  return new Float32Array(tri);
}

function resamplePolyline(pts: Vec2[], n: number): Vec2[] {
  if (n < 2 || pts.length === 0) return [];
  if (pts.length === 1) return Array.from({ length: n }, () => ({ x: pts[0].x, y: pts[0].y }));
  const lens: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    lens.push(lens[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = lens[lens.length - 1];
  const out: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const t = total < 1e-9 ? 0 : (k / (n - 1)) * total;
    let j = 0;
    while (j < lens.length - 2 && lens[j + 1] < t) j++;
    const segLen = lens[j + 1] - lens[j];
    const u = segLen < 1e-9 ? 0 : (t - lens[j]) / segLen;
    const p0 = pts[j];
    const p1 = pts[j + 1];
    out.push({ x: clamp01(p0.x + (p1.x - p0.x) * u), y: clamp01(p0.y + (p1.y - p0.y) * u) });
  }
  return out;
}

function revPts(pts: Vec2[]): Vec2[] {
  return [...pts].reverse();
}

/**
 * Mean squared distance between equal-arc-length samples on crease vs lash.
 * Wrong reversal (twisted loft) keeps large gaps even after resample; correct direction minimizes this.
 */
function loftCorrespondenceMse(crease: Vec2[], lash: Vec2[], sampleN = 28): number {
  if (crease.length < 2 || lash.length < 2) return Infinity;
  const cS = resamplePolyline(crease, sampleN);
  const lS = resamplePolyline(lash, sampleN);
  let acc = 0;
  for (let i = 0; i < sampleN; i++) {
    const dx = cS[i].x - lS[i].x;
    const dy = cS[i].y - lS[i].y;
    acc += dx * dx + dy * dy;
  }
  return acc / sampleN;
}

/** Pick crease/lash directions so loft is one sheet: brow-side crease, then best correspondence (not just endpoint distance). */
function alignCreaseLashForStrip(crease: Vec2[], lash: Vec2[]): { crease: Vec2[]; lash: Vec2[] } {
  if (crease.length < 2 || lash.length < 2) return { crease, lash };
  const endScore = (c: Vec2[], l: Vec2[]) => {
    const [ax, ay] = normToClip(c[0]);
    const [bx, by] = normToClip(c[c.length - 1]);
    const [cx, cy] = normToClip(l[0]);
    const [dx, dy] = normToClip(l[l.length - 1]);
    const d2 = (p: number, q: number, r: number, s: number) => {
      const u = p - r;
      const v = q - s;
      return u * u + v * v;
    };
    return d2(ax, ay, cx, cy) + d2(bx, by, dx, dy);
  };
  const meanY = (v: Vec2[]) => v.reduce((a, p) => a + p.y, 0) / v.length;
  const lRev = revPts(lash);
  const cRev = revPts(crease);
  const opts = [
    { id: 0, c: crease, l: lash, s: endScore(crease, lash), m: loftCorrespondenceMse(crease, lash) },
    { id: 1, c: crease, l: lRev, s: endScore(crease, lRev), m: loftCorrespondenceMse(crease, lRev) },
    { id: 2, c: cRev, l: lash, s: endScore(cRev, lash), m: loftCorrespondenceMse(cRev, lash) },
    { id: 3, c: cRev, l: lRev, s: endScore(cRev, lRev), m: loftCorrespondenceMse(cRev, lRev) },
  ];
  const okAny = opts.some((o) => meanY(o.c) < meanY(o.l) - 0.001);
  opts.sort((a, b) => {
    const okA = meanY(a.c) < meanY(a.l) - 0.001;
    const okB = meanY(b.c) < meanY(b.l) - 0.001;
    if (okAny) {
      if (okA !== okB) return okA ? -1 : 1;
    }
    if (a.m !== b.m) return a.m < b.m ? -1 : 1;
    if (a.s !== b.s) return a.s < b.s ? -1 : 1;
    return a.id - b.id;
  });
  return { crease: opts[0].c, lash: opts[0].l };
}

/**
 * Eyeshadow strip between crease and upper lash: loft both polylines at the same arc-length parameter.
 * (Nearest-crease + monotonic `jLo` on a much longer crease folds the mesh and reads as two blobs / tears.)
 * Pass crease/lash already oriented (e.g. via `alignCreaseLashForStrip`).
 */
function buildEyeshadowCreaseLashStrip(crease: Vec2[], lash: Vec2[], segments: number): Float32Array {
  if (crease.length < 2 || lash.length < 2) return new Float32Array(0);
  const n = Math.max(12, Math.min(56, segments | 0));
  const creaseS = resamplePolyline(crease, n);
  const lashS = resamplePolyline(lash, n);
  const tri: number[] = [];
  const pushClipTri = (a: Vec2, b: Vec2, cPt: Vec2) => {
    const [ax, ay] = normToClip(a);
    const [bx, by] = normToClip(b);
    const [cx, cy] = normToClip(cPt);
    tri.push(ax, ay, bx, by, cx, cy);
  };
  for (let i = 0; i < n - 1; i++) {
    const a0 = creaseS[i];
    const a1 = creaseS[i + 1];
    const b0 = lashS[i];
    const b1 = lashS[i + 1];
    pushClipTri(a0, a1, b1);
    pushClipTri(a0, b1, b0);
  }
  return new Float32Array(tri);
}

/** Same crease↔lash strip path for each eye (align + lash-led map + brow feather). */
export function buildShadowRibbon(
  pts: Vec2[],
  creaseIdx: readonly number[],
  lashIdx: readonly number[],
): Float32Array {
  const crease = creaseIdx.map((i) => pts[i]).filter(Boolean) as Vec2[];
  const lash = lashIdx.map((i) => pts[i]).filter(Boolean) as Vec2[];
  const { crease: c, lash: l } = alignCreaseLashForStrip(crease, lash);
  return buildEyeshadowCreaseLashStrip(c, l, 36);
}

export function buildWingedRibbon(
  pts: Vec2[],
  halfWidth: number,
  side: 'left' | 'right',
  wingLen: number,
): Float32Array {
  if (pts.length < 2) return new Float32Array(0);
  // Add one extrapolated point past the outer corner for a small wing.
  // Outer corner = first point in our upper-lid lists.
  const corner = pts[0];
  const next = pts[1];
  let dx = corner.x - next.x;
  let dy = corner.y - next.y;

  // Heuristic: force the wing to go "outward" horizontally for each eye.
  // (Avoids both wings pointing the same direction due to contour ordering / mirroring.)
  if (side === 'left' && dx > 0) dx = -dx;
  if (side === 'right' && dx < 0) dx = -dx;

  // Slight upward tilt for a cute wing.
  dy -= 0.45 * Math.abs(dx);

  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const wing: Vec2 = { x: clamp01(corner.x + ux * wingLen), y: clamp01(corner.y + uy * wingLen) };
  const withWing = [wing, ...pts];
  return buildRibbon(withWing, halfWidth);
}

export function buildBlushRegion(allPts: Vec2[], centerIdx: number, side: 'left' | 'right'): Float32Array {
  const c = allPts[centerIdx];
  if (!c) return new Float32Array(0);

  // Pick nearby landmarks around the cheek point; this adapts to face size/pose.
  const radius = 0.075;
  const candidates: Vec2[] = [];
  for (let i = 0; i < allPts.length; i++) {
    const p = allPts[i];
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > radius * radius) continue;

    // Keep it cheekbone-ish: a tighter vertical band prevents spreading to jaw/eye.
    if (Math.abs(dy) > 0.05) continue;
    if (side === 'left' && p.x > c.x + 0.02) continue;
    if (side === 'right' && p.x < c.x - 0.02) continue;
    candidates.push(p);
  }

  if (candidates.length < 8) {
    const simple: Vec2[] = [];
    const r = 0.03;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      simple.push({ x: clamp01(c.x + Math.cos(a) * r), y: clamp01(c.y + Math.sin(a) * r) });
    }
    return buildFan(simple);
  }

  return buildFan(convexHull(candidates));
}

/**
 * Under-eye crescent for concealer: the lower-lid polyline plus a copy offset downward,
 * stitched into a closed polygon. `offsetDown` is in normalized-y units; ~0.030 hits the
 * tear-trough / upper-cheek band where dark circles sit.
 */
export function buildUnderEyeRegion(
  pts: Vec2[],
  lowerLidIdx: readonly number[],
  offsetDown = 0.030,
): Float32Array {
  const lid = lowerLidIdx.map((i) => pts[i]).filter(Boolean) as Vec2[];
  if (lid.length < 3) return new Float32Array(0);
  const lower = lid.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y + offsetDown) }));
  const poly: Vec2[] = lid.concat([...lower].reverse());
  return buildFan(poly);
}

export function offsetPts(pts: Vec2[], dx: number, dy: number = 0): Vec2[] {
  return pts.map((p) => ({ x: clamp01(p.x + dx), y: clamp01(p.y + dy) }));
}

export function makeCircle(center: Vec2, r: number, seg = 24): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push({ x: clamp01(center.x + Math.cos(a) * r), y: clamp01(center.y + Math.sin(a) * r) });
  }
  return pts;
}

export function uniqueConcat<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const x of a.concat(b)) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

// =============================================================================
// Clip-space bounding boxes — used by the renderer to scissor each region's draw
// to its bbox (massive fragment savings) and to drive the makeup shader's
// top→bottom color gradient.
// =============================================================================

export type ClipBounds = { xMin: number; xMax: number; yMin: number; yMax: number };

export function clipBounds(verts: Float32Array): ClipBounds {
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < verts.length; i += 2) {
    const x = verts[i];
    const y = verts[i + 1];
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  return { xMin, xMax, yMin, yMax };
}

/** Convert a clip-space bbox (-1..1) into a pixel rect on a framebuffer, padded by `padPx`. */
export function clipBoundsToPixelRect(
  fbW: number,
  fbH: number,
  b: ClipBounds,
  padPx: number,
) {
  const x = Math.max(0, Math.floor((b.xMin + 1) * 0.5 * fbW) - padPx);
  const x2 = Math.min(fbW, Math.ceil((b.xMax + 1) * 0.5 * fbW) + padPx);
  const y = Math.max(0, Math.floor((b.yMin + 1) * 0.5 * fbH) - padPx);
  const y2 = Math.min(fbH, Math.ceil((b.yMax + 1) * 0.5 * fbH) + padPx);
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}
