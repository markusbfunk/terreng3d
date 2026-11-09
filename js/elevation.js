// Høydedata: Kartverket DTM (1 m, Norge) via WCS, med global reserve fra AWS Terrain Tiles.
import { xToLon, yToLat } from './geo.js';
import { ELEVATION } from './sources.js';
import { chooseZoom, fetchMosaic } from './tiles.js';
import { readTiff } from './tiff.js';

export const ELEV_SOURCES = {
  auto: { name: 'Automatisk – Kartverket 1 m i Norge, ellers global' },
  kartverket: { name: 'Kartverket DTM 1 m (kun Norge)' },
  terrarium: { name: 'AWS Terrain Tiles (global, ~10–30 m)' },
};

export const KARTVERKET = {
  url: 'https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833',
  coverage: 'nhm_dtm_topo_25833',
  bounds: { w: -2.0, e: 33.4, s: 57.2, n: 72.2 },
  attribution: 'Høydedata: © Kartverket, Nasjonal høydemodell DTM 1 m (CC BY 4.0)',
};

const CHUNK = 2000;

function overlaps(b, c) {
  return b.w < c.e && b.e > c.w && b.s < c.n && b.n > c.s;
}

async function fetchKartverketChunk(w, s, e, n, width, height) {
  const q = new URLSearchParams({
    service: 'WCS', request: 'GetCoverage', version: '1.0.0', coverage: KARTVERKET.coverage,
    crs: 'EPSG:4326', bbox: `${w},${s},${e},${n}`, width, height, format: 'GeoTIFF', interpolation: 'bilinear',
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${KARTVERKET.url}?${q}`);
    if (r.ok && (r.headers.get('content-type') || '').includes('tiff')) return readTiff(await r.arrayBuffer());
    if (attempt === 2) throw new Error(`Kartverket svarte ${r.status}`);
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
}

// Henter Kartverket-raster for hele området i biter og returnerer en sampler(lon, lat) → meter eller NaN.
async function kartverketSampler(lay, sampleM, onProgress) {
  const { w, e, s, n } = lay.bbox;
  const m = Math.max(1, sampleM / 1.5); // litt tettere enn modellrutenettet
  const latc = (s + n) / 2;
  const degX = m / (111320 * Math.cos((latc * Math.PI) / 180));
  const degY = m / 110574;
  const W = Math.max(2, Math.ceil((e - w) / degX));
  const H = Math.max(2, Math.ceil((n - s) / degY));
  const cx = Math.ceil(W / CHUNK), cy = Math.ceil(H / CHUNK);
  const chunks = [];
  for (let j = 0; j < cy; j++)
    for (let i = 0; i < cx; i++) {
      const cw = w + ((e - w) * i) / cx, ce = w + ((e - w) * (i + 1)) / cx;
      const cn = n - ((n - s) * j) / cy, cs = n - ((n - s) * (j + 1)) / cy;
      chunks.push({ w: cw, e: ce, n: cn, s: cs, width: Math.ceil(W / cx), height: Math.ceil(H / cy) });
    }
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const c = chunks[next++];
      c.t = await fetchKartverketChunk(c.w, c.s, c.e, c.n, c.width, c.height);
      onProgress?.(++done / chunks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, worker));

  return (lon, lat) => {
    const c = chunks.find((k) => lon >= k.w && lon <= k.e && lat >= k.s && lat <= k.n) || chunks[0];
    const t = c.t;
    const sx = (c.e - c.w) / t.width, sy = (c.n - c.s) / t.height;
    let fx = (lon - c.w) / sx - 0.5, fy = (c.n - lat) / sy - 0.5;
    fx = Math.max(0, Math.min(t.width - 1.001, fx));
    fy = Math.max(0, Math.min(t.height - 1.001, fy));
    const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
    const d = t.data, W2 = t.width;
    const a = d[iy * W2 + ix], b = d[iy * W2 + ix + 1], cc = d[(iy + 1) * W2 + ix], dd = d[(iy + 1) * W2 + ix + 1];
    if (Number.isNaN(a + b + cc + dd)) {
      // Kant mot manglende data: bruk nærmeste gyldige hjørne.
      const v = [a, b, cc, dd].find((x) => !Number.isNaN(x));
      return v ?? NaN;
    }
    return (a * (1 - ax) + b * ax) * (1 - ay) + (cc * (1 - ax) + dd * ax) * ay;
  };
}

// Returnerer { elevM: Float32Array(NX*NY), used: [attribution…] }
export async function sampleElevation(lay, srcKey, setStatus) {
  const { NX, NY } = lay;
  const sampleM = lay.dx / lay.scaleMmPerM;
  const elevM = new Float32Array(NX * NY).fill(NaN);
  const used = [];
  const lonAt = (i) => xToLon(lay.x1 + ((lay.x2 - lay.x1) * i) / (NX - 1));
  const latAt = (j) => yToLat(lay.y1 + ((lay.y2 - lay.y1) * j) / (NY - 1));

  const tryKv = srcKey === 'kartverket' || (srcKey === 'auto' && overlaps(lay.bbox, KARTVERKET.bounds));
  if (tryKv) {
    try {
      setStatus('Henter høydedata fra Kartverket …', 0);
      const sample = await kartverketSampler(lay, sampleM, (p) => setStatus('Henter høydedata fra Kartverket …', p * 0.45));
      let hits = 0;
      for (let j = 0; j < NY; j++) {
        const lat = latAt(j);
        for (let i = 0; i < NX; i++) {
          const v = sample(lonAt(i), lat);
          elevM[j * NX + i] = v;
          if (!Number.isNaN(v)) hits++;
        }
      }
      if (hits) used.push(KARTVERKET.attribution);
      if (!hits && srcKey === 'kartverket') throw new Error('Kartverket har ikke høydedata for dette området.');
    } catch (err) {
      if (srcKey === 'kartverket') throw err;
      console.warn('Kartverket feilet, bruker global kilde:', err);
    }
  }

  let missing = 0;
  for (let k = 0; k < elevM.length; k++) if (Number.isNaN(elevM[k])) missing++;
  if (missing) {
    const z = chooseZoom(lay, sampleM, ELEVATION.maxZoom, 600);
    const msg = `Henter globale høydedata (zoom ${z}) …`;
    const em = await fetchMosaic(ELEVATION.url, z, lay, 'terrarium', (p) => setStatus(msg, 0.45 + p * 0.1));
    for (let j = 0; j < NY; j++) {
      const y = lay.y1 + ((lay.y2 - lay.y1) * j) / (NY - 1);
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i;
        if (Number.isNaN(elevM[k])) elevM[k] = em.elevation(lay.x1 + ((lay.x2 - lay.x1) * i) / (NX - 1), y);
      }
    }
    used.push(ELEVATION.attribution);
  }
  return { elevM, used };
}
