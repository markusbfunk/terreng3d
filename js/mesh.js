// Bygger en lukket (vanntett) mesh for én flis: toppflate fra høyderutenettet, vegger og flat bunn.
// Koordinater i mm. x øst, y nord, z opp. Bunnen ligger på z = 0.

export const WALL = 255;

// Indekser fra a til og med b med gitt steg (b er alltid med).
export function indexRange(a, b, step) {
  const out = [];
  for (let i = a; i < b; i += step) out.push(i);
  if (out.length > 1 && b - out[out.length - 1] < step / 2) out.pop();
  out.push(b);
  return out;
}

// M: { NX, NY, dx, dy, z: Float32Array(NX*NY), cls: Uint8Array((NX-1)*(NY-1)) }
// cols/rows: punktindekser i det globale rutenettet (rad 0 = nord).
export function buildTileMesh(M, cols, rows) {
  const { NX, NY, dx, dy, z, cls } = M;
  const cw = NX - 1;
  const w = cols.length, h = rows.length;
  const nTop = w * h;
  const L = 2 * (w + h) - 4;
  const pos = new Float32Array((nTop + L + 1) * 3);
  const x0 = cols[0], yRef = rows[h - 1];

  for (let b = 0; b < h; b++) {
    const yy = (yRef - rows[b]) * dy;
    const zr = rows[b] * NX;
    for (let a = 0; a < w; a++) {
      const o = (b * w + a) * 3;
      pos[o] = (cols[a] - x0) * dx;
      pos[o + 1] = yy;
      pos[o + 2] = z[zr + cols[a]];
    }
  }

  // Omkrets mot klokka sett ovenfra: sør (vest→øst), øst (sør→nord), nord (øst→vest), vest (nord→sør).
  const loop = new Uint32Array(L);
  let k = 0;
  for (let a = 0; a < w; a++) loop[k++] = (h - 1) * w + a;
  for (let b = h - 2; b >= 0; b--) loop[k++] = b * w + (w - 1);
  for (let a = w - 2; a >= 0; a--) loop[k++] = a;
  for (let b = 1; b <= h - 2; b++) loop[k++] = b * w;

  for (let i = 0; i < L; i++) {
    const v = loop[i] * 3, o = (nTop + i) * 3;
    pos[o] = pos[v];
    pos[o + 1] = pos[v + 1];
    pos[o + 2] = 0;
  }
  const center = nTop + L;
  const width = (cols[w - 1] - x0) * dx, height = (yRef - rows[0]) * dy;
  pos[center * 3] = width / 2;
  pos[center * 3 + 1] = height / 2;
  pos[center * 3 + 2] = 0;

  const nTopTri = 2 * (w - 1) * (h - 1);
  const nTri = nTopTri + 3 * L;
  const idx = new Uint32Array(nTri * 3);
  const tc = new Uint8Array(nTri);
  let t = 0;
  const tri = (p, q, r, c) => {
    idx[t * 3] = p; idx[t * 3 + 1] = q; idx[t * 3 + 2] = r; tc[t] = c; t++;
  };

  for (let b = 0; b < h - 1; b++) {
    const cj = Math.min(NY - 2, (rows[b] + rows[b + 1]) >> 1);
    for (let a = 0; a < w - 1; a++) {
      const ci = Math.min(cw - 1, (cols[a] + cols[a + 1]) >> 1);
      const c = cls[cj * cw + ci];
      const va = b * w + a, vb = va + 1, vc = va + w, vd = vc + 1;
      tri(vc, vd, vb, c);
      tri(vc, vb, va, c);
    }
  }
  for (let i = 0; i < L; i++) {
    const p = loop[i], q = loop[(i + 1) % L];
    const pb = nTop + i, qb = nTop + ((i + 1) % L);
    tri(p, pb, qb, WALL);
    tri(p, qb, q, WALL);
    tri(center, qb, pb, WALL);
  }
  return { positions: pos, indices: idx, triCls: tc, width, height };
}
