// Klassebasert farging av Kartverkets arealdekkekart: hver piksel får en kjent arealklasse ut fra
// kartfargen, og klassene slås sammen etter prioritet når det er få filamenter.
//
// Prioritet (én filamentplass per trinn):
//   1 hav/vann · 2 land · 3 bebyggelse · 4 snø/bre · 5 skog skilles fra åpent/fjell · 6 veier
//   7 trær (eget filament) · 8 bygninger (eget filament) · 9 dyrket mark

// Kartfarger (Kartverket N50/N100/N250, WMS wms.topo) → grunnklasse.
const LEGEND = [
  ['water', '#e0fefe'], ['water', '#7ed1fe'], ['water', '#00a6fe'],
  ['forest', '#d2e67c'], ['park', '#9bb93c'],
  ['farm', '#fef7a3'],
  ['open', '#fefee6'], ['open', '#ffffe6'], ['myr', '#bbe1f6'],
  ['built', '#fad9bc'], ['built', '#f7be8c'], ['built', '#d7d7d7'], ['built', '#dcdcdc'], ['built', '#999933'],
  ['glacier', '#fefefe'], ['glacier', '#e3f4fe'],
];
const BASE = ['water', 'forest', 'park', 'farm', 'open', 'myr', 'built', 'glacier'];
const BASE_IDX = Object.fromEntries(BASE.map((k, i) => [k, i]));
export const WATER_BASE = BASE_IDX.water;

// Filamentklasser med navn og naturlige standardfarger.
export const CLASSES = {
  land: { name: 'Land', color: '#7fa65a' },
  open: { name: 'Åpent land / fjell', color: '#cbb991' },
  water: { name: 'Hav og vann', color: '#5b9bd5' },
  built: { name: 'Bebyggelse', color: '#d29c78' },
  glacier: { name: 'Snø og bre', color: '#f3f5f7' },
  forest: { name: 'Skog', color: '#4f7d3a' },
  farm: { name: 'Dyrket mark', color: '#d8cc72' },
  roads: { name: 'Veier', color: '#c9c9c9' },
};
export const SYMBOL_COLORS = { trees: { name: 'Trær', color: '#1f4d22' }, buildings: { name: 'Bygninger', color: '#b5523e' } };

const hexRgb = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
const LEG = LEGEND.map(([k, h]) => [BASE_IDX[k], ...hexRgb(h)]);

// rgb: Uint8Array n*3 (sammensatt over hvitt), alpha: Float32Array n, sea: Uint8Array n (1 = høyde ≤ 0).
// Returnerer grunnklasse per celle (indeks i BASE).
export function classifyKartverket(rgb, alpha, sea, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (alpha[i] < 0.5) { out[i] = sea[i] ? BASE_IDX.water : BASE_IDX.open; continue; }
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    let best = BASE_IDX.open, bd = Infinity;
    for (const [c, R, G, B] of LEG) {
      const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    out[i] = best;
  }
  return out;
}

// Velger hvilke filamentklasser som får egen plass innenfor budsjettet.
// counts: antall celler per grunnklasse. want: { roads, trees, buildings }.
export function planClasses(counts, n, budget, want) {
  const has = (...ks) => ks.reduce((s, k) => s + counts[BASE_IDX[k]], 0) > n * 0.002;
  const steps = [
    ['water', has('water')],
    ['land', true],
    ['built', has('built')],
    ['glacier', has('glacier')],
    ['forest', has('forest', 'park') && has('open', 'myr', 'farm', 'glacier')],
    ['roads', want.roads],
    ['trees', want.trees],
    ['buildings', want.buildings],
    ['farm', has('farm')],
  ];
  const on = new Set();
  for (const [k, ok] of steps) {
    if (!ok) continue;
    if (on.size >= budget) break;
    on.add(k);
  }
  return on;
}

// Lager palett (fast rekkefølge) og oversetter grunnklasser til palettindekser.
export function buildPalette(base, on) {
  const ids = ['land', 'water', 'built', 'glacier', 'forest', 'farm'].filter((k) => k === 'land' || on.has(k));
  const palette = ids.map((k) => {
    const c = k === 'land' && on.has('forest') ? CLASSES.open : CLASSES[k];
    return { id: k, name: c.name, color: c.color };
  });
  const idx = (k) => ids.indexOf(k);
  const target = (chain) => idx(chain.find((k) => idx(k) >= 0));
  const map = new Uint8Array(BASE.length);
  map[BASE_IDX.water] = target(['water', 'land']);
  map[BASE_IDX.built] = target(['built', 'land']);
  map[BASE_IDX.glacier] = target(['glacier', 'land']);
  map[BASE_IDX.forest] = target(['forest', 'land']);
  map[BASE_IDX.park] = target(['forest', 'land']);
  map[BASE_IDX.farm] = target(['farm', 'land']);
  map[BASE_IDX.open] = target(['land']);
  map[BASE_IDX.myr] = target(['land']);
  const cls = new Uint8Array(base.length);
  for (let i = 0; i < base.length; i++) cls[i] = map[base[i]];
  return { cls, palette };
}

export const baseCounts = (base) => {
  const c = new Float64Array(BASE.length);
  for (let i = 0; i < base.length; i++) c[base[i]]++;
  return c;
};

// Fjerner tomme klasser, beholder rekkefølgen og gir filamentplass 1..n.
export function finalizePalette(cls, palette) {
  const cnt = new Float64Array(palette.length);
  for (let i = 0; i < cls.length; i++) cnt[cls[i]]++;
  const keep = palette.map((_, i) => i).filter((i) => cnt[i] > 0);
  const map = new Uint8Array(palette.length);
  keep.forEach((o, i) => (map[o] = i));
  for (let i = 0; i < cls.length; i++) cls[i] = map[cls[i]];
  return keep.map((o, i) => ({ ...palette[o], pct: (cnt[o] / cls.length) * 100, slot: Math.min(16, i + 1) }));
}

// Veimaske: en celle er vei hvis noen av 3×3 delpunkter treffer veilaget, så tynne veier blir sammenhengende.
// Ved fin oppløsning (< 0,6 mm/celle) utvides linjene med én celle (mot øst og sør), så de blir minst ~0,8 mm.
// Veiklasse ut fra kartfargen i Kartverkets veilag (N50/N100/N250):
// 3 = riks-/europa-/fylkesvei (#d2232a) og motorvei (gul), 2 = øvrige bilveier (grå #6e6e6e),
// 0 = ikke vei: gjennomsiktig, tunneler (lys rød), stier og fergeruter (prikket #c11d1d), kantutjevning.
// Private og kommunale veier har samme farge i kartet og kan ikke skilles.
export function roadKind(p) {
  if (!p || p[3] < 120) return 0;
  const [r, g, b] = p, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (r > 200 && g > 170 && b < 90) return 3;
  if (r >= 195 && g < 70 && b >= 34 && b < 75) return 3;
  if (mx - mn < 25 && mx < 150) return 2;
  return 0;
}
export const ROAD_LEVELS = { major: 3, normal: 2 };

// Fjerner sammenhengende biter mindre enn minCells (prikker fra stier, løse stumper).
function dropSmall(m, nx, ny, minCells) {
  const seen = new Uint8Array(m.length), stack = [], comp = [];
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || seen[s]) continue;
    comp.length = 0; stack.push(s); seen[s] = 1;
    while (stack.length) {
      const k = stack.pop(); comp.push(k);
      const i = k % nx, j = (k / nx) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const q = jj * nx + ii;
        if (m[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    if (comp.length < minCells) for (const k of comp) m[k] = 0;
  }
}

export function roadMaskFrom(mosaic, lay, nx, ny, level = 'normal') {
  const min = ROAD_LEVELS[level] || 2;
  const m = new Uint8Array(nx * ny);
  const sub = [0.17, 0.5, 0.83];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let hit = 0;
      for (const v of sub) {
        for (const u of sub) if (roadKind(mosaic.rgba(...lay.gridXY(i + u, j + v))) >= min) { hit = 1; break; }
        if (hit) break;
      }
      m[j * nx + i] = hit;
    }
  dropSmall(m, nx, ny, Math.max(4, Math.round(3 / lay.dx)));
  if (lay.dx >= 0.6) return m;
  const out = m.slice();
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++)
      if (m[j * nx + i]) {
        if (i + 1 < nx) out[j * nx + i + 1] = 1;
        if (j + 1 < ny) out[(j + 1) * nx + i] = 1;
        if (i + 1 < nx && j + 1 < ny) out[(j + 1) * nx + i + 1] = 1;
      }
  return out;
}
