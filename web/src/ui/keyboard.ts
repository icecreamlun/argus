/** Global shortcuts. Ignored while typing in form fields or when a modifier key is held. */

export interface KeyActions {
  pauseToggle(): void;
  reset(): void;
  preset(index: number): void;
  closeInspector(): boolean;
  toggleHud(): void;
}

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) return !['range', 'checkbox', 'radio', 'button', 'submit'].includes(t.type);
  return false;
}

export function bindKeyboard(a: KeyActions): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (isTyping(e.target)) return;
    if (e.code === 'Space') {
      e.preventDefault(); // also stops a focused button from being activated
      a.pauseToggle();
    } else if (e.key === 'r' || e.key === 'R') {
      a.reset();
    } else if (e.key === 'h' || e.key === 'H') {
      a.toggleHud();
    } else if (e.key === 'Escape') {
      if (a.closeInspector()) e.preventDefault();
    } else if (/^[1-9]$/.test(e.key)) {
      a.preset(Number(e.key) - 1);
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
