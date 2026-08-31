// Decorations: things you buy purely because you want them there.
//
// Everything else placed on the farm earns its keep — a fence pens animals, a
// trough feeds them, a road is quicker to walk. Decorations do nothing at all,
// which is the point: a farm you've spent a month on should be somewhere you
// can arrange to your own taste, not only somewhere efficient.
//
// They reuse the objects the world already generates, so a bought tree is
// exactly the tree worldgen scatters — it draws the same, chops the same, and
// leaves the same wood behind.
//
// Prices are set *above* what clearing one gives back, or a decoration would be
// a money press: buy a tree, chop it, sell the wood, repeat.

import { OBJ, objDef, isWater } from '../world/tiledefs.js';
import { placePot, potAt } from './pots.js';
import { ITEMS } from './inventory.js';
import { emitUnlessSuspended } from '../engine/events.js';

export const DECOR = {
  tree: { name: 'Tree', obj: OBJ.TREE, price: 60, note: 'shade, and wood later' },
  deadTree: { name: 'Dead tree', obj: OBJ.DEAD_TREE, price: 35, note: 'bare branches' },
  bush: { name: 'Bush', obj: OBJ.BUSH, price: 25, note: 'low and round' },
  rock: { name: 'Rock', obj: OBJ.ROCK, price: 30, note: 'a boulder' },
  stump: { name: 'Stump', obj: OBJ.STUMP, price: 20, note: 'what a tree leaves' },
  weeds: { name: 'Wild grass', obj: OBJ.WEED, price: 10, note: 'a tuft, walk right over it' },
  // The odd one out: a pot is not an object on the grid but a layer of its own
  // (see sim/pots.js), because a planted pot has to be a pot and a flower at
  // the same time. `overlay` is what says so — the same idea the build menu
  // uses for tools hung on a wall.
  pot: {
    name: 'Flower pot', overlay: true, price: 40,
    note: 'flowers will grow in it anywhere',
  },
};

export function decorDef(kind) { return DECOR[kind] || null; }

/** What clearing one would hand back, in money. Prices must beat this. */
export function salvageValue(kind) {
  const def = decorDef(kind);
  if (!def || def.overlay) return 0;      // nothing to chop out of a pot
  const yields = objDef(def.obj).yields || {};
  return Object.entries(yields)
    .reduce((sum, [id, n]) => sum + (ITEMS[id]?.sell || 0) * n, 0);
}

/**
 * Somewhere a decoration may stand.
 *
 * Deliberately strict about the farm's working parts: not on a bed or a crop,
 * not in water, not on ground a build is already promised, and never on top of
 * anything — including a person or an animal, since most decorations block and
 * would strand whoever was standing there.
 */
export function canPlaceDecor(state, x, y, kind = null) {
  const grid = state.grid;
  if (!grid.inBounds(x, y) || !grid.isOwned(x, y)) return false;
  if (grid.getObject(x, y) !== OBJ.NONE) return false;
  // A pot brings its own soil, so it may stand on a road or a dirt path where
  // nothing would otherwise grow — but not in water, and not two to a tile.
  if (decorDef(kind)?.overlay) return !isWater(grid.getGround(x, y)) && !potAt(state, x, y);
  return true;
}

export function placeDecor(state, kind, x, y) {
  const def = decorDef(kind);
  if (!def) return { ok: false, reason: 'no such thing' };
  if (state.money < def.price) return { ok: false, reason: `that costs $${def.price}` };
  if (!canPlaceDecor(state, x, y, kind)) return { ok: false, reason: "it won't go there" };

  state.money -= def.price;
  if (def.overlay) placePot(state, x, y);
  else state.grid.setObject(x, y, def.obj);
  emitUnlessSuspended('money:changed', { delta: -def.price });
  emitUnlessSuspended('world:changed', { x, y });
  return { ok: true, spent: def.price };
}

/** Display rows for the shop. */
export function decorList(state) {
  return Object.entries(DECOR).map(([kind, def]) => ({
    kind,
    name: def.name,
    price: def.price,
    note: def.note,
    affordable: state.money >= def.price,
  }));
}
