// Wild animals: what wanders onto the farm, and how one is won over.
//
// Every so often something wild turns up — a squirrel, a deer, very rarely a
// tiger — and roams the farm for a day before moving on. Fuss over it and it
// bolts for the far side of the farm; find it again and fuss over it again,
// and after enough of that it decides you are all right and stays for good, as
// an animal like any other.
//
// A wild one is an ordinary entry in state.animals with `wild` set — not a
// parallel list — because once it is befriended it has to *be* an ordinary
// animal: eat, drink, graze, be drawn and moved and fed exactly like a horse.
// Keeping it in the same list from the start means winning one over is
// clearing a flag rather than moving a record between two worlds. sim/animals.js
// gives the untamed ones their own rules (no upkeep, restless movement); this
// file is everything else.
//
// Three things are measured from the moment it arrives, and only three:
//
//   * how many times it has been fussed over (`trust`) against its kind's
//     `tame`, from sim/wildkinds.js;
//   * when it leaves (`leavesAt`), a day after it came;
//   * whether it is mid-flight (`fleeing`) — a tap on an animal that is
//     running away is not a fuss, so every tap that counts had to catch it
//     standing still somewhere new.
//
// Hard rules, same as everything in sim/: no DOM, no Math.random(), no
// Date.now(). Catch-up replays this thousands of times over.

import { emitUnlessSuspended } from '../engine/events.js';
import { findPath } from '../world/pathfind.js';
import { PLOT, plotCoords } from '../world/land.js';
import { WILD_KINDS, WILD_IDS } from './wildkinds.js';
import { noteBefriended, noteMet } from './achievements.js';
import {
  makeAnimal, showEmote, actorFor, FOOD_DURATION, WATER_DURATION,
} from './animals.js';

/** Ticks between arrivals: at most one an hour. */
export const WILD_INTERVAL = 60 * 60;

/**
 * Arrivals allowed in any twenty-four hours of farm time.
 *
 * A rolling window rather than a calendar day, because the simulation can't
 * read a clock — catch-up replays it — and a window can't be gamed by
 * midnight either: there's no fresh five waiting at 12:01. Measured at a
 * visitor every twenty minutes with no daily limit, a player who shooed each
 * one on sight met all of them in a week, which made the rare ones a matter of
 * persistence rather than luck.
 */
export const WILD_PER_DAY = 5;

/**
 * Untamed animals on the farm at once.
 *
 * Small on purpose. Coming back from a week away to a farm overrun with
 * twenty wild things is a chore list, the same reason fish have a hard cap —
 * and three at a time is still enough that there is usually somebody about.
 */
export const WILD_CAP = 3;

/** How long a wild one stays before moving on: a day. */
export const WILD_STAY = 24 * 60 * 60;

/** A shooed wild one that can't get clear in this long simply goes. */
export const LEAVE_TIMEOUT = 60;

/** How far a shooed animal runs — the ones that live here only bolt a little. */
const SHOO_RUN = 8;

/** How far a shooed wild one runs looking for the edge before giving up. */
const LEAVE_RUN = 40;

/** Candidates considered for "the other side of the farm", and routes tried. */
const FLEE_SAMPLES = 16;
const FLEE_TRIES = 4;

const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export function wildKind(type) { return WILD_KINDS[type] || null; }

/** The untamed ones, which are the ones that count against the cap. */
export function wildOnes(state) {
  return (state.animals || []).filter((a) => a.wild);
}

// --- arriving and leaving --------------------------------------------------

export function updateWildlife(state) {
  // Moving on: a day is up, or a shooed one has reached the edge.
  for (const a of wildOnes(state)) {
    const gone = state.tickCount >= a.leavesAt
      || (a.leaving && ((a.path || []).length === 0 || state.tickCount >= a.leaveBy));
    if (gone) removeAnimal(state, a, a.leaving ? 'shooed' : 'moved on');
  }

  intimidate(state);

  if (state.tickCount % WILD_INTERVAL !== 0) return;
  if (wildOnes(state).length >= WILD_CAP) return;
  if (arrivalsToday(state) >= WILD_PER_DAY) return;
  if (arrive(state)) {
    state.wildArrivals = recentArrivals(state);
    state.wildArrivals.push(state.tickCount);
  }
}

/** Arrival ticks within the last twenty-four hours, oldest first. */
function recentArrivals(state) {
  const since = state.tickCount - 24 * 60 * 60;
  return (state.wildArrivals || []).filter((t) => t > since);
}

/** How many have arrived in the last twenty-four hours of farm time. */
export function arrivalsToday(state) {
  return recentArrivals(state).length;
}

// --- scaring your animals -------------------------------------------------

/** The closest a wild animal can scare from, and how much further full intimidation adds. */
const SCARE_BASE = 3;
const SCARE_REACH = 5;

/** How much further than that a scared animal runs, at full intimidation. */
const FLEE_EXTRA = 5;

/**
 * How close a wild animal has to come to one of yours before it can scare it.
 *
 * Scaled by how intimidating it is: four tiles for a crow, six for a fox,
 * eight for a lion. Measured against a fixed four for everything, over six
 * hours beside a herd of twelve: a lion went from 26 scares to 69 and a fox
 * barely moved, the cows still spent well under one per cent of their time
 * running, and an animal scared twice inside a minute — a predator flickering
 * in and out at the edge — stayed at one or two a day either way. So the reach
 * lands where it should, on the animals that are meant to be frightening.
 */
export function triggerRadius(intimidating) {
  return SCARE_BASE + Math.round(intimidating * SCARE_REACH);
}

/**
 * How far from the wild animal a scared one runs to, in tiles.
 *
 * Worked out *from* the trigger distance, so it is always beyond it whatever
 * either is tuned to. That is what makes "it tries again if it comes back"
 * work out naturally: a scared animal always ends up out of reach, so the wild
 * one has to approach it afresh to get another try.
 */
export function fleeRange(intimidating) {
  return triggerRadius(intimidating) + 1 + Math.round(intimidating * FLEE_EXTRA);
}

const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/**
 * Wild animals frightening yours.
 *
 * One roll per approach, not per tick: each wild animal remembers which of
 * your animals are already within its triggerRadius, and only one that has
 * just come into range gets a roll. Standing next to a cow for an hour is one
 * chance to scare it, not three thousand six hundred — and walking away and
 * back again is a fresh one.
 *
 * Only the untamed scare anything, and only while they aren't running — see
 * below. A lion that trusts you is one of yours.
 */
export function intimidate(state) {
  const yours = (state.animals || []).filter((a) => !a.wild);
  for (const w of wildOnes(state)) {
    const k = WILD_KINDS[w.type]?.intimidating || 0;
    const reach = triggerRadius(k);
    const before = new Set(w.inRange || []);
    const now = [];
    for (const f of yours) {
      if (chebyshev(f, w) > reach) continue;
      now.push(f.id);
      if (before.has(f.id)) continue;           // already had its roll this time
      // Running away — from a fuss or a shoo — it frightens nobody. Who it
      // passes is still remembered, so stopping beside a cow it ran past isn't
      // a fresh approach either: it has to wander off and come back for one.
      // That is the reward for chasing a predator off: the herd gets left alone.
      if (w.fleeing) continue;
      if (k > 0 && state.rng.chance(k)) scare(state, f, w, k);
    }
    w.inRange = now;
  }
}

/**
 * One of yours bolts: to the nearest place it can reach that is far enough
 * from what frightened it, by a route it can actually walk.
 */
export function scare(state, f, w, intimidating) {
  f.goal = null;
  showEmote(f, state, 'alarm');
  emitUnlessSuspended('animal:scared', { id: f.id, type: f.type, by: w.type });

  const range = fleeRange(intimidating);
  const actor = actorFor(f);
  // Rings outward from the scared animal: the first ring with any tile far
  // enough from the threat holds the shortest runs. A few routes tried, nearest
  // first, before settling for a straight dash away.
  for (let r = 1; r <= range * 2; r++) {
    const ring = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const spot = { x: f.x + dx, y: f.y + dy };
        if (chebyshev(spot, w) < range) continue;
        if (!state.grid.inBounds(spot.x, spot.y) || !state.grid.isWalkable(spot.x, spot.y, actor)) continue;
        ring.push(spot);
      }
    }
    if (ring.length === 0) continue;
    for (const spot of ring.slice(0, 3)) {
      const path = findPath(state.grid, { x: f.x, y: f.y }, spot, { actor });
      if (path && path.length > 0) { f.path = path; return true; }
    }
  }
  // Penned in, or nowhere far enough: it still bolts, as far as it can.
  const away = [Math.sign(f.x - w.x) || 1, Math.sign(f.y - w.y)];
  return dash(state, f, away, range);
}

/** Somebody new turns up, if there is anywhere for them to stand. */
export function arrive(state, type = rollKind(state)) {
  const plots = Array.from(state.grid.owned);
  if (plots.length === 0) return null;

  for (let i = 0; i < 8; i++) {
    const { px, py } = plotCoords(plots[state.rng.int(plots.length)], state.grid.w);
    const x = px * PLOT + state.rng.int(PLOT);
    const y = py * PLOT + state.rng.int(PLOT);
    if (!canStand(state, x, y, type)) continue;
    return spawnWild(state, type, x, y);
  }
  return null;
}

/** Puts one down. Separate from arrive() so tests can choose where. */
export function spawnWild(state, type, x, y) {
  if (!WILD_KINDS[type]) return null;
  const a = makeAnimal(state, type, x, y, 0);
  a.wild = true;
  a.trust = 0;
  a.leavesAt = state.tickCount + WILD_STAY;
  emitUnlessSuspended('wild:arrived', { id: a.id, type, x, y });
  return a;
}

/** Weighted pick across every kind, wildlife and exotic alike. */
export function rollKind(state) {
  const total = WILD_IDS.reduce((n, id) => n + WILD_KINDS[id].weight, 0);
  let roll = state.rng.int(total);
  for (const id of WILD_IDS) {
    roll -= WILD_KINDS[id].weight;
    if (roll < 0) return id;
  }
  return WILD_IDS[0];
}

function canStand(state, x, y, type) {
  if (!state.grid.inBounds(x, y) || !state.grid.isOwned(x, y)) return false;
  const actor = WILD_KINDS[type]?.swims ? 'swimmer' : 'animal';
  if (!state.grid.isWalkable(x, y, actor)) return false;
  if (state.farmer.x === x && state.farmer.y === y) return false;
  return !(state.animals || []).some((a) => a.x === x && a.y === y);
}

function removeAnimal(state, a, why) {
  const i = state.animals.indexOf(a);
  if (i >= 0) state.animals.splice(i, 1);
  emitUnlessSuspended('wild:left', { id: a.id, type: a.type, x: a.x, y: a.y, why });
}

// --- winning one over -------------------------------------------------------

/**
 * A fuss made of a wild animal.
 *
 * Counts toward trust only if it was standing still: one mid-flight is
 * running *from* you, and tapping it as it goes is not the same thing as
 * approaching it. Each fuss that counts sends it off again to the far side of
 * the farm, so winning one over is a matter of finding it again, and again —
 * more times for the big and the far-flung.
 *
 * @returns {{counted: boolean, befriended?: boolean, trust?: number, tame?: number}|null}
 *   null if this isn't a wild animal at all, and the caller should pet it
 *   the ordinary way
 */
export function befriend(state, a) {
  if (!a || !a.wild) return null;
  const kind = WILD_KINDS[a.type];
  meet(state, a.type);

  // Either way it didn't want fussing — mid-flight or not, a wild thing that
  // has just been touched says so.
  if (a.fleeing) {
    showEmote(a, state, 'annoyed');
    return { counted: false };
  }

  a.trust = (a.trust || 0) + 1;
  if (a.trust >= kind.tame) {
    tame(state, a);
    return { counted: true, befriended: true, trust: a.trust, tame: kind.tame };
  }

  flee(state, a);
  showEmote(a, state, 'annoyed');
  emitUnlessSuspended('wild:startled', { id: a.id, type: a.type, trust: a.trust, tame: kind.tame });
  return { counted: true, befriended: false, trust: a.trust, tame: kind.tame };
}

/** It trusts you now: stays for good, and lives like the horses do. */
function tame(state, a) {
  a.wild = false;
  a.fleeing = false;
  a.leaving = false;
  a.path = [];
  delete a.leavesAt;
  // It arrives in its new life fed and watered, the same courtesy a bought
  // animal gets — the troughs are somebody else's problem for the first hour.
  a.food = FOOD_DURATION;
  a.water = WATER_DURATION;
  showEmote(a, state, 'heart');

  const entry = journalEntry(state, a.type);
  entry.befriended += 1;
  emitUnlessSuspended('wild:befriended', {
    id: a.id, type: a.type, name: WILD_KINDS[a.type].name, first: entry.befriended === 1,
  });
  // After the journal and the friend's own banner, so any award it earns is
  // the next thing on screen rather than the thing that beats it there.
  noteBefriended(state);
}

/**
 * Off to the other side of the farm.
 *
 * Picks the farthest of a handful of open spots it could actually get to, so
 * the run is a real run rather than a hop to the next tile, and the player has
 * to go and look for it. Falls back to a dash in a straight line if nothing
 * far off is reachable — a fox penned in a corner still bolts, just not far.
 */
export function flee(state, a) {
  const actor = actorFor(a);
  const spots = [];
  const plots = Array.from(state.grid.owned);
  for (let i = 0; i < FLEE_SAMPLES; i++) {
    const { px, py } = plotCoords(plots[state.rng.int(plots.length)], state.grid.w);
    const x = px * PLOT + state.rng.int(PLOT);
    const y = py * PLOT + state.rng.int(PLOT);
    if (!state.grid.isWalkable(x, y, actor)) continue;
    spots.push({ x, y, d: Math.abs(x - a.x) + Math.abs(y - a.y) });
  }
  spots.sort((p, q) => q.d - p.d);

  for (const spot of spots.slice(0, FLEE_TRIES)) {
    const path = findPath(state.grid, { x: a.x, y: a.y }, spot, { actor });
    if (path && path.length > 0) {
      a.path = path;
      a.fleeing = true;
      return true;
    }
  }
  return dash(state, a, DIRECTIONS[state.rng.int(DIRECTIONS.length)], SHOO_RUN);
}

/** Straight off in one direction for up to `steps` tiles, until something's in the way. */
function dash(state, a, [dx, dy], steps) {
  const actor = actorFor(a);
  const path = [];
  let { x, y } = a;
  for (let i = 0; i < steps; i++) {
    // Diagonals are taken as two orthogonal steps, because animals only walk
    // orthogonally and a diagonal hop would cut the corner of a fence.
    const legs = dx && dy ? [[dx, 0], [0, dy]] : [[dx, dy]];
    let ok = true;
    for (const [sx, sy] of legs) {
      if (!state.grid.isWalkable(x + sx, y + sy, actor)) { ok = false; break; }
      x += sx; y += sy;
      path.push({ x, y });
    }
    if (!ok) break;
  }
  if (path.length === 0) return false;
  a.path = path;
  if (a.wild) a.fleeing = true;
  return true;
}

// --- shooing ----------------------------------------------------------------

/**
 * Off you go.
 *
 * Every animal runs from it, in a random direction. Only a wild one leaves:
 * it keeps running for the edge of the farm and is gone when it gets there —
 * or shortly after, if a fence or a pond is in the way, since a shooed animal
 * the player can watch failing to leave is worse than one that slips off. A
 * befriended one, or anything that lives here, just bolts a few tiles and
 * settles again; shooing never loses the player an animal they own.
 *
 * @returns {{leaving: boolean, ran: boolean}}
 */
export function shoo(state, a) {
  const dir = DIRECTIONS[state.rng.int(DIRECTIONS.length)];
  if (!a.wild) {
    // Not taken off whatever it was doing for long: an animal that lives here
    // walks a short way and goes back to its own business.
    a.goal = null;
    const ran = dash(state, a, dir, SHOO_RUN);
    if (ran) showEmote(a, state, 'angry');
    return { leaving: false, ran };
  }

  meet(state, a.type);
  const ran = dash(state, a, dir, LEAVE_RUN);
  a.leaving = true;
  a.fleeing = true;
  a.leaveBy = state.tickCount + LEAVE_TIMEOUT;
  showEmote(a, state, 'angry');
  emitUnlessSuspended('wild:shooed', { id: a.id, type: a.type });
  return { leaving: true, ran };
}

// --- the journal ------------------------------------------------------------

/** Remembers that this kind has been met. Meeting is the first tap of any kind. */
export function meet(state, type) {
  const entry = journalEntry(state, type);
  const first = entry.met === 0;
  entry.met += 1;
  if (first) {
    emitUnlessSuspended('wild:met', { type, name: WILD_KINDS[type].name });
    noteMet(state);
  }
  return first;
}

function journalEntry(state, type) {
  state.wildJournal = state.wildJournal || {};
  const entry = state.wildJournal[type] || (state.wildJournal[type] = { met: 0, befriended: 0 });
  entry.met = entry.met || 0;
  entry.befriended = entry.befriended || 0;
  return entry;
}

export function hasMet(state, type) {
  return ((state.wildJournal || {})[type]?.met || 0) > 0;
}

export function kindsMet(state) {
  return WILD_IDS.filter((id) => hasMet(state, id)).length;
}

/** Every kind, in sheet order, with what is known about it. */
export function journalRows(state) {
  return WILD_IDS.map((id) => {
    const k = WILD_KINDS[id];
    const entry = (state.wildJournal || {})[id] || { met: 0, befriended: 0 };
    return {
      id, name: k.name, sheet: k.sheet, row: k.row, tame: k.tame,
      met: entry.met, befriended: entry.befriended,
    };
  });
}

/**
 * Clears what can't be drawn: wild animals of a kind that no longer exists,
 * and journal lines for them.
 *
 * Renaming a kind's *id* would otherwise leave an invisible animal roaming the
 * farm for a day — and, worse, a befriended one for ever. Same lesson the fish
 * taught. Only ever touches kinds that came from the wild; a cow is not this
 * file's business.
 */
export function reconcileWildlife(state) {
  state.wildJournal = state.wildJournal || {};
  let dropped = 0;
  state.animals = (state.animals || []).filter((a) => {
    const unknown = (a.wild || a.trust != null) && !WILD_KINDS[a.type];
    if (unknown) dropped++;
    return !unknown;
  });
  for (const id of Object.keys(state.wildJournal)) {
    if (!WILD_KINDS[id]) delete state.wildJournal[id];
  }
  return { dropped };
}
