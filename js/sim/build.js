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

import { OBJ, GROUND, isTilled, isWater } from '../world/tiledefs.js';
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
    name: 'Barn', obj: OBJ.BUILDING, cost: { wood: 50, stone: 20 }, work: 120,
    // Footprint is the ground it stands on; the roof draws three rows higher,
    // overhanging tiles the farmer can still walk through (as trees do).
    size: [3, 2], building: 'barn',
    hint: 'Houses animals — 3 tiles wide',
  },
};

/** How many animals one barn holds. Total capacity is the sum over barns. */
export const BARN_CAPACITY = 4;

/** Finished barns only; a queued one doesn't house anything yet. */
export function animalCapacity(state) {
  return (state.buildings || []).filter((b) => b.type === 'barn').length * BARN_CAPACITY;
}

/** The building whose footprint covers this tile, if any. */
export function buildingAt(state, x, y) {
  for (const b of state.buildings || []) {
    const def = buildDef(b.type);
    if (!def) continue;
    const [w, h] = def.size;
    if (x >= b.x && x < b.x + w && y >= b.y && y < b.y + h) return b;
  }
  return null;
}

export function buildDef(kind) { return BUILDABLES[kind]; }

/** Every tile a structure placed at (x,y) would occupy. */
export function footprint(kind, x, y) {
  const def = buildDef(kind);
  if (!def) return [];
  const [w, h] = def.size;
  const tiles = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) tiles.push({ x: x + dx, y: y + dy });
  }
  return tiles;
}

/** Can this structure legally stand here? Ignores materials. */
export function canPlaceAt(state, kind, x, y) {
  const def = buildDef(kind);
  if (!def) return false;

  const reserved = reservedTiles(state);
  for (const t of footprint(kind, x, y)) {
    // Another build is already claiming this ground. Without this, two
    // overlapping orders both pass and the second quietly pays for a structure
    // that overwrites the first.
    if (reserved.has(`${t.x},${t.y}`)) return false;
    if (!state.grid.inBounds(t.x, t.y)) return false;
    // A barn may not straddle the boundary onto land you don't own.
    if (!state.grid.isOwned(t.x, t.y)) return false;
    // Nothing goes on water — there are no bridges, and a fence in a pond
    // would be nonsense. Take the water up first.
    if (isWater(state.grid.getGround(t.x, t.y))) return false;
    // Water must not be dug out from under anyone: it blocks, so the farmer or
    // an animal standing there would be stranded on an island of one tile.
    if (isWater(def.ground) && occupied(state, t.x, t.y)) return false;
    if (state.grid.getObject(t.x, t.y) !== OBJ.NONE) return false;
    if (cropAt(state, t.x, t.y)) return false;
    // Beds are hard-won; don't let a stray fence tap pave over one.
    if (isTilled(state.grid.getGround(t.x, t.y))) return false;
    if (def.ground && state.grid.getGround(t.x, t.y) === def.ground) return false;
  }
  return true;
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
    for (const t of footprint(task.buildKind, task.x, task.y)) out.add(`${t.x},${t.y}`);
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
    for (const t of footprint(task.buildKind, task.x, task.y)) out.set(`${t.x},${t.y}`, def.ground);
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
    const def = buildDef(task.buildKind);
    if (!def) continue;
    for (const [mat, n] of Object.entries(def.cost)) owed[mat] = (owed[mat] || 0) + n;
  }
  return owed;
}

/**
 * @returns {{ok: boolean, missing?: string}} whether one more of `kind` can be
 *   paid for on top of everything already queued.
 */
export function canAfford(state, kind) {
  const def = buildDef(kind);
  if (!def) return { ok: false, missing: 'unknown' };

  const owed = pendingMaterials(state);
  for (const [mat, n] of Object.entries(def.cost)) {
    if (countItem(state, mat) < (owed[mat] || 0) + n) return { ok: false, missing: mat };
  }
  return { ok: true };
}

/** Human-readable cost, for the picker. */
export function costLabel(kind) {
  const def = buildDef(kind);
  if (!def) return '';
  return Object.entries(def.cost).map(([m, n]) => `${n} ${itemName(m).toLowerCase()}`).join(', ');
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
  const def = buildDef(task.buildKind);
  if (!def) return false;
  for (const [mat, n] of Object.entries(def.cost)) {
    if (countItem(state, mat) < n) return false;
  }
  return true;
}

export function completeBuild(state, task) {
  const def = buildDef(task.buildKind);
  if (!def) return false;

  // Check everything before spending anything, so a half-paid build is impossible.
  if (!canCompleteBuild(state, task)) return false;
  for (const [mat, n] of Object.entries(def.cost)) removeItem(state, mat, n);

  placeStructure(state, task.buildKind, task.x, task.y);
  return true;
}

/**
 * Puts a finished structure into the world. Deliberately free of any cost or
 * validity checking — `completeBuild` handles payment, and worldgen uses this
 * directly to stand up the barn a new farm starts with.
 */
export function placeStructure(state, kind, x, y) {
  const def = buildDef(kind);
  if (!def) return false;

  const tiles = footprint(kind, x, y);

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
    state.buildings.push({ id: state.nextBuildingId++, type: def.building, x, y });
  }

  emitUnlessSuspended('world:changed', { x, y });
  return true;
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
export function refundFor(kind) {
  const def = buildDef(kind);
  if (!def) return {};
  const refund = {};
  for (const [mat, n] of Object.entries(def.cost)) {
    const half = Math.floor(n / 2);
    if (half > 0) refund[mat] = half;
  }
  return refund;
}

/** How long taking something down takes: half as long as putting it up. */
export function demolishWork(kind) {
  const def = buildDef(kind);
  return def ? Math.max(1, Math.ceil(def.work / 2)) : 1;
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
  if (building) return { kind: building.type, x: building.x, y: building.y };

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
  for (const t of footprint(found.kind, found.x, found.y)) {
    if (def.obj != null) state.grid.setObject(t.x, t.y, OBJ.NONE);
    // Ground structures revert to grass; a road should not leave bare earth.
    if (def.ground != null) state.grid.setGround(t.x, t.y, GROUND.GRASS);
  }
  if (def.trough) delete state.troughs[`${found.x},${found.y}`];
  if (def.building) {
    state.buildings = state.buildings.filter((b) => !(b.x === found.x && b.y === found.y));
  }

  emitUnlessSuspended('world:changed', { x: found.x, y: found.y });
  return { ok: true, refund: refundFor(found.kind) };
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
