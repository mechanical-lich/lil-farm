// The task queue: the player's only way to make anything happen.
//
// Tasks are plain serializable records. The farmer executes them strictly in
// order; a task it cannot reach goes to the back of the queue and is retried
// later, so one unreachable rock never deadlocks the whole farm.

import { emitUnlessSuspended } from '../engine/events.js';
import { addItems, itemName } from './inventory.js';
import { OBJ, GROUND, objDef, isTilled, isWater } from '../world/tiledefs.js';
import { cropAt, isRipe, isStalled, cropDef } from './crops.js';
import {
  buildDef, canPlaceAt, structureAt, demolishWork, troughAnchorAt, isReserved,
  footprint, workOf, sizeOf,
} from './build.js';
import { animalDef, TROUGH_CAPACITY, isReady } from './animals.js';
import { mushroomAt, forage } from './mushrooms.js';
import { flowerAt, pick as pickFlower, canPlantAt } from './flowers.js';
import { readSeedId, seedName } from './flowergenes.js';
import { handAt, carriedTotal } from './farmhand.js';
import { crateAt } from './crates.js';
import { potAt } from './pots.js';

/** Work is measured in ticks (1 tick = 1 second). */
export const TASK_TYPES = {
  clear: { label: 'Clear', verb: 'Clearing' },
  chop: { label: 'Chop', verb: 'Chopping' },
  untill: { label: 'Clear', verb: 'Clearing' },
  demolish: { label: 'Remove', verb: 'Removing' },
  pickup: { label: 'Pick up', verb: 'Picking up' },
  forage: { label: 'Pick', verb: 'Picking' },
  pick: { label: 'Pick', verb: 'Picking' },
  plantflower: { label: 'Plant', verb: 'Planting' },
  fill: { label: 'Fill', verb: 'Filling' },
  collect: { label: 'Collect', verb: 'Collecting' },
  gather: { label: 'Take', verb: 'Taking' },
  unload: { label: 'Empty', verb: 'Emptying' },
  liftpot: { label: 'Take', verb: 'Taking' },
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
  gather: 5,
  unload: 5,
  liftpot: 5,
};

/** A task the player cannot see the point of is a bug; keep labels concrete. */
export function taskLabel(task) {
  const base = TASK_TYPES[task.type]?.label || task.type;
  return task.detail ? `${base} ${task.detail}` : base;
}

/**
 * Keeps work that is aimed at somebody pointed at where they actually are.
 *
 * A cow is milked where it is, not where it was standing when you tapped it,
 * and the same goes for taking a satchel off a farmhand. The task carries an
 * id and its x/y is refreshed each tick, so the farmer walks to wherever they
 * have got to instead of solemnly milking a patch of empty grass.
 *
 * A task whose subject has gone — an animal sold — is dropped rather than left
 * pointing at nothing.
 */
export function followTargets(state) {
  for (const task of state.tasks) {
    const subject = task.animalId != null
      ? (state.animals || []).find((a) => a.id === task.animalId)
      : task.handId != null
        ? (state.hands || []).find((h) => h.id === task.handId)
        : null;
    if (subject === null) continue;               // not aimed at anybody

    if (!subject) {
      cancelTask(state, task.id);
      continue;
    }
    task.x = subject.x;
    task.y = subject.y;
  }
}

/**
 * Clears whatever has turned up on a build site, keeping anything worth having.
 *
 * Two kinds of thing turn up here. A building may be sited over scenery in the
 * first place — a farm is scattered with trees and weeds, and requiring a bare
 * rectangle made a big barn impossible to place — so the trees on the site are
 * expected, and the wood goes in the bag. The rest arrived on their own while
 * the task waited: reservation keeps deliberate things out, but not a hen, who
 * wanders where she likes and lays where she stands.
 *
 * Either way nothing is destroyed and the build is never cancelled.
 *
 * @returns {object} items gained, in the same shape the task pipeline reports
 */
export function clearBuildSite(state, task) {
  // An overlay hangs on what is already there, so there is no site to clear.
  // Without this a scythe hung on a well demolished the well on its way up —
  // and would have foraged a mushroom or picked a flower it was hung over,
  // which is the same bug wearing a different hat.
  if (buildDef(task.buildKind)?.overlay) return {};

  const gained = {};
  const add = (items) => {
    for (const [id, n] of Object.entries(items || {})) gained[id] = (gained[id] || 0) + n;
  };

  for (const t of footprint(task.buildKind, task.x, task.y, sizeOf(task))) {
    if (flowerAt(state, t.x, t.y)) {
      // Same reasoning as mushrooms below: pick() clears the tile and takes
      // the state.flowers entry with it. Paving over one would strand the
      // entry for ever and eat a slot in the spawn cap.
      add(pickFlower(state, t.x, t.y));
      continue;
    }

    if (mushroomAt(state, t.x, t.y)) {
      // forage() clears the tile, banks the mushroom and writes the journal —
      // and, critically, removes the state.mushrooms entry. Paving over one
      // would strand that entry forever and eat a slot in the spawn cap.
      // It banks the item itself, so this only records it for the report.
      add(forage(state, t.x, t.y));
      continue;
    }

    const obj = state.grid.getObject(t.x, t.y);
    if (obj === OBJ.NONE) continue;
    const def = objDef(obj);
    if (def.yields) {
      add(def.yields);
      addItems(state, def.yields);
    }
    state.grid.setObject(t.x, t.y, OBJ.NONE);
  }

  return gained;
}

export function addTask(state, task) {
  // Work aimed at somebody is identified by them, not by the tile: the task
  // follows them around (see followTargets), so two taps a moment apart would
  // otherwise queue the same milking twice from two different spots.
  if (task.animalId != null || task.handId != null) {
    const same = (t) => t.type === task.type
      && t.animalId === task.animalId && t.handId === task.handId;
    if (state.tasks.some(same)) return null;
  } else if (findTaskAt(state, task.x, task.y, task.type)) {
    // One task per tile per type, so drag-painting over the same tile twice or
    // double-tapping doesn't queue duplicate work.
    return null;
  }

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

/**
 * The queued task a tap on this tile is pointing at, if any.
 *
 * Not the same question as findTaskAt, which wants an exact tile: a queued barn
 * covers a rectangle, and tapping the middle of the outline the player can see
 * on the map should find it. Later tasks win ties, so tapping repeatedly peels
 * a stack off in the order it went on.
 *
 * @returns {object|null}
 */
export function taskCovering(state, x, y) {
  let found = null;
  for (const task of state.tasks || []) {
    if (task.type === 'build') {
      const covers = footprint(task.buildKind, task.x, task.y, sizeOf(task))
        .some((t) => t.x === x && t.y === y);
      if (covers) found = task;
      continue;
    }
    // Everything else is worked at one tile, whatever size it draws.
    if (task.x === x && task.y === y) found = task;
  }
  return found;
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
    detail: mushroomAt(state, x, y)?.name || flowerAt(state, x, y)?.name || def.name,
    // Blocking obstacles are worked on from an adjacent tile.
    adjacent: !!def.blocks,
  } : null);

  // Taking a pot away. Offered before demolishing, because a pot may be
  // standing on a road and the pot is the thing on top — the same "clear what
  // you can see first" order that takes a scythe off a fence before the fence.
  // A flower in it is picked first of all, by clearTask above, since the flower
  // is what the grid says is there.
  const potTask = () => (potAt(state, x, y)
    ? { type: 'liftpot', x, y, work: WORK.liftpot, detail: 'flower pot' }
    : null);

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
    const size = found.w > 0 ? [found.w, found.h] : def.size;
    return {
      type: 'demolish',
      x: found.x,
      y: found.y,
      work: demolishWork(found.kind, size),
      detail: def.name.toLowerCase(),
      w: size[0], h: size[1],
      // Solid structures are worked on from beside — and so is water, which
      // the farmer plainly cannot stand in to fill back in.
      adjacent: def.obj != null || isWater(def.ground),
    };
  };

  switch (tool) {
    case 'clear':
      return clearTask() || potTask() || demolishTask() || untillTask();

    case 'till':
      // Only bare, unplanted, unobstructed ground can be ploughed.
      if (obj !== OBJ.NONE || crop) return null;
      // ...and not the ground a queued build is standing on.
      if (isReserved(state, x, y)) return null;
      if (isTilled(ground)) return null;
      if (ground !== GROUND.GRASS && ground !== GROUND.DIRT) return null;
      return { type: 'till', x, y, work: WORK.till, detail: 'soil' };

    case 'plant': {
      if (!isTilled(ground) || crop || obj !== OBJ.NONE) return null;
      const type = opts.cropType;
      if (!type || !cropDef(type)) return null;
      return { type: 'plant', x, y, work: WORK.plant, detail: cropDef(type).name, cropType: type };
    }

    // Putting a saved colour back in the ground. Flowers grow in grass rather
    // than in a bed, so this asks the same question wild ones do — is this open
    // ground you own — rather than looking for tilled soil.
    case 'plantflower': {
      const seed = readSeedId(opts.seedId);
      if (!seed || !canPlantAt(state, x, y)) return null;
      return {
        type: 'plantflower', x, y, work: WORK.plant,
        detail: seedName(opts.seedId).replace(/ seeds$/, ''),
        seedId: opts.seedId,
      };
    }

    case 'water': {
      // A flower is watered to make it cross with its neighbours — see
      // sim/flowers.js. It grows in grass, so this asks about the flower
      // rather than about the ground under it.
      const bloom = flowerAt(state, x, y);
      if (bloom) return { type: 'water', x, y, work: WORK.water, detail: bloom.name };

      // Watering bare tilled soil is allowed: the player can prepare a bed.
      if (!isTilled(ground)) return null;
      if (crop && crop.dead) return null;

      // Tiles a watering can would do nothing to are skipped, so a drag across
      // a field queues only the work that's actually left. Without this a
      // watering pass costs the same on a field that's half picked as it did
      // on the day it was sown, and the player pays for the whole bed every
      // time to reach the few tiles that still need it.
      //
      // A ripe crop has finished growing — water is no use to it. And a crop
      // that's already growing on damp soil has everything it needs; watering
      // is a one-way latch (see updateCrops), so there's nothing to top up.
      //
      // Bare wet soil is deliberately *not* skipped: re-wetting it extends the
      // window in which a seed planted there starts out watered, which is the
      // whole water-then-plant workflow.
      if (crop && isRipe(crop)) return null;
      if (crop && crop.watered && ground === GROUND.TILLED_WET) return null;

      return { type: 'water', x, y, work: WORK.water, detail: crop ? cropDef(crop.type).name : 'soil' };
    }

    case 'build': {
      const kind = opts.buildKind;
      const def = buildDef(kind);
      // A barn is sized by the player, so the caller passes one in; everything
      // else is whatever its recipe says.
      const size = (opts && opts.size) || def?.size;
      if (!def || !canPlaceAt(state, kind, x, y, size)) return null;
      return {
        type: 'build', x, y, work: workOf(kind, size), detail: def.name.toLowerCase(), buildKind: kind,
        // Carrying the footprint on the task lets the UI outline the whole
        // structure without having to know anything about build recipes.
        w: size[0], h: size[1],
        // Structures are solid, so the farmer works on them from alongside.
        adjacent: true,
      };
    }

    case 'harvest': {
      // Picking a flower is deliberate: you reach for the harvest tool first.
      // A tap takes the flower's *water* (see 'auto' below), because watering
      // is what a player does over and over to a bed they are breeding, and
      // picking is the thing they do once and cannot undo.
      const bloom = flowerAt(state, x, y);
      if (bloom) {
        const def = objDef(OBJ.FLOWER);
        return { type: 'pick', x, y, work: def.work, detail: bloom.name };
      }

      // A mushroom is gathered rather than grown, but it is still something you
      // reach out and take — so the harvest tool finds it too. Clearing the
      // tile still works, as it always has; this is about the tool a player
      // picks up when they mean "collect", which is the harvest one.
      const shroom = mushroomAt(state, x, y);
      if (shroom) {
        const def = objDef(OBJ.MUSHROOM);
        return { type: 'forage', x, y, work: def.work, detail: shroom.name };
      }

      if (!crop) return null;
      if (crop.dead) {
        return { type: 'harvest', x, y, work: WORK.clearDead, detail: 'dead crop' };
      }
      if (!isRipe(crop)) return null;
      return { type: 'harvest', x, y, work: WORK.harvest, detail: cropDef(crop.type).name };
    }

    case 'auto':
    default: {
      // Tap-anywhere convenience: the most useful thing this tile needs.
      // Animals and troughs come first — they're what you tap them for.
      // A farmhand with a full satchel is the most useful thing on the tile.
      const hand = handAt(state, x, y);
      if (hand && carriedTotal(hand) > 0) {
        return {
          type: 'gather', x, y, work: WORK.gather,
          detail: 'from the farmhand', handId: hand.id,
        };
      }

      const ready = state.animals?.find((a) => isReady(a) && a.x === x && a.y === y);
      if (ready) {
        return {
          type: 'collect', x, y, work: WORK.collect,
          detail: animalDef(ready.type).produces, animalId: ready.id,
        };
      }
      // A crate with something in it is worth a tap for the same reason a full
      // farmhand is: it's the farm having gathered something and waiting for
      // you to come and collect it. An empty one has nothing to offer, so the
      // tap falls through to whatever else the tile needs.
      const crate = crateAt(state, x, y);
      if (crate && crate.item && crate.qty > 0) {
        return {
          type: 'unload', x, y, work: WORK.unload,
          detail: `${itemName(crate.item)} crate`, adjacent: true,
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
      // A tap on a flower waters it. Watering is the only say the player has
      // over breeding, and it is a thing they will do to the same bed again and
      // again — so it belongs on the tool that is already in their hand. There
      // is no way to undo a picking, and a tap is too easy to make by accident
      // to be allowed to destroy a colour that took a week to breed.
      const bloom = flowerAt(state, x, y);
      if (bloom) return { type: 'water', x, y, work: WORK.water, detail: bloom.name };

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
