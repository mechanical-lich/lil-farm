// The shop: sell what you grow, buy seeds and materials.
//
// The rotating seed selection is *derived* from the tick count rather than
// stored in the save. That keeps offline catch-up trivially correct: coming back
// after two days shows the stock you'd expect for right now, with no rotation
// bookkeeping to replay and nothing to migrate. It also means the stock is a
// pure function of (seed, tickCount), so it's reproducible in tests.

import { makeRng } from '../engine/rng.js';
import { emitUnlessSuspended } from '../engine/events.js';
import { CROPS, seedIdFor, isSeedId, cropFromSeedId } from './crops.js';
import { ITEMS, addItem, removeItem, countItem, itemName } from './inventory.js';
import { ANIMALS, animalDef, makeAnimal } from './animals.js';
import { animalCapacity } from './build.js';

/** How long one shop rotation lasts. Six hours: slower than a play session, so
 *  the selection feels like it changes between visits rather than under you. */
export const ROTATION_TICKS = 6 * 60 * 60;

/** Always available, so a player can never be stranded with nothing to plant. */
export const STAPLE_SEEDS = ['carrot', 'wheat'];

/** Two of these are offered at a time. */
export const ROTATING_SEEDS = ['corn', 'tomato', 'cabbage', 'eggplant'];
export const ROTATING_COUNT = 2;

/** Construction materials, for fences and troughs in M4. */
export const MATERIALS = {
  wood: { buy: 10 },
  stone: { buy: 8 },
};

/** Seeds resell at half price — enough to undo a mistake, never a money loop. */
export function sellPrice(id) {
  if (isSeedId(id)) {
    const crop = CROPS[cropFromSeedId(id)];
    return crop ? Math.floor(crop.seedCost / 2) : 0;
  }
  return ITEMS[id]?.sell || 0;
}

export function buyPrice(id) {
  if (isSeedId(id)) {
    const crop = CROPS[cropFromSeedId(id)];
    return crop ? crop.seedCost : 0;
  }
  return MATERIALS[id]?.buy || 0;
}

export function rotationIndex(state) {
  return Math.floor(state.tickCount / ROTATION_TICKS);
}

export function ticksUntilRotation(state) {
  return ROTATION_TICKS - (state.tickCount % ROTATION_TICKS);
}

/**
 * Which crops' seeds are for sale right now: the staples plus a rotating pick.
 * Uses its own generator seeded from the farm seed and the rotation number, so
 * it never consumes state.rng — the shop must not perturb the simulation.
 */
export function stockedSeedCrops(state) {
  const rng = makeRng(((state.seed >>> 0) ^ (rotationIndex(state) * 0x9e3779b1)) >>> 0);

  const pool = [...ROTATING_SEEDS];
  const picked = [];
  for (let i = 0; i < ROTATING_COUNT && pool.length > 0; i++) {
    picked.push(pool.splice(rng.int(pool.length), 1)[0]);
  }

  // Sorted by grow time so the list reads short-to-long, which is also
  // cheap-to-expensive; the shop shouldn't reshuffle its own rows visually.
  return [...STAPLE_SEEDS, ...picked].sort((a, b) => CROPS[a].growTicks - CROPS[b].growTicks);
}

/** Everything purchasable right now, as display-ready rows. */
export function buyList(state) {
  const seeds = stockedSeedCrops(state).map((crop) => ({
    id: seedIdFor(crop),
    name: `${CROPS[crop].name} seeds`,
    price: buyPrice(seedIdFor(crop)),
    note: growLabel(CROPS[crop].growTicks),
  }));

  const materials = Object.keys(MATERIALS).map((id) => ({
    id,
    name: itemName(id),
    price: buyPrice(id),
    note: 'material',
  }));

  return [...seeds, ...materials];
}

/** Everything in the bag that's worth money, as display-ready rows. */
export function sellList(state) {
  return Object.entries(state.inventory)
    .filter(([id, qty]) => qty > 0 && sellPrice(id) > 0)
    .map(([id, qty]) => ({ id, name: itemName(id), qty, price: sellPrice(id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function growLabel(ticks) {
  const mins = Math.round(ticks / 60);
  return mins >= 60 ? `${(mins / 60).toFixed(mins % 60 ? 1 : 0)} hr` : `${mins} min`;
}

/**
 * Livestock. Sold separately from items because buying one puts an animal in
 * the world rather than something in the bag, and it's gated on barn space.
 * @returns {{ok: boolean, reason?: string, spent?: number, animal?: object}}
 */
/**
 * Whether a purchase could go ahead — checked before the player picks a spot,
 * so we never send them off to choose a home for an animal they can't afford.
 * @returns {{ok: boolean, reason?: string}}
 */
export function canBuyAnimal(state, type) {
  const def = animalDef(type);
  if (!def) return { ok: false, reason: 'no such animal' };

  const capacity = animalCapacity(state);
  if (capacity === 0) return { ok: false, reason: 'build a barn first' };
  if (state.animals.length >= capacity) return { ok: false, reason: 'your barns are full' };
  if (state.money < def.price) return { ok: false, reason: 'not enough money' };
  return { ok: true };
}

/** Somewhere an animal could actually stand. */
export function canPlaceAnimal(state, x, y) {
  return state.grid.inBounds(x, y) && state.grid.isWalkable(x, y, 'animal');
}

/**
 * Completes a purchase at a spot the player chose. Money is only taken here, so
 * backing out of the placement costs nothing — the same rule building follows.
 * @returns {{ok: boolean, reason?: string, spent?: number, animal?: object}}
 */
export function buyAnimal(state, type, x, y) {
  const allowed = canBuyAnimal(state, type);
  if (!allowed.ok) return allowed;
  if (!canPlaceAnimal(state, x, y)) return { ok: false, reason: "it can't stand there" };

  const def = animalDef(type);
  state.money -= def.price;
  const animal = makeAnimal(state, type, x, y);
  emitUnlessSuspended('money:changed', { delta: -def.price });
  emitUnlessSuspended('animal:bought', { type });
  return { ok: true, spent: def.price, animal };
}

/** Display rows for the livestock tab. */
export function animalList(state) {
  const capacity = animalCapacity(state);
  return Object.entries(ANIMALS).map(([type, def]) => ({
    type,
    name: def.name,
    price: def.price,
    produces: itemName(def.produces),
    owned: state.animals.filter((a) => a.type === type).length,
    affordable: state.money >= def.price && state.animals.length < capacity,
  }));
}

/**
 * @returns {{ok: boolean, reason?: string, spent?: number}}
 */
export function buy(state, id, qty = 1) {
  if (qty <= 0) return { ok: false, reason: 'nothing to buy' };

  const price = buyPrice(id);
  if (!price) return { ok: false, reason: 'not for sale' };

  // Seeds must actually be in stock this rotation, not merely a known crop.
  if (isSeedId(id) && !stockedSeedCrops(state).includes(cropFromSeedId(id))) {
    return { ok: false, reason: 'not in stock right now' };
  }

  const cost = price * qty;
  if (state.money < cost) return { ok: false, reason: 'not enough money' };

  state.money -= cost;
  addItem(state, id, qty);
  emitUnlessSuspended('money:changed', { delta: -cost });
  return { ok: true, spent: cost };
}

/**
 * @returns {{ok: boolean, reason?: string, earned?: number, qty?: number}}
 */
export function sell(state, id, qty = 1) {
  if (qty <= 0) return { ok: false, reason: 'nothing to sell' };

  const price = sellPrice(id);
  if (!price) return { ok: false, reason: "that isn't worth anything" };

  const have = countItem(state, id);
  if (have < qty) return { ok: false, reason: `you only have ${have}` };

  if (!removeItem(state, id, qty)) return { ok: false, reason: 'could not take it from the bag' };

  const earned = price * qty;
  state.money += earned;
  emitUnlessSuspended('money:changed', { delta: earned });
  return { ok: true, earned, qty };
}

/** Sells the player's whole stack of one item. */
export function sellAll(state, id) {
  return sell(state, id, countItem(state, id));
}
