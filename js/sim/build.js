// Construction: what can be built, what it costs, and where it may go.
//
// Materials are checked when work is *queued* (against everything already
// queued, so you can't order ten fences with wood for two) but only spent when
// the farmer actually finishes the job. That way cancelling a build never costs
// the player anything, which matches how planting handles seeds.
//
// The ground a queued build stands on is reserved the same way, and for the
// same reason. A barn takes two minutes to raise; if a mushroom could sprout
// or a second build could be queued inside its footprint in the meantime, the
// only ways out are to cancel the barn or to pave over whatever arrived. Both
// are worse than simply not letting anything take the site in the first place.

import { OBJ, GROUND, isTilled, isWater, objDef } from '../world/tiledefs.js';
import { countItem, removeItem, itemName } from './inventory.js';
import { cropAt } from './crops.js';
import { emitUnlessSuspended } from '../engine/events.js';

/**
 * size is [width, height] in tiles. Troughs are the first two-tile structures
 * in the game; their anchor is the left-hand tile.
 */
export const BUILDABLES = {
  fence: {
    name: 'Fence', obj: OBJ.FENCE, cost: { wood: 2 }, work: 6, size: [1, 1],
    hint: 'Keeps animals in',
  },
  gate: {
    name: 'Gate', obj: OBJ.GATE, cost: { wood: 4 }, work: 8, size: [1, 1],
    hint: 'The farmer walks through; animals cannot',
  },
  road: {
    name: 'Stone road', ground: GROUND.ROAD, cost: { stone: 1 }, work: 5, size: [1, 1],
    hint: 'Tidy paths across the farm',
  },
  // Trodden earth rather than a built surface, so it costs nothing but the
  // walking — the price is the farmer's time. It autotiles with proper grass
  // edges, inside corners and all, which is what makes a run of it read as a
  // path rather than a row of brown squares.
  dirtRoad: {
    name: 'Dirt road', ground: GROUND.DIRT, cost: {}, work: 4, size: [1, 1],
    hint: 'Worn earth, free to lay',
  },
  // Water is dug, not bought, so both cost only the farmer's time — but a good
  // deal more of it than a path. Both block movement, so they double as
  // scenery you can shape a farm around.
  pond: {
    name: 'Pond', ground: GROUND.WATER, cost: {}, work: 20, size: [1, 1],
    hint: 'Still water — dig any shape',
  },
  river: {
    name: 'River', ground: GROUND.RIVER, cost: {}, work: 14, size: [1, 1],
    hint: 'Flowing water — one tile wide, bends as you lay it',
  },
  waterTrough: {
    name: 'Water trough', obj: OBJ.TROUGH_WATER, cost: { wood: 8 }, work: 14,
    size: [2, 1], trough: 'water', hint: 'Two tiles wide',
  },
  feedTrough: {
    name: 'Feed trough', obj: OBJ.TROUGH_FOOD, cost: { wood: 8 }, work: 14,
    size: [2, 1], trough: 'food', hint: 'Two tiles wide',
  },
  barn: {
    name: 'Barn', obj: OBJ.BUILDING, cost: barnCost(3, 2), work: barnWork(3, 2),
    // Footprint is the ground it stands on; the roof draws two rows higher,
    // overhanging tiles the farmer can still walk through (as trees do).
    // A barn is the one buildable the player sizes themselves — `size` here is
    // the smallest one, and BARN_LIMITS says how far it can be stretched.
    size: [3, 2], building: 'barn', sizable: true,
    hint: 'Houses animals — drag out its corners',
  },
};

/**
 * How big a barn may be.
 *
 * Width is odd because the roof's ridge board runs up a centre column, and an
 * even width would leave it half a tile off centre. Depth is free. The upper
 * bounds are taste rather than technique: a 9x5 is already an enormous thing to
 * put on a farm, and the art keeps working past it.
 */
export const BARN_LIMITS = { minW: 3, maxW: 9, minH: 2, maxH: 5, oddWidth: true };

/**
 * What a barn of this size costs, and what it can do.
 *
 * A flat base plus a rate per tile, chosen so the smallest barn comes out at
 * exactly what a barn has always cost — the balance is settled and this feature
 * has no business disturbing it. The base is the doors, the frame and the
 * raising; the rate is materials. Bigger barns therefore come out slightly
 * cheaper per tile, which is the right way round: committing to one big barn
 * should beat dotting small ones about.
 */
export function barnCost(w, h) {
  const tiles = w * h;
  return { wood: 26 + 4 * tiles, stone: 8 + 2 * tiles };
}

export function barnWork(w, h) { return 60 + 10 * w * h; }

/** Two tiles of floor to an animal, rounded down. A 3x2 holds four. */
export function barnCapacity(w, h) { return Math.floor((w * h * 2) / 3); }

/** How many animals live in a finished barn. */
export function BARN_CAPACITY_OF(b) { return barnCapacity(sizeOf(b)[0], sizeOf(b)[1]); }

/** The smallest barn's capacity, which several older callers still assume. */
export const BARN_CAPACITY = barnCapacity(3, 2);

/**
 * The size of a placed structure or a queued build.
 *
 * Barns carry their own; everything else takes it from the recipe. Saves from
 * before barns could be sized have no w/h at all, so the recipe is also the
 * fallback — see migrate() in engine/save.js, which stamps 3x2 on them.
 */
export function sizeOf(thing, kind = thing && (thing.type || thing.buildKind)) {
  if (thing && thing.w > 0 && thing.h > 0) return [thing.w, thing.h];
  const def = buildDef(kind);
  return def ? def.size : [1, 1];
}

/** Finished barns only; a queued one doesn't house anything yet. */
export function animalCapacity(state) {
  return (state.buildings || [])
    .filter((b) => b.type === 'barn')
    .reduce((n, b) => n + BARN_CAPACITY_OF(b), 0);
}

/** The building whose footprint covers this tile, if any. */
export function buildingAt(state, x, y) {
  for (const b of state.buildings || []) {
    if (!buildDef(b.type)) continue;
    const [w, h] = sizeOf(b);
    if (x >= b.x && x < b.x + w && y >= b.y && y < b.y + h) return b;
  }
  return null;
}

export function buildDef(kind) { return BUILDABLES[kind]; }

/**
 * Every tile a structure placed at (x,y) would occupy.
 *
 * `size` overrides the recipe, for the one structure the player sizes himself.
 */
export function footprint(kind, x, y, size) {
  const def = buildDef(kind);
  if (!def) return [];
  const [w, h] = size || def.size;
  const tiles = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) tiles.push({ x: x + dx, y: y + dy });
  }
  return tiles;
}

/**
 * Snaps a dragged rectangle to a barn that can actually be built.
 *
 * Always rounds *down* — the barn fits inside what was drawn rather than
 * spilling past it, so the rectangle is a promise about the ground being spent.
 */
export function snapBarn(x0, y0, x1, y1, limits = BARN_LIMITS) {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  let w = Math.abs(x1 - x0) + 1;
  let h = Math.abs(y1 - y0) + 1;
  w = Math.min(w, limits.maxW);
  h = Math.min(h, limits.maxH);
  if (limits.oddWidth && w % 2 === 0) w -= 1;
  if (w < limits.minW || h < limits.minH) return null;
  return { x, y, w, h };
}

/** Can this structure legally stand here? Ignores materials. */
export function canPlaceAt(state, kind, x, y, size) {
  return placementProblem(state, kind, x, y, size) === null;
}

/**
 * Why this structure can't stand here, in words, or null if it can.
 *
 * Separate from the yes/no because the answer matters: a barn is dragged out
 * across a lot of ground, and "something is in the way" told the player nothing
 * when the real reason was that half their rectangle wasn't their land. Every
 * rejection now says which one it is.
 */
export function placementProblem(state, kind, x, y, size) {
  const def = buildDef(kind);
  if (!def) return 'unknown structure';

  const reserved = reservedTiles(state);
  for (const t of footprint(kind, x, y, size)) {
    if (!state.grid.inBounds(t.x, t.y)) return 'off the edge of the world';
    // A barn may not straddle the boundary onto land you don't own.
    if (!state.grid.isOwned(t.x, t.y)) return "you don't own all that land";
    // Another build is already claiming this ground. Without this, two
    // overlapping orders both pass and the second quietly pays for a structure
    // that overwrites the first.
    if (reserved.has(`${t.x},${t.y}`)) return 'something else is queued there';
    // Nothing goes on water — there are no bridges, and a fence in a pond
    // would be nonsense. Take the water up first.
    if (isWater(state.grid.getGround(t.x, t.y))) return 'you would be building on water';
    // Water must not be dug out from under anyone: it blocks, so the farmer or
    // an animal standing there would be stranded on an island of one tile.
    if (isWater(def.ground) && occupied(state, t.x, t.y)) return 'someone is standing there';
    if (cropAt(state, t.x, t.y)) return 'crops are growing there';
    // Beds are hard-won; don't let a stray fence tap pave over one.
    if (isTilled(state.grid.getGround(t.x, t.y))) return 'that soil is already tilled';

    const obj = state.grid.getObject(t.x, t.y);
    // A building mark with no building behind it is stale, and must not refuse
    // ground that is plainly empty. The record is the source of truth; the mark
    // is only an index (see placeStructure). Refusing on the index alone told
    // the player there was a building in the way of a bare field.
    if (obj === OBJ.BUILDING && !buildingAt(state, t.x, t.y)) continue;
    if (obj !== OBJ.NONE) {
      // A building is dragged out over whatever ground the player likes, and a
      // farm is scattered with trees, rocks and weeds — insisting every tile
      // be bare first made the biggest barn impossible to site anywhere on a
      // new farm, which is how this was found. The farmer clears the site as
      // part of the job (see clearBuildSite), so scenery only has to be
      // *clearable*, not absent. Anything the player put there deliberately —
      // a fence, a trough, another building — still refuses.
      const clearable = def.building && objDef(obj).clearable;
      if (!clearable) return `there is a ${objDef(obj).name} in the way`;
    }

    if (def.ground && state.grid.getGround(t.x, t.y) === def.ground) {
      return `that is already ${def.name.toLowerCase()}`;
    }
  }
  return null;
}

/** Is anyone standing here? */
function occupied(state, x, y) {
  if (state.farmer.x === x && state.farmer.y === y) return true;
  return (state.animals || []).some((a) => a.x === x && a.y === y);
}

/**
 * Every tile a queued build is standing on.
 *
 * The footprint is already outlined on the map while the task waits, so a
 * reserved tile is one the player can see is spoken for.
 *
 * @returns {Set<string>} "x,y" keys
 */
export function reservedTiles(state) {
  const out = new Set();
  for (const task of state.tasks || []) {
    if (task.type !== 'build') continue;
    for (const t of footprint(task.buildKind, task.x, task.y, sizeOf(task))) out.add(`${t.x},${t.y}`);
  }
  return out;
}

/**
 * The ground each queued build is going to lay, keyed by tile.
 *
 * The renderer draws these faintly and counts them in when working out edges
 * and corners, so a pond or a path looks like the shape it's going to be from
 * the moment it's ordered. Without it the shape grows a fresh set of wrong
 * edges after every single tile the farmer finishes — and a half-dug pond in
 * particular reads as a bite taken out of it.
 *
 * @returns {Map<string, number>} "x,y" -> GROUND id
 */
export function pendingGroundTiles(state) {
  const out = new Map();
  for (const task of state.tasks || []) {
    if (task.type !== 'build') continue;
    const def = buildDef(task.buildKind);
    if (!def || def.ground == null) continue;
    for (const t of footprint(task.buildKind, task.x, task.y, sizeOf(task))) out.set(`${t.x},${t.y}`, def.ground);
  }
  return out;
}

/** Just the water ones, which is what the pond autotiler needs. */
export function pendingWaterTiles(state) {
  const out = new Set();
  for (const [key, ground] of pendingGroundTiles(state)) {
    if (isWater(ground)) out.add(key);
  }
  return out;
}

/** Is this tile promised to a build that hasn't happened yet? */
export function isReserved(state, x, y) {
  return reservedTiles(state).has(`${x},${y}`);
}

/** Total materials already promised to queued build tasks. */
export function pendingMaterials(state) {
  const owed = {};
  for (const task of state.tasks) {
    if (task.type !== 'build') continue;
    for (const [mat, n] of Object.entries(costOf(task.buildKind, sizeOf(task)))) {
      owed[mat] = (owed[mat] || 0) + n;
    }
  }
  return owed;
}

/** What a structure of this size costs. Only barns vary. */
export function costOf(kind, size) {
  const def = buildDef(kind);
  if (!def) return {};
  if (def.sizable && size) return barnCost(size[0], size[1]);
  return def.cost;
}

/** How long it takes to raise. Only barns vary. */
export function workOf(kind, size) {
  const def = buildDef(kind);
  if (!def) return 1;
  if (def.sizable && size) return barnWork(size[0], size[1]);
  return def.work;
}

/**
 * @returns {{ok: boolean, missing?: string}} whether one more of `kind` can be
 *   paid for on top of everything already queued.
 */
export function canAfford(state, kind, size) {
  const def = buildDef(kind);
  if (!def) return { ok: false, missing: 'unknown' };

  const owed = pendingMaterials(state);
  for (const [mat, n] of Object.entries(costOf(kind, size))) {
    if (countItem(state, mat) < (owed[mat] || 0) + n) return { ok: false, missing: mat };
  }
  return { ok: true };
}

/** Human-readable cost, for the picker. */
export function costLabel(kind, size) {
  if (!buildDef(kind)) return '';
  return Object.entries(costOf(kind, size))
    .map(([m, n]) => `${n} ${itemName(m).toLowerCase()}`).join(', ');
}

/**
 * Spends the materials and puts the structure into the world. Called by the
 * farmer when a build task completes.
 * @returns {boolean} false if the materials vanished while the task was queued.
 */
/**
 * Are the materials there right now? Split out so the farmer can find out
 * *before* clearing the site — no sense pulling up an egg for a barn that
 * turns out to be unaffordable.
 */
export function canCompleteBuild(state, task) {
  if (!buildDef(task.buildKind)) return false;
  for (const [mat, n] of Object.entries(costOf(task.buildKind, sizeOf(task)))) {
    if (countItem(state, mat) < n) return false;
  }
  return true;
}

export function completeBuild(state, task) {
  const def = buildDef(task.buildKind);
  if (!def) return false;

  // Check everything before spending anything, so a half-paid build is impossible.
  if (!canCompleteBuild(state, task)) return false;
  const size = sizeOf(task);
  for (const [mat, n] of Object.entries(costOf(task.buildKind, size))) removeItem(state, mat, n);

  placeStructure(state, task.buildKind, task.x, task.y, size);
  return true;
}

/**
 * Puts a finished structure into the world. Deliberately free of any cost or
 * validity checking — `completeBuild` handles payment, and worldgen uses this
 * directly to stand up the barn a new farm starts with.
 */
export function placeStructure(state, kind, x, y, size) {
  const def = buildDef(kind);
  if (!def) return false;

  const [w, h] = size || def.size;
  const tiles = footprint(kind, x, y, [w, h]);

  if (def.ground != null) {
    for (const t of tiles) state.grid.setGround(t.x, t.y, def.ground);
  }
  if (def.obj != null) {
    for (const t of tiles) state.grid.setObject(t.x, t.y, def.obj);
  }
  // A trough's contents live on its anchor tile; the grid marks only block movement.
  if (def.trough) {
    state.troughs[`${x},${y}`] = { kind: def.trough, level: 0, foodType: null };
  }
  // Same idea one size up: the building record is the source of truth, the grid
  // marks are just an index so collision and taps keep working.
  if (def.building) {
    state.buildings.push({ id: state.nextBuildingId++, type: def.building, x, y, w, h });
  }

  emitUnlessSuspended('world:changed', { x, y });
  return true;
}

/**
 * Makes the grid's building marks agree with the building records.
 *
 * The records are the truth and the marks are an index kept alongside them, so
 * the two can in principle drift — and when they do the game misleads rather
 * than merely misbehaving: a mark with nothing behind it refuses to let a barn
 * be built on ground the player can see is empty, and a record with no marks
 * lets animals walk through a wall.
 *
 * Run on load, where a scan of the map costs nothing that anyone will notice.
 *
 * @returns {{cleared: number, restored: number}} what had to be put right
 */
export function reconcileBuildings(state) {
  const grid = state.grid;
  const wanted = new Set();
  for (const b of state.buildings || []) {
    if (!buildDef(b.type)) continue;
    for (const t of footprint(b.type, b.x, b.y, sizeOf(b))) wanted.add(`${t.x},${t.y}`);
  }

  let cleared = 0;
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      if (grid.getObject(x, y) !== OBJ.BUILDING) continue;
      if (wanted.has(`${x},${y}`)) continue;
      grid.setObject(x, y, OBJ.NONE);
      cleared++;
    }
  }

  let restored = 0;
  for (const key of wanted) {
    const comma = key.indexOf(',');
    const x = +key.slice(0, comma);
    const y = +key.slice(comma + 1);
    if (!grid.inBounds(x, y) || grid.getObject(x, y) === OBJ.BUILDING) continue;
    grid.setObject(x, y, OBJ.BUILDING);
    restored++;
  }

  return { cleared, restored };
}

// --- demolition ---------------------------------------------------------
//
// Anything the player built can be taken back down for half its materials.
// Structures are matched back to their recipe by what they left in the world,
// so the refund always reflects the current price list rather than anything
// stored on the tile — which also means farms saved before demolition existed
// can be dismantled just fine.

/** The buildable whose finished form is this object id, if any. */
export function kindForObject(objId) {
  if (objId == null || objId === OBJ.NONE) return null;
  for (const [kind, def] of Object.entries(BUILDABLES)) {
    if (def.obj === objId) return kind;
  }
  return null;
}

/** The buildable whose finished form is this ground id, if any. */
export function kindForGround(groundId) {
  for (const [kind, def] of Object.entries(BUILDABLES)) {
    if (def.ground != null && def.ground === groundId) return kind;
  }
  return null;
}

/** Half the build cost, rounded down. Cheap things can refund nothing. */
export function refundFor(kind, size) {
  if (!buildDef(kind)) return {};
  const refund = {};
  for (const [mat, n] of Object.entries(costOf(kind, size))) {
    const half = Math.floor(n / 2);
    if (half > 0) refund[mat] = half;
  }
  return refund;
}

/** How long taking something down takes: half as long as putting it up. */
export function demolishWork(kind, size) {
  return buildDef(kind) ? Math.max(1, Math.ceil(workOf(kind, size) / 2)) : 1;
}

/**
 * What (if anything) stands on this tile that the player built.
 * Troughs report their anchor, so tapping either half removes the whole thing.
 * @returns {{kind: string, x: number, y: number}|null}
 */
export function structureAt(state, x, y) {
  if (!state.grid.inBounds(x, y)) return null;

  // Buildings first: their footprint tiles all carry the same generic marker,
  // so only the record knows which building a tile belongs to.
  const building = buildingAt(state, x, y);
  if (building) {
    const [w, h] = sizeOf(building);
    return { kind: building.type, x: building.x, y: building.y, w, h };
  }

  const objKind = kindForObject(state.grid.getObject(x, y));
  if (objKind) {
    const def = buildDef(objKind);
    if (def.trough) {
      const anchor = troughAnchorAt(state, x, y);
      if (anchor) return { kind: objKind, x: anchor.x, y: anchor.y };
    }
    return { kind: objKind, x, y };
  }

  // Ground-only structures (roads) count once nothing is standing on them.
  if (state.grid.getObject(x, y) === OBJ.NONE) {
    const groundKind = kindForGround(state.grid.getGround(x, y));
    if (groundKind) return { kind: groundKind, x, y };
  }
  return null;
}

/**
 * Takes a structure back down. Returns the materials owed to the player; the
 * caller adds them to the bag so the "you gained things" plumbing stays in one
 * place.
 * @returns {{ok: boolean, refund?: object}}
 */
export function demolish(state, x, y) {
  const found = structureAt(state, x, y);
  if (!found) return { ok: false };

  const def = buildDef(found.kind);
  const size = found.w > 0 ? [found.w, found.h] : null;
  for (const t of footprint(found.kind, found.x, found.y, size)) {
    if (def.obj != null) state.grid.setObject(t.x, t.y, OBJ.NONE);
    // Ground structures revert to grass; a road should not leave bare earth.
    if (def.ground != null) state.grid.setGround(t.x, t.y, GROUND.GRASS);
  }
  if (def.trough) delete state.troughs[`${found.x},${found.y}`];
  if (def.building) {
    state.buildings = state.buildings.filter((b) => !(b.x === found.x && b.y === found.y));
  }

  emitUnlessSuspended('world:changed', { x: found.x, y: found.y });
  return { ok: true, refund: refundFor(found.kind, size) };
}

/** Which trough (if any) covers this tile — troughs are two tiles wide. */
export function troughAnchorAt(state, x, y) {
  for (const key of Object.keys(state.troughs)) {
    const comma = key.indexOf(',');
    const ax = +key.slice(0, comma);
    const ay = +key.slice(comma + 1);
    if (ay === y && (ax === x || ax === x - 1)) return { x: ax, y: ay };
  }
  return null;
}
