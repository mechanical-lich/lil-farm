// The game state object and its serialization. This is the single source of
// truth that gets written to localStorage and replayed during catch-up.

import { SAVE_VERSION, MAP_W, MAP_H, START_MONEY, START_INVENTORY } from './config.js';
import { Grid } from './world/grid.js';
import { generateWorld } from './world/worldgen.js';
import { makeRng } from './engine/rng.js';

/** @returns {object} a fresh game */
export function newGame(seed = (Date.now() ^ 0x5f3759df) >>> 0) {
  const rng = makeRng(seed);
  const { grid, spawn } = generateWorld(rng);

  return {
    version: SAVE_VERSION,
    seed,
    rng,
    tickCount: 0,
    lastTickTime: Date.now(),
    money: START_MONEY,
    grid,
    farmer: { x: spawn.x, y: spawn.y, dir: 'down', taskId: null, path: [], trail: [], work: 0 },
    animals: [],
    crops: {},
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
    crops: state.crops,
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
    grid: Grid.fromJSON(data.map || { w: MAP_W, h: MAP_H, ground: [], objects: [] }),
    farmer: data.farmer,
    animals: data.animals || [],
    crops: data.crops || {},
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
