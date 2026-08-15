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
import { OBJ } from '../world/tiledefs.js';
import { addItem, countItem, removeItem, ITEMS } from './inventory.js';
import { CROPS } from './crops.js';
import { emitUnlessSuspended } from '../engine/events.js';

/**
 * `laysOnGround` is the difference between the two: a chicken with food, water
 * and time drops an egg where it stands, to be picked up like anything else
 * lying in the grass. A cow is milked directly, which is what you'd expect of
 * a cow. Both still need feeding to make any progress at all.
 */
export const ANIMALS = {
  chicken: {
    name: 'Chicken', price: 120, sprite: 'chicken',
    produces: 'egg', produceTicks: 1200,          // 20 min
    laysOnGround: true,
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
    facing: 'right',
    path: [],
  };
  state.animals.push(animal);
  return animal;
}

export function isHungry(a) { return a.food <= 0; }
export function isThirsty(a) { return a.water <= 0; }

/** True when an animal is missing something and so isn't producing. */
export function isNeglected(a) { return isHungry(a) || isThirsty(a); }

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
 * What goes into a feed trough, chosen automatically so the player doesn't need
 * yet another picker.
 *
 * Home-grown crops first, cheapest of them, so a stray "fill" never burns the
 * eggplants. **Bought feed is only the fallback** — it costs more than the crops
 * it replaces, and exists so an empty larder doesn't mean hungry animals.
 *
 * Testing membership against CROPS rather than a list of exclusions means wood,
 * stone, eggs, milk and feed itself are all ineligible without naming them.
 */
export function pickFeed(state) {
  let best = null;
  for (const [id, qty] of Object.entries(state.inventory)) {
    if (qty < FEED_COST) continue;
    if (!CROPS[id]) continue;                          // crops only
    if (!best || ITEMS[id].sell < ITEMS[best].sell) best = id;
  }
  if (best) return best;

  return countItem(state, 'feed') >= FEED_COST ? 'feed' : null;
}

export function fillFeedTrough(state, x, y) {
  const t = state.troughs[`${x},${y}`];
  if (!t || t.kind !== 'food') return { ok: false, reason: 'not a feed trough' };

  const food = pickFeed(state);
  if (!food) {
    return { ok: false, reason: `nothing to feed them — buy feed, or spare ${FEED_COST} crops` };
  }

  removeItem(state, food, FEED_COST);
  t.level = TROUGH_CAPACITY;
  t.foodType = food;
  emitUnlessSuspended('world:changed', { x, y });
  return { ok: true, food };
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
    const def = animalDef(a.type);
    if (def && !a.ready && !isNeglected(a)) {
      if (a.progress < def.produceTicks) a.progress++;

      if (a.progress >= def.produceTicks) {
        if (def.laysOnGround) {
          // Only reset once the egg is actually on the ground. If there's
          // nowhere to put it the hen simply tries again next tick rather than
          // losing the egg.
          if (layEgg(state, a)) a.progress = 0;
        } else {
          a.ready = true;
          emitUnlessSuspended('animal:ready', { id: a.id, type: a.type, x: a.x, y: a.y });
        }
      }
    }

    moveAnimal(state, a);
  }
}

/**
 * Drops an egg where the hen is standing, or on an adjacent free tile if that
 * one is taken. Eggs don't stack, so a hen penned somewhere already covered in
 * them just waits — nothing is lost, it simply can't lay until you tidy up.
 *
 * @returns {boolean} whether an egg was actually laid.
 */
function layEgg(state, a) {
  const spots = [
    { x: a.x, y: a.y },
    { x: a.x + 1, y: a.y }, { x: a.x - 1, y: a.y },
    { x: a.x, y: a.y + 1 }, { x: a.x, y: a.y - 1 },
  ];

  for (const s of spots) {
    if (!state.grid.inBounds(s.x, s.y)) continue;
    if (state.grid.getObject(s.x, s.y) !== OBJ.NONE) continue;
    if (state.crops[`${s.x},${s.y}`]) continue;      // not on top of a crop

    state.grid.setObject(s.x, s.y, OBJ.EGG);
    emitUnlessSuspended('animal:laid', { id: a.id, type: a.type, x: s.x, y: s.y });
    emitUnlessSuspended('world:changed', { x: s.x, y: s.y });
    return true;
  }
  return false;
}

function moveAnimal(state, a) {
  // Already walking somewhere: keep going.
  if (a.path && a.path.length > 0) {
    const next = a.path.shift();
    if (state.grid.isWalkable(next.x, next.y, 'animal')) {
      if (next.x !== a.x) a.facing = next.x > a.x ? 'right' : 'left';
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
  if (dx !== 0) a.facing = dx > 0 ? 'right' : 'left';
  a.x = nx;
  a.y = ny;
}
