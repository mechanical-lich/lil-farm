// The task queue: the player's only way to make anything happen.
//
// Tasks are plain serializable records. The farmer executes them strictly in
// order; a task it cannot reach goes to the back of the queue and is retried
// later, so one unreachable rock never deadlocks the whole farm.

import { emitUnlessSuspended } from '../engine/events.js';
import { OBJ, GROUND, objDef, isTilled } from '../world/tiledefs.js';
import { cropAt, isRipe, isStalled, cropDef } from './crops.js';
import { buildDef, canPlaceAt, structureAt, demolishWork, troughAnchorAt } from './build.js';
import { animalDef, TROUGH_CAPACITY, isReady } from './animals.js';
import { mushroomAt } from './mushrooms.js';

/** Work is measured in ticks (1 tick = 1 second). */
export const TASK_TYPES = {
  clear: { label: 'Clear', verb: 'Clearing' },
  chop: { label: 'Chop', verb: 'Chopping' },
  untill: { label: 'Clear', verb: 'Clearing' },
  demolish: { label: 'Remove', verb: 'Removing' },
  pickup: { label: 'Pick up', verb: 'Picking up' },
  forage: { label: 'Pick', verb: 'Picking' },
  fill: { label: 'Fill', verb: 'Filling' },
  collect: { label: 'Collect', verb: 'Collecting' },
  till: { label: 'Till', verb: 'Tilling' },
  plant: { label: 'Plant', verb: 'Planting' },
  water: { label: 'Water', verb: 'Watering' },
  harvest: { label: 'Harvest', verb: 'Harvesting' },
  build: { label: 'Build', verb: 'Building' },
};

/** How long each farming action takes, in ticks. */
export const WORK = {
  till: 8,
  plant: 4,
  water: 3,
  harvest: 6,
  clearDead: 4,
  untill: 5,
  fill: 8,
  collect: 6,
};

/** A task the player cannot see the point of is a bug; keep labels concrete. */
export function taskLabel(task) {
  const base = TASK_TYPES[task.type]?.label || task.type;
  return task.detail ? `${base} ${task.detail}` : base;
}

export function addTask(state, task) {
  // One task per tile per type, so drag-painting over the same tile twice or
  // double-tapping doesn't queue duplicate work.
  if (findTaskAt(state, task.x, task.y, task.type)) return null;

  const full = {
    id: state.nextTaskId++,
    retries: 0,
    progress: 0,
    ...task,
  };
  state.tasks.push(full);
  emitUnlessSuspended('tasks:changed');
  return full;
}

/**
 * Tilling happens in rows, never as a free-form area: the soil art is a capsule
 * set with rounded end-caps, so a bed has to run along one axis to be drawn
 * correctly. Two corner points are therefore snapped to whichever axis the
 * player dragged furthest along, and the shorter axis is discarded.
 *
 * @returns {{dir:'h'|'v', tiles: Array<{x:number,y:number}>}}
 */
export function tillRow(a, b) {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  const horizontal = dx >= dy;
  const tiles = [];

  if (horizontal) {
    const [x0, x1] = a.x <= b.x ? [a.x, b.x] : [b.x, a.x];
    for (let x = x0; x <= x1; x++) tiles.push({ x, y: a.y });
  } else {
    const [y0, y1] = a.y <= b.y ? [a.y, b.y] : [b.y, a.y];
    for (let y = y0; y <= y1; y++) tiles.push({ x: a.x, y });
  }

  return { dir: horizontal ? 'h' : 'v', tiles };
}

/**
 * Queues a whole tilling row. Tiles that cannot be tilled (occupied, already
 * ploughed) are skipped rather than aborting the row, so one stray rock in the
 * middle doesn't cost the player the whole drag.
 *
 * @returns {{queued:number, skipped:number, dir:'h'|'v'}}
 */
export function queueTillRow(state, a, b) {
  const { dir, tiles } = tillRow(a, b);
  let queued = 0;
  let skipped = 0;

  for (const t of tiles) {
    const spec = taskForTile(state, t.x, t.y, 'till');
    if (!spec) { skipped++; continue; }
    spec.tillDir = dir;
    if (addTask(state, spec)) queued++;
    else skipped++;
  }

  return { queued, skipped, dir };
}

export function findTaskAt(state, x, y, type) {
  return state.tasks.find((t) => t.x === x && t.y === y && (!type || t.type === type)) || null;
}

export function cancelTask(state, id) {
  const i = state.tasks.findIndex((t) => t.id === id);
  if (i === -1) return false;

  const [removed] = state.tasks.splice(i, 1);
  // If the farmer was mid-way through it, drop the work and re-plan.
  if (state.farmer.taskId === removed.id) {
    state.farmer.taskId = null;
    state.farmer.path = [];
    state.farmer.work = 0;
  }
  emitUnlessSuspended('tasks:changed');
  return true;
}

export function prioritizeTask(state, id) {
  const i = state.tasks.findIndex((t) => t.id === id);
  if (i <= 0) return false;

  const [task] = state.tasks.splice(i, 1);
  state.tasks.unshift(task);
  // Make the farmer reconsider immediately rather than finishing the old task.
  if (state.farmer.taskId !== task.id) {
    state.farmer.taskId = null;
    state.farmer.path = [];
    state.farmer.work = 0;
  }
  emitUnlessSuspended('tasks:changed');
  return true;
}

/** Moves a task that couldn't be started to the back of the queue. */
export function deferTask(state, id) {
  const i = state.tasks.findIndex((t) => t.id === id);
  if (i === -1) return;
  const [task] = state.tasks.splice(i, 1);
  task.retries++;
  task.progress = 0;
  state.tasks.push(task);
  emitUnlessSuspended('tasks:changed');
}

export function completeTask(state, id) {
  const i = state.tasks.findIndex((t) => t.id === id);
  if (i === -1) return;
  state.tasks.splice(i, 1);
  emitUnlessSuspended('tasks:changed');
}

/**
 * What the player gets by tapping a tile with a given tool: the one sensible
 * action there, or null if there's nothing to do. Keeping this in the sim (not
 * the UI) means the rules for "can I do this here" live in exactly one place.
 *
 * @param {string} tool 'auto' picks the obvious action for the tile; the other
 *   tools only ever produce their own kind of task, which is what makes
 *   drag-painting a whole field predictable.
 */
export function taskForTile(state, x, y, tool = 'auto', opts = {}) {
  const grid = state.grid;
  if (!grid.inBounds(x, y)) return null;
  // Nothing at all can be queued on land the player hasn't bought. One check
  // here covers every tool, so no new tool can forget it.
  if (!grid.isOwned(x, y)) return null;

  const obj = grid.getObject(x, y);
  const def = objDef(obj);
  const ground = grid.getGround(x, y);
  const crop = cropAt(state, x, y);

  const clearTask = () => (def.clearable ? {
    type: def.task || 'clear',
    x, y,
    work: def.work || 10,
    // A mushroom says which one it is, so the queue reads "Pick red toadstool"
    // rather than the same line four times over.
    detail: mushroomAt(state, x, y)?.name || def.name,
    // Blocking obstacles are worked on from an adjacent tile.
    adjacent: !!def.blocks,
  } : null);

  // Undoing a bed. Only offered when the bed is empty: a growing crop is worth
  // real waiting time, so it must be harvested or cleared deliberately rather
  // than destroyed by a stray tap of the clear tool.
  const untillTask = () => {
    if (obj !== OBJ.NONE || !isTilled(ground) || crop) return null;
    return { type: 'untill', x, y, work: WORK.untill, detail: 'bed' };
  };

  // Taking down something the player built. Deliberately only offered by the
  // explicit clear tool, never by 'auto' — a stray tap should not be able to
  // demolish a fence you spent materials on.
  const demolishTask = () => {
    const found = structureAt(state, x, y);
    if (!found) return null;
    const def = buildDef(found.kind);
    return {
      type: 'demolish',
      x: found.x,
      y: found.y,
      work: demolishWork(found.kind),
      detail: def.name.toLowerCase(),
      w: def.size[0], h: def.size[1],
      adjacent: def.obj != null,   // solid structures are worked on from beside
    };
  };

  switch (tool) {
    case 'clear':
      return clearTask() || demolishTask() || untillTask();

    case 'till':
      // Only bare, unplanted, unobstructed ground can be ploughed.
      if (obj !== OBJ.NONE || crop) return null;
      if (isTilled(ground)) return null;
      if (ground !== GROUND.GRASS && ground !== GROUND.DIRT) return null;
      return { type: 'till', x, y, work: WORK.till, detail: 'soil' };

    case 'plant': {
      if (!isTilled(ground) || crop || obj !== OBJ.NONE) return null;
      const type = opts.cropType;
      if (!type || !cropDef(type)) return null;
      return { type: 'plant', x, y, work: WORK.plant, detail: cropDef(type).name, cropType: type };
    }

    case 'water':
      // Watering bare tilled soil is allowed: the player can prepare a bed.
      if (!isTilled(ground)) return null;
      if (crop && crop.dead) return null;
      return { type: 'water', x, y, work: WORK.water, detail: crop ? cropDef(crop.type).name : 'soil' };

    case 'build': {
      const kind = opts.buildKind;
      const def = buildDef(kind);
      if (!def || !canPlaceAt(state, kind, x, y)) return null;
      return {
        type: 'build', x, y, work: def.work, detail: def.name.toLowerCase(), buildKind: kind,
        // Carrying the footprint on the task lets the UI outline the whole
        // structure without having to know anything about build recipes.
        w: def.size[0], h: def.size[1],
        // Structures are solid, so the farmer works on them from alongside.
        adjacent: true,
      };
    }

    case 'harvest':
      if (!crop) return null;
      if (crop.dead) {
        return { type: 'harvest', x, y, work: WORK.clearDead, detail: 'dead crop' };
      }
      if (!isRipe(crop)) return null;
      return { type: 'harvest', x, y, work: WORK.harvest, detail: cropDef(crop.type).name };

    case 'auto':
    default: {
      // Tap-anywhere convenience: the most useful thing this tile needs.
      // Animals and troughs come first — they're what you tap them for.
      const ready = state.animals?.find((a) => isReady(a) && a.x === x && a.y === y);
      if (ready) {
        return {
          type: 'collect', x, y, work: WORK.collect,
          detail: animalDef(ready.type).produces, animalId: ready.id,
        };
      }
      const trough = troughAnchorAt(state, x, y);
      if (trough) {
        const t = state.troughs[`${trough.x},${trough.y}`];
        if (t && (t.level || 0) < TROUGH_CAPACITY) {
          return {
            type: 'fill', x: trough.x, y: trough.y, work: WORK.fill,
            detail: t.kind === 'water' ? 'water trough' : 'feed trough',
            w: 2, h: 1, adjacent: true,
          };
        }
        return null;
      }
      if (crop) {
        if (crop.dead) return { type: 'harvest', x, y, work: WORK.clearDead, detail: 'dead crop' };
        if (isRipe(crop)) return { type: 'harvest', x, y, work: WORK.harvest, detail: cropDef(crop.type).name };
        // An unwatered seed isn't growing at all, so watering is the useful act.
        if (isStalled(crop)) return { type: 'water', x, y, work: WORK.water, detail: cropDef(crop.type).name };
        return null;
      }
      return clearTask();
    }
  }
}
