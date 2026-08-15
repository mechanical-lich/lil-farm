// Tile type tables. Ids are numeric because they are stored in typed arrays in
// the save; the names are the only thing code should reference.

// --- Ground layer -------------------------------------------------------
export const GROUND = {
  GRASS: 0,
  DIRT: 1,          // cleared/trampled earth, also what a path is made of
  TILLED: 2,        // ploughed and dry
  ROAD: 3,
  TILLED_WET: 4,    // ploughed and watered; dries back to TILLED over time
};

export function isTilled(groundId) {
  return groundId === GROUND.TILLED || groundId === GROUND.TILLED_WET;
}

// --- Object layer -------------------------------------------------------
export const OBJ = {
  NONE: 0,
  TREE: 1,
  DEAD_TREE: 2,
  ROCK: 3,
  WEED: 4,
  BUSH: 5,
  STUMP: 6,
  FENCE: 7,
  GATE: 8,
  TROUGH_WATER: 9,
  TROUGH_FOOD: 10,
  BARREL: 11,
  BUILDING: 12,
  EGG: 13,
};

export const OBJ_DEFS = {
  [OBJ.NONE]: { name: '', blocks: false },
  [OBJ.TREE]: { name: 'tree', blocks: true, tall: true, clearable: true, task: 'chop', work: 25, yields: { wood: 3 } },
  [OBJ.DEAD_TREE]: { name: 'dead tree', blocks: true, tall: true, clearable: true, task: 'chop', work: 15, yields: { wood: 2 } },
  [OBJ.ROCK]: { name: 'rock', blocks: true, clearable: true, task: 'clear', work: 12, yields: { stone: 2 } },
  [OBJ.WEED]: { name: 'weeds', blocks: false, clearable: true, task: 'clear', work: 5, yields: { fiber: 1 } },
  [OBJ.BUSH]: { name: 'bush', blocks: true, clearable: true, task: 'clear', work: 8, yields: { fiber: 2 } },
  [OBJ.STUMP]: { name: 'stump', blocks: true, clearable: true, task: 'clear', work: 18, yields: { wood: 1 } },
  [OBJ.FENCE]: { name: 'fence', blocks: true },
  // Gates block animals but the farmer opens them, so blocking is per-actor.
  [OBJ.GATE]: { name: 'gate', blocks: false, blocksAnimals: true },
  [OBJ.TROUGH_WATER]: { name: 'water trough', blocks: true },
  [OBJ.TROUGH_FOOD]: { name: 'feed trough', blocks: true },
  [OBJ.BARREL]: { name: 'barrel', blocks: true },
  // Every tile of a multi-tile building's footprint carries this marker so
  // walkability and tap handling work without knowing about buildings. The
  // building itself lives in state.buildings.
  [OBJ.BUILDING]: { name: 'building', blocks: true },
  // Chickens lay on the ground rather than being collected from, so an egg is
  // a thing lying in the grass. It's `clearable`, which means the existing
  // clear/pick-up pipeline handles it with no special cases — and being
  // non-blocking, animals and the farmer walk straight over it.
  [OBJ.EGG]: {
    name: 'egg', blocks: false, clearable: true,
    task: 'pickup', work: 3, yields: { egg: 1 },
  },
};

export function objDef(id) { return OBJ_DEFS[id] || OBJ_DEFS[OBJ.NONE]; }
