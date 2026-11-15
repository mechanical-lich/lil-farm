// Draws November's leaves and turkeys.
//
//   node tools/make-thanksgiving.mjs
//
// Writes two sheets, both from the text grids below — this file is their
// source, the same arrangement as tools/make-gourds.mjs. Change a grid and
// rerun.
//
//   assets/flora/leaves.png     one row of leaves, in LEAF_IDS order (see
//                               js/sim/thanksgiving.js)
//   assets/animals/turkeys.png  one column of turkeys, a breed per row, on the
//                               row js/sim/wildkinds.js says it lives on —
//                               the wildlife sheets' own layout
//
// Grids are the *inside* only; the outline is grown by the rule in
// tools/outline.mjs. A turkey follows the animal sheets' convention on top of
// it: nothing is drawn below its lowest pixel, so it has no line under its
// feet. A leaf is lying on the ground and is outlined all the way round.
//
// Legend — leaves
//   A B C   the leaf's own colours: blade, veins and shade, highlight
//   s       stem brown
//   .       nothing
//
// Legend — turkeys (one silhouette, a coat per breed)
//   T t     tail fan, and the band across its tips
//   B b     body, and its shade
//   W       wing
//   h e     head, and eye
//   R       snood and wattle
//   y f     beak, and feet
//   .       nothing

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';
import { isOutline } from './outline.mjs';
import { LEAF_IDS } from '../js/sim/thanksgiving.js';
import { TURKEY_KINDS, TURKEY_IDS } from '../js/sim/wildkinds.js';

const T = 16;

const OUTLINE = [63, 38, 49];
const STEM = [143, 86, 59];

const E = '................';

export const LEAF_COLOURS = {
  sugarmaple: { A: [232, 106, 44], B: [176, 62, 36], C: [253, 170, 83] },
  redoak: { A: [178, 70, 48], B: [122, 42, 40], C: [220, 110, 70] },
  whiteoak: { A: [168, 112, 72], B: [118, 72, 52], C: [206, 156, 104] },
  ginkgo: { A: [250, 214, 74], B: [212, 160, 44], C: [255, 240, 160] },
  aspen: { A: [244, 184, 52], B: [200, 130, 36], C: [255, 224, 120] },
  birch: { A: [226, 206, 80], B: [170, 150, 50], C: [248, 236, 150] },
  sweetgum: { A: [150, 60, 96], B: [100, 38, 72], C: [200, 96, 120] },
  sassafras: { A: [240, 140, 56], B: [190, 92, 40], C: [255, 196, 110] },
  tuliptree: { A: [236, 200, 64], B: [188, 146, 44], C: [252, 232, 140] },
  beech: { A: [196, 128, 60], B: [140, 84, 44], C: [230, 172, 100] },
  dogwood: { A: [196, 52, 60], B: [132, 32, 52], C: [236, 104, 96] },
  willow: { A: [190, 196, 84], B: [132, 144, 56], C: [224, 228, 140] },
};

/**
 * The leaves, keyed by the ids in LEAF_IDS. A test holds the two lists to each
 * other; the order of the sheet is LEAF_IDS', not this object's.
 */
export const LEAVES = {
  // Five pointed lobes: the one on the flag.
  sugarmaple: [E, E,
    '.......A........',
    '......AAA.......',
    '...A..AAA..A....',
    '...AA.ACA.AA....',
    '..AAAAACAAAAA...',
    '...AAACBCAAA....',
    '..AAAAABAAAAA...',
    '...AACABACAA....',
    '....AAABAAA.....',
    '......ABA.......',
    '.......s........',
    '.......s........',
    E, E],
  // Long, with bristle-tipped lobes either side of the midrib.
  redoak: [E, E,
    '.......A........',
    '.....A.AA.A.....',
    '.....AAABAA.....',
    '...A..AABA..A...',
    '...AAAAABAAAA...',
    '....AAACBAAA....',
    '...A.AAABAA.A...',
    '...AAAAABAAAA...',
    '....AAAABAAA....',
    '......AABA......',
    '.......Bs.......',
    '........s.......',
    E, E],
  // The same idea with every point rounded off.
  whiteoak: [E, E,
    '......AAA.......',
    '.....AAAAA......',
    '......ABA.......',
    '...AAAABAAAA....',
    '...AAAABAAAA....',
    '.....ACBA.......',
    '...AAAABAAAA....',
    '...AAAABAAAA....',
    '.....AABA.......',
    '.....AABAA......',
    '.......s........',
    '.......s........',
    E, E],
  // A fan with a notch in the middle.
  ginkgo: [E, E, E,
    '...AAAA..AAAA...',
    '..AACAAAAAACAA..',
    '..AAACAAAACAAA..',
    '..AAAACAACAAAA..',
    '...AAAABBAAAA...',
    '....AAABBAAA....',
    '.....AABBAA.....',
    '......ABBA......',
    '.......ss.......',
    '.......s........',
    '......s.........',
    E, E],
  // Nearly round, a small point, and the long stalk that makes it tremble.
  aspen: [E, E,
    '.......A........',
    '......AAA.......',
    '....AAACAAA.....',
    '...AAAACAAAA....',
    '...AACABACAA....',
    '...AAAABAAAA....',
    '...AAAABAAAA....',
    '....AAABAAA.....',
    '.....AABAA......',
    '.......s........',
    '.......s........',
    '........s.......',
    E, E],
  // A toothed triangle, widest near the stalk.
  birch: [E, E,
    '........A.......',
    '.......AA.......',
    '......AABA......',
    '.....AAABAA.....',
    '....ACAABACA....',
    '....AAACBAAA....',
    '...AACAABACA....',
    '...AAAAABAAA....',
    '....AAAABAA.....',
    '.....AAsAA......',
    '.......s........',
    '......s.........',
    E, E],
  // A five-pointed star.
  sweetgum: [E, E,
    '.......A........',
    '.......A........',
    '..A...AAA...A...',
    '..AAA.ABA.AAA...',
    '...AAAABAAAA....',
    '....AACBCAA.....',
    '.....AABAA......',
    '....AAABAAA.....',
    '...AAA.s.AAA....',
    '..AA...s...AA...',
    '.......s........',
    E, E, E],
  // The mitten: one lobe and a thumb.
  sassafras: [E, E,
    '......AAA.......',
    '.....AAAAA......',
    '.....AACAA..A...',
    '.....AABAA.AAA..',
    '.....AABAAAAAA..',
    '.....AABAACAA...',
    '.....AABABAA....',
    '.....AAABAA.....',
    '......AABA......',
    '.......As.......',
    '........s.......',
    '........s.......',
    E, E],
  // Four lobes and a top that looks bitten off square.
  tuliptree: [E, E,
    '....AA....AA....',
    '....AAA..AAA....',
    '...AAAAAAAAAA...',
    '..AAACAABACAAA..',
    '...AAAAABAAAA...',
    '....AAAABAAA....',
    '...AAAAABAAAA...',
    '..AAAAAABAAAAA..',
    '...AAAAABAAAA...',
    '.....AAABAA.....',
    '........s.......',
    '........s.......',
    E, E],
  // A plain oval ruled with straight side veins.
  beech: [E, E,
    '.......A........',
    '......AAA.......',
    '.....ABABA......',
    '.....AABAA......',
    '....ABABABA.....',
    '....AAABAAA.....',
    '....ABABABA.....',
    '....AAABAAA.....',
    '.....ABABA......',
    '......ABA.......',
    '.......s........',
    '.......s........',
    E, E],
  // A broad oval whose veins curve round to follow the edge.
  dogwood: [E, E,
    '........A.......',
    '.......AA.......',
    '.....AAABA......',
    '....AACABAA.....',
    '....ACAABCAA....',
    '...AAAAABACA....',
    '...AACAABAAA....',
    '....AACABAA.....',
    '.....AAABA......',
    '......AAs.......',
    '.......s........',
    E, E, E],
  // Long and narrow, lying on the slant.
  willow: [E, E,
    '...........A....',
    '..........AA....',
    '.........AAB....',
    '........AABA....',
    '.......AABA.....',
    '......AABA......',
    '.....AABA.......',
    '....AABA........',
    '....ABA.........',
    '...sA...........',
    '..s.............',
    E, E, E],
};

/** Every turkey is this bird; the breed is the coat. Drawn facing right. */
export const TURKEY = [E, E,
  '....ttt.........',
  '...tTTTtt.......',
  '..tTtTTTTt.hh...',
  '..tTTtTtTt.hey..',
  '..tTtTtTTt.hR...',
  '..tTTtTBBBBBR...',
  '...tTTBBWWBB....',
  '....tBBWWWBB....',
  '....BBBbWWbB....',
  '.....BBbbbB.....',
  '......f..f......',
  '.....ff.ff......',
  E, E];

/** What every breed shares: the bare head, the red, the beak and the feet. */
const TURKEY_SHARED = {
  h: [139, 155, 180], e: [38, 43, 68], R: [228, 59, 68], y: [254, 174, 52], f: [254, 174, 52],
};

/** The coats, keyed by the ids in TURKEY_KINDS. */
export const TURKEY_COLOURS = {
  // Dark all over, with the buff band the wild bird wears on its tail.
  wildturkey: { T: [118, 59, 54], t: [225, 154, 101], B: [102, 57, 49], b: [70, 40, 44], W: [189, 108, 74] },
  // The farmyard classic: coppery, with white tips to the fan.
  bronzeturkey: { T: [143, 86, 59], t: [255, 255, 255], B: [160, 104, 56], b: [110, 68, 46], W: [225, 154, 101] },
  // Chestnut red with a white tail and white in the wing.
  bourbonred: { T: [255, 255, 255], t: [176, 70, 48], B: [164, 62, 44], b: [116, 42, 40], W: [255, 255, 255] },
  // Steel grey barred with black and white.
  narragansett: { T: [82, 96, 124], t: [192, 203, 220], B: [58, 66, 92], b: [38, 43, 68], W: [192, 203, 220] },
  // White, with every feather edged in black.
  royalpalm: { T: [255, 255, 255], t: [38, 43, 68], B: [255, 255, 255], b: [192, 203, 220], W: [82, 96, 124] },
  // Ash blue from beak to tail.
  blueslate: { T: [139, 155, 180], t: [192, 203, 220], B: [120, 138, 166], b: [82, 96, 124], W: [192, 203, 220], h: [247, 194, 130] },
};

/**
 * One 16x16 sprite, outline included.
 * @param {boolean} grounded leave off the line under its lowest pixel
 */
export function build(rows, colours, { grounded = false } = {}) {
  if (rows.length !== T || rows.some((r) => r.length !== T)) {
    throw new Error(`a design is ${T}x${T}: got ${rows.map((r) => r.length).join(',')}`);
  }
  const grid = rows.map((r) => [...r]);
  const inside = (x, y) => y >= 0 && y < T && x >= 0 && x < T && grid[y][x] !== '.';
  let lowest = -1;
  for (let y = 0; y < T; y++) if (grid[y].some((c) => c !== '.')) lowest = y;

  const rgba = Buffer.alloc(T * T * 4);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const c = grid[y][x];
      let rgb;
      if (c === '.') {
        if (grounded && y > lowest) continue;
        if (!isOutline(inside, x, y)) continue;
        rgb = OUTLINE;
      } else {
        rgb = c === 's' ? STEM : colours[c];
      }
      if (!rgb) throw new Error(`no colour for "${c}"`);
      const i = (y * T + x) * 4;
      rgba[i] = rgb[0]; rgba[i + 1] = rgb[1]; rgba[i + 2] = rgb[2]; rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function sheet(cols, rows, spriteAt) {
  const width = cols * T;
  const rgba = Buffer.alloc(width * rows * T * 4);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sprite = spriteAt(c, r);
      for (let y = 0; y < T; y++) {
        sprite.copy(rgba, ((r * T + y) * width + c * T) * 4, y * T * 4, (y + 1) * T * 4);
      }
    }
  }
  return { width, height: rows * T, rgba };
}

export function drawLeafSheet() {
  const leaves = LEAF_IDS.map((id) => {
    if (!LEAVES[id] || !LEAF_COLOURS[id]) throw new Error(`${id} has no ${LEAVES[id] ? 'colours' : 'design'}`);
    return build(LEAVES[id], LEAF_COLOURS[id]);
  });
  return sheet(leaves.length, 1, (c) => leaves[c]);
}

export function drawTurkeySheet() {
  const byRow = [];
  for (const id of TURKEY_IDS) {
    if (!TURKEY_COLOURS[id]) throw new Error(`${id} has no coat`);
    byRow[TURKEY_KINDS[id].row] = build(TURKEY, { ...TURKEY_SHARED, ...TURKEY_COLOURS[id] }, { grounded: true });
  }
  return sheet(1, TURKEY_IDS.length, (c, r) => byRow[r]);
}

// --- run it --------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = (rel, { width, height, rgba }) => {
    writeFileSync(fileURLToPath(new URL(rel, import.meta.url)), encodePng(width, height, rgba));
    console.log(`${rel.slice(3)}: ${width / T}x${height / T}`);
  };
  write('../assets/flora/leaves.png', drawLeafSheet());
  write('../assets/animals/turkeys.png', drawTurkeySheet());
}
