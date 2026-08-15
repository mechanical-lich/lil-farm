// Item stacks. Pure data operations; the UI listens for 'inventory:changed'.

import { emitUnlessSuspended } from '../engine/events.js';

// Sell prices are tuned against CROPS.seedCost and growTicks — see the balance
// note in crops.js. Changing one without the other will break the curve.
export const ITEMS = {
  wood: { name: 'Wood', sell: 4 },
  stone: { name: 'Stone', sell: 3 },
  fiber: { name: 'Fiber', sell: 2 },
  carrot: { name: 'Carrot', sell: 10 },
  wheat: { name: 'Wheat', sell: 12 },
  corn: { name: 'Corn', sell: 16 },
  tomato: { name: 'Tomato', sell: 20 },
  cabbage: { name: 'Cabbage', sell: 40 },
  eggplant: { name: 'Eggplant', sell: 45 },
  egg: { name: 'Egg', sell: 25 },
  milk: { name: 'Milk', sell: 60 },
};

export function itemName(id) {
  if (ITEMS[id]) return ITEMS[id].name;
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
