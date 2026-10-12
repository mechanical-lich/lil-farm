// Jack-o'-lanterns, which only come out in October.
//
// The birthday balloons' autumn cousin, and built the same way (see
// sim/balloons.js): for the whole of October, lit pumpkins turn up on the farm,
// the farmer walks over and pops one, and inside is a packet of gourd seed.
// Gourds are the only crop you can't buy — this is where they come from — and
// once she has the seed they grow any time of year like anything else.
//
// The same two halves as the balloons:
//
//   * Whether it is October is decided at boot, from the real date, because
//     sim/ may not read a clock. main.js calls noteHalloween with today's date.
//   * The spawning runs in the tick, off the flag that set. Catch-up spawns
//     lanterns for the time she was away exactly as if she'd been watching.
//
// A lantern sits *on* the ground where a balloon floats over it, so it asks
// more of its tile: open grass with nothing on it, the same ground a mushroom
// wants. And the things that spawn onto open grass on their own — weeds and
// mushrooms — check for one, so nothing grows up through it.
//
// Like the balloons, one left standing after Halloween stays. Nothing tidies
// them away: she may well like the look of a lit pumpkin by the barn.
//
// Hard rules, same as everything in sim/: no DOM, no Math.random(), no
// Date.now(). The date function here takes the date as an argument.

import { emitUnlessSuspended } from '../engine/events.js';
import { PLOT, plotCoords } from '../world/land.js';
import { canBalloonSpawn } from './balloons.js';
import { canSprout } from './mushrooms.js';
import { GOURDS, seedIdFor } from './crops.js';

/** The season: every day of October, inclusive. */
export const SEASON = { month: 10, from: 1, to: 31 };

/**
 * The faces on assets/flora/jackolanterns.png, in column order. A lantern
 * saves its column, and the journal keys by these names, so: append, never
 * reorder. tools/make-gourds.mjs draws them, and a test holds its list to this.
 */
export const LANTERN_NAMES = [
  'classic', 'surprised', 'grumpy', 'happy',
  'winking', 'sleepy', 'vampire', 'silly', 'cyclops', 'lovestruck', 'spooky', 'sad',
];

/** How many faces there are to find. */
export const LANTERN_FACES = LANTERN_NAMES.length;

/** Ticks between spawn attempts — the balloons' pace. */
export const LANTERN_INTERVAL = 300;

/** How many may be waiting at once, however long she has been away. */
export const LANTERN_CAP = 4;

/** How many seeds are in one. Generous, like a balloon: it's a present. */
export const SEEDS = { lo: 3, hi: 6 };

const TRIES = 8;

// --- the season ----------------------------------------------------------

/** Is this date in October? */
export function isHalloweenSeason(today) {
  const [, m, d] = String(today).split('-').map(Number);
  return m === SEASON.month && d >= SEASON.from && d <= SEASON.to;
}

/** The night itself. */
export function isHalloween(today) {
  const [, m, d] = String(today).split('-').map(Number);
  return m === 10 && d === 31;
}

/**
 * Told what day it is, once per boot. Turns the spawner on or off.
 *
 * @param {string} today an ISO date, 'YYYY-MM-DD'
 * @returns {{on: boolean, fresh: boolean, halloween: boolean}} whether the
 *   lanterns are out, whether this is the first look of the day, and whether
 *   it is the 31st
 */
export function noteHalloween(state, today) {
  if (!state.halloween) state.halloween = { on: false, day: null };
  const season = state.halloween;
  season.on = isHalloweenSeason(today);
  const fresh = season.on && season.day !== today;
  if (fresh) season.day = today;
  return { on: season.on, fresh, halloween: isHalloween(today) };
}

// --- the lanterns themselves ---------------------------------------------

export function lanternKey(x, y) { return `${x},${y}`; }

export function lanternAt(state, x, y) {
  return (state.lanterns || {})[lanternKey(x, y)] || null;
}

export function lanternList(state) {
  return Object.entries(state.lanterns || {}).map(([key, l]) => {
    const comma = key.indexOf(',');
    return { x: +key.slice(0, comma), y: +key.slice(comma + 1), ...l };
  });
}

/**
 * Somewhere a lantern can sit: open grass a mushroom could grow on, with no
 * balloon over it, that the farmer can actually walk to.
 *
 * Both halves are borrowed. canSprout is the "nothing is here" test — no
 * object, no crop, no build site, nobody standing on it — and canBalloonSpawn
 * is the "she can reach it" one, route search and all, which also refuses a
 * tile with a balloon or a lantern already on it. Cheap one first: the route
 * search is the dear part.
 */
export function canLanternSpawn(state, x, y) {
  if (!state.grid.inBounds(x, y)) return false;
  if (!canSprout(state, x, y)) return false;
  return canBalloonSpawn(state, x, y);
}

export function spawnLantern(state, x, y, face) {
  state.lanterns = state.lanterns || {};
  state.lanterns[lanternKey(x, y)] = { face };
  emitUnlessSuspended('lantern:appeared', { x, y });
  return true;
}

export function updateLanterns(state) {
  if (!state.halloween?.on) return;
  if (state.tickCount % LANTERN_INTERVAL !== 0) return;

  const plots = Array.from(state.grid.owned);
  if (plots.length === 0) return;
  if (Object.keys(state.lanterns || {}).length >= LANTERN_CAP) return;

  for (let i = 0; i < TRIES; i++) {
    const { px, py } = plotCoords(plots[state.rng.int(plots.length)], state.grid.w);
    const x = px * PLOT + state.rng.int(PLOT);
    const y = py * PLOT + state.rng.int(PLOT);
    if (!canLanternSpawn(state, x, y)) continue;
    spawnLantern(state, x, y, state.rng.int(LANTERN_FACES));
    return;
  }
}

/** Drops lanterns on land no longer owned. */
export function reconcileLanterns(state) {
  state.lanterns = state.lanterns || {};
  let dropped = 0;
  for (const key of Object.keys(state.lanterns)) {
    const comma = key.indexOf(',');
    const x = +key.slice(0, comma);
    const y = +key.slice(comma + 1);
    if (state.grid.inBounds(x, y) && state.grid.isOwned(x, y)) continue;
    delete state.lanterns[key];
    dropped++;
  }
  return { dropped };
}

// --- what is inside ------------------------------------------------------

/**
 * Pops one: a packet of one gourd's seed.
 *
 * Every gourd equally likely. Eight kinds and a month of lanterns at the
 * balloons' pace is plenty for her to have seen them all, and an even draw
 * keeps the ghost pumpkin from being the one she never gets.
 *
 * @returns {Record<string, number>|null} what went in the bag, or null if
 *   there was no lantern there
 */
export function popLantern(state, x, y) {
  if (!lanternAt(state, x, y)) return null;
  delete state.lanterns[lanternKey(x, y)];

  const gourd = GOURDS[state.rng.int(GOURDS.length)];
  const qty = SEEDS.lo + state.rng.int(SEEDS.hi - SEEDS.lo + 1);
  const gained = { [seedIdFor(gourd)]: qty };
  emitUnlessSuspended('lantern:popped', { x, y, gained });
  return gained;
}
