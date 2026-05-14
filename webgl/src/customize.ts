import { hexToRgb01 } from './utils';
import { DEFAULT_BLUSH_HEX, makeupColors } from './colors';

/**
 * Customize panel: curated swatch palettes per product. Picking a swatch updates
 * the shared `makeupColors` so the next frame paints with the new color, and
 * resyncs the matching slider's chrome (`--c`) so the dot/fill/thumb on the HUD
 * mirror the chosen makeup color. Concealer is intentionally absent — it
 * auto-tracks the user's live skin tone.
 *
 * `initCustomizePanel` is called from `main.ts` AFTER `app.innerHTML` has been
 * set, so `.stage` exists. We avoid top-level DOM side effects on purpose.
 */

type CustomizeId = 'lip' | 'shadow' | 'liner' | 'brow' | 'blush' | 'nose';

type CustomizeDef = {
  id: CustomizeId;
  label: string;
  sliderId: string;
  swatches: string[];
  apply: (rgb: [number, number, number]) => void;
};

const customizeDefs: CustomizeDef[] = [
  {
    id: 'lip',
    label: 'Lips',
    sliderId: 'lipIntensity',
    swatches: ['#D4547A', '#B6304A', '#8B2C4A', '#E66A5A', '#D49080', '#B07090', '#6B2C4F'],
    apply: (rgb) => {
      makeupColors.lipstickTop = rgb;
      makeupColors.lipstickBottom = rgb;
    },
  },
  {
    id: 'shadow',
    label: 'Eyeshadow',
    sliderId: 'eyeShadowIntensity',
    swatches: ['#A06CC3', '#B07A4A', '#D4B888', '#4A6B3C', '#2E4A78', '#4D4350', '#C28890'],
    apply: (rgb) => {
      makeupColors.eyeShadowCrease = rgb;
      makeupColors.eyeShadowLash = rgb;
    },
  },
  {
    id: 'liner',
    label: 'Eyeliner',
    sliderId: 'eyeLinerIntensity',
    swatches: ['#5E3B7A', '#1A1014', '#5E3B30', '#1F2B4A', '#2F2A36'],
    apply: (rgb) => {
      makeupColors.eyeLiner = rgb;
    },
  },
  {
    id: 'brow',
    label: 'Brows',
    sliderId: 'browIntensity',
    swatches: ['#8B5A3C', '#A07458', '#5B3D26', '#2B1F18', '#6E4030', '#6B5648'],
    apply: (rgb) => {
      makeupColors.brow = rgb;
    },
  },
  {
    id: 'blush',
    label: 'Blush',
    sliderId: 'blushIntensity',
    swatches: [
      DEFAULT_BLUSH_HEX,
      '#F4778F',
      '#F39A6E',
      '#B0506A',
      '#F0AC8E',
      '#C77B9A',
      '#E89AAA',
    ],
    apply: (rgb) => {
      makeupColors.blush = rgb;
    },
  },
  {
    id: 'nose',
    label: 'Nose',
    sliderId: 'noseIntensity',
    swatches: ['#B08572', '#9E7A5E', '#62504A', '#7E5D4A', '#4A3328'],
    apply: (rgb) => {
      makeupColors.noseContour = rgb;
    },
  },
];

/** Euclidean distance² in RGB 0–1 space; used to pick which swatch best matches startup colors. */
export function closestSwatchIndex(rgb: [number, number, number], hexes: string[]): number {
  let bestIdx = 0;
  let bestD = Infinity;
  for (let i = 0; i < hexes.length; i++) {
    const c = hexToRgb01(hexes[i]);
    const d =
      (rgb[0] - c[0]) * (rgb[0] - c[0]) +
      (rgb[1] - c[1]) * (rgb[1] - c[1]) +
      (rgb[2] - c[2]) * (rgb[2] - c[2]);
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function initCustomizePanel(): void {
  const stageEl = document.querySelector<HTMLDivElement>('.stage');
  if (!stageEl) throw new Error('initCustomizePanel: .stage not in DOM yet');

  const blushDef = customizeDefs.find((d) => d.id === 'blush')!;
  const blushSelectedIdx = closestSwatchIndex(makeupColors.blush, blushDef.swatches);

  const customizeRowsHTML = customizeDefs
    .map((def, rowIdx) => {
      const selectedSwIdx = def.id === 'blush' ? blushSelectedIdx : 0;
      const swatches = def.swatches
        .map(
          (hex, swIdx) => `
          <button
            class="swatch${swIdx === selectedSwIdx ? ' selected' : ''}"
            type="button"
            data-row="${rowIdx}"
            data-hex="${hex}"
            style="--c:${hex}"
            aria-label="${def.label} ${hex}"
          ></button>
        `,
        )
        .join('');
      return `
        <div class="customize-row" data-row-id="${def.id}">
          <span class="customize-label">${def.label}</span>
          <div class="swatch-grid">${swatches}</div>
        </div>
      `;
    })
    .join('');

  stageEl.insertAdjacentHTML(
    'beforeend',
    `
    <button class="customize-btn" id="customizeBtn" type="button" aria-label="Customize colors" aria-expanded="false">
      <span class="customize-btn-dot"></span>
      <span class="customize-btn-label">Customize</span>
    </button>
    <aside class="customize-panel" id="customizePanel" hidden>
      <div class="customize-header">
        <span class="customize-title">Customize colors</span>
        <button class="customize-close" id="customizeClose" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="customize-rows">${customizeRowsHTML}</div>
      <div class="customize-note">Concealer auto-matches your skin tone</div>
    </aside>
  `,
  );

  // Blush HUD chrome (`--c`) should mirror the blush pigment + selected swatch on first paint.
  const blushChosenHex = blushDef.swatches[blushSelectedIdx];
  const blushSliderRow = document.querySelector<HTMLElement>(`.slider-row:has(#${blushDef.sliderId})`);
  if (blushSliderRow) blushSliderRow.style.setProperty('--c', blushChosenHex);

  const customizeBtn = document.querySelector<HTMLButtonElement>('#customizeBtn')!;
  const customizePanel = document.querySelector<HTMLElement>('#customizePanel')!;
  const customizeCloseBtn = document.querySelector<HTMLButtonElement>('#customizeClose')!;

  function setCustomizeOpen(open: boolean) {
    customizePanel.hidden = !open;
    customizeBtn.setAttribute('aria-expanded', String(open));
    customizeBtn.classList.toggle('open', open);
  }

  customizeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setCustomizeOpen(customizePanel.hidden !== false);
  });

  customizeCloseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setCustomizeOpen(false);
  });

  // Swallow clicks inside the panel so nested controls don't confuse other handlers.
  customizePanel.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !customizePanel.hidden) setCustomizeOpen(false);
  });

  // Swatch clicks: apply the color, re-sync the slider chrome, move .selected within the row.
  Array.from(customizePanel.querySelectorAll<HTMLButtonElement>('.swatch')).forEach((swatch) => {
    swatch.addEventListener('click', () => {
      const rowIdx = Number(swatch.dataset.row);
      const def = customizeDefs[rowIdx];
      const hex = swatch.dataset.hex!;
      def.apply(hexToRgb01(hex));

      const sliderRow = document.querySelector<HTMLElement>(`.slider-row:has(#${def.sliderId})`);
      if (sliderRow) sliderRow.style.setProperty('--c', hex);

      const parent = swatch.parentElement;
      if (parent) {
        Array.from(parent.querySelectorAll('.swatch.selected')).forEach((sib) => sib.classList.remove('selected'));
      }
      swatch.classList.add('selected');
    });
  });
}

/** AI color read palette: maps to `makeupColors` + HUD slider chrome. */
export type MakeupLookHex = {
  lip: string;
  eye_shadow: string;
  liner: string;
  brow: string;
  blush: string;
};

/** Apply an AI-suggested hex palette to the live try-on and sync HUD / Customize selection. */
export function applyMakeupLookFromHex(look: MakeupLookHex): void {
  const lip = hexToRgb01(look.lip);
  makeupColors.lipstickTop = lip;
  makeupColors.lipstickBottom = [...lip];
  const shadow = hexToRgb01(look.eye_shadow);
  makeupColors.eyeShadowCrease = shadow;
  makeupColors.eyeShadowLash = [...shadow];
  makeupColors.eyeLiner = hexToRgb01(look.liner);
  makeupColors.brow = hexToRgb01(look.brow);
  makeupColors.blush = hexToRgb01(look.blush);

  const sync: [string, string][] = [
    ['lipIntensity', look.lip],
    ['eyeShadowIntensity', look.eye_shadow],
    ['eyeLinerIntensity', look.liner],
    ['browIntensity', look.brow],
    ['blushIntensity', look.blush],
  ];
  for (const [sliderId, hex] of sync) {
    const row = document.querySelector<HTMLElement>(`.slider-row:has(#${sliderId})`);
    if (row) row.style.setProperty('--c', hex.trim().startsWith('#') ? hex.trim().toUpperCase() : `#${hex.trim().toUpperCase()}`);
  }
  refreshCustomizeSwatchSelection();
}

/** After loading a saved look, move `.selected` to the nearest swatch per row without changing RGB (exact colors stay). */
export function refreshCustomizeSwatchSelection(): void {
  customizeDefs.forEach((def) => {
    let rgb: [number, number, number];
    switch (def.id) {
      case 'lip':
        rgb = makeupColors.lipstickTop;
        break;
      case 'shadow':
        rgb = makeupColors.eyeShadowCrease;
        break;
      case 'liner':
        rgb = makeupColors.eyeLiner;
        break;
      case 'brow':
        rgb = makeupColors.brow;
        break;
      case 'blush':
        rgb = makeupColors.blush;
        break;
      case 'nose':
        rgb = makeupColors.noseContour;
        break;
      default:
        return;
    }
    const idx = closestSwatchIndex(rgb, def.swatches);
    const rowEl = document.querySelector<HTMLElement>(`.customize-row[data-row-id="${def.id}"]`);
    if (!rowEl) return;
    Array.from(rowEl.querySelectorAll<HTMLButtonElement>('.swatch')).forEach((btn, swIdx) => {
      btn.classList.toggle('selected', swIdx === idx);
    });
  });
}
