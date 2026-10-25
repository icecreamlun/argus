/**
 * Fire-light gating (integration-level perf fix, no visual change).
 *
 * Quake FX pools 6 PointLights ("fireLight0..5") and keeps them in the scene from boot at intensity 0, so the
 * light count never changes and starting a quake never recompiles every material. The price: every lit
 * fragment in every view evaluates 6 extra point lights all the time (~2.5 ms/frame at 1600×900 measured).
 *
 * Here the lights stay out of the light list (visible = false) until a fire actually burns, and the
 * "with fire lights" program variants are compiled in the background beforehand. three.js keeps each
 * material's programs keyed by their parameters (light counts included), so once both variants exist,
 * switching is just a program bind — no compile, no stall.
 */
import * as THREE from 'three';

export interface FireLightGate {
  /** Call once per frame: enables the lights as soon as any has intensity. */
  update(): void;
  /** Compile the lit variants in the background (call when a quake starts). */
  prewarm(): void;
  /** Back to the cheap state (quake reset). */
  disable(): void;
}

export function createFireLightGate(scene: THREE.Scene, camera: THREE.Camera, renderer: THREE.WebGLRenderer): FireLightGate {
  const lights: THREE.PointLight[] = [];
  scene.traverse((o) => {
    if ((o as THREE.PointLight).isPointLight && o.name.startsWith('fireLight')) lights.push(o as THREE.PointLight);
  });
  // Any render target makes three pick the same (linear-output) program variant the post chain's scene pass uses.
  const probeTarget = new THREE.WebGLRenderTarget(1, 1);
  let on = false;

  const setVisible = (v: boolean) => {
    for (const l of lights) l.visible = v;
  };
  setVisible(false);

  return {
    update() {
      if (on || !lights.length) return;
      for (const l of lights) {
        if (l.intensity > 0) {
          on = true;
          setVisible(true);
          return;
        }
      }
    },
    prewarm() {
      if (!lights.length || on) return;
      const prev = renderer.getRenderTarget();
      setVisible(true);
      try {
        renderer.setRenderTarget(probeTarget);
        // Synchronous part gathers lights and creates the programs; linking finishes in the background.
        void renderer.compileAsync(scene, camera).catch(() => {});
      } catch {
        /* compileAsync unavailable: the lights will compile on first use */
      } finally {
        renderer.setRenderTarget(prev);
        setVisible(false);
      }
    },
    disable() {
      on = false;
      setVisible(false);
    },
  };
}
