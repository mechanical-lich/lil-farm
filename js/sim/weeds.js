// Weeds coming back.
//
// Without this a farm is a one-way ratchet: clear it once and it stays cleared
// forever, so land you've tidied stops asking anything of you. Regrowth gives
// the farm a standing chore that isn't just "expand", and it makes the land you
// bought cost something to keep — the more you own, the more there is to tend.
//
// Three properties matter, and they're what the tuning below is shaped around:
//
//   - It has to be **self-limiting**. Coming back after a week to a farm buried
//     in weeds would be a punishment for leaving, and this is a game built to be
//     left alone. Weeds stop at a fraction of your land, so the worst case is
//     always the same modest tidy-up.
//   - It has to be **cheap to replay**. Catch-up runs this up to 604,800 times
//     in a row, so it only does real work on one tick in WEED_INTERVAL.
//   - It has to be **deterministic**. state.rng only, never Math.random(),
//     or catching up twice would produce two different farms.
//
// The same three properties will hold for mushrooms later, which want exactly
// this shape: a slow, capped, seeded scatter over open grass.

import { emitUnlessSuspended } from '../engine/events.js';
import { GEN } from '../config.js';
import { GROUND, OBJ } from '../world/tiledefs.js';
import { PLOT, plotCoords } from '../world/land.js';
import { cropAt } from './crops.js';

/** Ticks between attempts. One every two minutes is a background nuisance. */
export const WEED_INTERVAL = 120;

/**
 * Ceiling on weeds, as a fraction of the tiles you own.
 *
 * Tied to the density worldgen scatters them at, so the ceiling is "as weedy as
 * the land was when you found it" — a farm settles back to the state it started
 * in and no further. Because worldgen's weeds count toward it, a brand-new farm
 * is already at its cap: weeds return to *replace* what you clear rather than
 * piling up on top of it.
 */
export const WEED_MAX_FRACTION = GEN.weed;

/** Attempts per go before giving up, so a crowded farm doesn't spin. */
const TRIES = 4;

export function updateWeeds(state) {
  if (state.tickCount % WEED_INTERVAL !== 0) return;

  const plots = Array.from(state.grid.owned);
  if (plots.length === 0) return;

  const cap = Math.floor(plots.length * PLOT * PLOT * WEED_MAX_FRACTION);
  if (countWeeds(state) >= cap) return;

  for (let i = 0; i < TRIES; i++) {
    // Pick a plot first, then a tile inside it: uniform across owned land
    // without building a list of every tile every time.
    const { px, py } = plotCoords(plots[state.rng.int(plots.length)], state.grid.w);
    const x = px * PLOT + state.rng.int(PLOT);
    const y = py * PLOT + state.rng.int(PLOT);

    if (!canSprout(state, x, y)) continue;
    state.grid.setObject(x, y, OBJ.WEED);
    emitUnlessSuspended('weed:grown', { x, y });
    return;
  }
}

/**
 * Weeds only take open grass. Not beds, not roads, not anything already
 * standing there — a weed appearing in a planted row would read as a bug, and
 * the whole feature has to stay obviously fair.
 */
export function canSprout(state, x, y) {
  const grid = state.grid;
  if (!grid.isOwned(x, y)) return false;
  if (grid.getGround(x, y) !== GROUND.GRASS) return false;
  if (grid.getObject(x, y) !== OBJ.NONE) return false;
  if (cropAt(state, x, y)) return false;
  // Not underfoot: sprouting on top of the farmer or an animal looks wrong even
  // though weeds don't block anyone.
  if (state.farmer.x === x && state.farmer.y === y) return false;
  return !(state.animals || []).some((a) => a.x === x && a.y === y);
}

/**
 * Weeds on land you own. Deliberately not the whole map: worldgen scatters
 * weeds everywhere, so counting all of them would put a new farm hundreds over
 * its cap and nothing would ever grow back.
 */
export function countWeeds(state) {
  const grid = state.grid;
  let n = 0;
  for (const idx of grid.owned) {
    const { px, py } = plotCoords(idx, grid.w);
    for (let y = py * PLOT; y < (py + 1) * PLOT; y++) {
      for (let x = px * PLOT; x < (px + 1) * PLOT; x++) {
        if (grid.getObject(x, y) === OBJ.WEED) n++;
      }
    }
  }
  return n;
}
