// Web Mercator-hjelpere. x og y er normaliserte (0..1) over hele verden, y=0 i nord.
export const EARTH_R = 6378137;

export const lonToX = (lon) => (lon + 180) / 360;
export const xToLon = (x) => x * 360 - 180;

export function latToY(lat) {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

export function yToLat(y) {
  const n = Math.PI * (1 - 2 * y);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

// Meter på bakken per normalisert enhet ved en gitt breddegrad.
export const metersPerUnit = (lat) => 2 * Math.PI * EARTH_R * Math.cos((lat * Math.PI) / 180);
