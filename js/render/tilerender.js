// Draws the ground and object layers. Everything here is in world-pixel space;
// the caller has already applied the camera transform.

import { TILE } from '../config.js';
import { GROUND, OBJ, isTilled, isWater } from '../world/tiledefs.js';
import { SPRITES, TOWN, WATER, RIVER, CAPSULES, srcRect, sheetFor } from './sprites.js';
import { mushroomAt } from '../sim/mushrooms.js';
import { hash2d } from '../engine/rng.js';
import { cropStage, isStalled, spoilRemaining, SPOIL_TICKS } from '../sim/crops.js';

/**
 * Picks the capsule piece for a tilled tile from the axis of the row it was
 * ploughed in and whether its neighbours along that same axis belong to a row
 * of the same orientation.
 *
 * Only same-axis neighbours join up, which is the whole point: two horizontal
 * rows stacked vertically stay two separate beds instead of merging into a
 * featureless block.
 */
function tilledPiece(state, x, y) {
  const dir = state.tillDir?.[`${x},${y}`] === 'v' ? 'v' : 'h';

  const joins = (nx, ny) => {
    const g = state.grid.getGround(nx, ny);
    if (!isTilled(g)) return false;
    const nd = state.tillDir?.[`${nx},${ny}`] === 'v' ? 'v' : 'h';
    return nd === dir;
  };

  if (dir === 'h') {
    const l = joins(x - 1, y);
    const r = joins(x + 1, y);
    return l && r ? 'hMid' : l ? 'hRight' : r ? 'hLeft' : 'hSingle';
  }
  const u = joins(x, y - 1);
  const d = joins(x, y + 1);
  return u && d ? 'vMid' : u ? 'vBottom' : d ? 'vTop' : 'vSingle';
}

/**
 * Picks the nine-slice piece for a patch of ground, from which orthogonal
 * neighbours are part of the same patch. Used for dirt, which appears in
 * arbitrary shapes (wherever a tree was felled) rather than tidy rows.
 */
/**
 * Which dirt tile belongs at this cell, given its neighbours. Exported so the
 * autotiling can be tested without a canvas — getting a nine-slice subtly wrong
 * means a farm full of hard square edges, and that's hard to eyeball.
 */
export function dirtPieceAt(state, x, y) {
  return ninePiece(isDirtAt(state), x, y, DIRT_SET);
}

const isDirtAt = (state) => (nx, ny) => state.grid.getGround(nx, ny) === GROUND.DIRT;

/** Water of either kind counts as water, so a river joins a pond seamlessly. */
const isWaterAt = (state) => (nx, ny) => isWater(state.grid.getGround(nx, ny));

export function waterPieceAt(state, x, y) {
  return ninePiece(isWaterAt(state), x, y, WATER);
}

export function waterCornersAt(state, x, y) {
  return concaveCorners(isWaterAt(state), x, y);
}

/** Quadrant of a tile each concave corner occupies, in pixels. */
const QUADRANT = {
  innerTL: [0, 0], innerTR: [TILE / 2, 0],
  innerBL: [0, TILE / 2], innerBR: [TILE / 2, TILE / 2],
};

/**
 * The concave corners this cell needs — the insides of bends.
 *
 * A corner needs a grass wedge when both of its neighbours are dirt but the
 * diagonal between them isn't: the path wraps round an outside bend, and
 * without the wedge the turn draws as solid earth with a square notch of grass
 * sitting in it.
 *
 * Returned as a list and **composited a quarter-tile at a time** rather than
 * picked as a single tile. The sheet's inner-corner tiles are solid earth with
 * one wedge each, so drawing two of them would have the second paint over the
 * first; clipping each to its own quadrant lets all four appear at once. That
 * matters at a crossroads, where every diagonal is grass and picking one tile
 * would leave three corners wrong.
 */
export function dirtCornersAt(state, x, y) {
  return concaveCorners(isDirtAt(state), x, y);
}

function concaveCorners(same, x, y) {
  const n = same(x, y - 1);
  const s = same(x, y + 1);
  const w = same(x - 1, y);
  const e = same(x + 1, y);

  const out = [];
  if (n && w && !same(x - 1, y - 1)) out.push('innerTL');
  if (n && e && !same(x + 1, y - 1)) out.push('innerTR');
  if (s && w && !same(x - 1, y + 1)) out.push('innerBL');
  if (s && e && !same(x + 1, y + 1)) out.push('innerBR');
  return out;
}

/** Draws one inner corner, clipped to its own quarter of the tile. */
function blitCorner(ctx, sheets, set, corner, px, py) {
  const [qx, qy] = QUADRANT[corner];
  ctx.save();
  ctx.beginPath();
  ctx.rect(px + qx, py + qy, TILE / 2, TILE / 2);
  ctx.clip();
  blit(ctx, sheets, set[corner], px, py);
  ctx.restore();
}

/**
 * Which river piece belongs here, from the water it touches.
 *
 * A river is a one-tile-wide path, so it's the *connections* that decide the
 * tile, not an area fill: two opposite neighbours make a straight, two
 * adjacent ones a bend. Three or more is a confluence the sheet has no tile
 * for, and neither has a lone tile with none — both become open water, which
 * reads as a pool where the channels meet.
 *
 * @returns {{sprite: number[], turns: number}} turns are quarter turns clockwise
 */
export function riverPieceAt(state, x, y) {
  const same = isWaterAt(state);
  const n = same(x, y - 1);
  const s = same(x, y + 1);
  const w = same(x - 1, y);
  const e = same(x + 1, y);
  const count = n + s + w + e;

  if (count >= 3 || count === 0) return { sprite: RIVER.pool, turns: 0 };

  if (n && s) return { sprite: RIVER.straight, turns: 0 };
  if (w && e) return { sprite: RIVER.straight, turns: 1 };

  if (n && e) return { sprite: RIVER.NE, turns: 0 };
  if (n && w) return { sprite: RIVER.NW, turns: 0 };
  if (s && e) return { sprite: RIVER.SE, turns: 0 };
  if (s && w) return { sprite: RIVER.SW, turns: 0 };

  // A dead end: draw it as a straight running the way it points, so the
  // channel looks like it carries on rather than stopping in mid-air.
  return { sprite: RIVER.straight, turns: (w || e) ? 1 : 0 };
}

/**
 * Picks the tile for one cell of an autotiled area: straight edges and the
 * convex corners. Concave corners are composited on top — see dirtCornersAt.
 */
function ninePiece(same, x, y, set) {
  const n = same(x, y - 1);
  const s = same(x, y + 1);
  const w = same(x - 1, y);
  const e = same(x + 1, y);

  if (n && s && w && e) return set.C;
  if (!n && s && e && !w) return set.TL;
  if (!n && s && w && !e) return set.TR;
  if (n && !s && e && !w) return set.BL;
  if (n && !s && w && !e) return set.BR;
  if (!n && s) return set.T;
  if (n && !s) return set.B;
  if (!w && e) return set.L;
  if (w && !e) return set.R;
  return set.C;
}

const DIRT_SET = {
  TL: TOWN.dirtTL, T: TOWN.dirtT, TR: TOWN.dirtTR,
  L: TOWN.dirtL, C: TOWN.dirtC, R: TOWN.dirtR,
  BL: TOWN.dirtBL, B: TOWN.dirtB, BR: TOWN.dirtBR,
  // Concave corners, named for where the grass sits in them.
  innerTL: TOWN.dirtInnerTL, innerTR: TOWN.dirtInnerTR,
  innerBL: TOWN.dirtInnerBL, innerBR: TOWN.dirtInnerBR,
};

/** Ground layer: real grass and dirt tiles, tilled beds, and paving. */
export function drawGround(ctx, sheets, state, view) {
  const grid = state.grid;

  for (let y = view.y0; y <= view.y1; y++) {
    for (let x = view.x0; x <= view.x1; x++) {
      const g = grid.getGround(x, y);
      if (g === GROUND.GRASS) {
        // The town sheet has a real grass tile plus two decorated variants.
        // Scattering them deterministically keeps open fields from reading as
        // one flat slab, without the procedural blades we used to fake.
        const h = hash2d(x, y);
        const tile = h < 0.08 ? TOWN.grassClump : h < 0.11 ? TOWN.grassFlower : TOWN.grass;
        blit(ctx, sheets, tile, x * TILE, y * TILE);
      } else if (isTilled(g)) {
        // The capsule art has its grass background knocked out, so whatever the
        // bed was ploughed from still shows around its rounded ends.
        // Beds sit on whatever the ground was, so paint grass underneath first.
        blit(ctx, sheets, TOWN.grass, x * TILE, y * TILE);
        const set = CAPSULES[g === GROUND.TILLED_WET ? 'wet' : 'dry'];
        const piece = set?.[tilledPiece(state, x, y)];
        if (piece) ctx.drawImage(piece, x * TILE, y * TILE);
      } else if (g === GROUND.ROAD) {
        blit(ctx, sheets, TOWN.paved, x * TILE, y * TILE);
      } else if (g === GROUND.WATER) {
        // Grass underneath: the pond's edge tiles are part water, part bank.
        blit(ctx, sheets, TOWN.grass, x * TILE, y * TILE);
        blit(ctx, sheets, waterPieceAt(state, x, y), x * TILE, y * TILE);
        for (const corner of waterCornersAt(state, x, y)) {
          blitCorner(ctx, sheets, WATER, corner, x * TILE, y * TILE);
        }
      } else if (g === GROUND.RIVER) {
        blit(ctx, sheets, TOWN.grass, x * TILE, y * TILE);
        const { sprite, turns } = riverPieceAt(state, x, y);
        blitTurned(ctx, sheets, sprite, x * TILE, y * TILE, turns);
      } else {
        // Bare earth: the barn yard, and any dirt road the player has laid.
        // Autotiled so a run of it gets a proper grassy boundary — edges,
        // corners and the insides of bends — instead of hard square edges.
        blit(ctx, sheets, dirtPieceAt(state, x, y), x * TILE, y * TILE);
        for (const corner of dirtCornersAt(state, x, y)) {
          blitCorner(ctx, sheets, DIRT_SET, corner, x * TILE, y * TILE);
        }
      }
    }
  }
}

/**
 * Planted tiles. Drawn between ground and objects so a tree still overlaps a
 * crop in front of it.
 */
export function drawCrops(ctx, sheets, state, view) {
  for (const [key, crop] of Object.entries(state.crops)) {
    const comma = key.indexOf(',');
    const x = +key.slice(0, comma);
    const y = +key.slice(comma + 1);
    if (x < view.x0 || x > view.x1 || y < view.y0 || y > view.y1) continue;

    const px = x * TILE;
    const py = y * TILE;

    if (crop.dead) {
      const dead = SPRITES.cropDead[crop.type];
      if (dead) blit(ctx, sheets, dead, px, py);
      continue;
    }

    const stages = SPRITES.cropStages[crop.type];
    if (!stages) continue;
    blit(ctx, sheets, stages[cropStage(crop)], px, py);

    // Two things the player needs to see without tapping every tile: seeds that
    // haven't been watered (and so aren't growing at all), and ripe crops
    // running out of time before they spoil.
    if (isStalled(crop)) {
      drawMark(ctx, px, py, '#4aa3e0');
    } else {
      const left = spoilRemaining(state, crop);
      if (left !== null && left < SPOIL_TICKS / 4) drawMark(ctx, px, py, '#e5533d');
    }
  }
}

function drawMark(ctx, px, py, color) {
  ctx.fillStyle = color;
  ctx.fillRect(px + TILE - 5, py + 1, 3, 3);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(px + TILE - 5, py + 1, 1, 1);
}

/**
 * Object layer, drawn top row to bottom row so that sprites taller than one
 * tile are correctly overlapped by whatever stands in front of them.
 */
export function drawObjects(ctx, sheets, state, view, entityRows = null) {
  const grid = state.grid;
  const drawn = new Set();

  for (let y = view.y0; y <= view.y1; y++) {
    for (let x = view.x0; x <= view.x1; x++) {
      const o = grid.getObject(x, y);
      // Building footprints are drawn whole, from the building record.
      if (o === OBJ.NONE || o === OBJ.BUILDING) continue;
      drawObject(ctx, sheets, state, o, x, y);
    }
    // Draw each building as its bottom row comes up, so it sorts against other
    // objects the same way a tall sprite does: things lower on screen overlap it.
    drawBuildingsEndingAt(ctx, sheets, state, y);

    // Then anything standing on this row. Drawing movers here rather than in a
    // pass of their own is what stops the farmer walking across the barn roof:
    // on a roof-overhang row he is drawn before the barn and ends up behind it.
    if (entityRows?.has(y)) {
      for (const draw of entityRows.get(y)) draw(ctx, sheets);
      drawn.add(y);
    }
  }

  // Movers just outside the drawn rows still need painting or they'd blink out
  // at the screen edge.
  if (entityRows) {
    for (const [y, list] of entityRows) {
      if (drawn.has(y)) continue;
      for (const draw of list) draw(ctx, sheets);
    }
  }

  drawTroughs(ctx, sheets, state, view);
}

/**
 * A barn is three tiles wide and five tall: three roof rows overhanging above
 * two body rows. Only the body sits on the ground, so the roof can hang over
 * tiles the farmer walks through.
 */
/**
 * Washes over land the player hasn't bought.
 *
 * Drawn last, over the scenery rather than under it, so the trees out there
 * dim too — the boundary has to read as "not yours yet" at a glance, and
 * dimming only the grass under a bright tree doesn't say that. The wash is
 * deliberately gentle: it's an invitation, not a wall.
 */
export function drawUnowned(ctx, state, view) {
  const { grid } = state;
  ctx.save();
  ctx.fillStyle = 'rgba(24, 38, 20, 0.42)';
  for (let y = view.y0; y <= view.y1; y++) {
    // Runs of unowned tiles are filled in one rect per row, which at 40 tiles
    // wide is a handful of fills instead of hundreds.
    let runStart = -1;
    for (let x = view.x0; x <= view.x1 + 1; x++) {
      const unowned = x <= view.x1 && !grid.isOwned(x, y);
      if (unowned && runStart < 0) runStart = x;
      if (!unowned && runStart >= 0) {
        ctx.fillRect(runStart * TILE, y * TILE, (x - runStart) * TILE, TILE);
        runStart = -1;
      }
    }
  }
  ctx.restore();
}

export function drawBuilding(ctx, sheets, building) {
  const px = building.x * TILE;
  const roofRows = SPRITES.barnRoofRows;
  const bodyRows = SPRITES.barnBodyRows;

  // The body's top row is the anchor; the roof stacks upward from there.
  roofRows.forEach((row, i) => {
    const y = (building.y - roofRows.length + i) * TILE;
    for (let c = 0; c < 3; c++) blit(ctx, sheets, [SPRITES.barnRoofCol0 + c, row], px + c * TILE, y);
  });
  bodyRows.forEach((row, i) => {
    const y = (building.y + i) * TILE;
    for (let c = 0; c < 3; c++) blit(ctx, sheets, [SPRITES.barnBodyCol0 + c, row], px + c * TILE, y);
  });
}

function drawBuildingsEndingAt(ctx, sheets, state, y) {
  for (const b of state.buildings || []) {
    if (b.y + 1 === y) drawBuilding(ctx, sheets, b);   // body is two rows tall
  }
}

/**
 * Troughs occupy two tiles and are drawn from their anchor (the left tile), so
 * the halves always line up. Their fill level picks the empty or full sprite.
 */
function drawTroughs(ctx, sheets, state, view) {
  for (const [key, trough] of Object.entries(state.troughs || {})) {
    const comma = key.indexOf(',');
    const x = +key.slice(0, comma);
    const y = +key.slice(comma + 1);
    if (y < view.y0 || y > view.y1 || x + 1 < view.x0 || x > view.x1) continue;

    const full = (trough.level || 0) > 0;
    const pair = trough.kind === 'water'
      ? (full ? [SPRITES.troughWaterL, SPRITES.troughWaterR] : [SPRITES.troughWoodEmptyL, SPRITES.troughWoodEmptyR])
      : (full ? [SPRITES.troughFoodL, SPRITES.troughFoodR] : [SPRITES.troughMetalEmptyL, SPRITES.troughMetalEmptyR]);

    blit(ctx, sheets, pair[0], x * TILE, y * TILE);
    blit(ctx, sheets, pair[1], (x + 1) * TILE, y * TILE);
  }
}

/**
 * Picks a fence piece from its neighbours. The town sheet has a complete set —
 * straight runs with end posts, and four corners — so a fenced pen turns its
 * corners properly instead of butting two straight rails together.
 */
function fencePiece(state, x, y) {
  const joins = (nx, ny) => {
    const o = state.grid.getObject(nx, ny);
    return o === OBJ.FENCE || o === OBJ.GATE;
  };
  const n = joins(x, y - 1);
  const s = joins(x, y + 1);
  const w = joins(x - 1, y);
  const e = joins(x + 1, y);

  // Corners first: two perpendicular neighbours.
  if (s && e && !n && !w) return TOWN.fenceCornerTL;
  if (s && w && !n && !e) return TOWN.fenceCornerTR;
  if (n && e && !s && !w) return TOWN.fenceCornerBL;
  if (n && w && !s && !e) return TOWN.fenceCornerBR;

  // Straight runs.
  if (w && e) return TOWN.fenceHMid;
  if (n && s) return TOWN.fenceVMid;

  // Ends of a run get a post on the open side.
  if (e) return TOWN.fenceHLeft;
  if (w) return TOWN.fenceHRight;
  if (s) return TOWN.fenceVTop;
  if (n) return TOWN.fenceVBottom;

  // A T-junction or crossroads has no dedicated art; a straight rail reads
  // better there than a corner would. Isolated posts land here too.
  return TOWN.fenceHMid;
}

function drawObject(ctx, sheets, state, objId, x, y) {
  const px = x * TILE;
  const py = y * TILE;

  switch (objId) {
    case OBJ.TREE: {
      // The town sheet has fuller trees in two colours; mixing them
      // deterministically stops a wood reading as one cloned trunk repeated.
      const autumn = hash2d(x, y) < 0.28;
      blit(ctx, sheets, autumn ? TOWN.autumnTop : TOWN.pineTop, px, py - TILE);
      blit(ctx, sheets, autumn ? TOWN.autumnBottom : TOWN.pineBottom, px, py);
      break;
    }
    case OBJ.DEAD_TREE:
      blit(ctx, sheets, SPRITES.deadTreeTop, px, py - TILE);
      blit(ctx, sheets, SPRITES.deadTreeBottom, px, py);
      break;
    case OBJ.ROCK:
      blit(ctx, sheets, hash2d(x, y) < 0.5 ? SPRITES.rockSmall : SPRITES.rockPile, px, py);
      break;
    case OBJ.WEED:
      blit(ctx, sheets, hash2d(x, y) < 0.5 ? SPRITES.grassTuft : SPRITES.seedling, px, py);
      break;
    case OBJ.BUSH:
      blit(ctx, sheets, hash2d(x, y) < 0.5 ? TOWN.bushRound : SPRITES.leafyBush, px, py);
      break;
    case OBJ.STUMP:
      blit(ctx, sheets, SPRITES.stump, px, py);
      break;
    case OBJ.FENCE:
      blit(ctx, sheets, fencePiece(state, x, y), px, py);
      break;
    case OBJ.GATE:
      // Drawing nothing while the farmer stands here reads as the gate swung
      // open for them — neither sheet has an open-gate sprite, and none is
      // needed. Closed, a gate is the fence rail it continues, plus a pale
      // latch post so the player can find the way in at a glance.
      if (!(state.farmer.x === x && state.farmer.y === y)) {
        blit(ctx, sheets, fencePiece(state, x, y), px, py);
        ctx.fillStyle = '#fec99c';
        ctx.fillRect(px + 6, py + 6, 4, 5);
        ctx.fillStyle = '#8a5a3b';
        ctx.fillRect(px + 7, py + 8, 2, 1);
      }
      break;
    case OBJ.TROUGH_WATER:
    case OBJ.TROUGH_FOOD:
      break;   // troughs are two tiles wide; drawn from their anchors instead
    case OBJ.BARREL:
      blit(ctx, sheets, SPRITES.barrel, px, py);
      break;
    case OBJ.EGG:
      blit(ctx, sheets, SPRITES.egg, px, py);
      break;
    case OBJ.MUSHROOM: {
      // Which one grew here is state, not a hash of the tile — a mushroom is a
      // find, and it has to still be the same find after a reload.
      const m = mushroomAt(state, x, y);
      if (m) blit(ctx, sheets, [m.sprite, 0, 'shrooms'], px, py);
      break;
    }
    default:
      break;
  }
}

/**
 * Draws one sprite. `sheets` is the {farm, town} pair; the sprite reference
 * carries which of them it lives on.
 */
/**
 * Like blit, but turned a quarter turn at a time about the tile's centre. The
 * sheet has a north-south river channel and no east-west one, and a quarter
 * turn is a better answer than asking for more art.
 */
export function blitTurned(ctx, sheets, sprite, dx, dy, turns = 0) {
  if (!turns) { blit(ctx, sheets, sprite, dx, dy); return; }
  const { sx, sy, sw, sh } = srcRect(sprite);
  ctx.save();
  ctx.translate(dx + sw / 2, dy + sh / 2);
  ctx.rotate((Math.PI / 2) * turns);
  ctx.drawImage(sheetFor(sheets, sprite), sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
  ctx.restore();
}

export function blit(ctx, sheets, sprite, dx, dy, flip = false) {
  const { sx, sy, sw, sh } = srcRect(sprite);
  const img = sheetFor(sheets, sprite);

  if (!flip) {
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, sw, sh);
    return;
  }
  // Mirrored horizontally. Every character on the sheet is drawn facing right,
  // so this is how anything walking left is turned round.
  ctx.save();
  ctx.translate(dx + sw, dy);
  ctx.scale(-1, 1);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.restore();
}
