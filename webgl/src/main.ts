import './style.css';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { FacePoints, FaceRegions } from './regions';

type Vec2 = { x: number; y: number };

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app not found');

app.innerHTML = `
  <div class="stage">
    <canvas id="gl"></canvas>
    <canvas id="overlay"></canvas>
    <div class="hud">
      <div class="hud-title">Doremi Virtual Makeup (WebGL)</div>
      <div class="hud-row">Keys: <code>D</code> toggle debug points</div>
      <div class="hud-row">
        <button id="uploadBtn" type="button">Upload makeup photo</button>
        <input id="fileInput" type="file" accept="image/*" />
      </div>
      <div class="hud-row">
        Lips <input id="lipIntensity" type="range" min="0" max="100" value="15" />
      </div>
      <div class="hud-row">
        Eyeshadow <input id="eyeShadowIntensity" type="range" min="0" max="100" value="18" />
      </div>
      <div class="hud-row">
        Eyeliner <input id="eyeLinerIntensity" type="range" min="0" max="100" value="20" />
      </div>
      <div class="hud-row">
        Brows <input id="browIntensity" type="range" min="0" max="100" value="16" />
      </div>
      <div class="hud-row">
        Blush <input id="blushIntensity" type="range" min="0" max="100" value="14" />
      </div>
      <div class="hud-row">
        Nose contour <input id="noseIntensity" type="range" min="0" max="100" value="10" />
      </div>
      <div class="hud-row" id="status">Loading…</div>
    </div>
  </div>
`;

const glCanvas = document.querySelector<HTMLCanvasElement>('#gl')!;
const overlayCanvas = document.querySelector<HTMLCanvasElement>('#overlay')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const uploadBtn = document.querySelector<HTMLButtonElement>('#uploadBtn')!;
const fileInput = document.querySelector<HTMLInputElement>('#fileInput')!;
const lipIntensityEl = document.querySelector<HTMLInputElement>('#lipIntensity')!;
const eyeShadowIntensityEl = document.querySelector<HTMLInputElement>('#eyeShadowIntensity')!;
const eyeLinerIntensityEl = document.querySelector<HTMLInputElement>('#eyeLinerIntensity')!;
const browIntensityEl = document.querySelector<HTMLInputElement>('#browIntensity')!;
const blushIntensityEl = document.querySelector<HTMLInputElement>('#blushIntensity')!;
const noseIntensityEl = document.querySelector<HTMLInputElement>('#noseIntensity')!;

let showDebug = true;
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'd') showDebug = !showDebug;
});

function resizeCanvases() {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  for (const c of [glCanvas, overlayCanvas]) {
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
  }
}
window.addEventListener('resize', resizeCanvases);
resizeCanvases();

const overlay2d = overlayCanvas.getContext('2d')!;

// Hidden <video> source for webcam frames.
const video = document.createElement('video');
video.playsInline = true;
video.muted = true;
video.autoplay = true;
video.style.display = 'none';
document.body.appendChild(video);

// MJPEG <img> source (for OBS Browser Source mode)
const mjpegImg = document.createElement('img');
mjpegImg.style.display = 'none';
document.body.appendChild(mjpegImg);

type SourceKind = 'camera' | 'mjpeg';
const params = new URLSearchParams(window.location.search);
const sourceKind: SourceKind = (params.get('src') === 'mjpeg' ? 'mjpeg' : 'camera');
// Default to same-origin proxy path (see vite.config.ts) for OBS compatibility.
const mjpegUrl = params.get('mjpeg') || '/stream.mjpg';

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function pointInPolygon(x: number, y: number, poly: Array<[number, number]>) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0],
      yi = poly[i][1];
    const xj = poly[j][0],
      yj = poly[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function sampleMeanColorFromPolygon(
  ctx: CanvasRenderingContext2D,
  polyPx: Array<[number, number]>,
) {
  if (polyPx.length < 3) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of polyPx) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  minX = Math.floor(minX);
  minY = Math.floor(minY);
  maxX = Math.ceil(maxX);
  maxY = Math.ceil(maxY);
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const img = ctx.getImageData(minX, minY, w, h);
  const data = img.data;

  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const px = minX + xx;
      const py = minY + yy;
      if (!pointInPolygon(px, py, polyPx)) continue;
      const idx = (yy * w + xx) * 4;
      const rr = data[idx];
      const gg = data[idx + 1];
      const bb = data[idx + 2];
      const a = data[idx + 3];
      if (a < 5) continue;
      r += rr;
      g += gg;
      b += bb;
      n++;
    }
  }
  if (n < 50) return null;
  return { r: r / n, g: g / n, b: b / n };
}

function sampleMeanColorFromEllipse(
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
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const x = minX + xx;
      const y = minY + yy;
      const dx = (x - cx) / (rx + 1e-9);
      const dy = (y - cy) / (ry + 1e-9);
      if (dx * dx + dy * dy > 1) continue;
      const idx = (yy * w + xx) * 4;
      const a = data[idx + 3];
      if (a < 5) continue;
      r += data[idx];
      g += data[idx + 1];
      b += data[idx + 2];
      n++;
    }
  }
  if (n < 30) return null;
  return { r: r / n, g: g / n, b: b / n };
}

function convexHull(points: Vec2[]) {
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

function buildBlushRegion(allPts: Vec2[], centerIdx: number, side: 'left' | 'right') {
  const c = allPts[centerIdx];
  if (!c) return { fill: new Float32Array(0), feather: new Float32Array(0), poly: [] as Vec2[] };

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

  // If too few points, fall back to a small fan around center using 8 samples.
  if (candidates.length < 8) {
    const simple: Vec2[] = [];
    const r = 0.03;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      simple.push({ x: clamp01(c.x + Math.cos(a) * r), y: clamp01(c.y + Math.sin(a) * r) });
    }
    const fill = buildFan(simple, 0);
    const feather = buildFan(simple, 0.18);
    return { fill, feather, poly: simple };
  }

  const hull = convexHull(candidates);
  const fill = buildFan(hull, 0);
  const feather = buildFan(hull, 0.22);
  return { fill, feather, poly: hull };
}

async function startMJPEG() {
  // OBS Browser Source can generally display MJPEG without camera permissions.
  // We'll use it as our texture source.
  mjpegImg.src = mjpegUrl;
  await new Promise<void>((resolve, reject) => {
    const start = performance.now();
    const tick = () => {
      if (mjpegImg.naturalWidth > 0) return resolve();
      if (performance.now() - start > 8000) return reject(new Error('MJPEG timeout'));
      requestAnimationFrame(tick);
    };
    mjpegImg.onerror = () => reject(new Error('MJPEG failed to load'));
    tick();
  });
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type);
  if (!s) throw new Error('createShader failed');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
  }
  return s;
}

function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  if (!p) throw new Error('createProgram failed');
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return p;
}

// WebGL: draw a fullscreen textured quad (the webcam).
// Request a stencil buffer so we can "cut out" the inner mouth (prevents lipstick on teeth).
const gl = glCanvas.getContext('webgl2', { alpha: false, antialias: true, stencil: true })!;
if (!gl) throw new Error('WebGL2 not available');

// Make video textures match 2D/canvas coordinates (prevents upside-down camera).
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

const quadVS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = (a_pos + 1.0) * 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const quadFS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 outColor;
void main() {
  // Mirror horizontally (more natural for users + matches typical filters).
  vec2 uv = vec2(1.0 - v_uv.x, v_uv.y);
  outColor = texture(u_tex, uv);
}`;

const quadProgram = createProgram(gl, quadVS, quadFS);
const quadVAO = gl.createVertexArray()!;
gl.bindVertexArray(quadVAO);
const quadBuf = gl.createBuffer()!;
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
  gl.STATIC_DRAW,
);
const quadPosLoc = gl.getAttribLocation(quadProgram, 'a_pos');
gl.enableVertexAttribArray(quadPosLoc);
gl.vertexAttribPointer(quadPosLoc, 2, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

const videoTex = gl.createTexture()!;
gl.bindTexture(gl.TEXTURE_2D, videoTex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.bindTexture(gl.TEXTURE_2D, null);

// Simple GPU lips overlay: triangle-fan polygons blended over the webcam.
const polyVS = `#version 300 es
in vec2 a_pos;
out float v_y;
void main() {
  v_y = a_pos.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const polyFS = `#version 300 es
precision mediump float;
uniform vec4 u_colorTop;
uniform vec4 u_colorBottom;
uniform vec2 u_yMinMax; // clip-space y min/max for gradient normalization
out vec4 outColor;
in float v_y;
void main() {
  float y0 = u_yMinMax.x;
  float y1 = u_yMinMax.y;
  float t = 0.5;
  if (abs(y1 - y0) > 1e-5) {
    t = clamp((v_y - y0) / (y1 - y0), 0.0, 1.0);
  }
  outColor = mix(u_colorTop, u_colorBottom, t);
}`;

const polyProgram = createProgram(gl, polyVS, polyFS);
const polyVAO = gl.createVertexArray()!;
const polyBuf = gl.createBuffer()!;
const polyPosLoc = gl.getAttribLocation(polyProgram, 'a_pos');
const polyColorTopLoc = gl.getUniformLocation(polyProgram, 'u_colorTop');
const polyColorBottomLoc = gl.getUniformLocation(polyProgram, 'u_colorBottom');
const polyYMinMaxLoc = gl.getUniformLocation(polyProgram, 'u_yMinMax');

type RegionKey = keyof typeof FaceRegions;
type FeatherKey =
  | 'LIP_UPPER_FEATHER'
  | 'LIP_LOWER_FEATHER'
  | 'EYESHADOW_LEFT_FEATHER'
  | 'EYESHADOW_RIGHT_FEATHER'
  | 'BLUSH_LEFT_FEATHER'
  | 'BLUSH_RIGHT_FEATHER'
  | 'BLUSH_LEFT'
  | 'BLUSH_RIGHT'
  | 'LIP_OUTER'
  | 'LIP_OUTER_FEATHER'
  | 'MOUTH_INNER'
  | 'BROW_LEFT_RIBBON'
  | 'BROW_RIGHT_RIBBON'
  | 'BROW_LEFT_RIBBON_FEATHER'
  | 'BROW_RIGHT_RIBBON_FEATHER'
  | 'LEFT_EYE'
  | 'RIGHT_EYE'
  | 'LINER_LEFT_RIBBON'
  | 'LINER_RIGHT_RIBBON'
  | 'LINER_LEFT_RIBBON_FEATHER'
  | 'LINER_RIGHT_RIBBON_FEATHER'
  | 'SHADOW_LEFT_RIBBON'
  | 'SHADOW_RIGHT_RIBBON'
  | 'SHADOW_LEFT_RIBBON_FEATHER'
  | 'SHADOW_RIGHT_RIBBON_FEATHER'
  | 'NOSE_LEFT_RIBBON'
  | 'NOSE_RIGHT_RIBBON'
  | 'NOSE_LEFT_RIBBON_FEATHER'
  | 'NOSE_RIGHT_RIBBON_FEATHER'
  | 'NOSE_TIP'
  | 'NOSE_TIP_FEATHER';
type RegionVerts = Partial<Record<RegionKey | FeatherKey, Float32Array>>;
const regionVerts: RegionVerts = {};

let lipstickTopRGB: [number, number, number] = [0.85, 0.1, 0.35];
let lipstickBottomRGB: [number, number, number] = [0.85, 0.1, 0.35];
let eyeShadowRGB: [number, number, number] = [0.2, 0.4, 0.15];
let eyeLinerRGB: [number, number, number] = [0.2, 0.05, 0.05];
let browRGB: [number, number, number] = [0.25, 0.18, 0.12];
let blushRGB: [number, number, number] = [0.55, 0.35, 0.55];

function normToClip(p: Vec2): [number, number] {
  // Landmarks are normalized [0..1]. Mirror X to match the mirrored webcam.
  const x = 1.0 - p.x;
  const y = p.y;
  return [x * 2 - 1, (1 - y) * 2 - 1];
}

function sortAroundCenter(pts: Vec2[], center: Vec2) {
  return [...pts].sort((a, b) => {
    const aa = Math.atan2(a.y - center.y, a.x - center.x);
    const bb = Math.atan2(b.y - center.y, b.x - center.x);
    return aa - bb;
  });
}

function buildFan(pts: Vec2[], expand: number = 0, sortByAngle: boolean = false): Float32Array {
  if (pts.length < 3) return new Float32Array(0);
  let cx = 0,
    cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  const center: Vec2 = { x: cx, y: cy };

  const contour = sortByAngle ? sortAroundCenter(pts, center) : pts;

  const exp = Math.max(0, expand);
  const expanded = exp > 1e-6;

  const out: number[] = [];
  const [ccx, ccy] = normToClip(center);
  for (let i = 0; i < contour.length; i++) {
    let a = contour[i];
    let b = contour[(i + 1) % contour.length];

    if (expanded) {
      const ax = center.x + (a.x - center.x) * (1 + exp);
      const ay = center.y + (a.y - center.y) * (1 + exp);
      const bx = center.x + (b.x - center.x) * (1 + exp);
      const by = center.y + (b.y - center.y) * (1 + exp);
      a = { x: clamp01(ax), y: clamp01(ay) };
      b = { x: clamp01(bx), y: clamp01(by) };
    }

    const [ax, ay] = normToClip(a);
    const [bx, by] = normToClip(b);
    out.push(ccx, ccy, ax, ay, bx, by);
  }
  return new Float32Array(out);
}

function clipYMinMax(verts: Float32Array) {
  // verts are [x,y] pairs in clip space
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 1; i < verts.length; i += 2) {
    const y = verts[i];
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return { yMin: -1, yMax: 1 };
  return { yMin, yMax };
}

function buildRibbon(pts: Vec2[], halfWidth: number, taper: boolean = false): Float32Array {
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

    // Perpendicular normal
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

  // Convert strip vertices into triangles (two per segment)
  const tri: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const i0 = i * 4;
    const i1 = (i + 1) * 4;
    // v0L, v0R, v1L, v1R
    const v0L = [out[i0], out[i0 + 1]];
    const v0R = [out[i0 + 2], out[i0 + 3]];
    const v1L = [out[i1], out[i1 + 1]];
    const v1R = [out[i1 + 2], out[i1 + 3]];
    // Tri 1: v0L v0R v1L
    tri.push(v0L[0], v0L[1], v0R[0], v0R[1], v1L[0], v1L[1]);
    // Tri 2: v1L v0R v1R
    tri.push(v1L[0], v1L[1], v0R[0], v0R[1], v1R[0], v1R[1]);
  }
  return new Float32Array(tri);
}

function buildWingedRibbon(
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

function offsetPts(pts: Vec2[], dx: number, dy: number = 0) {
  return pts.map((p) => ({ x: clamp01(p.x + dx), y: clamp01(p.y + dy) }));
}

function makeCircle(center: Vec2, r: number, seg = 24) {
  const pts: Vec2[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push({ x: clamp01(center.x + Math.cos(a) * r), y: clamp01(center.y + Math.sin(a) * r) });
  }
  return pts;
}

function uniqueConcat<T>(a: T[], b: T[]) {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const x of a.concat(b)) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

type LandmarkerMode = 'VIDEO' | 'IMAGE';

async function createLandmarker(mode: LandmarkerMode) {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm',
  );
  const landmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
    },
    runningMode: mode,
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  });
  return landmarker;
}

function drawDebugPoints(points: Vec2[]) {
  overlay2d.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!showDebug) return;
  overlay2d.fillStyle = 'rgba(0, 255, 255, 0.8)';
  for (const p of points) {
    const x = (1 - p.x) * overlayCanvas.width;
    const y = p.y * overlayCanvas.height;
    overlay2d.beginPath();
    overlay2d.arc(x, y, 2.0, 0, Math.PI * 2);
    overlay2d.fill();
  }
}

async function main() {
  if (sourceKind === 'mjpeg') {
    statusEl.textContent = `Loading MJPEG stream…`;
    await startMJPEG();
  } else {
    statusEl.textContent = 'Requesting camera…';
    await startCamera();
  }

  statusEl.textContent = 'Loading face model…';
  const [landmarkerVideo, landmarkerImage] = await Promise.all([
    createLandmarker('VIDEO'),
    createLandmarker('IMAGE'),
  ]);

  statusEl.textContent =
    sourceKind === 'mjpeg'
      ? `Running (OBS Browser Source mode). MJPEG: ${mjpegUrl}`
      : 'Running (WebGL + Face Landmarks)…';

  let lastLipsUpdate = 0;

  // Upload makeup photo → sample lip color → apply to live lipstick tint
  fileInput.style.display = 'none';
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      statusEl.textContent = 'Analyzing makeup photo…';
      const bmp = await createImageBitmap(f);
      const off = document.createElement('canvas');
      off.width = bmp.width;
      off.height = bmp.height;
      const ctx = off.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);

      const res = landmarkerImage.detect(bmp as unknown as HTMLVideoElement);
      const face = res.faceLandmarks?.[0];
      if (!face?.length) {
        statusEl.textContent = 'No face found in photo.';
        return;
      }

      const pts = face.map((p) => ({ x: p.x, y: p.y }));
      const toPxPoly = (idxs: readonly number[]) =>
        idxs
          .map((i) => pts[i])
          .filter(Boolean)
          .map((p) => [p.x * bmp.width, p.y * bmp.height] as [number, number]);

      const mean2 = (a: any, b: any) =>
        a && b ? { r: (a.r + b.r) / 2, g: (a.g + b.g) / 2, b: (a.b + b.b) / 2 } : a || b;

      const lipTop = sampleMeanColorFromPolygon(ctx, toPxPoly(FaceRegions.LIP_UPPER));
      const lipBottom = sampleMeanColorFromPolygon(ctx, toPxPoly(FaceRegions.LIP_LOWER));
      const lipC = mean2(lipTop, lipBottom);
      if (lipTop)
        lipstickTopRGB = [clamp01(lipTop.r / 255), clamp01(lipTop.g / 255), clamp01(lipTop.b / 255)];
      if (lipBottom)
        lipstickBottomRGB = [
          clamp01(lipBottom.r / 255),
          clamp01(lipBottom.g / 255),
          clamp01(lipBottom.b / 255),
        ];
      if (lipC && !lipTop && !lipBottom) {
        lipstickTopRGB = [clamp01(lipC.r / 255), clamp01(lipC.g / 255), clamp01(lipC.b / 255)];
        lipstickBottomRGB = lipstickTopRGB;
      }

      const shadowC = mean2(
        sampleMeanColorFromPolygon(ctx, toPxPoly(FaceRegions.EYESHADOW_LEFT)),
        sampleMeanColorFromPolygon(ctx, toPxPoly(FaceRegions.EYESHADOW_RIGHT)),
      );
      if (shadowC) eyeShadowRGB = [clamp01(shadowC.r / 255), clamp01(shadowC.g / 255), clamp01(shadowC.b / 255)];

      const linerC = mean2(
        sampleMeanColorFromPolygon(ctx, toPxPoly(FaceRegions.EYELINER_LEFT)),
        sampleMeanColorFromPolygon(ctx, toPxPoly(FaceRegions.EYELINER_RIGHT)),
      );
      if (linerC) eyeLinerRGB = [clamp01(linerC.r / 255), clamp01(linerC.g / 255), clamp01(linerC.b / 255)];

      const browC = mean2(
        sampleMeanColorFromPolygon(ctx, toPxPoly(FaceRegions.EYEBROW_LEFT)),
        sampleMeanColorFromPolygon(ctx, toPxPoly(FaceRegions.EYEBROW_RIGHT)),
      );
      if (browC) browRGB = [clamp01(browC.r / 255), clamp01(browC.g / 255), clamp01(browC.b / 255)];

      const blushL = pts[FacePoints.BLUSH_LEFT];
      const blushR = pts[FacePoints.BLUSH_RIGHT];
      // Use a small ellipse for sampling color (shape on your face is handled by a polygon).
      const blushC = mean2(
        blushL ? sampleMeanColorFromEllipse(ctx, blushL.x * bmp.width, blushL.y * bmp.height, 18, 12) : null,
        blushR ? sampleMeanColorFromEllipse(ctx, blushR.x * bmp.width, blushR.y * bmp.height, 18, 12) : null,
      );
      if (blushC) blushRGB = [clamp01(blushC.r / 255), clamp01(blushC.g / 255), clamp01(blushC.b / 255)];

      statusEl.textContent = 'Makeup photo applied (lips + eyes + brows + blush).';
    } catch (e) {
      console.error(e);
      statusEl.textContent = `Photo failed: ${String(e)}`;
    } finally {
      fileInput.value = '';
    }
  });

  function frame() {
    resizeCanvases();
    gl.viewport(0, 0, glCanvas.width, glCanvas.height);

    // Upload latest webcam frame to the texture.
    const canUploadVideo = sourceKind === 'camera' && video.readyState >= 2;
    const canUploadMJPEG = sourceKind === 'mjpeg' && mjpegImg.complete && mjpegImg.naturalWidth > 0;
    if (canUploadVideo || canUploadMJPEG) {
      gl.bindTexture(gl.TEXTURE_2D, videoTex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGB,
        gl.RGB,
        gl.UNSIGNED_BYTE,
        canUploadVideo ? video : mjpegImg,
      );
    }

    // 1) Draw webcam quad
    gl.disable(gl.BLEND);
    gl.useProgram(quadProgram);
    gl.bindVertexArray(quadVAO);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    // 2) Update landmarks (throttled)
    const now = performance.now();
    const doLandmarks = now - lastLipsUpdate > 40; // ~25Hz
    const srcReady = canUploadVideo || canUploadMJPEG;
    const srcEl = canUploadVideo ? video : mjpegImg;
    if (doLandmarks && srcReady) {
      // detectForVideo accepts ImageSource types; for MJPEG we still provide a timestamp.
      const res = landmarkerVideo.detectForVideo(srcEl as unknown as HTMLVideoElement, now);
      const face = res.faceLandmarks?.[0];
      if (face && face.length) {
        const pts = face.map((p) => ({ x: p.x, y: p.y }));
        drawDebugPoints(pts);

        // Build both normal and slightly-expanded fans for feathered edges.
        // (Draw expanded low-alpha under the normal fill.)
        regionVerts.LIP_UPPER = buildFan(FaceRegions.LIP_UPPER.map((idx) => pts[idx]).filter(Boolean));
        regionVerts.LIP_LOWER = buildFan(FaceRegions.LIP_LOWER.map((idx) => pts[idx]).filter(Boolean));
        regionVerts.LIP_UPPER_FEATHER = buildFan(
          FaceRegions.LIP_UPPER.map((idx) => pts[idx]).filter(Boolean),
          0.06,
        );
        regionVerts.LIP_LOWER_FEATHER = buildFan(
          FaceRegions.LIP_LOWER.map((idx) => pts[idx]).filter(Boolean),
          0.06,
        );

        // Better lip mask: outer lips minus inner mouth opening.
        const lipOuterIdx = uniqueConcat(
          [...FaceRegions.LIP_UPPER],
          [...FaceRegions.LIP_LOWER],
        );
        const lipOuterPts = lipOuterIdx.map((idx) => pts[idx]).filter(Boolean);
        regionVerts.LIP_OUTER = buildFan(lipOuterPts, 0);
        regionVerts.LIP_OUTER_FEATHER = buildFan(lipOuterPts, 0.06);
        regionVerts.MOUTH_INNER = buildFan(
          FaceRegions.MOUTH_INNER.map((idx) => pts[idx]).filter(Boolean),
          0,
        );

        // Eyeshadow: draw as a thick upper-lid ribbon (one continuous piece, avoids polygon self-intersections)
        // This also naturally avoids painting the eyeball, so we don't need stencil cutouts.
        const shadowLeft = FaceRegions.EYELID_UPPER_LEFT.map((idx) => pts[idx]).filter(Boolean);
        const shadowRightRaw = FaceRegions.EYELID_UPPER_RIGHT.map((idx) => pts[idx]).filter(Boolean);
        const shadowRight =
          shadowRightRaw.length >= 2 && shadowRightRaw[0].x < shadowRightRaw[shadowRightRaw.length - 1].x
            ? [...shadowRightRaw].reverse()
            : shadowRightRaw;

        regionVerts.SHADOW_LEFT_RIBBON = buildRibbon(shadowLeft, 0.014);
        regionVerts.SHADOW_RIGHT_RIBBON = buildRibbon(shadowRight, 0.014);
        regionVerts.SHADOW_LEFT_RIBBON_FEATHER = buildRibbon(shadowLeft, 0.020);
        regionVerts.SHADOW_RIGHT_RIBBON_FEATHER = buildRibbon(shadowRight, 0.020);

        regionVerts.EYELINER_LEFT = buildFan(
          FaceRegions.EYELINER_LEFT.map((idx) => pts[idx]).filter(Boolean),
        );
        regionVerts.EYELINER_RIGHT = buildFan(
          FaceRegions.EYELINER_RIGHT.map((idx) => pts[idx]).filter(Boolean),
        );

        regionVerts.EYEBROW_LEFT = buildFan(
          FaceRegions.EYEBROW_LEFT.map((idx) => pts[idx]).filter(Boolean),
        );
        regionVerts.EYEBROW_RIGHT = buildFan(
          FaceRegions.EYEBROW_RIGHT.map((idx) => pts[idx]).filter(Boolean),
        );

        // Eyebrows: use a ribbon stroke instead of a filled polygon (prevents blob/bleed)
        const browLeftPts = FaceRegions.EYEBROW_LEFT.map((idx) => pts[idx]).filter(Boolean);
        const browRightPts = FaceRegions.EYEBROW_RIGHT.map((idx) => pts[idx]).filter(Boolean);
        // Thinner, tapered brow strokes to avoid "blobby" spill outside the brow line.
        regionVerts.BROW_LEFT_RIBBON = buildRibbon(browLeftPts, 0.0042, true);
        regionVerts.BROW_RIGHT_RIBBON = buildRibbon(browRightPts, 0.0042, true);
        regionVerts.BROW_LEFT_RIBBON_FEATHER = buildRibbon(browLeftPts, 0.0065, true);
        regionVerts.BROW_RIGHT_RIBBON_FEATHER = buildRibbon(browRightPts, 0.0065, true);

        // Eyeliner: thin upper-lid ribbon + small wing at outer corner.
        // Only draw outer part of the upper lid (avoid heavy inner-corner liner).
        const lidLeftFull = FaceRegions.EYELID_UPPER_LEFT.map((idx) => pts[idx]).filter(Boolean);
        // Ensure the first point is the OUTER corner for the right eye (some lists are ordered inner->outer).
        const lidRightFullRaw = FaceRegions.EYELID_UPPER_RIGHT.map((idx) => pts[idx]).filter(Boolean);
        const lidRightFull =
          lidRightFullRaw.length >= 2 && lidRightFullRaw[0].x < lidRightFullRaw[lidRightFullRaw.length - 1].x
            ? [...lidRightFullRaw].reverse()
            : lidRightFullRaw;

        const lidLeft = lidLeftFull.slice(0, Math.min(5, lidLeftFull.length));
        const lidRight = lidRightFull.slice(0, Math.min(5, lidRightFull.length));
        // Smaller wing length for a subtle cat-eye.
        regionVerts.LINER_LEFT_RIBBON = buildWingedRibbon(lidLeft, 0.0032, 'left', 0.012);
        regionVerts.LINER_RIGHT_RIBBON = buildWingedRibbon(lidRight, 0.0032, 'right', 0.012);
        regionVerts.LINER_LEFT_RIBBON_FEATHER = buildWingedRibbon(lidLeft, 0.0052, 'left', 0.014);
        regionVerts.LINER_RIGHT_RIBBON_FEATHER = buildWingedRibbon(lidRight, 0.0052, 'right', 0.014);

        // Blush regions from nearby-landmark hulls (more natural than ovals)
        const leftBlush = buildBlushRegion(pts, FacePoints.BLUSH_LEFT, 'left');
        const rightBlush = buildBlushRegion(pts, FacePoints.BLUSH_RIGHT, 'right');
        regionVerts.BLUSH_LEFT = leftBlush.fill;
        regionVerts.BLUSH_RIGHT = rightBlush.fill;
        regionVerts.BLUSH_LEFT_FEATHER = leftBlush.feather;
        regionVerts.BLUSH_RIGHT_FEATHER = rightBlush.feather;

        // Nose contour: take ridge points and offset left/right into side shadows.
        const ridge = FaceRegions.NOSE_RIDGE.map((idx) => pts[idx]).filter(Boolean);
        const noseLeft = offsetPts(ridge, -0.018);
        const noseRight = offsetPts(ridge, 0.018);
        regionVerts.NOSE_LEFT_RIBBON = buildRibbon(noseLeft, 0.006, true);
        regionVerts.NOSE_RIGHT_RIBBON = buildRibbon(noseRight, 0.006, true);
        regionVerts.NOSE_LEFT_RIBBON_FEATHER = buildRibbon(noseLeft, 0.010, true);
        regionVerts.NOSE_RIGHT_RIBBON_FEATHER = buildRibbon(noseRight, 0.010, true);

        // Nose tip "button nose" highlight/contour (small soft patch)
        const tip = pts[FacePoints.NOSE_TIP];
        if (tip) {
          const tipCircle = makeCircle(tip, 0.022, 22);
          regionVerts.NOSE_TIP = buildFan(tipCircle, 0, true);
          regionVerts.NOSE_TIP_FEATHER = buildFan(tipCircle, 0.25, true);
        }

        lastLipsUpdate = now;
      }
    }

    // 3) Draw makeup polygons (GPU)
    const drawRegion = (
      verts: Float32Array | undefined,
      rgbTop: [number, number, number],
      rgbBottom: [number, number, number],
      alpha: number,
      yMinMax?: { yMin: number; yMax: number },
    ) => {
      if (!verts || verts.length === 0 || alpha <= 0) return;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(polyProgram);
      gl.bindVertexArray(polyVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, polyBuf);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(polyPosLoc);
      gl.vertexAttribPointer(polyPosLoc, 2, gl.FLOAT, false, 0, 0);
      gl.uniform4f(polyColorTopLoc, rgbTop[0], rgbTop[1], rgbTop[2], clamp01(alpha));
      gl.uniform4f(polyColorBottomLoc, rgbBottom[0], rgbBottom[1], rgbBottom[2], clamp01(alpha));
      const mm = yMinMax ?? clipYMinMax(verts);
      gl.uniform2f(polyYMinMaxLoc, mm.yMin, mm.yMax);
      gl.drawArrays(gl.TRIANGLES, 0, verts.length / 2);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    };

    const lipA = clamp01(Number(lipIntensityEl.value) / 100);
    const shadowA = clamp01(Number(eyeShadowIntensityEl.value) / 100);
    const linerA = clamp01(Number(eyeLinerIntensityEl.value) / 100);
    const browA = clamp01(Number(browIntensityEl.value) / 100);
    const blushA = clamp01(Number(blushIntensityEl.value) / 100);
    const noseA = clamp01(Number(noseIntensityEl.value) / 100);

    // Lips with mouth hole (stencil): draw only on lips, not teeth/mouth interior.
    if (lipA > 0 && regionVerts.LIP_OUTER && regionVerts.MOUTH_INNER) {
      const lipMM = clipYMinMax(regionVerts.LIP_OUTER);
      // 1) Build stencil = 1 for outer lips
      gl.enable(gl.STENCIL_TEST);
      gl.clearStencil(0);
      gl.clear(gl.STENCIL_BUFFER_BIT);
      gl.stencilMask(0xff);
      gl.stencilFunc(gl.ALWAYS, 1, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      gl.colorMask(false, false, false, false);
      drawRegion(regionVerts.LIP_OUTER, [0, 0, 0], [0, 0, 0], 1, lipMM);

      // 2) Carve out inner mouth: set stencil back to 0
      gl.stencilFunc(gl.ALWAYS, 0, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      drawRegion(regionVerts.MOUTH_INNER, [0, 0, 0], [0, 0, 0], 1, lipMM);

      // 3) Render lipstick only where stencil==1
      gl.colorMask(true, true, true, true);
      gl.stencilFunc(gl.EQUAL, 1, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

      drawRegion(regionVerts.LIP_OUTER_FEATHER, lipstickTopRGB, lipstickBottomRGB, lipA * 0.35, lipMM);
      drawRegion(regionVerts.LIP_OUTER, lipstickTopRGB, lipstickBottomRGB, lipA, lipMM);

      gl.disable(gl.STENCIL_TEST);
    }

    // Eyeshadow (upper-lid ribbon + feather)
    drawRegion(regionVerts.SHADOW_LEFT_RIBBON_FEATHER, eyeShadowRGB, eyeShadowRGB, shadowA * 0.20);
    drawRegion(regionVerts.SHADOW_RIGHT_RIBBON_FEATHER, eyeShadowRGB, eyeShadowRGB, shadowA * 0.20);
    drawRegion(regionVerts.SHADOW_LEFT_RIBBON, eyeShadowRGB, eyeShadowRGB, shadowA * 0.80);
    drawRegion(regionVerts.SHADOW_RIGHT_RIBBON, eyeShadowRGB, eyeShadowRGB, shadowA * 0.80);

    // Eyeliner (upper lid + wing)
    drawRegion(regionVerts.LINER_LEFT_RIBBON_FEATHER, eyeLinerRGB, eyeLinerRGB, linerA * 0.22);
    drawRegion(regionVerts.LINER_RIGHT_RIBBON_FEATHER, eyeLinerRGB, eyeLinerRGB, linerA * 0.22);
    drawRegion(regionVerts.LINER_LEFT_RIBBON, eyeLinerRGB, eyeLinerRGB, linerA * 0.85);
    drawRegion(regionVerts.LINER_RIGHT_RIBBON, eyeLinerRGB, eyeLinerRGB, linerA * 0.85);

    // Brows (ribbon + feather). This hugs real eyebrow shape better.
    drawRegion(regionVerts.BROW_LEFT_RIBBON_FEATHER, browRGB, browRGB, browA * 0.12);
    drawRegion(regionVerts.BROW_RIGHT_RIBBON_FEATHER, browRGB, browRGB, browA * 0.12);
    drawRegion(regionVerts.BROW_LEFT_RIBBON, browRGB, browRGB, browA * 0.55);
    drawRegion(regionVerts.BROW_RIGHT_RIBBON, browRGB, browRGB, browA * 0.55);

    // Blush (feather then fill), using cheek-shaped polygons
    if (blushA > 0) {
      drawRegion(regionVerts.BLUSH_LEFT_FEATHER, blushRGB, blushRGB, blushA * 0.22);
      drawRegion(regionVerts.BLUSH_RIGHT_FEATHER, blushRGB, blushRGB, blushA * 0.22);
      drawRegion(regionVerts.BLUSH_LEFT, blushRGB, blushRGB, blushA * 0.45);
      drawRegion(regionVerts.BLUSH_RIGHT, blushRGB, blushRGB, blushA * 0.45);
    }

    // Nose contour (very subtle, should not look like stripes)
    if (noseA > 0) {
      const contourRGB: [number, number, number] = [0.12, 0.08, 0.06]; // warm shadow
      drawRegion(regionVerts.NOSE_LEFT_RIBBON_FEATHER, contourRGB, contourRGB, noseA * 0.10);
      drawRegion(regionVerts.NOSE_RIGHT_RIBBON_FEATHER, contourRGB, contourRGB, noseA * 0.10);
      drawRegion(regionVerts.NOSE_LEFT_RIBBON, contourRGB, contourRGB, noseA * 0.20);
      drawRegion(regionVerts.NOSE_RIGHT_RIBBON, contourRGB, contourRGB, noseA * 0.20);

      // Button-nose tip: subtle rosy highlight (common "cute" effect)
      const tipRGB: [number, number, number] = [0.95, 0.55, 0.70];
      drawRegion(regionVerts.NOSE_TIP_FEATHER, tipRGB, tipRGB, noseA * 0.08);
      drawRegion(regionVerts.NOSE_TIP, tipRGB, tipRGB, noseA * 0.14);
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch((e) => {
  console.error(e);
  statusEl.textContent = `Error: ${String(e)}`;
});
