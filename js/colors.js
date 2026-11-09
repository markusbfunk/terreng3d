// Fargereduksjon (k-means i CIELAB), støyfjerning og palett-opprydding.

const LIN = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});
const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

function labInto(r, g, b, out, o) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const fx = f(X), fy = f(Y), fz = f(Z);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const toHex = (r, g, b) =>
  '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

function nearest(lab, i, C, k) {
  let best = 0, bd = Infinity;
  const L = lab[i * 3], A = lab[i * 3 + 1], B = lab[i * 3 + 2];
  for (let c = 0; c < k; c++) {
    const dl = L - C[c * 3], da = A - C[c * 3 + 1], db = B - C[c * 3 + 2];
    const d = dl * dl + da * da + db * db;
    if (d < bd) { bd = d; best = c; }
  }
  return [best, bd];
}

// rgb: Uint8Array n*3. Returnerer {cls: Uint8Array n, palette: [{name, color}]}
export function quantizeColors(rgb, n, k) {
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) labInto(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], lab, i * 3);

  const rand = rng(12345);
  const S = Math.min(n, 40000);
  const sLab = new Float32Array(S * 3);
  for (let s = 0; s < S; s++) {
    const i = S === n ? s : Math.floor(rand() * n);
    sLab.set(lab.subarray(i * 3, i * 3 + 3), s * 3);
  }
  k = Math.max(1, Math.min(k, S));

  // k-means++
  const C = new Float32Array(k * 3);
  C.set(sLab.subarray(0, 3), 0);
  const D = new Float64Array(S).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let s = 0; s < S; s++) {
      const [, d] = nearest(sLab, s, C.subarray((c - 1) * 3), 1);
      if (d < D[s]) D[s] = d;
      sum += D[s];
    }
    let r = rand() * sum, pick = S - 1;
    for (let s = 0; s < S; s++) { r -= D[s]; if (r <= 0) { pick = s; break; } }
    C.set(sLab.subarray(pick * 3, pick * 3 + 3), c * 3);
  }

  // Lloyd
  const sums = new Float64Array(k * 3), cnt = new Float64Array(k);
  for (let it = 0; it < 30; it++) {
    sums.fill(0); cnt.fill(0);
    for (let s = 0; s < S; s++) {
      const [c] = nearest(sLab, s, C, k);
      cnt[c]++;
      sums[c * 3] += sLab[s * 3]; sums[c * 3 + 1] += sLab[s * 3 + 1]; sums[c * 3 + 2] += sLab[s * 3 + 2];
    }
    let move = 0;
    for (let c = 0; c < k; c++) {
      if (!cnt[c]) continue;
      for (let j = 0; j < 3; j++) {
        const v = sums[c * 3 + j] / cnt[c];
        move += Math.abs(v - C[c * 3 + j]);
        C[c * 3 + j] = v;
      }
    }
    if (move < 0.01) break;
  }

  const cls = new Uint8Array(n);
  const sumRGB = new Float64Array(k * 3);
  cnt.fill(0);
  for (let i = 0; i < n; i++) {
    const [c] = nearest(lab, i, C, k);
    cls[i] = c;
    cnt[c]++;
    sumRGB[c * 3] += rgb[i * 3]; sumRGB[c * 3 + 1] += rgb[i * 3 + 1]; sumRGB[c * 3 + 2] += rgb[i * 3 + 2];
  }
  const palette = [];
  for (let c = 0; c < k; c++) {
    const m = cnt[c] || 1;
    palette.push({ name: `Farge ${c + 1}`, color: toHex(sumRGB[c * 3] / m, sumRGB[c * 3 + 1] / m, sumRGB[c * 3 + 2] / m) });
  }
  return { cls, palette };
}

// Flertallsfilter 3×3: fjerner enkeltpiksler og fransete kanter.
export function majorityFilter(cls, w, h, passes, nc) {
  let src = cls, dst = new Uint8Array(cls.length);
  const cnt = new Uint16Array(nc);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
        cnt.fill(0);
        for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) cnt[src[yy * w + xx]]++;
        const i = y * w + x;
        let best = src[i], bc = cnt[best];
        for (let c = 0; c < nc; c++) if (cnt[c] > bc) { best = c; bc = cnt[c]; }
        dst[i] = best;
      }
    }
    [src, dst] = [dst, src];
  }
  if (src !== cls) cls.set(src);
}

// Fjerner ubrukte farger, sorterer etter areal og gir filamentplass 1..n.
// keepFirst: indeks 0 (grunnfarge) beholdes alltid som plass 1.
export function compactPalette(cls, palette, keepFirst) {
  const cnt = new Float64Array(palette.length);
  for (let i = 0; i < cls.length; i++) cnt[cls[i]]++;
  let order = palette.map((_, i) => i).filter((i) => cnt[i] > 0 && !(keepFirst && i === 0));
  order.sort((a, b) => cnt[b] - cnt[a]);
  if (keepFirst) order = [0, ...order];
  const map = new Uint8Array(palette.length);
  order.forEach((o, i) => (map[o] = i));
  for (let i = 0; i < cls.length; i++) cls[i] = map[cls[i]];
  return order.map((o, i) => ({ ...palette[o], pct: (cnt[o] / cls.length) * 100, slot: Math.min(16, i + 1) }));
}
