// The farmer NPC: a small state machine run once per tick.
//
//   no task      -> claim the first task in the queue
//   task claimed -> path to it (or defer it if unreachable)
//   in position  -> spend ticks on it until the work is done
//   nothing to do -> wander
//
// Movement is one tile per tick. The renderer interpolates between the previous
// and current tile so it looks smooth without the sim caring about frame rate.

import { FARMER_SPEED } from '../config.js';
import { findPath, besideBox, insideBox } from '../world/pathfind.js';
import { OBJ, objDef, GROUND } from '../world/tiledefs.js';
import { deferTask, completeTask, clearBuildSite } from './tasks.js';
import { addItems, removeItem } from './inventory.js';
import { plantCrop, waterTile, harvestCrop, seedIdFor } from './crops.js';
import { completeBuild, demolish, canCompleteBuild } from './build.js';
import { fillWaterTrough, fillFeedTrough, collectFrom } from './animals.js';
import { forage } from './mushrooms.js';
import { takeFromHand } from './farmhand.js';
import { emitUnlessSuspended } from '../engine/events.js';

const WANDER_CHANCE = 0.08;   // per idle tick

export function updateFarmer(state) {
  const f = state.farmer;

  // Every tile touched this tick, starting from where we began. The renderer
  // walks this polyline so a multi-tile step follows the actual route instead
  // of cutting the corner on a turn.
  f.trail = [{ x: f.x, y: f.y }];

  if (f.taskId === null) {
    claimNextTask(state);
    if (f.taskId === null) {
      wander(state);
      return;
    }
  }

  const task = state.tasks.find((t) => t.id === f.taskId);
  if (!task) {                 // cancelled out from under us
    f.taskId = null;
    f.path = [];
    f.work = 0;
    return;
  }

  if (f.path && f.path.length > 0) {
    step(state, f);
    return;
  }

  if (inPosition(f, task)) {
    doWork(state, task);
  } else {
    // We arrived at where we planned to stand but the goal moved or the route
    // is stale; re-plan once, and defer the task if it's genuinely unreachable.
    if (!planRouteTo(state, task)) deferTask(state, task.id);
    else if (f.path.length === 0) doWork(state, task);
  }
}

function claimNextTask(state) {
  const f = state.farmer;
  for (const task of state.tasks) {
    if (planRouteTo(state, task)) {
      f.taskId = task.id;
      return;
    }
    // Unreachable right now (fenced off, or blocked by another obstacle).
    // Push it back so the farmer moves on instead of stalling forever.
    deferTask(state, task.id);
    emitUnlessSuspended('task:unreachable', { task });
    return;
  }
}

/** @returns {boolean} true if a route exists (possibly of length 0). */
function planRouteTo(state, task) {
  const f = state.farmer;
  const path = findPath(
    state.grid,
    { x: f.x, y: f.y },
    { x: task.x, y: task.y },
    { actor: 'farmer', adjacent: !!task.adjacent, w: task.w || 1, h: task.h || 1 },
  );
  if (path === null) return false;
  f.path = path;
  return true;
}

/** Walks up to FARMER_SPEED tiles along the planned route. */
function step(state, f) {
  for (let i = 0; i < FARMER_SPEED && f.path.length > 0; i++) {
    const next = f.path.shift();

    // The world can change under a planned route (a new fence, a felled tree).
    if (!state.grid.isWalkable(next.x, next.y, 'farmer')) {
      f.path = [];
      return;
    }

    f.dir = next.x > f.x ? 'right' : next.x < f.x ? 'left' : next.y > f.y ? 'down' : 'up';
    // Facing only changes on horizontal movement, so walking straight up or
    // down doesn't spin the sprite round.
    if (next.x !== f.x) f.facing = next.x > f.x ? 'right' : 'left';
    f.x = next.x;
    f.y = next.y;
    f.trail.push({ x: f.x, y: f.y });

    // Gates open as the farmer passes and close behind; animals can't do this.
    if (state.grid.getObject(f.x, f.y) === OBJ.GATE) {
      emitUnlessSuspended('gate:used', { x: f.x, y: f.y });
    }
  }
}

function inPosition(f, task) {
  const w = task.w || 1;
  const h = task.h || 1;
  // Must match findPath's goal test exactly, or the farmer arrives somewhere
  // the route considered acceptable and then refuses to start work.
  return task.adjacent
    ? besideBox(task.x, task.y, w, h, f.x, f.y)
    : insideBox(task.x, task.y, w, h, f.x, f.y);
}

function doWork(state, task) {
  const f = state.farmer;
  f.dir = task.x > f.x ? 'right' : task.x < f.x ? 'left' : task.y > f.y ? 'down' : 'up';

  task.progress = (task.progress || 0) + 1;
  f.work = task.progress;

  if (task.progress < task.work) return;

  applyTaskResult(state, task);
  completeTask(state, task.id);
  f.taskId = null;
  f.work = 0;
  f.path = [];
}

/** The moment a task's effect lands on the world. */
function applyTaskResult(state, task) {
  const grid = state.grid;
  let gained = null;

  switch (task.type) {
    case 'clear':
    case 'chop':
    case 'pickup': {
      const obj = grid.getObject(task.x, task.y);
      const def = objDef(obj);
      gained = def.yields || null;
      addItems(state, gained);
      grid.setObject(task.x, task.y, OBJ.NONE);
      // Cleared land goes back to plain grass. Leaving bare earth behind made
      // a tidied farm look scarred rather than cleared.
      emitUnlessSuspended('world:changed', { x: task.x, y: task.y });
      break;
    }
    case 'till':
      grid.setGround(task.x, task.y, GROUND.TILLED);
      // Remember which way the row ran; the renderer uses it to pick the right
      // capsule piece, which is what keeps two adjacent rows reading as two
      // beds instead of merging into one grid.
      state.tillDir[`${task.x},${task.y}`] = task.tillDir === 'v' ? 'v' : 'h';
      emitUnlessSuspended('world:changed', { x: task.x, y: task.y });
      break;

    case 'plant':
      // The seed leaves the bag only now, when it actually goes in the ground,
      // so cancelling a queued planting never costs the player anything.
      if (removeItem(state, seedIdFor(task.cropType), 1)) {
        plantCrop(state, task.x, task.y, task.cropType);
      } else {
        emitUnlessSuspended('task:failed', { task, reason: 'no seeds' });
      }
      break;

    case 'untill': {
      // Undo a bed back to plain grass. The row axis and any wetness must go
      // with it, or a later bed on this tile would inherit a stale orientation
      // and cap itself against neighbours it no longer belongs to.
      const key = `${task.x},${task.y}`;
      grid.setGround(task.x, task.y, GROUND.GRASS);
      delete state.tillDir[key];
      delete state.wetUntil[key];
      emitUnlessSuspended('world:changed', { x: task.x, y: task.y });
      break;
    }

    case 'water':
      waterTile(state, task.x, task.y);
      break;

    case 'harvest':
      gained = harvestCrop(state, task.x, task.y);
      break;

    case 'fill': {
      const trough = state.troughs[`${task.x},${task.y}`];
      if (!trough) break;
      const res = trough.kind === 'water'
        ? fillWaterTrough(state, task.x, task.y)
        : fillFeedTrough(state, task.x, task.y);
      if (!res.ok) {
        emitUnlessSuspended('task:failed', { task, reason: res.reason || 'could not fill it' });
      }
      break;
    }

    case 'forage': {
      // Which mushroom it was is looked up at the moment it's picked, not when
      // the task was queued — that's the only place that knows.
      gained = forage(state, task.x, task.y);
      break;
    }

    case 'gather': {
      const hand = (state.hands || []).find((h) => h.id === task.handId);
      if (hand) {
        gained = takeFromHand(hand);
        addItems(state, gained);
      }
      break;
    }

    case 'collect': {
      const animal = state.animals.find((a) => a.id === task.animalId);
      gained = collectFrom(state, animal);
      break;
    }

    case 'demolish': {
      // Half the materials come back, so a misplaced fence is a small loss
      // rather than a permanent scar on the farm.
      const result = demolish(state, task.x, task.y);
      if (result.ok) {
        gained = result.refund;
        addItems(state, gained);
      }
      break;
    }

    case 'build':
      // The materials may have been spent elsewhere while this sat in the
      // queue; say so rather than silently building something for free.
      // Checked *before* clearing the site, so an unaffordable barn doesn't
      // cost the player an egg on the way to failing.
      if (!canCompleteBuild(state, task)) {
        emitUnlessSuspended('task:failed', { task, reason: `not enough materials for a ${task.detail}` });
        break;
      }
      gained = clearBuildSite(state, task);
      completeBuild(state, task);
      break;

    default:
      break;
  }

  emitUnlessSuspended('task:done', { task, gained });
}

function wander(state) {
  const f = state.farmer;
  if (!state.rng.chance(WANDER_CHANCE)) return;

  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const [dx, dy] = dirs[state.rng.int(4)];
  const nx = f.x + dx;
  const ny = f.y + dy;
  if (!state.grid.isWalkable(nx, ny, 'farmer')) return;

  f.dir = dx > 0 ? 'right' : dx < 0 ? 'left' : dy > 0 ? 'down' : 'up';
  if (dx !== 0) f.facing = dx > 0 ? 'right' : 'left';
  f.x = nx;
  f.y = ny;
  f.trail.push({ x: nx, y: ny });
}
