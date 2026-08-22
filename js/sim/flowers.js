// Flowers growing in the world: where they come from, and what picking one
// gets you.
//
// Nothing here is authored. The sheet holds eight flowers drawn in three greys
// — 255, 198 and 141 — and every flower in the game is one of those eight with
// those greys replaced by colours worked out from its genome (see
// flowergenes.js for what a genome is, and render/flowerart.js for the paint).
// There is no list of variants anywhere, and there is not meant to be one.
//
// The spawn machinery is the same shape as weeds and mushrooms: capped so a
// week away cannot carpet the farm, real work on one tick in FLOWER_INTERVAL so
// catch-up stays cheap, and state.rng only so replaying the same days twice
// grows the same flowers.

import { emitUnlessSuspended } from '../engine/events.js';
import { GROUND, OBJ } from '../world/tiledefs.js';
import { PLOT, plotCoords } from '../world/land.js';
import { cropAt } from './crops.js';
import { addItem } from './inventory.js';
import { isReserved } from './build.js';
import {
  FLOWERS, FLOWER_KINDS, WILD_HUES, HUE_STEP, makeGenome, rollWildGenome,
  seedIdFor, readSeedId, hueName, hueSlot, crossGenomes, flowerLabel, isCross, sentenceCase,
  petalHue,
} from './flowergenes.js';

export * from './flowergenes.js';

/** Ticks between spawn attempts. Rarer than weeds, kinder than mushrooms. */
export const FLOWER_INTERVAL = 240;

/** Ceiling, as a fraction of the land you own. */
export const FLOWER_MAX_FRACTION = 0.006;

/**
 * How long a watering keeps a flower willing to cross — half an hour.
 *
 * This was first set to the time soil takes to dry, on the grounds that it is
 * the same gesture. That was tidy and wrong: soil dries in less time than
 * passes between breeding attempts, so a watering routinely wore off before a
 * single attempt was made and the watering can appeared to do nothing at all.
 * It has to outlast the interval below by a comfortable margin, or the control
 * is a coin toss.
 */
export const FLOWER_WET_TICKS = 1800;

/**
 * Ticks between breeding attempts, and the chance one comes to anything.
 *
 * Together with the watering above these give a bed roughly two crosses per
 * watering: enough that going out with the can is visibly worth doing, few
 * enough that a colour arriving is still an event.
 */
export const BREED_INTERVAL = 300;
export const BREED_CHANCE = 0.35;

/**
 * Ceiling on flowers of every origin, as a fraction of the land you own.
 *
 * Higher than the wild one, and deliberately so: wild flowers only ever fill a
 * little of the valley, which leaves room underneath the ceiling for a garden
 * the player made to keep crossing. Without the gap a farm that had grown a few
 * wild flowers would find its beds silently sterile.
 */
export const FLOWER_TOTAL_FRACTION = 0.018;

/** How many seeds a picked flower is worth. */
export const SEEDS_PER_FLOWER = [1, 3];

const TRIES = 4;

// --- growing wild --------------------------------------------------------

export function updateFlowers(state) {
  if (state.tickCount % FLOWER_INTERVAL !== 0) return;

  const plots = Array.from(state.grid.owned);
  if (plots.length === 0) return;

  const cap = Math.max(1, Math.floor(plots.length * PLOT * PLOT * FLOWER_MAX_FRACTION));
  if (Object.keys(state.flowers || {}).length >= cap) return;

  for (let i = 0; i < TRIES; i++) {
    const { px, py } = plotCoords(plots[state.rng.int(plots.length)], state.grid.w);
    const x = px * PLOT + state.rng.int(PLOT);
    const y = py * PLOT + state.rng.int(PLOT);
    if (!canBloom(state, x, y)) continue;

    const kind = FLOWER_KINDS[state.rng.int(FLOWER_KINDS.length)];
    plant(state, x, y, kind, rollWildGenome(state.rng));
    return;
  }
}

/**
 * Ground a flower can occupy at all: open, owned grass with nothing on it.
 *
 * The record is checked as well as the tile. They should never disagree, but if
 * they ever do, a second flower planted on top of the first would leave the
 * older one stranded in state.flowers for ever — invisible, unpickable, and
 * still counting against the spawn cap.
 */
function bareGround(state, x, y) {
  const grid = state.grid;
  if (!grid.inBounds(x, y)) return false;
  if (!grid.isOwned(x, y)) return false;
  if (grid.getGround(x, y) !== GROUND.GRASS) return false;
  if (grid.getObject(x, y) !== OBJ.NONE) return false;
  if ((state.flowers || {})[`${x},${y}`]) return false;
  if (cropAt(state, x, y)) return false;
  return !isReserved(state, x, y);
}

/**
 * Where a flower may come up on its own — which is nowhere anybody is standing.
 * A flower appearing under the farmer's boots reads as a glitch even though
 * nothing about it blocks him.
 */
export function canBloom(state, x, y) {
  if (!bareGround(state, x, y)) return false;
  if (state.farmer.x === x && state.farmer.y === y) return false;
  return !(state.animals || []).some((a) => a.x === x && a.y === y);
}

/**
 * Where the farmer may deliberately put one.
 *
 * Same ground, but it does not care who is standing there — because he is. He
 * walks onto the tile to plant it, so asking "is this square empty of people"
 * at the moment of planting is asking whether he exists. That question failed
 * every planting until it was split from the one above.
 */
export function canPlantAt(state, x, y) {
  return bareGround(state, x, y);
}

/**
 * Drops flower records whose tile no longer says a flower is there.
 *
 * The tile marker is what the world draws and what a tap finds, so a record
 * without one is invisible and unreachable — but it would still hold its square
 * against future planting and still count against the spawn cap. Run on load,
 * where a scan of the map costs nothing anyone will notice.
 */
export function reconcileFlowers(state) {
  let dropped = 0;
  for (const key of Object.keys(state.flowers || {})) {
    const comma = key.indexOf(',');
    const x = +key.slice(0, comma);
    const y = +key.slice(comma + 1);
    if (state.grid.inBounds(x, y) && state.grid.getObject(x, y) === OBJ.FLOWER) continue;
    delete state.flowers[key];
    dropped++;
  }
  return dropped;
}

/** Puts a flower in the world. Used by spawning, by planting, and by breeding. */
export function plant(state, x, y, kind, genome) {
  state.flowers = state.flowers || {};
  state.flowers[`${x},${y}`] = { kind, hues: [...genome.hues], sat: genome.sat };
  state.grid.setObject(x, y, OBJ.FLOWER);
  emitUnlessSuspended('flower:bloomed', { x, y, kind });
  return state.flowers[`${x},${y}`];
}

/** @returns {{kind, genome, name}|null} what is growing here */
export function flowerAt(state, x, y) {
  const f = (state.flowers || {})[`${x},${y}`];
  if (!f || !FLOWERS[f.kind]) return null;
  const genome = makeGenome(f.hues, f.sat);
  return { kind: f.kind, genome, name: sentenceCase(flowerLabel(f.kind, genome)) };
}

/**
 * Picks one.
 *
 * The flower itself does not go in the bag — there is no such item, and no
 * price on it. What you take away is a handful of its seeds and the memory of
 * having seen it, which is the whole of what a flower is worth here.
 *
 * @returns {object|null} what went in the bag, in the shape the task pipeline
 *   reports gains
 */
export function pick(state, x, y) {
  const found = flowerAt(state, x, y);
  if (!found) return null;

  delete state.flowers[`${x},${y}`];
  state.grid.setObject(x, y, OBJ.NONE);

  const [min, max] = SEEDS_PER_FLOWER;
  const count = min + state.rng.int(max - min + 1);
  const id = seedIdFor(found.kind, found.genome);
  addItem(state, id, count);

  const first = !hasFound(state, found.kind, petalHue(found.genome));
  record(state, found.kind, petalHue(found.genome));
  emitUnlessSuspended('flower:picked', { x, y, kind: found.kind, name: found.name, first });
  return { [id]: count };
}

// --- breeding ------------------------------------------------------------
//
// A *watered* flower with a neighbour of its own kind puts up a third nearby
// that takes after both. It spreads the way anything on a grid spreads — a bed
// kept watered slowly fills in with the colours between the ones that were
// planted, which is the whole reason the wild ring has gaps in it.
//
// Watering is the whole of the control, and it is the reason this is a garden
// rather than a weather report. Crossing used to happen wherever two flowers
// happened to touch, which meant a player who liked their bed exactly as it was
// had no way to say so. Now a bed left dry is a bed left alone, and stopping is
// as easy as not doing something.
//
// Same shape as every other growing thing here: real work on one tick in
// BREED_INTERVAL, capped so a fortnight away cannot bury the farm, and rolled
// from state.rng so catching up twice grows the same garden.

/** The eight neighbours, nearest first is not important — any of them will do. */
const AROUND = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

export function totalCap(state) {
  const owned = state.grid.owned.size * PLOT * PLOT;
  return Math.max(1, Math.floor(owned * FLOWER_TOTAL_FRACTION));
}

export function updateBreeding(state) {
  if (state.tickCount % BREED_INTERVAL !== 0) return null;
  if (!state.rng.chance(BREED_CHANCE)) return null;

  // Only the watered ones are in the running, which is also what keeps this
  // cheap: a farm carpeted in wild flowers has nothing to consider unless the
  // player has been out with the watering can.
  const keys = Object.keys(state.flowers || {}).filter((k) => isWet(state, state.flowers[k]));
  if (keys.length === 0) return null;
  if (Object.keys(state.flowers).length >= totalCap(state)) return null;

  // A handful of tries rather than a sweep of every flower on the farm: this
  // runs during catch-up too, and a crowded garden should not cost more than a
  // sparse one.
  for (let i = 0; i < 6; i++) {
    const key = keys[state.rng.int(keys.length)];
    const comma = key.indexOf(',');
    const x = +key.slice(0, comma);
    const y = +key.slice(comma + 1);
    const child = breedAt(state, x, y);
    if (child) return child;
  }
  return null;
}

/**
 * Tries to raise a child from the flower at (x, y) and one of its neighbours.
 * @returns {{kind, genome, name}|null} the flower that grew, if one did
 */
export function breedAt(state, x, y) {
  const mother = flowerAt(state, x, y);
  if (!mother) return null;
  // The watered one is the one doing the crossing; its neighbour need not be.
  // Watering a single flower is a small enough gesture to aim precisely, which
  // is what makes this a control rather than a chore.
  if (!isWet(state, state.flowers[`${x},${y}`])) return null;

  const mates = [];
  const spots = [];
  for (const [dx, dy] of AROUND) {
    const nx = x + dx;
    const ny = y + dy;
    const other = flowerAt(state, nx, ny);
    if (other && other.kind === mother.kind) mates.push(other);
    else if (canBloom(state, nx, ny)) spots.push({ x: nx, y: ny });
  }
  if (mates.length === 0 || spots.length === 0) return null;

  const father = mates[state.rng.int(mates.length)];
  const where = spots[state.rng.int(spots.length)];
  const genome = crossGenomes(mother.genome, father.genome, state.rng);

  plant(state, where.x, where.y, mother.kind, genome);
  emitUnlessSuspended('flower:bred', {
    x: where.x, y: where.y, kind: mother.kind, name: flowerLabel(mother.kind, genome),
  });
  // The same shape flowerAt gives, rather than the raw record: a caller asking
  // what grew wants the flower, not the row in the table.
  return flowerAt(state, where.x, where.y);
}

/** Is this flower still damp enough to be interested in its neighbours? */
export function isWet(state, flower) {
  return !!flower && (flower.wet || 0) > state.tickCount;
}

/** Whether the tile holds a flower somebody has watered. */
export function isWatered(state, x, y) {
  return isWet(state, (state.flowers || {})[`${x},${y}`]);
}

/**
 * Waters the flower here, if there is one.
 *
 * Flowers grow in grass rather than in a bed, so there is no wet soil to show
 * for it — the damp is kept on the flower itself, and goes when the flower is
 * picked rather than lingering on a tile nobody is looking at.
 *
 * @returns {boolean} whether there was anything here to water
 */
export function water(state, x, y) {
  const flower = (state.flowers || {})[`${x},${y}`];
  if (!flower) return false;
  flower.wet = state.tickCount + FLOWER_WET_TICKS;
  emitUnlessSuspended('world:changed', { x, y });
  return true;
}

// --- the journal ---------------------------------------------------------
//
// Kept apart from the seeds on purpose. Seeds are spent — planted, or lost when
// a bed is cleared — and a collection that forgets what you have already found
// the moment you use it is not a collection. The journal remembers the kinds
// you have picked and, within each, which colours around the wheel you have
// actually held. That second part is what breeding is aiming at.

export function record(state, kind, hue) {
  state.flowerJournal = state.flowerJournal || {};
  const entry = state.flowerJournal[kind] || (state.flowerJournal[kind] = { picked: 0, hues: [] });
  entry.picked += 1;
  const slot = hueSlot(hue);
  if (!entry.hues.includes(slot)) entry.hues.push(slot);
  return entry;
}

export function hasFound(state, kind, hue) {
  const entry = (state.flowerJournal || {})[kind];
  return !!entry && entry.hues.includes(hueSlot(hue));
}

export function pickedCount(state, kind) {
  return ((state.flowerJournal || {})[kind] || {}).picked || 0;
}

export function kindsFound(state) {
  return FLOWER_KINDS.filter((k) => pickedCount(state, k) > 0).length;
}

/** Every kind with what is known about it, in sheet order. */
export function journalRows(state) {
  return FLOWER_KINDS.map((kind) => {
    const entry = (state.flowerJournal || {})[kind] || { picked: 0, hues: [] };
    return {
      kind,
      name: FLOWERS[kind].name,
      sprite: FLOWERS[kind].sprite,
      picked: entry.picked,
      hues: [...entry.hues].sort((a, b) => a - b),
      wild: WILD_HUES,
    };
  });
}

/**
 * The seeds in the bag, grouped by kind — which is how a drawer of seed packets
 * is actually organised, and the only way the list stays readable once a player
 * has been collecting for a while.
 */
export function seedGroups(state) {
  const byKind = new Map();
  for (const [id, qty] of Object.entries(state.inventory || {})) {
    if (qty <= 0) continue;
    const seed = readSeedId(id);
    if (!seed) continue;
    if (!byKind.has(seed.kind)) byKind.set(seed.kind, []);
    byKind.get(seed.kind).push({ id, qty, kind: seed.kind, genome: seed.genome });
  }
  return FLOWER_KINDS
    .filter((kind) => byKind.has(kind))
    .map((kind) => ({
      kind,
      name: FLOWERS[kind].name,
      sprite: FLOWERS[kind].sprite,
      seeds: byKind.get(kind).sort((a, b) => petalHue(a.genome) - petalHue(b.genome)),
    }));
}
