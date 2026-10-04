// Draws the generated flower kinds into assets/flora/flowers.png.
//
//   node tools/make-flower-kinds.mjs
//
// The first eight kinds on the sheet were drawn by hand. These six were drawn
// here, as text, and this file is their source: change a grid below and rerun
// to change the flower. A shape edit is then a reviewable diff of characters
// rather than an opaque change to a PNG.
//
// The grids are the *inside* of each flower only. The heavy dark outline every
// sprite on the sheet wears is generated, by the same rule the artist's turns
// out to follow: every empty pixel within two of a coloured one, except the
// four diagonal corners at exactly two. Measured against the eight hand-drawn
// kinds, that rule reproduces the sunflower and daisy pixel for pixel and the
// rest to within a handful of hand-tuned pixels — so a generated flower wears
// the same outline as a drawn one, which is most of what makes it look like it
// belongs on the sheet.
//
// The one thing this means for drawing: any gap narrower than about four
// pixels fills in with outline. That is why there is a hyacinth here rather
// than a lavender — a thin spike of buds came out looking like a thermometer.
//
// Legend
//   W M S   the three greys the genome recolours, lit face to shadow
//   g G l   stem and leaf greens, never recoloured
//   y       a fixed yellow, for the hearts of the lily and forget-me-not
//   o       outline, if a design wants a dark line *inside* itself
//   .       nothing
//
// Each kind is written to the column FLOWERS says it lives in, so the table in
// js/sim/flowergenes.js decides placement and this file decides the pixels. The
// hand-drawn columns are never touched. Safe to rerun: the second run writes
// exactly the bytes the first one did.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';
import { FLOWERS } from '../js/sim/flowergenes.js';

const T = 16;

export const PALETTE = {
  o: [63, 38, 49],
  W: [255, 255, 255], M: [198, 198, 198], S: [141, 141, 141],
  g: [132, 198, 105], G: [78, 151, 76], l: [198, 229, 141],
  y: [246, 214, 94],
};

/** The leaf base nearly every hand-drawn kind stands on, rows 12 to 15. */
const BASE = [
  '.....GGggll.....',
  '.....GGggll.....',
  '......Gggl......',
  '.......gg.......',
];

export const DESIGNS = {
  // A cup with a notched three-point crown.
  tulip: [
    '................',
    '................',
    '....W..MM..S....',
    '....WW.MM.SS....',
    '....WWWMMMSS....',
    '....WWMMMMSS....',
    '....WWMMMMSS....',
    '.....WMMMMS.....',
    '......MMMS......',
    '.......SS.......',
    '.......gg.......',
    '.......gg.......',
    ...BASE,
  ],
  // A five-pointed star with a yellow heart — the most different silhouette
  // from anything already on the sheet.
  lily: [
    '................',
    '................',
    '.......WW.......',
    '.......WM.......',
    '......WWMS......',
    '..WWWWWyyMSSSS..',
    '...WWWMyyMSSS...',
    '.....WMMMSS.....',
    '....WWM..SSS....',
    '...WW......SS...',
    '.......gg.......',
    '.......gg.......',
    ...BASE,
  ],
  // The peony's outline, told apart by the spiral.
  rose: [
    '................',
    '................',
    '................',
    '.....WWWMM......',
    '....WWMSSMM.....',
    '....WMSWWSM.....',
    '....WMSWSSMS....',
    '....MMSSSMSS....',
    '.....MMMSSS.....',
    '......lSSl......',
    '.......gg.......',
    '.......gg.......',
    ...BASE,
  ],
  // A round ball of florets on a tall bare stem: the only lollipop.
  allium: [
    '................',
    '................',
    '.....WMWM.......',
    '....WMWMWS......',
    '....MWMWMS......',
    '....WMWMSS......',
    '.....MSMS.......',
    '.......g........',
    '.......g........',
    '.......g........',
    '.......g........',
    '.......gg.......',
    ...BASE,
  ],
  // A cone of beads. Tall like the crocus, but bumpy and pointed.
  hyacinth: [
    '................',
    '................',
    '.......W........',
    '......WMS.......',
    '......MWS.......',
    '.....WMSMS......',
    '.....MWMSS......',
    '.....WMSMS......',
    '......MWS.......',
    '.......S........',
    '.......g........',
    '.......gg.......',
    ...BASE,
  ],
  // Three tiny blossoms on branching stems — the only kind with more than one
  // head. Its id has no underscores because seed ids split on the first one.
  forgetmenot: [
    '................',
    '................',
    '.....W....M.....',
    '....WyW..MyS....',
    '.....M.W..S.....',
    '......WyM.......',
    '.......S........',
    '.....g.g.g......',
    '......ggg.......',
    '.......g........',
    '.......gg.......',
    '.......gg.......',
    ...BASE,
  ],
};

/** One 16x16 sprite, outline included, from a grid of insides. */
export function build(rows) {
  if (rows.length !== T || rows.some((r) => r.length !== T)) {
    throw new Error(`a design is ${T}x${T}: got ${rows.map((r) => r.length).join(',')}`);
  }
  const grid = rows.map((r) => [...r]);
  for (const row of grid) {
    for (const c of row) {
      if (c !== '.' && !PALETTE[c]) throw new Error(`no colour for "${c}"`);
    }
  }
  const inside = (x, y) => y >= 0 && y < T && x >= 0 && x < T
    && grid[y][x] !== '.' && grid[y][x] !== 'o';

  const rgba = Buffer.alloc(T * T * 4);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      let c = grid[y][x];
      if (c === '.') {
        let near = false;
        for (let dy = -2; dy <= 2 && !near; dy++) {
          for (let dx = -2; dx <= 2 && !near; dx++) {
            if (Math.abs(dx) === 2 && Math.abs(dy) === 2) continue;   // round the corners
            if (inside(x + dx, y + dy)) near = true;
          }
        }
        if (!near) continue;
        c = 'o';
      }
      const [r, g, b] = PALETTE[c];
      const i = (y * T + x) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/**
 * The sheet with every generated kind written into its column.
 * @param {{width: number, height: number, rgba: Uint8Array}} src
 */
export function drawKinds(src) {
  if (src.height !== T) throw new Error(`the flower sheet should be one row of ${T}px`);
  const columns = Math.max(...Object.values(FLOWERS).map((f) => f.sprite)) + 1;
  const width = columns * T;
  const rgba = Buffer.alloc(width * T * 4);
  for (let y = 0; y < T; y++) {
    Buffer.from(src.rgba).copy(rgba, y * width * 4, y * src.width * 4,
      y * src.width * 4 + Math.min(src.width, width) * 4);
  }
  for (const [kind, rows] of Object.entries(DESIGNS)) {
    const def = FLOWERS[kind];
    if (!def) throw new Error(`${kind} is drawn here but missing from FLOWERS`);
    const sprite = build(rows);
    for (let y = 0; y < T; y++) {
      sprite.copy(rgba, (y * width + def.sprite * T) * 4, y * T * 4, (y + 1) * T * 4);
    }
  }
  return { width, height: T, rgba };
}

// --- run it --------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = fileURLToPath(new URL('../assets/flora/flowers.png', import.meta.url));
  const src = decodePng(path);
  const out = drawKinds(src);
  writeFileSync(path, encodePng(out.width, out.height, out.rgba));
  console.log(`flowers.png: ${src.width / T} -> ${out.width / T} kinds `
    + `(drawn here: ${Object.keys(DESIGNS).join(', ')})`);
}
