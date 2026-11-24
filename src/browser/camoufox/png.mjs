// Minimal zero-dependency 8-bit RGB/RGBA non-interlaced PNG decoder and tile
// comparator used by Camoufox screenshot coordinate grounding (D18 parity).
import { inflateSync } from 'node:zlib';
import { TILE } from '../host-common.mjs';

export function decodePngPixels(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) break;
    if (type === 'IHDR' && len >= 13) {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      if (buf[dataStart + 12] !== 0) return null; // interlaced unsupported
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataEnd + 4;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!width || !height || bitDepth !== 8 || !bpp || !idat.length) return null;
  let raw;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return null;
  const pixels = Buffer.allocUnsafe(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? pixels[dst + x - bpp] : 0;
      const b = y > 0 ? pixels[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[dst - stride + x - bpp] : 0;
      const v = raw[src + x];
      pixels[dst + x] = filter === 0 ? v : filter === 1 ? (v + a) & 0xff
        : filter === 2 ? (v + b) & 0xff : filter === 3 ? (v + ((a + b) >> 1)) & 0xff
          : (v + paeth(a, b, c)) & 0xff;
    }
  }
  return { width, height, bpp, pixels };
}

export function pngClipMatchesTile(baseBuf, clipBuf, baseW, baseH, left, top, tileW, tileH, baseDecoded = null) {
  const a = baseDecoded ?? decodePngPixels(baseBuf);
  const b = decodePngPixels(clipBuf);
  if (!a || !b) return baseBuf.equals(clipBuf);
  if (a.bpp !== b.bpp) return false;
  const sx = a.width / baseW, sy = a.height / baseH;
  const fullFrame = b.width === a.width && b.height === a.height;
  let x0, y0, cmpW, cmpH, bx0, by0;
  if (fullFrame) {
    // Fallback when a full-viewport screenshot was returned instead of a clipped tile.
    const cx = left + tileW / 2, cy = top + tileH / 2;
    const fl = Math.max(0, Math.min(baseW - TILE, cx - TILE / 2));
    const ft = Math.max(0, Math.min(baseH - TILE, cy - TILE / 2));
    x0 = Math.max(0, Math.floor(fl * sx));
    y0 = Math.max(0, Math.floor(ft * sy));
    cmpW = Math.min(a.width - x0, Math.ceil(TILE * sx));
    cmpH = Math.min(a.height - y0, Math.ceil(TILE * sy));
    bx0 = x0;
    by0 = y0;
  } else {
    x0 = Math.max(0, Math.round(left * sx));
    y0 = Math.max(0, Math.round(top * sy));
    cmpW = Math.min(b.width, a.width - x0);
    cmpH = Math.min(b.height, a.height - y0);
    bx0 = 0;
    by0 = 0;
  }
  if (cmpW <= 0 || cmpH <= 0) return false;
  const aStride = a.width * a.bpp;
  const bStride = b.width * b.bpp;
  const rowBytes = cmpW * a.bpp;
  for (let row = 0; row < cmpH; row++) {
    const aStart = (y0 + row) * aStride + x0 * a.bpp;
    const bStart = (by0 + row) * bStride + bx0 * a.bpp;
    if (!a.pixels.subarray(aStart, aStart + rowBytes).equals(b.pixels.subarray(bStart, bStart + rowBytes))) {
      return false;
    }
  }
  return true;
}
