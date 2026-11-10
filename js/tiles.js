// Henting av kartfliser (XYZ, 256 px) til en mosaikk som kan samples med normaliserte koordinater.

const TS = 256;
const cache = new Map();
let scratch = null;

const HALF = 20037508.342789244; // halv omkrets i EPSG:3857-meter

function tileUrl(tpl, z, x, y) {
  if (tpl.includes('{bbox3857}')) {
    const size = (2 * HALF) / 2 ** z;
    const bbox = [-HALF + x * size, HALF - (y + 1) * size, -HALF + (x + 1) * size, HALF - y * size].map((v) => v.toFixed(2)).join(',');
    return tpl.replace('{bbox3857}', bbox);
  }
  return tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

async function loadTile(url) {
  if (cache.has(url)) return cache.get(url);
  const p = (async () => {
    const r = await fetch(url, { mode: 'cors' });
    if (r.status === 404 || r.status === 204) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status} ved henting av ${url}`);
    const blob = await r.blob();
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    if (!scratch) {
      scratch = document.createElement('canvas');
      scratch.width = TS;
      scratch.height = TS;
    }
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, TS, TS);
    ctx.drawImage(bmp, 0, 0, TS, TS);
    bmp.close();
    return ctx.getImageData(0, 0, TS, TS).data;
  })();
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}

export function tileRange(lay, z) {
  const n = 2 ** z;
  const clamp = (v) => Math.max(0, Math.min(n - 1, v));
  return {
    tx0: clamp(Math.floor(lay.x1 * n)),
    tx1: clamp(Math.floor(lay.x2 * n - 1e-9)),
    ty0: clamp(Math.floor(lay.y1 * n)),
    ty1: clamp(Math.floor(lay.y2 * n - 1e-9)),
  };
}

export function tileCount(lay, z) {
  const r = tileRange(lay, z);
  return (r.tx1 - r.tx0 + 1) * (r.ty1 - r.ty0 + 1);
}

// Velg zoom slik at én kartpiksel er omtrent targetM meter, innenfor maxZoom og maxTiles.
export function chooseZoom(lay, targetM, maxZoom, maxTiles) {
  let z = Math.ceil(Math.log2(lay.mpu / (TS * targetM)));
  z = Math.max(0, Math.min(maxZoom, z));
  while (z > 0 && tileCount(lay, z) > maxTiles) z--;
  return z;
}

// kind: 'terrarium' (dekoder høyde i meter) eller 'rgb'
export async function fetchMosaic(tpl, z, lay, kind, onProgress) {
  const { tx0, tx1, ty0, ty1 } = tileRange(lay, z);
  const cols = tx1 - tx0 + 1;
  const rows = ty1 - ty0 + 1;
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
  const tiles = new Array(jobs.length).fill(null);
  let done = 0;
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const k = next++;
      const [tx, ty] = jobs[k];
      const rgba = await loadTile(tileUrl(tpl, z, tx, ty));
      if (rgba) {
        if (kind === 'terrarium') {
          const e = new Float32Array(TS * TS);
          for (let i = 0; i < TS * TS; i++) {
            e[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
          }
          tiles[k] = e;
        } else {
          tiles[k] = rgba;
        }
      }
      done++;
      onProgress?.(done / jobs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, worker));
  return new Mosaic(z, tx0, ty0, cols, rows, tiles, kind);
}

export class Mosaic {
  // Rå RGBA (0–255) i nærmeste piksel, eller null.
  rgba(x, y) {
    const [gx, gy] = this._px(x, y);
    const ix = Math.round(gx), iy = Math.round(gy);
    const t = this.tiles[(iy >> 8) * this.cols + (ix >> 8)];
    if (!t) return null;
    const k = ((iy & 255) * 256 + (ix & 255)) * 4;
    return [t[k], t[k + 1], t[k + 2], t[k + 3]];
  }

  // Dekning (alfa 0–1) i nærmeste piksel. Manglende fliser gir 0.
  alpha(x, y) {
    const [gx, gy] = this._px(x, y);
    const ix = Math.round(gx), iy = Math.round(gy);
    const t = this.tiles[(iy >> 8) * this.cols + (ix >> 8)];
    return t ? t[((iy & 255) * TS + (ix & 255)) * 4 + 3] / 255 : 0;
  }

  constructor(z, tx0, ty0, cols, rows, tiles, kind) {
    Object.assign(this, { z, tx0, ty0, cols, rows, tiles, kind });
    this.n = 2 ** z;
    this.W = cols * TS;
    this.H = rows * TS;
  }

  _px(x, y) {
    let gx = (x * this.n - this.tx0) * TS - 0.5;
    let gy = (y * this.n - this.ty0) * TS - 0.5;
    gx = Math.max(0, Math.min(this.W - 1.001, gx));
    gy = Math.max(0, Math.min(this.H - 1.001, gy));
    return [gx, gy];
  }

  _elev(ix, iy) {
    const t = this.tiles[(iy >> 8) * this.cols + (ix >> 8)];
    return t ? t[(iy & 255) * TS + (ix & 255)] : 0;
  }

  // Bilineær høyde i meter.
  elevation(x, y) {
    const [gx, gy] = this._px(x, y);
    const ix = Math.floor(gx), iy = Math.floor(gy);
    const fx = gx - ix, fy = gy - iy;
    const a = this._elev(ix, iy), b = this._elev(ix + 1, iy);
    const c = this._elev(ix, iy + 1), d = this._elev(ix + 1, iy + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  // Bilineær RGB inn i out[o..o+2]. Gjennomsiktige piksler og manglende fliser gir hvitt.
  rgb(x, y, out, o) {
    const [gx, gy] = this._px(x, y);
    const ix = Math.floor(gx), iy = Math.floor(gy);
    const fx = gx - ix, fy = gy - iy;
    for (let ch = 0; ch < 3; ch++) {
      const v = (px, py) => {
        const t = this.tiles[(py >> 8) * this.cols + (px >> 8)];
        if (!t) return 255;
        const k = ((py & 255) * TS + (px & 255)) * 4, a = t[k + 3] / 255;
        return t[k + ch] * a + 255 * (1 - a);
      };
      const val =
        (v(ix, iy) * (1 - fx) + v(ix + 1, iy) * fx) * (1 - fy) +
        (v(ix, iy + 1) * (1 - fx) + v(ix + 1, iy + 1) * fx) * fy;
      out[o + ch] = val;
    }
  }
}
