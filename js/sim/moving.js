// Picking things up and putting them somewhere else.
//
// A farm is somewhere you arrange. Animals wander, the farmhand walks its own
// rounds, and after a while things end up where the simulation left them
// rather than where you want them — the cow on the wrong side of the fence,
// the hand parked by the wrong barn. This is the player reaching in and
// putting them right.
//
// It is not a task: like petting, it happens because the player did it, not
// because the farmer was sent to do it. Nothing is queued and nothing is paid.

import { animalDef, actorFor } from './animals.js';
import { emitUnlessSuspended } from '../engine/events.js';

/**
 * Whatever movable thing is standing on this tile.
 *
 * Order matters where two things share a tile: the farmhand and the farmer are
 * the ones a player is most likely to be reaching for, since animals move
 * themselves anyway.
 *
 * @returns {{kind: string, ref: object, name: string}|null}
 */
export function movableAt(state, x, y) {
  const hand = (state.hands || []).find((h) => h.x === x && h.y === y);
  if (hand) return { kind: 'hand', ref: hand, name: 'farmhand' };

  if (state.farmer.x === x && state.farmer.y === y) {
    return { kind: 'farmer', ref: state.farmer, name: 'farmer' };
  }

  const animal = (state.animals || []).find((a) => a.x === x && a.y === y);
  if (animal) return { kind: 'animal', ref: animal, name: animalDef(animal.type).name.toLowerCase() };

  return null;
}

/** Can this particular thing stand there? */
export function canMoveTo(state, movable, x, y) {
  if (!movable) return false;
  const actor = movable.kind === 'animal' ? actorFor(movable.ref) : 'farmer';
  return state.grid.isWalkable(x, y, actor);
}

/**
 * Sets it down.
 *
 * Everything in flight is thrown away deliberately: a half-walked path, a job
 * a farmhand had claimed, the previous position the renderer interpolates
 * from. Keeping any of it would have the thing slide back across the map from
 * where it used to be, or carry on to a target it can no longer sensibly reach.
 */
export function moveTo(state, movable, x, y) {
  if (!canMoveTo(state, movable, x, y)) return { ok: false, reason: "it can't go there" };

  const it = movable.ref;
  it.x = x;
  it.y = y;
  it.px = x;
  it.py = y;
  it.path = [];

  if (movable.kind === 'farmer') {
    // The farmer's trail is what the renderer walks him along; a stale one
    // would drag him back to where he was picked up from.
    it.trail = [{ x, y }];
    it.taskId = null;
    it.work = 0;
  }
  if (movable.kind === 'hand') {
    it.target = null;
    it.restSpot = null;
    it.scannedAt = null;
    it.work = 0;
  }

  emitUnlessSuspended('entity:moved', { kind: movable.kind, x, y });
  return { ok: true };
}
