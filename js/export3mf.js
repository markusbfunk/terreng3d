// 3MF-eksport med fargemaling per trekant.
//
// Fargekoding (TriangleSelector-serialisering, hex), lik i Bambu Studio, OrcaSlicer og PrusaSlicer:
// filament 1 = "4", 2 = "8", 3 = "0C", 4 = "1C", …
//
// To formater:
//  - 'bambu':   Bambu Studio-prosjekt (H2D) med filamentoppsett. Bambu Studio leser bare malingen
//               når filen er et Bambu-prosjekt med nok filamenter.
//  - 'generic': Én enkel 3MF med paint_color / slic3rpe:mmu_segmentation (PrusaSlicer m.fl.).
import { Zip, ZipDeflate } from 'fflate';
import { WALL } from './mesh.js';

export function paintCode(slot) {
  if (slot <= 1) return null; // umalt = objektets standardfilament (plass 1)
  if (slot === 2) return '8';
  return (slot - 3).toString(16).toUpperCase() + 'C';
}

const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PROD_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const BBS_NS = 'http://schemas.bambulab.com/package/2021';
const BBS_VERSION = '02.08.02.61';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
const fmt = (v) => String(Math.round(v * 1000) / 1000);
const tick = () => new Promise((r) => setTimeout(r, 0));
const uuid = () =>
  crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (Math.random() * 16) >> (c / 4)).toString(16));

let templatePromise = null;
function loadTemplate() {
  templatePromise ??= fetch(new URL('./bambu_h2d_settings.json', import.meta.url)).then((r) => {
    if (!r.ok) throw new Error('Fant ikke Bambu-malen (bambu_h2d_settings.json)');
    return r.json();
  });
  return templatePromise;
}

function meshBounds(p) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  return { min, max, center: min.map((v, k) => (v + max[k]) / 2) };
}

// Skriver <mesh>…</mesh> strømmet. shift trekkes fra alle hjørner.
async function writeMesh(mesh, codes, shift, out, progress, attrs) {
  const p = mesh.positions, ix = mesh.indices, tc = mesh.triCls;
  out.write('<mesh>\n<vertices>\n');
  const nv = p.length / 3;
  for (let i = 0; i < nv; i++) {
    out.write(`<vertex x="${fmt(p[i * 3] - shift[0])}" y="${fmt(p[i * 3 + 1] - shift[1])}" z="${fmt(p[i * 3 + 2] - shift[2])}"/>\n`);
  }
  out.write('</vertices>\n<triangles>\n');
  const nt = tc.length;
  for (let t = 0; t < nt; t++) {
    const code = tc[t] === WALL ? null : codes[tc[t]];
    out.write(
      code
        ? `<triangle v1="${ix[t * 3]}" v2="${ix[t * 3 + 1]}" v3="${ix[t * 3 + 2]}" ${attrs(code)}/>\n`
        : `<triangle v1="${ix[t * 3]}" v2="${ix[t * 3 + 1]}" v3="${ix[t * 3 + 2]}"/>\n`,
    );
    if (out.pending() > 4e6) {
      out.flush();
      progress(t);
      await tick();
    }
  }
  out.write('</triangles>\n</mesh>\n');
}

// Lager en zip-strøm og gir tilbake hjelpere for å legge til filer.
function zipWriter() {
  const enc = new TextEncoder();
  const chunks = [];
  let resolve, reject;
  const done = new Promise((res, rej) => { resolve = res; reject = rej; });
  const zip = new Zip((err, data, final) => {
    if (err) return reject(err);
    chunks.push(data);
    if (final) resolve(new Blob(chunks, { type: 'model/3mf' }));
  });
  return {
    small(name, text) {
      const f = new ZipDeflate(name, { level: 6 });
      zip.add(f);
      f.push(enc.encode(text), true);
    },
    stream(name) {
      const f = new ZipDeflate(name, { level: 6 });
      zip.add(f);
      let buf = '';
      return {
        write: (s) => { buf += s; },
        pending: () => buf.length,
        flush: () => { f.push(enc.encode(buf), false); buf = ''; },
        end: () => { f.push(enc.encode(buf), true); buf = ''; },
      };
    },
    end() { zip.end(); return done; },
    fail: (e) => reject(e),
    done,
  };
}

// objects: [{ name, mesh, offset: [x, y], parts?: [{ name, mesh, slot }] }]
// opts: { format: 'bambu' | 'generic', slotOf: [...], slotColors: ['#rrggbb', …] (indeks 0 = F1), title, onProgress, platePerObject }
export async function build3mf(objects, opts) {
  const { format = 'bambu', slotOf, slotColors, title = 'Terreng', onProgress } = opts;
  // Hvert objekt (flis) = terreng (malt) + valgfrie deler (trær, bygninger) med eget filament.
  const meshesOf = (o) => [{ name: o.name, mesh: o.mesh, slot: 1, paint: true }, ...(o.parts || []).map((p) => ({ ...p, paint: false }))];
  const codes = slotOf.map(paintCode);
  const noCodes = [];
  const totalTri = objects.reduce((s, o) => s + meshesOf(o).reduce((a, m) => a + m.mesh.triCls.length, 0), 0);
  let doneTri = 0;
  const progressFor = () => (t) => onProgress?.((doneTri + t) / totalTri);
  const z = zipWriter();

  z.small('[Content_Types].xml', CONTENT_TYPES);
  z.small('_rels/.rels', RELS);

  // Fortløpende id-er: delene først, så omsluttende objekt.
  let nextId = 1;
  const ids = objects.map((o) => {
    const parts = meshesOf(o).map((m) => ({ ...m, id: nextId++ }));
    return { parts, wrap: nextId++ };
  });

  if (format === 'generic') {
    const out = z.stream('3D/3dmodel.model');
    out.write(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
<metadata name="Application">Terreng3D</metadata>
<metadata name="Title">${esc(title)}</metadata>
<metadata name="slic3rpe:MmPaintingVersion">1</metadata>
<resources>
`);
    for (let oi = 0; oi < objects.length; oi++) {
      for (const p of ids[oi].parts) {
        out.write(`<object id="${p.id}" name="${esc(p.name)}" type="model">`);
        await writeMesh(p.mesh, p.paint ? codes : noCodes, [0, 0, 0], out, progressFor(),
          (c) => `paint_color="${c}" slic3rpe:mmu_segmentation="${c}"`);
        out.write('</object>\n');
        doneTri += p.mesh.triCls.length;
      }
      out.write(`<object id="${ids[oi].wrap}" name="${esc(objects[oi].name)}" type="model"><components>\n`);
      for (const p of ids[oi].parts) out.write(`<component objectid="${p.id}"/>\n`);
      out.write('</components></object>\n');
    }
    out.write('</resources>\n<build>\n');
    objects.forEach((o, oi) => {
      out.write(`<item objectid="${ids[oi].wrap}" transform="1 0 0 0 1 0 0 0 1 ${fmt(o.offset[0])} ${fmt(o.offset[1])} 0" printable="1"/>\n`);
    });
    out.write('</build>\n</model>\n');
    out.end();
    onProgress?.(1);
    return z.end();
  }

  // ---- Bambu Studio-prosjekt ----
  const tpl = await loadTemplate();
  const nSlots = Math.max(1, ...slotOf, ...objects.flatMap((o) => (o.parts || []).map((p) => p.slot)));
  const settings = structuredClone(tpl.settings);
  for (const k of tpl.perFilament) settings[k] = Array(nSlots).fill(tpl.settings[k][0]);
  settings.filament_colour = Array.from({ length: nSlots }, (_, i) => (slotColors[i] || '#C8C8C8').toUpperCase());
  settings.different_settings_to_system = Array(nSlots + 2).fill('');
  settings.inherits_group = Array(nSlots + 2).fill('');
  // Filament → dyse-kart (auto) og spylevolum: én verdi per filament, matrise N×N per dyse (H2D har 2).
  for (const k of ['filament_map', 'filament_map_2', 'filament_nozzle_map', 'filament_volume_map']) {
    if (Array.isArray(tpl.settings[k])) settings[k] = Array(nSlots).fill(tpl.settings[k][0]);
  }
  const nExt = (tpl.settings.nozzle_diameter || [0]).length;
  settings.flush_volumes_matrix = [];
  for (let e = 0; e < nExt; e++)
    for (let i = 0; i < nSlots; i++)
      for (let j = 0; j < nSlots; j++) settings.flush_volumes_matrix.push(i === j ? '0' : '280');
  settings.flush_volumes_vector = Array(nExt * nSlots).fill('140');

  // Plassering: én plate per objekt (Bambu legger platene i et rutenett med 20 % mellomrom),
  // ellers hele gruppen midt på plate 1. Terrengets senter brukes som objektets origo.
  const bounds = objects.map((o) => meshBounds(o.mesh.positions));
  const [bedW, bedD] = [tpl.bedCenter[0] * 2, tpl.bedCenter[1] * 2];
  const platePer = objects.length > 1 && opts.platePerObject !== false;
  const plateCols = Math.ceil(Math.sqrt(objects.length) - 1e-9);
  const plateOf = (i) => (platePer ? i : 0);
  const placeXY = [];
  if (platePer) {
    objects.forEach((o, i) => {
      const col = i % plateCols, row = Math.floor(i / plateCols);
      placeXY.push([col * bedW * 1.2 + bedW / 2, -row * bedD * 1.2 + bedD / 2]);
    });
  } else {
    let gMax = [0, 0];
    objects.forEach((o, i) => {
      gMax = [Math.max(gMax[0], o.offset[0] + bounds[i].max[0]), Math.max(gMax[1], o.offset[1] + bounds[i].max[1])];
    });
    const shiftX = bedW / 2 - gMax[0] / 2, shiftY = bedD / 2 - gMax[1] / 2;
    objects.forEach((o, i) => placeXY.push([shiftX + o.offset[0] + bounds[i].center[0], shiftY + o.offset[1] + bounds[i].center[1]]));
  }

  const fileOf = (i) => `3D/Objects/object_${ids[i].parts[0].id}.model`;
  let main = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:BambuStudio="${BBS_NS}" xmlns:p="${PROD_NS}" requiredextensions="p">
 <metadata name="Application">BambuStudio-${BBS_VERSION}</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="Title">${esc(title)}</metadata>
 <metadata name="Designer">Terreng3D</metadata>
 <resources>
`;
  ids.forEach((id, i) => {
    main += `  <object id="${id.wrap}" p:UUID="${uuid()}" type="model">\n   <components>\n`;
    for (const p of id.parts) {
      main += `    <component p:path="/${fileOf(i)}" objectid="${p.id}" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n`;
    }
    main += '   </components>\n  </object>\n';
  });
  main += ' </resources>\n <build p:UUID="' + uuid() + '">\n';
  objects.forEach((o, i) => {
    const c = bounds[i].center;
    main += `  <item objectid="${ids[i].wrap}" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 ${fmt(placeXY[i][0])} ${fmt(placeXY[i][1])} ${fmt(c[2])}" printable="1"/>\n`;
  });
  main += ' </build>\n</model>\n';
  z.small('3D/3dmodel.model', main);
  z.small('3D/_rels/3dmodel.model.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${ids.map((id, i) => ` <Relationship Target="/${fileOf(i)}" Id="rel-${i + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`).join('\n')}
</Relationships>`);

  for (let i = 0; i < objects.length; i++) {
    const out = z.stream(fileOf(i));
    out.write(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:BambuStudio="${BBS_NS}" xmlns:p="${PROD_NS}" requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
`);
    for (const p of ids[i].parts) {
      out.write(`  <object id="${p.id}" p:UUID="${uuid()}" type="model">\n`);
      await writeMesh(p.mesh, p.paint ? codes : noCodes, bounds[i].center, out, progressFor(), (c) => `paint_color="${c}"`);
      out.write('  </object>\n');
      doneTri += p.mesh.triCls.length;
    }
    out.write(' </resources>\n <build/>\n</model>\n');
    out.end();
  }

  let ms = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n';
  objects.forEach((o, i) => {
    const faces = ids[i].parts.reduce((a, p) => a + p.mesh.triCls.length, 0);
    ms += `  <object id="${ids[i].wrap}">
    <metadata key="name" value="${esc(o.name)}"/>
    <metadata key="extruder" value="1"/>
    <metadata face_count="${faces}"/>
`;
    for (const p of ids[i].parts) {
      const ext = p.paint ? '' : `      <metadata key="extruder" value="${p.slot}"/>\n`;
      ms += `    <part id="${p.id}" subtype="normal_part">
      <metadata key="name" value="${esc(p.name)}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
${ext}      <mesh_stat face_count="${p.mesh.triCls.length}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
`;
    }
    ms += '  </object>\n';
  });
  const nPlates = platePer ? objects.length : 1;
  for (let p = 0; p < nPlates; p++) {
    ms += `  <plate>
    <metadata key="plater_id" value="${p + 1}"/>
    <metadata key="plater_name" value="${platePer ? esc(objects[p].name) : ''}"/>
    <metadata key="locked" value="false"/>
    <metadata key="filament_map_mode" value="Auto For Flush"/>
    <metadata key="filament_maps" value="${Array(nSlots).fill(1).join(' ')}"/>
    <metadata key="filament_volume_maps" value="${Array(nSlots).fill(0).join(' ')}"/>
`;
    ids.forEach((id, i) => {
      if (plateOf(i) !== p) return;
      ms += `    <model_instance>
      <metadata key="object_id" value="${id.wrap}"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="${100 + i}"/>
    </model_instance>
`;
    });
    ms += '  </plate>\n';
  }
  ms += '  <assemble>\n  </assemble>\n</config>\n';
  z.small('Metadata/model_settings.config', ms);
  z.small('Metadata/project_settings.config', JSON.stringify(settings, null, 4));
  z.small('Metadata/slice_info.config', `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="${BBS_VERSION}"/>
  </header>
</config>
`);
  onProgress?.(1);
  return z.end();
}
