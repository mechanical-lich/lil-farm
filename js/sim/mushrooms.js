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
import { isReserved } from './build.js';

/**
 * Seven kinds, each in five colours — the sheet is one row of thirty-five,
 * grouped by shape, with the sprites of a kind running consecutively.
 *
 * Rarity is a spawn weight rather than a percentage, so adding a kind means
 * picking one number rather than re-balancing all the others. The weights below
 * happen to sum to a hundred, which makes them readable as percentages, but
 * nothing depends on that.
 *
 * `sprites` is derived rather than written out: the sheet is laid out in
 * species order, five to a kind, and typing thirty-five indices by hand is an
 * invitation to get one wrong in a way nothing would catch.
 */
const SHEET_ORDER = ['toadstool', 'bolete', 'morel', 'button', 'chestnut', 'portobello', 'parasol'];

/** How many colours each kind comes in. The fifth is always the rainbow one. */
export const COLOURS_PER_SPECIES = 5;

const spritesFor = (species) => {
  const first = SHEET_ORDER.indexOf(species) * COLOURS_PER_SPECIES;
  return Array.from({ length: COLOURS_PER_SPECIES }, (_, i) => first + i);
};

export const SPECIES = {
  button: {
    name: 'Button mushroom', item: 'mushroom_button',
    sell: 12, weight: 44, sprites: spritesFor('button'),
  },
  chestnut: {
    name: 'Chestnut mushroom', item: 'mushroom_chestnut',
    sell: 20, weight: 22, sprites: spritesFor('chestnut'),
  },
  toadstool: {
    name: 'Toadstool', item: 'mushroom_toadstool',
    sell: 28, weight: 16, sprites: spritesFor('toadstool'),
  },
  portobello: {
    name: 'Portobello', item: 'mushroom_portobello',
    sell: 45, weight: 9, sprites: spritesFor('portobello'),
  },
  bolete: {
    name: 'Bolete', item: 'mushroom_bolete',
    sell: 65, weight: 5, sprites: spritesFor('bolete'),
  },
  parasol: {
    name: 'Parasol', item: 'mushroom_parasol',
    sell: 95, weight: 3, sprites: spritesFor('parasol'),
  },
  morel: {
    name: 'Morel', item: 'mushroom_morel',
    sell: 150, weight: 1, sprites: spritesFor('morel'),
  },
};

/**
 * The colour names, in sheet order within each species.
 *
 * The first four of each are the colours that have always been there, in the
 * order they have always been in, because a journal entry is keyed by colour
 * and species — reordering these would quietly rename every mushroom anybody
 * has ever found. The rainbow one is new, and goes last for the same reason.
 */
const COLOURS = {
  button: ['Tan', 'Orange', 'Blue', 'Spotted', 'Rainbow'],
  toadstool: ['Red', 'Green', 'Pink', 'Navy', 'Rainbow'],
  bolete: ['Umber', 'Tan', 'Orange', 'Violet', 'Rainbow'],
  morel: ['Orange', 'Brown', 'Pink', 'Ash', 'Rainbow'],
  chestnut: ['Tan', 'Orange', 'Blue', 'Spotted', 'Rainbow'],
  portobello: ['Tan', 'Orange', 'Blue', 'Spotted', 'Rainbow'],
  parasol: ['Tan', 'Orange', 'Blue', 'Spotted', 'Rainbow'],
};

/**
 * How a colour is picked: the weight of the rainbow one against each of the
 * four ordinary ones.
 *
 * Picking evenly would make a fifth of every find a rainbow, which would leave
 * the rarest-looking thing on the sheet the most ordinary thing in the journal.
 * At one against six it comes out around one find in twenty-five — often enough
 * to happen, rare enough to be worth showing somebody.
 */
export const COLOUR_WEIGHT = { ordinary: 6, rainbow: 1 };

/** The rainbow one is always the last colour of its kind. */
export const isRainbow = (id) => id.startsWith('rainbow_');

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
  if (isReserved(state, x, y)) return false;      // a queued build owns it
  if (state.farmer.x === x && state.farmer.y === y) return false;
  return !(state.animals || []).some((a) => a.x === x && a.y === y);
}

/** Weighted pick across the species, then a colour within it. */
export function rollSpecies(state) {
  const total = Object.values(SPECIES).reduce((n, d) => n + d.weight, 0);
  let roll = state.rng.int(total);
  for (const [species, def] of Object.entries(SPECIES)) {
    roll -= def.weight;
    if (roll < 0) return rollColour(state, species);
  }
  return MUSHROOMS[0].id;
}

/** Which colour of a kind turned up. The rainbow one is the rare find. */
export function rollColour(state, species) {
  const colours = MUSHROOMS.filter((m) => m.species === species);
  const weigh = (m) => (isRainbow(m.id) ? COLOUR_WEIGHT.rainbow : COLOUR_WEIGHT.ordinary);
  const total = colours.reduce((n, m) => n + weigh(m), 0);
  let roll = state.rng.int(total);
  for (const m of colours) {
    roll -= weigh(m);
    if (roll < 0) return m.id;
  }
  return colours[0].id;
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
