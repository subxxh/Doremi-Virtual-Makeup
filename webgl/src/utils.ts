/**
 * Tiny shared helpers used across modules. Keeping these here (rather than scattered)
 * avoids circular imports — every other module can lean on `utils` without dragging
 * in colors / webgl / etc.
 */

/** A 2D point in normalized landmark space (0..1). */
export type Vec2 = { x: number; y: number };

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Parse a `#RRGGBB` (or `#RGB`) hex string into a `[r,g,b]` triple in 0..1, matching the float space the shaders expect. */
export function hexToRgb01(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/** `[r,g,b]` in 0..1 → `#RRGGBB` for HUD `--c` and saved looks. */
export function rgb01ToHex(r: number, g: number, b: number): string {
  const byte = (x: number) => Math.round(clamp01(x) * 255);
  const rr = byte(r).toString(16).padStart(2, '0');
  const gg = byte(g).toString(16).padStart(2, '0');
  const bb = byte(b).toString(16).padStart(2, '0');
  return `#${rr}${gg}${bb}`.toUpperCase();
}
