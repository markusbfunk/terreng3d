import { lonToX, latToY, xToLon, yToLat, metersPerUnit } from './geo.js';
import { ELEVATION, COLOR_SOURCES, BASEMAPS, inNorway } from './sources.js';
import { chooseZoom, fetchMosaic } from './tiles.js';
import { quantizeColors, majorityFilter, compactPalette } from './colors.js';
import { BASE_CLASS, OSM_CLASSES, fetchOsm, rasterizeOsm } from './osm.js';
import { textPrism, buildTileMesh, indexRange, clipPoly, polyArea, polyEdges, insideDist } from './mesh.js';
import { SHAPES, shapeAspect, shapePoly } from './shapes.js';
import { ELEV_SOURCES, KARTVERKET, sampleElevation } from './elevation.js';
import { placeTrees, placeBuildings, buildSymbolMesh } from './symbols.js';
import { build3mf } from './export3mf.js';
import { Preview } from './preview.js';
import { loadFont, labelShapes, triangulate, placeName, coordText } from './label.js';
import { CLASSES, SYMBOL_COLORS, WATER_BASE, classifyKartverket, planClasses, buildPalette, baseCounts, finalizePalette, roadMaskFrom } from './landclass.js';

const $ = (id) => document.getElementById(id);
const num = (id) => parseFloat($(id).value);
const MAX_POINTS = 8e6;

const state = { sel: null, outline: null, handles: null, model: null, drawing: false, drawStart: null, preview: null, busy: false };

// ---------------- Kart ----------------
const map = L.map('map').setView([62.49, 7.72], 11);
const baseLayers = {};
BASEMAPS.forEach((b, i) => {
  const layer = L.tileLayer(b.url, { maxZoom: 19, maxNativeZoom: b.maxZoom, attribution: b.attribution });
  baseLayers[b.name] = layer;
  if (i === 0) layer.addTo(map);
});
L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);
const overlay = L.layerGroup().addTo(map);

for (const [k, s] of Object.entries(SHAPES)) $('shape').add(new Option(s.name, k));

// Utsnittet: senter (lat/lon), størrelse i meter og rotasjon i grader med klokka.
// For regulære former er høyden låst til formens forhold.
function normSel(s) {
  const asp = shapeAspect($('shape').value);
  s.wM = Math.max(50, s.wM);
  s.hM = asp ? s.wM * asp : Math.max(50, s.hM);
  s.rot = ((((s.rot || 0) + 180) % 360) + 360) % 360 - 180;
  return s;
}

function selFromBounds(b) {
  const x1 = lonToX(b.getWest()), x2 = lonToX(b.getEast()), y1 = latToY(b.getNorth()), y2 = latToY(b.getSouth());
  const c = b.getCenter(), mpu = metersPerUnit(c.lat);
  let wM = (x2 - x1) * mpu, hM = (y2 - y1) * mpu;
  const asp = shapeAspect($('shape').value);
  if (asp) wM = Math.min(wM, hM / asp);
  return { lat: c.lat, lon: c.lng, wM, hM, rot: 0 };
}

// Lokale meter (lx langs bredden, ly langs høyden i utsnittets egen retning) relativt til senter.
function toLocalM(s, latlng) {
  const mpu = metersPerUnit(s.lat), th = (s.rot * Math.PI) / 180;
  const east = (lonToX(latlng.lng) - lonToX(s.lon)) * mpu, north = (latToY(s.lat) - latToY(latlng.lat)) * mpu;
  return [east * Math.cos(th) - north * Math.sin(th), east * Math.sin(th) + north * Math.cos(th)];
}
function fromLocalM(s, lx, ly) {
  const mpu = metersPerUnit(s.lat), th = (s.rot * Math.PI) / 180;
  const east = lx * Math.cos(th) + ly * Math.sin(th), north = -lx * Math.sin(th) + ly * Math.cos(th);
  return L.latLng(yToLat(latToY(s.lat) - north / mpu), xToLon(lonToX(s.lon) + east / mpu));
}

function handlePos(s) {
  return {
    move: L.latLng(s.lat, s.lon),
    size: fromLocalM(s, s.wM / 2, s.hM / 2),
    rot: fromLocalM(s, 0, s.hM / 2 + Math.max(s.wM, s.hM) * 0.12),
  };
}

function ensureHandles() {
  if (state.handles) return;
  const mk = (cls, title) =>
    L.marker([0, 0], { draggable: true, title, icon: L.divIcon({ className: 'handle ' + cls, iconSize: [16, 16] }), zIndexOffset: 1000 }).addTo(map);
  const h = { move: mk('h-move', 'Dra for å flytte'), size: mk('h-size', 'Dra for å endre størrelse'), rot: mk('h-rot', 'Dra for å rotere') };
  h.move.on('drag', (e) => { state.sel.lat = e.latlng.lat; state.sel.lon = e.latlng.lng; drawSel('move'); });
  h.size.on('drag', (e) => {
    const s = state.sel, [lx, ly] = toLocalM(s, e.latlng);
    const asp = shapeAspect($('shape').value);
    s.wM = asp ? Math.max(2 * Math.abs(lx), (2 * Math.abs(ly)) / asp) : 2 * Math.abs(lx);
    s.hM = 2 * Math.abs(ly);
    normSel(s);
    drawSel('size');
  });
  h.rot.on('drag', (e) => {
    const s = state.sel, mpu = metersPerUnit(s.lat);
    const east = (lonToX(e.latlng.lng) - lonToX(s.lon)) * mpu, north = (latToY(s.lat) - latToY(e.latlng.lat)) * mpu;
    s.rot = Math.round((Math.atan2(east, north) * 180) / Math.PI);
    normSel(s);
    drawSel('rot');
  });
  for (const m of Object.values(h)) m.on('dragend', () => setSel(state.sel));
  state.handles = h;
}

// Tegner utsnittet uten å endre lenken (brukes også under dra).
function drawSel(skip) {
  const s = state.sel;
  const lay = layout();
  const ring = lay.poly.map(([x, y]) => lay.toLatLng(x, y));
  if (!state.outline) state.outline = L.polygon(ring, { color: '#e4572e', weight: 2, fillOpacity: 0.06, interactive: false }).addTo(map);
  else state.outline.setLatLngs(ring);
  ensureHandles();
  const hp = handlePos(s);
  for (const k of ['move', 'size', 'rot']) if (k !== skip) state.handles[k].setLatLng(hp[k]);
  if (document.activeElement !== $('rot')) $('rot').value = s.rot;
  if (document.activeElement !== $('rotSlider')) $('rotSlider').value = s.rot;
  $('rotOut').textContent = s.rot + '°';
  updateOverlay(lay);
}

function setSel(s) {
  state.sel = normSel(s);
  drawSel();
  markStale();
  // Del utsnittet via lenke.
  const f = (v, d) => v.toFixed(d);
  const h = `#c=${f(s.lat, 5)},${f(s.lon, 5)}&s=${f(s.wM, 0)},${f(s.hM, 0)}&r=${s.rot}&f=${$('shape').value}`;
  history.replaceState(null, '', h);
}

function selFromHash() {
  const hs = location.hash;
  const shape = hs.match(/[#&]f=(\w+)/);
  if (shape && SHAPES[shape[1]]) $('shape').value = shape[1];
  const c = hs.match(/[#&]c=([-\d.]+),([-\d.]+)/), sz = hs.match(/[#&]s=([\d.]+),([\d.]+)/), r = hs.match(/[#&]r=([-\d.]+)/);
  if (c && sz) return { lat: +c[1], lon: +c[2], wM: +sz[1], hM: +sz[2], rot: r ? +r[1] : 0 };
  const m = hs.match(/bbox=([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)/);
  if (!m) return null;
  const [so, w, n, e] = m.slice(1).map(Number);
  return so < n && w < e ? selFromBounds(L.latLngBounds([so, w], [n, e])) : null;
}
window.addEventListener('hashchange', () => {
  const s = selFromHash();
  if (s) { setSel(s); map.fitBounds(state.outline.getBounds().pad(0.15)); }
});

// Rotasjon: slider (dra) og tallfelt holdes i takt.
function setRot(v) {
  if (!state.sel) return;
  state.sel.rot = Math.max(-180, Math.min(180, Math.round(+v || 0)));
  setSel(state.sel);
}
$('rotSlider').addEventListener('input', () => setRot($('rotSlider').value));
$('rot').addEventListener('change', () => setRot(num('rot')));
$('shape').addEventListener('change', () => { if (state.sel) setSel(state.sel); });

function stopDrawing() {
  state.drawing = false;
  state.drawStart = null;
  map.dragging.enable();
  map.getContainer().classList.remove('drawing');
  $('drawBtn').classList.remove('active');
}

$('drawBtn').onclick = () => {
  if (state.drawing) return stopDrawing();
  state.drawing = true;
  map.dragging.disable();
  map.getContainer().classList.add('drawing');
  $('drawBtn').classList.add('active');
};
map.on('mousedown', (e) => { if (state.drawing) state.drawStart = e.latlng; });
map.on('mousemove', (e) => {
  if (!state.drawing || !state.drawStart) return;
  const p1 = map.latLngToContainerPoint(state.drawStart), p2 = map.latLngToContainerPoint(e.latlng);
  if (Math.abs(p1.x - p2.x) < 8 || Math.abs(p1.y - p2.y) < 8) return;
  state.sel = normSel(selFromBounds(L.latLngBounds(state.drawStart, e.latlng)));
  drawSel();
});
map.on('mouseup', (e) => {
  if (!state.drawing || !state.drawStart) return;
  const b = L.latLngBounds(state.drawStart, e.latlng);
  stopDrawing();
  const p1 = map.latLngToContainerPoint(b.getNorthWest()), p2 = map.latLngToContainerPoint(b.getSouthEast());
  if (Math.abs(p1.x - p2.x) < 8 || Math.abs(p1.y - p2.y) < 8) return;
  setSel(selFromBounds(b));
});
$('viewBtn').onclick = () => setSel(selFromBounds(map.getBounds().pad(-0.12)));

$('searchForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('searchInput').value.trim();
  if (!q) return;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
    const res = await r.json();
    if (!res.length) return setStatus(`Fant ikke «${q}».`, true);
    const [s, n, w, ee] = res[0].boundingbox.map(Number);
    map.fitBounds([[s, w], [n, ee]], { maxZoom: 13 });
    setStatus(res[0].display_name);
  } catch (err) {
    setStatus('Søket feilet: ' + err.message, true);
  }
};

// ---------------- Oppsett / fliser ----------------
// Modellkoordinater: mm, x langs utsnittets bredde (0..W), y langs høyden (0..H, «sør» → «nord»).
// Rutenettpunkt (i, j) ligger i x = i·dx, y = H − j·dy (rad 0 øverst).
function layout() {
  const s = state.sel;
  if (!s) return null;
  const shape = $('shape').value;
  const wM = s.wM, hM = s.hM;
  const cx = lonToX(s.lon), cy = latToY(s.lat);
  const mpu = metersPerUnit(s.lat);
  const th = (s.rot * Math.PI) / 180, co = Math.cos(th), si = Math.sin(th);
  const W = Math.max(10, num('widthMm') || 200);
  const H = (W * hM) / wM;
  const scaleMmPerM = W / wM;
  const toXY = (xm, ym) => {
    const lx = xm / scaleMmPerM - wM / 2, ly = ym / scaleMmPerM - hM / 2;
    return [cx + (lx * co + ly * si) / mpu, cy - (-lx * si + ly * co) / mpu];
  };
  const toMM = (x, y) => {
    const east = (x - cx) * mpu, north = (cy - y) * mpu;
    return [(east * co - north * si + wM / 2) * scaleMmPerM, (east * si + north * co + hM / 2) * scaleMmPerM];
  };
  const toLatLng = (xm, ym) => { const [x, y] = toXY(xm, ym); return L.latLng(yToLat(y), xToLon(x)); };

  const maxTile = Math.max(20, num('maxTile') || 300);
  const res = Math.max(0.1, num('res') || 0.4);
  const cols = Math.max(1, Math.ceil(W / maxTile - 1e-9));
  const rows = Math.max(1, Math.ceil(H / maxTile - 1e-9));
  const NX = Math.max(cols + 1, Math.round(W / res) + 1);
  const NY = Math.max(rows + 1, Math.round(H / res) + 1);
  const dx = W / (NX - 1), dy = H / (NY - 1);
  const gridXY = (fi, fj) => toXY(fi * dx, H - fj * dy);
  const colBreaks = Array.from({ length: cols + 1 }, (_, k) => Math.round((k * (NX - 1)) / cols));
  const rowBreaks = Array.from({ length: rows + 1 }, (_, k) => Math.round((k * (NY - 1)) / rows));
  const poly = shapePoly(shape, W, H);

  // Fliser: rutenettrektangler klippet mot formen (tomme fliser utelates).
  const tiles = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x0 = colBreaks[c] * dx, x1 = colBreaks[c + 1] * dx;
      const y0 = (NY - 1 - rowBreaks[r + 1]) * dy, y1 = (NY - 1 - rowBreaks[r]) * dy;
      const gpoly = clipPoly(poly, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
      if (gpoly.length < 3 || polyArea(gpoly) < 1) continue;
      const xs = gpoly.map((p) => p[0]), ys = gpoly.map((p) => p[1]);
      tiles.push({
        r, c, name: tileName(r, c), rect: { x0, x1, y0, y1 }, gpoly,
        poly: gpoly.map(([x, y]) => [x - x0, y - y0]),
        w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
      });
    }

  const corners = [[0, 0], [W, 0], [W, H], [0, H]].map(([a, b]) => toXY(a, b));
  const x1 = Math.min(...corners.map((p) => p[0])), x2 = Math.max(...corners.map((p) => p[0]));
  const y1 = Math.min(...corners.map((p) => p[1])), y2 = Math.max(...corners.map((p) => p[1]));
  return {
    x1, x2, y1, y2, latc: s.lat, mpu, widthM: wM, heightM: hM, W, H, cols, rows, NX, NY,
    dx, dy, colBreaks, rowBreaks, scaleMmPerM, toXY, toMM, toLatLng, gridXY, poly, tiles, shape, rot: s.rot,
    center: { lat: s.lat, lon: s.lon },
    bbox: { s: yToLat(y2), n: yToLat(y1), w: xToLon(x1), e: xToLon(x2) },
  };
}

const tileName = (r, c) => `R${r + 1}K${c + 1}`;

// Klipp et linjestykke mot et konvekst polygon (Cyrus–Beck).
function clipSeg(a, b, poly) {
  let t0 = 0, t1 = 1;
  for (const e of polyEdges(poly)) {
    const fa = e.nx * a[0] + e.ny * a[1] + e.c, fb = e.nx * b[0] + e.ny * b[1] + e.c;
    if (fa < 0 && fb < 0) return null;
    if (fa < 0) t0 = Math.max(t0, fa / (fa - fb));
    else if (fb < 0) t1 = Math.min(t1, fa / (fa - fb));
  }
  if (t1 - t0 < 1e-6) return null;
  const p = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return [p(t0), p(t1)];
}

function updateOverlay(lay = layout()) {
  overlay.clearLayers();
  if (!lay) return;
  const style = { color: '#e4572e', weight: 1.5, dashArray: '5 4', interactive: false };
  const line = (a, b) => {
    const seg = clipSeg(a, b, lay.poly);
    if (seg) L.polyline(seg.map(([x, y]) => lay.toLatLng(x, y)), style).addTo(overlay);
  };
  for (let k = 1; k < lay.cols; k++) { const x = lay.colBreaks[k] * lay.dx; line([x, 0], [x, lay.H]); }
  for (let k = 1; k < lay.rows; k++) { const y = (lay.NY - 1 - lay.rowBreaks[k]) * lay.dy; line([0, y], [lay.W, y]); }
  if (lay.tiles.length > 1) {
    for (const t of lay.tiles) {
      const cx = t.gpoly.reduce((s, p) => s + p[0], 0) / t.gpoly.length, cy = t.gpoly.reduce((s, p) => s + p[1], 0) / t.gpoly.length;
      const icon = L.divIcon({ className: 'tile-label', html: t.name, iconSize: [40, 16] });
      L.marker(lay.toLatLng(cx, cy), { icon, interactive: false }).addTo(overlay);
    }
  }
  const km = (m) => (m >= 10000 ? (m / 1000).toFixed(0) : (m / 1000).toFixed(1));
  const pts = lay.NX * lay.NY;
  const big = lay.tiles.reduce((a, t) => (t.w * t.h > a.w * a.h ? t : a), lay.tiles[0] || { w: 0, h: 0 });
  const lines = [
    `Område: ${km(lay.widthM)} × ${km(lay.heightM)} km · ${SHAPES[lay.shape].name.split(' (')[0].toLowerCase()}, rotert ${lay.rot}°`,
    `Modell: ${lay.W.toFixed(0)} × ${lay.H.toFixed(0)} mm · målestokk 1:${Math.round(1000 / lay.scaleMmPerM).toLocaleString('no')}`,
    `Fliser: ${lay.tiles.length} (største ca. ${big.w.toFixed(0)} × ${big.h.toFixed(0)} mm)`,
    `Rutenett: ${lay.NX} × ${lay.NY} punkter · 1 punkt = ${(lay.dx / lay.scaleMmPerM).toFixed(1)} m i terrenget`,
  ];
  let html = lines.map((l) => `<div>${l}</div>`).join('');
  if (pts > MAX_POINTS) html += `<div class="warn">For mange punkter (${(pts / 1e6).toFixed(1)} mill.). Øk mm/punkt eller minsk bredden.</div>`;
  else if (pts > 3e6) html += `<div class="warn">Stor modell – generering og eksport kan ta en stund.</div>`;
  $('layoutInfo').innerHTML = html;
}

for (const id of ['widthMm', 'maxTile', 'res']) $(id).addEventListener('input', () => { if (state.sel) drawSel(); markStale(); });
for (const id of ['colorSrc', 'nColors', 'smooth', 'seaWater', 'elevSrc', 'symTrees', 'symBuildings', 'roads', 'roadLevel', 'treeSpacing', 'treeHeight', 'treeDiam', 'treeFill', 'bldMin', 'bldMinH'])
  $(id).addEventListener('change', markStale);
for (const [k, s] of Object.entries(ELEV_SOURCES)) $('elevSrc').add(new Option(s.name, k));
const syncSymOpts = () => {
  $('treeOpts').hidden = !$('symTrees').checked;
  $('bldOpts').hidden = !$('symBuildings').checked;
  if ($('credits').innerHTML) updateCredits(state.model?.used);
};
$('symTrees').addEventListener('change', syncSymOpts);
$('symBuildings').addEventListener('change', syncSymOpts);
syncSymOpts();

// Høydeparametre kan oppdateres uten å hente data på nytt.
for (const id of ['exag', 'base', 'seaStep', 'flatSea']) {
  $(id).addEventListener('change', () => {
    if (!state.model || state.busy) return;
    computeHeights(state.model);
    renderPreview(false);
  });
}

function markStale() {
  if (state.model) $('staleNote').hidden = false;
}

// ---------------- Fargekilde-UI ----------------
for (const [k, s] of Object.entries(COLOR_SOURCES)) $('colorSrc').add(new Option(s.name, k));
OSM_CLASSES.forEach((c) => {
  const lab = document.createElement('label');
  lab.className = 'check';
  lab.innerHTML = `<input type="checkbox" data-cls="${c.id}" ${c.on ? 'checked' : ''}><span class="swatch" style="background:${c.color}"></span>${c.name}`;
  lab.querySelector('input').addEventListener('change', markStale);
  $('osmClasses').append(lab);
});
function onSourceChange() {
  const t = COLOR_SOURCES[$('colorSrc').value].type;
  $('osmOpts').hidden = t !== 'osm';
  $('rasterOpts').hidden = t !== 'raster';
  $('roadOpt').hidden = !COLOR_SOURCES[$('colorSrc').value].roads;
  $('roadLevelLbl').hidden = !COLOR_SOURCES[$('colorSrc').value].roads || !$('roads').checked;
  $('smooth').value = t === 'raster' ? 2 : 0;
  updateCredits();
}
$('colorSrc').addEventListener('change', onSourceChange);
$('roads').addEventListener('change', () => { $('roadLevelLbl').hidden = !$('roads').checked; });

function updateCredits(used) {
  const src = COLOR_SOURCES[$('colorSrc').value];
  const elev = used || [KARTVERKET.attribution + ' (i Norge)', ELEVATION.attribution];
  const sym = $('symTrees').checked || $('symBuildings').checked ? COLOR_SOURCES.osm.attribution : '';
  $('credits').innerHTML = [...elev, src.attribution, sym, 'Stedsøk: Nominatim / OpenStreetMap']
    .filter((s, i, a) => s && a.indexOf(s) === i).map((s) => `<div>${s}</div>`).join('');
}

// ---------------- Status ----------------
function setStatus(text, isError = false, frac = null) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
  const p = $('progress');
  p.hidden = frac === null;
  if (frac !== null) p.value = frac;
}

function setBusy(b) {
  state.busy = b;
  $('genBtn').disabled = b;
  document.querySelectorAll('#exports button').forEach((x) => (x.disabled = b));
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------- Generering ----------------
// Når trær/bygninger ikke får eget filament: trær deler med skog/land (den grønneste fargen),
// bygninger med bebyggelse (ellers den mørkeste fargen).
function shareSlot(palette, key) {
  const rgb = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
  const lum = (h) => { const [r, g, b] = rgb(h); return 0.299 * r + 0.587 * g + 0.114 * b; };
  let best;
  if (key === 'trees') {
    best = palette.find((p) => p.id === 'forest') || palette.find((p) => p.id === 'land');
    const score = (h) => { const [r, g, b] = rgb(h); return (g - Math.max(r, b)) * 2 - lum(h) * 0.5; };
    best ||= palette.reduce((a, p) => (score(p.color) > score(a.color) ? p : a));
  } else {
    best = palette.find((p) => p.id === 'built') || palette.reduce((a, p) => (lum(p.color) < lum(a.color) ? p : a));
  }
  return { slot: best.slot, color: best.color };
}

// Erstatter kjente kartfarger (± toleranse) med én felles farge, f.eks. alle typer bebyggelse.
function mergeColors(rgb, rules) {
  const hex = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
  const R = rules.map((r) => ({ to: hex(r.to), from: r.from.map(hex) }));
  for (let o = 0; o < rgb.length; o += 3) {
    for (const r of R) {
      if (r.from.some(([a, b, c]) => Math.abs(rgb[o] - a) + Math.abs(rgb[o + 1] - b) + Math.abs(rgb[o + 2] - c) <= 18)) {
        rgb[o] = r.to[0]; rgb[o + 1] = r.to[1]; rgb[o + 2] = r.to[2];
        break;
      }
    }
  }
}

// Fyller inn stedsnavn automatisk (med mindre brukeren har skrevet et eget).
async function autoLabel(M) {
  if (!labelOn()) return;
  const f = $('labelName');
  if (f.value && f.value !== f.dataset.auto) return;
  try {
    setStatus('Henter stedsnavn …', false, 0.97);
    const name = await placeName(M.center.lat, M.center.lon);
    f.value = f.dataset.auto = name;
  } catch (err) {
    console.warn(err);
  }
}

// Tekst som graveres inn i bunnen av én flis (null hvis av eller ikke plass).
async function tileEngrave(M, t) {
  if (!labelOn()) return null;
  const depth = Math.min(0.6, (Math.max(0.2, num('base') || 3)) - 0.4);
  if (depth < 0.2) return null;
  const font = await loadFont();
  const lines = [
    { text: $('labelName').value.trim(), scale: 1 },
    { text: coordText(M.center.lat, M.center.lon), scale: 0.55 },
  ];
  if (M.tiles.length > 1) lines.push({ text: 'Flis ' + t.name, scale: 0.55 });
  const size = Math.max(3.5, Math.min(8, 0.05 * Math.min(t.w, t.h)));
  // Får ikke alt plass, droppes koordinatene først, så flisnavnet.
  const tries = [lines, lines.filter((_, i) => i !== 1), lines.slice(0, 1)];
  let res = null;
  for (const ls of tries) if ((res = labelShapes(font, ls, t.poly, { size, minSize: 2.5, margin: 2 }))) break;
  return res ? { shapes: res.shapes, box: res.box, depth, triangulate } : null;
}

// Beregner tekst for alle fliser (brukes av forhåndsvisning og eksport).
const labelOn = () => $('labelMode').value !== 'off';
const labelInlay = () => $('labelMode').value === 'inlay';

// Innlagt tekst får en filamentplass (standard: den mørkeste fargen) og vises i filamentlisten.
function syncLabelEntry() {
  const M = state.model;
  if (!M) return;
  M.symPalette = M.symPalette.filter((s) => s.key !== 'label');
  if (labelInlay()) {
    const lum = (h) => { const [r, g, b] = [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)); return 0.299 * r + 0.587 * g + 0.114 * b; };
    const all = [...M.palette, ...M.symPalette];
    const prev = M.labelSlot && all.find((p) => p.slot === M.labelSlot);
    const pick = prev || all.reduce((a, p) => (lum(p.color) < lum(a.color) ? p : a));
    M.labelSlot = pick.slot;
    M.symPalette.push({ key: 'label', name: 'Tekst i bunnen – deler filament', slot: pick.slot, color: pick.color, pct: null });
  }
  renderPalette();
}
$('labelMode').addEventListener('change', () => { syncLabelEntry(); refreshColors(); renderExports(); });

async function updateEngraves() {
  const M = state.model;
  state.engraves = new Map();
  if (!M || !labelOn()) return;
  for (const t of M.tiles) {
    try { state.engraves.set(t.name, await tileEngrave(M, t)); } catch (err) { console.warn('Tekst i bunnen:', err); }
  }
}
for (const id of ['labelMode', 'labelName', 'base']) $(id).addEventListener('change', async () => { if (state.model) { await updateEngraves(); renderPreview(false); } });

async function generate() {
  const lay = layout();
  if (!lay) return setStatus('Velg et område i kartet først.', true);
  if (lay.NX * lay.NY > MAX_POINTS) return setStatus('Modellen har for mange punkter. Øk mm/punkt eller minsk bredden.', true);
  setBusy(true);
  try {
    const { NX, NY } = lay;
    const nx = NX - 1, ny = NY - 1;

    // 1) Høyde
    const sampleM = lay.dx / lay.scaleMmPerM;
    const { elevM, used } = await sampleElevation(lay, $('elevSrc').value, (t, p) => setStatus(t, false, p));

    // 2) OSM-data (arealtyper og/eller symboler) – én felles spørring
    let srcKey = $('colorSrc').value;
    if (COLOR_SOURCES[srcKey].norwayOnly && !inNorway(lay.bbox)) {
      // Kartverket-kartene er blanke utenfor Norge → bruk et globalt kart i stedet.
      srcKey = 'opentopomap';
      $('colorSrc').value = srcKey;
      onSourceChange();
      setStatus('Området ligger utenfor Norge – bruker OpenTopoMap som fargekilde.', false, 0.5);
      await new Promise((r) => setTimeout(r, 1200));
    }
    const src = COLOR_SOURCES[srcKey];
    const wantTrees = $('symTrees').checked, wantBld = $('symBuildings').checked;
    const enabled = src.type === 'osm' ? OSM_CLASSES.filter((c) => document.querySelector(`[data-cls="${c.id}"]`).checked) : [];
    const forestCls = OSM_CLASSES.find((c) => c.id === 'forest');
    const bldCls = OSM_CLASSES.find((c) => c.id === 'building');
    const queryCls = [...enabled];
    if (wantTrees && !queryCls.includes(forestCls)) queryCls.push(forestCls);
    if (wantBld && !queryCls.includes(bldCls)) queryCls.push(bldCls);
    let osmData = null;
    if (queryCls.length) {
      try {
        osmData = await fetchOsm(lay.bbox, queryCls, (t) => setStatus(t, false, 0.6));
      } catch (err) {
        if (src.type === 'osm') throw err;
        console.warn(err);
        setStatus('Symboler hoppes over: ' + err.message, true);
      }
    }

    // 3) Farger
    const budget = Math.max(2, Math.round(num('nColors')) || 6);
    const wantRoads = !!(src.roads && $('roads').checked);
    let cls, palette, keepFirst = false, roadMask = null, onWater = null, ownSym = { trees: true, buildings: true }, classPlan = null;
    if (src.type === 'osm') {
      if (enabled.length) {
        const data = osmData;
        setStatus('Tegner arealtyper …', false, 0.75);
        await tick();
        cls = rasterizeOsm(data, lay, enabled, nx, ny);
      } else cls = new Uint8Array(nx * ny);
      palette = [BASE_CLASS, ...enabled].map((c) => ({ name: c.name, color: c.color, id: c.id }));
      const wi = enabled.findIndex((c) => c.id === 'water');
      if (wi >= 0 && $('seaWater').checked) {
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const k = j * NX + i;
            if (Math.max(elevM[k], elevM[k + 1], elevM[k + NX], elevM[k + NX + 1]) <= 0) cls[j * nx + i] = wi + 1;
          }
      }
      keepFirst = true;
    } else if (src.type === 'raster') {
      const zc = chooseZoom(lay, sampleM / 1.5, src.maxZoom, 500);
      const cm = await fetchMosaic(src.url, zc, lay, 'rgb', (p) => setStatus(`Henter fargekart (zoom ${zc}) …`, false, 0.5 + p * 0.3));
      setStatus('Fordeler farger …', false, 0.85);
      await tick();
      const n = nx * ny;
      const rgb = new Uint8Array(n * 3), alpha = new Float32Array(n);
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const [x, y] = lay.gridXY(i + 0.5, j + 0.5);
          cm.rgb(x, y, rgb, (j * nx + i) * 3);
          alpha[j * nx + i] = cm.alpha(x, y);
        }
      if (src.classify) {
        // Kjente kartklasser med navn og naturlige farger; slås sammen etter prioritet ved få filamenter.
        const sea = new Uint8Array(n);
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const k = j * NX + i;
            sea[j * nx + i] = Math.max(elevM[k], elevM[k + 1], elevM[k + NX], elevM[k + NX + 1]) <= 0 ? 1 : 0;
          }
        const base = classifyKartverket(rgb, alpha, sea, n);
        onWater = base.map((b) => (b === WATER_BASE ? 1 : 0)); // ingen veier (fergeruter) på vann
        classPlan = planClasses(baseCounts(base), n, budget, { roads: wantRoads, trees: wantTrees, buildings: wantBld });
        ({ cls, palette } = buildPalette(base, classPlan));
        ownSym = { trees: classPlan.has('trees'), buildings: classPlan.has('buildings') };
      } else {
        // Andre kart: k-means. Trær/bygninger får egne filamenter hvis det blir minst tre kartfarger igjen.
        const nSym = (wantTrees ? 1 : 0) + (wantBld ? 1 : 0);
        const share = budget - nSym < 3;
        ownSym = { trees: !share, buildings: !share };
        ({ cls, palette } = quantizeColors(rgb, n, share ? budget : budget - nSym));
      }
      if (wantRoads && (!classPlan || classPlan.has('roads'))) {
        const rm = await fetchMosaic(src.roads, zc, lay, 'rgb', (p) => setStatus(`Henter veier (zoom ${zc}) …`, false, 0.85 + p * 0.05));
        roadMask = roadMaskFrom(rm, lay, nx, ny, $('roadLevel').value);
      }
    } else {
      cls = new Uint8Array(nx * ny);
      palette = [{ name: 'Terreng', color: '#cfc29a' }];
    }
    const passes = Math.round(num('smooth')) || 0;
    if (passes > 0) {
      setStatus('Fjerner støy …', false, 0.9);
      await tick();
      majorityFilter(cls, nx, ny, passes, palette.length);
    }
    // Veier legges på helt til slutt (etter støyfjerningen), så linjene blir hele.
    if (roadMask && roadMask.some((v) => v)) {
      const ri = palette.length;
      palette.push({ name: CLASSES.roads.name, color: CLASSES.roads.color, id: 'roads' });
      for (let i = 0; i < cls.length; i++) if (roadMask[i] && !(onWater && onWater[i])) cls[i] = ri;
    }
    if (src.classify) palette = finalizePalette(cls, palette);
    else {
      palette = compactPalette(cls, palette, keepFirst);
      if (src.type === 'raster') { let k = 0; palette.forEach((p) => { if (p.id !== 'roads') p.name = `Farge ${++k}`; }); }
    }

    const M = { ...lay, elevM, cls, palette, srcKey, z: null, used, symbols: {}, symPalette: [] };
    computeHeights(M);

    // 4) Symboler – egne filamenter med naturlige farger når budsjettet tillater det, ellers deler de med en kartfarge.
    if (osmData && (wantTrees || wantBld)) {
      setStatus('Plasserer symboler …', false, 0.95);
      await tick();
      let nextSlot = Math.max(...palette.map((p) => p.slot)) + 1;
      const symEntry = (key, count) => {
        const own = ownSym[key];
        const base = own ? { ...SYMBOL_COLORS[key], slot: Math.min(16, nextSlot++) } : { name: SYMBOL_COLORS[key].name, ...shareSlot(palette, key) };
        return { key, ...base, name: `${base.name} (${count})${own ? '' : ' – deler filament'}`, pct: null };
      };
      let bld = null;
      if (wantBld) {
        bld = placeBuildings(M, osmData.elements || [], { minSize: num('bldMin') || 1.2, minHeight: num('bldMinH') || 1.2, exag: num('exag') || 1, max: 20000 });
        if (bld.items.length) {
          M.symbols.buildings = bld.items;
          M.symPalette.push(symEntry('buildings', bld.items.length));
        }
      }
      if (wantTrees) {
        const mask = rasterizeOsm(osmData, lay, [forestCls], nx, ny);
        const r = (num('treeDiam') || 1.2) / 2;
        const trees = placeTrees(M, mask, { spacing: Math.max(2 * r, num('treeSpacing') || 1), fill: num('treeFill') || 0.25, radius: r, height: num('treeHeight') || 4, max: 40000 }, bld);
        if (trees.length) {
          M.symbols.trees = trees;
          M.symPalette.push(symEntry('trees', trees.length));
        }
      }
    }

    state.model = M;
    await autoLabel(M);
    updateCredits(used);
    computeHeights(M);
    $('staleNote').hidden = true;
    $('resultSec').hidden = false;
    $('tab3d').disabled = false;
    renderPalette();
    renderExports();
    $('symToggles').hidden = !M.symPalette.length;
    $('showTreesLbl').hidden = !M.symbols.trees;
    $('showBldLbl').hidden = !M.symbols.buildings;
    showTab('3d');
    syncLabelEntry();
    await updateEngraves();
    renderPreview(true);
  } catch (err) {
    console.error(err);
    setStatus('Feil: ' + err.message, true);
  } finally {
    setBusy(false);
  }
}
$('genBtn').onclick = generate;

function computeHeights(M) {
  const flat = $('flatSea').checked;
  const exag = num('exag') || 1;
  const base = Math.max(0.2, num('base') || 3);
  const step = Math.max(0, num('seaStep') || 0);
  const e = M.elevM;
  if (!M.inMask) {
    const edges = polyEdges(M.poly), margin = -1.5 * Math.max(M.dx, M.dy);
    M.inMask = new Uint8Array(e.length);
    for (let j = 0; j < M.NY; j++)
      for (let i = 0; i < M.NX; i++) M.inMask[j * M.NX + i] = insideDist(edges, i * M.dx, M.H - j * M.dy) >= margin ? 1 : 0;
  }
  let minE = Infinity, maxE = -Infinity, hasSea = false;
  for (let i = 0; i < e.length; i++) {
    if (!M.inMask[i]) continue;
    const v = flat ? Math.max(0, e[i]) : e[i];
    if (flat && e[i] <= 0) hasSea = true;
    if (v < minE) minE = v;
    if (v > maxE) maxE = v;
  }
  const k = M.scaleMmPerM * exag;
  const lift = flat && hasSea ? step : 0;
  const z = M.z && M.z.length === e.length ? M.z : new Float32Array(e.length);
  let maxZ = 0;
  for (let i = 0; i < e.length; i++) {
    const v = flat ? Math.max(0, e[i]) : e[i];
    z[i] = base + (v - minE) * k + (v > 0 ? lift : 0);
    if (z[i] > maxZ) maxZ = z[i];
  }
  M.z = z;
  const warn = maxZ > 320 ? ' – høyere enn H2D sitt byggevolum!' : '';
  setStatus(`Ferdig. Terreng ${Math.round(minE)}–${Math.round(maxE)} moh. · modellhøyde ${maxZ.toFixed(1)} mm${warn}`, !!warn);
}

function tileOffset(M, t, gap) {
  return [t.rect.x0 + t.c * gap, t.rect.y0 + (M.rows - 1 - t.r) * gap];
}

function tileMesh(M, t, step, engrave) {
  return buildTileMesh(
    M,
    indexRange(M.colBreaks[t.c], M.colBreaks[t.c + 1], step),
    indexRange(M.rowBreaks[t.r], M.rowBreaks[t.r + 1], step),
    t.poly,
    engrave,
  );
}

const symVisible = (key) => (key === 'trees' ? $('showTrees') : $('showBld')).checked;
for (const id of ['showTrees', 'showBld']) $(id).addEventListener('change', () => { if (state.model) { renderPreview(false); renderExports(); } });

// Symboldeler (trær/bygninger) for én flis, i flisens lokale koordinater.
function symbolParts(M, t) {
  const parts = [];
  for (const sp of M.symPalette) {
    if (sp.key === 'label') {
      const e = labelInlay() && state.engraves?.get(t.name);
      if (e) parts.push({ name: 'Tekst', key: 'label', mesh: textPrism(e), slot: sp.slot });
      continue;
    }
    if (!symVisible(sp.key)) continue;
    const mesh = buildSymbolMesh(M, M.symbols[sp.key], sp.key, t.rect, t.gpoly);
    if (mesh) parts.push({ name: sp.key === 'trees' ? 'Trær' : 'Bygninger', key: sp.key, mesh, slot: sp.slot });
  }
  return parts;
}

// ---------------- 3D-forhåndsvisning ----------------
function wallColor(M) {
  return (M.palette.find((p) => p.slot === 1) || M.palette[0]).color;
}

const symColors = (M) => Object.fromEntries(M.symPalette.map((s) => [s.key, s.color]));

function renderPreview(refit) {
  const M = state.model;
  if (!M) return;
  if (!state.preview) state.preview = new Preview($('preview'));
  const step = Math.max(1, Math.ceil(Math.max(M.NX, M.NY) / 450));
  const gap = M.tiles.length > 1 ? Math.max(2, M.W * 0.01) : 0;
  const tiles = [];
  for (const t of M.tiles) {
    const offset = tileOffset(M, t, gap);
    tiles.push({ ...tileMesh(M, t, step, state.engraves?.get(t.name)), offset });
    for (const p of symbolParts(M, t)) tiles.push({ ...p.mesh, offset, symKey: p.key });
  }
  state.preview.setTiles(tiles, M.palette.map((p) => p.color), wallColor(M), refit, symColors(M));
}

function refreshColors() {
  const M = state.model;
  state.preview?.setColors(M.palette.map((q) => q.color), wallColor(M), symColors(M));
}

function showTab(which) {
  const is3d = which === '3d';
  $('map').hidden = is3d;
  $('preview').hidden = !is3d;
  $('tabMap').classList.toggle('active', !is3d);
  $('tab3d').classList.toggle('active', is3d);
  if (!is3d) map.invalidateSize();
  else state.preview?.resize();
}
$('tabMap').onclick = () => showTab('map');
$('tab3d').onclick = () => showTab('3d');

// ---------------- Palett ----------------
function renderPalette() {
  const M = state.model;
  const el = $('palette');
  el.innerHTML = '';
  const all = [...M.palette, ...M.symPalette];
  const nSlots = Math.max(8, all.length);
  all.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'pal-row';
    const color = Object.assign(document.createElement('input'), { type: 'color', value: p.color, title: 'Farge i forhåndsvisningen' });
    const name = Object.assign(document.createElement('span'), { textContent: p.name });
    const pctText = p.pct == null ? 'symbol' : p.pct < 0.1 ? '<0,1 %' : `${p.pct.toFixed(1)} %`;
    const pct = Object.assign(document.createElement('span'), { className: 'pct', textContent: pctText });
    const sel = document.createElement('select');
    sel.title = 'Filamentplass';
    for (let s = 1; s <= Math.min(16, nSlots); s++) sel.add(new Option(`F${s}`, s));
    sel.value = p.slot;
    color.oninput = () => { p.color = color.value; refreshColors(); };
    sel.onchange = () => {
      p.slot = +sel.value;
      if (p.key === 'label') M.labelSlot = p.slot;
      if (p.pct == null) {
        const owner = M.palette.find((q) => q.slot === p.slot);
        if (owner) color.value = p.color = owner.color;
      }
      refreshColors();
    };
    row.append(color, name, pct, sel);
    el.append(row);
  });
}

// ---------------- Eksport ----------------
function filePrefix(M) {
  const { lat, lon } = M.center;
  const shape = M.shape === 'rect' ? '' : '_' + M.shape;
  return `terreng_${lat.toFixed(3)}_${lon.toFixed(3)}${shape}`;
}

function renderExports() {
  const M = state.model;
  const el = $('exports');
  el.innerHTML = '';
  const many = M.tiles.length > 1;
  for (const t of M.tiles) {
    const btn = document.createElement('button');
    btn.textContent = `⬇ ${many ? 'Flis ' + t.name : 'Last ned 3MF'} · ${t.w.toFixed(0)} × ${t.h.toFixed(0)} mm`;
    btn.onclick = () => exportTiles([t], `${filePrefix(M)}${many ? '_' + t.name : ''}.3mf`);
    el.append(btn);
  }
  if (many) {
    const all = document.createElement('button');
    all.textContent = '⬇ Alle fliser i én 3MF (én byggeplate per flis)';
    all.onclick = () => exportTiles(M.tiles, `${filePrefix(M)}_alle.3mf`);
    el.append(all);
  }
}

async function exportTiles(list, filename) {
  const M = state.model;
  setBusy(true);
  try {
    setStatus('Bygger mesh …', false, 0);
    await tick();
    await updateEngraves();
    const engraves = list.map((t) => state.engraves.get(t.name) || null);
    const nText = engraves.filter(Boolean).length;
    const objects = list.map((t, k) => ({
      name: t.name,
      mesh: tileMesh(M, t, 1, engraves[k]),
      offset: list.length > 1 ? tileOffset(M, t, 10) : [0, 0],
      parts: symbolParts(M, t),
    }));
    const tris = objects.reduce((s, o) => s + o.mesh.triCls.length + o.parts.reduce((a, p) => a + p.mesh.triCls.length, 0), 0);
    const slotOf = M.palette.map((p) => p.slot);
    const all = [...M.palette, ...M.symPalette];
    const slotColors = Array.from({ length: Math.max(...all.map((p) => p.slot)) }, (_, i) => all.find((p) => p.slot === i + 1)?.color);
    const blob = await build3mf(objects, {
      format: $('format').value,
      slotOf,
      slotColors,
      title: filename.replace('.3mf', ''),
      onProgress: (p) => setStatus(`Skriver 3MF (${(tris / 1e6).toFixed(2)} mill. trekanter) …`, false, p),
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    const txt = labelOn() ? (nText ? ` Tekst «${$("labelName").value.trim()}» ${labelInlay() ? 'lagt inn' : 'gravert'} i undersiden av ${nText} av ${list.length} fliser.` : " Teksten fikk ikke plass i undersiden.") : "";
    setStatus(`Lagret ${filename} (${(blob.size / 1e6).toFixed(1)} MB, ${(tris / 1e6).toFixed(2)} mill. trekanter).${txt}`);
  } catch (err) {
    console.error(err);
    setStatus('Eksport feilet: ' + err.message, true);
  } finally {
    setBusy(false);
  }
}

// ---------------- Start ----------------
$('colorSrc').value = 'kv_clean';
onSourceChange();
{
  const sel = selFromHash() || selFromBounds(L.latLngBounds([62.44, 7.60], [62.55, 7.85]));
  setSel(sel);
  map.fitBounds(state.outline.getBounds().pad(0.15));
}
window.terreng = state; // for feilsøking
window.terrengMap = map;
