// Crops: watering starts growth, and ripe crops spoil if left unpicked.
//
// The rules (from the design doc):
//   1. A seed does nothing until it is watered. Watering starts the clock; an
//      unwatered seed waits indefinitely as a seedling and is never lost.
//   2. Once fully grown, a crop must be harvested within 48 hours or it spoils
//      and withers.
//
// Rule 1 is deliberately forgiving about *when* you water, because planting a
// large field takes the farmer real time — an earlier design killed a crop that
// went unwatered too long, which meant a big field died before the farmer could
// finish planting it. Nothing is lost by planting ambitiously now; the pressure
// sits at the harvest end instead, where the player can see a ripe field.
//
// Watering is tracked on the crop, not the soil, so a tile drying out does not
// stop a plant that is already growing. Soil wetness is the player's visual cue
// for "this bed has been seen to".

import { GROUND, isTilled } from '../world/tiledefs.js';
import { addItem } from './inventory.js';
import { emitUnlessSuspended } from '../engine/events.js';

/**
 * growTicks is the full seedling-to-ripe life cycle in seconds, counted only
 * while the crop is watered.
 *
 * Balance shape: short crops pay better *per minute*, long crops pay far better
 * *per planting*. That's deliberate for a game you check on twice a day — a
 * 4-minute carrot is great while you're watching and wastes eleven hours while
 * you're not, so the long crops have to be the obvious choice for an overnight
 * field. Profit per minute slides from ~4.3 (carrot) down to ~2.0 (eggplant),
 * while profit per planting climbs from ~17 to ~180.
 */
export const CROPS = {
  carrot:   { name: 'Carrot',   growTicks: 480,  seedCost: 8,  yield: [2, 3] },   // 8 min
  wheat:    { name: 'Wheat',    growTicks: 600,  seedCost: 6,  yield: [2, 3] },   // 10 min
  corn:     { name: 'Corn',     growTicks: 600,  seedCost: 14, yield: [3, 4] },   // 10 min
  tomato:   { name: 'Tomato',   growTicks: 1200, seedCost: 20, yield: [3, 5] },   // 20 min
  cabbage:  { name: 'Cabbage',  growTicks: 2400, seedCost: 30, yield: [3, 4] },   // 40 min
  eggplant: { name: 'Eggplant', growTicks: 5400, seedCost: 45, yield: [4, 6] },   // 90 min
};

/** How long watered soil stays visibly wet before drying out again. */
export const SOIL_DRY_TICKS = 420;

/**
 * How long a fully grown crop survives before it spoils. Deliberately long: the
 * point is to stop a farm running itself forever unattended, not to punish
 * someone for sleeping.
 */
export const SPOIL_TICKS = 48 * 60 * 60;

export const STAGE_COUNT = 3;   // seedling, young, ripe

export function cropDef(type) { return CROPS[type]; }
export function seedIdFor(type) { return `${type}_seed`; }
export function isSeedId(id) { return id.endsWith('_seed'); }
export function cropFromSeedId(id) { return id.replace(/_seed$/, ''); }

export function tileKey(x, y) { return `${x},${y}`; }

export function cropAt(state, x, y) {
  return state.crops[tileKey(x, y)] || null;
}

/**
 * Plants a seed. The caller is responsible for having removed it from the bag.
 */
export function plantCrop(state, x, y, type) {
  const def = cropDef(type);
  if (!def) return null;

  // A seed going into damp soil is already watered — the water is right there.
  //
  // This is what collapses planting from three passes to two. It used to be
  // till, plant, then water, with the watering pass trailing a field's length
  // behind the planting one and every seed sitting stalled until it arrived.
  // Now the player waters the bed and plants into it, and each seed starts
  // growing the moment it goes in, tile by tile. Planting into dry soil still
  // works exactly as before — it just waits for the can, as it always did.
  const wet = state.grid.getGround(x, y) === GROUND.TILLED_WET;

  const crop = {
    type,
    age: 0,
    watered: wet,     // gates growth entirely; see updateCrops
    ripeAt: null,     // tick the crop finished growing, for spoilage
    dead: false,
  };
  state.crops[tileKey(x, y)] = crop;
  emitUnlessSuspended('world:changed', { x, y });
  return crop;
}

/** Waters the crop on a tile and darkens the soil. */
export function waterTile(state, x, y) {
  const crop = cropAt(state, x, y);
  if (crop && !crop.dead) crop.watered = true;

  if (isTilled(state.grid.getGround(x, y))) {
    state.grid.setGround(x, y, GROUND.TILLED_WET);
    state.wetUntil[tileKey(x, y)] = state.tickCount + SOIL_DRY_TICKS;
  }
  emitUnlessSuspended('world:changed', { x, y });
}

/** True once a crop has reached its final stage and can be picked. */
export function isRipe(crop) {
  if (!crop || crop.dead) return false;
  const def = cropDef(crop.type);
  return def ? crop.age >= def.growTicks : false;
}

/** 0-based sprite stage index for a living crop. */
export function cropStage(crop) {
  const def = cropDef(crop.type);
  if (!def) return 0;
  const pct = Math.min(1, crop.age / def.growTicks);
  return Math.min(STAGE_COUNT - 1, Math.floor(pct * STAGE_COUNT));
}

/** True when a crop is planted but has never been watered, so it isn't growing. */
export function isStalled(crop) {
  return !!crop && !crop.dead && !crop.watered;
}

/**
 * Ticks left before a ripe crop spoils, or null if it isn't ripe (or is already
 * gone). Used for the on-tile warning and the away-summary.
 */
export function spoilRemaining(state, crop) {
  if (!crop || crop.dead || crop.ripeAt == null) return null;
  return Math.max(0, crop.ripeAt + SPOIL_TICKS - state.tickCount);
}

export function harvestCrop(state, x, y) {
  const key = tileKey(x, y);
  const crop = state.crops[key];
  if (!crop) return null;

  // Clearing a dead plant just tidies the bed; there is nothing to gain.
  if (crop.dead) {
    delete state.crops[key];
    emitUnlessSuspended('world:changed', { x, y });
    return {};
  }
  if (!isRipe(crop)) return null;

  const def = cropDef(crop.type);
  const [lo, hi] = def.yield;
  const qty = lo + state.rng.int(hi - lo + 1);
  addItem(state, crop.type, qty);

  delete state.crops[key];
  // Harvesting works the bed back to plain tilled soil, ready to replant.
  state.grid.setGround(x, y, GROUND.TILLED);
  delete state.wetUntil[key];
  emitUnlessSuspended('world:changed', { x, y });

  return { [crop.type]: qty };
}

/** One tick of growth for every planted tile, plus spoiling and soil drying. */
export function updateCrops(state) {
  for (const [key, crop] of Object.entries(state.crops)) {
    if (crop.dead) continue;

    const def = cropDef(crop.type);
    if (!def) continue;

    // An unwatered seed simply waits. It never ages and is never lost, so a
    // field planted faster than the farmer can water it is in no danger.
    if (!crop.watered) continue;

    if (crop.age < def.growTicks) {
      crop.age++;
      if (crop.age >= def.growTicks) {
        crop.ripeAt = state.tickCount;
        const [x, y] = key.split(',').map(Number);
        emitUnlessSuspended('crop:ripe', { x, y, type: crop.type });
      }
      continue;
    }

    // Ripe. Crops left standing too long spoil.
    // ripeAt may be missing on a farm saved before spoiling existed; treat the
    // first tick we see it as the moment it ripened rather than losing it.
    if (crop.ripeAt == null) crop.ripeAt = state.tickCount;

    if (state.tickCount - crop.ripeAt >= SPOIL_TICKS) {
      crop.dead = true;
      const [x, y] = key.split(',').map(Number);
      emitUnlessSuspended('crop:died', { x, y, type: crop.type });
    }
  }

  dryOutSoil(state);
}

function dryOutSoil(state) {
  for (const [key, until] of Object.entries(state.wetUntil)) {
    if (state.tickCount < until) continue;
    delete state.wetUntil[key];
    const [x, y] = key.split(',').map(Number);
    if (state.grid.getGround(x, y) === GROUND.TILLED_WET) {
      state.grid.setGround(x, y, GROUND.TILLED);
      emitUnlessSuspended('world:changed', { x, y });
    }
  }
}
