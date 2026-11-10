// Arealtyper fra OpenStreetMap (Overpass API), rasterisert til et klasse-rutenett.
import { lonToX, latToY } from './geo.js';

// Rekkefølgen er tegnerekkefølge: senere klasser tegnes over tidligere.
export const BASE_CLASS = { id: 'land', name: 'Terreng (annet)', color: '#cfc29a' };
export const OSM_CLASSES = [
  {
    id: 'farmland', name: 'Jordbruk / gress', color: '#a9c97f', on: true,
    areas: [
      ['landuse', 'farmland|meadow|grass|orchard|vineyard|allotments|village_green|recreation_ground'],
      ['natural', 'grassland|heath|scrub'],
      ['leisure', 'park|golf_course|pitch'],
    ],
  },
  { id: 'urban', name: 'Bebyggelse', color: '#d8c6a8', on: true, areas: [['landuse', 'residential|industrial|commercial|retail|construction|railway|garages']] },
  { id: 'wetland', name: 'Myr', color: '#8ea98a', on: false, areas: [['natural', 'wetland']] },
  { id: 'rock', name: 'Fjell / ur / sand', color: '#9c9b95', on: true, areas: [['natural', 'bare_rock|scree|shingle|sand|beach']] },
  { id: 'forest', name: 'Skog', color: '#3e7139', on: true, areas: [['landuse', 'forest'], ['natural', 'wood']] },
  { id: 'glacier', name: 'Isbre / snø', color: '#f3f6f8', on: true, areas: [['natural', 'glacier']] },
  {
    id: 'water', name: 'Vann / hav', color: '#3b78c4', on: true,
    areas: [['natural', 'water'], ['waterway', 'riverbank'], ['landuse', 'reservoir|basin']],
    lines: [['waterway', 'river|canal']], lineWidthM: 20,
  },
  { id: 'road', name: 'Hovedveier', color: '#3a3a3a', on: false, lines: [['highway', 'motorway|trunk|primary|secondary|tertiary']], lineWidthM: 12 },
  { id: 'building', name: 'Bygninger', color: '#b5523e', on: false, areas: [['building', null]] },
];

const filt = ([k, re]) => (re ? `["${k}"~"^(${re})$"]` : `["${k}"]`);
const matcher = (rules) => {
  const compiled = rules.map(([k, re]) => [k, re ? new RegExp(`^(${re})$`) : null]);
  return (tags) => compiled.some(([k, re]) => tags[k] !== undefined && (!re || re.test(tags[k])));
};

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export async function fetchOsm(b, classes, onStatus) {
  const parts = [];
  for (const c of classes) {
    for (const r of c.areas || []) parts.push(`way${filt(r)};relation${filt(r)}["type"="multipolygon"];`);
    for (const r of c.lines || []) parts.push(`way${filt(r)};`);
  }
  const bbox = [b.s, b.w, b.n, b.e].map((v) => v.toFixed(6)).join(',');
  const q = `[out:json][timeout:180][bbox:${bbox}];(${parts.join('')});out geom;`;
  let lastErr;
  // Offentlige Overpass-servere er ofte fulle: prøv alle, med økende ventetid mellom rundene.
  for (let round = 0; round < 3; round++) {
    for (const url of ENDPOINTS) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 75000);
      try {
        onStatus?.(`Henter arealtyper fra OpenStreetMap (${new URL(url).host}, forsøk ${round + 1}) …`);
        const r = await fetch(url, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(q),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: ctrl.signal,
        });
        if (!r.ok) throw new Error(`Overpass svarte ${r.status}`);
        return await r.json();
      } catch (e) {
        lastErr = e.name === 'AbortError' ? new Error('tidsavbrudd') : e;
      } finally {
        clearTimeout(timer);
      }
    }
    if (round < 2) {
      const wait = 5 * 2 ** round;
      onStatus?.(`OSM-serverne er opptatt – prøver igjen om ${wait} s …`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  throw new Error(
    `Kunne ikke hente OSM-data (${lastErr?.message}). De offentlige Overpass-serverne er trolig overbelastet – ` +
      'prøv igjen senere, velg et mindre område, eller bruk en kartbasert fargekilde.',
  );
}

const same = (a, b) => a.lat === b.lat && a.lon === b.lon;

// Setter sammen relasjonsmedlemmer til lukkede ringer.
function stitch(ways) {
  const pool = ways.filter((w) => w.length > 1).map((w) => w.slice());
  const rings = [];
  while (pool.length) {
    let ring = pool.pop();
    let changed = true;
    while (!same(ring[0], ring[ring.length - 1]) && changed) {
      changed = false;
      for (let i = 0; i < pool.length; i++) {
        const w = pool[i];
        const end = ring[ring.length - 1];
        if (same(end, w[0])) ring = ring.concat(w.slice(1));
        else if (same(end, w[w.length - 1])) ring = ring.concat(w.slice(0, -1).reverse());
        else if (same(ring[0], w[w.length - 1])) ring = w.concat(ring.slice(1));
        else if (same(ring[0], w[0])) ring = w.slice().reverse().concat(ring.slice(1));
        else continue;
        pool.splice(i, 1);
        changed = true;
        break;
      }
    }
    rings.push(ring);
  }
  return rings;
}

// Returnerer cls (Uint8Array nx*ny) der 0 = grunnfarge og i+1 = classes[i].
export function rasterizeOsm(data, lay, classes, nx, ny) {
  const canvas = document.createElement('canvas');
  canvas.width = nx;
  canvas.height = ny;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const cls = new Uint8Array(nx * ny);
  // Celle (i, j) dekker x ∈ [i·dx, (i+1)·dx] og y ∈ [H − (j+1)·dy, H − j·dy] i modell-mm.
  const toCell = (p) => {
    const [xm, ym] = lay.toMM(lonToX(p.lon), latToY(p.lat));
    return [xm / lay.dx, (lay.H - ym) / lay.dy];
  };
  const cellsPerM = nx / lay.widthM;
  const elements = data.elements || [];

  const path = (pts, close) => {
    pts = pts.filter(Boolean);
    if (pts.length < 2) return;
    ctx.moveTo(...toCell(pts[0]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(...toCell(pts[i]));
    if (close) ctx.closePath();
  };

  classes.forEach((c, ci) => {
    const isArea = c.areas ? matcher(c.areas) : () => false;
    const isLine = c.lines ? matcher(c.lines) : () => false;
    ctx.clearRect(0, 0, nx, ny);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.2, (c.lineWidthM || 0) * cellsPerM);
    let drew = false;
    for (const el of elements) {
      const tags = el.tags || {};
      if (isArea(tags)) {
        if (el.type === 'way' && el.geometry && el.geometry.length > 3 && same(el.geometry[0], el.geometry[el.geometry.length - 1])) {
          ctx.beginPath(); path(el.geometry, true); ctx.fill('evenodd'); drew = true;
        } else if (el.type === 'relation' && el.members) {
          const rings = stitch(el.members.filter((m) => m.type === 'way' && m.geometry).map((m) => m.geometry.filter(Boolean)));
          ctx.beginPath(); rings.forEach((r) => path(r, true)); ctx.fill('evenodd'); drew = true;
        }
      }
      if (el.type === 'way' && el.geometry && isLine(tags)) {
        ctx.beginPath(); path(el.geometry, false); ctx.stroke(); drew = true;
      }
    }
    if (!drew) return;
    const img = ctx.getImageData(0, 0, nx, ny).data;
    for (let i = 0; i < nx * ny; i++) if (img[i * 4 + 3] >= 128) cls[i] = ci + 1;
  });
  return cls;
}
