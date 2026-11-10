// Tekst på undersiden: stedsnavn (Nominatim) og glyfkonturer (three.js-font) som graveres inn i bunnen.
import { ShapeUtils, Vector2 } from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { polyEdges, insideDist } from './mesh.js';
import polygonClipping from 'https://cdn.jsdelivr.net/npm/polygon-clipping@0.15.7/+esm';

const FONT_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/fonts/droid/droid_sans_bold.typeface.json';
let fontP = null;
export function loadFont() {
  if (!fontP) fontP = new FontLoader().loadAsync(FONT_URL).catch((e) => { fontP = null; throw e; });
  return fontP;
}

// Bitteliten, fast forskyvning (1e-6 mm) bare for trianguleringen: earcut fjerner ellers punkter som ligger
// nøyaktig på linje (f.eks. felles grunnlinje for flere bokstaver), og da oppstår T-skjøter i bunnen.
let jit = 0;
const vec = (pts) => pts.map((p) => { jit = (jit + 0.6180339887) % 1; return new Vector2(p.x + jit * 1e-6, p.y + ((jit * 7.31) % 1) * 1e-6); });
export const triangulate = (contour, holes) => ShapeUtils.triangulateShape(vec(contour), holes.map(vec));

// Nærmeste større stedsnavn: by/tettsted hvis punktet ligger i et, ellers kommunen (eller fylket).
export async function placeName(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&zoom=12&accept-language=no`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Stedsnavn: HTTP ${r.status}`);
  const j = await r.json();
  const a = j.address || {};
  return a.city || a.town || a.village || a.municipality || a.county || a.state || a.country || j.name || '';
}

const fmt = (v, d) => Math.abs(v).toFixed(d).replace('.', ',');
export function coordText(lat, lon) {
  return `${fmt(lat, 4)}° ${lat >= 0 ? 'N' : 'S'}  ${fmt(lon, 4)}° ${lon >= 0 ? 'Ø' : 'V'}`;
}

// Fjerner like nabopunkter (inkl. lukkepunkt) og veldig korte kanter.
function clean(pts, tol) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > tol) out.push(p);
  }
  while (out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= tol) out.pop();
  return out;
}

// Lager speilvendte glyfkonturer (lesbare når modellen snus) sentrert i polygonet.
// lines: [{ text, scale }] – scale relativt til første linje. Returnerer { shapes, box, size } eller null hvis teksten ikke får plass.
export function labelShapes(font, lines, poly, { size, minSize = 3, margin = 3 }) {
  lines = lines.filter((l) => l.text && l.text.trim());
  if (!lines.length) return null;
  const edges = polyEdges(poly);
  let cx = 0, cy = 0;
  for (const [x, y] of poly) { cx += x; cy += y; }
  cx /= poly.length; cy /= poly.length;

  const minScale = Math.min(...lines.map((l) => l.scale || 1));
  // minSize gjelder den minste linjen.
  for (let s = size; s * minScale >= minSize; s *= 0.88) {
    // Linjer stables nedover; hver linje sentreres horisontalt.
    const raw = [];
    let y = 0;
    for (const l of lines) {
      const fs = s * (l.scale || 1);
      const shapes = font.generateShapes(l.text, fs);
      const pts = shapes.flatMap((sh) => sh.extractPoints(4).shape);
      if (!pts.length) continue;
      const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
      y -= fs;
      raw.push({ shapes, dx: -(minX + maxX) / 2, dy: y });
      y -= fs * 0.35;
    }
    if (!raw.length) return null;
    const allY = [];
    for (const r of raw) for (const sh of r.shapes) for (const p of sh.extractPoints(4).shape) allY.push(p.y + r.dy);
    const midY = (Math.min(...allY) + Math.max(...allY)) / 2;

    const tol = s * 0.004;
    const out = [];
    let fits = true;
    // Speil i x: x' = cx − x. Sett fra undersiden leses teksten da riktig.
    const tf = (r) => (p) => [cx - (p.x + r.dx), cy + (p.y + r.dy - midY)];
    const polys = [];
    for (const r of raw) {
      for (const sh of r.shapes) {
        const { shape, holes } = sh.extractPoints(4);
        const outer = clean(shape, tol).map(tf(r));
        if (outer.length < 3) continue;
        polys.push([outer, ...holes.map((h) => clean(h, tol).map(tf(r))).filter((h) => h.length >= 3)]);
      }
    }
    // Union fjerner overlapp mellom konturer (f.eks. ringen i Å) og gir rene, ikke-overlappende flater.
    const toPts = (ring) => clean(ring.map(([x, y]) => ({ x, y })), tol).map((p) => [p.x, p.y]);
    for (const [o, ...hs] of polys.length ? polygonClipping.union(...polys.map((p) => [p])) : []) {
      const outer = toPts(o);
      if (outer.length >= 3) out.push({ outer, holes: hs.map(toPts).filter((h) => h.length >= 3) });
    }
    if (!out.length) return null;
    // Rektangel rundt teksten (med luft) som må ligge godt innenfor formen.
    const pad = Math.max(1, s * 0.15);
    const xs = out.flatMap((g) => g.outer.map((p) => p[0])), ys = out.flatMap((g) => g.outer.map((p) => p[1]));
    const box = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
    for (const [x, y] of [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]])
      if (insideDist(edges, x, y) < margin) fits = false;
    if (fits) return { shapes: out, box, size: s };
  }
  return null;
}
