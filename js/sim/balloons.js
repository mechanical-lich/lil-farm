// Balloons, which only exist during the week of her birthday.
//
// Everything else in the game is there every day. This is not: for nine days a
// year — the week of the 9th of September, with the weekend on either end —
// balloons drift up on the farm, and popping one is a present. Once a day the
// present is a mythical horse, which is the only way to get one.
//
// The window is worked out from the date rather than typed in, so it comes back
// every September without anybody editing a constant. See partyWindow.
//
// Two halves, kept apart on purpose:
//
//   * The window and the daily prize are decided at boot, from the real date,
//     because sim/ may not read a clock — the same arrangement as the day
//     streak in achievements.js. main.js calls noteParty with today's date.
//   * The spawning runs in the tick, off a flag the boot set. That keeps the
//     simulation deterministic and replayable: catch-up spawns balloons for
//     the days she was away exactly as if she had been watching.
//
// Hard rules, same as everything in sim/: no DOM, no Math.random(), no
// Date.now(). The one date function here takes the date as an argument.

import { emitUnlessSuspended } from '../engine/events.js';
import { isWater } from '../world/tiledefs.js';
import { findPath } from '../world/pathfind.js';
import { PLOT, plotCoords } from '../world/land.js';
import { OBJ } from '../world/tiledefs.js';
import { SPECIES } from './mushrooms.js';
import { FLOWER_KINDS, seedIdFor, rollWildGenome } from './flowergenes.js';

/** Whose birthday, and therefore which week. */
export const BIRTHDAY = { month: 9, day: 9 };

/** How many colours are on assets/animals/balloons.png. */
export const BALLOON_COLOURS = 12;

/** Ticks between spawn attempts. Rarer than fish: a balloon is an occasion. */
export const BALLOON_INTERVAL = 300;

/** How many may be waiting at once, however long she has been away. */
export const BALLOON_CAP = 4;

/** Tries per attempt before giving up on finding a spot. */
const TRIES = 8;

// --- the window ----------------------------------------------------------

/** Days in an ISO date, as a UTC timestamp. Pure label arithmetic. */
function stamp(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }

const DAY = 24 * 60 * 60 * 1000;

/**
 * The birthday week for a given year: the Saturday before it through the
 * Sunday at the end of it. Nine days, both weekends.
 *
 * Computed rather than written down, because the weekday moves every year and
 * a hardcoded range would be wrong by the second one — silently, and in the
 * direction where nothing happens at all.
 *
 * @returns {{from: string, to: string}} inclusive ISO dates
 */
export function partyWindow(year) {
  const birthday = Date.UTC(year, BIRTHDAY.month - 1, BIRTHDAY.day);
  // getUTCDay: 0 is Sunday. Shift so Monday is 0, which is the day the week
  // the birthday falls in begins.
  const sinceMonday = (new Date(birthday).getUTCDay() + 6) % 7;
  const monday = birthday - sinceMonday * DAY;
  return { from: iso(monday - 2 * DAY), to: iso(monday + 6 * DAY) };
}

/** Is this date inside the birthday week? */
export function isPartyDay(today) {
  const [year] = String(today).split('-').map(Number);
  if (!year) return false;
  const { from, to } = partyWindow(year);
  return stamp(today) >= stamp(from) && stamp(today) <= stamp(to);
}

/**
 * Told what day it is, once per boot.
 *
 * Turns the spawner on or off, and arms the day's guaranteed prize. Arming is
 * per calendar day and does not stack: a day she never opens the game is a day
 * with no prize, which is the point — the present is for turning up.
 *
 * @param {string} today an ISO date, 'YYYY-MM-DD'
 * @returns {{on: boolean, fresh: boolean, birthday: boolean}} whether the
 *   balloons are flying, whether this is the first look of the day, and
 *   whether today is the day itself
 */
export function noteParty(state, today) {
  const party = record(state);
  party.on = isPartyDay(today);

  const fresh = party.on && party.day !== today;
  if (fresh) {
    party.day = today;
    party.prizePending = true;
  }
  return { on: party.on, fresh, birthday: isBirthday(today) };
}

/** The day itself, rather than the week around it. */
export function isBirthday(today) {
  const [, m, d] = String(today).split('-').map(Number);
  return m === BIRTHDAY.month && d === BIRTHDAY.day;
}

function record(state) {
  if (!state.party) state.party = { on: false, day: null, prizePending: false, given: [] };
  state.party.given = state.party.given || [];
  return state.party;
}

// --- the balloons themselves ---------------------------------------------

export function balloonKey(x, y) { return `${x},${y}`; }

export function balloonAt(state, x, y) {
  return (state.balloons || {})[balloonKey(x, y)] || null;
}

export function balloonList(state) {
  return Object.entries(state.balloons || {}).map(([key, b]) => {
    const comma = key.indexOf(',');
    return { x: +key.slice(0, comma), y: +key.slice(comma + 1), ...b };
  });
}

/**
 * Somewhere a balloon can sit: owned, empty, dry, and — the part that matters —
 * somewhere the farmer can actually get to.
 *
 * Reachable rather than merely walkable. A tile of dry land marooned in the
 * middle of a pond passes every "can this be stood on" test and can never be
 * walked to, and a present she can see and never open is worse than no present
 * at all. The fish had this exact bug, on a real farm, for a fortnight.
 *
 * The route search is last on purpose: it is far and away the dearest check
 * here, and every cheap disqualifier above it means one fewer search. What is
 * left runs a handful of times every few minutes, which is nothing.
 */
export function canBalloonSpawn(state, x, y) {
  const grid = state.grid;
  if (!grid.inBounds(x, y) || !grid.isOwned(x, y)) return false;
  if (isWater(grid.getGround(x, y))) return false;
  if (grid.getObject(x, y) !== OBJ.NONE) return false;
  if (!grid.isWalkable(x, y, 'farmer')) return false;
  if (balloonAt(state, x, y)) return false;

  // A zero-length path counts: he may already be standing there.
  return !!findPath(state.grid, { x: state.farmer.x, y: state.farmer.y }, { x, y },
    { actor: 'farmer' });
}

export function spawnBalloon(state, x, y, colour) {
  state.balloons = state.balloons || {};
  state.balloons[balloonKey(x, y)] = { colour };
  emitUnlessSuspended('balloon:appeared', { x, y });
  return true;
}

export function updateBalloons(state) {
  if (!state.party?.on) return;
  if (state.tickCount % BALLOON_INTERVAL !== 0) return;

  const plots = Array.from(state.grid.owned);
  if (plots.length === 0) return;
  if (Object.keys(state.balloons || {}).length >= BALLOON_CAP) return;

  for (let i = 0; i < TRIES; i++) {
    const { px, py } = plotCoords(plots[state.rng.int(plots.length)], state.grid.w);
    const x = px * PLOT + state.rng.int(PLOT);
    const y = py * PLOT + state.rng.int(PLOT);
    if (!canBalloonSpawn(state, x, y)) continue;
    spawnBalloon(state, x, y, state.rng.int(BALLOON_COLOURS));
    return;
  }
}

/** Drops balloons that ended up somewhere they no longer belong. */
export function reconcileBalloons(state) {
  state.balloons = state.balloons || {};
  let dropped = 0;
  for (const key of Object.keys(state.balloons)) {
    const comma = key.indexOf(',');
    const x = +key.slice(0, comma);
    const y = +key.slice(comma + 1);
    if (state.grid.inBounds(x, y) && state.grid.isOwned(x, y)) continue;
    delete state.balloons[key];
    dropped++;
  }
  return { dropped };
}

// --- what is inside ------------------------------------------------------

/**
 * The four that only come out of a balloon.
 *
 * They are ordinary animals in every way the simulation cares about — see the
 * entries in sim/animals.js, which is where they live. This is only the list
 * of which ones the party hands out, in the order they are given: a kind she
 * has not got yet comes first, and once she has all four they start repeating.
 */
export const MYTHICALS = ['unicorn', 'pegasus', 'nightmare', 'hippocampus'];

/**
 * How big an ordinary present is.
 *
 * Generous rather than balanced. A balloon is not a crop, it happens nine days
 * a year, and a present that reads as "oh, four eggs" is worse than no present.
 */
const GIFTS = [
  { kind: 'eggs', weight: 3, lo: 6, hi: 20 },
  { kind: 'mushrooms', weight: 3, lo: 3, hi: 8 },
  { kind: 'seeds', weight: 3, lo: 2, hi: 5 },
];

/**
 * Pops one, and works out what was in it.
 *
 * The present is decided here rather than when the balloon appeared, so the
 * day's guaranteed mythical goes to whichever balloon she pops first rather
 * than to whichever one happened to spawn first — and a balloon left floating
 * overnight is not quietly holding yesterday's prize.
 *
 * @returns {{gained: Record<string, number>|null, mythical: string|null}|null}
 *   null if there was no balloon there at all
 */
export function popBalloon(state, x, y) {
  const balloon = balloonAt(state, x, y);
  if (!balloon) return null;
  delete state.balloons[balloonKey(x, y)];

  const party = record(state);
  if (party.on && party.prizePending) {
    party.prizePending = false;
    const type = nextMythical(state);
    party.given.push(type);
    emitUnlessSuspended('balloon:popped', { x, y, mythical: type });
    return { gained: null, mythical: type };
  }

  const gained = rollGift(state);
  emitUnlessSuspended('balloon:popped', { x, y, mythical: null, gained });
  return { gained, mythical: null };
}

/** One she hasn't had, or — once she has them all — any of them. */
export function nextMythical(state) {
  const had = new Set(record(state).given);
  const fresh = MYTHICALS.filter((type) => !had.has(type));
  const pool = fresh.length ? fresh : MYTHICALS;
  return pool[state.rng.int(pool.length)];
}

/** An ordinary present: eggs, mushrooms or a handful of flower seeds. */
export function rollGift(state) {
  const total = GIFTS.reduce((n, g) => n + g.weight, 0);
  let roll = state.rng.int(total);
  let pick = GIFTS[0];
  for (const gift of GIFTS) {
    roll -= gift.weight;
    if (roll < 0) { pick = gift; break; }
  }

  const qty = pick.lo + state.rng.int(pick.hi - pick.lo + 1);

  if (pick.kind === 'eggs') return { egg: qty };
  if (pick.kind === 'mushrooms') {
    const items = Object.values(SPECIES).map((s) => s.item);
    return { [items[state.rng.int(items.length)]]: qty };
  }

  // Seeds come as one colour rather than a scattering of singles: a packet of
  // five of the same is something she can actually plant a bed with, and the
  // colour is a wild one so it goes straight into the journal's wheel.
  const kind = FLOWER_KINDS[state.rng.int(FLOWER_KINDS.length)];
  return { [seedIdFor(kind, rollWildGenome(state.rng))]: qty };
}
