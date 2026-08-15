// Foraging: mushrooms that appear on open grass and are picked up on sight.
//
// Crops are something you make happen and animals are something you look after.
// Mushrooms are the third thing — something you *find*. Nothing is planted and
// nothing is tended; you walk the farm, spot one, and pick it. That's why they
// spawn everywhere on your land rather than in a plot, and why the rare ones
// are worth an amount of money that has nothing to do with effort.
//
// The spawn machinery is the same shape as weeds (see sim/weeds.js): capped so
// a week away can't carpet the farm, real work on one tick in
// MUSHROOM_INTERVAL so catch-up stays cheap, and `state.rng` only so replaying
// the same time twice finds the same mushrooms.
//
// Which *variant* grew is kept in `state.mushrooms`, keyed by tile, rather than
// in the object grid — the grid holds one byte per tile and there are sixteen
// mushrooms. Same arrangement as crops.

import { emitUnlessSuspended } from '../engine/events.js';
import { GROUND, OBJ } from '../world/tiledefs.js';
import { PLOT, plotCoords } from '../world/land.js';
import { cropAt } from './crops.js';
import { addItem } from './inventory.js';

/**
 * Four kinds, each in four colours — the sheet is one row of sixteen, grouped
 * by shape. Rarity is a spawn weight rather than a percentage, so adding a kind
 * later doesn't mean re-balancing all the others.
 */
export const SPECIES = {
  button: {
    name: 'Button mushroom', item: 'mushroom_button',
    sell: 12, weight: 60, sprites: [12, 13, 14, 15],
  },
  toadstool: {
    name: 'Toadstool', item: 'mushroom_toadstool',
    sell: 28, weight: 25, sprites: [0, 1, 2, 3],
  },
  bolete: {
    name: 'Bolete', item: 'mushroom_bolete',
    sell: 65, weight: 12, sprites: [4, 5, 6, 7],
  },
  morel: {
    name: 'Morel', item: 'mushroom_morel',
    sell: 150, weight: 3, sprites: [8, 9, 10, 11],
  },
};

/** The colour names, in sheet order within each species. */
const COLOURS = {
  button: ['Tan', 'Orange', 'Blue', 'Spotted'],
  toadstool: ['Red', 'Green', 'Pink', 'Navy'],
  bolete: ['Umber', 'Tan', 'Orange', 'Violet'],
  morel: ['Orange', 'Brown', 'Pink', 'Ash'],
};

/**
 * All sixteen, flat. This is the journal's running order and the thing spawning
 * picks from, so it's built once rather than derived at every call site.
 */
export const MUSHROOMS = Object.entries(SPECIES).flatMap(([species, def]) =>
  def.sprites.map((sprite, i) => ({
    id: `${COLOURS[species][i].toLowerCase()}_${species}`,
    species,
    sprite,
    name: `${COLOURS[species][i]} ${def.name.toLowerCase()}`,
  })));

export const MUSHROOMS_BY_ID = Object.fromEntries(MUSHROOMS.map((m) => [m.id, m]));

export function mushroomDef(id) { return MUSHROOMS_BY_ID[id] || null; }
export function speciesDef(species) { return SPECIES[species] || null; }

/** Ticks between attempts. Rarer than weeds: a find should feel like one. */
export const MUSHROOM_INTERVAL = 300;

/** Ceiling, as a fraction of the land you own — about six to a 40x40 cell. */
export const MUSHROOM_MAX_FRACTION = 0.004;

const TRIES = 4;

export function updateMushrooms(state) {
  if (state.tickCount % MUSHROOM_INTERVAL !== 0) return;

  const plots = Array.from(state.grid.owned);
  if (plots.length === 0) return;

  const cap = Math.max(1, Math.floor(plots.length * PLOT * PLOT * MUSHROOM_MAX_FRACTION));
  if (Object.keys(state.mushrooms || {}).length >= cap) return;

  for (let i = 0; i < TRIES; i++) {
    const { px, py } = plotCoords(plots[state.rng.int(plots.length)], state.grid.w);
    const x = px * PLOT + state.rng.int(PLOT);
    const y = py * PLOT + state.rng.int(PLOT);
    if (!canSprout(state, x, y)) continue;

    sprout(state, x, y, rollSpecies(state));
    return;
  }
}

/** Open grass only — same rule as weeds, and for the same reasons. */
export function canSprout(state, x, y) {
  const grid = state.grid;
  if (!grid.isOwned(x, y)) return false;
  if (grid.getGround(x, y) !== GROUND.GRASS) return false;
  if (grid.getObject(x, y) !== OBJ.NONE) return false;
  if (cropAt(state, x, y)) return false;
  if (state.farmer.x === x && state.farmer.y === y) return false;
  return !(state.animals || []).some((a) => a.x === x && a.y === y);
}

/** Weighted pick across the species, then a colour within it. */
export function rollSpecies(state) {
  const total = Object.values(SPECIES).reduce((n, d) => n + d.weight, 0);
  let roll = state.rng.int(total);
  for (const [species, def] of Object.entries(SPECIES)) {
    roll -= def.weight;
    if (roll < 0) {
      const colours = MUSHROOMS.filter((m) => m.species === species);
      return colours[state.rng.int(colours.length)].id;
    }
  }
  return MUSHROOMS[0].id;
}

export function sprout(state, x, y, id) {
  state.mushrooms = state.mushrooms || {};
  state.mushrooms[`${x},${y}`] = id;
  state.grid.setObject(x, y, OBJ.MUSHROOM);
  emitUnlessSuspended('mushroom:grown', { x, y, id });
  return id;
}

/**
 * Puts a few mushrooms near the farmhouse on a brand-new farm.
 *
 * Without this the first one appears somewhere on 1,600 tiles at some point in
 * the first hour, which is a poor way to find out the game has foraging in it
 * at all. Starting with a couple in plain sight makes it discoverable on the
 * first look round, and they're on the cleared ground by the barn so nothing
 * has to be chopped down to reach them.
 */
export function seedStartingMushrooms(state, spawn, count = 2) {
  const placed = [];
  // Rings outward from the farmhouse, so they land close but not underfoot.
  for (let r = 2; r <= 6 && placed.length < count; r++) {
    for (let dy = -r; dy <= r && placed.length < count; dy++) {
      for (let dx = -r; dx <= r && placed.length < count; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // ring edge only
        const x = spawn.x + dx;
        const y = spawn.y + dy;
        if (!canSprout(state, x, y)) continue;
        placed.push(sprout(state, x, y, rollSpecies(state)));
      }
    }
  }
  return placed;
}

export function mushroomAt(state, x, y) {
  const id = (state.mushrooms || {})[`${x},${y}`];
  return id ? mushroomDef(id) : null;
}

/**
 * Picks one. Returns what went in the bag, so the task pipeline can report it
 * the same way it reports a harvest.
 */
export function forage(state, x, y) {
  const key = `${x},${y}`;
  const id = (state.mushrooms || {})[key];
  const def = mushroomDef(id);
  if (!def) return null;

  delete state.mushrooms[key];
  state.grid.setObject(x, y, OBJ.NONE);

  const species = SPECIES[def.species];
  addItem(state, species.item, 1);
  recordFind(state, id);

  emitUnlessSuspended('mushroom:found', { x, y, id, name: def.name, first: journalCount(state, id) === 1 });
  return { [species.item]: 1 };
}

// --- the journal --------------------------------------------------------
//
// Separate from the inventory on purpose: the bag holds four kinds of mushroom
// because sixteen sell rows would be miserable, but the journal remembers all
// sixteen. Selling never erases what you found.

export function recordFind(state, id) {
  state.journal = state.journal || {};
  state.journal[id] = (state.journal[id] || 0) + 1;
}

export function journalCount(state, id) { return (state.journal || {})[id] || 0; }

export function journalFound(state) {
  return MUSHROOMS.filter((m) => journalCount(state, m.id) > 0).length;
}

/** Every mushroom with what's known about it, in sheet order. */
export function journalRows(state) {
  return MUSHROOMS.map((m) => ({
    ...m,
    found: journalCount(state, m.id),
    sell: SPECIES[m.species].sell,
  }));
}
