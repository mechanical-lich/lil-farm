// Animals: wandering, feeding, and production.
//
// The rule that shapes all of this (from the design doc): **animals can never
// die.** Going hungry or thirsty only stalls progress toward being harvestable.
// Feed and water them again and production resumes with no lasting penalty.
// This is deliberately unlike crops, which do wither — a seed is cheap, a cow is
// an expensive purchase, and coming back to a dead animal in a game you're meant
// to leave alone for days would feel awful. Do not add a health value here.
//
// Animals are free-range: nothing requires a fence. Fences and gates are how you
// *choose* to keep them near their troughs, since a gate blocks an animal but
// not the farmer.

import { findPath, besideBox } from '../world/pathfind.js';
import { addItem, countItem, removeItem, ITEMS } from './inventory.js';
import { emitUnlessSuspended } from '../engine/events.js';

export const ANIMALS = {
  chicken: {
    name: 'Chicken', price: 120, sprite: 'chicken',
    produces: 'egg', produceTicks: 1200,          // 20 min
  },
  cow: {
    name: 'Cow', price: 500, sprite: 'cow',
    produces: 'milk', produceTicks: 3600,         // 1 hr
  },
};

/** How long one helping of food or water lasts an animal. */
export const FOOD_DURATION = 3600;    // 1 hr
export const WATER_DURATION = 2700;   // 45 min

/** Below this, an animal goes looking for a trough. */
export const SEEK_THRESHOLD = 600;    // 10 min left

/** Helpings a full trough holds, and what one refill costs. */
export const TROUGH_CAPACITY = 24;
export const FEED_COST = 3;           // crops consumed to fill a feed trough

/** Per-tick chance an idle, contented animal ambles a tile. */
const WANDER_CHANCE = 0.06;

export function animalDef(type) { return ANIMALS[type]; }

export function makeAnimal(state, type, x, y) {
  const animal = {
    id: state.nextAnimalId++,
    type,
    x, y, px: x, py: y,
    // They arrive fed and watered; the player shouldn't be punished for the
    // gap between buying an animal and building a trough.
    food: FOOD_DURATION,
    water: WATER_DURATION,
    progress: 0,
    ready: false,
    path: [],
  };
  state.animals.push(animal);
  return animal;
}

export function animalAt(state, x, y) {
  return state.animals.find((a) => a.x === x && a.y === y) || null;
}

export function isHungry(a) { return a.food <= 0; }
export function isThirsty(a) { return a.water <= 0; }

/** True when an animal is missing something and so isn't producing. */
export function isNeglected(a) { return isHungry(a) || isThirsty(a); }

/** Ticks of production still owed, or null once it's ready to collect. */
export function produceRemaining(a) {
  if (a.ready) return null;
  const def = animalDef(a.type);
  return def ? Math.max(0, def.produceTicks - a.progress) : null;
}

/** Collects milk or eggs. Resets the animal to start producing again. */
export function collectFrom(state, animal) {
  if (!animal || !animal.ready) return null;
  const def = animalDef(animal.type);

  addItem(state, def.produces, 1);
  animal.ready = false;
  animal.progress = 0;
  return { [def.produces]: 1 };
}

// --- troughs ------------------------------------------------------------

export function troughList(state) {
  return Object.entries(state.troughs || {}).map(([key, t]) => {
    const comma = key.indexOf(',');
    return { key, x: +key.slice(0, comma), y: +key.slice(comma + 1), ...t };
  });
}

/** Water is free and endless; the work is carrying it, not finding it. */
export function fillWaterTrough(state, x, y) {
  const t = state.troughs[`${x},${y}`];
  if (!t || t.kind !== 'water') return { ok: false };
  t.level = TROUGH_CAPACITY;
  emitUnlessSuspended('world:changed', { x, y });
  return { ok: true };
}

/**
 * Which crop to put in a feed trough: the cheapest one the player has enough
 * of. Picking automatically avoids yet another picker in the UI, and choosing
 * the cheapest means a stray "fill" never burns the eggplants.
 */
export function pickFeedCrop(state) {
  let best = null;
  for (const [id, qty] of Object.entries(state.inventory)) {
    if (qty < FEED_COST) continue;
    const def = ITEMS[id];
    if (!def || !def.sell) continue;
    if (id === 'wood' || id === 'stone' || id === 'fiber') continue;
    if (id === 'egg' || id === 'milk') continue;      // don't feed produce back
    if (!best || def.sell < ITEMS[best].sell) best = id;
  }
  return best;
}

export function fillFeedTrough(state, x, y) {
  const t = state.troughs[`${x},${y}`];
  if (!t || t.kind !== 'food') return { ok: false, reason: 'not a feed trough' };

  const crop = pickFeedCrop(state);
  if (!crop) return { ok: false, reason: `no crop to spare (need ${FEED_COST})` };

  removeItem(state, crop, FEED_COST);
  t.level = TROUGH_CAPACITY;
  t.foodType = crop;
  emitUnlessSuspended('world:changed', { x, y });
  return { ok: true, crop };
}

// --- per-tick -----------------------------------------------------------

export function updateAnimals(state) {
  for (const a of state.animals) {
    a.px = a.x;
    a.py = a.y;

    a.food = Math.max(0, a.food - 1);
    a.water = Math.max(0, a.water - 1);

    // Production runs only while an animal has both. Missing either simply
    // pauses the clock — progress is never lost, and neither is the animal.
    if (!a.ready && !isNeglected(a)) {
      a.progress++;
      const def = animalDef(a.type);
      if (def && a.progress >= def.produceTicks) {
        a.ready = true;
        emitUnlessSuspended('animal:ready', { id: a.id, type: a.type, x: a.x, y: a.y });
      }
    }

    moveAnimal(state, a);
  }
}

function moveAnimal(state, a) {
  // Already walking somewhere: keep going.
  if (a.path && a.path.length > 0) {
    const next = a.path.shift();
    if (state.grid.isWalkable(next.x, next.y, 'animal')) {
      a.x = next.x;
      a.y = next.y;
      return;
    }
    a.path = [];   // something was built across the route
  }

  // Drink first: thirst runs out sooner than hunger.
  const wants = a.water <= SEEK_THRESHOLD ? 'water'
    : a.food <= SEEK_THRESHOLD ? 'food'
      : null;

  if (wants) {
    const trough = troughBeside(state, a, wants);
    if (trough) { drinkOrEat(state, a, trough, wants); return; }
    if (seekTrough(state, a, wants)) return;
  }

  wander(state, a);
}

/** A stocked trough of the right kind that the animal is standing next to. */
function troughBeside(state, a, kind) {
  for (const t of troughList(state)) {
    if (t.kind !== kind || (t.level || 0) <= 0) continue;
    if (besideBox(t.x, t.y, 2, 1, a.x, a.y)) return t;
  }
  return null;
}

function drinkOrEat(state, a, trough, kind) {
  const t = state.troughs[trough.key];
  if (!t || (t.level || 0) <= 0) return;

  t.level -= 1;
  if (kind === 'water') a.water = WATER_DURATION;
  else a.food = FOOD_DURATION;

  emitUnlessSuspended('world:changed', { x: trough.x, y: trough.y });
}

/** Routes toward the nearest stocked trough it can actually reach. */
function seekTrough(state, a, kind) {
  const candidates = troughList(state)
    .filter((t) => t.kind === kind && (t.level || 0) > 0)
    .sort((p, q) => (Math.abs(p.x - a.x) + Math.abs(p.y - a.y))
                  - (Math.abs(q.x - a.x) + Math.abs(q.y - a.y)));

  // Only try the closest few: a fenced-out animal shouldn't scan the whole
  // farm every tick, and it will try again next tick anyway.
  for (const t of candidates.slice(0, 3)) {
    const path = findPath(state.grid, { x: a.x, y: a.y }, { x: t.x, y: t.y },
      { actor: 'animal', adjacent: true, w: 2, h: 1 });
    if (path && path.length > 0) { a.path = path; return true; }
    if (path && path.length === 0) return false;   // already there
  }
  return false;
}

function wander(state, a) {
  if (!state.rng.chance(WANDER_CHANCE)) return;
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const [dx, dy] = dirs[state.rng.int(4)];
  const nx = a.x + dx;
  const ny = a.y + dy;
  if (!state.grid.isWalkable(nx, ny, 'animal')) return;
  a.x = nx;
  a.y = ny;
}
