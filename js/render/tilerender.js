// Draws the ground and object layers. Everything here is in world-pixel space;
// the caller has already applied the camera transform.

import { TILE } from '../config.js';

/** Half a tile: autotiling works a quarter of a tile at a time. */
const HALF = TILE / 2;
import { GROUND, OBJ, isTilled, isWater } from '../world/tiledefs.js';
import { SPRITES, TOWN, WATER, RIVER, BARN, CAPSULES, srcRect, sheetFor } from './sprites.js';
import { mushroomAt } from '../sim/mushrooms.js';
import { flowerAt, isWatered } from '../sim/flowers.js';
import { flowerCanvas } from './flowerart.js';
import { pendingGroundTiles } from '../sim/build.js';
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
 * Which piece each quarter of an autotiled cell should be cut from.
 *
 * Choosing one tile per *tile* cannot work: a 13-piece set has no answer for
 * "grass on three sides", which is what every one-tile-wide arm and every
 * half-dug pond is made of. The nine-slice would fall back to a straight edge
 * and leave two sides of the tile as open water butting into grass.
 *
 * Choosing one piece per *quarter* has an answer for every arrangement, from
 * the same 13 pieces. Each quadrant looks at the three neighbours that touch
 * it — two sides and the diagonal between them — and takes its 8x8 corner from
 * whichever piece already draws that situation:
 *
 *   both sides grass        the outer corner
 *   one side grass          that edge
 *   both sides water,       the concave corner (the inside of a bend)
 *     diagonal grass
 *   all three water         plain interior
 *
 * @returns {{tl: string, tr: string, bl: string, br: string}} keys into a set
 */
export function autotileQuadrants(same, x, y) {
  const n = same(x, y - 1);
  const s = same(x, y + 1);
  const w = same(x - 1, y);
  const e = same(x + 1, y);

  const pick = (a, b, diagonal, corner, edgeA, edgeB, inner) => {
    if (!a && !b) return corner;
    if (!a) return edgeA;
    if (!b) return edgeB;
    return diagonal ? 'C' : inner;
  };

  return {
    tl: pick(n, w, same(x - 1, y - 1), 'TL', 'T', 'L', 'innerTL'),
    tr: pick(n, e, same(x + 1, y - 1), 'TR', 'T', 'R', 'innerTR'),
    bl: pick(s, w, same(x - 1, y + 1), 'BL', 'B', 'L', 'innerBL'),
    br: pick(s, e, same(x + 1, y + 1), 'BR', 'B', 'R', 'innerBR'),
  };
}

/** Quarter-tile offsets, in the order autotileQuadrants reports them. */
const QUADS = { tl: [0, 0], tr: [HALF, 0], bl: [0, HALF], br: [HALF, HALF] };

/**
 * Draws one autotiled cell as four quarters.
 *
 * Each quarter is the *same* quarter of its chosen piece, so the art lines up
 * with itself — the top-left 8x8 of the top-left corner piece really is a
 * top-left corner. Source sub-rects rather than clipping: four drawImage calls
 * with no canvas state changes at all.
 */
export function blitAutotile(ctx, sheets, set, same, x, y) {
  const quads = autotileQuadrants(same, x, y);
  const px = x * TILE;
  const py = y * TILE;

  for (const [corner, key] of Object.entries(quads)) {
    const sprite = set[key] || set.C;
    const { sx, sy } = srcRect(sprite);
    const [qx, qy] = QUADS[corner];
    ctx.drawImage(sheetFor(sheets, sprite),
      sx + qx, sy + qy, HALF, HALF,
      px + qx, py + qy, HALF, HALF);
  }
}

export const isDirtAt = (state, planned = null) => (nx, ny) => (
  state.grid.getGround(nx, ny) === GROUND.DIRT || !!planned?.has(`${nx},${ny}`)
);

/** Water of either kind counts as water, so a river joins a pond seamlessly. */
export const isWaterAt = (state, planned = null) => (nx, ny) => (
  isWater(state.grid.getGround(nx, ny)) || !!planned?.has(`${nx},${ny}`)
);

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
export function riverPieceAt(state, x, y, same = isWaterAt(state)) {
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

  // Ground the farmer has been told to lay but hasn't reached yet. Counting it
  // in while autotiling means a pond or a path has the outline of the shape
  // it's going to be from the moment it's ordered, rather than every
  // unfinished tile leaving a bitten edge behind.
  const planned = pendingGroundTiles(state);
  const plannedWater = new Set();
  const plannedDirt = new Set();
  for (const [key, ground] of planned) {
    if (isWater(ground)) plannedWater.add(key);
    else if (ground === GROUND.DIRT) plannedDirt.add(key);
  }

  const near = {
    water: isWaterAt(state, plannedWater),
    dirt: isDirtAt(state, plannedDirt),
  };

  for (let y = view.y0; y <= view.y1; y++) {
    for (let x = view.x0; x <= view.x1; x++) {
      const g = grid.getGround(x, y);
      paintGround(ctx, sheets, state, g, x, y, near);

      // Then, over the top, whatever is on its way here — faint enough to read
      // as a plan rather than as ground that is already down.
      const coming = planned.get(`${x},${y}`);
      if (coming != null && coming !== g) {
        ctx.save();
        ctx.globalAlpha = 0.45;
        paintGround(ctx, sheets, state, coming, x, y, near);
        ctx.restore();
      }
    }
  }
}

/**
 * Paints one tile of ground. Shared by the real ground and the faint preview
 * of ground that is only ordered so far, so the two can never drift apart.
 */
function paintGround(ctx, sheets, state, g, x, y, near) {
  const px = x * TILE;
  const py = y * TILE;

  if (g === GROUND.GRASS) {
    // The town sheet has a real grass tile plus two decorated variants.
    // Scattering them deterministically keeps open fields from reading as one
    // flat slab, without the procedural blades we used to fake.
    const h = hash2d(x, y);
    blit(ctx, sheets, h < 0.08 ? TOWN.grassClump : h < 0.11 ? TOWN.grassFlower : TOWN.grass, px, py);
    return;
  }

  if (isTilled(g)) {
    // The capsule art has its grass background knocked out, so whatever the
    // bed was ploughed from still shows around its rounded ends.
    blit(ctx, sheets, TOWN.grass, px, py);
    const set = CAPSULES[g === GROUND.TILLED_WET ? 'wet' : 'dry'];
    const piece = set?.[tilledPiece(state, x, y)];
    if (piece) ctx.drawImage(piece, px, py);
    return;
  }

  if (g === GROUND.ROAD) {
    blit(ctx, sheets, TOWN.paved, px, py);
    return;
  }

  if (g === GROUND.WATER) {
    // Grass underneath: the pond's edge tiles are part water, part bank.
    blit(ctx, sheets, TOWN.grass, px, py);
    blitAutotile(ctx, sheets, WATER, near.water, x, y);
    return;
  }

  if (g === GROUND.RIVER) {
    blit(ctx, sheets, TOWN.grass, px, py);
    const { sprite, turns } = riverPieceAt(state, x, y, near.water);
    blitTurned(ctx, sheets, sprite, px, py, turns);
    return;
  }

  // Bare earth: the barn yard, and any dirt road the player has laid.
  // Autotiled so a run of it gets a proper grassy boundary — edges, corners
  // and the insides of bends — instead of hard square edges.
  blitAutotile(ctx, sheets, DIRT_SET, near.dirt, x, y);
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

/**
 * Lays out a barn of any size as a grid of sprites, top-left first.
 *
 * Split out from the drawing so it can be checked without a canvas, and
 * because the shape is the interesting part. Returns rows of sprite references
 * (or null for a gap), and `above`: how many rows sit outside the footprint.
 *
 * The roof is a flat top with its corners cut at 45 degrees. Each step out
 * drops one row, and the innermost step shares a row with the flat top, so the
 * outline never breaks. Because the corner is the only thing that grows with
 * width, the roof stays the same height however wide the barn is — a gable
 * would climb a row per tile and hang five rows up over a nine-wide barn.
 */
export function barnGrid(w, h) {
  const key = `${w}x${h}`;
  const cached = BARN_GRIDS.get(key);
  if (cached) return cached;

  const grid = layOutBarn(w, h);
  BARN_GRIDS.set(key, grid);
  return grid;
}

/**
 * Barns are drawn every frame they are on screen and there are only a handful
 * of legal sizes, so the layout is worked out once and kept. This is the same
 * frugality the rest of the renderer runs on — the phone this is played on ran
 * hot once already.
 */
const BARN_GRIDS = new Map();

function layOutBarn(w, h) {
  const mid = (w - 1) / 2;
  // Cut the corner more deeply on a wider barn, but always leave three tiles
  // of flat top: any less and a narrow barn becomes a spike over its own ridge.
  const cut = Math.max(1, Math.min(Math.floor((w - 3) / 2), Math.floor(w / 4)));
  // Corner rows, then the near edge. Nothing else: the whole point of this
  // shape is that the roof stays low, and every extra row of it is another row
  // of farm hidden behind the barn. That was the complaint that started this.
  const roofRows = cut + 1;

  const rows = [];
  for (let r = 0; r < roofRows; r++) rows.push(new Array(w).fill(null));

  for (let col = 0; col < w; col++) {
    const fromEdge = Math.min(col, w - 1 - col);
    const outer = col === 0 || col === w - 1;
    const opens = fromEdge < cut ? cut - 1 - fromEdge : 0;
    for (let r = opens; r <= roofRows - 2; r++) {
      if (r === opens) {
        rows[r][col] = fromEdge < cut ? (col < mid ? BARN.slopeL : BARN.slopeR)
          : col === mid ? BARN.topRidge : (col < mid ? BARN.topD : BARN.topL);
      } else if (col === mid) {
        rows[r][col] = BARN.ridge;
      } else {
        rows[r][col] = outer ? (col < mid ? BARN.planeL : BARN.planeR)
          : (col < mid ? BARN.fillD : BARN.fillL);
      }
    }
  }

  // The roof's near edge runs straight across: there is no gable here to end,
  // so nothing pokes down over the wall.
  const last = roofRows - 1;
  for (let col = 0; col < w; col++) {
    rows[last][col] = col < mid ? BARN.botD : col > mid ? BARN.botL : BARN.botRidge;
  }
  rows[last][0] = BARN.edgeL;
  rows[last][w - 1] = BARN.edgeR;

  // Wall. Its top row shares the roof's last row: the eave corners flare out
  // beside it, and the braced upper storey shows between them.
  const wall = [];
  wall.push(rowOf(w, BARN.braceL, BARN.braceM, BARN.braceR));
  for (let i = 0; i < h - 2; i++) wall.push(rowOf(w, BARN.plankL, BARN.plankM, BARN.plankR));
  if (h >= 2) wall.push(doorRow(w));
  const body = wall.slice(-h);

  // The eaves overhang the wall's top row rather than sitting above it.
  body[0] = body[0].slice();
  const eaves = new Array(w).fill(null);
  eaves[0] = BARN.eaveL;
  eaves[w - 1] = BARN.eaveR;

  return { rows: rows.concat([eaves]), wall: body, above: roofRows };
}

const rowOf = (w, l, m, r) =>
  Array.from({ length: w }, (_, i) => (i === 0 ? l : i === w - 1 ? r : m));

/**
 * The ground floor: doors set one tile in from each end, the ends themselves
 * framed wall. Kenney's door tiles carry a frame on one side, which is why the
 * doors used to sit at the corners — a barn wide enough to need two doors made
 * that look like an accident rather than a choice.
 */
function doorRow(w) {
  const wall = rowOf(w, BARN.wallL, BARN.wallM, BARN.wallR);
  for (let i = 1; i < w - 1; i += 4) wall[i] = BARN.door;
  return wall;
}

/**
 * Draws a barn. `building` needs x, y and (for anything but the smallest) w, h.
 *
 * Only the wall stands on the ground; the roof hangs above it over tiles the
 * farmer still walks through, the way a tree canopy does.
 */
export function drawBuilding(ctx, sheets, building) {
  const [w, h] = building.w > 0 ? [building.w, building.h] : [3, 2];
  const { rows, wall, above } = barnGrid(w, h);
  const px = building.x * TILE;

  rows.forEach((row, i) => row.forEach((sprite, j) => {
    if (sprite) blit(ctx, sheets, sprite, px + j * TILE, (building.y - above + i) * TILE);
  }));
  wall.forEach((row, i) => row.forEach((sprite, j) => {
    if (sprite) blit(ctx, sheets, sprite, px + j * TILE, (building.y + i) * TILE);
  }));
}

function drawBuildingsEndingAt(ctx, sheets, state, y) {
  for (const b of state.buildings || []) {
    const h = b.h > 0 ? b.h : 2;
    if (b.y + h - 1 === y) drawBuilding(ctx, sheets, b);   // sorts on its last row
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

/**
 * One object drawn at a tile, for the placement ghost. Goes through the same
 * code the world does, so what you're shown is what you'll get — including the
 * tall sprites that overhang the tile above.
 */
export function drawObjectSprite(ctx, sheets, state, objId, at) {
  drawObject(ctx, sheets, state, objId, at.x, at.y);
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
    case OBJ.FLOWER: {
      // A watered flower is the one that will cross with its neighbours, so it
      // has to be possible to tell at a glance which ones are damp — otherwise
      // the player's only control over breeding is invisible. Grass has no wet
      // version the way soil does, so the ground under it is simply darkened.
      if (isWatered(state, x, y)) {
        ctx.fillStyle = 'rgba(46, 86, 140, 0.22)';
        ctx.fillRect(px, py + 4, TILE, TILE - 4);
      }

      // Drawn from its own recoloured canvas rather than from a sheet — see
      // render/flowerart.js. By the time it reaches here it is an ordinary
      // image, and this is an ordinary blit.
      const f = flowerAt(state, x, y);
      const art = f && flowerCanvas(f.kind, f.genome);
      if (art) ctx.drawImage(art, px, py);
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
