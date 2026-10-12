// Draws the gourds and the jack-o'-lanterns.
//
//   node tools/make-gourds.mjs
//
// Writes two sheets, both from the text grids below — this file is their
// source, the same arrangement as tools/make-flower-kinds.mjs and
// tools/mushroom-kinds.mjs. Change a grid and rerun.
//
//   assets/flora/gourds.png        a row per gourd, in GOURDS order (see
//                                  js/sim/crops.js): seedling, young, ripe,
//                                  withered, and set out as a decoration
//   assets/flora/jackolanterns.png one row of LANTERN_FACES faces
//
// Grids are the *inside* only; the outline is grown by the rule in
// tools/outline.mjs, the one the artist's crops and flowers already wear.
//
// Legend
//   A B C   the gourd's own colours: body, shade, highlight (GOURD_COLOURS)
//   g G l   leaf greens, the crop sheet's own
//   s       stem brown
//   y       a squash blossom, and a jack-o'-lantern's candle glow
//   f       a jack-o'-lantern's lit face
//   r       a jack-o'-lantern's tongue
//   w       white, for the turban's stripes
//   k       a dark hole, for the birdhouse gourd
//   .       nothing
//
// The seedling and the young vine are shared by every gourd, the young one
// with a little fruit in the gourd's own colours. A withered gourd is its ripe
// sprite recoloured to the crop sheet's browns by brightness, and a gourd set
// out as a decoration is its ripe sprite with the leaves taken off — it has
// been picked — so a new gourd needs one grid, not five.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';
import { isOutline } from './outline.mjs';
import { GOURDS } from '../js/sim/crops.js';

const T = 16;

export const STAGES = 5;   // seedling, young, ripe, withered, set out — the sheet's columns

export const SHARED = {
  o: [63, 38, 49],
  g: [132, 198, 105], G: [78, 151, 76], l: [198, 229, 141],
  s: [143, 86, 59], y: [253, 190, 83], w: [255, 255, 255], k: [40, 24, 30],
  f: [255, 236, 110],
};

export const GOURD_COLOURS = {
  pumpkin: { A: [227, 134, 40], B: [186, 88, 32], C: [253, 190, 83] },
  wintersquash: { A: [118, 152, 166], B: [80, 108, 128], C: [178, 206, 212] },
  birdhouse: { A: [214, 170, 100], B: [168, 122, 68], C: [242, 212, 152] },
  acorn: { A: [58, 104, 66], B: [36, 70, 46], C: [232, 150, 56] },
  turban: { A: [206, 72, 52], B: [150, 44, 40], C: [244, 128, 92] },
  swan: { A: [104, 164, 72], B: [62, 116, 56], C: [214, 232, 150] },
  spaghetti: { A: [246, 214, 92], B: [214, 170, 58], C: [255, 242, 176] },
  ghostpumpkin: { A: [232, 228, 214], B: [190, 186, 176], C: [255, 255, 255] },
};

/** A jack-o'-lantern is a darker pumpkin than a growing one: it's lit from inside. */
export const LANTERN_COLOURS = {
  A: [196, 92, 30], B: [140, 56, 26], C: [228, 132, 44], y: [255, 178, 50],
  r: [240, 76, 96],   // the silly one's tongue
};

const E = '................';

export const SEEDLING = [E, E, E, E, E, E, E,
  '.....gg..gg.....',
  '....glgg.gglg...',
  '......gGGg......',
  '.......Gg.......',
  E, E, E, E, E];

export const YOUNG = [E, E, E,
  '....gg....gg....',
  '...glgg..gglg...',
  '...gggG..Gggg...',
  '....GGgggGG.....',
  '......GgG...y...',
  '.......G...yyy..',
  '......AAG...yG..',
  '.....ABAAgGGG...',
  '......AA........',
  E, E, E, E];

const PUMPKIN = [E, E, E,
  '.......ss.gg....',
  '.....AAsAAglg...',
  '...ACAABAACAA...',
  '..ACAABAAACAAB..',
  '..ACAABAAACAAB..',
  '..AAAABAAAAAAB..',
  '..BAAABAAABAAB..',
  '...BAABAAABAB...',
  '....BBBBBBBB....',
  E, E, E, E];

export const RIPE = {
  pumpkin: PUMPKIN,
  // A blue hubbard: a lopsided teardrop.
  wintersquash: [E, E, E,
    '.......s........',
    '......ACA.......',
    '.....ACAAB..gg..',
    '....ACAAAAB.glg.',
    '...ACAAAAAAB.g..',
    '...AAAAAAAAB....',
    '...BAAAAAABB....',
    '....BAAAAABg....',
    '.....BBBBBgGg...',
    '.......B...g....',
    E, E, E],
  // A bottle with a hole cut in it for the birds.
  birdhouse: [E, E,
    '.......s........',
    '.......s........',
    '......ACA.......',
    '......AAB.......',
    '......CAB.......',
    '.....ACAAB......',
    '....ACkkAAB.....',
    '....AAkkAAB.....',
    '....BAAAAAB.....',
    '.....BAAABB.....',
    '..gg..BBBB..gg..',
    '..glg......glg..',
    E, E],
  // Deep ribs, pointed at the bottom, with the orange patch where it lay.
  acorn: [E, E, E,
    '.......ss.......',
    '....ABAsABAB....',
    '...ABABAABABA...',
    '...ABABAABABA...',
    '...ABABAABCBA...',
    '....ABAAABCB....',
    '.....BABABB.....',
    '......BABB......',
    '.......BB.......',
    '..gg........gg..',
    E, E, E],
  // A red base wearing a striped cap.
  turban: [E, E, E,
    '.......ss.......',
    '.....gwgwgw.....',
    '....gwgwgwgw....',
    '....AwAgAwAg....',
    '...ACAACAACAA...',
    '..ACAABAACAABB..',
    '..AAAABAAAAABB..',
    '..BAAABAAABABB..',
    '...BBBBBBBBBB...',
    E, E, E, E],
  // A round body and a long neck curling over at the top.
  swan: [E, E,
    '.....sAAA.......',
    '....ACBBAA......',
    '....AB...BA.....',
    '....AB....B.....',
    '....AB..........',
    '....AAB.........',
    '.....AB.........',
    '.....ACAAA......',
    '....ACACAAB.....',
    '....AAAACAB..g..',
    '....BACAAAB.glg.',
    '.....BBBBB..gg..',
    E, E],
  // A plain yellow oval.
  spaghetti: [E, E, E, E, E,
    '.......s........',
    '....ACCAAAA.....',
    '...ACAAAAAAB....',
    '...AAAAAAAAB....',
    '...AAAAAAABB....',
    '...BAAAAAABB....',
    '....BBBBBBB.....',
    '..gg........gg..',
    '..glg......glg..',
    E, E],
  // The pumpkin, in white.
  ghostpumpkin: PUMPKIN,
};

/** A pumpkin with a lit face cut in it: five rows of face, framed. */
const lantern = (face) => [E, E, E,
  '.......ss.......',
  '......ssg.......',
  '....AAAAAAAA....',
  '...ACAABAACAA...',
  ...face,
  '...BAABAAABAB...',
  '....BBBBBBBB....',
  E, E];

/**
 * The faces, in sheet order, keyed by the names in LANTERN_NAMES
 * (js/sim/lanterns.js). The order is saved: change a face, never reorder, and
 * add new ones at the end.
 */
export const FACES = {
  classic: [
    '..AAfAAAAfAAAB..',
    '..AffyAAffyAAB..',
    '..AAAAAfAAAAAB..',
    '..fAAAAAAAAAfB..',
    '..AffffffffffB..',
  ],
  surprised: [
    '..AffAAAAffAAB..',
    '..AffAAAAffAAB..',
    '..AAAAAAAAAAAB..',
    '..AAAAAffAAAAB..',
    '..AAAAAffAAAAB..',
  ],
  grumpy: [
    '..ffAAAAAAffAB..',
    '..AffyAAyffAAB..',
    '..AAAAAAAAAAAB..',
    '..AfAfAfAfAfAB..',
    '..AffffffffffB..',
  ],
  happy: [
    '..AfffAAfffAAB..',
    '..fAAAfAAAAfAB..',
    '..AAAAAAAAAAAB..',
    '..AfAAAAAAAfAB..',
    '..AAfffffffAAB..',
  ],
  winking: [
    '..AAfAAAAAAAAB..',
    '..AffyAAfffAAB..',
    '..AAAAAAAAAAAB..',
    '..AfAAAAAAAfAB..',
    '..AAfffffffAAB..',
  ],
  sleepy: [
    '..AAAAAAAAAAAB..',
    '..AfffAAAfffAB..',
    '..AAAAAAAAAAAB..',
    '..AAAAAffAAAAB..',
    '..AAAAAAAAAAAB..',
  ],
  vampire: [
    '..AfyAAAAAyfAB..',
    '..AAffAAAffAAB..',
    '..AAAAAAAAAAAB..',
    '..AfffffffffAB..',
    '..AAfAAAAAfAAB..',
  ],
  silly: [
    '..AffAAAAffAAB..',
    '..AffAAAAffAAB..',
    '..AAAAAAAAAAAB..',
    '..AfffffffffAB..',
    '..AAAArrrAAAAB..',
  ],
  cyclops: [
    '..AAAAffyAAAAB..',
    '..AAAfffffAAAB..',
    '..AAAAffyAAAAB..',
    '..AAAAAAAAAAAB..',
    '..AAffffffAAAB..',
  ],
  lovestruck: [
    '..AfAfAAfAfAAB..',
    '..AfffAAfffAAB..',
    '..AAfAAAAfAAAB..',
    '..AAAAAAAAAAAB..',
    '..AAAfffffAAAB..',
  ],
  spooky: [
    '..AffAAAAAffAB..',
    '..AffAAAAAffAB..',
    '..AAAAAAAAAAAB..',
    '..AfAAAfAAAfAB..',
    '..fAfAfAfAfAfB..',
  ],
  sad: [
    '..AAAAAAAAAAAB..',
    '..AffyAAffyAAB..',
    '..AAAAAAAAAAAB..',
    '..AAAffffAAAAB..',
    '..AAfAAAAfAAAB..',
  ],
};

/** One 16x16 sprite, outline included. */
export function build(rows, colours) {
  if (rows.length !== T || rows.some((r) => r.length !== T)) {
    throw new Error(`a design is ${T}x${T}: got ${rows.map((r) => r.length).join(',')}`);
  }
  const grid = rows.map((r) => [...r]);
  const inside = (x, y) => y >= 0 && y < T && x >= 0 && x < T
    && grid[y][x] !== '.' && grid[y][x] !== 'o';
  const rgba = Buffer.alloc(T * T * 4);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      let c = grid[y][x];
      if (c === '.') {
        if (!isOutline(inside, x, y)) continue;
        c = 'o';
      }
      const rgb = colours[c] || SHARED[c];
      if (!rgb) throw new Error(`no colour for "${c}"`);
      const i = (y * T + x) * 4;
      rgba[i] = rgb[0]; rgba[i + 1] = rgb[1]; rgba[i + 2] = rgb[2]; rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/** The crop sheet's withered browns, darkest first. */
export const WITHERED = [[110, 64, 48], [143, 86, 59], [189, 108, 74], [234, 165, 108]];

/** A ripe sprite gone over: everything but the outline, to brown by brightness. */
export function wither(rgba) {
  const out = Buffer.from(rgba);
  const [or, og, ob] = SHARED.o;
  for (let i = 0; i < out.length; i += 4) {
    if (!out[i + 3]) continue;
    if (out[i] === or && out[i + 1] === og && out[i + 2] === ob) continue;
    const lum = 0.3 * out[i] + 0.59 * out[i + 1] + 0.11 * out[i + 2];
    const [r, g, b] = WITHERED[Math.min(WITHERED.length - 1, Math.floor(lum / 64))];
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
  }
  return out;
}

/**
 * Which letters are leaves, to come off a picked gourd. The turban keeps its
 * greens: they are the stripes on its cap, not leaves.
 */
const LEAVES = /[gGl]/g;
const KEEPS_GREEN = new Set(['turban']);

/** The ripe grid with the leaves off: a gourd that has been picked. */
export function picked(kind) {
  const rows = RIPE[kind];
  return KEEPS_GREEN.has(kind) ? rows : rows.map((r) => r.replace(LEAVES, '.'));
}

/** Every stage of one gourd, in sheet order. */
export function gourdStages(kind) {
  const colours = GOURD_COLOURS[kind];
  const rows = RIPE[kind];
  if (!colours || !rows) throw new Error(`${kind} has no ${colours ? 'design' : 'colours'}`);
  const ripe = build(rows, colours);
  return [build(SEEDLING, colours), build(YOUNG, colours), ripe, wither(ripe), build(picked(kind), colours)];
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

export function drawGourdSheet() {
  const stages = GOURDS.map(gourdStages);
  return sheet(STAGES, GOURDS.length, (c, r) => stages[r][c]);
}

export function drawLanternSheet() {
  const faces = Object.values(FACES).map((face) => build(lantern(face), LANTERN_COLOURS));
  return sheet(faces.length, 1, (c) => faces[c]);
}

// --- run it --------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = (rel, { width, height, rgba }) => {
    writeFileSync(fileURLToPath(new URL(rel, import.meta.url)), encodePng(width, height, rgba));
    console.log(`${rel.slice(3)}: ${width / T}x${height / T}`);
  };
  write('../assets/flora/gourds.png', drawGourdSheet());
  write('../assets/flora/jackolanterns.png', drawLanternSheet());
}
