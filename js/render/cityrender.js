// Draws the city. Everything here is in world-pixel space; the caller has
// already applied the camera transform, exactly as it does for the farm.
//
// The farm's drawing is not reused wholesale because nearly all of it is about
// things that never happen in a street — soil, crops, ponds, weeds, fish. What
// is reused is what a street shares with a farm: the per-quarter autotiler,
// the blitter, and the grass.

import { TILE } from '../config.js';
import { TOWN, CITY, CITY_ROOF, CITY_WALL, CITY_ROAD, SPRITES, FACTORY, WATER } from './sprites.js';
import { LINES } from '../sim/factory.js';
import { blit, blitAutotile, DIRT_SET, houseGrid, drawUnowned } from './tilerender.js';
import { animalSprite } from './entityrender.js';
import { animalDef, variantOf } from '../sim/animals.js';
import { hash2d } from '../engine/rng.js';
import { CITY_GROUND, cityGroundAt, cityDef, ownsTile } from '../sim/city.js';

/** Ground, then everything standing on it sorted by the row it stands on. */
export function drawCity(ctx, sheets, state, view, alpha = 1) {
  drawPlace(ctx, sheets, state.city, view, alpha);
}

/** The sanctuary: the same kind of map, with its animals drawn in. */
export function drawSanctuary(ctx, sheets, state, view, alpha = 1) {
  drawPlace(ctx, sheets, state.sanctuary, view, alpha);
}

/**
 * Any map built the way the city is: its ground, its pieces, and whoever is
 * standing about on it — townsfolk, vehicles, and in the sanctuary the animals.
 */
function drawPlace(ctx, sheets, city, view, alpha) {
  drawCityGround(ctx, sheets, city, view);

  // Pieces sort by their bottom row, the way the farm's objects do, so a lamp
  // in front of a building is drawn over its wall and one behind it is hidden.
  const rows = new Map();
  const add = (y, fn) => {
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(fn);
  };
  for (const p of city.pieces) {
    const bottom = p.y + p.h - 1;
    const def = cityDef(p.kind);
    const top = p.y - (def?.rise || (def?.tall ? 1 : 0));
    if (bottom < view.y0 || top > view.y1 || p.x + p.w - 1 < view.x0 || p.x > view.x1) continue;
    // An enclosure is drawn a row at a time, sorted in with what stands inside
    // it. As one piece it would sort by its bottom fence and be painted over
    // the top of every tree and animal it holds.
    if (def?.pen) {
      for (let i = 0; i < p.h; i++) add(p.y + i, () => drawPaddock(ctx, sheets, p, i));
      continue;
    }
    add(bottom, () => drawPiece(ctx, sheets, city, p));
  }
  // The townsfolk and their vehicles, sorted in with everything else so one
  // walking behind a lamp is hidden by it. Drawn where they are partway to if
  // they took a step this tick — the same interpolation the farm's animals get.
  for (const m of city.folk || []) {
    const x = (m.px ?? m.x) + (m.x - (m.px ?? m.x)) * alpha;
    const y = (m.py ?? m.y) + (m.y - (m.py ?? m.y)) * alpha;
    if (y < view.y0 - 1 || y > view.y1 + 1 || x < view.x0 - 2 || x > view.x1 + 1) continue;
    add(Math.round(y), () => drawMover(ctx, sheets, m, x, y));
  }
  // And the animals, in the sanctuary: the same sprite the farm draws for
  // each, facing the way it last stepped.
  for (const r of city.residents || []) {
    const x = (r.px ?? r.x) + (r.x - (r.px ?? r.x)) * alpha;
    const y = (r.py ?? r.y) + (r.y - (r.py ?? r.y)) * alpha;
    if (y < view.y0 - 1 || y > view.y1 + 1 || x < view.x0 - 1 || x > view.x1 + 1) continue;
    add(Math.round(y), () => drawResident(ctx, sheets, r, x, y));
  }

  for (const y of [...rows.keys()].sort((a, b) => a - b)) {
    for (const fn of rows.get(y)) fn(ctx, sheets);
  }

  // Lots not bought yet, washed over the way the farm's unbought land is.
  if (city.owned) drawUnowned(ctx, null, view, (x, y) => ownsTile(city, x, y));
}

/** Is this tile road? The autotiler's question, asked of the city. */
export const isCityRoadAt = (city) => (x, y) => cityGroundAt(city, x, y) === CITY_GROUND.ROAD;

function drawCityGround(ctx, sheets, city, view) {
  const road = isCityRoadAt(city);
  for (let y = view.y0; y <= view.y1; y++) {
    for (let x = view.x0; x <= view.x1; x++) {
      const g = cityGroundAt(city, x, y);
      const px = x * TILE;
      const py = y * TILE;
      if (g === CITY_GROUND.ROAD) {
        blitAutotile(ctx, sheets, CITY_ROAD, road, x, y);
      } else if (g === CITY_GROUND.FLOOR) {
        const h = hash2d(x * 3 + 1, y * 5 + 2);
        blit(ctx, sheets, h < 0.1 ? FACTORY.floorHatched : h < 0.2 ? FACTORY.floorChecked : FACTORY.floor, px, py);
      } else if (g === CITY_GROUND.TRAIL) {
        // The farm's own dirt road, with its grassy edges and inside corners.
        blitAutotile(ctx, sheets, DIRT_SET, (ax, ay) => cityGroundAt(city, ax, ay) === CITY_GROUND.TRAIL, x, y);
      } else if (g === CITY_GROUND.WATER) {
        // And its pond: grass underneath, since the bank tiles are part water.
        blit(ctx, sheets, TOWN.grass, px, py);
        blitAutotile(ctx, sheets, WATER, (ax, ay) => cityGroundAt(city, ax, ay) === CITY_GROUND.WATER, x, y);
      } else if (g === CITY_GROUND.PAVEMENT) {
        // A cracked slab now and then, scattered by position so it never moves.
        blit(ctx, sheets, hash2d(x, y) < 0.2 ? CITY.pavementCracked : CITY.pavement, px, py);
      } else {
        const h = hash2d(x, y);
        blit(ctx, sheets, h < 0.08 ? TOWN.grassClump : h < 0.11 ? TOWN.grassFlower : TOWN.grass, px, py);
      }
    }
  }
}

function drawResident(ctx, sheets, r, x, y) {
  const def = animalDef(r.type);
  if (!def) return;
  blit(ctx, sheets, animalSprite(def, variantOf(r)), Math.round(x * TILE), Math.round(y * TILE) - 1, r.facing === 'left');
}

function drawMover(ctx, sheets, m, x, y) {
  const px = Math.round(x * TILE);
  const py = Math.round(y * TILE);
  if (m.kind !== 'car') {
    blit(ctx, sheets, CITY.folk[m.sprite % CITY.folk.length], px, py, m.flip);
    return;
  }
  // A vehicle is 2x2 with its wheels on the tile it stands on. Mirrored as a
  // whole when it last moved left, so its two halves swap sides as well.
  const [tl, tr, bl, br] = CITY.vehicles[m.sprite % CITY.vehicles.length];
  const [l1, r1, l2, r2] = m.flip ? [tr, tl, br, bl] : [tl, tr, bl, br];
  blit(ctx, sheets, l1, px, py - TILE, m.flip);
  blit(ctx, sheets, r1, px + TILE, py - TILE, m.flip);
  blit(ctx, sheets, l2, px, py, m.flip);
  blit(ctx, sheets, r2, px + TILE, py, m.flip);
}

/**
 * What each shop has on its sign: the farm's own picture of what it buys, set
 * on the roof above the door so four brown buildings can be told apart without
 * tapping each one. The pictures are the bag's icons, unchanged.
 */
const SHOP_SIGNS = {
  bakery: SPRITES.itemIcons.wheat,
  grocer: SPRITES.itemIcons.cabbage,
  dairy: SPRITES.goods.milk,
  tailor: SPRITES.goods.wool,
};

/** One piece of street furniture, or a building. */
export function drawPiece(ctx, sheets, city, p) {
  const def = cityDef(p.kind);
  if (!def) return;
  const px = p.x * TILE;
  const py = p.y * TILE;

  if (def.building === 'paddock') { drawPaddock(ctx, sheets, p); return; }
  if (def.building === 'lodge') { drawLodge(ctx, sheets, p); return; }

  if (def.building) {
    const grid = cityBuildingGrid(def.building, p.w, p.h);
    grid.forEach((row, i) => row.forEach((sprite, j) => {
      if (sprite) blit(ctx, sheets, sprite, px + j * TILE, py + i * TILE);
    }));
    const sign = SHOP_SIGNS[p.kind];
    if (sign) blit(ctx, sheets, sign, px + Math.floor((p.w - 1) / 2) * TILE, py);
    return;
  }

  if (def.machine) {
    // Three looks per colour; which one is settled by the piece's id, so a
    // row of mills is not three of the same and none ever changes.
    const looks = FACTORY.machines[LINES[def.machine].colour];
    blit(ctx, sheets, looks[p.id % looks.length], px, py);
    return;
  }

  if (def.line) {
    const set = LINE_SETS[p.kind];
    blit(ctx, sheets, set ? runPiece(city, p.kind, p.x, p.y, set) : fencePiece(city, p.kind, p.x, p.y), px, py);
    return;
  }

  switch (p.kind) {
    case 'bench':
      blit(ctx, sheets, CITY.benchL, px, py);
      blit(ctx, sheets, CITY.benchR, px + TILE, py);
      return;
    case 'busShelter':
      blit(ctx, sheets, CITY.shelterTopL, px, py - TILE);
      blit(ctx, sheets, CITY.shelterTopR, px + TILE, py - TILE);
      blit(ctx, sheets, CITY.shelterL, px, py);
      blit(ctx, sheets, CITY.shelterR, px + TILE, py);
      return;
    case 'planter':
      blit(ctx, sheets, CITY.planterL, px, py);
      blit(ctx, sheets, CITY.planterM, px + TILE, py);
      blit(ctx, sheets, CITY.planterR, px + 2 * TILE, py);
      return;
    case 'drinker':
      blit(ctx, sheets, SPRITES.troughWaterL, px, py);
      blit(ctx, sheets, SPRITES.troughWaterR, px + TILE, py);
      return;
    default: {
      const art = SANCTUARY_ART[p.kind];
      if (art) {
        if (art.top) blit(ctx, sheets, art.top, px, py - TILE);
        blit(ctx, sheets, art.body, px, py);
        return;
      }
      const top = CITY[`${p.kind}Top`] || FACTORY[`${p.kind}Top`];
      if (top) blit(ctx, sheets, top, px, py - TILE);
      const body = CITY[p.kind] || FACTORY[p.kind];
      if (body) blit(ctx, sheets, body, px, py);
    }
  }
}

/**
 * The sanctuary's own pieces, which are the farm's and the town's art under
 * new names: the farm's tree and rocks and hay, the town's pines and well.
 */
const SANCTUARY_ART = {
  oak: { top: SPRITES.treeTop, body: SPRITES.treeMid },
  pine: { top: TOWN.pineTop, body: TOWN.pineBottom },
  maple: { top: TOWN.autumnTop, body: TOWN.autumnBottom },
  shrub: { body: TOWN.bushRound },
  boulder: { body: SPRITES.rockPile },
  hayRack: { body: SPRITES.hayBale },
  signpost: { body: TOWN.signPost },
  wishingWell: { top: TOWN.wellTop, body: TOWN.wellBottom },
};

/**
 * An enclosure: the town sheet's fence, drawn as a ring round its footprint.
 * The sheet has the whole ring — four corners and four edges — so the fence
 * is laid out rather than autotiled, and the grass inside is the map's own.
 */
function drawPaddock(ctx, sheets, p, row = null) {
  const x1 = p.w - 1;
  const y1 = p.h - 1;
  for (let j = 0; j <= x1; j++) {
    for (let i = row ?? 0; i <= (row ?? y1); i++) {
      const edgeX = j === 0 || j === x1;
      const edgeY = i === 0 || i === y1;
      if (!edgeX && !edgeY) continue;
      let sprite;
      if (edgeX && edgeY) {
        sprite = i === 0
          ? (j === 0 ? TOWN.fenceCornerTL : TOWN.fenceCornerTR)
          : (j === 0 ? TOWN.fenceCornerBL : TOWN.fenceCornerBR);
      } else if (edgeY) sprite = i === 0 ? TOWN.fenceEdgeT : TOWN.fenceEdgeB;
      else sprite = j === 0 ? TOWN.fenceEdgeL : TOWN.fenceEdgeR;
      blit(ctx, sheets, sprite, (p.x + j) * TILE, (p.y + i) * TILE);
    }
  }
}

/** The visitor centre: one of the town's houses, roof and all. */
function drawLodge(ctx, sheets, p) {
  const { rows, wall, above } = houseGrid(p.w, p.h, 'tan');
  const px = p.x * TILE;
  rows.forEach((row, i) => row.forEach((sprite, j) => {
    if (sprite) blit(ctx, sheets, sprite, px + j * TILE, (p.y - above + i) * TILE);
  }));
  wall.forEach((row, i) => row.forEach((sprite, j) => {
    if (sprite) blit(ctx, sheets, sprite, px + j * TILE, (p.y + i) * TILE);
  }));
}

/** The factory's runs: belts, pipes and the hazard strip. Fences have their own. */
const LINE_SETS = {
  conveyor: FACTORY.belt,
  conveyorTrim: FACTORY.beltTrim,
  pipe: FACTORY.pipe,
  hazard: FACTORY.hazard,
};

/**
 * Which piece of a run goes here: across if it has a neighbour either side,
 * down if it has one above or below, and the single piece if it is alone.
 */
export function runPiece(city, kind, x, y, set) {
  const same = (nx, ny) => city.pieces.some((p) => p.kind === kind && p.x === nx && p.y === ny);
  const l = same(x - 1, y);
  const r = same(x + 1, y);
  if (l || r) return l && r ? set.mid : l ? set.right : set.left;
  const u = same(x, y - 1);
  const d = same(x, y + 1);
  if (u || d) return u && d ? set.midV : u ? set.bottom : set.top;
  return set.single;
}

/** Draws a piece where it would go, for the placement ghost. */
export function drawPieceGhost(ctx, sheets, city, kind, at) {
  drawPiece(ctx, sheets, city, { kind, x: at.x, y: at.y, w: at.w, h: at.h });
}

/**
 * Is this post line the right-hand wall of something? Followed up and down to
 * where it ends, and asked of the fence it meets there: a wall whose corner
 * turns off to the left is a right wall, and its posts belong at the right
 * edge of the tile, under the right-hand corner's post. A line that meets
 * nothing, or turns right, keeps its posts at the left edge, as before.
 */
function postLineOnRight(same, x, y) {
  let left = false;
  let right = false;
  for (const dy of [-1, 1]) {
    let ty = y;
    // At most a map's height of steps: a post line is never longer.
    for (let i = 0; i < 400 && same(x, ty + dy); i++) {
      ty += dy;
      const l = same(x - 1, ty);
      const r = same(x + 1, ty);
      if (l || r) {
        if (l && !r) right = true;
        if (r && !l) left = true;
        break;
      }
    }
  }
  return right && !left;
}

/**
 * Which fence tile a run takes here, from which neighbours are the same fence.
 * Across is the usual case; a post line runs down; and where a picket fence
 * turns a corner at the top of an enclosure it has the art for it.
 */
export function fencePiece(city, kind, x, y) {
  const same = (nx, ny) => city.pieces.some((p) => p.kind === kind && p.x === nx && p.y === ny);
  const l = same(x - 1, y);
  const r = same(x + 1, y);
  const u = same(x, y - 1);
  const d = same(x, y + 1);
  const picket = kind === 'picketFence';

  if ((u || d) && !l && !r) {
    const right = postLineOnRight(same, x, y);
    if (picket) return right ? CITY.picketVR : CITY.picketV;
    return right ? CITY.chainVR : CITY.chainV;
  }
  if (picket && d && r && !l) return CITY.picketTL;
  if (picket && d && l && !r) return CITY.picketTR;
  if (l && r) return picket ? CITY.picketM : CITY.chainM;
  if (r) return picket ? CITY.picketL : CITY.chainL;
  if (l) return picket ? CITY.picketR : CITY.chainR;
  return picket ? CITY.picketM : CITY.chainM;
}

/** Which art each building draws with. */
const BUILDING_LOOKS = {
  apartments: { roof: 'tan', wall: 'red' },
  shop: { roof: 'slate', wall: 'brown' },
};

const BUILDING_GRIDS = new Map();

/**
 * The tiles of a building of this size, row by row, covering its footprint.
 *
 * Unlike a farmhouse, nothing overhangs: a flat roof seen from above sits
 * inside the walls, so the whole building is its footprint and nothing behind
 * it is hidden. The roof takes the back rows and the walls the front two —
 * three on a deep building, which reads as another storey.
 *
 * Memoised like the barn and the houses: buildings are drawn every frame they
 * are on screen and there are only so many sizes.
 */
export function cityBuildingGrid(type, w, h) {
  const key = `${type}:${w}x${h}`;
  const cached = BUILDING_GRIDS.get(key);
  if (cached) return cached;
  const grid = layOutBuilding(type, w, h);
  BUILDING_GRIDS.set(key, grid);
  return grid;
}

/** How many rows of a building of this depth are wall. */
export function wallRows(h) { return h >= 5 ? 3 : 2; }

function layOutBuilding(type, w, h) {
  const look = BUILDING_LOOKS[type] || BUILDING_LOOKS.apartments;
  const R = CITY_ROOF[look.roof];
  const W = CITY_WALL[look.wall];
  const pick = (j, L, M, Rt) => (j === 0 ? L : j === w - 1 ? Rt : M);

  const walls = Math.min(wallRows(h), h - 1);
  const roofRows = h - walls;
  const rows = [];

  if (roofRows === 1) {
    rows.push(Array.from({ length: w }, (_, j) => pick(j, R.stripL, R.stripM, R.stripR)));
  } else {
    for (let i = 0; i < roofRows; i++) {
      const top = i === 0;
      const bottom = i === roofRows - 1;
      rows.push(Array.from({ length: w }, (_, j) => {
        if (top) return pick(j, R.TL, R.T, R.TR);
        if (bottom) return pick(j, R.BL, R.B, R.BR);
        if (j === 0) return R.L;
        if (j === w - 1) return R.R;
        // A vent or a few specks on a big roof, placed by position so the
        // same building always looks the same.
        const n = hash2d(j * 7 + w, i * 13 + h);
        return n < 0.12 ? R.vent : n < 0.3 ? R.specks : R.C;
      }));
    }
  }

  // Upper storeys: windows every other tile, plain brick between.
  const plain = [W.upperM, W.upperM2, W.upperM3];
  for (let i = 0; i < walls - 1; i++) {
    rows.push(Array.from({ length: w }, (_, j) => {
      if (j === 0) return W.upperL;
      if (j === w - 1) return W.upperR;
      return j % 2 === 1 ? W.window : plain[(j + i) % plain.length];
    }));
  }

  // The ground floor, with its door in the middle: the wide one where the
  // width is even and it can sit dead centre, the single one where it is odd.
  const ground = Array.from({ length: w }, (_, j) => pick(j, W.lowerL, W.lowerM, W.lowerR));
  if (w % 2 === 0 && w >= 4) {
    ground[w / 2 - 1] = W.wideL;
    ground[w / 2] = W.wideR;
  } else {
    ground[Math.floor(w / 2)] = W.door;
  }
  rows.push(ground);
  return rows;
}
