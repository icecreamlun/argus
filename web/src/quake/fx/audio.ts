/**
 * Synthesised earthquake audio (WebAudio, no assets): a deep brown-noise rumble whose level follows the
 * shaking envelope at the camera, a mid-band rattle (windows, contents) during strong motion, and crash
 * bursts for collapses — delayed by the distance to the camera at the speed of sound (343 m/s).
 * Starts only after a user gesture (autoplay policy) and never in automated/headless browsers.
 */

export class QuakeAudio {
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  private rumble: GainNode | null = null;
  private rattle: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private enabled = false;
  private gestureBound = false;

  constructor() {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav || (nav as Navigator & { webdriver?: boolean }).webdriver) return;
    if (typeof window === 'undefined' || !('AudioContext' in window)) return;
    this.enabled = true;
    this.bindGesture();
  }

  private bindGesture(): void {
    if (this.gestureBound) return;
    this.gestureBound = true;
    const start = () => {
      window.removeEventListener('pointerdown', start);
      window.removeEventListener('keydown', start);
      this.init();
    };
    window.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);
  }

  private init(): void {
    if (!this.enabled || this.ac) return;
    try {
      const ac = new AudioContext();
      this.ac = ac;
      const master = ac.createGain();
      master.gain.value = 0.7;
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 5;
      master.connect(comp).connect(ac.destination);
      this.master = master;
      // 4 s of brown noise, looped.
      const len = ac.sampleRate * 4;
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      let seed = 12345;
      for (let i = 0; i < len; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const w = seed / 4294967296 - 0.5;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
      this.noise = buf;
      const mk = (freq: number, type: BiquadFilterType, q: number) => {
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.playbackRate.value = type === 'lowpass' ? 1 : 3.2;
        const f = ac.createBiquadFilter();
        f.type = type;
        f.frequency.value = freq;
        f.Q.value = q;
        const g = ac.createGain();
        g.gain.value = 0;
        src.connect(f).connect(g).connect(master);
        src.start();
        return g;
      };
      this.rumble = mk(85, 'lowpass', 0.9);
      this.rattle = mk(420, 'bandpass', 1.4);
    } catch {
      this.enabled = false;
    }
  }

  /** intensity = local envelope × PGV (m/s); pPhase 0..1. */
  update(intensity: number, pPhase: number, live: boolean): void {
    if (!this.ac || !this.rumble || !this.rattle) return;
    const now = this.ac.currentTime;
    const k = live ? 1 : 0;
    const rum = Math.min(1, intensity * 2.2 + pPhase * 0.12) * k;
    const rat = Math.min(0.6, Math.max(0, intensity - 0.05) * 1.4 + pPhase * 0.1) * k;
    this.rumble.gain.setTargetAtTime(rum, now, 0.08);
    this.rattle.gain.setTargetAtTime(rat * 0.35, now, 0.06);
  }

  /** A collapse at `distance` metres from the listener, with dust mass proxy `mass`. */
  crash(distance: number, mass: number): void {
    if (!this.ac || !this.noise || !this.master) return;
    const ac = this.ac;
    const delay = distance / 343;
    const loud = Math.min(1, (Math.sqrt(mass) / 60) * (220 / Math.max(120, distance)));
    if (loud < 0.03) return;
    const src = ac.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 1.6;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = Math.max(180, 900 * (300 / Math.max(300, distance)));
    const g = ac.createGain();
    const t0 = ac.currentTime + delay;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(loud, t0 + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 3.2);
    src.connect(f).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + 3.4);
  }

  silence(): void {
    if (!this.ac || !this.rumble || !this.rattle) return;
    const now = this.ac.currentTime;
    this.rumble.gain.setTargetAtTime(0, now, 0.1);
    this.rattle.gain.setTargetAtTime(0, now, 0.1);
  }
}
