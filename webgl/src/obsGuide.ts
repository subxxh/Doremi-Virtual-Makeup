export function initObsGuide(): void {
  const stageEl = document.querySelector<HTMLDivElement>('.stage');
  if (!stageEl) throw new Error('initObsGuide: .stage not in DOM yet');

  stageEl.insertAdjacentHTML(
    'beforeend',
    `
    <div class="obs-overlay" id="obsOverlay" hidden>
      <div class="obs-shell">
        <div class="obs-topbar">
          <span class="obs-title">Use your filter in Zoom</span>
          <button class="obs-close" id="obsClose" type="button" aria-label="Close">&times;</button>
        </div>
        <p class="obs-lede">Keep this page open in Chrome — OBS will capture the window. Your filter appears in Zoom with full quality.</p>
        <ol class="obs-steps">
          <li>
            <span class="obs-step-num">1</span>
            <div class="obs-step-body">
              <strong>Download OBS Studio</strong> — free, one-time install<br>
              <a class="obs-link" href="https://obsproject.com" target="_blank" rel="noopener noreferrer">obsproject.com</a>
            </div>
          </li>
          <li>
            <span class="obs-step-num">2</span>
            <div class="obs-step-body">
              <strong>Add a Window Capture source</strong><br>
              In OBS: click <kbd>+</kbd> under Sources &rarr; choose <em>Window Capture</em> &rarr; select your Chrome window from the dropdown
            </div>
          </li>
          <li>
            <span class="obs-step-num">3</span>
            <div class="obs-step-body">
              <strong>Crop to the app</strong> (optional)<br>
              Hold <kbd>Alt</kbd> and drag the edges of the source in the preview to trim out browser chrome
            </div>
          </li>
          <li>
            <span class="obs-step-num">4</span>
            <div class="obs-step-body">
              <strong>Start Virtual Camera</strong><br>
              Click <em>Start Virtual Camera</em> in the bottom-right panel of OBS
            </div>
          </li>
          <li>
            <span class="obs-step-num">5</span>
            <div class="obs-step-body">
              <strong>Select it in Zoom</strong><br>
              Zoom &rarr; Settings &rarr; Video &rarr; Camera &rarr; pick <em>OBS Virtual Camera</em>
            </div>
          </li>
        </ol>
        <p class="obs-tip">Keep both this page and OBS open during your call. Minimising Chrome may pause the capture — use a separate monitor or keep it in the background at a small size.</p>
      </div>
    </div>
  `,
  );

  const overlay = document.querySelector<HTMLDivElement>('#obsOverlay')!;
  const closeBtn = document.querySelector<HTMLButtonElement>('#obsClose')!;

  function open() {
    overlay.hidden = false;
  }
  function close() {
    overlay.hidden = true;
  }

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  const triggerBtn = document.querySelector<HTMLButtonElement>('#obsGuideBtn');
  triggerBtn?.addEventListener('click', open);
}
