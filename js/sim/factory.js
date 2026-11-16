// The factory district: machines in the city that turn what the farm grows
// into something worth more.
//
// One production line per colour of machine on the factory sheet. A line takes
// its raw good out of the bag at a steady rate and puts the processed good back
// in; the processed goods sell at a flat price, outside the market (see
// TRADED in sim/market.js), the way mushrooms and gourds do.
//
// WHY THE THROUGHPUT IS CAPPED
//
// A flat price is a way round the market. The market exists to make a farm
// that grows one thing earn less than one that grows several; a mill that
// would take every bushel of wheat a farm could grow, at a fixed price, would
// make growing nothing but wheat the best plan in the game. So each machine
// works at a fixed pace, and only LINE_MACHINE_CAP machines of a colour count:
// a line is an outlet for part of a harvest, not for the whole of a monoculture.
//
// Same rules as everything the tick calls: no clock, no randomness at all here,
// and the work is done once a minute alongside the rest of the city.

import { addItem, removeItem, countItem } from './inventory.js';
import { emitUnlessSuspended } from '../engine/events.js';

/**
 * The four lines. `ticksPerUnit` is how long one machine takes over one unit.
 *
 * Paced by value, not by count: each machine takes about $4,300 of raw goods a
 * day when it is kept fed — 360 bushels of wheat, 240 tomatoes, 72 pails of
 * milk or 48 fleeces — so three on a line take roughly $13,000 a day, about a
 * quarter of what a mature farm sells. Every processed good is worth half as
 * much again as what went in (see ITEMS in sim/inventory.js), so a fed machine
 * adds a little over $2,000 a day and pays back its price in about twelve.
 */
export const LINES = {
  mill: {
    name: 'Mill', colour: 'yellow', input: 'wheat', output: 'flour', ticksPerUnit: 240,
  },
  cannery: {
    name: 'Cannery', colour: 'red', input: 'tomato', output: 'preserves', ticksPerUnit: 360,
  },
  creamery: {
    name: 'Creamery', colour: 'blue', input: 'milk', output: 'cheese', ticksPerUnit: 1200,
  },
  loom: {
    name: 'Loom', colour: 'green', input: 'wool', output: 'cloth', ticksPerUnit: 1800,
  },
};

/** Machines of one colour beyond this many add nothing. See the note above. */
export const LINE_MACHINE_CAP = 3;

/** What a factory machine costs. One machine is one line's worth of work. */
export const MACHINE_PRICE = 25000;

/**
 * How a line stands: switched on or off, and part-done work carried over.
 * `progress` is counted in machine-ticks, a whole number, so a slow line's
 * thirtieths add up to exactly one unit rather than to 0.9999999 of one.
 */
export function lineState(city, line) {
  city.lines = city.lines || {};
  if (!city.lines[line]) city.lines[line] = { on: true, progress: 0 };
  return city.lines[line];
}

/** Is this line switched on? Lines start on. */
export function lineOn(city, line) { return city.lines?.[line]?.on !== false; }

/** Switches a line on or off. Work in hand is kept for when it comes back. */
export function setLine(city, line, on) {
  if (!LINES[line]) return false;
  lineState(city, line).on = !!on;
  emitUnlessSuspended('city:changed', { line });
  return true;
}

/** How many machines a line has that count, given the city's pieces. */
export function machinesFor(city, line, isWorking) {
  let n = 0;
  for (const p of city.pieces) if (p.kind === line && isWorking(p)) n++;
  return Math.min(n, LINE_MACHINE_CAP);
}

/** Units a line handles in a minute with this many machines. */
export function lineRate(line, machines) {
  const def = LINES[line];
  return def ? (machines * 60) / def.ticksPerUnit : 0;
}

/**
 * One minute of every line. Whole units only: a slow line accumulates its
 * fraction and delivers when it adds up to a unit. A line with nothing to work
 * on loses that minute rather than banking it — a mill that stood idle all
 * night does not grind a night's wheat in a second when some arrives.
 *
 * @param {(line: string) => number} machinesOf how many working machines each
 *   line has; the caller knows which are on factory floor.
 * @param {number} minutes how many minutes this call stands for
 * @returns {Record<string, number>} units made, by output good
 */
export function runLines(state, machinesOf, minutes = 1) {
  const made = {};
  for (const [line, def] of Object.entries(LINES)) {
    const machines = machinesOf(line);
    if (machines <= 0 || !lineOn(state.city, line)) continue;
    const st = lineState(state.city, line);
    st.progress += machines * 60 * minutes;
    const whole = Math.floor(st.progress / def.ticksPerUnit);
    if (whole <= 0) continue;
    st.progress -= whole * def.ticksPerUnit;
    const take = Math.min(whole, countItem(state, def.input));
    if (take <= 0) continue;
    removeItem(state, def.input, take);
    addItem(state, def.output, take);
    made[def.output] = (made[def.output] || 0) + take;
  }
  return made;
}
