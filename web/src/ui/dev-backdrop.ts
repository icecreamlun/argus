/**
 * Dev-only stand-in for the 3D city: a painted aerial pseudo-city (perspective boxes, sky, haze) so
 * glass panels are judged over busy, realistic luminance instead of a flat colour.
 */
import { rng } from './dev-mocks';

type V3 = [number, number, number];

interface Box {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  tone: number;
}

export function paintBackdrop(canvas: HTMLCanvasElement, night: number): void {
  const W = (canvas.width = innerWidth);
  const H = (canvas.height = innerHeight);
  const c = canvas.getContext('2d')!;
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const rgb = (a: number[], alpha = 1) => `rgba(${a[0]},${a[1]},${a[2]},${alpha})`;

  // Camera above the Bay looking west-north-west, pitched down: basis forward/up/right.
  const eye: V3 = [0, 560, 980];
  const pitch = 0.25;
  const f = H * 1.05;
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const horizon = H / 2 - Math.tan(pitch) * f;
  const project = ([x, y, z]: V3): [number, number, number] => {
    const dx = x - eye[0];
    const dy = y - eye[1];
    const dz = z - eye[2];
    const depth = -dy * sp - dz * cp;
    const vy = dy * cp - dz * sp;
    return [W / 2 + (dx / depth) * f, H / 2 - (vy / depth) * f, depth];
  };

  // Sky.
  const skyTop = mix([142, 178, 214], [10, 16, 32], night);
  const skyHor = mix([226, 214, 196], [44, 40, 58], night);
  const ground = mix([128, 132, 124], [20, 23, 30], night);
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, rgb(skyTop));
  g.addColorStop(horizon / H - 0.005, rgb(skyHor));
  g.addColorStop(horizon / H + 0.01, rgb(mix(skyHor, ground, 0.6)));
  g.addColorStop(1, rgb(mix(ground, [0, 0, 0], 0.15)));
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);

  // Bay on the right.
  c.fillStyle = rgb(mix([86, 112, 128], [10, 16, 26], night));
  c.beginPath();
  c.moveTo(W * 0.62, horizon);
  c.lineTo(W, horizon);
  c.lineTo(W, H);
  c.lineTo(W * 0.92, H);
  c.closePath();
  c.fill();

  // Blocks on a street grid.
  const r = rng(42);
  const boxes: Box[] = [];
  for (let gx = -1600; gx < 900; gx += 110) {
    for (let gz = -2600; gz < 520; gz += 95) {
      const sub = 1 + Math.floor(r() * 3);
      for (let k = 0; k < sub; k++) {
        const w = 90 / sub - 6;
        const tall = Math.abs(gx + 300) < 420 && gz > -1300 && gz < 0;
        const h = tall && r() < 0.35 ? 60 + r() * 190 : 10 + r() * 30;
        boxes.push({ x: gx + k * (90 / sub), z: gz, w, d: 70 + r() * 8, h, tone: r() });
      }
    }
  }
  boxes.sort((a, b) => a.z - b.z || Math.abs(b.x) - Math.abs(a.x));

  const day = 1 - night;
  for (const b of boxes) {
    const p = (x: number, y: number, z: number) => project([x, y, z]);
    const corners = {
      t0: p(b.x, b.h, b.z),
      t1: p(b.x + b.w, b.h, b.z),
      t2: p(b.x + b.w, b.h, b.z + b.d),
      t3: p(b.x, b.h, b.z + b.d),
      b2: p(b.x + b.w, 0, b.z + b.d),
      b3: p(b.x, 0, b.z + b.d),
      b1: p(b.x + b.w, 0, b.z),
    };
    if (corners.t0[2] <= 10) continue;
    const base = mix([196, 188, 172], [172, 176, 182], b.tone);
    const lit = mix(base, [40, 44, 56], night * 0.9);
    const poly = (pts: [number, number, number][], col: string) => {
      c.fillStyle = col;
      c.beginPath();
      pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.closePath();
      c.fill();
    };
    // Front (south) face.
    poly([corners.t3, corners.t2, corners.b2, corners.b3], rgb(mix(lit, [0, 0, 0], 0.18 * day + 0.2 * night)));
    // East or west face depending on side of the camera.
    if (b.x > 0) poly([corners.t0, corners.t3, corners.b3, p(b.x, 0, b.z)], rgb(mix(lit, [0, 0, 0], 0.35)));
    else poly([corners.t1, corners.t2, corners.b2, corners.b1], rgb(mix(lit, [255, 236, 210], 0.12 * day)));
    poly([corners.t0, corners.t1, corners.t2, corners.t3], rgb(mix(lit, [255, 255, 255], 0.16 * day)));
    if (night > 0.3) {
      // Lit windows.
      c.fillStyle = `rgba(255, 205, 140, ${0.55 * night})`;
      const [x0, y0] = corners.t3;
      const [x1, y1] = corners.b2;
      for (let k = 0; k < 6; k++) {
        if (r() < 0.5) continue;
        const wx = x0 + (x1 - x0) * r();
        const wy = y0 + (y1 - y0) * r();
        c.fillRect(wx, wy, 1.5, 1.2);
      }
    }
  }

  // Aerial haze toward the horizon.
  const hz = c.createLinearGradient(0, horizon - 4, 0, horizon + H * 0.3);
  hz.addColorStop(0, rgb(skyHor, 0.85));
  hz.addColorStop(1, rgb(skyHor, 0));
  c.fillStyle = hz;
  c.fillRect(0, horizon - 4, W, H * 0.3 + 4);
}
