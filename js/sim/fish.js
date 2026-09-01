// Fishing: the third thing you find rather than make.
//
// Crops you make happen, animals you look after, mushrooms and flowers you
// stumble on. Fish are the same family as the last two — something spotted and
// taken — but they are the first that needs a place rather than a walk: water,
// which until now existed for ducks to swim on and animals to drink from.
//
// A fish is a shadow under the surface. The farmer cannot swim (see
// grid.isWalkable), so he works one from the bank, casting to a tile he will
// never stand on. That is the one genuinely new shape here: every other task in
// the game is done from the tile itself or from the square beside it, and this
// one is done from up to CAST_RANGE tiles away. The task carries the bank tile
// it is to be worked from — see standFor — so the router and the arrival check
// still agree without either of them learning about water.
//
// The sheet is five species in two sizes, then the things that have no business
// in a farm pond at all. Those are deliberately almost impossible: a shark in
// the duck pond should be a story, not a Tuesday.
//
// Hard rules, same as everything in sim/: no DOM, no Math.random(), no
// Date.now(). Catch-up replays this thousands of times over.

import { emitUnlessSuspended } from '../engine/events.js';
import { isWater } from '../world/tiledefs.js';
import { findPath } from '../world/pathfind.js';
import { PLOT, plotCoords } from '../world/land.js';
import { addItem } from './inventory.js';

/**
 * What swims here.
 *
 * `sprite` is the row on assets/animals/aquatic.png. `weight` is a spawn
 * weight, not a percentage, so adding a fish means picking one number rather
 * than rebalancing every other. The small ones are the everyday catch and the
 * big ones the same fish grown up, which is why they share a name — a journal
 * that reads "bass" and "big bass" says what a size pair is for without needing
 * a word of explanation.
 *
 * The rarity and price ladder is tied to the *sprite*, not to the species: the
 * smaller five are the common catch and the larger five the prize, whatever
 * they are called. So renaming a fish moves the name and nothing else, which is
 * how bass, salmon and catfish came to sit where they do.
 */
export const FISH = {
  bass: { name: 'Bass', sprite: 5, weight: 22, sell: 18 },
  trout: { name: 'Trout', sprite: 6, weight: 20, sell: 22 },
  salmon: { name: 'Salmon', sprite: 7, weight: 18, sell: 26 },
  catfish: { name: 'Catfish', sprite: 8, weight: 16, sell: 30 },
  carp: { name: 'Carp', sprite: 9, weight: 14, sell: 34 },

  big_bass: { name: 'Big bass', sprite: 0, weight: 7, sell: 55 },
  big_trout: { name: 'Big trout', sprite: 1, weight: 6, sell: 65 },
  big_salmon: { name: 'Big salmon', sprite: 2, weight: 5, sell: 80 },
  big_catfish: { name: 'Big catfish', sprite: 3, weight: 4, sell: 95 },
  big_carp: { name: 'Big carp', sprite: 4, weight: 3, sell: 120 },

  crab: { name: 'Crab', sprite: 13, weight: 6, sell: 70 },

  // The ones that make no sense whatsoever in a hand-dug pond, which is the
  // point of them. One in a few hundred casts, so landing one is worth telling
  // somebody about.
  reef_shark: { name: 'Reef shark', sprite: 10, weight: 1, sell: 400 },
  great_white: { name: 'Great white', sprite: 11, weight: 1, sell: 600 },
  dolphin: { name: 'Dolphin', sprite: 12, weight: 1, sell: 500 },
};

export const FISH_IDS = Object.keys(FISH);

export function fishDef(id) { return FISH[id] || null; }

/** How far the farmer will cast. Beyond this a fish is somebody else's. */
export const CAST_RANGE = 5;

/** Ticks between spawn attempts. Rarer than mushrooms: water is scarcer. */
export const FISH_INTERVAL = 420;

/**
 * Ceiling, as a fraction of the water you own.
 *
 * Measured against water rather than land, because a farm with one puddle and a
 * farm with a lake should not have the same number of fish in them. Generous
 * next to mushrooms — water is a small part of most farms, and a pond with
 * nothing in it is not worth walking to.
 */
export const FISH_MAX_FRACTION = 0.25;

/**
 * The most fish that will ever be waiting, however much water there is.
 *
 * Fishing queues no work by itself — nothing in the simulation ever adds a
 * task, only the player's taps do — so coming home can never mean a backlog of
 * jobs. But a lake at a flat quarter-full is a different kind of backlog: a
 * 12x12 pond came out at thirty-six shadows after a week away, and thirty-six
 * things that each look like they want tapping is a chore list whatever the
 * queue says.
 *
 * Six is comfortably under the point where a pond starts to read as work. It is
 * also why the fraction stays: a puddle should still hold one or two rather
 * than always the same six as a lake.
 */
export const FISH_HARD_CAP = 6;

const TRIES = 6;

export function fishKey(x, y) { return `${x},${y}`; }

export function fishAt(state, x, y) {
  const id = (state.fish || {})[fishKey(x, y)];
  return id ? { id, ...FISH[id] } : null;
}

/** Every fish in the water, each with the tile it is under. */
export function fishList(state) {
  return Object.entries(state.fish || {}).map(([key, id]) => {
    const comma = key.indexOf(',');
    return { x: +key.slice(0, comma), y: +key.slice(comma + 1), id, ...FISH[id] };
  });
}

/** Owned water with nothing already in it. */
export function canFishSpawn(state, x, y) {
  const grid = state.grid;
  if (!grid.inBounds(x, y)) return false;
  if (!grid.isOwned(x, y)) return false;
  if (!isWater(grid.getGround(x, y))) return false;
  return !(state.fish || {})[fishKey(x, y)];
}

/** How much owned water there is, which is what the cap is measured against. */
export function waterTiles(state) {
  let n = 0;
  const grid = state.grid;
  for (const plot of grid.owned) {
    const { px, py } = plotCoords(plot, grid.w);
    for (let y = 0; y < PLOT; y++) {
      for (let x = 0; x < PLOT; x++) {
        if (isWater(grid.getGround(px * PLOT + x, py * PLOT + y))) n++;
      }
    }
  }
  return n;
}

export function fishCap(state) {
  return Math.min(Math.floor(waterTiles(state) * FISH_MAX_FRACTION), FISH_HARD_CAP);
}

export function updateFish(state) {
  if (state.tickCount % FISH_INTERVAL !== 0) return;

  const plots = Array.from(state.grid.owned);
  if (plots.length === 0) return;
  if (Object.keys(state.fish || {}).length >= fishCap(state)) return;

  for (let i = 0; i < TRIES; i++) {
    const { px, py } = plotCoords(plots[state.rng.int(plots.length)], state.grid.w);
    const x = px * PLOT + state.rng.int(PLOT);
    const y = py * PLOT + state.rng.int(PLOT);
    if (!canFishSpawn(state, x, y)) continue;

    spawnFish(state, x, y, rollFish(state));
    return;
  }
}

/** Weighted pick across the species. */
export function rollFish(state) {
  const total = FISH_IDS.reduce((n, id) => n + FISH[id].weight, 0);
  let roll = state.rng.int(total);
  for (const id of FISH_IDS) {
    roll -= FISH[id].weight;
    if (roll < 0) return id;
  }
  return FISH_IDS[0];
}

/**
 * Puts one in the water.
 *
 * Refuses an id that is not on the list. A fish whose species does not exist
 * has no sprite to draw and no name to offer, so it becomes an invisible thing
 * occupying a tile that can never be fished — silent, and exactly what a
 * renamed species leaves behind.
 *
 * @returns {string|null} the id, or null if there is no such fish
 */
export function spawnFish(state, x, y, id) {
  if (!FISH[id]) return null;
  state.fish = state.fish || {};
  state.fish[fishKey(x, y)] = id;
  emitUnlessSuspended('fish:appeared', { x, y, id });
  return id;
}

/**
 * Clears out fish and journal entries whose species no longer exists.
 *
 * Renaming a fish is a one-word change to the table above, and a farm saved
 * before it keeps the old word — which would otherwise sit in the water for
 * ever as an invisible fish nobody can catch, holding a tile against the cap.
 * Run on load, where a scan of a few dozen entries costs nothing.
 *
 * @returns {{dropped: number, forgotten: number}} what had to be cleared
 */
export function reconcileFish(state) {
  state.fish = state.fish || {};
  state.fishJournal = state.fishJournal || {};

  let dropped = 0;
  for (const [key, id] of Object.entries(state.fish)) {
    if (FISH[id]) continue;
    delete state.fish[key];
    dropped++;
  }

  let forgotten = 0;
  for (const id of Object.keys(state.fishJournal)) {
    if (FISH[id]) continue;
    delete state.fishJournal[id];
    forgotten++;
  }

  return { dropped, forgotten };
}

/**
 * How many banks to try before giving up on a fish.
 *
 * Each try is a path search, and a search that fails costs its whole budget —
 * so checking all sixty-odd tiles within a cast would be far too slow for
 * something that runs on every tap and every tile of a drag. Nearest-first with
 * an early exit means the ordinary case, where the closest bank is simply
 * reachable, costs exactly one search.
 */
const STAND_TRIES = 8;

/**
 * The bank tile the farmer would fish this one from.
 *
 * The nearest place he can actually *get to* within a cast — which is not the
 * same as the nearest place he could stand on. An island in the middle of a
 * pond is walkable ground he can never reach, and picking it left the farmer
 * announcing "can't reach that salmon" for ever: the task was created, routed
 * to the island, and failed on arrival every retry.
 *
 * So each candidate is checked with a real route from where he is now. Ordered
 * nearest-first, so the answer is still the closest usable bank.
 *
 * @returns {{x: number, y: number}|null} null if no bank in reach can be got to
 */
export function standFor(state, x, y, from = state.farmer) {
  const candidates = [];
  for (let dy = -CAST_RANGE; dy <= CAST_RANGE; dy++) {
    for (let dx = -CAST_RANGE; dx <= CAST_RANGE; dx++) {
      const d = Math.abs(dx) + Math.abs(dy);
      if (d === 0 || d > CAST_RANGE) continue;
      const sx = x + dx;
      const sy = y + dy;
      if (!state.grid.isWalkable(sx, sy, 'farmer')) continue;
      candidates.push({ d, x: sx, y: sy });
    }
  }
  candidates.sort((a, b) => a.d - b.d);

  for (const c of candidates.slice(0, STAND_TRIES)) {
    // A zero-length path counts: he is already standing there.
    const path = findPath(state.grid, { x: from.x, y: from.y }, { x: c.x, y: c.y },
      { actor: 'farmer' });
    if (path) return { x: c.x, y: c.y };
  }
  return null;
}

/**
 * Lands one. Returns what went in the bag, so the task pipeline reports it the
 * same way it reports a harvest.
 */
export function landFish(state, x, y) {
  const found = fishAt(state, x, y);
  if (!found) return null;

  delete state.fish[fishKey(x, y)];
  addItem(state, itemFor(found.id), 1);

  const first = !caughtBefore(state, found.id);
  record(state, found.id);
  emitUnlessSuspended('fish:caught', {
    x, y, id: found.id, name: found.name, sprite: found.sprite, first,
  });
  return { [itemFor(found.id)]: 1 };
}

/** The bag id for a species. Prefixed so nothing collides with a crop. */
export function itemFor(id) { return `fish_${id}`; }

// --- the journal ---------------------------------------------------------

export function caughtBefore(state, id) {
  return ((state.fishJournal || {})[id] || 0) > 0;
}

export function caughtCount(state, id) {
  return (state.fishJournal || {})[id] || 0;
}

function record(state, id) {
  state.fishJournal = state.fishJournal || {};
  state.fishJournal[id] = (state.fishJournal[id] || 0) + 1;
}

export function kindsCaught(state) {
  return FISH_IDS.filter((id) => caughtBefore(state, id)).length;
}

/** Every species with what is known about it, in sheet order. */
export function journalRows(state) {
  return FISH_IDS.map((id) => ({
    id,
    name: FISH[id].name,
    sprite: FISH[id].sprite,
    caught: caughtCount(state, id),
    sell: FISH[id].sell,
  }));
}
