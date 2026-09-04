// Achievements: the things the farm remembers you having done.
//
// Two kinds of condition, and the difference matters more than it looks:
//
//   * Tallies — eggs picked up, water dug, flowers planted. These count events
//     that leave no trace on the farm, so they have to be counted as they
//     happen and kept in the save. Nothing can reconstruct "1000 eggs" by
//     looking at a farm afterwards.
//   * Journals — every mushroom, every flower colour, every fish. These read
//     the collection the game already keeps, because that journal *is* the
//     history: it has always recorded everything ever picked, so it can be
//     trusted about a farm that predates achievements entirely.
//
// Both are evaluated at the same moments — whenever something happened that
// could plausibly have earned one. Nothing runs on a timer, so a farm sitting
// idle does no achievement work at all, and a week of offline catch-up costs
// only what the player's own actions would have.
//
// Counting lives in here rather than in the modules that do the work, because
// the alternative is a `bump()` scattered through a dozen files that each have
// their own job. The hooks are deliberately few: the farmer's task pipeline
// (see applyTaskResult), the shop, and the wall clock for the day streak.
//
// Existing farms start from zero on purpose — see the note in state.js. That is
// why even the ones phrased as *having* something ("ten barns", "10 farmhands")
// are counted as they are built and hired rather than read off the farm: a save
// that already has ten barns must not be handed the award for picking up its
// next egg. The journals are the exception, and the reason is above — they are
// a real record rather than a guess.
//
// Hard rules, same as everything in sim/: no DOM, no Math.random(), no
// Date.now(). The day streak takes today's date as an argument — see
// notePlayDay — precisely so this file never reads a clock.

import { emitUnlessSuspended } from '../engine/events.js';
import { ANIMALS } from './animals.js';
import { CROPS } from './crops.js';
import { SPECIES, MUSHROOMS, journalCount } from './mushrooms.js';
import { FLOWER_KINDS, WILD_HUES } from './flowergenes.js';
import { FISH_IDS, caughtBefore, itemFor } from './fish.js';
import { handTargeting } from './farmhand.js';

/**
 * Which bag items count toward which tally, built from the tables that own
 * them rather than typed out here.
 *
 * A new crop, a new mushroom colour or a new fish therefore counts the day it
 * is added, with nothing to remember to update — which matters more than it
 * looks, because forgetting would not break anything loudly. It would just
 * quietly stop counting, and the first anyone would know is an achievement that
 * never arrived.
 */
const CROP_ITEMS = new Set(Object.keys(CROPS));
const MUSHROOM_ITEMS = new Set(Object.values(SPECIES).map((s) => s.item));
const FISH_ITEMS = new Set(FISH_IDS.map(itemFor));
const PRODUCE_ITEMS = new Set(
  Object.values(ANIMALS).map((a) => a.produces).filter((id) => id && id !== 'egg'),
);

/** How many wild colours there are to find in total, across every kind. */
export const FLOWER_SLOTS = FLOWER_KINDS.length * WILD_HUES;

/**
 * One rung of a ladder becomes one achievement.
 *
 * Most of these count the same handful of things at different heights — ten
 * crops, a hundred, five hundred, a thousand — and writing each rung out by
 * hand meant four near-identical objects whose only real difference was a
 * number, with four chances to point the check at the wrong counter. Here the
 * counter is named once for the whole ladder.
 *
 * What is *not* generated is the name. "Egg hunt", "Good clutch", "Omelette
 * money" — the joke is the reward, and a ladder that generated "Eggs II" would
 * be a progress bar wearing a medal. Blurbs are generated, because "Picked up
 * 500 eggs" is a fact and facts do not need writing twice; a rung can override
 * it where the sentence needs care (see the ones that stop at one).
 *
 * @param {string} key the tally in state.achievements.counts
 * @param {(n: number) => string} text how the blurb reads at n
 * @param {Array<{at: number, id: string, name: string, blurb?: string}>} rungs
 */
function ladder(key, text, rungs) {
  return rungs.map((rung) => ({
    id: rung.id,
    name: rung.name,
    blurb: rung.blurb || text(rung.at),
    check: (s) => count(s, key) >= rung.at,
  }));
}

/**
 * The list, in the order it is shown.
 *
 * Ladders first, because they are what a player is walking up on any given
 * afternoon; then the odd ones out; then the three that ask for a whole
 * collection, which are the end of the game rather than a step in it.
 *
 * `blurb` is what the player is told once they have it — which is also the
 * first time they are told anything, since a locked achievement shows neither
 * its name nor its condition (see rows()). A hidden list is a nicer surprise on
 * a small farm game than a checklist of chores.
 *
 * Every `check` is a pure function of the state and must stay cheap: they all
 * run on every hook, so nothing in here may walk the map.
 *
 * **Ids are permanent.** They are the keys in every existing save's earned
 * record, so a rung may be renamed or reworded freely and must never be
 * renumbered or renamed *as an id* — that would take an award back off a farm
 * that had earned it.
 */
export const ACHIEVEMENTS = [
  ...ladder('crops', (n) => `Harvested ${n} crops`, [
    { at: 10, id: 'first_pickings', name: 'First pickings' },
    { at: 100, id: 'market_day', name: 'Market day' },
    { at: 500, id: 'full_cellar', name: 'Full cellar' },
    { at: 1000, id: 'bountiful_harvest', name: 'Bountiful harvest' },
  ]),

  ...ladder('eggs', (n) => `Picked up ${n} eggs`, [
    { at: 10, id: 'egg_hunt', name: 'Egg hunt' },
    { at: 100, id: 'good_clutch', name: 'Good clutch' },
    { at: 500, id: 'omelette_money', name: 'Omelette money' },
    { at: 1000, id: 'what_the_cluck', name: 'What the cluck' },
  ]),

  // Milk, goat's milk and wool — everything an animal gives that isn't an egg.
  ...ladder('produce', (n) => `Collected ${n} pails of milk and fleeces of wool`, [
    { at: 10, id: 'milk_round', name: 'Milk round' },
    { at: 100, id: 'creamery', name: 'Creamery' },
    { at: 500, id: 'dairy_empire', name: 'Dairy empire' },
  ]),

  ...ladder('mushrooms', (n) => `Picked ${n} mushrooms`, [
    { at: 10, id: 'forager', name: 'Forager' },
    { at: 100, id: 'mushroom_mania', name: 'Mushroom mania' },
    { at: 500, id: 'fungus_among_us', name: 'Fungus among us' },
  ]),

  ...ladder('fish', (n) => `Landed ${n} fish`, [
    { at: 10, id: 'got_a_bite', name: 'Got a bite' },
    { at: 100, id: 'angler', name: 'Angler' },
    { at: 500, id: 'old_salt', name: 'Old salt' },
  ]),

  ...ladder('flowers', (n) => `Planted ${n} flowers`, [
    { at: 10, id: 'first_bloom', name: 'First bloom' },
    { at: 50, id: 'green_thumb', name: 'Green thumb' },
    { at: 100, id: 'greenhouse_god', name: 'Greenhouse god' },
    { at: 250, id: 'flower_fields', name: 'Flower fields' },
  ]),

  ...ladder('animals', (n) => `Bought ${n} animals`, [
    { at: 1, id: 'first_of_the_herd', name: 'First of the herd', blurb: 'Bought your first animal' },
    { at: 10, id: 'small_holding', name: 'Small holding' },
    { at: 100, id: 'zoo', name: 'Is this a zoo?' },
  ]),

  ...ladder('hands', (n) => `Hired ${n} farmhands`, [
    { at: 1, id: 'extra_hands', name: 'An extra pair of hands', blurb: 'Hired your first farmhand' },
    { at: 10, id: 'hired_help', name: 'Hired help' },
    { at: 25, id: 'on_the_payroll', name: 'On the payroll' },
  ]),

  ...ladder('water', (n) => `Dug ${n} tiles of water`, [
    { at: 10, id: 'puddle', name: 'Puddle' },
    { at: 100, id: 'water_works', name: 'Water works' },
    { at: 500, id: 'reservoir', name: 'Reservoir' },
  ]),

  ...ladder('barns', (n) => `Built ${n} barns`, [
    { at: 1, id: 'first_barn', name: 'Somewhere to sleep', blurb: 'Built a barn of your own' },
    { at: 10, id: 'barn_raising', name: 'Barn raising' },
  ]),

  ...ladder('houses', () => '', [
    { at: 1, id: 'home_sweet_home', name: 'Home sweet home', blurb: 'Built a house' },
  ]),

  // The odd ones out: no ladder, no second helping.
  {
    id: 'noahs_ark',
    name: "Noah's ark",
    blurb: 'Bought two of every animal',
    check: (s) => Object.keys(ANIMALS).every((type) => count(s, `bought:${type}`) >= 2),
  },
  {
    // The name is the condition: you got there before the hired help did.
    // Checked against a farmhand actually on its way to that animal rather
    // than merely being employed — see noteTaskResult.
    id: 'manual_labor',
    name: 'Manual labor',
    blurb: 'Beat a farmhand to an animal they were already walking to',
    check: (s) => count(s, 'beatHand') >= 1,
  },
  {
    id: 'dedicated_farmer',
    name: 'Dedicated farmer',
    blurb: 'Played ten days running',
    check: (s) => count(s, 'streak') >= 10,
  },

  // And the three that want the whole cabinet. Last on the list because that is
  // where they are in the game.
  {
    id: 'mushroom_master',
    name: 'Mushroom master',
    blurb: `Found all ${MUSHROOMS.length} mushrooms`,
    check: (s) => MUSHROOMS.every((m) => journalCount(s, m.id) > 0),
  },
  {
    // The whole journal, not just one of each kind: the wheels are what the
    // flower journal calls a collection, and finishing them is the endgame the
    // breeding is for.
    id: 'flower_master',
    name: 'Flower master',
    blurb: `Found all ${FLOWER_SLOTS} flower colours`,
    check: (s) => FLOWER_KINDS.every(
      (kind) => (((s.flowerJournal || {})[kind] || {}).hues || []).length >= WILD_HUES,
    ),
  },
  {
    id: 'bigger_boat',
    name: "We're going to need a bigger boat",
    blurb: `Caught all ${FISH_IDS.length} fish`,
    check: (s) => FISH_IDS.every((id) => caughtBefore(s, id)),
  },
];

export const ACHIEVEMENTS_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

export function achievementDef(id) { return ACHIEVEMENTS_BY_ID[id] || null; }

// --- the record ----------------------------------------------------------

/**
 * The shape kept in the save.
 *
 * `earned` maps id to the tick it was earned on, which is what lets the boot
 * sequence tell the player about anything that landed while they were away —
 * events are suspended during catch-up, so the toast never fires. See
 * earnedSince.
 */
export function newAchievementRecord() {
  return { earned: {}, counts: {} };
}

function record(state) {
  if (!state.achievements) state.achievements = newAchievementRecord();
  const rec = state.achievements;
  rec.earned = rec.earned || {};
  rec.counts = rec.counts || {};
  return rec;
}

export function count(state, key) {
  return (state.achievements?.counts || {})[key] || 0;
}

export function isEarned(state, id) {
  return (state.achievements?.earned || {})[id] != null;
}

export function earnedCount(state) {
  return ACHIEVEMENTS.filter((a) => isEarned(state, a.id)).length;
}

/**
 * Every achievement, in list order, with its name and condition withheld until
 * it has been earned.
 *
 * Withheld here rather than in the panel so the answers never reach the DOM at
 * all: a locked achievement is nothing but an id and a question mark.
 */
export function rows(state) {
  return ACHIEVEMENTS.map((a) => {
    const earned = isEarned(state, a.id);
    return {
      id: a.id,
      earned,
      name: earned ? a.name : null,
      blurb: earned ? a.blurb : null,
    };
  });
}

/**
 * Ids earned strictly after a given tick, in list order. Used by the boot
 * report to find what landed during offline catch-up.
 *
 * Exclusive on purpose: the tick handed in is the one the farm was left on, so
 * an award earned in the last second of the previous session belongs to that
 * session and must not be announced again on every load thereafter.
 */
export function earnedSince(state, tick) {
  const earned = state.achievements?.earned || {};
  return ACHIEVEMENTS
    .filter((a) => earned[a.id] != null && earned[a.id] > tick)
    .map((a) => a.id);
}

// --- counting ------------------------------------------------------------

/**
 * Adds to a tally and checks whether that earned anything.
 *
 * Everything goes through here rather than through a check-on-tick, so the cost
 * of achievements on an idle farm is exactly zero.
 */
export function bump(state, key, n = 1) {
  if (!(n > 0)) return;
  const rec = record(state);
  rec.counts[key] = (rec.counts[key] || 0) + n;
  checkAchievements(state);
}

/** Sets a tally outright, for the ones that are a running figure rather than a
 *  total — at present just the day streak, which can go back down to 1. */
export function setCount(state, key, n) {
  const rec = record(state);
  if (rec.counts[key] === n) return;
  rec.counts[key] = n;
  checkAchievements(state);
}

/**
 * Evaluates everything not yet earned.
 *
 * Safe to call whenever something might have changed; the list is short, the
 * checks are all O(small), and each one stops being evaluated for good the
 * moment it is earned.
 *
 * @returns {string[]} ids earned by this call, if any
 */
export function checkAchievements(state) {
  const rec = record(state);
  let won = null;
  for (const a of ACHIEVEMENTS) {
    if (rec.earned[a.id] != null) continue;
    if (!a.check(state)) continue;
    rec.earned[a.id] = state.tickCount || 0;
    (won = won || []).push(a.id);
    emitUnlessSuspended('achievement:earned', { id: a.id, name: a.name, blurb: a.blurb });
  }
  return won || [];
}

// --- the hooks ------------------------------------------------------------

/**
 * Everything the farmer finishing a job can earn.
 *
 * One hook rather than a dozen, because the task pipeline is already the single
 * place where the farmer's work lands on the world — and it is the same place
 * the "while you were away" tally reads, which is a good sign it is the right
 * seam. Farmhands are covered too: what they gather reaches the player through
 * a 'gather' or 'unload' task, and is counted there exactly once.
 *
 * @param {object} task the task just completed
 * @param {Record<string, number>|null} gained what it put in the bag
 */
export function noteTaskResult(state, task, gained) {
  for (const [id, n] of Object.entries(gained || {})) {
    if (id === 'egg') bump(state, 'eggs', n);
    else if (PRODUCE_ITEMS.has(id)) bump(state, 'produce', n);
    else if (CROP_ITEMS.has(id)) bump(state, 'crops', n);
    else if (MUSHROOM_ITEMS.has(id)) bump(state, 'mushrooms', n);
    else if (FISH_ITEMS.has(id)) bump(state, 'fish', n);
  }

  if (task.type === 'plantflower') bump(state, 'flowers');

  // Only counts if a farmhand was actually on its way to that animal. Merely
  // employing somebody and doing your own milking is not beating them to it.
  if (task.type === 'collect' && gained && handTargeting(state, task.animalId)) {
    bump(state, 'beatHand');
  }
}

/**
 * A finished build. Called only when the build actually completed, so a job
 * that failed for want of materials counts for nothing.
 *
 * Counted rather than read off state.buildings, even for the ones phrased as
 * having something ("ten barns"). A farm that already had ten barns when this
 * shipped would otherwise be handed the award for its first egg, which is the
 * one thing an achievement must never do — every one of these is something the
 * player did while the game was watching. What it costs is that demolishing a
 * barn does not take the count back down, which nobody will ever notice, and
 * which is the kinder direction to be wrong in.
 */
export function noteBuild(state, task) {
  const tiles = (task.w || 1) * (task.h || 1);
  switch (task.buildKind) {
    case 'pond':
    case 'river':
      bump(state, 'water', tiles);
      break;
    case 'barn':
      bump(state, 'barns');
      break;
    case 'house':
    case 'stoneHouse':
      bump(state, 'houses');
      break;
    default:
      break;
  }
}

/** An animal bought. Counted by type as well as in total, for the ark. */
export function noteAnimalBought(state, type) {
  bump(state, `bought:${type}`);
  bump(state, 'animals');
}

/** A farmhand hired. */
export function noteHandHired(state) {
  bump(state, 'hands');
}

/**
 * Today, for the day-streak achievement.
 *
 * Takes the date as a string rather than reading a clock, because this file
 * runs inside the simulation and the simulation may not know what time it is —
 * see the hard rules at the top. main.js passes the real one; the tests pass
 * whatever day they are pretending it is.
 *
 * A day the game is opened at all counts. Consecutive means consecutive
 * calendar days in the player's own timezone: miss one and the streak restarts
 * at today, which is the forgiving reading and the only one a player would
 * guess.
 *
 * @param {string} today an ISO date, 'YYYY-MM-DD'
 * @returns {number} the streak including today
 */
export function notePlayDay(state, today) {
  const rec = record(state);
  const last = rec.lastPlayed;

  let streak;
  if (last === today) streak = count(state, 'streak') || 1;
  else if (last === dayBefore(today)) streak = (count(state, 'streak') || 0) + 1;
  else streak = 1;

  rec.lastPlayed = today;
  setCount(state, 'streak', streak);
  return streak;
}

/** The calendar day before an ISO date, as an ISO date. */
export function dayBefore(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  // UTC throughout: the string carries no timezone, so this is pure date
  // arithmetic on the label rather than anything to do with local midnight.
  const t = Date.UTC(y, m - 1, d) - 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}
