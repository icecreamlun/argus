/** Shared UI state, owned by index.ts and read by components. */
import type { OverlayMode, QuakeScenario, UsgsEvent } from '../contracts';

/** monitoring → (event) alert → shaking → aftermath → (reset) monitoring */
export type Phase = 'monitoring' | 'alert' | 'shaking' | 'aftermath';

export interface UiState {
  phase: Phase;
  event: UsgsEvent | null;
  scenario: QuakeScenario | null;
  simSeconds: number;
  playing: boolean;
  timeScale: number;
  timeOfDay: number;
  overlay: OverlayMode;
  night: boolean;
}
