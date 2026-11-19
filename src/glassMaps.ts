/**
 * Procedurally builds the two images behind the liquid-glass pointer for a capsule of w×h:
 *  - disp: displacement map (R/G = outward refraction vector, 128 = neutral) for feDisplacementMap
 *  - spec: rim light, brightest on the top-left edge, faint on the opposite edge
 */
export function buildGlassMaps(w: number, h: number, dpr = 2) {
  const W = w * dpr, H = h * dpr, R = H / 2;
  const make = () => {
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    return { canvas, ctx, img: ctx.createImageData(W, H) };
  };
  const d = make(), s = make();
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const cx = Math.min(Math.max(px + 0.5, R), W - R);
      const dx = px + 0.5 - cx, dy = py + 0.5 - H / 2;
      const dist = Math.hypot(dx, dy);
      const nx = dist ? dx / dist : 0, ny = dist ? dy / dist : 0;
      const t = Math.min(Math.max((R - dist) / R, 0), 1); // 0 at the rim → 1 at the core
      const m = (1 - t) ** 2;                              // bends hardest at the rim
      const i = (py * W + px) * 4;
      d.img.data.set([128 + 127 * m * nx, 128 + 127 * m * ny, 128, 255], i);
      const light = Math.max(0, -(nx * 0.6 + ny * 0.8)) + 0.4 * Math.max(0, nx * 0.6 + ny * 0.8);
      const a = R - dist < 0 ? 0 : 255 * Math.min(1, (1 - t) ** 5 * light * 1.3);
      s.img.data.set([255, 255, 255, a], i);
    }
  }
  d.ctx.putImageData(d.img, 0, 0);
  s.ctx.putImageData(s.img, 0, 0);
  return { disp: d.canvas.toDataURL(), spec: s.canvas.toDataURL() };
}
