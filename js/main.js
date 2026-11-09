import { lonToX, latToY, xToLon, yToLat, metersPerUnit } from './geo.js';
import { ELEVATION, COLOR_SOURCES, BASEMAPS } from './sources.js';
import { chooseZoom, fetchMosaic } from './tiles.js';
import { quantizeColors, majorityFilter, compactPalette } from './colors.js';
import { BASE_CLASS, OSM_CLASSES, fetchOsm, rasterizeOsm } from './osm.js';
import { buildTileMesh, indexRange } from './mesh.js';
import { ELEV_SOURCES, KARTVERKET, sampleElevation } from './elevation.js';
import { placeTrees, placeBuildings, buildSymbolMesh } from './symbols.js';
import { build3mf } from './export3mf.js';
import { Preview } from './preview.js';

const $ = (id) => document.getElementById(id);
const num = (id) => parseFloat($(id).value);
const MAX_POINTS = 8e6;

const state = { bounds: null, rect: null, handles: [], model: null, drawing: false, drawStart: null, preview: null, busy: false };

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

function setBounds(b) {
  state.bounds = b;
  if (!state.rect) {
    state.rect = L.rectangle(b, { color: '#e4572e', weight: 2, fillOpacity: 0.06, interactive: false }).addTo(map);
    const icon = L.divIcon({ className: 'handle', iconSize: [14, 14] });
    state.handles = [0, 1].map(() => L.marker(b.getCenter(), { draggable: true, icon, zIndexOffset: 1000 }).addTo(map));
    state.handles.forEach((h) => {
      h.on('drag', () => {
        const bb = L.latLngBounds(state.handles[0].getLatLng(), state.handles[1].getLatLng());
        state.rect.setBounds(bb);
        state.bounds = bb;
        updateOverlay();
      });
      h.on('dragend', () => setBounds(state.bounds));
    });
  }
  state.rect.setBounds(b);
  state.handles[0].setLatLng(b.getNorthWest());
  state.handles[1].setLatLng(b.getSouthEast());
  updateOverlay();
  markStale();
  // Del området via lenke: #bbox=sør,vest,nord,øst
  const h = '#bbox=' + [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => v.toFixed(5)).join(',');
  history.replaceState(null, '', h);
}

function boundsFromHash() {
  const m = location.hash.match(/bbox=([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)/);
  if (!m) return null;
  const [s, w, n, e] = m.slice(1).map(Number);
  return s < n && w < e ? L.latLngBounds([s, w], [n, e]) : null;
}
window.addEventListener('hashchange', () => {
  const b = boundsFromHash();
  if (b) { setBounds(b); map.fitBounds(b.pad(0.15)); }
});

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
  const b = L.latLngBounds(state.drawStart, e.latlng);
  if (!state.rect) setBounds(b);
  state.rect.setBounds(b);
});
map.on('mouseup', (e) => {
  if (!state.drawing || !state.drawStart) return;
  const b = L.latLngBounds(state.drawStart, e.latlng);
  stopDrawing();
  const p1 = map.latLngToContainerPoint(b.getNorthWest()), p2 = map.latLngToContainerPoint(b.getSouthEast());
  if (Math.abs(p1.x - p2.x) < 8 || Math.abs(p1.y - p2.y) < 8) {
    if (state.bounds) state.rect.setBounds(state.bounds);
    return;
  }
  setBounds(b);
});
$('viewBtn').onclick = () => setBounds(map.getBounds().pad(-0.12));

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
function layout() {
  const b = state.bounds;
  if (!b) return null;
  const x1 = lonToX(b.getWest()), x2 = lonToX(b.getEast());
  const y1 = latToY(b.getNorth()), y2 = latToY(b.getSouth());
  const latc = (b.getNorth() + b.getSouth()) / 2;
  const mpu = metersPerUnit(latc);
  const widthM = (x2 - x1) * mpu, heightM = (y2 - y1) * mpu;
  const W = Math.max(10, num('widthMm') || 200);
  const H = (W * heightM) / widthM;
  const maxTile = Math.max(20, num('maxTile') || 300);
  const res = Math.max(0.1, num('res') || 0.4);
  const cols = Math.max(1, Math.ceil(W / maxTile - 1e-9));
  const rows = Math.max(1, Math.ceil(H / maxTile - 1e-9));
  const NX = Math.max(cols + 1, Math.round(W / res) + 1);
  const NY = Math.max(rows + 1, Math.round(H / res) + 1);
  const colBreaks = Array.from({ length: cols + 1 }, (_, k) => Math.round((k * (NX - 1)) / cols));
  const rowBreaks = Array.from({ length: rows + 1 }, (_, k) => Math.round((k * (NY - 1)) / rows));
  const scaleMmPerM = W / widthM;
  return {
    x1, x2, y1, y2, latc, mpu, widthM, heightM, W, H, cols, rows, NX, NY,
    dx: W / (NX - 1), dy: H / (NY - 1), colBreaks, rowBreaks, scaleMmPerM,
    bbox: { s: b.getSouth(), n: b.getNorth(), w: b.getWest(), e: b.getEast() },
  };
}

const tileName = (r, c) => `R${r + 1}K${c + 1}`;

function updateOverlay() {
  overlay.clearLayers();
  const lay = layout();
  if (!lay) return;
  const { n, s, w, e } = lay.bbox;
  const style = { color: '#e4572e', weight: 1.5, dashArray: '5 4', interactive: false };
  const lonAt = (k) => xToLon(lay.x1 + ((lay.x2 - lay.x1) * lay.colBreaks[k]) / (lay.NX - 1));
  const latAt = (k) => yToLat(lay.y1 + ((lay.y2 - lay.y1) * lay.rowBreaks[k]) / (lay.NY - 1));
  for (let k = 1; k < lay.cols; k++) L.polyline([[n, lonAt(k)], [s, lonAt(k)]], style).addTo(overlay);
  for (let k = 1; k < lay.rows; k++) L.polyline([[latAt(k), w], [latAt(k), e]], style).addTo(overlay);
  if (lay.cols * lay.rows > 1) {
    for (let r = 0; r < lay.rows; r++)
      for (let c = 0; c < lay.cols; c++) {
        const icon = L.divIcon({ className: 'tile-label', html: tileName(r, c), iconSize: [40, 16] });
        L.marker([(latAt(r) + latAt(r + 1)) / 2, (lonAt(c) + lonAt(c + 1)) / 2], { icon, interactive: false }).addTo(overlay);
      }
  }
  const km = (m) => (m >= 10000 ? (m / 1000).toFixed(0) : (m / 1000).toFixed(1));
  const pts = lay.NX * lay.NY;
  const tw = lay.W / lay.cols, th = lay.H / lay.rows;
  const lines = [
    `Område: ${km(lay.widthM)} × ${km(lay.heightM)} km`,
    `Modell: ${lay.W.toFixed(0)} × ${lay.H.toFixed(0)} mm · målestokk 1:${Math.round(1000 / lay.scaleMmPerM).toLocaleString('no')}`,
    `Fliser: ${lay.cols} × ${lay.rows} (ca. ${tw.toFixed(0)} × ${th.toFixed(0)} mm hver)`,
    `Rutenett: ${lay.NX} × ${lay.NY} punkter · 1 punkt = ${(lay.dx / lay.scaleMmPerM).toFixed(1)} m i terrenget`,
  ];
  let html = lines.map((l) => `<div>${l}</div>`).join('');
  if (pts > MAX_POINTS) html += `<div class="warn">For mange punkter (${(pts / 1e6).toFixed(1)} mill.). Øk mm/punkt eller minsk bredden.</div>`;
  else if (pts > 3e6) html += `<div class="warn">Stor modell – generering og eksport kan ta en stund.</div>`;
  $('layoutInfo').innerHTML = html;
}

for (const id of ['widthMm', 'maxTile', 'res']) $(id).addEventListener('input', () => { updateOverlay(); markStale(); });
for (const id of ['colorSrc', 'nColors', 'smooth', 'seaWater', 'elevSrc', 'symTrees', 'symBuildings', 'treeSpacing', 'treeHeight', 'treeDiam', 'treeFill', 'bldMin', 'bldMinH'])
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
  $('smooth').value = t === 'raster' ? 1 : 0;
  updateCredits();
}
$('colorSrc').addEventListener('change', onSourceChange);

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
    const srcKey = $('colorSrc').value;
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
    let cls, palette, keepFirst = false;
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
      setStatus('Reduserer farger …', false, 0.85);
      await tick();
      const rgb = new Uint8Array(nx * ny * 3);
      for (let j = 0; j < ny; j++) {
        const y = lay.y1 + ((lay.y2 - lay.y1) * (j + 0.5)) / ny;
        for (let i = 0; i < nx; i++) cm.rgb(lay.x1 + ((lay.x2 - lay.x1) * (i + 0.5)) / nx, y, rgb, (j * nx + i) * 3);
      }
      ({ cls, palette } = quantizeColors(rgb, nx * ny, Math.round(num('nColors')) || 6));
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
    palette = compactPalette(cls, palette, keepFirst);
    if (src.type === 'raster') palette.forEach((p, i) => (p.name = `Farge ${i + 1}`));

    const M = { ...lay, elevM, cls, palette, srcKey, z: null, used, symbols: {}, symPalette: [] };
    computeHeights(M);

    // 4) Symboler
    if (osmData && (wantTrees || wantBld)) {
      setStatus('Plasserer symboler …', false, 0.95);
      await tick();
      let nextSlot = Math.max(...palette.map((p) => p.slot)) + 1;
      let bld = null;
      if (wantBld) {
        bld = placeBuildings(M, osmData.elements || [], { minSize: num('bldMin') || 1.6, minHeight: num('bldMinH') || 1.2, exag: num('exag') || 1, max: 20000 });
        if (bld.items.length) {
          M.symbols.buildings = bld.items;
          M.symPalette.push({ key: 'buildings', name: `Bygninger (${bld.items.length})`, color: '#b5523e', slot: Math.min(16, nextSlot++), pct: null });
        }
      }
      if (wantTrees) {
        const mask = rasterizeOsm(osmData, lay, [forestCls], nx, ny);
        const r = (num('treeDiam') || 1.8) / 2;
        const trees = placeTrees(M, mask, { spacing: Math.max(2 * r, num('treeSpacing') || 3), fill: num('treeFill') || 0.6, radius: r, height: num('treeHeight') || 3, max: 40000 }, bld);
        if (trees.length) {
          M.symbols.trees = trees;
          M.symPalette.push({ key: 'trees', name: `Trær (${trees.length})`, color: '#1f4d22', slot: Math.min(16, nextSlot++), pct: null });
        }
      }
    }

    state.model = M;
    updateCredits(used);
    computeHeights(M);
    $('staleNote').hidden = true;
    $('resultSec').hidden = false;
    $('tab3d').disabled = false;
    renderPalette();
    renderExports();
    showTab('3d');
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
  let minE = Infinity, maxE = -Infinity, hasSea = false;
  for (let i = 0; i < e.length; i++) {
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

function tileOffset(M, r, c, gap) {
  return [
    M.colBreaks[c] * M.dx + c * gap,
    (M.NY - 1 - M.rowBreaks[r + 1]) * M.dy + (M.rows - 1 - r) * gap,
  ];
}

function tileMesh(M, r, c, step) {
  return buildTileMesh(
    M,
    indexRange(M.colBreaks[c], M.colBreaks[c + 1], step),
    indexRange(M.rowBreaks[r], M.rowBreaks[r + 1], step),
  );
}

// Symboldeler (trær/bygninger) for én flis, i flisens lokale koordinater.
function symbolParts(M, r, c) {
  const rect = {
    x0: M.colBreaks[c] * M.dx, x1: M.colBreaks[c + 1] * M.dx,
    y0: (M.NY - 1 - M.rowBreaks[r + 1]) * M.dy, y1: (M.NY - 1 - M.rowBreaks[r]) * M.dy,
  };
  const parts = [];
  for (const sp of M.symPalette) {
    const mesh = buildSymbolMesh(M, M.symbols[sp.key], sp.key, rect);
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
  const gap = M.cols * M.rows > 1 ? Math.max(2, M.W * 0.01) : 0;
  const tiles = [];
  for (let r = 0; r < M.rows; r++)
    for (let c = 0; c < M.cols; c++) {
      const offset = tileOffset(M, r, c, gap);
      tiles.push({ ...tileMesh(M, r, c, step), offset });
      for (const p of symbolParts(M, r, c)) tiles.push({ ...p.mesh, offset, symKey: p.key });
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
    sel.onchange = () => { p.slot = +sel.value; refreshColors(); };
    row.append(color, name, pct, sel);
    el.append(row);
  });
}

// ---------------- Eksport ----------------
function filePrefix(M) {
  const lat = (M.bbox.n + M.bbox.s) / 2, lon = (M.bbox.w + M.bbox.e) / 2;
  return `terreng_${lat.toFixed(3)}_${lon.toFixed(3)}`;
}

function renderExports() {
  const M = state.model;
  const el = $('exports');
  el.innerHTML = '';
  const many = M.cols * M.rows > 1;
  for (let r = 0; r < M.rows; r++)
    for (let c = 0; c < M.cols; c++) {
      const w = (M.colBreaks[c + 1] - M.colBreaks[c]) * M.dx, h = (M.rowBreaks[r + 1] - M.rowBreaks[r]) * M.dy;
      const btn = document.createElement('button');
      btn.textContent = `⬇ ${many ? 'Flis ' + tileName(r, c) : 'Last ned 3MF'} · ${w.toFixed(0)} × ${h.toFixed(0)} mm`;
      btn.onclick = () => exportTiles([[r, c]], `${filePrefix(M)}${many ? '_' + tileName(r, c) : ''}.3mf`);
      el.append(btn);
    }
  if (many) {
    const all = document.createElement('button');
    all.textContent = '⬇ Alle fliser i én 3MF (én byggeplate per flis)';
    const list = [];
    for (let r = 0; r < M.rows; r++) for (let c = 0; c < M.cols; c++) list.push([r, c]);
    all.onclick = () => exportTiles(list, `${filePrefix(M)}_alle.3mf`);
    el.append(all);
  }
}

async function exportTiles(list, filename) {
  const M = state.model;
  setBusy(true);
  try {
    setStatus('Bygger mesh …', false, 0);
    await tick();
    const objects = list.map(([r, c]) => ({
      name: tileName(r, c),
      mesh: tileMesh(M, r, c, 1),
      offset: list.length > 1 ? tileOffset(M, r, c, 10) : [0, 0],
      parts: symbolParts(M, r, c),
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
    setStatus(`Lagret ${filename} (${(blob.size / 1e6).toFixed(1)} MB, ${(tris / 1e6).toFixed(2)} mill. trekanter).`);
  } catch (err) {
    console.error(err);
    setStatus('Eksport feilet: ' + err.message, true);
  } finally {
    setBusy(false);
  }
}

// ---------------- Start ----------------
$('colorSrc').value = 'topo_no';
onSourceChange();
{
  const b = boundsFromHash() || L.latLngBounds([62.44, 7.60], [62.55, 7.85]);
  setBounds(b);
  map.fitBounds(b.pad(0.15));
}
window.terreng = state; // for feilsøking
