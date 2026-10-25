/**
 * Click-to-focus: fly the camera to a building (and select it) or to a world point.
 * Thin wrapper over window.__argus.focus / focusPoint (defined in main.ts), so pins, incident markers and
 * list rows can call it without new wiring through the UI handlers.
 */
type FocusApi = { focus?(id: string | null): void; focusPoint?(x: number, y: number, z: number, span?: number): void };
const api = () => (window as unknown as { __argus?: FocusApi }).__argus;

export function focusBuilding(id: string | null | undefined): void {
  if (id) api()?.focus?.(id);
}

export function focusPoint(x: number, y: number, z: number, span?: number): void {
  api()?.focusPoint?.(x, y, z, span);
}
