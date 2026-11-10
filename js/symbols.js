// Symbolske trær (kjegler i skog) og bygninger (hus med saltak) som egne deler oppå terrenget.
// Koordinater: globale mm, x østover fra vestkant, y nordover fra sørkant.
import { lonToX, latToY } from './geo.js';
import { WALL, polyEdges, insideDist } from './mesh.js';

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Terrenghøyde (mm) i et globalt punkt, bilineært fra M.z.
export function terrainZ(M, x, y) {
  const fi = Math.max(0, Math.min(M.NX - 1.0001, x / M.dx));
  const fj = Math.max(0, Math.min(M.NY - 1.0001, (M.H - y) / M.dy));
  const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j;
  const z = M.z, N = M.NX;
  return (z[j * N + i] * (1 - a) + z[j * N + i + 1] * a) * (1 - b) + (z[(j + 1) * N + i] * (1 - a) + z[(j + 1) * N + i + 1] * a) * b;
}

const toGlobal = (M, lon, lat) => M.toMM(lonToX(lon), latToY(lat));

// Bygninger fra OSM-fotavtrykk → forenklede, orienterte hus. Tynnes ut så de ikke overlapper.
export function placeBuildings(M, elements, opt) {
  const out = [];
  const raw = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags?.building || !el.geometry || el.geometry.length < 4) continue;
    const pts = el.geometry.filter(Boolean).map((p) => toGlobal(M, p.lon, p.lat));
    let cx = 0, cy = 0;
    pts.forEach(([x, y]) => { cx += x; cy += y; });
    cx /= pts.length; cy /= pts.length;
    if (cx < 0 || cy < 0 || cx > M.W || cy > M.H) continue;
    // Hovedretning = lengste kant.
    let best = 0, ang = 0;
    for (let k = 0; k < pts.length - 1; k++) {
      const dx = pts[k + 1][0] - pts[k][0], dy = pts[k + 1][1] - pts[k][1];
      const l = dx * dx + dy * dy;
      if (l > best) { best = l; ang = Math.atan2(dy, dx); }
    }
    const ca = Math.cos(ang), sa = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    pts.forEach(([x, y]) => {
      const u = (x - cx) * ca + (y - cy) * sa, v = -(x - cx) * sa + (y - cy) * ca;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    });
    const t = el.tags;
    let hM = parseFloat(t.height) || (parseFloat(t['building:levels']) || 2) * 3;
    raw.push({ x: cx + ((u0 + u1) / 2) * ca - ((v0 + v1) / 2) * sa, y: cy + ((u0 + u1) / 2) * sa + ((v0 + v1) / 2) * ca, L: u1 - u0, Wd: v1 - v0, ang, hM, area: (u1 - u0) * (v1 - v0) });
  }
  raw.sort((a, b) => b.area - a.area);
  const cell = opt.minSize * 1.15;
  const occ = new Set();
  const key = (gx, gy) => gx * 100003 + gy;
  for (const b of raw) {
    const L = Math.max(b.L, opt.minSize), Wd = Math.max(b.Wd, opt.minSize * 0.75);
    if (L > opt.minSize * 12) continue; // svære industribygg: dropp heller enn store klosser
    const rad = Math.hypot(L, Wd) / 2;
    const gx0 = Math.floor((b.x - rad) / cell), gx1 = Math.floor((b.x + rad) / cell);
    const gy0 = Math.floor((b.y - rad) / cell), gy1 = Math.floor((b.y + rad) / cell);
    let free = true;
    for (let gx = gx0; gx <= gx1 && free; gx++) for (let gy = gy0; gy <= gy1; gy++) if (occ.has(key(gx, gy))) { free = false; break; }
    if (!free) continue;
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) occ.add(key(gx, gy));
    const wallH = Math.max(opt.minHeight, b.hM * M.scaleMmPerM * opt.exag);
    out.push({ x: b.x, y: b.y, L, Wd, ang: b.ang, wallH, roofH: Wd * 0.4, rad });
    if (out.length >= opt.max) break;
  }
  return { items: out, occ, cell };
}

// Trær på et jittret rutenett innenfor skogmasken (celler nx*ny, 1 = skog).
export function placeTrees(M, mask, opt, avoid) {
  const out = [];
  const rand = rng(4242);
  const nx = M.NX - 1, ny = M.NY - 1;
  const s = opt.spacing;
  for (let y = s / 2; y < M.H; y += s) {
    for (let x = s / 2; x < M.W; x += s) {
      if (rand() > opt.fill) continue;
      const px = x + (rand() - 0.5) * s * 0.7, py = y + (rand() - 0.5) * s * 0.7;
      const ci = Math.floor(px / M.dx), cj = Math.floor((M.H - py) / M.dy);
      if (ci < 0 || cj < 0 || ci >= nx || cj >= ny || !mask[cj * nx + ci]) continue;
      if (avoid && avoid.occ.has(Math.floor(px / avoid.cell) * 100003 + Math.floor(py / avoid.cell))) continue;
      const k = 0.8 + rand() * 0.4;
      out.push({ x: px, y: py, r: opt.radius * k, h: opt.height * k, rad: opt.radius * k });
      if (out.length >= opt.max) return out;
    }
  }
  return out;
}

// Lager én mesh av alle symboler som ligger helt inne i flisen (rect og poly i globale mm).
// Resultatet er i flisens lokale koordinater (origo i flisens sørvestre hjørne).
export function buildSymbolMesh(M, items, kind, rect, poly) {
  const edges = polyEdges(poly || [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x1, rect.y1], [rect.x0, rect.y1]]);
  const inside = items.filter((it) => insideDist(edges, it.x, it.y) > it.rad + 0.3);
  if (!inside.length) return null;
  const SEG = 10;
  const vPer = kind === 'trees' ? SEG + 2 : 10;
  const tPer = kind === 'trees' ? SEG * 2 : 16;
  const pos = new Float32Array(inside.length * vPer * 3);
  const idx = new Uint32Array(inside.length * tPer * 3);
  let v = 0, t = 0;
  const P = (x, y, z) => { pos[v * 3] = x - rect.x0; pos[v * 3 + 1] = y - rect.y0; pos[v * 3 + 2] = z; return v++; };
  const T = (a, b, c) => { idx[t * 3] = a; idx[t * 3 + 1] = b; idx[t * 3 + 2] = c; t++; };

  for (const it of inside) {
    if (kind === 'trees') {
      let zMin = terrainZ(M, it.x, it.y);
      for (let k = 0; k < 4; k++) zMin = Math.min(zMin, terrainZ(M, it.x + Math.cos(k * Math.PI / 2) * it.r, it.y + Math.sin(k * Math.PI / 2) * it.r));
      const zb = zMin - 0.3, zTop = terrainZ(M, it.x, it.y) + it.h;
      const ring = [];
      for (let k = 0; k < SEG; k++) {
        const a = (k / SEG) * Math.PI * 2;
        ring.push(P(it.x + Math.cos(a) * it.r, it.y + Math.sin(a) * it.r, zb));
      }
      const c = P(it.x, it.y, zb), apex = P(it.x, it.y, zTop);
      for (let k = 0; k < SEG; k++) {
        const a = ring[k], b = ring[(k + 1) % SEG];
        T(a, b, apex);
        T(c, b, a);
      }
    } else {
      const ca = Math.cos(it.ang), sa = Math.sin(it.ang);
      const W = (u, w) => [it.x + u * ca - w * sa, it.y + u * sa + w * ca];
      const L2 = it.L / 2, W2 = it.Wd / 2;
      const corners = [W(-L2, -W2), W(L2, -W2), W(L2, W2), W(-L2, W2)];
      const zs = corners.map(([x, y]) => terrainZ(M, x, y));
      const z0 = Math.min(...zs) - 0.3, zw = Math.max(...zs) + it.wallH, zr = zw + it.roofH;
      const b = corners.map(([x, y]) => P(x, y, z0));
      const tp = corners.map(([x, y]) => P(x, y, zw));
      const r0 = P(...W(-L2, 0), zr), r1 = P(...W(L2, 0), zr);
      const [v0, v1, v2, v3] = b, [v4, v5, v6, v7] = tp;
      T(v0, v2, v1); T(v0, v3, v2); // bunn
      T(v0, v1, v5); T(v0, v5, v4); // langvegg sør
      T(v2, v3, v7); T(v2, v7, v6); // langvegg nord
      T(v1, v2, v6); T(v1, v6, r1); T(v1, r1, v5); // gavl øst
      T(v3, v0, v4); T(v3, v4, r0); T(v3, r0, v7); // gavl vest
      T(v4, v5, r1); T(v4, r1, r0); // tak sør
      T(v6, v7, r0); T(v6, r0, r1); // tak nord
    }
  }
  return { positions: pos, indices: idx, triCls: new Uint8Array(t).fill(WALL) };
}
