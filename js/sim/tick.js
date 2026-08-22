// One simulation tick. Everything time-based in the game happens here.
//
// Hard rules for this file and everything it calls:
//   - No DOM access, no rendering, no Math.random(), no Date.now().
//   - Pure function of (state) -> mutated state.
// Catch-up replays this thousands of times in a row; anything that breaks those
// rules will either be slow, non-deterministic, or crash offline.

import { TICK_MS } from '../config.js';
import { updateFarmer } from './farmer.js';
import { followTargets } from './tasks.js';
import { updateCrops } from './crops.js';
import { updateAnimals } from './animals.js';
import { updateHands } from './farmhand.js';
import { updateWeeds } from './weeds.js';
import { updateMushrooms } from './mushrooms.js';
import { updateMarket } from './market.js';
import { updateFlowers, updateBreeding } from './flowers.js';

/** @param {object} state */
export function tick(state) {
  state.tickCount++;
  state.lastTickTime += TICK_MS;

  // Before the farmer moves, so work aimed at an animal is pointing at where
  // that animal actually is this tick.
  followTargets(state);
  updateFarmer(state);
  updateCrops(state);
  updateAnimals(state);
  updateHands(state);
  updateWeeds(state);
  updateMushrooms(state);
  updateFlowers(state);
  updateBreeding(state);
  updateMarket(state);
}
