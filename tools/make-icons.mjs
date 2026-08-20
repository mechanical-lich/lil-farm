// Generates the app icons from the game's own tilesheet: `node tools/make-icons.mjs`
//
// Written by hand rather than pulled from a library because the project has no
// dependencies and no build step. The PNG reading and writing lives in
// tools/png.mjs. Re-run it if the barn art changes.

import { writeFileSync, mkdirSync } from 'node:fs';
import { decodePng, encodePng } from './png.mjs';

const TILE = 16;
const SHEET = 'assets/tilemap_packed.png';

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
