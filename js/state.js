// The game state object and its serialization. This is the single source of
// truth that gets written to localStorage and replayed during catch-up.

import { SAVE_VERSION, MAP_W, MAP_H, START_MONEY, START_INVENTORY } from './config.js';
import { Grid } from './world/grid.js';
import { generateWorld, startingBarnAnchor } from './world/worldgen.js';
import { placeStructure, reconcileBuildings } from './sim/build.js';
import { reconcileCrates } from './sim/crates.js';
import { reconcileHay } from './sim/hay.js';
import { seedStartingMushrooms } from './sim/mushrooms.js';
import { newMarket } from './sim/market.js';
import { reconcileFlowers } from './sim/flowers.js';
import { startingPlot } from './world/land.js';
import { makeRng } from './engine/rng.js';

/** @returns {object} a fresh game */
export function newGame(seed = (Date.now() ^ 0x5f3759df) >>> 0) {
  const rng = makeRng(seed);
  const { grid, spawn } = generateWorld(rng);

  const state = {
    version: SAVE_VERSION,
    seed,
    rng,
    tickCount: 0,
    lastTickTime: Date.now(),
    money: START_MONEY,
    grid,
    farmer: { x: spawn.x, y: spawn.y, dir: 'down', facing: 'right', taskId: null, path: [], trail: [], work: 0 },
    animals: [],
    nextAnimalId: 1,
    hands: [],          // hired farmhands; see sim/farmhand.js
    nextHandId: 1,
    crops: {},
    mushrooms: {},   // tile key -> mushroom id; see sim/mushrooms.js
    journal: {},     // mushroom id -> how many you have ever picked
    flowers: {},     // tile key -> {kind, hue, sat, split}; see sim/flowers.js
    flowerJournal: {},  // kind -> {picked, hues[]}
    wetUntil: {},    // tileKey -> tick at which watered soil dries out
    tillDir: {},     // tileKey -> 'h' | 'v', the axis of the row it was tilled in
    buildings: [],   // multi-tile structures; the grid only marks their footprint
    nextBuildingId: 1,
    troughs: {},
    crates: {},     // tile key -> {item, qty}; see sim/crates.js
    hay: {},        // tile key -> {left}; see sim/hay.js
    tools: {},      // tile key -> buildable kind; see sim/tools.js
    pots: {},       // tile key -> true; see sim/pots.js
    tasks: [],
    nextTaskId: 1,
    // See TESTING in config.js — a real farm starts with just a few seeds.
    inventory: { ...START_INVENTORY },
    market: newMarket(),
  };

  // Every farm starts with one barn. It gives the opening view a centre to sit
  // around, and means keeping animals is something the player can work toward
  // from day one rather than only after saving 50 wood and 20 stone.
  const barn = startingBarnAnchor(spawn);
  placeStructure(state, 'barn', barn.x, barn.y);

  // A couple in plain sight by the barn, so foraging is something you find on
  // the first look round rather than an hour in. See sim/mushrooms.js.
  seedStartingMushrooms(state, spawn);

  return state;
}

/** Plain-JSON snapshot for localStorage. */
export function serialize(state) {
  return {
    version: SAVE_VERSION,
    seed: state.seed,
    rngState: state.rng.getState(),
    tickCount: state.tickCount,
    lastTickTime: state.lastTickTime,
    money: state.money,
    map: state.grid.toJSON(),
    farmer: state.farmer,
    animals: state.animals,
    nextAnimalId: state.nextAnimalId,
    hands: state.hands,
    nextHandId: state.nextHandId,
    crops: state.crops,
    mushrooms: state.mushrooms,
    flowers: state.flowers,
    flowerJournal: state.flowerJournal,
    journal: state.journal,
    wetUntil: state.wetUntil,
    tillDir: state.tillDir,
    buildings: state.buildings,
    nextBuildingId: state.nextBuildingId,
    troughs: state.troughs,
    crates: state.crates,
    hay: state.hay,
    tools: state.tools,
    pots: state.pots,
    tasks: state.tasks,
    nextTaskId: state.nextTaskId,
    inventory: state.inventory,
    market: state.market,
  };
}

function emptyMap() {
  const grid = new Grid(MAP_W, MAP_H);
  const centre = startingPlot({ x: Math.floor(MAP_W / 2), y: Math.floor(MAP_H / 2) });
  grid.own(centre.px, centre.py);
  return grid.toJSON();
}

/** Inverse of serialize(). Assumes migrations already ran. */
export function deserialize(data) {
  const rng = makeRng(data.seed >>> 0);
  rng.setState(data.rngState >>> 0);

  const state = {
    version: data.version,
    seed: data.seed,
    rng,
    tickCount: data.tickCount || 0,
    lastTickTime: data.lastTickTime || Date.now(),
    money: data.money || 0,
    // The fallback can only be reached by calling deserialize directly — both
    // loadSave and validateSave refuse a save with no map. It still grants the
    // starting cell, because a grid that owns nothing is a grid where nothing
    // can walk, which is a far more confusing failure than an empty map.
    grid: Grid.fromJSON(data.map || emptyMap()),
    farmer: data.farmer,
    animals: data.animals || [],
    nextAnimalId: data.nextAnimalId || 1,
    hands: data.hands || [],
    nextHandId: data.nextHandId || 1,
    crops: data.crops || {},
    mushrooms: data.mushrooms || {},
    flowers: data.flowers || {},
    flowerJournal: data.flowerJournal || {},
    journal: data.journal || {},
    wetUntil: data.wetUntil || {},
    tillDir: data.tillDir || {},
    buildings: data.buildings || [],
    nextBuildingId: data.nextBuildingId || 1,
    troughs: data.troughs || {},
    // Farms saved before crates existed simply have none.
    crates: data.crates || {},
    // Farms saved before hay bales existed simply have none.
    hay: data.hay || {},
    // Farms saved before tools could be hung up simply have none.
    tools: data.tools || {},
    // Farms saved before flower pots existed simply have none.
    pots: data.pots || {},
    tasks: data.tasks || [],
    nextTaskId: data.nextTaskId || 1,
    inventory: data.inventory || {},
    market: data.market || newMarket(),
  };

  // The grid's building marks are an index over state.buildings, and an index
  // can go stale. Putting it right on load is cheap and stops a farm carrying a
  // wrong answer around with it forever.
  reconcileFlowers(state);
  const fixed = reconcileBuildings(state);
  if (fixed.cleared || fixed.restored) {
    console.warn(`building marks repaired on load: ${fixed.cleared} stale, ${fixed.restored} missing`);
  }
  const crates = reconcileCrates(state);
  if (crates.adopted || crates.dropped) {
    console.warn(`crate records repaired on load: ${crates.adopted} adopted, ${crates.dropped} dropped`);
  }
  const bales = reconcileHay(state);
  if (bales.adopted || bales.dropped) {
    console.warn(`hay records repaired on load: ${bales.adopted} adopted, ${bales.dropped} dropped`);
  }
  return state;
}
