// Hay bales: food for the horses, and the only feed that runs out for good.
//
// A feed trough is a fixture — you fill it, it empties, you fill it again, and
// it stands there for ever either way. A bale is the opposite: it arrives full,
// it is eaten down, and then it is gone. That makes it the thing you drop in a
// paddock rather than the thing you plumb in, and it means a horse kept on hay
// alone is a standing small commitment rather than a one-off build.
//
// Only grazers eat from one, which today means horses (see `grazes` in
// sim/animals.js). It is a species flag rather than a check for the string
// 'horse' so the next animal that ought to eat hay can simply say so.
//
// How much is left lives here, keyed by tile, rather than on the grid: the grid
// has one byte per tile and a bale has a count. The grid mark is an index over
// these records, exactly as it is for crates and buildings.
//
// Hard rules, same as everything in sim/: no DOM, no Math.random(), no
// Date.now(). Catch-up replays this thousands of times over.

import { emitUnlessSuspended } from '../engine/events.js';
import { OBJ } from '../world/tiledefs.js';

/**
 * Helpings in a fresh bale.
 *
 * Half a feed trough (24). A trough is refillable and a bale is not, so the
 * bale being smaller is the whole trade — it is convenience and scenery, not a
 * cheaper way to feed a farm.
 */
export const HAY_HELPINGS = 12;

export function hayKey(x, y) { return `${x},${y}`; }

export function hayAt(state, x, y) {
  return (state.hay || {})[hayKey(x, y)] || null;
}

/** Every bale on the farm, each with the tile it stands on. */
export function hayList(state) {
  return Object.entries(state.hay || {}).map(([key, bale]) => {
    const comma = key.indexOf(',');
    return { x: +key.slice(0, comma), y: +key.slice(comma + 1), ...bale };
  });
}

export function hayLeft(bale) { return Math.max(0, bale?.left || 0); }

/**
 * Takes one helping, and clears the bale away if that was the last of it.
 *
 * Removing the record *and* the grid mark together is the point: a bale eaten
 * to nothing that left its mark behind would be an invisible wall, and one that
 * left its record behind would be a meal that could be eaten for ever.
 *
 * @returns {boolean} whether there was anything to eat
 */
export function eatFrom(state, x, y) {
  const bale = hayAt(state, x, y);
  if (!bale || hayLeft(bale) <= 0) return false;

  bale.left -= 1;
  if (bale.left <= 0) {
    delete state.hay[hayKey(x, y)];
    if (state.grid.getObject(x, y) === OBJ.HAY) state.grid.setObject(x, y, OBJ.NONE);
    emitUnlessSuspended('hay:finished', { x, y });
  }
  emitUnlessSuspended('world:changed', { x, y });
  return true;
}

/**
 * Makes the grid's hay marks agree with the hay records.
 *
 * Same argument as reconcileCrates. A mark with nothing behind it is a bale the
 * farmer can't walk through and no horse can eat; a record with no mark is a
 * meal hanging in the air.
 *
 * @returns {{adopted: number, dropped: number}} what had to be put right
 */
export function reconcileHay(state) {
  const grid = state.grid;
  state.hay = state.hay || {};

  let adopted = 0;
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      if (grid.getObject(x, y) !== OBJ.HAY) continue;
      if (state.hay[hayKey(x, y)]) continue;
      // A mark with no record is a full bale as far as the player can see, so
      // give it one rather than deleting something they paid for.
      state.hay[hayKey(x, y)] = { left: HAY_HELPINGS };
      adopted++;
    }
  }

  let dropped = 0;
  for (const { x, y } of hayList(state)) {
    if (!grid.inBounds(x, y)) { delete state.hay[hayKey(x, y)]; continue; }
    if (grid.getObject(x, y) === OBJ.HAY) continue;
    delete state.hay[hayKey(x, y)];
    dropped++;
  }

  return { adopted, dropped };
}
