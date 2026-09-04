// The shop: sell what you grow, buy seeds and materials.
//
// The rotating seed selection is *derived* from the tick count rather than
// stored in the save. That keeps offline catch-up trivially correct: coming back
// after two days shows the stock you'd expect for right now, with no rotation
// bookkeeping to replay and nothing to migrate. It also means the stock is a
// pure function of (seed, tickCount), so it's reproducible in tests.

import { makeRng } from '../engine/rng.js';
import { noteAnimalBought, noteHandHired } from './achievements.js';
import { emitUnlessSuspended } from '../engine/events.js';
import { CROPS, seedIdFor, isSeedId, cropFromSeedId } from './crops.js';
import {
  ITEMS, ITEM_GROUPS, addItem, removeItem, countItem, itemName, itemGroup,
} from './inventory.js';
import { ANIMALS, animalDef, makeAnimal, SWIMMERS } from './animals.js';
import { animalCapacity } from './build.js';
import { priceOf, priceMultiplier, recordSale } from './market.js';
import {
  HAND_PRICE, HAND_CAPACITY, makeHand, handCount, handCapacity,
} from './farmhand.js';

/** How long one shop rotation lasts. Six hours: slower than a play session, so
 *  the selection feels like it changes between visits rather than under you. */
export const ROTATION_TICKS = 6 * 60 * 60;

/** Always available, so a player can never be stranded with nothing to plant. */
export const STAPLE_SEEDS = ['carrot', 'wheat'];

/**
 * The non-staple crops, split by how long they take. One is drawn from each
 * tier, so the shop always offers something slow.
 *
 * Drawing two from a single pool let a rotation take out cabbage *and*
 * eggplant together, which is the one outcome the balance can't afford: the
 * slow crops are the whole point of an overnight field, and a player who
 * checks in at bedtime and finds only 4- and 5-minute crops has nothing worth
 * planting. Tiering costs nothing — the list is still four seeds long and
 * still rotates — and it makes that case impossible rather than unlikely.
 */
export const ROTATING_TIERS = [
  ['corn', 'tomato'],        // mid: something to plant while you're watching
  ['cabbage', 'eggplant'],   // slow: something to leave running overnight
];

/** Flat view of the same pool, for anything that just wants the names. */
export const ROTATING_SEEDS = ROTATING_TIERS.flat();
export const ROTATING_COUNT = ROTATING_TIERS.length;

/** Everything sold by the sack rather than the seed packet. */
export const MATERIALS = {
  wood: { buy: 10, note: 'material' },
  stone: { buy: 8, note: 'material' },
  // Deliberately dearer than feeding your own crops: a full trough costs $45 in
  // feed against roughly $30 of carrots. It exists so an empty larder never
  // means hungry animals, not as the sensible everyday choice.
  feed: { buy: 15, note: 'animal feed' },
};

/** Seeds resell at half price — enough to undo a mistake, never a money loop. */
/**
 * What one of these fetches.
 *
 * Takes the state because crops and produce are traded on a market whose prices
 * move (see sim/market.js). Seeds and materials are not: a seed is bought back
 * at half what it cost, and building materials are deliberately kept out of the
 * market so a barn's price never wanders.
 */
export function sellPrice(state, id) {
  if (isSeedId(id)) {
    const crop = CROPS[cropFromSeedId(id)];
    return crop ? Math.floor(crop.seedCost / 2) : 0;
  }
  return priceOf(state, id);
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

  const picked = ROTATING_TIERS.map((tier) => tier[rng.int(tier.length)]);

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

  const materials = Object.entries(MATERIALS).map(([id, def]) => ({
    id,
    name: itemName(id),
    price: buyPrice(id),
    note: def.note,
  }));

  return [...seeds, ...materials];
}

/** Everything in the bag that's worth money, as display-ready rows. */
export function sellList(state) {
  return Object.entries(state.inventory)
    .filter(([id, qty]) => qty > 0 && sellPrice(state, id) > 0)
    .map(([id, qty]) => ({
      id, name: itemName(id), qty, price: sellPrice(state, id), group: itemGroup(id),
      // What the market is doing to this price, so the sell list can show it
      // where the decision is actually made rather than only in the panel.
      multiplier: priceMultiplier(state, id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The same list under headings, empty groups dropped.
 *
 * Sorted by group first and by name within it, so the order is stable as the
 * bag fills and empties — a row never jumps to a different place in the list
 * just because you sold the thing above it.
 */
export function sellGroups(state) {
  const rows = sellList(state);
  return ITEM_GROUPS
    .map((group) => ({ ...group, rows: rows.filter((r) => r.group === group.id) }))
    .filter((group) => group.rows.length > 0);
}

/** What the whole group would fetch, for the heading. */
export function groupValue(group) {
  return group.rows.reduce((sum, r) => sum + r.price * r.qty, 0);
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
/**
 * @param {string} [type] which animal — a duck may be put straight on the pond,
 *   everything else needs dry land.
 */
export function canPlaceAnimal(state, x, y, type) {
  const actor = type && SWIMMERS.has(type) ? 'swimmer' : 'animal';
  return state.grid.inBounds(x, y) && state.grid.isWalkable(x, y, actor);
}

/**
 * Completes a purchase at a spot the player chose. Money is only taken here, so
 * backing out of the placement costs nothing — the same rule building follows.
 * @returns {{ok: boolean, reason?: string, spent?: number, animal?: object}}
 */
export function buyAnimal(state, type, x, y) {
  const allowed = canBuyAnimal(state, type);
  if (!allowed.ok) return allowed;
  if (!canPlaceAnimal(state, x, y, type)) return { ok: false, reason: "it can't stand there" };

  const def = animalDef(type);
  state.money -= def.price;
  const animal = makeAnimal(state, type, x, y);
  emitUnlessSuspended('money:changed', { delta: -def.price });
  emitUnlessSuspended('animal:bought', { type });
  noteAnimalBought(state, type);
  return { ok: true, spent: def.price, animal };
}

/** Display rows for the livestock tab. */
/**
 * Hiring a farmhand. Reads like buying an animal on purpose — you pay, then you
 * say where they should start — but it isn't livestock, so it gets its own
 * row and its own capacity: one hand per barn.
 */
export function canHireHand(state) {
  const capacity = handCapacity(state);
  if (capacity === 0) return { ok: false, reason: 'build a barn first — they need somewhere to bring things' };
  if (handCount(state) >= capacity) return { ok: false, reason: 'every barn already has a farmhand' };
  if (state.money < HAND_PRICE) return { ok: false, reason: `a farmhand costs $${HAND_PRICE}` };
  return { ok: true };
}

export function hireHand(state, x, y) {
  const allowed = canHireHand(state);
  if (!allowed.ok) return allowed;
  if (!canPlaceAnimal(state, x, y)) return { ok: false, reason: "they can't stand there" };

  state.money -= HAND_PRICE;
  const hand = makeHand(state, x, y);
  emitUnlessSuspended('money:changed', { delta: -HAND_PRICE });
  emitUnlessSuspended('hand:hired', { id: hand.id });
  noteHandHired(state);
  return { ok: true, spent: HAND_PRICE, hand };
}

export function handRow(state) {
  const capacity = handCapacity(state);
  return {
    name: 'Farmhand',
    price: HAND_PRICE,
    note: `milks, shears and picks up eggs · carries ${HAND_CAPACITY}`,
    owned: handCount(state),
    capacity,
    affordable: canHireHand(state).ok,
  };
}

export function animalList(state) {
  const capacity = animalCapacity(state);
  return Object.entries(ANIMALS).map(([type, def]) => ({
    type,
    name: def.name,
    price: def.price,
    // A horse gives nothing, and the shop row has to say so rather than
    // asking itemName what undefined is called.
    produces: def.produces ? itemName(def.produces) : null,
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

  const price = sellPrice(state, id);
  if (!price) return { ok: false, reason: "that isn't worth anything" };

  const have = countItem(state, id);
  if (have < qty) return { ok: false, reason: `you only have ${have}` };

  if (!removeItem(state, id, qty)) return { ok: false, reason: 'could not take it from the bag' };

  const earned = price * qty;
  state.money += earned;
  // The town now holds these, which is what moves the price next time.
  recordSale(state, id, qty, earned);
  emitUnlessSuspended('money:changed', { delta: earned });
  return { ok: true, earned, qty };
}

/** Sells the player's whole stack of one item. */
export function sellAll(state, id) {
  return sell(state, id, countItem(state, id));
}
