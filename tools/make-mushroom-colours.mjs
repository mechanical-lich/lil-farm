// Builds the generated mushroom colours into assets/flora/mushrooms.png.
//
//   node tools/make-mushroom-colours.mjs
//
// Every colour on the sheet is the same sprite with a different cap, and the
// cap of each kind's Lime sprite is exactly two colours: a base and a shade.
// Everything else — the outline, the stem, the toadstool's white spots — is
// identical across all of a kind's colours. So a new colour is a new pair of
// cap colours swapped into the Lime sprite, and the artist's shading comes with
// it for free. The pairs live in GENERATED_COLOURS in js/sim/mushrooms.js,
// which is the one place to add or change one.
//
// Safe to run on either shape of sheet, any number of times:
//
//   * the hand-drawn one, eight to a kind (four originals, Lime, Cyan, Frost,
//     rainbow) — as exported from art/mushrooms.aseprite before any of this;
//   * the widened one this writes, fourteen to a kind.
//
// Each block is rebuilt as: the first seven columns as they are (drawn by
// hand), then one column per generated colour made fresh from Lime, then the
// block's last column (always the rainbow). Running it on its own output gives
// back exactly the same bytes — there is a test for that — so the drawn columns
// stay the artist's, and editing the sheet in Aseprite and exporting either
// shape is fine. Rerun this after.
//
// It refuses rather than guesses if a Lime sprite isn't made of the two colours
// it expects: a recolour that found no cap would write a column of bare stems
// and call it a success.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';
import { GENERATED_COLOURS, COLOURS_PER_SPECIES, SPECIES } from '../js/sim/mushrooms.js';

const T = 16;

/** Hand-drawn columns at the start of every block: four originals + Lime, Cyan, Frost. */
export const DRAWN = 7;

/** Which of those is Lime — the template every generated colour is made from. */
export const LIME_COLUMN = 4;

/** Lime's two cap colours. Art facts, read off the sheet. */
export const LIME = { base: [153, 229, 80], shade: [106, 190, 48] };

const KINDS = Object.keys(SPECIES).length;

const is = (d, i, c) => d[i] === c[0] && d[i + 1] === c[1] && d[i + 2] === c[2];

/**
 * The widened sheet, from either shape of input.
 *
 * @param {{width: number, height: number, rgba: Uint8Array}} src
 * @returns {{width: number, height: number, rgba: Buffer}}
 */
export function expandSheet(src) {
  if (src.height !== T) throw new Error(`the mushroom sheet should be one row of ${T}px, not ${src.height}px`);
  const columns = src.width / T;
  const per = columns / KINDS;
  if (!Number.isInteger(per) || per < DRAWN + 1) {
    throw new Error(`expected ${KINDS} blocks of at least ${DRAWN + 1} columns, found ${columns} columns`);
  }

  const outPer = COLOURS_PER_SPECIES;
  const width = KINDS * outPer * T;
  const rgba = Buffer.alloc(width * T * 4);

  const copy = (fromCol, toCol, swap) => {
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const si = (y * src.width + fromCol * T + x) * 4;
        const oi = (y * width + toCol * T + x) * 4;
        const d = src.rgba;
        let r = d[si]; let g = d[si + 1]; let b = d[si + 2]; const a = d[si + 3];
        if (swap && a) {
          if (is(d, si, LIME.base)) [r, g, b] = swap.base;
          else if (is(d, si, LIME.shade)) [r, g, b] = swap.shade;
        }
        rgba[oi] = r; rgba[oi + 1] = g; rgba[oi + 2] = b; rgba[oi + 3] = a;
      }
    }
  };

  for (let k = 0; k < KINDS; k++) {
    const inBlock = k * per;
    const outBlock = k * outPer;
    assertLime(src, inBlock + LIME_COLUMN, k);

    for (let c = 0; c < DRAWN; c++) copy(inBlock + c, outBlock + c, null);
    GENERATED_COLOURS.forEach((colour, i) => copy(inBlock + LIME_COLUMN, outBlock + DRAWN + i, colour));
    copy(inBlock + per - 1, outBlock + outPer - 1, null);               // the rainbow
  }
  return { width, height: T, rgba };
}

/** Refuses a Lime sprite that has no cap made of the two expected colours. */
function assertLime(src, col, kind) {
  let base = 0;
  let shade = 0;
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const i = (y * src.width + col * T + x) * 4;
      if (!src.rgba[i + 3]) continue;
      if (is(src.rgba, i, LIME.base)) base++;
      else if (is(src.rgba, i, LIME.shade)) shade++;
    }
  }
  if (!base || !shade) {
    throw new Error(`block ${kind}: column ${col} should be the Lime sprite `
      + `(base ${LIME.base}, shade ${LIME.shade}), found ${base} base and ${shade} shade pixels`);
  }
}

// --- run it --------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = new URL('../assets/flora/mushrooms.png', import.meta.url);
  const src = decodePng(fileURLToPath(path));
  const out = expandSheet(src);
  writeFileSync(path, encodePng(out.width, out.height, out.rgba));
  console.log(`mushrooms.png: ${src.width / T} -> ${out.width / T} sprites `
    + `(${KINDS} kinds x ${COLOURS_PER_SPECIES} colours; generated: `
    + `${GENERATED_COLOURS.map((c) => c.name).join(', ')})`);
}
