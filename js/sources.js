// Datakilder. Alle må tillate CORS slik at nettleseren kan lese pikslene.

export const ELEVATION = {
  name: 'AWS Terrain Tiles (global)',
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  maxZoom: 15,
  attribution:
    'Høydedata: AWS Terrain Tiles / Mapzen (SRTM, GMTED2010, ETOPO1, Kartverket, USGS 3DEP m.fl.)',
};

export const COLOR_SOURCES = {
  osm: {
    name: 'OpenStreetMap – arealtyper (rene farger, kan være treg)',
    type: 'osm',
    attribution: 'Arealtyper: © OpenStreetMap-bidragsytere (ODbL), via Overpass API',
  },
  kv_clean: {
    name: 'Kartverket arealdekke uten tekst (kun Norge)',
    type: 'raster',
    norwayOnly: true,
    url: 'https://wms.geonorge.no/skwms1/wms.topo?service=WMS&version=1.3.0&request=GetMap&styles=&crs=EPSG:3857&width=256&height=256&format=image/png&transparent=true&bbox={bbox3857}&layers=kd_arealdekkeflate,fkb_arealdekke,kd_vannflate,fkb_vann,kd_elver,kd_bygninger,fkb_bygning',
    // All bebyggelse (by, tettsted, industri/næring, rullebane) får samme farge før fargereduksjonen.
    merge: [{ to: '#fad9bc', from: ['#fad9bc', '#f7be8c', '#d7d7d7', '#dcdcdc'] }],
    // Veier hentes som eget gjennomsiktig lag og legges på som én mørkegrå farge.
    roads: 'https://wms.geonorge.no/skwms1/wms.topo?service=WMS&version=1.3.0&request=GetMap&styles=&crs=EPSG:3857&width=256&height=256&format=image/png&transparent=true&bbox={bbox3857}&layers=kd_veger,veg,veg_bru',
    maxZoom: 18,
    attribution: 'Kart: © Kartverket (CC BY 4.0)',
  },
  topo_no: {
    name: 'Kartverket topografisk kart, med tekst (kun Norge)',
    type: 'raster',
    norwayOnly: true,
    url: 'https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png',
    maxZoom: 18,
    attribution: 'Kart: © Kartverket (CC BY 4.0)',
  },
  opentopomap: {
    name: 'OpenTopoMap (global, med tekst)',
    type: 'raster',
    url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
    maxZoom: 17,
    attribution: 'Kart: © OpenTopoMap (CC BY-SA), © OpenStreetMap-bidragsytere',
  },
  s2: {
    name: 'Satellitt – Sentinel-2 skyfri (global, 10 m)',
    type: 'raster',
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg',
    maxZoom: 15,
    attribution:
      'Sentinel-2 cloudless – s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2020), CC BY-NC-SA 4.0',
  },
  none: { name: 'Ingen (én farge)', type: 'none', attribution: '' },
};

// Grov test: overlapper området Norge (fastland + kyst)? Kartverket-kartene er blanke utenfor.
const NORWAY = [
  { s: 57.8, n: 59.3, w: 4.4, e: 11.9 },
  { s: 59.3, n: 64.0, w: 4.4, e: 12.9 },
  { s: 64.0, n: 68.5, w: 9.5, e: 18.2 },
  { s: 68.5, n: 71.4, w: 14.5, e: 31.3 },
];
export const inNorway = (b) => NORWAY.some((c) => b.w < c.e && b.e > c.w && b.s < c.n && b.n > c.s);

export const BASEMAPS = [
  {
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
  { name: 'Kartverket topo', url: COLOR_SOURCES.topo_no.url, maxZoom: 18, attribution: '© Kartverket' },
  { name: 'OpenTopoMap', url: COLOR_SOURCES.opentopomap.url, maxZoom: 17, attribution: '© OpenTopoMap, © OpenStreetMap' },
  { name: 'Satellitt (Sentinel-2)', url: COLOR_SOURCES.s2.url, maxZoom: 15, attribution: 'Sentinel-2 cloudless by EOX' },
];
