import { rgb01ToHex } from './utils';
import type { MakeupColorsMutable } from './colors';
import { refreshCustomizeSwatchSelection } from './customize';

const STORAGE_KEY = 'doremi-saved-makeup-looks-v1';

export type MakeupLookSnapshotV1 = {
  v: 1;
  colors: {
    lipstickTop: [number, number, number];
    lipstickBottom: [number, number, number];
    eyeShadowCrease: [number, number, number];
    eyeShadowLash: [number, number, number];
    eyeLiner: [number, number, number];
    brow: [number, number, number];
    blush: [number, number, number];
    noseContour: [number, number, number];
  };
  /** Slider id → 0–100. Concealer included; live skin tone for concealer is not persisted. */
  sliders: Record<string, number>;
};

export type SavedLookEntry = {
  id: string;
  name: string;
  savedAt: number;
  snapshot: MakeupLookSnapshotV1;
};

function newLookId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readStoredLooks(): SavedLookEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidSavedLookEntry);
  } catch {
    return [];
  }
}

function isValidSavedLookEntry(x: unknown): x is SavedLookEntry {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.savedAt !== 'number') return false;
  const snap = o.snapshot;
  if (!snap || typeof snap !== 'object') return false;
  const s = snap as Record<string, unknown>;
  if (s.v !== 1 || typeof s.sliders !== 'object' || !s.colors) return false;
  return true;
}

function writeStoredLooks(looks: SavedLookEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(looks));
  } catch (e) {
    console.warn('Could not save looks to localStorage', e);
  }
}

function captureSnapshot(
  colors: MakeupColorsMutable,
  sliderIds: readonly string[],
): MakeupLookSnapshotV1 {
  const sliders: Record<string, number> = {};
  for (const id of sliderIds) {
    const el = document.querySelector<HTMLInputElement>(`#${id}`);
    if (!el) continue;
    const n = Number(el.value);
    sliders[id] = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
  }
  return {
    v: 1,
    colors: {
      lipstickTop: [...colors.lipstickTop] as [number, number, number],
      lipstickBottom: [...colors.lipstickBottom] as [number, number, number],
      eyeShadowCrease: [...colors.eyeShadowCrease] as [number, number, number],
      eyeShadowLash: [...colors.eyeShadowLash] as [number, number, number],
      eyeLiner: [...colors.eyeLiner] as [number, number, number],
      brow: [...colors.brow] as [number, number, number],
      blush: [...colors.blush] as [number, number, number],
      noseContour: [...colors.noseContour] as [number, number, number],
    },
    sliders,
  };
}

function applySnapshot(
  colors: MakeupColorsMutable,
  snapshot: MakeupLookSnapshotV1,
  sliderIds: readonly string[],
) {
  const c = snapshot.colors;
  colors.lipstickTop = [...c.lipstickTop];
  colors.lipstickBottom = [...c.lipstickBottom];
  colors.eyeShadowCrease = [...c.eyeShadowCrease];
  colors.eyeShadowLash = [...c.eyeShadowLash];
  colors.eyeLiner = [...c.eyeLiner];
  colors.brow = [...c.brow];
  colors.blush = [...c.blush];
  colors.noseContour = [...c.noseContour];

  const sliderChrome: [string, [number, number, number]][] = [
    ['lipIntensity', colors.lipstickTop],
    ['concealerIntensity', colors.liveSkinTone],
    ['eyeShadowIntensity', colors.eyeShadowCrease],
    ['eyeLinerIntensity', colors.eyeLiner],
    ['browIntensity', colors.brow],
    ['blushIntensity', colors.blush],
    ['noseIntensity', colors.noseContour],
  ];

  for (const id of sliderIds) {
    const el = document.querySelector<HTMLInputElement>(`#${id}`);
    if (!el) continue;
    const v = snapshot.sliders[id];
    if (typeof v === 'number' && Number.isFinite(v)) {
      el.value = String(Math.max(0, Math.min(100, Math.round(v))));
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  for (const [sliderId, rgb] of sliderChrome) {
    const row = document.querySelector<HTMLElement>(`.slider-row:has(#${sliderId})`);
    if (row) row.style.setProperty('--c', rgb01ToHex(rgb[0], rgb[1], rgb[2]));
  }

  refreshCustomizeSwatchSelection();
}

export type InitSavedLooksArgs = {
  makeupColors: MakeupColorsMutable;
  /** Same ids as your range inputs, e.g. `sliderDefs.map((s) => s.id)`. */
  sliderIds: readonly string[];
  statusEl: HTMLElement | null;
  /** e.g. exit “No makeup” mode so loaded sliders apply correctly. */
  beforeRestoreLook?: () => void;
};

export function initSavedLooksPanel(args: InitSavedLooksArgs): void {
  const stageEl = document.querySelector<HTMLDivElement>('.stage');
  if (!stageEl) throw new Error('initSavedLooksPanel: .stage not in DOM yet');

  stageEl.insertAdjacentHTML(
    'beforeend',
    `
    <button class="saved-looks-btn" id="savedLooksBtn" type="button" aria-label="Saved looks" aria-expanded="false">
      <span class="saved-looks-btn-icon" aria-hidden="true">♡</span>
      <span class="saved-looks-btn-label">Saved looks</span>
    </button>
    <aside class="saved-looks-panel" id="savedLooksPanel" hidden>
      <div class="saved-looks-header">
        <span class="saved-looks-title">Saved looks</span>
        <button class="saved-looks-close" id="savedLooksClose" type="button" aria-label="Close">&times;</button>
      </div>
      <p class="saved-looks-hint">Save your current colors + sliders. Concealer still tracks live skin when the camera runs.</p>
      <div class="saved-looks-save-row">
        <input class="saved-looks-name-input" id="savedLookName" type="text" maxlength="40" placeholder="Name this look…" autocomplete="off" />
        <button class="saved-looks-save-btn" id="savedLookSaveBtn" type="button">Save</button>
      </div>
      <div class="saved-looks-list" id="savedLooksList"></div>
      <p class="saved-looks-empty" id="savedLooksEmpty">No looks saved yet.</p>
    </aside>
  `,
  );

  const btn = document.querySelector<HTMLButtonElement>('#savedLooksBtn')!;
  const panel = document.querySelector<HTMLElement>('#savedLooksPanel')!;
  const closeBtn = document.querySelector<HTMLButtonElement>('#savedLooksClose')!;
  const nameInput = document.querySelector<HTMLInputElement>('#savedLookName')!;
  const saveBtn = document.querySelector<HTMLButtonElement>('#savedLookSaveBtn')!;
  const listEl = document.querySelector<HTMLDivElement>('#savedLooksList')!;
  const emptyEl = document.querySelector<HTMLParagraphElement>('#savedLooksEmpty')!;

  function setOpen(open: boolean) {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('open', open);
    if (open) nameInput.focus();
  }

  function toast(msg: string) {
    if (args.statusEl) args.statusEl.textContent = msg;
  }

  function renderList() {
    const looks = readStoredLooks().sort((a, b) => b.savedAt - a.savedAt);
    emptyEl.hidden = looks.length > 0;
    listEl.innerHTML = looks
      .map(
        (look) => `
        <div class="saved-look-row" data-look-id="${look.id}">
          <div class="saved-look-info">
            <span class="saved-look-name">${escapeHtml(look.name)}</span>
            <span class="saved-look-date">${formatSavedAt(look.savedAt)}</span>
          </div>
          <div class="saved-look-actions">
            <button type="button" class="saved-look-load" data-action="load" data-id="${look.id}">Load</button>
            <button type="button" class="saved-look-delete" data-action="delete" data-id="${look.id}" aria-label="Delete ${escapeHtml(look.name)}">×</button>
          </div>
        </div>
      `,
      )
      .join('');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(panel.hidden !== false);
    if (!panel.hidden) renderList();
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(false);
  });

  panel.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('click', () => {
    if (!panel.hidden) setOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) setOpen(false);
  });

  saveBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) {
      toast('Type a name for this look.');
      nameInput.focus();
      return;
    }
    const snapshot = captureSnapshot(args.makeupColors, args.sliderIds);
    const entry: SavedLookEntry = {
      id: newLookId(),
      name: name.slice(0, 40),
      savedAt: Date.now(),
      snapshot,
    };
    const looks = readStoredLooks();
    looks.push(entry);
    writeStoredLooks(looks);
    nameInput.value = '';
    renderList();
    toast(`Saved “${entry.name}”.`);
  });

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveBtn.click();
    }
  });

  listEl.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action][data-id]');
    if (!t) return;
    const id = t.dataset.id!;
    const action = t.dataset.action;
    const looks = readStoredLooks();
    const idx = looks.findIndex((x) => x.id === id);
    if (idx < 0) return;

    if (action === 'load') {
      args.beforeRestoreLook?.();
      applySnapshot(args.makeupColors, looks[idx].snapshot, args.sliderIds);
      toast(`Loaded “${looks[idx].name}”.`);
      setOpen(false);
    } else if (action === 'delete') {
      const removed = looks.splice(idx, 1)[0];
      writeStoredLooks(looks);
      renderList();
      toast(removed ? `Removed “${removed.name}”.` : 'Look removed.');
    }
  });

  renderList();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSavedAt(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
