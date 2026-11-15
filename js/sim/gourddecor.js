// Gourds set out as decorations: a pumpkin on the porch.
//
// A harvested gourd can go in the bag and be sold like any crop, or it can be
// put down on the farm and left there to look autumnal. Clearing one away
// later breaks it open for its seed, which is the other way gourd seed comes
// back once October is over and the jack-o'-lanterns stop — so a gourd she
// grew is never a dead end.
//
// Like a flower pot (see sim/pots.js) it lives in its own tile-keyed layer and
// never touches the object grid, so it blocks nobody and nothing else has to
// learn about it beyond "something is sitting here". The things that spawn on
// open ground on their own — weeds, mushrooms, wild flowers, balloons,
// jack-o'-lanterns — each check for one, the same way they check for a
// lantern.
//
// Hard rules, same as everything in sim/: no DOM, no Math.random(), no
// Date.now().

import { emitUnlessSuspended } from '../engine/events.js';
import { OBJ, isWater } from '../world/tiledefs.js';
import { cropAt, isGourd, seedIdFor } from './crops.js';
import { countItem, removeItem, addItem } from './inventory.js';
import { potAt } from './pots.js';
import { isReserved } from './build.js';

/** Seeds back from breaking one open. */
export const DECOR_SEEDS = { lo: 2, hi: 4 };

export function gourdKey(x, y) { return `${x},${y}`; }

/** Which gourd is set out on this tile, if any. */
export function decorGourdAt(state, x, y) {
  return (state.gourdDecor || {})[gourdKey(x, y)] || null;
}

export function gourdDecorList(state) {
  return Object.entries(state.gourdDecor || {}).map(([key, type]) => {
    const comma = key.indexOf(',');
    return { x: +key.slice(0, comma), y: +key.slice(comma + 1), type };
  });
}

/**
 * Somewhere a gourd may be set down: any dry ground you own with nothing else
 * on it. Roads and paths included — a pumpkin by the barn door is exactly the
 * point, and the barn door is rarely on grass. Not on a bed with a crop in it,
 * not on a build site, and never on top of a pot, a lantern, a balloon or
 * another gourd.
 */
export function canPlaceGourd(state, x, y) {
  const grid = state.grid;
  if (!grid.inBounds(x, y) || !grid.isOwned(x, y)) return false;
  if (isWater(grid.getGround(x, y))) return false;
  if (grid.getObject(x, y) !== OBJ.NONE) return false;
  if (cropAt(state, x, y)) return false;
  if (isReserved(state, x, y)) return false;
  if (potAt(state, x, y) || decorGourdAt(state, x, y)) return false;
  const key = gourdKey(x, y);
  if ((state.lanterns || {})[key] || (state.balloons || {})[key]) return false;
  if ((state.leaves || {})[key]) return false;
  return true;
}

/** Takes one from the bag and sets it out. */
export function placeGourd(state, type, x, y) {
  if (!isGourd(type)) return { ok: false, reason: "that isn't a gourd" };
  if (countItem(state, type) < 1) return { ok: false, reason: 'none in the bag' };
  if (!canPlaceGourd(state, x, y)) return { ok: false, reason: "it won't go there" };

  removeItem(state, type, 1);
  state.gourdDecor = state.gourdDecor || {};
  state.gourdDecor[gourdKey(x, y)] = type;
  emitUnlessSuspended('world:changed', { x, y });
  return { ok: true };
}

/**
 * Clears one away, for its seed. The gourd itself doesn't come back — it was
 * broken open to get at them, which is what makes this a choice: keep it as a
 * gourd in the bag and sell it, or set it out and get seed back at the end.
 *
 * @returns {Record<string, number>|null} what went in the bag
 */
export function clearGourd(state, x, y) {
  const type = decorGourdAt(state, x, y);
  if (!type) return null;
  delete state.gourdDecor[gourdKey(x, y)];
  const qty = DECOR_SEEDS.lo + state.rng.int(DECOR_SEEDS.hi - DECOR_SEEDS.lo + 1);
  const gained = { [seedIdFor(type)]: qty };
  addItem(state, seedIdFor(type), qty);
  emitUnlessSuspended('world:changed', { x, y });
  return gained;
}

/** Drops records on land no longer owned, or of a gourd that no longer exists. */
export function reconcileGourdDecor(state) {
  state.gourdDecor = state.gourdDecor || {};
  let dropped = 0;
  for (const [key, type] of Object.entries(state.gourdDecor)) {
    const comma = key.indexOf(',');
    const x = +key.slice(0, comma);
    const y = +key.slice(comma + 1);
    if (isGourd(type) && state.grid.inBounds(x, y) && state.grid.isOwned(x, y)) continue;
    delete state.gourdDecor[key];
    dropped++;
  }
  return { dropped };
}
