import { clamp01, hexToRgb01, type Vec2 } from './utils';

/**
 * Original “cute” startup blush — dusty mauve. Exported so the HUD slider, shader
 * default, and Customize panel’s first blush swatch all stay one real color.
 */
export const DEFAULT_BLUSH_HEX = '#8C598C' as const;

/**
 * Shared mutable color state for every makeup product.
 *
 * We expose this as a single mutable object (rather than per-product `let` exports)
 * because ESM exported `let`s are read-only at import sites — the customize panel
 * and photo-upload pipeline both need to mutate these values from outside this module.
 *
 * Defaults are tuned for the "first frame before anything else happens" look.
 */
export const makeupColors = {
  lipstickTop:     [0.85, 0.10, 0.35] as [number, number, number],
  lipstickBottom:  [0.85, 0.10, 0.35] as [number, number, number],
  /** Live forehead skin-tone sample. Concealer = this, lifted ~half a shade. */
  liveSkinTone:    [0.78, 0.62, 0.52] as [number, number, number],
  eyeShadowCrease: [0.20, 0.40, 0.15] as [number, number, number],
  eyeShadowLash:   [0.20, 0.40, 0.15] as [number, number, number],
  eyeLiner:        [0.20, 0.05, 0.05] as [number, number, number],
  brow:            [0.25, 0.18, 0.12] as [number, number, number],
  /** Default “cute” mauve blush; same hex as `DEFAULT_BLUSH_HEX` + first Customize swatch. */
  blush: hexToRgb01(DEFAULT_BLUSH_HEX),
  noseContour:     [0.62, 0.50, 0.45] as [number, number, number],
};

export type MakeupColorsMutable = typeof makeupColors;

/** Nose-tip highlight: a soft pink screen-blend. Not user-customizable. */
export const NOSE_TIP_RGB: [number, number, number] = [0.45, 0.20, 0.28];

// =============================================================================
// Color sampling (used when analyzing an uploaded makeup photo).
// =============================================================================

export function pointInPolygon(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function sampleMeanColorFromPolygon(
  ctx: CanvasRenderingContext2D,
  polyPx: Array<[number, number]>,
) {
  if (polyPx.length < 3) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of polyPx) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  minX = Math.floor(minX);
  minY = Math.floor(minY);
  maxX = Math.ceil(maxX);
  maxY = Math.ceil(maxY);
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const img = ctx.getImageData(minX, minY, w, h);
  const data = img.data;

  let r = 0, g = 0, b = 0, n = 0;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const px = minX + xx;
      const py = minY + yy;
      if (!pointInPolygon(px, py, polyPx)) continue;
      const idx = (yy * w + xx) * 4;
      if (data[idx + 3] < 5) continue;
      r += data[idx];
      g += data[idx + 1];
      b += data[idx + 2];
      n++;
    }
  }
  if (n < 50) return null;
  return { r: r / n, g: g / n, b: b / n };
}

export function sampleMeanColorFromEllipse(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
) {
  const minX = Math.floor(cx - rx);
  const minY = Math.floor(cy - ry);
  const w = Math.max(1, Math.ceil(rx * 2));
  const h = Math.max(1, Math.ceil(ry * 2));
  const img = ctx.getImageData(minX, minY, w, h);
  const data = img.data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const x = minX + xx;
      const y = minY + yy;
      const dx = (x - cx) / (rx + 1e-9);
      const dy = (y - cy) / (ry + 1e-9);
      if (dx * dx + dy * dy > 1) continue;
      const idx = (yy * w + xx) * 4;
      if (data[idx + 3] < 5) continue;
      r += data[idx];
      g += data[idx + 1];
      b += data[idx + 2];
      n++;
    }
  }
  if (n < 30) return null;
  return { r: r / n, g: g / n, b: b / n };
}

/** Closed hull around landmark points (for photo color sampling, like lip regions). */
export function sampleMeanColorFromPointHull(
  ctx: CanvasRenderingContext2D,
  normPts: Vec2[],
  bmpW: number,
  bmpH: number,
) {
  if (normPts.length < 3) return null;
  const hull = convexHull(normPts);
  if (hull.length < 3) return null;
  const polyPx = hull.map((p) => [p.x * bmpW, p.y * bmpH] as [number, number]);
  return sampleMeanColorFromPolygon(ctx, polyPx);
}

export function convexHull(points: Vec2[]): Vec2[] {
  // Monotonic chain hull in normalized coordinates.
  const pts = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (pts.length <= 3) return pts;

  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

// =============================================================================
// Photo-sample color corrections.
// =============================================================================

/** Concealer = skin tone lifted slightly with a warm bias (~half-shade lighter, as in real makeup). */
export function concealerColorFromSkin(skin: [number, number, number]): [number, number, number] {
  return [clamp01(skin[0] + 0.10), clamp01(skin[1] + 0.08), clamp01(skin[2] + 0.05)];
}

/**
 * Photo-sampled cheek pixels bleed warm skin tone into the blush color, which lands on the
 * orange side of the warm spectrum. Pull the blue channel up toward red (pink keeps B close to R)
 * and trim green a touch so the result reads pink instead of peach/coral. Already-pink samples
 * stay pink — the formula is adaptive: the lift is proportional to (r - b), which is small for
 * pinks and large for oranges.
 */
export function pinkifyBlush(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb;
  const newB = clamp01(b + 0.35 * Math.max(0, r - b));
  const newG = clamp01(g * 0.88);
  return [r, newG, newB];
}

// =============================================================================
// Live skin-tone sampling (forehead pixels from the video feed).
// =============================================================================

// Tiny scratch 2D canvas used to drawImage() the current video frame so we can sample
// the user's live skin tone with `sampleMeanColorFromEllipse`. 256² is plenty — we only
// average ~tens of pixels around landmark 10 — and avoids a heavy readPixels round-trip.
const skinScratchCanvas = document.createElement('canvas');
skinScratchCanvas.width = 256;
skinScratchCanvas.height = 256;
const skinScratchCtx = skinScratchCanvas.getContext('2d', { willReadFrequently: true })!;

/**
 * Pull a fresh skin-tone reading from a small forehead ellipse (landmark 10). Rejects samples
 * that are obviously not skin (hair occlusion -> very dark, or hot specular -> very bright).
 * Mutates `makeupColors.liveSkinTone` in place.
 */
export function sampleLiveSkinTone(srcEl: HTMLVideoElement, pts: Vec2[]) {
  const fore = pts[10];
  if (!fore) return;
  const w = skinScratchCanvas.width;
  const h = skinScratchCanvas.height;
  skinScratchCtx.drawImage(srcEl, 0, 0, w, h);
  const c = sampleMeanColorFromEllipse(skinScratchCtx, fore.x * w, fore.y * h, w * 0.05, h * 0.025);
  if (!c) return;
  const luma = (c.r + c.g + c.b) / 3;
  if (luma < 30 || luma > 245) return; // probably hair / blown highlight, keep previous
  makeupColors.liveSkinTone = [clamp01(c.r / 255), clamp01(c.g / 255), clamp01(c.b / 255)];
}
