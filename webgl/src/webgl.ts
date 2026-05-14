import { clamp01 } from './utils';
import { clipBounds, clipBoundsToPixelRect, type ClipBounds } from './geometry';

/**
 * The makeup renderer. All WebGL state — context, shaders, programs, FBOs, the
 * video texture — is encapsulated inside `createMakeupRenderer`. Callers get back
 * an object with methods that hide the GL specifics:
 *
 *   syncMaskFbosToCanvas() — call when the canvas size changes
 *   uploadVideoFrame(v)    — copy the latest webcam frame into the texture
 *   drawVideoQuad()        — paint the mirrored webcam fullscreen
 *   drawMakeupRegion(opts) — the mask -> blur -> composite makeup pipeline
 *
 * Wrapping the whole pipeline in a factory keeps it side-effect-free at import
 * time (we need the `#gl` canvas in the DOM before any of this runs), and gives
 * the rest of the app a small, focused API instead of a soup of mutable GL bindings.
 */

// =============================================================================
// Blend modes + per-region look config (caller-facing types).
// =============================================================================

export const BlendMode = {
  HSLColor: 0,
  Multiply: 1,
  SoftLight: 2,
  Screen: 3,
} as const;
export type BlendModeId = (typeof BlendMode)[keyof typeof BlendMode];

export type MakeupRegionOpts = {
  /** Polygons drawn into the mask as 1.0 (additive coverage). */
  add: Array<Float32Array | undefined>;
  /** Polygons drawn into the mask as 0.0 (subtract coverage — e.g. eyeball cut-out). */
  subtract?: Array<Float32Array | undefined>;
  /** Pixels of separable Gaussian blur on the mask (per-axis). */
  blurStrength: number;
  /** Top color of the vertical gradient inside the mask region. */
  topRGB: [number, number, number];
  /** Bottom color of the vertical gradient. Pass topRGB === bottomRGB for solid fills. */
  bottomRGB: [number, number, number];
  /** 0..1; this is what the slider drives (already multiplied by the region cap). */
  intensity: number;
  blendMode: BlendModeId;
  /** Only used by HSL-color mode (mode 0). */
  multiplyMix?: number;
  /**
   * Only used by HSL-color mode (mode 0). 0 keeps the skin's luminance (most natural shading);
   * higher values lift the transferred L toward a bright midpoint so vivid pinks/reds don't
   * read grey on naturally darker areas (lips especially). 0.3 is a good lip default.
   */
  lumaLift?: number;
  /** [start, end] luma band that fades makeup out to preserve underlying highlights. */
  specGuard?: readonly [number, number];
};

export interface MakeupRenderer {
  /** Underlying canvas — exposed so the caller can read its width/height for layout. */
  readonly canvas: HTMLCanvasElement;
  /** Resize the mask/blur FBOs to match the current canvas size. Call after canvas resize. */
  syncMaskFbosToCanvas(): void;
  /** Copy the latest webcam frame to the video texture. */
  uploadVideoFrame(video: HTMLVideoElement): void;
  /** Paint the mirrored webcam fullscreen. */
  drawVideoQuad(): void;
  /** Mask -> blur -> composite pipeline for one makeup region. */
  drawMakeupRegion(opts: MakeupRegionOpts): void;
}

// =============================================================================
// Shader source — kept inline (rather than fetched) for snappy first-paint.
// =============================================================================

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

const maskVS = `#version 300 es
in vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const maskFS = `#version 300 es
precision mediump float;
uniform float u_value;
out vec4 outColor;
void main() {
  outColor = vec4(u_value);
}`;

const blurVS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = (a_pos + 1.0) * 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Separable 9-tap Gaussian. `u_offset` is the per-axis step in UV space (pre-scaled
// by blur strength), and we sample 0, ±1..±4 taps with the standard 1-4-6-4-1-ish kernel.
const blurFS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_offset;
in vec2 v_uv;
out vec4 outColor;
const float w0 = 0.2270270270;
const float w1 = 0.1945945946;
const float w2 = 0.1216216216;
const float w3 = 0.0540540541;
const float w4 = 0.0162162162;
void main() {
  vec4 c = texture(u_tex, v_uv) * w0;
  c += texture(u_tex, v_uv + u_offset * 1.0) * w1;
  c += texture(u_tex, v_uv - u_offset * 1.0) * w1;
  c += texture(u_tex, v_uv + u_offset * 2.0) * w2;
  c += texture(u_tex, v_uv - u_offset * 2.0) * w2;
  c += texture(u_tex, v_uv + u_offset * 3.0) * w3;
  c += texture(u_tex, v_uv - u_offset * 3.0) * w3;
  c += texture(u_tex, v_uv + u_offset * 4.0) * w4;
  c += texture(u_tex, v_uv - u_offset * 4.0) * w4;
  outColor = c;
}`;

// --- Generalized makeup composite shader ---
// Same straight-alpha output, with per-region blend modes:
//   0 = HSL "color" blend (+ optional multiply mix)  — lips, bold eyeshadow
//   1 = multiply                                       — eyeliner, brows, contour shadow
//   2 = soft-light                                     — blush, soft eyeshadow
//   3 = screen                                         — nose-tip / highlight
// The shader has a final `else` that returns the raw color; it's an unreachable safety
// net for unexpected u_blendMode values, not a user-facing mode.
// rgb2hsl/hsl2rgb/blendSoftLight are stock formulae (Adobe spec for soft-light).
const makeupCompositeVS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = (a_pos + 1.0) * 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const makeupCompositeFS = `#version 300 es
precision mediump float;
uniform sampler2D u_video;
uniform sampler2D u_mask;
uniform vec3 u_topRGB;
uniform vec3 u_bottomRGB;
uniform vec2 u_yRange;        // (yMin, yMax) in v_uv space; top of region = yMax
uniform float u_intensity;    // 0..1 (slider * region cap)
uniform float u_multiplyMix;  // mode 0 only: 0 = pure HSL color, 1 = pure multiply
uniform float u_lumaLift;     // mode 0 only: 0 = keep skin luminance, 1 = pull L to 0.55 midpoint
uniform vec2 u_specGuard;     // smoothstep(start, end, luma) -> 0 = preserve highlight
uniform int u_blendMode;
in vec2 v_uv;
out vec4 outColor;

vec3 rgb2hsl(vec3 c) {
  float maxc = max(max(c.r, c.g), c.b);
  float minc = min(min(c.r, c.g), c.b);
  float l = (maxc + minc) * 0.5;
  float h = 0.0;
  float s = 0.0;
  float d = maxc - minc;
  if (d > 1e-6) {
    s = (l > 0.5) ? d / (2.0 - maxc - minc) : d / (maxc + minc);
    if (maxc == c.r)      h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (maxc == c.g) h = (c.b - c.r) / d + 2.0;
    else                  h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}

float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5)     return q;
  if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
  return p;
}

vec3 hsl2rgb(vec3 hsl) {
  float h = hsl.x, s = hsl.y, l = hsl.z;
  if (s < 1e-6) return vec3(l);
  float q = (l < 0.5) ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return vec3(hue2rgb(p, q, h + 1.0/3.0), hue2rgb(p, q, h), hue2rgb(p, q, h - 1.0/3.0));
}

vec3 blendSoftLight(vec3 b, vec3 s) {
  // Photoshop soft-light: branch per-component on whether the overlay is darker or lighter than 50%.
  // sqrt branch lifts highlights, b*b branch deepens shadows — preserves underlying texture either way.
  return mix(
    2.0 * b * s + b * b * (1.0 - 2.0 * s),
    sqrt(b) * (2.0 * s - 1.0) + 2.0 * b * (1.0 - s),
    step(0.5, s)
  );
}

void main() {
  float m = texture(u_mask, v_uv).r;
  if (m < 0.001) { outColor = vec4(0.0); return; }

  // Match the horizontal mirror that quadFS does so 'skin' is the same pixel the user sees.
  vec2 videoUV = vec2(1.0 - v_uv.x, v_uv.y);
  vec3 skin = texture(u_video, videoUV).rgb;

  // Top -> bottom color gradient. yMax = top of screen.
  float t = clamp((u_yRange.y - v_uv.y) / max(u_yRange.y - u_yRange.x, 1e-5), 0.0, 1.0);
  vec3 color = mix(u_topRGB, u_bottomRGB, t);

  vec3 makeup;
  if (u_blendMode == 0) {
    // HSL color blend with optional luma lift. Pulling the transferred L toward a bright midpoint
    // (0.55) stops dark lips/eyelids from dragging vivid pinks/reds into a grey-brown muddle.
    float skinL = rgb2hsl(skin).z;
    float liftedL = mix(skinL, 0.55, u_lumaLift);
    vec3 hslColor = hsl2rgb(vec3(rgb2hsl(color).xy, liftedL));
    vec3 mult = skin * color;
    makeup = mix(hslColor, mult, u_multiplyMix);
  } else if (u_blendMode == 1) {
    makeup = skin * color;
  } else if (u_blendMode == 2) {
    makeup = blendSoftLight(skin, color);
  } else if (u_blendMode == 3) {
    makeup = vec3(1.0) - (vec3(1.0) - skin) * (vec3(1.0) - color);
  } else {
    makeup = color;
  }

  // Specular guard: dim makeup where the underlying skin is glossy/bright so highlights survive.
  float luma = dot(skin, vec3(0.299, 0.587, 0.114));
  float specGuard = 1.0 - smoothstep(u_specGuard.x, u_specGuard.y, luma);

  float a = clamp(m * u_intensity * specGuard, 0.0, 1.0);
  outColor = vec4(makeup, a);
}`;

// =============================================================================
// Renderer factory.
// =============================================================================

type Fbo = { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number };

export function createMakeupRenderer(canvas: HTMLCanvasElement): MakeupRenderer {
  // Request a stencil buffer so future region tweaks (e.g. tighter mouth cut-outs) can use stencil ops.
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, stencil: true });
  if (!gl) throw new Error('WebGL2 not available');

  // Match video textures to 2D/canvas coordinates (prevents upside-down camera).
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  // -------------------------------------------------------------------------
  // Shader / program helpers (private to this factory).
  // -------------------------------------------------------------------------

  function compileShader(type: number, src: string): WebGLShader {
    const s = gl!.createShader(type);
    if (!s) throw new Error('createShader failed');
    gl!.shaderSource(s, src);
    gl!.compileShader(s);
    if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) {
      throw new Error(gl!.getShaderInfoLog(s) || 'shader compile failed');
    }
    return s;
  }

  function createProgram(vsSrc: string, fsSrc: string): WebGLProgram {
    const vs = compileShader(gl!.VERTEX_SHADER, vsSrc);
    const fs = compileShader(gl!.FRAGMENT_SHADER, fsSrc);
    const p = gl!.createProgram();
    if (!p) throw new Error('createProgram failed');
    gl!.attachShader(p, vs);
    gl!.attachShader(p, fs);
    gl!.linkProgram(p);
    if (!gl!.getProgramParameter(p, gl!.LINK_STATUS)) {
      throw new Error(gl!.getProgramInfoLog(p) || 'program link failed');
    }
    gl!.deleteShader(vs);
    gl!.deleteShader(fs);
    return p;
  }

  // -------------------------------------------------------------------------
  // Fullscreen webcam quad.
  // -------------------------------------------------------------------------

  const quadProgram = createProgram(quadVS, quadFS);
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

  // Generic VAO + buffer we use to push region polygons (lip outer, eye masks,
  // blush hulls, ribbons, etc.) into the mask FBO each frame. The actual fragment
  // program varies (mask program below), but they all consume the same a_pos vec2 layout.
  const regionVAO = gl.createVertexArray()!;
  const regionBuf = gl.createBuffer()!;

  // -------------------------------------------------------------------------
  // FBOs (half-res mask + two blur ping-pong targets).
  // -------------------------------------------------------------------------

  function createFBO(width: number, height: number): Fbo {
    const tex = gl!.createTexture()!;
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA8, width, height, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, null);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    const fbo = gl!.createFramebuffer()!;
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, tex, 0);
    if (gl!.checkFramebufferStatus(gl!.FRAMEBUFFER) !== gl!.FRAMEBUFFER_COMPLETE) {
      throw new Error('FBO incomplete');
    }
    gl!.bindTexture(gl!.TEXTURE_2D, null);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    return { fbo, tex, w: width, h: height };
  }

  function resizeFBO(f: Fbo, w: number, h: number) {
    if (f.w === w && f.h === h) return;
    gl!.bindTexture(gl!.TEXTURE_2D, f.tex);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA8, w, h, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, null);
    gl!.bindTexture(gl!.TEXTURE_2D, null);
    f.w = w;
    f.h = h;
  }

  // Half-res is plenty: the mask gets Gaussian-blurred anyway, and we save a lot of fillrate.
  function maskTargetSize() {
    return {
      w: Math.max(2, Math.floor(canvas.width / 2)),
      h: Math.max(2, Math.floor(canvas.height / 2)),
    };
  }

  const initSize = maskTargetSize();
  const maskFbo = createFBO(initSize.w, initSize.h);
  const blurPingFbo = createFBO(initSize.w, initSize.h);
  const blurPongFbo = createFBO(initSize.w, initSize.h);

  // -------------------------------------------------------------------------
  // Mask, blur, composite programs.
  // -------------------------------------------------------------------------

  const maskProgram = createProgram(maskVS, maskFS);
  const maskPosLoc = gl.getAttribLocation(maskProgram, 'a_pos');
  const maskValueLoc = gl.getUniformLocation(maskProgram, 'u_value');

  const blurProgram = createProgram(blurVS, blurFS);
  const blurPosLoc = gl.getAttribLocation(blurProgram, 'a_pos');
  const blurTexLoc = gl.getUniformLocation(blurProgram, 'u_tex');
  const blurOffsetLoc = gl.getUniformLocation(blurProgram, 'u_offset');

  const makeupProgram = createProgram(makeupCompositeVS, makeupCompositeFS);
  const makeupPosLoc = gl.getAttribLocation(makeupProgram, 'a_pos');
  const makeupVideoLoc = gl.getUniformLocation(makeupProgram, 'u_video');
  const makeupMaskLoc = gl.getUniformLocation(makeupProgram, 'u_mask');
  const makeupTopLoc = gl.getUniformLocation(makeupProgram, 'u_topRGB');
  const makeupBottomLoc = gl.getUniformLocation(makeupProgram, 'u_bottomRGB');
  const makeupYRangeLoc = gl.getUniformLocation(makeupProgram, 'u_yRange');
  const makeupIntensityLoc = gl.getUniformLocation(makeupProgram, 'u_intensity');
  const makeupMultiplyMixLoc = gl.getUniformLocation(makeupProgram, 'u_multiplyMix');
  const makeupLumaLiftLoc = gl.getUniformLocation(makeupProgram, 'u_lumaLift');
  const makeupSpecGuardLoc = gl.getUniformLocation(makeupProgram, 'u_specGuard');
  const makeupBlendModeLoc = gl.getUniformLocation(makeupProgram, 'u_blendMode');

  // -------------------------------------------------------------------------
  // Public methods.
  // -------------------------------------------------------------------------

  function syncMaskFbosToCanvas() {
    const { w, h } = maskTargetSize();
    resizeFBO(maskFbo, w, h);
    resizeFBO(blurPingFbo, w, h);
    resizeFBO(blurPongFbo, w, h);
  }

  function uploadVideoFrame(video: HTMLVideoElement) {
    gl!.bindTexture(gl!.TEXTURE_2D, videoTex);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGB, gl!.RGB, gl!.UNSIGNED_BYTE, video);
  }

  function drawVideoQuad() {
    gl!.viewport(0, 0, canvas.width, canvas.height);
    gl!.disable(gl!.BLEND);
    gl!.useProgram(quadProgram);
    gl!.bindVertexArray(quadVAO);
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, videoTex);
    gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
    gl!.bindVertexArray(null);
  }

  function drawMakeupRegion(opts: MakeupRegionOpts) {
    if (opts.intensity <= 0) return;
    const adds = opts.add.filter((p): p is Float32Array => !!p && p.length > 0);
    if (adds.length === 0) return;
    const subs = (opts.subtract ?? []).filter((p): p is Float32Array => !!p && p.length > 0);

    // Combined clip-space bbox across all add polys (used for the y-gradient AND the scissor rect).
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const p of adds) {
      const b = clipBounds(p);
      if (b.xMin < xMin) xMin = b.xMin;
      if (b.xMax > xMax) xMax = b.xMax;
      if (b.yMin < yMin) yMin = b.yMin;
      if (b.yMax > yMax) yMax = b.yMax;
    }
    if (!Number.isFinite(xMin) || !Number.isFinite(yMin)) return;
    const bbox: ClipBounds = { xMin, xMax, yMin, yMax };
    const yMinUV = (yMin + 1) * 0.5;
    const yMaxUV = (yMax + 1) * 0.5;

    // Scissor everything to this region's bbox. Massive fragment-count win: 99% of the
    // screen is "not lips" / "not blush" / etc., so we'd otherwise do blur+composite work
    // on millions of pixels that just early-out in the shader.
    //
    // Padding accounts for the 9-tap Gaussian's reach (up to 4 × blurStrength mask-px from
    // each output fragment). innerPad covers the soft-edge falloff we WANT to draw; outerPad
    // covers the additional read reach so the blur never samples stale data outside what we
    // just cleared.
    const reachPx = Math.ceil(4 * opts.blurStrength) + 1;
    const innerMaskPad = reachPx + 1;
    const outerMaskPad = innerMaskPad + reachPx;

    const innerMask = clipBoundsToPixelRect(maskFbo.w, maskFbo.h, bbox, innerMaskPad);
    const outerMask = clipBoundsToPixelRect(maskFbo.w, maskFbo.h, bbox, outerMaskPad);
    if (innerMask.w === 0 || innerMask.h === 0) return;

    gl!.enable(gl!.SCISSOR_TEST);

    // 1) Wipe all three FBOs in the OUTER scissor area so subsequent blur reads see 0 outside
    //    what we're about to draw (avoids leakage from a previous region whose bbox overlapped).
    gl!.disable(gl!.BLEND);
    gl!.disable(gl!.STENCIL_TEST);
    gl!.clearColor(0, 0, 0, 0);
    gl!.scissor(outerMask.x, outerMask.y, outerMask.w, outerMask.h);
    for (const f of [maskFbo, blurPingFbo, blurPongFbo]) {
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, f.fbo);
      gl!.viewport(0, 0, f.w, f.h);
      gl!.clear(gl!.COLOR_BUFFER_BIT);
    }

    // 2) Tighten to the inner scissor for the actual mask draws / blur / composite.
    gl!.scissor(innerMask.x, innerMask.y, innerMask.w, innerMask.h);

    // 2a) Rasterize binary mask: add polys = 1, then subtract polys = 0 (mouth interior, eyeballs).
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, maskFbo.fbo);
    gl!.viewport(0, 0, maskFbo.w, maskFbo.h);

    gl!.useProgram(maskProgram);
    gl!.bindVertexArray(regionVAO);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, regionBuf);
    gl!.enableVertexAttribArray(maskPosLoc);
    gl!.uniform1f(maskValueLoc, 1.0);
    for (const p of adds) {
      gl!.bufferData(gl!.ARRAY_BUFFER, p, gl!.DYNAMIC_DRAW);
      gl!.vertexAttribPointer(maskPosLoc, 2, gl!.FLOAT, false, 0, 0);
      gl!.drawArrays(gl!.TRIANGLES, 0, p.length / 2);
    }
    gl!.uniform1f(maskValueLoc, 0.0);
    for (const p of subs) {
      gl!.bufferData(gl!.ARRAY_BUFFER, p, gl!.DYNAMIC_DRAW);
      gl!.vertexAttribPointer(maskPosLoc, 2, gl!.FLOAT, false, 0, 0);
      gl!.drawArrays(gl!.TRIANGLES, 0, p.length / 2);
    }
    gl!.bindVertexArray(null);

    // 2b) Separable Gaussian: maskFbo -> ping (horizontal) -> pong (vertical).
    gl!.useProgram(blurProgram);
    gl!.bindVertexArray(quadVAO);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, quadBuf);
    gl!.enableVertexAttribArray(blurPosLoc);
    gl!.vertexAttribPointer(blurPosLoc, 2, gl!.FLOAT, false, 0, 0);
    gl!.uniform1i(blurTexLoc, 0);
    gl!.activeTexture(gl!.TEXTURE0);

    gl!.bindFramebuffer(gl!.FRAMEBUFFER, blurPingFbo.fbo);
    gl!.viewport(0, 0, blurPingFbo.w, blurPingFbo.h);
    gl!.bindTexture(gl!.TEXTURE_2D, maskFbo.tex);
    gl!.uniform2f(blurOffsetLoc, opts.blurStrength / maskFbo.w, 0);
    gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);

    gl!.bindFramebuffer(gl!.FRAMEBUFFER, blurPongFbo.fbo);
    gl!.viewport(0, 0, blurPongFbo.w, blurPongFbo.h);
    gl!.bindTexture(gl!.TEXTURE_2D, blurPingFbo.tex);
    gl!.uniform2f(blurOffsetLoc, 0, opts.blurStrength / blurPingFbo.h);
    gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
    gl!.bindVertexArray(null);

    // 3) Composite at full canvas resolution. Canvas is 2× mask FBO, so scale the inner pad.
    const innerFull = clipBoundsToPixelRect(canvas.width, canvas.height, bbox, innerMaskPad * 2);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    gl!.viewport(0, 0, canvas.width, canvas.height);
    gl!.scissor(innerFull.x, innerFull.y, innerFull.w, innerFull.h);

    gl!.useProgram(makeupProgram);
    gl!.bindVertexArray(quadVAO);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, quadBuf);
    gl!.enableVertexAttribArray(makeupPosLoc);
    gl!.vertexAttribPointer(makeupPosLoc, 2, gl!.FLOAT, false, 0, 0);

    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, videoTex);
    gl!.uniform1i(makeupVideoLoc, 0);
    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, blurPongFbo.tex);
    gl!.uniform1i(makeupMaskLoc, 1);

    gl!.uniform3f(makeupTopLoc, opts.topRGB[0], opts.topRGB[1], opts.topRGB[2]);
    gl!.uniform3f(makeupBottomLoc, opts.bottomRGB[0], opts.bottomRGB[1], opts.bottomRGB[2]);
    gl!.uniform2f(makeupYRangeLoc, yMinUV, yMaxUV);
    gl!.uniform1f(makeupIntensityLoc, clamp01(opts.intensity));
    gl!.uniform1f(makeupMultiplyMixLoc, opts.multiplyMix ?? 0);
    gl!.uniform1f(makeupLumaLiftLoc, opts.lumaLift ?? 0);
    const sg = opts.specGuard ?? [0.85, 0.99];
    gl!.uniform2f(makeupSpecGuardLoc, sg[0], sg[1]);
    gl!.uniform1i(makeupBlendModeLoc, opts.blendMode);

    gl!.enable(gl!.BLEND);
    gl!.blendFunc(gl!.SRC_ALPHA, gl!.ONE_MINUS_SRC_ALPHA);
    gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
    gl!.disable(gl!.BLEND);
    gl!.bindVertexArray(null);
    gl!.activeTexture(gl!.TEXTURE0);

    gl!.disable(gl!.SCISSOR_TEST);
  }

  return {
    canvas,
    syncMaskFbosToCanvas,
    uploadVideoFrame,
    drawVideoQuad,
    drawMakeupRegion,
  };
}
