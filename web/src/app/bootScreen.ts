/**
 * Boot screen driver. The markup + styles live inline in index.html so they paint before any module
 * loads; this file only advances the progress bar, fades it out, or turns it into an error card.
 */
const root = () => document.getElementById('boot');

export function bootProgress(label: string, fraction: number): void {
  const el = root();
  if (!el) return;
  const text = el.querySelector<HTMLElement>('.boot__status');
  if (text) text.textContent = label;
  el.style.setProperty('--boot-p', String(Math.max(0, Math.min(1, fraction))));
}

/** Fade the boot screen out (instantly when the HUD is off, so harness screenshots are clean). */
export function bootDone(instant = false): void {
  const el = root();
  if (!el) return;
  el.style.setProperty('--boot-p', '1');
  if (instant) {
    el.remove();
    return;
  }
  el.classList.add('is-done');
  window.setTimeout(() => el.remove(), 700);
}

export function bootFailed(message: string): void {
  const el = root();
  if (!el) {
    const pre = document.createElement('pre');
    pre.className = 'boot-error';
    pre.textContent = `Argus failed to start:\n${message}`;
    document.body.appendChild(pre);
    return;
  }
  el.classList.add('is-error');
  const text = el.querySelector<HTMLElement>('.boot__status');
  if (text) text.textContent = `Argus failed to start — ${message}`;
}
