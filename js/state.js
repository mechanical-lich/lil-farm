// The game state object and its serialization. This is the single source of
// truth that gets written to localStorage and replayed during catch-up.

import { SAVE_VERSION, MAP_W, MAP_H, START_MONEY, START_INVENTORY } from './config.js';
import { Grid } from './world/grid.js';
import { generateWorld, startingBarnAnchor } from './world/worldgen.js';
import { placeStructure } from './sim/build.js';
import { seedStartingMushrooms } from './sim/mushrooms.js';
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
    crops: {},
    mushrooms: {},   // tile key -> mushroom id; see sim/mushrooms.js
    journal: {},     // mushroom id -> how many you have ever picked
    wetUntil: {},    // tileKey -> tick at which watered soil dries out
    tillDir: {},     // tileKey -> 'h' | 'v', the axis of the row it was tilled in
    buildings: [],   // multi-tile structures; the grid only marks their footprint
    nextBuildingId: 1,
    troughs: {},
    tasks: [],
    nextTaskId: 1,
    // See TESTING in config.js — a real farm starts with just a few seeds.
    inventory: { ...START_INVENTORY },
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
    crops: state.crops,
    mushrooms: state.mushrooms,
    journal: state.journal,
    wetUntil: state.wetUntil,
    tillDir: state.tillDir,
    buildings: state.buildings,
    nextBuildingId: state.nextBuildingId,
    troughs: state.troughs,
    tasks: state.tasks,
    nextTaskId: state.nextTaskId,
    inventory: state.inventory,
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

  return {
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
    crops: data.crops || {},
    mushrooms: data.mushrooms || {},
    journal: data.journal || {},
    wetUntil: data.wetUntil || {},
    tillDir: data.tillDir || {},
    buildings: data.buildings || [],
    nextBuildingId: data.nextBuildingId || 1,
    troughs: data.troughs || {},
    tasks: data.tasks || [],
    nextTaskId: data.nextTaskId || 1,
    inventory: data.inventory || {},
  };
}
