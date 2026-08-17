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

/**
 * How far they will look for a dropped egg.
 *
 * Generous, because it turned out not to be: at 14 tiles a hand waiting by its
 * barn couldn't see a third of a real farm, so eggs piled up at the far end
 * while the crew stood around. Animals aren't limited at all — they're a short
 * list, so checking every one of them costs nothing.
 */
const EGG_RADIUS = 30;

/**
 * How often an idle hand looks for work.
 *
 * Not every tick: a hand with nothing to do would otherwise scan hundreds of
 * tiles every tick of a seven-day catch-up. Once they have a job they walk to
 * it without scanning again, so this only costs anything while they're idle.
 */
const SCAN_INTERVAL = 20;

/** Ticks a hand may hold a job without getting any closer before giving up. */
const STUCK_LIMIT = 30;

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
    hand.stuckFor = 0;
    return;
  }

  // Belt and braces: whatever the reason, a hand that has held a job without
  // moving for this long has misunderstood something. Drop it and look again,
  // rather than standing there for the rest of the week.
  hand.stuckFor = (hand.x === hand.wasAt?.x && hand.y === hand.wasAt?.y)
    ? (hand.stuckFor || 0) + 1
    : 0;
  hand.wasAt = { x: hand.x, y: hand.y };
  if (hand.target && hand.stuckFor > STUCK_LIMIT) {
    hand.target = null;
    hand.path = [];
    hand.scannedAt = null;
    hand.stuckFor = 0;
  }

  if (hand.target && !stillWorthDoing(state, hand.target, hand)) hand.target = null;

  if (!hand.target) {
    const rested = hand.scannedAt != null && state.tickCount - hand.scannedAt < SCAN_INTERVAL;
    if (!rested) {
      hand.target = findWork(state, hand);
      hand.scannedAt = state.tickCount;
      if (hand.target) { hand.path = []; hand.restSpot = null; }
    }
  }

  if (hand.target) {
    if (inReach(hand, hand.target)) { hand.work = HAND_WORK; return; }
    if (hand.path.length === 0 && !walkTo(state, hand, hand.target)) {
      hand.target = null;                 // can't get there; look for something else
      return;
    }
    step(state, hand);
    return;
  }

  // Nothing to do, or nowhere to put it: wait by a barn.
  rest(state, hand);
}

/** An egg is picked up from its own tile; an animal is worked on from beside. */
function inReach(hand, target) {
  if (target.kind === 'animal') {
    return Math.abs(hand.x - target.x) + Math.abs(hand.y - target.y) <= 1;
  }
  return hand.x === target.x && hand.y === target.y;
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
  // Look again straight away rather than waiting out the scan interval: a hand
  // that has just finished is standing in the middle of the work, and pausing
  // there means starting the walk home only to turn round again.
  hand.scannedAt = null;
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
 * Is another hand already on its way to this?
 *
 * Without this every hand picks the nearest job, which is the *same* job:
 * three of them converge on one cow, one milks it and the other two arrive to
 * find it done. A job belongs to whoever claimed it first.
 */
function claimedByAnother(state, hand, kind, id, x, y) {
  return (state.hands || []).some((other) => {
    if (other === hand || !other.target || other.target.kind !== kind) return false;
    return kind === 'animal'
      ? other.target.id === id
      : other.target.x === x && other.target.y === y;
  });
}

/**
 * Is another hand physically standing here right now?
 *
 * Used to choose somewhere to *stop*, never to decide whether to move. Two
 * hands sharing a tile for a moment in passing is barely visible; refusing to
 * walk through each other is not, because the one in the way is often standing
 * still by a barn and will never move — which livelocked the whole crew.
 */
function standingHere(state, hand, x, y) {
  return (state.hands || []).some((other) => other !== hand && other.x === x && other.y === y);
}

/** Has another hand called this tile as its waiting spot? */
function spotClaimed(state, hand, x, y) {
  return (state.hands || []).some((other) => other !== hand
    && other.restSpot && other.restSpot.x === x && other.restSpot.y === y);
}

/**
 * The nearest job worth doing that nobody else has claimed.
 *
 * Animals first, then eggs: an animal that's full has stopped producing, so
 * emptying it is worth more than tidying up something already on the ground.
 */
function findWork(state, hand) {
  if (handRoom(hand) <= 0) return null;          // full: nothing is worth doing

  let best = null;
  for (const animal of state.animals || []) {
    if (!isReady(animal)) continue;
    if (claimedByAnother(state, hand, 'animal', animal.id)) continue;
    const d = Math.abs(animal.x - hand.x) + Math.abs(animal.y - hand.y);
    if (!best || d < best.d) {
      best = { d, target: { kind: 'animal', id: animal.id, x: animal.x, y: animal.y } };
    }
  }
  if (best) return best.target;

  // Eggs, searched outward so the first one found is the closest.
  for (let r = 1; r <= EGG_RADIUS; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = hand.x + dx;
        const y = hand.y + dy;
        if (state.grid.getObject(x, y) !== OBJ.EGG) continue;
        if (!state.grid.isWalkable(x, y, 'farmer')) continue;
        if (claimedByAnother(state, hand, 'egg', null, x, y)) continue;
        return { kind: 'egg', x, y };
      }
    }
  }
  return null;
}

/**
 * Waiting by the barn between jobs.
 *
 * They used to simply stop wherever the last job left them, which looked less
 * like hired help taking a break than like someone loitering in a hedge. Each
 * one claims its own spot around the barn, so a crew of them lines up instead
 * of piling onto a single tile.
 */
function rest(state, hand) {
  // Sharing a tile with someone is reason enough to move, arrived or not.
  if (standingHere(state, hand, hand.x, hand.y)) hand.restSpot = null;
  if (hand.restSpot && spotClaimed(state, hand, hand.restSpot.x, hand.restSpot.y)) {
    hand.restSpot = null;
  }
  if (!hand.restSpot) {
    hand.restSpot = pickRestSpot(state, hand);
    hand.path = [];
  }

  const spot = hand.restSpot;
  if (!spot) return;                             // no barn, or nowhere free
  if (hand.x === spot.x && hand.y === spot.y) { hand.path = []; return; }

  if (hand.path.length === 0
      && !walkTo(state, hand, { kind: 'spot', x: spot.x, y: spot.y })) {
    hand.restSpot = null;
    return;
  }
  step(state, hand);
}

/**
 * A free tile against the nearest barn.
 *
 * Order matters, and not for tidiness: a barn's roof is drawn three rows above
 * its footprint, so the row directly *above* it — the obvious first choice
 * when scanning top to bottom — puts the hand behind the roof where nobody can
 * see them. They looked like they were hiding. In front of the barn first,
 * then the sides, and only under the eaves if there is nowhere else.
 */
function pickRestSpot(state, hand) {
  const barns = (state.buildings || []).filter((b) => b.type === 'barn');
  if (barns.length === 0) return null;

  let barn = barns[0];
  let bestD = Infinity;
  for (const b of barns) {
    const d = Math.abs(b.x - hand.x) + Math.abs(b.y - hand.y);
    if (d < bestD) { bestD = d; barn = b; }
  }

  const [w, h] = buildDef('barn').size;
  const inFront = [];
  const sides = [];
  const behind = [];
  for (let y = barn.y - 1; y <= barn.y + h; y++) {
    for (let x = barn.x - 1; x <= barn.x + w; x++) {
      if (!besideBox(barn.x, barn.y, w, h, x, y)) continue;
      if (y >= barn.y + h) inFront.push({ x, y });
      else if (y < barn.y) behind.push({ x, y });
      else sides.push({ x, y });
    }
  }

  for (const spot of [...inFront, ...sides, ...behind]) {
    if (!state.grid.isWalkable(spot.x, spot.y, 'farmer')) continue;
    if (spotClaimed(state, hand, spot.x, spot.y)) continue;
    if (standingHere(state, hand, spot.x, spot.y)) continue;
    return spot;
  }
  return null;
}

function walkTo(state, hand, target) {
  if (!target) return false;
  const path = findPath(state.grid, { x: hand.x, y: hand.y }, { x: target.x, y: target.y }, {
    actor: 'farmer',
    adjacent: target.kind === 'animal',
  });
  if (!path) return false;
  hand.path = path;
  return true;
}

/**
 * One tile a tick — deliberately slower than the farmer, who has a job to do.
 *
 * Two hands never share a tile: rather than walking through each other they
 * wait and re-plan, which is what stops a crew stacking into one sprite.
 */
function step(state, hand) {
  const next = hand.path[0];
  if (!next) return;
  if (!state.grid.isWalkable(next.x, next.y, 'farmer')) {
    hand.path = [];        // the world changed under the route; re-plan
    return;
  }
  hand.path.shift();
  if (next.x !== hand.x) hand.facing = next.x > hand.x ? 'right' : 'left';
  hand.x = next.x;
  hand.y = next.y;
}
