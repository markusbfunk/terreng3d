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
  topo_no: {
    name: 'Kartverket topografisk kart (kun Norge)',
    type: 'raster',
    url: 'https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png',
    maxZoom: 18,
    attribution: 'Kart: © Kartverket (CC BY 4.0)',
  },
  opentopomap: {
    name: 'OpenTopoMap (global)',
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
