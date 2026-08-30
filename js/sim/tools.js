// Hung-up tools: decoration that shares a tile with whatever is already there.
//
// Everything else the player places owns its tile. A fence, a crate, a barn —
// one thing per square, because the grid holds exactly one object per tile and
// that is the whole of its memory. Tools are the exception on purpose: a scythe
// leaning on a barn wall and an axe by the woodpile are both *on* something
// else, and making them fight the barn for the square would mean you could
// never hang anything anywhere you'd actually want it.
//
// So they live in their own layer, keyed by tile, and the object grid never
// hears about them. They don't block, they don't get in the way of a build, and
// nothing that walks the farm has to know they exist. The cost of that freedom
// is that they are drawn last (see drawTools) and cleared first (see
// structureAt) — the topmost thing on a tile in both senses.
//
// Hard rules, same as everything in sim/: no DOM, no Math.random(), no
// Date.now(). Catch-up replays this thousands of times over.

import { emitUnlessSuspended } from '../engine/events.js';

/**
 * The buildable kinds that live in this layer.
 *
 * The stored value *is* the buildable's key, so there's no second table mapping
 * one to the other and no way for the two to drift apart. Adding a tool is a
 * BUILDABLES entry with `overlay: true` and a line in the renderer's sprite
 * table — nothing here needs touching.
 */
export function toolKey(x, y) { return `${x},${y}`; }

export function toolAt(state, x, y) {
  return (state.tools || {})[toolKey(x, y)] || null;
}

/** Every hung tool on the farm, each with the tile it is on. */
export function toolList(state) {
  return Object.entries(state.tools || {}).map(([key, kind]) => {
    const comma = key.indexOf(',');
    return { x: +key.slice(0, comma), y: +key.slice(comma + 1), kind };
  });
}

export function placeTool(state, x, y, kind) {
  state.tools = state.tools || {};
  state.tools[toolKey(x, y)] = kind;
  emitUnlessSuspended('world:changed', { x, y });
  return kind;
}

/** @returns {string|null} what was taken down, if anything */
export function removeTool(state, x, y) {
  const kind = toolAt(state, x, y);
  if (!kind) return null;
  delete state.tools[toolKey(x, y)];
  emitUnlessSuspended('world:changed', { x, y });
  return kind;
}
