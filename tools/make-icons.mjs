// Generates the app icons from the game's own tilesheet: `node tools/make-icons.mjs`
//
// Written by hand rather than pulled from a library because the project has no
// dependencies and no build step, and Node ships everything needed — zlib for
// the PNG streams, and a few lines of CRC. Re-run it if the barn art changes.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

const TILE = 16;
const SHEET = 'assets/tilemap_packed.png';

// --- PNG decode (enough for the Kenney sheets: 8-bit palette or RGB/RGBA) ---

function readChunks(buf) {
  const chunks = [];
  let p = 8;                                  // skip the signature
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    chunks.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;                            // len + type + data + crc
  }
  return chunks;
}

function decodePng(path) {
  const chunks = readChunks(readFileSync(path));
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colorType = ihdr[9];
  if (depth !== 8) throw new Error(`only 8-bit PNGs supported, got ${depth}`);

  const palette = chunks.find((c) => c.type === 'PLTE')?.data;
  const alpha = chunks.find((c) => c.type === 'tRNS')?.data;
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = inflateSync(idat);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  // Undo the per-scanline filters. Each row is prefixed with its filter byte.
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const dst = out.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? dst[i - channels] : 0;   // left
      const b = up ? up[i] : 0;                          // above
      const c = up && i >= channels ? up[i - channels] : 0;  // above-left
      let v = row[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      dst[i] = v & 0xff;
    }
  }

  // Normalise everything to RGBA so the compositor below stays simple.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (colorType === 3) {
      const idx = out[i];
      rgba[i * 4] = palette[idx * 3];
      rgba[i * 4 + 1] = palette[idx * 3 + 1];
      rgba[i * 4 + 2] = palette[idx * 3 + 2];
      rgba[i * 4 + 3] = alpha && idx < alpha.length ? alpha[idx] : 255;
    } else if (colorType === 2) {
      rgba.set(out.subarray(i * 3, i * 3 + 3), i * 4);
      rgba[i * 4 + 3] = 255;
    } else {
      rgba.set(out.subarray(i * channels, i * channels + 4), i * 4);
    }
  }
  return { width, height, rgba };
}

// --- PNG encode ---------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // RGBA
  // Filter 0 on every row: the images are tiny and flat, so it costs nothing.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- compose ------------------------------------------------------------

const sheet = decodePng(SHEET);

/** Nearest-neighbour blit of one 16x16 tile, scaled, keeping pixels crisp. */
function blitTile(dst, size, col, row, dx, dy, scale) {
  for (let y = 0; y < TILE * scale; y++) {
    for (let x = 0; x < TILE * scale; x++) {
      const sx = col * TILE + Math.floor(x / scale);
      const sy = row * TILE + Math.floor(y / scale);
      const s = (sy * sheet.width + sx) * 4;
      if (sheet.rgba[s + 3] === 0) continue;          // transparent source pixel
      const tx = dx + x;
      const ty = dy + y;
      if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue;
      const d = (ty * size + tx) * 4;
      dst[d] = sheet.rgba[s];
      dst[d + 1] = sheet.rgba[s + 1];
      dst[d + 2] = sheet.rgba[s + 2];
      dst[d + 3] = 255;
    }
  }
}

/** The barn on grass: three roof rows (cols 9-11) over two body rows (cols 6-8). */
function makeIcon(size, fill) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = 0x84; rgba[i * 4 + 1] = 0xc6; rgba[i * 4 + 2] = 0x69; rgba[i * 4 + 3] = 255;
  }

  const srcH = 5 * TILE;
  const scale = Math.max(1, Math.floor((size * fill) / srcH));
  const w = 3 * TILE * scale;
  const h = srcH * scale;
  const ox = Math.round((size - w) / 2);
  const oy = Math.round((size - h) / 2);

  [7, 8, 9].forEach((row, i) => {
    for (let c = 0; c < 3; c++) blitTile(rgba, size, 9 + c, row, ox + c * TILE * scale, oy + i * TILE * scale, scale);
  });
  [9, 10].forEach((row, i) => {
    for (let c = 0; c < 3; c++) blitTile(rgba, size, 6 + c, row, ox + c * TILE * scale, oy + (3 + i) * TILE * scale, scale);
  });

  return encodePng(size, size, rgba);
}

mkdirSync('icons', { recursive: true });
// Maskable icons get cropped, so leave the barn more room in those.
for (const [name, size, fill] of [
  ['icons/icon-512.png', 512, 0.72],
  ['icons/icon-192.png', 192, 0.72],
  ['icons/apple-touch-icon.png', 180, 0.66],
]) {
  writeFileSync(name, makeIcon(size, fill));
  console.log(`wrote ${name}`);
}
