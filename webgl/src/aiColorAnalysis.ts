/**
 * AI color read: captures a mirrored webcam snapshot, POSTs to `/api/analyze-makeup-colors`
 * (FastAPI + Google Gemini vision on the server), shows a modal with the result, a hex palette
 * you can apply to the try-on, copy, or save to localStorage ("scrapbook").
 */

import { applyMakeupLookFromHex, type MakeupLookHex } from './customize';

export const AI_LOOK_VIBES = ['natural', 'glam', 'fun'] as const;
export type AiLookVibe = (typeof AI_LOOK_VIBES)[number];

export const AI_LOOK_VIBE_LABELS: Record<AiLookVibe, string> = {
  natural: 'Natural',
  glam: 'Glam',
  fun: 'Fun',
};

const VIBE_PREF_KEY = 'doremi-ai-look-vibe-pref';

function readVibePreference(): AiLookVibe {
  try {
    const v = sessionStorage.getItem(VIBE_PREF_KEY);
    if (v && (AI_LOOK_VIBES as readonly string[]).includes(v)) return v as AiLookVibe;
  } catch {
    /* ignore */
  }
  return 'natural';
}

function storeVibePreference(v: AiLookVibe) {
  try {
    sessionStorage.setItem(VIBE_PREF_KEY, v);
  } catch {
    /* ignore */
  }
}

function readVibeFromDom(): AiLookVibe {
  const el = document.querySelector<HTMLInputElement>('input[name="aiLookVibe"]:checked');
  const v = el?.value;
  if (v && (AI_LOOK_VIBES as readonly string[]).includes(v)) return v as AiLookVibe;
  return 'natural';
}

function syncVibeRadiosFromStorage() {
  const pref = readVibePreference();
  document.querySelectorAll<HTMLInputElement>('input[name="aiLookVibe"]').forEach((r) => {
    r.checked = r.value === pref;
  });
}

const LOOK_HEX_KEYS = ['lip', 'eye_shadow', 'liner', 'brow', 'blush'] as const;

function isLookHex(x: unknown): x is MakeupLookHex {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  for (const k of LOOK_HEX_KEYS) {
    const v = o[k];
    if (typeof v !== 'string') return false;
    const t = v.trim();
    if (!/^#[0-9A-Fa-f]{6}$/i.test(t)) return false;
  }
  return true;
}

function normalizeLookHex(raw: unknown): MakeupLookHex | undefined {
  if (!isLookHex(raw)) return undefined;
  const o = raw as Record<string, string>;
  const out: Record<string, string> = {};
  for (const k of LOOK_HEX_KEYS) {
    const h = (o[k].trim().startsWith('#') ? o[k].trim().slice(1) : o[k].trim()).toUpperCase();
    out[k] = `#${h}`;
  }
  return out as MakeupLookHex;
}

function stripSparkleEmoji(s: string): string {
  return s.replace(/\u2728/g, '').replace(/\s{2,}/g, ' ').trim();
}

const STORAGE_KEY = 'doremi-ai-color-reads-v1';

export type AiColorAnalysis = {
  headline: string;
  vibe_tags: string[];
  undertone_read: string;
  lip_colors: string[];
  eye_colors: string[];
  blush_colors: string[];
  liner_brow: string;
  tips: string[];
  confidence_note: string;
  disclaimer: string;
  /** Present on new reads; older scrapbook saves may omit this. */
  look_hex?: MakeupLookHex;
};

export type SavedAiRead = {
  id: string;
  savedAt: number;
  headline: string;
  /** Which look direction was used when this read was generated. */
  lookVibe?: AiLookVibe;
  analysis: AiColorAnalysis;
};

type InitArgs = {
  video: HTMLVideoElement;
  statusEl: HTMLElement | null;
  /** Called right after AI hex colors are applied (modal + scrapbook Apply). Arg is the read’s vibe, or null for old saves. */
  onAfterApplyLook?: (lookVibe: AiLookVibe | null) => void;
};

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readSavedReads(): SavedAiRead[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedRead);
  } catch {
    return [];
  }
}

function isSavedRead(x: unknown): x is SavedAiRead {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.savedAt !== 'number' || typeof o.headline !== 'string') return false;
  const a = o.analysis;
  if (!a || typeof a !== 'object') return false;
  const ar = a as Record<string, unknown>;
  if (typeof ar.headline !== 'string' || !Array.isArray(ar.vibe_tags)) return false;
  if (ar.look_hex !== undefined && !isLookHex(ar.look_hex)) return false;
  if (o.lookVibe !== undefined) {
    if (typeof o.lookVibe !== 'string' || !(AI_LOOK_VIBES as readonly string[]).includes(o.lookVibe)) return false;
  }
  return true;
}

function writeSavedReads(reads: SavedAiRead[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(reads));
  } catch (e) {
    console.warn('Could not save AI reads', e);
  }
}

function asStringArray(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.filter((v): v is string => typeof v === 'string');
}

function normalizeAnalysis(raw: Record<string, unknown>): AiColorAnalysis {
  const headlineRaw = typeof raw.headline === 'string' ? raw.headline : 'Your color read';
  const look_hex = normalizeLookHex(raw.look_hex);
  return {
    headline: stripSparkleEmoji(headlineRaw) || 'Your color read',
    vibe_tags: asStringArray(raw.vibe_tags),
    undertone_read: typeof raw.undertone_read === 'string' ? raw.undertone_read : '',
    lip_colors: asStringArray(raw.lip_colors),
    eye_colors: asStringArray(raw.eye_colors),
    blush_colors: asStringArray(raw.blush_colors),
    liner_brow: typeof raw.liner_brow === 'string' ? raw.liner_brow : '',
    tips: asStringArray(raw.tips),
    confidence_note: typeof raw.confidence_note === 'string' ? raw.confidence_note : '',
    disclaimer: '',
    ...(look_hex ? { look_hex } : {}),
  };
}

/** Snapshot matches on-screen mirror: horizontal flip, max width capped for upload size. */
function captureMirroredJpeg(video: HTMLVideoElement, maxW = 640, quality = 0.85): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (video.readyState < 2 || video.videoWidth < 2) {
      resolve(null);
      return;
    }
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const w = Math.min(maxW, vw);
    const h = Math.round((vh / vw) * w);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) {
      resolve(null);
      return;
    }
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    c.toBlob((b) => resolve(b), 'image/jpeg', quality);
  });
}

function pillTags(tags: string[]): string {
  if (!tags.length) return '<span class="ai-color-muted">no tags</span>';
  return tags
    .map((t) => `<span class="ai-color-pill">${escapeHtml(t)}</span>`)
    .join('');
}

function bulletList(items: string[]): string {
  if (!items.length) return '';
  return `<ul class="ai-color-list">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
}

function renderLookHexSection(look: MakeupLookHex | undefined): string {
  if (!look) {
    return `<p class="ai-color-muted">No hex palette in this read. Run a new color read to get loadable colors.</p>`;
  }
  const rows: [string, string][] = [
    ['Lips', look.lip],
    ['Eyeshadow', look.eye_shadow],
    ['Liner', look.liner],
    ['Brows', look.brow],
    ['Blush', look.blush],
  ];
  return `
    <div class="ai-color-look-section">
      <span class="ai-color-card-title">Palette — tap a swatch to copy hex</span>
      <div class="ai-color-hex-grid">
        ${rows
          .map(
            ([label, hex]) => `
          <div class="ai-color-hex-row">
            <span class="ai-color-hex-label">${escapeHtml(label)}</span>
            <button type="button" class="ai-color-hex-chip" style="--chip:${escapeHtml(hex)}" data-copy-hex="${escapeHtml(hex)}" title="Copy ${escapeHtml(hex)}">
              <span class="ai-color-hex-swatch" aria-hidden="true"></span>
              <code class="ai-color-hex-code">${escapeHtml(hex)}</code>
            </button>
          </div>`,
          )
          .join('')}
      </div>
    </div>`;
}

function renderAnalysisHtml(a: AiColorAnalysis, vibe: AiLookVibe | null | undefined): string {
  const vibeLine =
    vibe != null
      ? `<p class="ai-color-vibe-badge" role="note"><span>${escapeHtml(AI_LOOK_VIBE_LABELS[vibe])}</span> direction</p>`
      : '';
  return `
    <div class="ai-color-result">
      ${vibeLine}
      <h3 class="ai-color-headline">${escapeHtml(a.headline)}</h3>
      <div class="ai-color-pill-row">${pillTags(a.vibe_tags)}</div>
      ${renderLookHexSection(a.look_hex)}
      <p class="ai-color-body">${escapeHtml(a.undertone_read)}</p>
      <div class="ai-color-grid">
        <div class="ai-color-card">
          <span class="ai-color-card-title">Lips</span>
          ${bulletList(a.lip_colors)}
        </div>
        <div class="ai-color-card">
          <span class="ai-color-card-title">Eyes</span>
          ${bulletList(a.eye_colors)}
        </div>
        <div class="ai-color-card">
          <span class="ai-color-card-title">Blush</span>
          ${bulletList(a.blush_colors)}
        </div>
      </div>
      <p class="ai-color-liner">${escapeHtml(a.liner_brow)}</p>
      <div class="ai-color-tips">
        <span class="ai-color-card-title">Hot tips</span>
        ${bulletList(a.tips)}
      </div>
      <p class="ai-color-note">${escapeHtml(a.confidence_note)}</p>
      <p class="ai-color-disclaimer">${escapeHtml(a.disclaimer)}</p>
    </div>
  `;
}

export function initAiColorAnalysis(args: InitArgs): void {
  const stage = document.querySelector<HTMLDivElement>('.stage');
  if (!stage) throw new Error('initAiColorAnalysis: .stage missing');

  stage.insertAdjacentHTML(
    'beforeend',
    `
    <div class="ai-color-overlay" id="aiColorOverlay" hidden>
      <div class="ai-color-shell" role="dialog" aria-modal="true" aria-labelledby="aiColorTitle">
        <div class="ai-color-shell-inner">
          <div class="ai-color-topbar">
            <span class="ai-color-title" id="aiColorTitle">AI color read</span>
            <button type="button" class="ai-color-x" id="aiColorClose" aria-label="Close">&times;</button>
          </div>
          <div id="aiColorMainBlock">
          <p class="ai-color-lede">We’ll use one snapshot (mirrored like your preview) to suggest colors and a hex palette you can load onto the try-on.</p>
          <fieldset class="ai-color-vibe-fieldset" id="aiColorVibeFieldset">
            <legend class="ai-color-vibe-legend">Look direction</legend>
            <div class="ai-color-vibe-grid" role="radiogroup" aria-label="Look direction">
              <label class="ai-color-vibe-option">
                <input type="radio" name="aiLookVibe" value="natural" checked />
                <span class="ai-color-vibe-option-text">
                  <span class="ai-color-vibe-name">Natural</span>
                  <span class="ai-color-vibe-hint">Soft, everyday, suits you</span>
                </span>
              </label>
              <label class="ai-color-vibe-option">
                <input type="radio" name="aiLookVibe" value="glam" />
                <span class="ai-color-vibe-option-text">
                  <span class="ai-color-vibe-name">Glam</span>
                  <span class="ai-color-vibe-hint">Richer, evening-ready</span>
                </span>
              </label>
              <label class="ai-color-vibe-option">
                <input type="radio" name="aiLookVibe" value="fun" />
                <span class="ai-color-vibe-option-text">
                  <span class="ai-color-vibe-name">Fun</span>
                  <span class="ai-color-vibe-hint">Playful, expressive color</span>
                </span>
              </label>
            </div>
          </fieldset>
          <div class="ai-color-actions-top" id="aiColorActionsTop">
            <button type="button" class="ai-color-primary" id="aiColorRunBtn">Run color read</button>
            <button type="button" class="ai-color-ghost" id="aiColorLibraryBtn">Scrapbook</button>
          </div>
          <div class="ai-color-loading" id="aiColorLoading" hidden>
            <span class="ai-color-spinner" aria-hidden="true"></span>
            <span>Reading your light + undertone vibes…</span>
          </div>
          <div class="ai-color-error" id="aiColorError" hidden></div>
          <div class="ai-color-body-slot" id="aiColorBody"></div>
          <div class="ai-color-footer-actions" id="aiColorFooter" hidden>
            <button type="button" class="ai-color-primary sm" id="aiColorApplyBtn" hidden>Apply to try-on</button>
            <button type="button" class="ai-color-secondary" id="aiColorSaveBtn">Save to scrapbook</button>
          </div>
          </div>
          <div class="ai-color-library" id="aiColorLibrary" hidden>
            <div class="ai-color-library-head">
              <span>Saved reads</span>
              <button type="button" class="ai-color-ghost sm" id="aiColorLibraryBack">Back</button>
            </div>
            <div class="ai-color-library-list" id="aiColorLibraryList"></div>
            <p class="ai-color-library-empty" id="aiColorLibraryEmpty">Nothing saved yet — run a read and tap “Save to scrapbook”.</p>
          </div>
        </div>
      </div>
    </div>
  `,
  );

  const overlay = document.querySelector<HTMLElement>('#aiColorOverlay')!;
  const closeBtn = document.querySelector<HTMLButtonElement>('#aiColorClose')!;
  const runBtn = document.querySelector<HTMLButtonElement>('#aiColorRunBtn')!;
  const libraryBtn = document.querySelector<HTMLButtonElement>('#aiColorLibraryBtn')!;
  const loadingEl = document.querySelector<HTMLElement>('#aiColorLoading')!;
  const errorEl = document.querySelector<HTMLElement>('#aiColorError')!;
  const bodyEl = document.querySelector<HTMLDivElement>('#aiColorBody')!;
  const footerEl = document.querySelector<HTMLElement>('#aiColorFooter')!;
  const applyBtn = document.querySelector<HTMLButtonElement>('#aiColorApplyBtn')!;
  const saveBtn = document.querySelector<HTMLButtonElement>('#aiColorSaveBtn')!;
  const libraryEl = document.querySelector<HTMLElement>('#aiColorLibrary')!;
  const libraryList = document.querySelector<HTMLDivElement>('#aiColorLibraryList')!;
  const libraryEmpty = document.querySelector<HTMLElement>('#aiColorLibraryEmpty')!;
  const libraryBack = document.querySelector<HTMLButtonElement>('#aiColorLibraryBack')!;
  const mainBlock = document.querySelector<HTMLElement>('#aiColorMainBlock')!;

  let latest: AiColorAnalysis | null = null;
  let lastRunVibe: AiLookVibe | null = null;

  document.querySelectorAll<HTMLInputElement>('input[name="aiLookVibe"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (r.checked) storeVibePreference(r.value as AiLookVibe);
    });
  });
  syncVibeRadiosFromStorage();

  function setVibeFieldsetDisabled(disabled: boolean) {
    document.querySelector<HTMLFieldSetElement>('#aiColorVibeFieldset')!.disabled = disabled;
  }

  function toast(msg: string) {
    if (args.statusEl) args.statusEl.textContent = msg;
  }

  function syncApplyButton() {
    applyBtn.hidden = !latest?.look_hex;
  }

  function setOpen(open: boolean) {
    overlay.hidden = !open;
    if (!open) {
      showLibrary(false);
      errorEl.hidden = true;
      loadingEl.hidden = true;
    }
  }

  function showLibrary(show: boolean) {
    libraryEl.hidden = !show;
    mainBlock.hidden = show;
    if (show) {
      loadingEl.hidden = true;
      renderLibrary();
    }
  }

  function renderLibrary() {
    const reads = readSavedReads().sort((a, b) => b.savedAt - a.savedAt);
    libraryEmpty.hidden = reads.length > 0;
    libraryList.innerHTML = reads
      .map(
        (r) => `
        <div class="ai-color-lib-row" data-read-id="${escapeHtml(r.id)}">
          <div class="ai-color-lib-meta">
            <span class="ai-color-lib-title">${escapeHtml(r.headline)}</span>
            <span class="ai-color-lib-date">${new Date(r.savedAt).toLocaleString()}</span>
            ${
              r.lookVibe
                ? `<span class="ai-color-lib-vibe">${escapeHtml(AI_LOOK_VIBE_LABELS[r.lookVibe])} look</span>`
                : ''
            }
          </div>
          <div class="ai-color-lib-actions">
            ${
              r.analysis.look_hex
                ? `<button type="button" class="ai-color-mini accent" data-act="apply" data-id="${escapeHtml(r.id)}">Apply</button>`
                : ''
            }
            <button type="button" class="ai-color-mini" data-act="view" data-id="${escapeHtml(r.id)}">View</button>
            <button type="button" class="ai-color-mini danger" data-act="del" data-id="${escapeHtml(r.id)}">×</button>
          </div>
        </div>
      `,
      )
      .join('');
  }

  function openRead(r: SavedAiRead) {
    latest = r.analysis;
    showLibrary(false);
    bodyEl.innerHTML = renderAnalysisHtml(r.analysis, r.lookVibe ?? null);
    footerEl.hidden = false;
    syncApplyButton();
    errorEl.hidden = true;
    toast('Opened a saved read.');
  }

  libraryList.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act][data-id]');
    if (!btn) return;
    const id = btn.dataset.id!;
    const reads = readSavedReads();
    const r = reads.find((x) => x.id === id);
    if (!r) return;
    if (btn.dataset.act === 'view') openRead(r);
    if (btn.dataset.act === 'apply' && r.analysis.look_hex) {
      applyMakeupLookFromHex(r.analysis.look_hex);
      args.onAfterApplyLook?.(r.lookVibe ?? null);
      setOpen(false);
      toast('Look applied from scrapbook.');
    }
    if (btn.dataset.act === 'del') {
      writeSavedReads(reads.filter((x) => x.id !== id));
      renderLibrary();
      toast('Removed from scrapbook.');
    }
  });

  document.getElementById('aiColorReadTrigger')?.addEventListener('click', (e) => {
    e.preventDefault();
    setOpen(true);
    errorEl.hidden = true;
    bodyEl.innerHTML = '';
    footerEl.hidden = true;
    latest = null;
    lastRunVibe = null;
    showLibrary(false);
    syncVibeRadiosFromStorage();
  });

  closeBtn.addEventListener('click', () => setOpen(false));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) setOpen(false);
  });

  libraryBtn.addEventListener('click', () => {
    showLibrary(true);
  });
  libraryBack.addEventListener('click', () => showLibrary(false));

  bodyEl.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-hex]');
    if (!chip?.dataset.copyHex) return;
    const h = chip.dataset.copyHex;
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(h).then(
        () => toast(`Copied ${h}`),
        () => toast('Could not copy to clipboard.'),
      );
    } else {
      toast('Clipboard not available in this context.');
    }
  });

  applyBtn.addEventListener('click', () => {
    if (!latest?.look_hex) return;
    applyMakeupLookFromHex(latest.look_hex);
    args.onAfterApplyLook?.(lastRunVibe ?? readVibeFromDom());
    setOpen(false);
    toast('Look applied to try-on.');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) setOpen(false);
  });

  runBtn.addEventListener('click', async () => {
    errorEl.hidden = true;
    bodyEl.innerHTML = '';
    footerEl.hidden = true;
    latest = null;
    lastRunVibe = null;

    const blob = await captureMirroredJpeg(args.video);
    if (!blob) {
      errorEl.textContent = 'Camera is not ready yet — give it a sec and try again.';
      errorEl.hidden = false;
      return;
    }

    loadingEl.hidden = false;
    runBtn.disabled = true;
    setVibeFieldsetDisabled(true);
    toast('Sending snapshot for color read…');

    try {
      const fd = new FormData();
      fd.append('image', blob, 'snapshot.jpg');
      fd.append('look_vibe', readVibeFromDom());
      const res = await fetch('/api/analyze-makeup-colors', { method: 'POST', body: fd });
      const rawText = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        if (!res.ok) throw new Error(rawText.slice(0, 240) || `Request failed (${res.status})`);
      }

      if (!res.ok) {
        const detail = json.detail;
        let msg: string;
        if (typeof detail === 'string') msg = detail;
        else if (Array.isArray(detail))
          msg = detail
            .map((item) =>
              item && typeof item === 'object' && 'msg' in item ? String((item as { msg: unknown }).msg) : JSON.stringify(item),
            )
            .join(' ');
        else msg = `Request failed (${res.status})`;
        throw new Error(msg);
      }

      const analysisRaw = json.analysis as Record<string, unknown> | undefined;
      if (!analysisRaw || typeof analysisRaw !== 'object') {
        throw new Error('Unexpected response shape from server.');
      }

      const analysis = normalizeAnalysis(analysisRaw);
      latest = analysis;
      lastRunVibe = readVibeFromDom();
      bodyEl.innerHTML = renderAnalysisHtml(analysis, lastRunVibe);
      footerEl.hidden = false;
      syncApplyButton();
      toast('Color read ready.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errorEl.textContent = msg;
      errorEl.hidden = false;
      toast('Color read failed — see message in panel.');
    } finally {
      loadingEl.hidden = true;
      runBtn.disabled = false;
      setVibeFieldsetDisabled(false);
    }
  });

  saveBtn.addEventListener('click', () => {
    if (!latest) return;
    const entry: SavedAiRead = {
      id: newId(),
      savedAt: Date.now(),
      headline: latest.headline,
      lookVibe: lastRunVibe ?? readVibeFromDom(),
      analysis: latest,
    };
    const all = readSavedReads();
    all.push(entry);
    writeSavedReads(all);
    toast('Saved to scrapbook.');
  });
}
