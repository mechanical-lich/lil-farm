// Thanksgiving: fallen leaves to collect, and a turkey a day.
//
// November's event, built the way October's is (see sim/lanterns.js): for the
// whole of the month, leaves off a dozen real trees turn
// up on the farm, the farmer walks over and picks one up, and it goes in the
// Events journal. A leaf is only a keepsake — nothing goes in the bag — so the
// collection *is* the reward: one of every tree, then a pressed handful of
// each.
//
// The other half of the event is the turkeys: one wanders on each day of the
// month, to be won over like any wild animal. That half lives in
// sim/wildlife.js (see turkeyOfTheDay), because it is wildlife in every respect
// but when it arrives; this file only says whether today's is still owed.
//
// The same two halves as the lanterns:
//
//   * Whether it is the season is decided at boot, from the real date, because
//     sim/ may not read a clock. main.js calls noteThanksgiving with today's
//     date.
//   * The spawning runs in the tick, off the flag that set. Catch-up drops
//     leaves for the time she was away exactly as if she'd been watching.
//
// A leaf lies *on* the ground, so it wants what a lantern wants: open grass
// with nothing on it that the farmer can walk to. And the things that turn up
// on open grass on their own check for one, so nothing grows up through it.
//
// Like the balloons and the lanterns, a leaf still lying there when December
// comes stays. Nothing rakes them up.
//
// Hard rules, same as everything in sim/: no DOM, no Math.random(), no
// Date.now(). The date functions here take the date as an argument.

import { emitUnlessSuspended } from '../engine/events.js';
import { PLOT, plotCoords } from '../world/land.js';
import { canBalloonSpawn } from './balloons.js';
import { canSprout } from './mushrooms.js';

/**
 * The trees, in the column order of assets/flora/leaves.png. A leaf on the
 * farm and a line in the journal are both saved by `id`, so: rename a tree
 * freely, never change an id, and add new ones at the end.
 * tools/make-thanksgiving.mjs draws them, and a test holds its list to this.
 */
export const LEAF_KINDS = {
  sugarmaple: { name: 'Sugar maple' },
  redoak: { name: 'Red oak' },
  whiteoak: { name: 'White oak' },
  ginkgo: { name: 'Ginkgo' },
  aspen: { name: 'Quaking aspen' },
  birch: { name: 'Paper birch' },
  sweetgum: { name: 'Sweetgum' },
  sassafras: { name: 'Sassafras' },
  tuliptree: { name: 'Tulip tree' },
  beech: { name: 'American beech' },
  dogwood: { name: 'Flowering dogwood' },
  willow: { name: 'Weeping willow' },
};

export const LEAF_IDS = Object.keys(LEAF_KINDS);

/** Ticks between spawn attempts. A little quicker than the lanterns: see LEAF_CAP. */
export const LEAF_INTERVAL = 200;

/**
 * How many may be lying about at once, however long she has been away.
 *
 * More than the lanterns' four, because a leaf is all there is to it — there
 * is no seed inside to grow for the rest of the month — and because there are
 * twelve trees to find five leaves of each from.
 */
export const LEAF_CAP = 6;

const TRIES = 8;

// --- the season ----------------------------------------------------------

/**
 * The day of November that Thanksgiving falls on: the fourth Thursday.
 *
 * Date.UTC here is arithmetic on the numbers handed in, not a look at the
 * clock — the same use sim/achievements.js makes of it for the day streak.
 */
export function thanksgivingDay(year) {
  const first = new Date(Date.UTC(year, 10, 1)).getUTCDay();   // 0 is Sunday
  return 1 + ((4 - first + 7) % 7) + 21;
}

const parts = (today) => String(today).split('-').map(Number);

/** The season: every day of November, inclusive — like the lanterns' October. */
export const SEASON = { month: 11, from: 1, to: 30 };

/**
 * Is this date in the season?
 *
 * The whole month, not just the run-up: Thanksgiving falls anywhere from the
 * 22nd to the 28th, and an event that packed up the morning after would be
 * gone before the long weekend was.
 */
export function isThanksgivingSeason(today) {
  const [, m, d] = parts(today);
  return m === SEASON.month && d >= SEASON.from && d <= SEASON.to;
}

/** The day itself. */
export function isThanksgiving(today) {
  const [y, m, d] = parts(today);
  return m === 11 && d === thanksgivingDay(y);
}

/**
 * Told what day it is, once per boot. Turns the leaves on or off, and on the
 * first look of each day in the season, says a turkey is owed.
 *
 * @param {string} today an ISO date, 'YYYY-MM-DD'
 * @returns {{on: boolean, fresh: boolean, thanksgiving: boolean}} whether the
 *   event is running, whether this is the first look of the day, and whether
 *   it is Thanksgiving itself
 */
export function noteThanksgiving(state, today) {
  if (!state.thanksgiving) state.thanksgiving = { on: false, day: null, turkeyDue: false };
  const season = state.thanksgiving;
  season.on = isThanksgivingSeason(today);
  const fresh = season.on && season.day !== today;
  if (fresh) {
    season.day = today;
    season.turkeyDue = true;
  }
  // A turkey still owed when the month ends never comes.
  if (!season.on) season.turkeyDue = false;
  return { on: season.on, fresh, thanksgiving: isThanksgiving(today) };
}

// --- the leaves themselves -----------------------------------------------

export function leafKey(x, y) { return `${x},${y}`; }

export function leafAt(state, x, y) {
  return (state.leaves || {})[leafKey(x, y)] || null;
}

export function leafList(state) {
  return Object.entries(state.leaves || {}).map(([key, l]) => {
    const comma = key.indexOf(',');
    return { x: +key.slice(0, comma), y: +key.slice(comma + 1), ...l };
  });
}

/** What to call the leaf of this tree: "sugar maple leaf". */
export function leafName(kind) {
  const def = LEAF_KINDS[kind];
  return def ? `${def.name.toLowerCase()} leaf` : 'leaf';
}

/**
 * Somewhere a leaf can land: the lanterns' own test, borrowed whole. canSprout
 * is "nothing is here" and canBalloonSpawn is "she can reach it" — which also
 * refuses a tile with a balloon, a lantern or another leaf already on it.
 * Cheap one first: the route search is the dear part.
 */
export function canLeafFall(state, x, y) {
  if (!state.grid.inBounds(x, y)) return false;
  if (!canSprout(state, x, y)) return false;
  return canBalloonSpawn(state, x, y);
}

export function dropLeaf(state, x, y, kind) {
  if (!LEAF_KINDS[kind]) return false;
  state.leaves = state.leaves || {};
  state.leaves[leafKey(x, y)] = { kind };
  emitUnlessSuspended('leaf:fell', { x, y, kind });
  return true;
}

export function updateLeaves(state) {
  if (!state.thanksgiving?.on) return;
  if (state.tickCount % LEAF_INTERVAL !== 0) return;

  const plots = Array.from(state.grid.owned);
  if (plots.length === 0) return;
  if (Object.keys(state.leaves || {}).length >= LEAF_CAP) return;

  for (let i = 0; i < TRIES; i++) {
    const { px, py } = plotCoords(plots[state.rng.int(plots.length)], state.grid.w);
    const x = px * PLOT + state.rng.int(PLOT);
    const y = py * PLOT + state.rng.int(PLOT);
    if (!canLeafFall(state, x, y)) continue;
    // Every tree equally likely, so there is no one leaf she never finds.
    dropLeaf(state, x, y, LEAF_IDS[state.rng.int(LEAF_IDS.length)]);
    return;
  }
}

/** Drops leaves on land no longer owned, and any off a tree that no longer exists. */
export function reconcileLeaves(state) {
  state.leaves = state.leaves || {};
  let dropped = 0;
  for (const key of Object.keys(state.leaves)) {
    const comma = key.indexOf(',');
    const x = +key.slice(0, comma);
    const y = +key.slice(comma + 1);
    const known = !!LEAF_KINDS[state.leaves[key]?.kind];
    if (known && state.grid.inBounds(x, y) && state.grid.isOwned(x, y)) continue;
    delete state.leaves[key];
    dropped++;
  }
  return { dropped };
}

/**
 * Picks one up.
 *
 * @returns {string|null} which tree it was off, or null if there was no leaf
 */
export function collectLeaf(state, x, y) {
  const leaf = leafAt(state, x, y);
  if (!leaf) return null;
  delete state.leaves[leafKey(x, y)];
  return leaf.kind;
}
