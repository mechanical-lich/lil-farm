// Item stacks. Pure data operations; the UI listens for 'inventory:changed'.

import { isFlowerSeed, seedName } from './flowergenes.js';
import { emitUnlessSuspended } from '../engine/events.js';

// Sell prices are tuned against CROPS.seedCost and growTicks — see the balance
// note in crops.js. Changing one without the other will break the curve.
/**
 * How the sell list is broken up, in the order the headings appear.
 *
 * The list started as four things in alphabetical order and is now twenty-odd,
 * which is long enough that "where is the milk" became a real question. The
 * grouping is by where a thing *came from*, because that's how a player thinks
 * about their own bag — what I grew, what the animals gave me, what I found.
 */
export const ITEM_GROUPS = [
  { id: 'crop', name: 'Crops' },
  { id: 'produce', name: 'From the animals' },
  { id: 'fish', name: 'From the water' },
  { id: 'foraged', name: 'Foraged' },
  { id: 'material', name: 'Materials' },
  { id: 'seed', name: 'Seeds' },
];

export const ITEMS = {
  wood: { name: 'Wood', sell: 4, group: 'material' },
  stone: { name: 'Stone', sell: 3, group: 'material' },
  fiber: { name: 'Fiber', sell: 2, group: 'material' },
  // Bought animal feed. Sells for far less than it costs, so stocking up is a
  // convenience rather than a way to store value.
  feed: { name: 'Feed', sell: 5, group: 'material' },
  carrot: { name: 'Carrot', sell: 10, group: 'crop' },
  wheat: { name: 'Wheat', sell: 12, group: 'crop' },
  corn: { name: 'Corn', sell: 16, group: 'crop' },
  tomato: { name: 'Tomato', sell: 20, group: 'crop' },
  cabbage: { name: 'Cabbage', sell: 40, group: 'crop' },
  eggplant: { name: 'Eggplant', sell: 45, group: 'crop' },
  egg: { name: 'Egg', sell: 25, group: 'produce' },
  milk: { name: 'Milk', sell: 60, group: 'produce' },
  // A goat gives less than a cow and gives it sooner, so a goat pays for itself
  // quicker and a cow earns more once it has. See the note in animals.js.
  goat_milk: { name: "Goat's milk", sell: 45, group: 'produce' },
  wool: { name: 'Wool', sell: 100, group: 'produce' },
  // Out of the water. Prices climb with rarity rather than with size alone —
  // the things that have no business in a farm pond are worth a fortune
  // precisely because landing one is a story.
  fish_bass: { name: 'Bass', sell: 18, group: 'fish' },
  fish_trout: { name: 'Trout', sell: 22, group: 'fish' },
  fish_salmon: { name: 'Salmon', sell: 26, group: 'fish' },
  fish_catfish: { name: 'Catfish', sell: 30, group: 'fish' },
  fish_carp: { name: 'Carp', sell: 34, group: 'fish' },
  fish_big_bass: { name: 'Big bass', sell: 55, group: 'fish' },
  fish_big_trout: { name: 'Big trout', sell: 65, group: 'fish' },
  fish_big_salmon: { name: 'Big salmon', sell: 80, group: 'fish' },
  fish_big_catfish: { name: 'Big catfish', sell: 95, group: 'fish' },
  fish_big_carp: { name: 'Big carp', sell: 120, group: 'fish' },
  fish_crab: { name: 'Crab', sell: 70, group: 'fish' },
  fish_reef_shark: { name: 'Reef shark', sell: 400, group: 'fish' },
  fish_great_white: { name: 'Great white', sell: 600, group: 'fish' },
  fish_dolphin: { name: 'Dolphin', sell: 500, group: 'fish' },

  // Foraged. Four kinds rather than sixteen: the journal remembers every
  // colour, the bag only needs to know what it's worth.
  mushroom_button: { name: 'Button mushrooms', sell: 12, group: 'foraged' },
  mushroom_chestnut: { name: 'Chestnut mushrooms', sell: 20, group: 'foraged' },
  mushroom_toadstool: { name: 'Toadstools', sell: 28, group: 'foraged' },
  mushroom_portobello: { name: 'Portobellos', sell: 45, group: 'foraged' },
  mushroom_bolete: { name: 'Boletes', sell: 65, group: 'foraged' },
  mushroom_parasol: { name: 'Parasols', sell: 95, group: 'foraged' },
  mushroom_morel: { name: 'Morels', sell: 150, group: 'foraged' },
};

/**
 * Which heading an item belongs under.
 *
 * Seeds are the odd ones out: their ids are generated per crop rather than
 * listed above, so they're recognised by shape instead of by lookup.
 */
export function itemGroup(id) {
  if (id.endsWith('_seed')) return 'seed';
  return ITEMS[id]?.group || 'material';
}

export function itemName(id) {
  if (ITEMS[id]) return ITEMS[id].name;
  // A flower seed carries its flower's genome in its own id, so there are far
  // too many of them to list — it says its own name instead.
  if (isFlowerSeed(id)) return seedName(id);
  // Seeds are generated per crop rather than listed one by one.
  if (id.endsWith('_seed')) {
    const base = id.slice(0, -5);
    return `${ITEMS[base]?.name || base} seeds`;
  }
  return id;
}

export function addItem(state, id, qty = 1) {
  if (qty <= 0) return;
  state.inventory[id] = (state.inventory[id] || 0) + qty;
  emitUnlessSuspended('inventory:changed', { id, qty });
}

export function addItems(state, yields) {
  for (const [id, qty] of Object.entries(yields || {})) addItem(state, id, qty);
}

export function countItem(state, id) {
  return state.inventory[id] || 0;
}

export function removeItem(state, id, qty = 1) {
  const have = countItem(state, id);
  if (have < qty) return false;
  const left = have - qty;
  if (left === 0) delete state.inventory[id];
  else state.inventory[id] = left;
  emitUnlessSuspended('inventory:changed', { id, qty: -qty });
  return true;
}

/** Stable, sorted list for display. */
export function inventoryList(state) {
  return Object.entries(state.inventory)
    .filter(([, n]) => n > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, qty]) => ({ id, qty, name: itemName(id) }));
}
