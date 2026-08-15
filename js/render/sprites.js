// Tilesheet atlas. Three Kenney sheets (CC0), all 16px tiles:
//
//   'farm'   — assets/tilemap_packed.png       crops, soil beds, animals, barn
//   'town'   — assets/town_tilemap_packed.png  grass, dirt, paving, fences, trees
//   'emotes' — assets/emotes.png               speech bubbles over the animals
//
// Both share the same palette (#84c669 grass, #eaa56c dirt), so tiles from the
// two sheets sit next to each other seamlessly.
//
// A sprite is [col, row] for the farm sheet, or [col, row, 'town'] / [col, row,
// 'emotes'] for the others. Keeping the farm form unsuffixed means the sheet
// only has to be named where it isn't the original one.
//
// Coordinates were catalogued from tools/atlas-viewer.html (append ?sheet=town
// for the second sheet). If a sprite looks wrong in game, open that page — it
// draws the sheet magnified with col/row labels.

import { TILE } from '../config.js';

/**
 * The soil capsule set — the art tilling is actually drawn with.
 *
 * Tilled ground is laid out in *rows*, not as a blob, and each row is drawn as a
 * capsule: a rounded cap at each end with straight middles between. Verified
 * tile-by-tile against the sheet (see tools/atlas-viewer.html):
 *
 *   vertical   moisture varies by COLUMN — col 0 dry, col 1 wet
 *              r0 single · r1 top cap · r2 middle · r3 bottom cap
 *   horizontal moisture varies by ROW — row 4 wet, row 5 dry
 *              c0 left cap · c1 middle · c2 right cap · c3 single
 *
 * Note the two orientations have their own "single" sprite (a tall oval vs a
 * wide one), so a one-tile bed still reads as belonging to its row's axis.
 */
export const SOIL = {
  dry: {
    vSingle: [0, 0], vTop: [0, 1], vMid: [0, 2], vBottom: [0, 3],
    hLeft: [0, 5], hMid: [1, 5], hRight: [2, 5], hSingle: [3, 5],
  },
  wet: {
    vSingle: [1, 0], vTop: [1, 1], vMid: [1, 2], vBottom: [1, 3],
    hLeft: [0, 4], hMid: [1, 4], hRight: [2, 4], hSingle: [3, 4],
  },
};

/**
 * Town-sheet ground and fence sets, verified pixel by pixel.
 *
 * GRASS: (0,0) is 100% grass with no decoration — the plain fill. (1,0) and
 * (2,0) are the same grass with clumps and flowers.
 *
 * DIRT: a true 3x3 nine-slice. (1,2) is 100% dirt with no edges (the interior);
 * the ring around it carries the grass boundary. This replaces the derived
 * dirt tile the farm sheet forced on us.
 *
 * FENCE: a full set — a nine-slice for enclosures, plus standalone horizontal
 * and vertical runs with proper end posts.
 */
export const TOWN = {
  grass: [0, 0, 'town'],
  grassClump: [1, 0, 'town'],
  grassFlower: [2, 0, 'town'],

  dirtTL: [0, 1, 'town'], dirtT: [1, 1, 'town'], dirtTR: [2, 1, 'town'],
  dirtL: [0, 2, 'town'], dirtC: [1, 2, 'town'], dirtR: [2, 2, 'town'],
  dirtBL: [0, 3, 'town'], dirtB: [1, 3, 'town'], dirtBR: [2, 3, 'town'],

  paved: [7, 3, 'town'],

  // Straight runs, with end posts.
  fenceHLeft: [8, 6, 'town'], fenceHMid: [9, 6, 'town'], fenceHRight: [10, 6, 'town'],
  fenceVTop: [11, 3, 'town'], fenceVMid: [11, 4, 'town'], fenceVBottom: [11, 5, 'town'],
  // Corners, from the enclosure block.
  fenceCornerTL: [8, 3, 'town'], fenceCornerTR: [10, 3, 'town'],
  fenceCornerBL: [8, 5, 'town'], fenceCornerBR: [10, 5, 'town'],
  fenceEdgeT: [9, 3, 'town'], fenceEdgeB: [9, 5, 'town'],
  fenceEdgeL: [8, 4, 'town'], fenceEdgeR: [10, 4, 'town'],

  pineTop: [4, 0, 'town'], pineBottom: [4, 1, 'town'], pineSmall: [4, 2, 'town'],
  autumnTop: [3, 0, 'town'], autumnBottom: [3, 1, 'town'], autumnSmall: [3, 2, 'town'],
  bushRound: [5, 0, 'town'],
  mushrooms: [5, 2, 'town'],
  signPost: [11, 6, 'town'],
};

export const SPRITES = {
  // Nature
  deadTreeTop: [2, 0],
  deadTreeBottom: [2, 1],
  deadBranch: [2, 2],
  treeTop: [3, 0],
  treeMid: [3, 1],
  treeSmall: [3, 2],
  bush: [3, 3],
  grassTuft: [8, 6],
  leafyBush: [6, 6],
  stump: [7, 6],
  seedling: [9, 6],
  sunflower: [11, 6],
  rockSmall: [5, 6],
  rockPile: [5, 7],

  // Crops: one crop per row (rows 0-5).
  //   col 4 = seedling, col 5 = young, col 6 = ripe and harvestable
  //   col 7 = the SAME plant withered brown — a dead crop, not a growth stage
  //   col 8 = harvested item icon, col 9/10 = seed packets, col 11 = crate
  cropStages: {
    carrot:   [[4, 0], [5, 0], [6, 0]],
    eggplant: [[4, 1], [5, 1], [6, 1]],
    corn:     [[4, 2], [5, 2], [6, 2]],
    tomato:   [[4, 3], [5, 3], [6, 3]],
    cabbage:  [[4, 4], [5, 4], [6, 4]],
    wheat:    [[4, 5], [5, 5], [6, 5]],
  },
  cropDead: {
    carrot: [7, 0], eggplant: [7, 1], corn: [7, 2],
    tomato: [7, 3], cabbage: [7, 4], wheat: [7, 5],
  },
  itemIcons: {
    carrot: [8, 0], eggplant: [8, 1], corn: [8, 2],
    tomato: [8, 3], cabbage: [8, 4], wheat: [8, 5],
  },
  seedPackets: {
    carrot: [9, 0], eggplant: [9, 1], corn: [9, 2],
    tomato: [9, 3], cabbage: [9, 4], wheat: [9, 5],
  },
  crates: {
    carrot: [11, 0], eggplant: [11, 1], corn: [11, 2],
    tomato: [11, 3], cabbage: [11, 4], wheat: [11, 5],
  },

  // Props / containers
  barrel: [0, 6],
  barrelWater: [1, 6],
  sack: [2, 6],
  chair: [3, 6],
  crateEmpty: [4, 6],
  hayBale: [1, 7],
  hayBlock: [0, 8],
  toolA: [2, 7],
  toolB: [3, 7],
  mystery: [4, 7],

  // Troughs are two tiles wide (left half, right half).
  troughWoodEmptyL: [2, 8], troughWoodEmptyR: [3, 8],
  troughMetalEmptyL: [4, 8], troughMetalEmptyR: [5, 8],
  troughWaterL: [2, 9], troughWaterR: [3, 9],
  troughFoodL: [4, 9], troughFoodR: [5, 9],

  // Fences: an X-braced rail set that tiles seamlessly left-to-right.
  //   c6 = left end post, c7 = repeating middle, c8 = right end post
  fenceLeft: [6, 7],
  fenceMid: [7, 7],
  fenceRight: [8, 7],
  // Gates are the hinged panels on row 10 (note the blue hinge pixels).
  gateClosed: [6, 10],
  gateClosedAlt: [7, 10],
  // Barn. Drawn 3 wide and 5 tall from these rows, top to bottom: three roof
  // rows taken from cols 9-11, then two body rows from cols 6-8. Only the two
  // body rows sit on the ground; the roof overhangs upward like a tree canopy.
  // Composition verified by rendering the alternatives side by side.
  barnRoofRows: [7, 8, 9],
  barnBodyRows: [9, 10],
  barnRoofCol0: 9,
  barnBodyCol0: 6,

  // Eggs a hen has dropped, waiting to be picked up.
  egg: [5, 10],

  // Characters
  farmer: [0, 9],
  farmerHat: [1, 9],
  sheep: [0, 10],
  cow: [1, 10],
  chicken: [2, 10],
  duck: [3, 10],
};

/**
 * Kenney's emote pack (CC0), a 5x6 grid of 16px speech bubbles in
 * assets/emotes.png. Catalogued by eye from the sheet itself — only the ones
 * the game actually uses are named; the rest are left for later.
 *
 *   row 0  swirl · music · sad face · sweat drop · ring
 *   row 1  sparkles · HAHA · smiley · ellipsis · dollar
 *   row 2  star · lightbulb · blank · two dots · scribble
 *   row 3  ZZ · small hearts · !! · dot · impact
 *   row 4  Z · broken heart · ! · cross · cheer
 *   row 5  ? · heart · droplets · gloom cloud · angry face
 */
export const EMOTES = {
  music: [1, 0, 'emotes'],
  sad: [2, 0, 'emotes'],
  smile: [2, 1, 'emotes'],
  dots: [3, 1, 'emotes'],
  star: [0, 2, 'emotes'],
  sleep: [0, 3, 'emotes'],
  hearts: [1, 3, 'emotes'],
  heart: [1, 5, 'emotes'],
  droplets: [2, 5, 'emotes'],
  angry: [4, 5, 'emotes'],
};

/** Source rect in the sheet for a [col,row] pair. */
export function srcRect([col, row]) {
  return { sx: col * TILE, sy: row * TILE, sw: TILE, sh: TILE };
}

// --- Derived tiles ------------------------------------------------------

/**
 * The soil capsules with their baked-in grass background knocked out to
 * transparency, so a bed can sit on any ground (grass, or the bare earth left
 * behind by a felled tree) and still look right. The art uses flat colour with
 * no anti-aliasing between grass and dirt, so a simple colour key is exact.
 *
 * Shape: CAPSULES[moisture][piece] -> canvas
 */
export const CAPSULES = { dry: {}, wet: {} };

const GRASS_KEY = [0x84, 0xc6, 0x69];

function cutOutGrass(sheet, [col, row]) {
  const c = document.createElement('canvas');
  c.width = TILE;
  c.height = TILE;
  // willReadFrequently: this canvas exists purely to be read back once.
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sheet, col * TILE, row * TILE, TILE, TILE, 0, 0, TILE, TILE);

  const img = ctx.getImageData(0, 0, TILE, TILE);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] === GRASS_KEY[0] && d[i + 1] === GRASS_KEY[1] && d[i + 2] === GRASS_KEY[2]) {
      d[i + 3] = 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function buildCapsules(sheet) {
  for (const moisture of ['dry', 'wet']) {
    for (const [piece, coords] of Object.entries(SOIL[moisture])) {
      CAPSULES[moisture][piece] = cutOutGrass(sheet, coords);
    }
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load tilesheet: ${src}`));
    img.src = src;
  });
}

/**
 * Loads both tilesheets and prepares derived tiles.
 * @returns {Promise<{farm: HTMLImageElement, town: HTMLImageElement,
 *   emotes: HTMLImageElement}>}
 */
export async function loadSheets() {
  const [farm, town, emotes] = await Promise.all([
    loadImage('assets/tilemap_packed.png'),
    loadImage('assets/town_tilemap_packed.png'),
    loadImage('assets/emotes.png'),
  ]);
  buildCapsules(farm);
  return { farm, town, emotes };
}

/** Resolves which sheet image a sprite reference belongs to. */
export function sheetFor(sheets, sprite) {
  return sheets[sprite[2] || 'farm'];
}
