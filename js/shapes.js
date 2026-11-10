// Utsnittsformer. Polygonene er konvekse, mot klokka, og fyller rektangelet W × H (mm, origo sørvest).

export const SHAPES = {
  rect: { name: 'Rektangel (fritt forhold)', n: 0 },
  square: { name: 'Kvadrat', n: 4 },
  tri: { name: 'Trekant', n: 3 },
  pent: { name: 'Femkant', n: 5 },
  hex: { name: 'Sekskant', n: 6 },
  oct: { name: 'Åttekant', n: 8 },
  circle: { name: 'Sirkel', n: 120 },
};

const cache = {};

// Regulær mangekant normalisert til [0,1]². Oddetall peker opp, partall har flat topp.
function unit(n) {
  if (cache[n]) return cache[n];
  const a0 = Math.PI / 2 + (n % 2 ? 0 : Math.PI / n);
  const pts = Array.from({ length: n }, (_, k) => [Math.cos(a0 + (2 * Math.PI * k) / n), Math.sin(a0 + (2 * Math.PI * k) / n)]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const u = { pts: pts.map(([x, y]) => [(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)]), aspect: (y1 - y0) / (x1 - x0) };
  cache[n] = u;
  return u;
}

// Høyde/bredde-forhold for regulære former, null for fritt rektangel.
export function shapeAspect(key) {
  const n = SHAPES[key]?.n;
  return n ? unit(n).aspect : null;
}

export function shapePoly(key, W, H) {
  const n = SHAPES[key]?.n;
  if (!n) return [[0, 0], [W, 0], [W, H], [0, H]];
  return unit(n).pts.map(([x, y]) => [x * W, y * H]);
}
