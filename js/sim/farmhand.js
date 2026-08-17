// The farmhand: hired help who does the rounds so you don't have to.
//
// Everything else on this farm happens because the player asked for it. The
// farmhand is the exception: you pay once, and from then on they walk the farm
// milking, shearing and picking up eggs on their own. That's the point of them
// — a farm big enough to be worth having is a farm where tapping every hen
// individually stops being a pleasure.
//
// They are deliberately *not* a second farmer. They never clear, till, plant or
// build; they only gather what animals have already produced. And what they
// gather goes into their own pockets, not yours: when they fill up they walk to
// a barn and wait for you to come and take it off them. That keeps the player
// in the loop — the help is a multiplier on your farm, not a replacement for
// visiting it.
//
// Hard rules, same as everything in sim/: no DOM, no Math.random(), no
// Date.now(). Catch-up replays this thousands of times over.

import { emitUnlessSuspended } from '../engine/events.js';
import { OBJ, objDef } from '../world/tiledefs.js';
import { findPath, besideBox } from '../world/pathfind.js';
import { animalDef, isReady, takeFromAnimal } from './animals.js';
import { buildDef } from './build.js';

/** What one farmhand costs to hire. */
export const HAND_PRICE = 1200;

/** How much they can carry before they have to hand it over. */
export const HAND_CAPACITY = 24;

/** Ticks spent on one job — the same effort the farmer spends collecting. */
export const HAND_WORK = 6;

/** How far they will look for something to do. */
const SEARCH_RADIUS = 14;

/**
 * How often an idle hand looks for work.
 *
 * Not every tick: a hand with nothing to do would otherwise scan hundreds of
 * tiles every tick of a seven-day catch-up. Once they have a job they walk to
 * it without scanning again, so this only costs anything while they're idle.
 */
const SCAN_INTERVAL = 20;

export function makeHand(state, x, y) {
  const hand = {
    id: state.nextHandId++,
    x, y, px: x, py: y,
    facing: 'right',
    path: [],
    carrying: {},
    work: 0,
    target: null,       // {kind: 'animal'|'egg', id?, x, y}
    scannedAt: null,
  };
  state.hands = state.hands || [];
  state.hands.push(hand);
  return hand;
}

export function handCount(state) { return (state.hands || []).length; }

/** One hand per barn. Somewhere to put them, and a reason to build another. */
export function handCapacity(state) {
  return (state.buildings || []).filter((b) => b.type === 'barn').length;
}

export function carriedTotal(hand) {
  return Object.values(hand.carrying || {}).reduce((n, q) => n + q, 0);
}

export function handRoom(hand) {
  return Math.max(0, HAND_CAPACITY - carriedTotal(hand));
}

export function isFull(hand) { return handRoom(hand) === 0; }

export function handAt(state, x, y) {
  return (state.hands || []).find((h) => h.x === x && h.y === y) || null;
}

/** Is this animal the one a hand is on its way to? Used to keep it still. */
export function handTargeting(state, animalId) {
  return (state.hands || []).some((h) => h.target?.kind === 'animal' && h.target.id === animalId);
}

/**
 * Hands everything a farmhand is carrying to the player.
 *
 * @returns {object} what changed hands, in the shape the task pipeline reports
 */
export function takeFromHand(hand) {
  const carried = { ...hand.carrying };
  hand.carrying = {};
  return carried;
}

export function updateHands(state) {
  for (const hand of state.hands || []) {
    hand.px = hand.x;
    hand.py = hand.y;
    stepHand(state, hand);
  }
}

function stepHand(state, hand) {
  // Mid-job: keep at it.
  if (hand.work > 0) {
    hand.work--;
    if (hand.work === 0) finishJob(state, hand);
    return;
  }

  // Full: take it to a barn and wait there for someone to collect it.
  if (isFull(hand)) {
    if (!walkTo(state, hand, restingPlace(state, hand))) hand.path = [];
    else step(state, hand);
    return;
  }

  if (hand.target && !stillWorthDoing(state, hand.target, hand)) hand.target = null;

  if (!hand.target) {
    if (hand.scannedAt != null && state.tickCount - hand.scannedAt < SCAN_INTERVAL) return;
    hand.target = findWork(state, hand);
    hand.scannedAt = state.tickCount;
    if (!hand.target) return;
    hand.path = [];
  }

  // In position? Start the job. Otherwise walk.
  if (inReach(hand, hand.target)) {
    hand.work = HAND_WORK;
    return;
  }
  if (hand.path.length === 0 && !walkTo(state, hand, hand.target)) {
    hand.target = null;                 // can't get there; look for something else
    return;
  }
  step(state, hand);
}

/** An egg is picked up from its own tile; an animal is worked on from beside. */
function inReach(hand, target) {
  if (target.kind === 'egg') return hand.x === target.x && hand.y === target.y;
  return Math.abs(hand.x - target.x) + Math.abs(hand.y - target.y) <= 1;
}

function stillWorthDoing(state, target, hand) {
  if (handRoom(hand) <= 0) return false;
  if (target.kind === 'egg') return state.grid.getObject(target.x, target.y) === OBJ.EGG;

  const animal = state.animals.find((a) => a.id === target.id);
  if (!animal || !isReady(animal)) return false;
  // Animals wander, so the target follows them the way the farmer's own
  // collect task does.
  target.x = animal.x;
  target.y = animal.y;
  return true;
}

function finishJob(state, hand) {
  const target = hand.target;
  hand.target = null;
  if (!target) return;

  if (target.kind === 'egg') {
    if (state.grid.getObject(target.x, target.y) !== OBJ.EGG) return;
    state.grid.setObject(target.x, target.y, OBJ.NONE);
    give(hand, objDef(OBJ.EGG).yields);
    emitUnlessSuspended('world:changed', { x: target.x, y: target.y });
    emitUnlessSuspended('hand:gathered', { id: hand.id, gained: { egg: 1 } });
    return;
  }

  const animal = state.animals.find((a) => a.id === target.id);
  if (!animal || !isReady(animal)) return;

  // Only as much as they can carry — the rest stays on the animal rather than
  // evaporating, so nothing is ever lost to a full pair of pockets.
  const taken = takeFromAnimal(state, animal, handRoom(hand));
  if (!taken) return;
  give(hand, { [taken.id]: taken.qty });
  emitUnlessSuspended('hand:gathered', { id: hand.id, gained: { [taken.id]: taken.qty } });
}

function give(hand, items) {
  for (const [id, n] of Object.entries(items || {})) {
    hand.carrying[id] = (hand.carrying[id] || 0) + n;
  }
}

/**
 * The nearest job worth doing.
 *
 * Animals first, then eggs: an animal that's full has stopped producing, so
 * emptying it is worth more than tidying up something already on the ground.
 */
function findWork(state, hand) {
  let best = null;
  for (const animal of state.animals || []) {
    if (!isReady(animal)) continue;
    const d = Math.abs(animal.x - hand.x) + Math.abs(animal.y - hand.y);
    if (d > SEARCH_RADIUS) continue;
    if (!best || d < best.d) best = { d, target: { kind: 'animal', id: animal.id, x: animal.x, y: animal.y } };
  }
  if (best) return best.target;

  // Eggs, searched outward so the first one found is the closest.
  for (let r = 1; r <= SEARCH_RADIUS; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = hand.x + dx;
        const y = hand.y + dy;
        if (state.grid.getObject(x, y) !== OBJ.EGG) continue;
        if (!state.grid.isWalkable(x, y, 'farmer')) continue;
        return { kind: 'egg', x, y };
      }
    }
  }
  return null;
}

/** Where a full hand waits: beside the nearest barn, or where they stand. */
function restingPlace(state, hand) {
  const barns = (state.buildings || []).filter((b) => b.type === 'barn');
  if (barns.length === 0) return { kind: 'rest', x: hand.x, y: hand.y };

  let best = barns[0];
  let bestD = Infinity;
  for (const b of barns) {
    const d = Math.abs(b.x - hand.x) + Math.abs(b.y - hand.y);
    if (d < bestD) { bestD = d; best = b; }
  }
  const size = buildDef('barn').size;
  return {
    kind: 'rest', x: best.x, y: best.y, w: size[0], h: size[1],
    arrived: besideBox(best.x, best.y, size[0], size[1], hand.x, hand.y),
  };
}

function walkTo(state, hand, target) {
  if (!target) return false;
  if (target.kind === 'rest' && target.arrived) return true;

  const path = findPath(state.grid, { x: hand.x, y: hand.y }, { x: target.x, y: target.y }, {
    actor: 'farmer',
    adjacent: target.kind !== 'egg',
    w: target.w || 1,
    h: target.h || 1,
  });
  if (!path) return false;
  hand.path = path;
  return true;
}

/** One tile a tick — deliberately slower than the farmer, who has a job to do. */
function step(state, hand) {
  const next = hand.path.shift();
  if (!next) return;
  if (!state.grid.isWalkable(next.x, next.y, 'farmer')) { hand.path = []; return; }
  if (next.x !== hand.x) hand.facing = next.x > hand.x ? 'right' : 'left';
  hand.x = next.x;
  hand.y = next.y;
}
