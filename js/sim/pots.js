// Flower pots: soil you can put down anywhere.
//
// A flower needs bare owned grass to grow on (see bareGround in sim/flowers.js),
// which means the places a farm most wants flowers — along a stone path, by the
// barn door, on the dirt outside the house — are exactly the places they cannot
// go. A pot brings its own soil, so it makes those places plantable. That is
// the whole point of it: a pot that only worked on grass would be a pot you
// never needed, because you could have planted there anyway.
//
// Like the hung tools in sim/tools.js, a pot lives in its own tile-keyed layer
// and never touches the object grid. That is what keeps this small. A planted
// pot has to be both a pot and a flower at once, and the grid holds one object
// per tile — so if the pot owned the tile, every flower path would have to
// learn about pots: what counts as bare ground, what picking leaves behind,
// what reconcileFlowers reads, what the harvest task finds. Kept separate, the
// flower in a pot is an *ordinary flower*, and breeding, watering, picking, the
// journal and the spawn cap all work with no changes at all.
//
// Hard rules, same as everything in sim/: no DOM, no Math.random(), no
// Date.now(). Catch-up replays this thousands of times over.

import { emitUnlessSuspended } from '../engine/events.js';

export function potKey(x, y) { return `${x},${y}`; }

export function potAt(state, x, y) {
  return !!(state.pots || {})[potKey(x, y)];
}

/** Every pot on the farm, each with the tile it stands on. */
export function potList(state) {
  return Object.keys(state.pots || {}).map((key) => {
    const comma = key.indexOf(',');
    return { x: +key.slice(0, comma), y: +key.slice(comma + 1) };
  });
}

export function placePot(state, x, y) {
  state.pots = state.pots || {};
  state.pots[potKey(x, y)] = true;
  emitUnlessSuspended('world:changed', { x, y });
  return true;
}

/** @returns {boolean} whether there was one to take away */
export function removePot(state, x, y) {
  if (!potAt(state, x, y)) return false;
  delete state.pots[potKey(x, y)];
  emitUnlessSuspended('world:changed', { x, y });
  return true;
}
