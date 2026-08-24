// Crates: somewhere for the farmhands to put things down.
//
// A farmhand carries very little — two dozen items and their pockets are full,
// after which they walk to a barn and stand there until you come and take it
// off them. That is deliberate (see sim/farmhand.js): the help is a multiplier
// on your farm, not a replacement for visiting it. But on a big farm it means
// the whole crew ends up idle by the barn holding eight eggs each.
//
// A crate is the middle ground. It holds a hundred of *one* kind of goods, so
// a hand that fills up can stow what it has and get straight back to work. The
// player still has to come and empty it — the loop is the same, just at a
// coarser grain, and the crate you place is where you have chosen to make the
// farm collect itself.
//
// One kind, not a warehouse: a crate takes its type from whatever is put in it
// first and holds that until it is emptied. That keeps a crate something you
// site deliberately — by the coop, by the pasture — rather than a single box
// that swallows the entire farm.
//
// Contents live here, keyed by tile, rather than on the grid: the grid has one
// byte per tile and a crate has both a kind of goods and a count. The grid mark
// is an index over these records, exactly as it is for buildings.
//
// Hard rules, same as everything in sim/: no DOM, no Math.random(), no
// Date.now(). Catch-up replays this thousands of times over.

import { emitUnlessSuspended } from '../engine/events.js';
import { OBJ } from '../world/tiledefs.js';

/**
 * How much one crate holds.
 *
 * Comfortably more than a farmhand (24), which is the whole point — a hand
 * should be able to fill up several times over before a crate needs emptying,
 * or crates would just move the standing-around from the barn to the box.
 */
export const CRATE_CAPACITY = 100;

export function crateKey(x, y) { return `${x},${y}`; }

export function crateAt(state, x, y) {
  return (state.crates || {})[crateKey(x, y)] || null;
}

/** Every crate on the farm, each with the tile it stands on. */
export function crateList(state) {
  return Object.entries(state.crates || {}).map(([key, crate]) => {
    const comma = key.indexOf(',');
    return { x: +key.slice(0, comma), y: +key.slice(comma + 1), ...crate };
  });
}

export function crateRoom(crate) {
  if (!crate) return 0;
  return Math.max(0, CRATE_CAPACITY - (crate.qty || 0));
}

export function isCrateFull(crate) { return crateRoom(crate) === 0; }

/**
 * Will this crate take that item?
 *
 * An empty crate takes anything — it has no type until something is in it.
 */
export function crateAccepts(crate, itemId) {
  if (!crate || crateRoom(crate) <= 0) return false;
  return !crate.item || crate.qty <= 0 || crate.item === itemId;
}

/**
 * Put what fits into the crate.
 *
 * Takes the whole satchel and returns only what it actually took, so the caller
 * can keep the remainder: a hand carrying eggs and milk unloads its eggs into
 * an egg crate and walks on still holding the milk. Nothing is ever destroyed
 * by a full crate — the same rule as a full pair of pockets.
 *
 * @param {object} items  {itemId: qty}
 * @returns {object} what went in, in the same shape
 */
export function depositInto(state, x, y, items) {
  const crate = crateAt(state, x, y);
  if (!crate) return {};

  const took = {};
  for (const [id, qty] of Object.entries(items || {})) {
    if (qty <= 0) continue;
    if (!crateAccepts(crate, id)) continue;
    const n = Math.min(qty, crateRoom(crate));
    if (n <= 0) break;                       // full; nothing else can fit either
    crate.item = id;                         // first thing in sets the type
    crate.qty = (crate.qty || 0) + n;
    took[id] = n;
  }

  if (Object.keys(took).length > 0) {
    emitUnlessSuspended('world:changed', { x, y });
  }
  return took;
}

/**
 * Empty a crate out, back to having no type at all.
 *
 * @returns {object} what was inside, in the shape the task pipeline reports
 */
export function emptyCrate(state, x, y) {
  const crate = crateAt(state, x, y);
  if (!crate || !crate.item || crate.qty <= 0) return {};
  const contents = { [crate.item]: crate.qty };
  crate.item = null;
  crate.qty = 0;
  emitUnlessSuspended('world:changed', { x, y });
  return contents;
}

/**
 * The nearest crate that will take something this hand is carrying.
 *
 * Distance only — a hand should walk to the box it can see, not reason about
 * which one is emptiest. Crates that are full, or spoken for by a kind of goods
 * this hand hasn't got, are simply not candidates, which is what makes a full
 * crate send the hand looking for another one.
 */
export function findCrateFor(state, carrying, from) {
  const ids = Object.keys(carrying || {}).filter((id) => carrying[id] > 0);
  if (ids.length === 0) return null;

  let best = null;
  for (const crate of crateList(state)) {
    if (!ids.some((id) => crateAccepts(crate, id))) continue;
    const d = Math.abs(crate.x - from.x) + Math.abs(crate.y - from.y);
    if (!best || d < best.d) best = { d, crate };
  }
  return best ? { x: best.crate.x, y: best.crate.y } : null;
}

/**
 * Makes the grid's crate marks agree with the crate records.
 *
 * Same argument as reconcileBuildings: the records are the truth and the marks
 * are an index kept alongside them, so the two can drift. A mark with nothing
 * behind it is a box the farmer can't walk through and can't empty; a record
 * with no mark is goods stored in thin air.
 *
 * @returns {{adopted: number, dropped: number}} what had to be put right
 */
export function reconcileCrates(state) {
  const grid = state.grid;
  state.crates = state.crates || {};

  let adopted = 0;
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      if (grid.getObject(x, y) !== OBJ.CRATE) continue;
      if (state.crates[crateKey(x, y)]) continue;
      // A mark with no record is an empty crate as far as the player can see,
      // so give it a record rather than deleting a box they built.
      state.crates[crateKey(x, y)] = { item: null, qty: 0 };
      adopted++;
    }
  }

  let dropped = 0;
  for (const { x, y } of crateList(state)) {
    if (!grid.inBounds(x, y)) { delete state.crates[crateKey(x, y)]; continue; }
    if (grid.getObject(x, y) === OBJ.CRATE) continue;
    // The tile is something else now — whatever it is has a better claim than
    // a stale record, so the record goes rather than the world changing under
    // the player.
    delete state.crates[crateKey(x, y)];
    dropped++;
  }

  return { adopted, dropped };
}
