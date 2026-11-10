// Bygger en lukket (vanntett) mesh for én flis: toppflate fra høyderutenettet, vegger og flat bunn.
// Flisen kan være et vilkårlig konvekst polygon (rektangel, sekskant, sirkel …): rutenettet klippes
// mot polygonet, og veggene følger polygonkanten.
// Koordinater i mm. x øst, y nord, z opp. Bunnen ligger på z = 0.

export const WALL = 255;
const EPS = 1e-6;

// Indekser fra a til og med b med gitt steg (b er alltid med).
export function indexRange(a, b, step) {
  const out = [];
  for (let i = a; i < b; i += step) out.push(i);
  if (out.length > 1 && b - out[out.length - 1] < step / 2) out.pop();
  out.push(b);
  return out;
}

// ---------- Polygonhjelpere (konvekse polygoner, mot klokka, [[x,y], …]) ----------

export function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

// Kanter som halvplan: f(x,y) = nx*x + ny*y + c ≥ 0 betyr innenfor (avstand i mm).
export function polyEdges(p) {
  return p.map(([x1, y1], i) => {
    const [x2, y2] = p[(i + 1) % p.length];
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const nx = -(y2 - y1) / len, ny = (x2 - x1) / len;
    return { nx, ny, c: -(nx * x1 + ny * y1), x1, y1, ex: (x2 - x1) / len, ey: (y2 - y1) / len, len };
  });
}

// Minste avstand innover fra kantene (negativ = utenfor).
export function insideDist(edges, x, y) {
  let m = Infinity;
  for (const e of edges) {
    const d = e.nx * x + e.ny * y + e.c;
    if (d < m) m = d;
  }
  return m;
}

// Sutherland–Hodgman: klipp polygon (punkter [x,y,…]) mot konvekst polygon.
export function clipPoly(subject, clip) {
  let out = subject;
  for (const e of polyEdges(clip)) {
    const inp = out;
    out = [];
    if (!inp.length) break;
    for (let i = 0; i < inp.length; i++) {
      const a = inp[i], b = inp[(i + 1) % inp.length];
      const fa = e.nx * a[0] + e.ny * a[1] + e.c, fb = e.nx * b[0] + e.ny * b[1] + e.c;
      if (fa >= -EPS) out.push(a);
      if ((fa >= -EPS) !== (fb >= -EPS) && !(fa >= -EPS && Math.abs(fa) <= EPS) && !(fb >= -EPS && Math.abs(fb) <= EPS)) {
        out.push(lerpPt(a, b, fa, fb));
      }
    }
  }
  return out;
}

// Skjæringspunkt beregnet i fast rekkefølge, slik at naboceller får nøyaktig samme punkt.
function lerpPt(a, b, fa, fb) {
  if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) { [a, b] = [b, a]; [fa, fb] = [fb, fa]; }
  const t = Math.min(1, Math.max(0, fa / (fa - fb)));
  const p = [];
  for (let k = 0; k < a.length; k++) p.push(k === 3 ? -1 : a[k] + (b[k] - a[k]) * t);
  return p;
}

// Voksende typet buffer.
class Buf {
  constructor(T, cap) { this.T = T; this.a = new T(Math.max(16, cap)); this.n = 0; }
  grow(k) {
    if (this.n + k <= this.a.length) return;
    const b = new this.T(Math.max(this.a.length * 2, this.n + k));
    b.set(this.a); this.a = b;
  }
  push1(v) { this.grow(1); this.a[this.n++] = v; }
  push3(x, y, z) { this.grow(3); this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z; }
  done() { return this.a.slice(0, this.n); }
}

// ---------- Flis-mesh ----------

// M: { NX, NY, dx, dy, z: Float32Array(NX*NY), cls: Uint8Array((NX-1)*(NY-1)) }
// cols/rows: punktindekser i det globale rutenettet (rad 0 = nord).
// poly: konvekst polygon i flisens lokale mm (origo i flisens sørvestre hjørne). Standard: hele flisen.
// engrave: { shapes: [{ outer, holes }], depth, triangulate } – tekst som graveres inn i bunnen (valgfritt).
export function buildTileMesh(M, cols, rows, poly, engrave) {
  const { NX, NY, dx, dy, z, cls } = M;
  const cw = NX - 1;
  const w = cols.length, h = rows.length;
  const x0 = cols[0], yRef = rows[h - 1];
  const width = (cols[w - 1] - x0) * dx, height = (yRef - rows[0]) * dy;
  if (!poly) poly = [[0, 0], [width, 0], [width, height], [0, height]];
  const edges = polyEdges(poly);

  // Hjørnepunkter i flisens lokale mm.
  const gx = (a) => (cols[a] - x0) * dx;
  const gy = (b) => (yRef - rows[b]) * dy;

  const P = new Buf(Float64Array, (w * h + 4 * (w + h)) * 3);
  const gridIdx = new Int32Array(w * h).fill(-1);
  const keyIdx = new Map();
  const addV = (x, y, zz) => { P.push3(x, y, zz); return P.n / 3 - 1; };
  const gv = (a, b) => {
    const k = b * w + a;
    if (gridIdx[k] < 0) gridIdx[k] = addV(gx(a), gy(b), z[rows[b] * NX + cols[a]]);
    return gridIdx[k];
  };
  // Snapp til polygonhjørner, ellers del punkter på avrundet posisjon.
  const pv = (p) => {
    if (p[3] >= 0) return gv(p[3] % w, Math.floor(p[3] / w));
    let x = p[0], y = p[1];
    for (const [cx, cy] of poly) if (Math.abs(cx - x) < 1e-5 && Math.abs(cy - y) < 1e-5) { x = cx; y = cy; break; }
    const key = Math.round(x * 1e4) * 1e9 + Math.round(y * 1e4);
    let i = keyIdx.get(key);
    if (i === undefined) { i = addV(x, y, p[2]); keyIdx.set(key, i); }
    return i;
  };

  const inside = new Uint8Array(w * h);
  for (let b = 0; b < h; b++) for (let a = 0; a < w; a++) inside[b * w + a] = insideDist(edges, gx(a), gy(b)) >= -EPS ? 1 : 0;

  const I = new Buf(Uint32Array, 2 * w * h * 3 + 64), C = new Buf(Uint8Array, 2 * w * h + 64);
  const tri = (p, q, r, c) => { I.push3(p, q, r); C.push1(c); };
  const corner = (a, b) => [gx(a), gy(b), z[rows[b] * NX + cols[a]], b * w + a];

  for (let b = 0; b < h - 1; b++) {
    const cj = Math.min(NY - 2, (rows[b] + rows[b + 1]) >> 1);
    for (let a = 0; a < w - 1; a++) {
      const ci = Math.min(cw - 1, (cols[a] + cols[a + 1]) >> 1);
      const c = cls[cj * cw + ci];
      const ka = b * w + a, kb = ka + 1, kc = ka + w, kd = kc + 1;
      const n = inside[ka] + inside[kb] + inside[kc] + inside[kd];
      if (n === 4) {
        const va = gv(a, b), vb = gv(a + 1, b), vc = gv(a, b + 1), vd = gv(a + 1, b + 1);
        tri(vc, vd, vb, c);
        tri(vc, vb, va, c);
        continue;
      }
      // Helt utenfor én kant → hopp over.
      const xa = gx(a), xb = gx(a + 1), ya = gy(b), yc = gy(b + 1);
      let out = false;
      for (const e of edges) {
        if (Math.max(e.nx * xa + e.ny * ya, e.nx * xb + e.ny * ya, e.nx * xa + e.ny * yc, e.nx * xb + e.ny * yc) + e.c < -EPS) { out = true; break; }
      }
      if (out) continue;
      const A = corner(a, b), B = corner(a + 1, b), Cc = corner(a, b + 1), D = corner(a + 1, b + 1);
      for (const t of [[Cc, D, B], [Cc, B, A]]) {
        const pg = clipPoly(t, poly);
        if (pg.length < 3 || Math.abs(polyArea(pg)) < 1e-9) continue;
        const ids = pg.map(pv);
        for (let k = 1; k < ids.length - 1; k++) {
          if (ids[0] !== ids[k] && ids[k] !== ids[k + 1] && ids[0] !== ids[k + 1]) tri(ids[0], ids[k], ids[k + 1], c);
        }
      }
    }
  }

  // Randpunkter sortert langs omkretsen (mot klokka).
  const nTop = P.n / 3;
  const cum = [];
  let per = 0;
  for (const e of edges) { cum.push(per); per += e.len; }
  const used = new Uint8Array(nTop);
  for (let k = 0; k < I.n; k++) used[I.a[k]] = 1;
  const rim = [];
  for (let v = 0; v < nTop; v++) {
    if (!used[v]) continue;
    const x = P.a[v * 3], y = P.a[v * 3 + 1];
    for (let k = 0; k < edges.length; k++) {
      const e = edges[k];
      if (Math.abs(e.nx * x + e.ny * y + e.c) > 2e-5) continue;
      const t = (x - e.x1) * e.ex + (y - e.y1) * e.ey;
      if (t < -2e-5 || t > e.len + 2e-5) continue;
      rim.push([cum[k] + Math.max(0, t), v]);
      break;
    }
  }
  rim.sort((p, q) => p[0] - q[0]);
  const loop = rim.map((r) => r[1]);
  const L = loop.length;

  for (let i = 0; i < L; i++) P.push3(P.a[loop[i] * 3], P.a[loop[i] * 3 + 1], 0);
  for (let i = 0; i < L; i++) {
    const p = loop[i], q = loop[(i + 1) % L];
    const pb = nTop + i, qb = nTop + ((i + 1) % L);
    tri(p, pb, qb, WALL);
    tri(p, qb, q, WALL);
  }
  const bottomLoop = Array.from({ length: L }, (_, i) => nTop + i);
  if (!(engrave && engrave.shapes.length && engraveBottom(P, tri, addV, bottomLoop, engrave))) {
    let cx = 0, cy = 0;
    for (const [px, py] of poly) { cx += px; cy += py; }
    const center = addV(cx / poly.length, cy / poly.length, 0);
    for (let i = 0; i < L; i++) tri(center, bottomLoop[(i + 1) % L], bottomLoop[i], WALL);
  }
  return { positions: new Float32Array(P.a.subarray(0, P.n)), indices: I.done(), triCls: C.done(), width, height };
}

// ---------- Gravert tekst i bunnen ----------

const signedArea = (pts) => polyArea(pts);
const ccw = (pts) => (signedArea(pts) < 0 ? pts.slice().reverse() : pts);

// Bunnflaten (z = 0) trianguleres med bokstavene som hull. Hver bokstav blir et hulrom med tak på z = depth,
// vegger langs alle konturer og «øyer» (innsiden av o, a, ø …) som bunnflate. Alle flater peker ut av modellen.
// triangulate(contour, holes) → [[i, j, k], …] med indekser i contour ++ holes (som THREE.ShapeUtils.triangulateShape).
// Syr sammen to løkker (ytre: konveks rand, indre: konveks boks) sortert etter vinkel rundt c.
function stitch(outer, inner, xy, c, faceDown) {
  const ang = (v) => { const [x, y] = xy(v); const a = Math.atan2(y - c[1], x - c[0]); return a < 0 ? a + 2 * Math.PI : a; };
  const seq = (loop) => {
    const a = loop.map(ang);
    let s = 0;
    for (let i = 1; i < a.length; i++) if (a[i] < a[s]) s = i;
    const ids = [], an = [];
    for (let k = 0; k <= loop.length; k++) {
      const i = (s + k) % loop.length;
      ids.push(loop[i]);
      let v = a[i] + (k === loop.length ? 2 * Math.PI : 0);
      if (k > 0 && k < loop.length && v < an[k - 1]) v += 2 * Math.PI;
      an.push(v);
    }
    return { ids, an };
  };
  const O = seq(outer), I = seq(inner);
  const nO = outer.length, nI = inner.length, faces = [], ids = [];
  const id = (v) => { ids.push(v); return ids.length - 1; };
  let i = 0, j = 0;
  while (i < nO || j < nI) {
    if (j === nI || (i < nO && O.an[i + 1] <= I.an[j + 1])) { faces.push([id(O.ids[i]), id(O.ids[i + 1]), id(I.ids[j])]); i++; }
    else { faces.push([id(O.ids[i]), id(I.ids[j + 1]), id(I.ids[j])]); j++; }
  }
  faceDown(ids, faces);
}

function engraveBottom(P, tri, addV, bottomLoop, { shapes, box, depth, triangulate }) {
  const xy = (v) => [P.a[v * 3], P.a[v * 3 + 1]];
  // Flate med normal ned (−z): trekanter med negativt areal sett ovenfra.
  const faceDown = (ids, faces) => {
    // Degenererte trekanter (kolineære randpunkter) må beholdes for å unngå hull; de får flertallets retning.
    const crs = faces.map(([i, j, k]) => {
      const a = xy(ids[i]), b = xy(ids[j]), c = xy(ids[k]);
      return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    });
    const major = crs.reduce((s, c) => s + Math.sign(c), 0) < 0 ? -1 : 1;
    faces.forEach(([i, j, k], n) => {
      const sg = Math.abs(crs[n]) < 1e-12 ? major : Math.sign(crs[n]);
      if (sg < 0) tri(ids[i], ids[j], ids[k], WALL);
      else tri(ids[i], ids[k], ids[j], WALL);
    });
  };
  const v2 = (p) => ({ x: p[0], y: p[1] });

  const rimPts = bottomLoop.map(xy);
  const glyphs = shapes.map((s) => ({ outer: ccw(s.outer), holes: s.holes.map(ccw) }));
  // Hver kontur får toppunkter på z = 0 og z = depth.
  const ring = (pts) => ({ lo: pts.map(([x, y]) => addV(x, y, 0)), hi: pts.map(([x, y]) => addV(x, y, depth)) });

  const outerRings = glyphs.map((g) => ring(g.outer));
  const holeRings = glyphs.map((g) => g.holes.map(ring));

  // 1) Bunnflate: tekstboks (rektangel) med bokstavhull, og en ring mellom randen og boksen.
  const [bx0, by0, bx1, by1] = box;
  const boxIds = [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]].map(([x, y]) => addV(x, y, 0));
  const bFaces = triangulate(boxIds.map((v) => v2(xy(v))), glyphs.map((g) => g.outer.map(v2)));
  if (!bFaces.length) return false;
  faceDown([...boxIds, ...outerRings.flatMap((r) => r.lo)], bFaces);
  stitch(bottomLoop, boxIds, xy, [(bx0 + bx1) / 2, (by0 + by1) / 2], faceDown);

  glyphs.forEach((g, gi) => {
    const o = outerRings[gi], hs = holeRings[gi];
    // 2) Tak i hulrommet (z = depth), normal ned.
    faceDown([...o.hi, ...hs.flatMap((r) => r.hi)], triangulate(g.outer.map(v2), g.holes.map((h) => h.map(v2))));
    // 3) Øyer (bokstavenes indre hull) som bunnflate på z = 0.
    g.holes.forEach((h, hi) => faceDown(hs[hi].lo, triangulate(h.map(v2), [])));
    // 4) Vegger. Ytterkontur (mot klokka): normal mot venstre (inn i hulrommet). Hull: normal mot høyre.
    const wall = (r, inward) => {
      const n = r.lo.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const p0 = r.lo[i], q0 = r.lo[j], p1 = r.hi[i], q1 = r.hi[j];
        if (inward) { tri(p0, q1, q0, WALL); tri(p0, p1, q1, WALL); }
        else { tri(p0, q0, q1, WALL); tri(p0, q1, p1, WALL); }
      }
    };
    wall(o, true);
    hs.forEach((r) => wall(r, false));
  });
  return true;
}

// Innlagt tekst: bokstavene som egne, lukkede prismer fra z = 0 til depth. De fyller nøyaktig hulrommet
// engraveBottom lager, så teksten kan printes i et annet filament uten hulrom.
export function textPrism({ shapes, depth, triangulate }) {
  const P = new Buf(Float64Array, 1024), I = new Buf(Uint32Array, 1024), C = new Buf(Uint8Array, 256);
  const addV = (x, y, z) => { P.push3(x, y, z); return P.n / 3 - 1; };
  const tri = (a, b, c) => { I.push3(a, b, c); C.push1(WALL); };
  const v2 = (p) => ({ x: p[0], y: p[1] });
  const xy = (v) => [P.a[v * 3], P.a[v * 3 + 1]];
  const face = (ids, faces, up) => {
    const crs = faces.map(([i, j, k]) => {
      const a = xy(ids[i]), b = xy(ids[j]), c = xy(ids[k]);
      return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    });
    const major = crs.reduce((s, c) => s + Math.sign(c), 0) < 0 ? -1 : 1;
    faces.forEach(([i, j, k], n) => {
      const sg = Math.abs(crs[n]) < 1e-12 ? major : Math.sign(crs[n]);
      if ((sg > 0) === up) tri(ids[i], ids[j], ids[k]);
      else tri(ids[i], ids[k], ids[j]);
    });
  };
  for (const sh of shapes) {
    const outer = ccw(sh.outer), holes = sh.holes.map(ccw);
    const rings = [outer, ...holes].map((pts) => ({ lo: pts.map(([x, y]) => addV(x, y, 0)), hi: pts.map(([x, y]) => addV(x, y, depth)) }));
    const faces = triangulate(outer.map(v2), holes.map((h) => h.map(v2)));
    face(rings.flatMap((r) => r.lo), faces, false);
    face(rings.flatMap((r) => r.hi), faces, true);
    // Vegger med normal ut av bokstaven: ytterkontur (mot klokka) → høyre, hull → venstre.
    rings.forEach((r, ri) => {
      const n = r.lo.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, p0 = r.lo[i], q0 = r.lo[j], p1 = r.hi[i], q1 = r.hi[j];
        if (ri === 0) { tri(p0, q0, q1); tri(p0, q1, p1); }
        else { tri(p0, q1, q0); tri(p0, p1, q1); }
      }
    });
  }
  return { positions: new Float32Array(P.a.subarray(0, P.n)), indices: I.done(), triCls: C.done() };
}
