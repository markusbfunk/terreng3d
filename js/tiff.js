// Minimal GeoTIFF-leser for ukomprimerte enkeltbånd-rastere (som Kartverkets WCS leverer).
// Støtter striper og fliser, little/big endian, float32/float64/int16/int32/uint16.

export function readTiff(buffer) {
  const dv = new DataView(buffer);
  const le = dv.getUint16(0) === 0x4949;
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  if (u16(2) !== 42) throw new Error('Ikke en gyldig TIFF-fil (BigTIFF støttes ikke)');
  const ifd = u32(4);
  const n = u16(ifd);
  const tags = {};
  const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    const size = (typeSize[type] || 1) * count;
    const off = size <= 4 ? e + 8 : u32(e + 8);
    const vals = [];
    for (let k = 0; k < Math.min(count, 1 << 20); k++) {
      const o = off + k * (typeSize[type] || 1);
      if (type === 3) vals.push(u16(o));
      else if (type === 4 || type === 16) vals.push(u32(o));
      else if (type === 12) vals.push(dv.getFloat64(o, le));
      else if (type === 11) vals.push(dv.getFloat32(o, le));
      else if (type === 2) vals.push(dv.getUint8(o));
      else vals.push(dv.getUint8(o));
    }
    tags[tag] = type === 2 ? String.fromCharCode(...vals.filter(Boolean)) : vals;
  }
  const width = tags[256][0], height = tags[257][0];
  const bps = (tags[258] || [32])[0];
  const fmt = (tags[339] || [1])[0]; // 1 uint, 2 int, 3 float
  const comp = (tags[259] || [1])[0];
  if (comp !== 1) throw new Error(`Komprimert TIFF (type ${comp}) støttes ikke`);
  const bytes = bps / 8;
  const read = (o) => {
    if (fmt === 3) return bps === 64 ? dv.getFloat64(o, le) : dv.getFloat32(o, le);
    if (fmt === 2) return bps === 16 ? dv.getInt16(o, le) : dv.getInt32(o, le);
    return bps === 16 ? dv.getUint16(o, le) : dv.getUint32(o, le);
  };
  // Manglende (glisne) fliser/striper blir NaN = ingen data.
  const data = new Float32Array(width * height).fill(NaN);
  if (tags[324]) {
    // fliser
    const tw = tags[322][0], th = tags[323][0], offs = tags[324], counts = tags[325] || [];
    const across = Math.ceil(width / tw);
    offs.forEach((off, t) => {
      if (!off || counts[t] === 0 || off + tw * th * bytes > buffer.byteLength) return;
      const tx = (t % across) * tw, ty = Math.floor(t / across) * th;
      for (let y = 0; y < th && ty + y < height; y++)
        for (let x = 0; x < tw && tx + x < width; x++) data[(ty + y) * width + tx + x] = read(off + (y * tw + x) * bytes);
    });
  } else {
    const offs = tags[273], rps = (tags[278] || [height])[0], counts = tags[279] || [];
    offs.forEach((off, s) => {
      const y0 = s * rps;
      const rows = Math.min(rps, height - y0);
      if (!off || counts[s] === 0 || off + rows * width * bytes > buffer.byteLength) return;
      for (let i = 0; i < rows * width; i++) data[y0 * width + i] = read(off + i * bytes);
    });
  }
  const nodata = tags[42113] ? parseFloat(tags[42113]) : null;
  // ModelTiepoint (33922) + ModelPixelScale (33550) → georeferanse
  let geo = null;
  if (tags[33922] && tags[33550]) {
    const [, , , X, Y] = tags[33922];
    const [sx, sy] = tags[33550];
    geo = { x0: X, y0: Y, sx, sy };
  }
  return { width, height, data, nodata, geo };
}
