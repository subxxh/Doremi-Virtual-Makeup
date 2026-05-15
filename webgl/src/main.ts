import './style.css';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { FacePoints, FaceRegions } from './regions';
import { clamp01, type Vec2 } from './utils';
import {
  DEFAULT_BLUSH_HEX,
  makeupColors,
  NOSE_TIP_RGB,
  concealerColorFromSkin,
  pinkifyBlush,
  sampleLiveSkinTone,
  sampleMeanColorFromEllipse,
  sampleMeanColorFromPointHull,
  sampleMeanColorFromPolygon,
} from './colors';
import {
  buildBlushRegion,
  buildFan,
  buildRibbon,
  buildShadowRibbon,
  buildUnderEyeRegion,
  buildWingedRibbon,
  makeCircle,
  offsetPts,
  uniqueConcat,
} from './geometry';
import { BlendMode, createMakeupRenderer } from './webgl';
import { initCustomizePanel } from './customize';
import { initSavedLooksPanel } from './savedLooks';
import { initAiColorAnalysis, type AiLookVibe } from './aiColorAnalysis';
import { initObsGuide } from './obsGuide';

// =============================================================================
// HUD bootstrap. Everything in this section runs once at startup to put the
// initial DOM in place (#gl, #overlay, sliders, status text, upload button)
// before any module that queries those elements runs.
// =============================================================================

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app not found');

type SliderDef = {
  id: string;
  label: string;
  color: string;
  value: number;
};

const sliderDefs: SliderDef[] = [
  { id: 'lipIntensity', label: 'Lips', color: '#D4547A', value: 30 },
  { id: 'concealerIntensity', label: 'Concealer', color: '#E2BB95', value: 24 },
  { id: 'eyeShadowIntensity', label: 'Eyeshadow', color: '#A06CC3', value: 36 },
  { id: 'eyeLinerIntensity', label: 'Eyeliner', color: '#5E3B7A', value: 26 },
  { id: 'browIntensity', label: 'Brows', color: '#8B5A3C', value: 14 },
  { id: 'blushIntensity', label: 'Blush', color: DEFAULT_BLUSH_HEX, value: 28 },
  { id: 'noseIntensity', label: 'Nose', color: '#B08572', value: 20 },
];

const sliderRowsHTML = sliderDefs
  .map(
    (s) => `
      <div class="slider-row" style="--c:${s.color}">
        <span class="dot"></span>
        <span class="lbl">${s.label}</span>
        <div class="track">
          <div class="fill" data-fill="${s.id}" style="width:${s.value}%"></div>
          <input id="${s.id}" type="range" min="0" max="100" step="1" value="${s.value}" />
        </div>
        <span class="val" data-val="${s.id}">${s.value}%</span>
      </div>
    `,
  )
  .join('');

app.innerHTML = `
  <div class="stage">
    <canvas id="gl"></canvas>
    <canvas id="overlay"></canvas>
    <div class="hud">
      <div class="hud-title">Doremi Virtual Makeup</div>
      <div class="hud-hint"><kbd>D</kbd> toggles landmark dots &nbsp;·&nbsp; <kbd>H</kbd> hides panels</div>
      <div class="hud-actions">
        <button id="uploadBtn" type="button">Upload makeup photo</button>
        <input id="fileInput" type="file" accept="image/*" />
        <button type="button" class="hud-btn-secondary" id="aiColorReadTrigger">AI color read</button>
        <button type="button" class="hud-btn-secondary" id="obsGuideBtn">Use in Zoom</button>
      </div>
      <div class="sliders">${sliderRowsHTML}</div>
      <label class="no-makeup-row">
        <input type="checkbox" id="noMakeupToggle" />
        <span>No makeup</span>
      </label>
      <div class="hud-status" id="status">Loading…</div>
    </div>
  </div>
`;

for (const s of sliderDefs) {
  const input = document.querySelector<HTMLInputElement>(`#${s.id}`);
  const fill = document.querySelector<HTMLDivElement>(`[data-fill="${s.id}"]`);
  const val = document.querySelector<HTMLSpanElement>(`[data-val="${s.id}"]`);
  if (!input || !fill || !val) continue;
  const sync = () => {
    fill.style.width = `${input.value}%`;
    val.textContent = `${input.value}%`;
  };
  input.addEventListener('input', sync);
  sync();
}

let noMakeupSliderSnapshot: Record<string, number> | null = null;

function setSliderPercentsFromRecord(pctById: Record<string, number>) {
  for (const [id, pct] of Object.entries(pctById)) {
    const el = document.querySelector<HTMLInputElement>(`#${id}`);
    if (!el) continue;
    el.value = String(pct);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** Turn off “No makeup” and restore saved slider values (used before other presets apply). */
function exitNoMakeupIfNeeded() {
  const t = document.querySelector<HTMLInputElement>('#noMakeupToggle');
  if (!t?.checked) return;
  if (noMakeupSliderSnapshot) {
    setSliderPercentsFromRecord(noMakeupSliderSnapshot);
    noMakeupSliderSnapshot = null;
  }
  t.checked = false;
  document.querySelector('.hud .sliders')?.classList.remove('sliders--no-makeup');
  for (const s of sliderDefs) {
    const el = document.querySelector<HTMLInputElement>(`#${s.id}`);
    if (el) el.disabled = false;
  }
}

document.querySelector<HTMLInputElement>('#noMakeupToggle')?.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  const slidersEl = document.querySelector('.hud .sliders');
  if (t.checked) {
    const snap: Record<string, number> = {};
    for (const s of sliderDefs) {
      const el = document.querySelector<HTMLInputElement>(`#${s.id}`);
      if (el) snap[s.id] = Number(el.value);
    }
    noMakeupSliderSnapshot = snap;
    for (const s of sliderDefs) {
      const el = document.querySelector<HTMLInputElement>(`#${s.id}`);
      if (!el) continue;
      el.value = '0';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.disabled = true;
    }
    slidersEl?.classList.add('sliders--no-makeup');
  } else {
    if (noMakeupSliderSnapshot) {
      setSliderPercentsFromRecord(noMakeupSliderSnapshot);
      noMakeupSliderSnapshot = null;
    }
    for (const s of sliderDefs) {
      const el = document.querySelector<HTMLInputElement>(`#${s.id}`);
      if (el) el.disabled = false;
    }
    slidersEl?.classList.remove('sliders--no-makeup');
  }
});

const glCanvas = document.querySelector<HTMLCanvasElement>('#gl')!;
const overlayCanvas = document.querySelector<HTMLCanvasElement>('#overlay')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const uploadBtn = document.querySelector<HTMLButtonElement>('#uploadBtn')!;
const fileInput = document.querySelector<HTMLInputElement>('#fileInput')!;
const lipIntensityEl = document.querySelector<HTMLInputElement>('#lipIntensity')!;
const concealerIntensityEl = document.querySelector<HTMLInputElement>('#concealerIntensity')!;
const eyeShadowIntensityEl = document.querySelector<HTMLInputElement>('#eyeShadowIntensity')!;
const eyeLinerIntensityEl = document.querySelector<HTMLInputElement>('#eyeLinerIntensity')!;
const browIntensityEl = document.querySelector<HTMLInputElement>('#browIntensity')!;
const blushIntensityEl = document.querySelector<HTMLInputElement>('#blushIntensity')!;
const noseIntensityEl = document.querySelector<HTMLInputElement>('#noseIntensity')!;

// Initialize the WebGL renderer + customize panel now that all DOM exists.
const renderer = createMakeupRenderer(glCanvas);
initCustomizePanel();
initObsGuide();
initSavedLooksPanel({
  makeupColors,
  sliderIds: sliderDefs.map((s) => s.id),
  statusEl,
  beforeRestoreLook: exitNoMakeupIfNeeded,
});

// =============================================================================
// Canvas sizing + debug overlay.
// =============================================================================

let showDebug = false;
let showSidePanels = true;
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'd') showDebug = !showDebug;

  if (e.key.toLowerCase() === 'h') {
    showSidePanels = !showSidePanels;
    const hud = document.querySelector<HTMLElement>('.hud');
    const customizeBtn = document.querySelector<HTMLElement>('#customizeBtn');
    const customizePanel = document.querySelector<HTMLElement>('#customizePanel');
    const savedLooksBtn = document.querySelector<HTMLElement>('.saved-looks-btn');
    const savedLooksPanel = document.querySelector<HTMLElement>('.saved-looks-panel');
    for (const el of [hud, customizeBtn, savedLooksBtn]) {
      if (el) el.style.visibility = showSidePanels ? '' : 'hidden';
    }
    if (!showSidePanels) {
      if (customizePanel) customizePanel.hidden = true;
      if (savedLooksPanel) savedLooksPanel.hidden = true;
    }
  }
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
let lastPointsForDebug: Vec2[] | null = null;

function paintOverlay() {
  const w = overlayCanvas.width;
  const h = overlayCanvas.height;
  overlay2d.clearRect(0, 0, w, h);

  if (showDebug && lastPointsForDebug?.length) {
    const fontPx = Math.max(9, Math.min(14, Math.floor(w * 0.011)));
    overlay2d.font = `${fontPx}px ui-monospace, Menlo, monospace`;
    overlay2d.textAlign = 'left';
    overlay2d.textBaseline = 'middle';
    for (let i = 0; i < lastPointsForDebug.length; i++) {
      const p = lastPointsForDebug[i];
      const x = (1 - p.x) * w;
      const y = p.y * h;
      overlay2d.fillStyle = 'rgba(0, 255, 255, 0.85)';
      overlay2d.beginPath();
      overlay2d.arc(x, y, 2.2, 0, Math.PI * 2);
      overlay2d.fill();
      const label = String(i);
      const tx = x + 4;
      const ty = y;
      overlay2d.lineWidth = Math.max(2, fontPx * 0.2);
      overlay2d.strokeStyle = 'rgba(0, 0, 0, 0.92)';
      overlay2d.strokeText(label, tx, ty);
      overlay2d.fillStyle = 'rgba(255, 255, 220, 0.95)';
      overlay2d.fillText(label, tx, ty);
    }
  }
}

// =============================================================================
// Webcam + face landmarker.
// =============================================================================

const video = document.createElement('video');
video.playsInline = true;
video.muted = true;
video.autoplay = true;
video.style.display = 'none';
document.body.appendChild(video);

/** After “Apply to try-on” from an AI color read, nudge intensities. Natural = stronger; glam/fun = softer (bold colors read loud). */
function applyPostAiLookSliderPreset(lookVibe: AiLookVibe | null) {
  exitNoMakeupIfNeeded();
  const boldOrFun = lookVibe === 'glam' || lookVibe === 'fun';
  const preset: Record<string, number> = boldOrFun
    ? {
        lipIntensity: 22,
        eyeShadowIntensity: 30,
        eyeLinerIntensity: 36,
        blushIntensity: 25,
      }
    : {
        lipIntensity: 60,
        concealerIntensity: 35,
        eyeShadowIntensity: 75,
        eyeLinerIntensity: 37,
        blushIntensity: 68,
        noseIntensity: 24,
      };
  for (const [id, pct] of Object.entries(preset)) {
    const el = document.querySelector<HTMLInputElement>(`#${id}`);
    if (!el) continue;
    el.value = String(pct);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

initAiColorAnalysis({ video, statusEl, onAfterApplyLook: applyPostAiLookSliderPreset });

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

type LandmarkerMode = 'VIDEO' | 'IMAGE';

async function createLandmarker(mode: LandmarkerMode) {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm',
  );
  return FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
    },
    runningMode: mode,
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  });
}

// =============================================================================
// Per-region look tunables. blurStrength is in mask-texels of the 9-tap separable kernel
// (taps at 1..4 × strength), so effective radius ≈ 4 × strength mask-px. At half-res
// that's ~0.6 × strength % of canvas height. Intensity caps below 1.0 keep a sliver of
// skin showing through so makeup reads as pigment, not vinyl.
// =============================================================================

// Lips: HSL color + small multiply, narrow specular band so only truly blown-out gloss highlights
// lose pigment. LIP_LUMA_LIFT pulls the transferred luminance toward a brighter midpoint so dark
// lips don't drag pinks/reds into a grey-brown look at high pigment.
const LIP_BLUR_STRENGTH = 1.4;
const LIP_MULTIPLY_MIX = 0.14;
const LIP_LUMA_LIFT = 0.32;
const LIP_SPEC = [0.88, 0.99] as const;
const LIP_INTENSITY_MAX = 0.85;

// Eyeshadow: HSL color with a chunkier multiply mix for richer pigment, large soft blur.
const SHADOW_BLUR_STRENGTH = 2.4;
const SHADOW_MULTIPLY_MIX = 0.40;
const SHADOW_SPEC = [0.85, 0.99] as const;
const SHADOW_INTENSITY_MAX = 0.65;

// Eyeliner: multiply with the eyeliner color, sharp blur, near-opaque cap so dark liner stays dark.
const LINER_BLUR_STRENGTH = 0.7;
const LINER_SPEC = [0.92, 1.00] as const;
const LINER_INTENSITY_MAX = 0.95;

// Brows: multiply, small blur — fills in sparse hair without painting over the brow shape.
const BROW_BLUR_STRENGTH = 0.9;
const BROW_SPEC = [0.92, 1.00] as const;
const BROW_INTENSITY_MAX = 0.55;

// Blush: soft-light, large diffuse blur — that classic "brushed onto cheekbone" glow.
const BLUSH_BLUR_STRENGTH = 3.6;
const BLUSH_SPEC = [0.88, 0.99] as const;
const BLUSH_INTENSITY_MAX = 0.85;

// Nose contour: multiply with a warm desaturated brown -> soft side shadow on the nose.
// Multiplied with skin (~0.7) the result darkens by ~30%, giving a believable shadow without going grey.
const NOSE_CONTOUR_BLUR_STRENGTH = 2.4;
const NOSE_CONTOUR_SPEC = [0.90, 1.00] as const;
const NOSE_CONTOUR_INTENSITY_MAX = 0.45;

// Nose tip highlight: screen-blend a soft pink — lifts the tip without flattening it.
const NOSE_TIP_BLUR_STRENGTH = 3.0;
const NOSE_TIP_SPEC = [0.95, 1.00] as const;
const NOSE_TIP_INTENSITY_MAX = 0.45;

// Concealer: soft-light blend with the user's live skin tone (lifted slightly toward warm pale).
// Soft-light preserves the under-eye texture while quietly evening out dark circles. Big blur
// keeps the edge invisible — concealer should never have a hard outline.
const CONCEALER_BLUR_STRENGTH = 3.2;
const CONCEALER_SPEC = [0.92, 1.00] as const;
const CONCEALER_INTENSITY_MAX = 0.7;

// =============================================================================
// Per-frame region polygon storage. Each entry is a Float32Array of clip-space
// triangle vertices, recomputed when landmarks update.
// =============================================================================

type RegionVertsKey =
  | 'LIP_OUTER'
  | 'MOUTH_INNER'
  | 'SHADOW_LEFT_RIBBON'
  | 'SHADOW_RIGHT_RIBBON'
  | 'EYE_LEFT_MASK'
  | 'EYE_RIGHT_MASK'
  | 'LINER_LEFT_RIBBON'
  | 'LINER_RIGHT_RIBBON'
  | 'BROW_LEFT_RIBBON'
  | 'BROW_RIGHT_RIBBON'
  | 'BLUSH_LEFT'
  | 'BLUSH_RIGHT'
  | 'NOSE_LEFT_RIBBON'
  | 'NOSE_RIGHT_RIBBON'
  | 'NOSE_TIP'
  | 'UNDER_EYE_LEFT'
  | 'UNDER_EYE_RIGHT';
type RegionVerts = Partial<Record<RegionVertsKey, Float32Array>>;
const regionVerts: RegionVerts = {};

// =============================================================================
// Main: kick off the camera, build landmarkers, wire the photo upload, and start
// the render loop.
// =============================================================================

async function main() {
  statusEl.textContent = 'Requesting camera…';
  await startCamera();

  statusEl.textContent = 'Loading face model…';
  const [landmarkerVideo, landmarkerImage] = await Promise.all([
    createLandmarker('VIDEO'),
    createLandmarker('IMAGE'),
  ]);

  statusEl.textContent = 'Running (WebGL + Face Landmarks)…';

  let lastLipsUpdate = 0;

  // -------------------------------------------------------------------------
  // Photo upload: detect a face in the image, sample makeup colors out of it,
  // write into `makeupColors`, and bump sliders to a flattering preset.
  // -------------------------------------------------------------------------
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
      if (lipTop)
        makeupColors.lipstickTop = [clamp01(lipTop.r / 255), clamp01(lipTop.g / 255), clamp01(lipTop.b / 255)];
      if (lipBottom)
        makeupColors.lipstickBottom = [
          clamp01(lipBottom.r / 255),
          clamp01(lipBottom.g / 255),
          clamp01(lipBottom.b / 255),
        ];

      const creaseL = FaceRegions.EYELID_CREASE_LEFT.map((i) => pts[i]).filter(Boolean) as Vec2[];
      const creaseR = FaceRegions.EYELID_CREASE_RIGHT.map((i) => pts[i]).filter(Boolean) as Vec2[];
      const lashL = FaceRegions.EYELID_LASH_LEFT.map((i) => pts[i]).filter(Boolean) as Vec2[];
      const lashR = FaceRegions.EYELID_LASH_RIGHT.map((i) => pts[i]).filter(Boolean) as Vec2[];
      const shadowCrease = mean2(
        sampleMeanColorFromPointHull(ctx, creaseL, bmp.width, bmp.height),
        sampleMeanColorFromPointHull(ctx, creaseR, bmp.width, bmp.height),
      );
      const shadowLash = mean2(
        sampleMeanColorFromPointHull(ctx, lashL, bmp.width, bmp.height),
        sampleMeanColorFromPointHull(ctx, lashR, bmp.width, bmp.height),
      );
      if (shadowCrease)
        makeupColors.eyeShadowCrease = [
          clamp01(shadowCrease.r / 255),
          clamp01(shadowCrease.g / 255),
          clamp01(shadowCrease.b / 255),
        ];
      if (shadowLash)
        makeupColors.eyeShadowLash = [
          clamp01(shadowLash.r / 255),
          clamp01(shadowLash.g / 255),
          clamp01(shadowLash.b / 255),
        ];
      if (shadowCrease && !shadowLash) makeupColors.eyeShadowLash = [...makeupColors.eyeShadowCrease];
      if (!shadowCrease && shadowLash) makeupColors.eyeShadowCrease = [...makeupColors.eyeShadowLash];

      const linerC = mean2(
        sampleMeanColorFromPolygon(ctx, toPxPoly(FaceRegions.EYELINER_LEFT)),
        sampleMeanColorFromPolygon(ctx, toPxPoly(FaceRegions.EYELINER_RIGHT)),
      );
      if (linerC)
        makeupColors.eyeLiner = [clamp01(linerC.r / 255), clamp01(linerC.g / 255), clamp01(linerC.b / 255)];

      const browC = mean2(
        sampleMeanColorFromPolygon(ctx, toPxPoly(FaceRegions.EYEBROW_LEFT)),
        sampleMeanColorFromPolygon(ctx, toPxPoly(FaceRegions.EYEBROW_RIGHT)),
      );
      if (browC)
        makeupColors.brow = [clamp01(browC.r / 255), clamp01(browC.g / 255), clamp01(browC.b / 255)];

      const blushL = pts[FacePoints.BLUSH_LEFT];
      const blushR = pts[FacePoints.BLUSH_RIGHT];
      // Use a small ellipse for sampling color (shape on the face is handled by a polygon).
      const blushC = mean2(
        blushL ? sampleMeanColorFromEllipse(ctx, blushL.x * bmp.width, blushL.y * bmp.height, 18, 12) : null,
        blushR ? sampleMeanColorFromEllipse(ctx, blushR.x * bmp.width, blushR.y * bmp.height, 18, 12) : null,
      );
      if (blushC) {
        const sampled: [number, number, number] = [
          clamp01(blushC.r / 255),
          clamp01(blushC.g / 255),
          clamp01(blushC.b / 255),
        ];
        makeupColors.blush = pinkifyBlush(sampled);
      }

      exitNoMakeupIfNeeded();

      // Photo-sampled colors render fairly subtly at the default slider values, so on a fresh
      // upload bump each slider to a known-flattering preset. We dispatch 'input' so the existing
      // sync handler updates the fill width and the % label too. Brows are left untouched.
      const photoPresets: ReadonlyArray<[HTMLInputElement, number]> = [
        [lipIntensityEl, 41],
        [concealerIntensityEl, 36],
        [eyeShadowIntensityEl, 72],
        [eyeLinerIntensityEl, 41],
        [blushIntensityEl, 56],
        [noseIntensityEl, 25],
      ];
      for (const [input, value] of photoPresets) {
        input.value = String(value);
        input.dispatchEvent(new Event('input'));
      }

      statusEl.textContent = 'Makeup photo applied.';
    } catch (e) {
      console.error(e);
      statusEl.textContent = `Photo failed: ${String(e)}`;
    } finally {
      fileInput.value = '';
    }
  });

  // -------------------------------------------------------------------------
  // Render loop.
  // -------------------------------------------------------------------------
  function frame() {
    resizeCanvases();
    renderer.syncMaskFbosToCanvas();

    // 1) Upload latest webcam frame + draw it as the background quad.
    const videoReady = video.readyState >= 2;
    if (videoReady) renderer.uploadVideoFrame(video);
    renderer.drawVideoQuad();

    // 2) Update landmarks (throttled to ~25Hz).
    const now = performance.now();
    const doLandmarks = now - lastLipsUpdate > 40;
    if (doLandmarks && videoReady) {
      const res = landmarkerVideo.detectForVideo(video, now);
      const face = res.faceLandmarks?.[0];
      if (face && face.length) {
        const pts = face.map((p) => ({ x: p.x, y: p.y }));
        lastPointsForDebug = pts;

        // Lip mask = outer lips minus inner mouth opening (so lipstick doesn't paint on teeth).
        const lipOuterIdx = uniqueConcat(
          [...FaceRegions.LIP_UPPER],
          [...FaceRegions.LIP_LOWER],
        );
        const lipOuterPts = lipOuterIdx.map((idx) => pts[idx]).filter(Boolean);
        regionVerts.LIP_OUTER = buildFan(lipOuterPts);
        regionVerts.MOUTH_INNER = buildFan(
          FaceRegions.MOUTH_INNER.map((idx) => pts[idx]).filter(Boolean),
        );

        // Eyeshadow: crease -> lash strip per eye. Eye-ball masks subtract from the
        // mask so shadow doesn't bleed onto the eyeball.
        regionVerts.SHADOW_LEFT_RIBBON = buildShadowRibbon(
          pts, FaceRegions.EYELID_CREASE_LEFT, FaceRegions.EYELID_LASH_LEFT,
        );
        regionVerts.SHADOW_RIGHT_RIBBON = buildShadowRibbon(
          pts, FaceRegions.EYELID_CREASE_RIGHT, FaceRegions.EYELID_LASH_RIGHT,
        );
        regionVerts.EYE_LEFT_MASK = buildFan(FaceRegions.LEFT_EYE.map((idx) => pts[idx]).filter(Boolean));
        regionVerts.EYE_RIGHT_MASK = buildFan(FaceRegions.RIGHT_EYE.map((idx) => pts[idx]).filter(Boolean));

        // Brows: thin tapered ribbon along the upper-brow points.
        regionVerts.BROW_LEFT_RIBBON = buildRibbon(
          FaceRegions.EYEBROW_LEFT.map((idx) => pts[idx]).filter(Boolean), 0.0042, true,
        );
        regionVerts.BROW_RIGHT_RIBBON = buildRibbon(
          FaceRegions.EYEBROW_RIGHT.map((idx) => pts[idx]).filter(Boolean), 0.0042, true,
        );

        // Eyeliner: thin upper-lid ribbon + small wing. Right lid polyline is inner -> outer in
        // index order, so reverse for the liner only (winged-ribbon code expects the outer corner first).
        const lidLeftFull = FaceRegions.EYELID_UPPER_LEFT.map((idx) => pts[idx]).filter(Boolean);
        const lidRightFull = FaceRegions.EYELID_UPPER_RIGHT.map((idx) => pts[idx]).filter(Boolean);
        const linerLidPts = 5;
        const lidLeft = lidLeftFull.slice(0, Math.min(linerLidPts, lidLeftFull.length));
        const lidRight = [...lidRightFull].reverse().slice(0, Math.min(linerLidPts, lidRightFull.length));
        regionVerts.LINER_LEFT_RIBBON = buildWingedRibbon(lidLeft, 0.0032, 'left', 0.012);
        regionVerts.LINER_RIGHT_RIBBON = buildWingedRibbon(lidRight, 0.0032, 'right', 0.012);

        // Blush hulls — convex hull around landmarks near each cheekbone point.
        regionVerts.BLUSH_LEFT = buildBlushRegion(pts, FacePoints.BLUSH_LEFT, 'left');
        regionVerts.BLUSH_RIGHT = buildBlushRegion(pts, FacePoints.BLUSH_RIGHT, 'right');

        // Nose contour: ridge points offset to either side of the bridge.
        const ridge = FaceRegions.NOSE_RIDGE.map((idx) => pts[idx]).filter(Boolean);
        regionVerts.NOSE_LEFT_RIBBON = buildRibbon(offsetPts(ridge, -0.018), 0.006, true);
        regionVerts.NOSE_RIGHT_RIBBON = buildRibbon(offsetPts(ridge, 0.018), 0.006, true);

        // Nose tip soft patch for the screen-mode highlight.
        const tip = pts[FacePoints.NOSE_TIP];
        if (tip) {
          regionVerts.NOSE_TIP = buildFan(makeCircle(tip, 0.022, 22), true);
        }

        // Under-eye crescents for concealer.
        regionVerts.UNDER_EYE_LEFT = buildUnderEyeRegion(pts, FaceRegions.UNDER_EYE_LEFT_LID);
        regionVerts.UNDER_EYE_RIGHT = buildUnderEyeRegion(pts, FaceRegions.UNDER_EYE_RIGHT_LID);

        // Live skin-tone sample (forehead) — drives the concealer color.
        sampleLiveSkinTone(video, pts);

        lastLipsUpdate = now;
      } else {
        lastPointsForDebug = null;
      }
    }

    // 3) Draw makeup. Each region runs the same mask -> blur -> composite path
    //    via renderer.drawMakeupRegion(), with a per-region blend mode picked to
    //    match how that product behaves on real skin (multiply for pigment that
    //    darkens, soft-light for diffuse cheek tints, screen for highlights, HSL
    //    "color" for lipstick/shadow that needs the underlying luminance preserved).
    //
    //    Sliders go straight to intensity (0..1) — the per-region *_INTENSITY_MAX
    //    constants are the makeup-style cap.
    const lipSlider       = clamp01(Number(lipIntensityEl.value) / 100);
    const concealerSlider = clamp01(Number(concealerIntensityEl.value) / 100);
    const shadowSlider    = clamp01(Number(eyeShadowIntensityEl.value) / 100);
    const linerSlider     = clamp01(Number(eyeLinerIntensityEl.value) / 100);
    const browSlider      = clamp01(Number(browIntensityEl.value) / 100);
    const blushSlider     = clamp01(Number(blushIntensityEl.value) / 100);
    const noseSlider      = clamp01(Number(noseIntensityEl.value) / 100);

    // Lips: HSL color blend so the lip's own highlights / shape survive; tight spec band keeps gloss.
    renderer.drawMakeupRegion({
      add: [regionVerts.LIP_OUTER],
      subtract: [regionVerts.MOUTH_INNER],
      blurStrength: LIP_BLUR_STRENGTH,
      topRGB: makeupColors.lipstickTop,
      bottomRGB: makeupColors.lipstickBottom,
      intensity: lipSlider * LIP_INTENSITY_MAX,
      blendMode: BlendMode.HSLColor,
      multiplyMix: LIP_MULTIPLY_MIX,
      lumaLift: LIP_LUMA_LIFT,
      specGuard: LIP_SPEC,
    });

    // Concealer: soft-light with the user's live skin tone (lifted ~half a shade). Drawn BEFORE
    // the eye products so eyeshadow/liner read on top of it. Eye-ball masks subtracted so
    // we never paint over the eye itself, just the tear-trough/upper-cheek band.
    if (concealerSlider > 0) {
      const concealerRGB = concealerColorFromSkin(makeupColors.liveSkinTone);
      renderer.drawMakeupRegion({
        add: [regionVerts.UNDER_EYE_LEFT, regionVerts.UNDER_EYE_RIGHT],
        subtract: [regionVerts.EYE_LEFT_MASK, regionVerts.EYE_RIGHT_MASK],
        blurStrength: CONCEALER_BLUR_STRENGTH,
        topRGB: concealerRGB,
        bottomRGB: concealerRGB,
        intensity: concealerSlider * CONCEALER_INTENSITY_MAX,
        blendMode: BlendMode.SoftLight,
        specGuard: CONCEALER_SPEC,
      });
    }

    // Eyeshadow: one pass for both eyes (same color, mirrored regions); each eyeball masked out.
    renderer.drawMakeupRegion({
      add: [regionVerts.SHADOW_LEFT_RIBBON, regionVerts.SHADOW_RIGHT_RIBBON],
      subtract: [regionVerts.EYE_LEFT_MASK, regionVerts.EYE_RIGHT_MASK],
      blurStrength: SHADOW_BLUR_STRENGTH,
      topRGB: makeupColors.eyeShadowCrease,
      bottomRGB: makeupColors.eyeShadowLash,
      intensity: shadowSlider * SHADOW_INTENSITY_MAX,
      blendMode: BlendMode.HSLColor,
      multiplyMix: SHADOW_MULTIPLY_MIX,
      specGuard: SHADOW_SPEC,
    });

    // Eyeliner: multiply with the dark liner color; small blur keeps the line crisp but not jaggy.
    renderer.drawMakeupRegion({
      add: [regionVerts.LINER_LEFT_RIBBON, regionVerts.LINER_RIGHT_RIBBON],
      blurStrength: LINER_BLUR_STRENGTH,
      topRGB: makeupColors.eyeLiner,
      bottomRGB: makeupColors.eyeLiner,
      intensity: linerSlider * LINER_INTENSITY_MAX,
      blendMode: BlendMode.Multiply,
      specGuard: LINER_SPEC,
    });

    // Brows: multiply, low cap. Reads as filling in sparse hairs rather than painting on a brow.
    renderer.drawMakeupRegion({
      add: [regionVerts.BROW_LEFT_RIBBON, regionVerts.BROW_RIGHT_RIBBON],
      blurStrength: BROW_BLUR_STRENGTH,
      topRGB: makeupColors.brow,
      bottomRGB: makeupColors.brow,
      intensity: browSlider * BROW_INTENSITY_MAX,
      blendMode: BlendMode.Multiply,
      specGuard: BROW_SPEC,
    });

    // Blush: soft-light + heavy diffuse blur for that "brushed onto cheekbone" glow.
    renderer.drawMakeupRegion({
      add: [regionVerts.BLUSH_LEFT, regionVerts.BLUSH_RIGHT],
      blurStrength: BLUSH_BLUR_STRENGTH,
      topRGB: makeupColors.blush,
      bottomRGB: makeupColors.blush,
      intensity: blushSlider * BLUSH_INTENSITY_MAX,
      blendMode: BlendMode.SoftLight,
      specGuard: BLUSH_SPEC,
    });

    // Nose contour (multiply warm dark) + nose-tip highlight (screen soft pink).
    if (noseSlider > 0) {
      renderer.drawMakeupRegion({
        add: [regionVerts.NOSE_LEFT_RIBBON, regionVerts.NOSE_RIGHT_RIBBON],
        blurStrength: NOSE_CONTOUR_BLUR_STRENGTH,
        topRGB: makeupColors.noseContour,
        bottomRGB: makeupColors.noseContour,
        intensity: noseSlider * NOSE_CONTOUR_INTENSITY_MAX,
        blendMode: BlendMode.Multiply,
        specGuard: NOSE_CONTOUR_SPEC,
      });
      renderer.drawMakeupRegion({
        add: [regionVerts.NOSE_TIP],
        blurStrength: NOSE_TIP_BLUR_STRENGTH,
        topRGB: NOSE_TIP_RGB,
        bottomRGB: NOSE_TIP_RGB,
        intensity: noseSlider * NOSE_TIP_INTENSITY_MAX,
        blendMode: BlendMode.Screen,
        specGuard: NOSE_TIP_SPEC,
      });
    }

    paintOverlay();

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch((e) => {
  console.error(e);
  statusEl.textContent = `Error: ${String(e)}`;
});
