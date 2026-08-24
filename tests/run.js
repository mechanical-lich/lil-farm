// Minimal no-framework test runner: `node tests/run.js`
//
// Only headless modules are testable here (engine/, world/, sim/, state.js).
// Anything under render/ or ui/ touches the DOM by design and is verified in
// the browser instead.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { makeRng, hash2d } from '../js/engine/rng.js';
import { Grid } from '../js/world/grid.js';
import { GROUND, OBJ, isTilled, isWater, objDef } from '../js/world/tiledefs.js';
import { generateWorld, startingBarnAnchor } from '../js/world/worldgen.js';
import { findPath, besideBox, insideBox } from '../js/world/pathfind.js';
import { Camera } from '../js/render/camera.js';
import {
  PLOT, plotOfTile, plotBounds, plotIndex, startingPlot, landPrice, nextLandPrice,
  canBuyPlot, buyPlot, buyablePlots, totalPlots,
} from '../js/world/land.js';
import { expandSaveToCells, centreCellIndex } from '../js/world/expand.js';
import {
  updateWeeds, canSprout, countWeeds, WEED_INTERVAL, WEED_MAX_FRACTION,
} from '../js/sim/weeds.js';
import {
  MUSHROOMS, MUSHROOMS_BY_ID, SPECIES, MUSHROOM_MAX_FRACTION, sprout, forage,
  mushroomAt, rollSpecies, journalCount, journalFound, journalRows,
  canSprout as canSproutShroom, COLOURS_PER_SPECIES, rollColour, isRainbow,
} from '../js/sim/mushrooms.js';
import {
  addTask, cancelTask, prioritizeTask, taskForTile, tillRow, queueTillRow, clearBuildSite,
  followTargets,
} from '../js/sim/tasks.js';
import {
  CROPS, SOIL_DRY_TICKS, plantCrop, waterTile, harvestCrop,
  cropAt, isRipe, isStalled, spoilRemaining, SPOIL_TICKS, updateCrops, seedIdFor,
} from '../js/sim/crops.js';
import {
  ROTATION_TICKS, STAPLE_SEEDS, ROTATING_COUNT, ROTATING_TIERS, stockedSeedCrops, buyList, sellList,
  buy, sell, sellAll, buyAnimal, canBuyAnimal, canPlaceAnimal, MATERIALS,
  hireHand, canHireHand, handRow, sellGroups, groupValue,
} from '../js/sim/shop.js';
import { ITEMS, ITEM_GROUPS, itemGroup, countItem } from '../js/sim/inventory.js';
import {
  HAND_PRICE, HAND_CAPACITY, carriedTotal, isFull, handCount, handCapacity,
} from '../js/sim/farmhand.js';
import {
  CRATE_CAPACITY, crateAt, crateAccepts, crateRoom, depositInto, emptyCrate,
  findCrateFor, reconcileCrates,
} from '../js/sim/crates.js';
import { DECOR, decorList, salvageValue, canPlaceDecor, placeDecor } from '../js/sim/decor.js';
import { movableAt, canMoveTo, moveTo } from '../js/sim/moving.js';
import {
  ANIMALS, TROUGH_CAPACITY, FEED_COST, FOOD_DURATION, WATER_DURATION, SEEK_THRESHOLD,
  makeAnimal, collectFrom, isNeglected, fillWaterTrough, fillFeedTrough, pickFeed, animalDef,
  petAnimal, pickEmote, currentEmote, animalAt, isReady, PRODUCE_CAP,
  setAnimalVariants, animalVariantCount, variantOf, isThirsty, SWIMMERS, canLayAt,
  AFFECTION_MAX, PET_GAIN, PET_COOLDOWN, EMOTE_TICKS,
} from '../js/sim/animals.js';
import {
  BUILDABLES, canPlaceAt, canAfford, footprint, troughAnchorAt,
  completeBuild, demolish, structureAt, buildingAt, animalCapacity, BARN_CAPACITY,
  placeStructure, buildDef, kindForGround, isReserved, canCompleteBuild,
  pendingWaterTiles, pendingGroundTiles, footprint as buildFootprint,
  barnCost, barnWork, barnCapacity, snapBarn, reservedTiles, refundFor, sizeOf,
  costLabel, placementProblem, reconcileBuildings,
} from '../js/sim/build.js';
import { TOWN, WATER, RIVER } from '../js/render/sprites.js';
import {
  TRADED, PRICE_FLOOR, PRICE_CEILING, GLUT_RATIO, TICKS_PER_DAY, newMarket, priceOf,
  priceMultiplier, recordSale, updateMarket, basePrice, marketRows, multiplierFor,
  glutRatio,
} from '../js/sim/market.js';
import { barnGrid } from '../js/render/tilerender.js';
import {
  FLOWER_KINDS, WILD_HUES, HUE_STEP, makeGenome, rollWildGenome, readSeedId, isFlowerSeed,
  seedIdFor as flowerSeedId, blendHue, crossGenomes, isCross, seedName, petalHue, toneCount,
} from '../js/sim/flowergenes.js';
import {
  plant as plantFlower, pick as pickFlower, flowerAt, canBloom, canPlantAt, pickedCount,
  hasFound, seedGroups, FLOWER_INTERVAL, FLOWER_MAX_FRACTION,
  breedAt, totalCap, BREED_INTERVAL, water as waterFlower, isWatered, FLOWER_WET_TICKS,
} from '../js/sim/flowers.js';
import { palette, KEYS, flowerCanvas, cacheSize, CACHE_LIMIT } from '../js/render/flowerart.js';
import { decodePng } from '../tools/png.mjs';
import {
  riverPieceAt, autotileQuadrants, isWaterAt, isDirtAt as isDirt,
} from '../js/render/tilerender.js';
import { addItems } from '../js/sim/inventory.js';
import { newGame as newGameRaw, serialize, deserialize } from '../js/state.js';
import { tick } from '../js/sim/tick.js';
import {
  migrate, Autosaver, exportSave, validateSave, loadSave, listBackups, backupKey,
} from '../js/engine/save.js';
import { runCatchup, GameLoop, discardSkipped } from '../js/engine/loop.js';
import { anythingMoving } from '../js/render/renderer.js';
import {
  on, suspend, resume, startTally, stopTally, emitUnlessSuspended,
} from '../js/engine/events.js';
import { buildSummary } from '../js/ui/summary.js';
import {
  TICK_MS, SAVE_VERSION, FARMER_SPEED, MAP_W, MAP_H, CELL_W, CELL_H, SAVE_KEY,
  TILE, ANIMAL_VARIANTS, MAX_CATCHUP_TICKS, CATCHUP_CHUNK,
} from '../js/config.js';

let passed = 0;
const failures = [];

/**
 * Tests are collected here and run one at a time at the end of the file.
 *
 * They used to run as they were declared, with async ones left to finish in
 * the background — which meant an async test's `await` handed control to the
 * *next* tests while its event listeners were still registered. A later test
 * that fired `task:done` would be counted by an earlier test's listener, and
 * the failure appeared in the innocent test. Sequential is slower by nothing
 * measurable and removes a whole class of confusing failure.
 */
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function runAll() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failures.push({ name, err });
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

/**
 * Two fresh farms from one seed, sharing a clock.
 *
 * newGame() stamps lastTickTime from the wall clock, so two games built on
 * either side of a millisecond boundary differ by 1ms and any whole-state
 * comparison fails spuriously. Aligning the clock keeps these tests about what
 * they actually claim to test: that the simulation itself is deterministic.
 */
/**
 * Every test below predates land ownership and works wherever on the map it
 * likes, so `newGame` here hands over the whole valley. The land tests call
 * `newGameRaw` to get a farm with the single plot a real new game starts with.
 */
function newGame(seed) { return ownEverything(newGameRaw(seed)); }

/** A grid that is entirely owned — the pre-ownership Grid, for tests about tiles. */
function openGrid(w, h) {
  const g = new Grid(w, h);
  for (let i = 0; i < Math.ceil(w / PLOT) * Math.ceil(h / PLOT); i++) g.owned.add(i);
  return g;
}

/**
 * Hands a farm the whole map. Land ownership is its own feature with its own
 * tests; every other test predates it and works wherever it likes, so helpers
 * that aren't about land opt out of the boundary rather than dodging it.
 */
/**
 * A farm as it would have been saved before the 3x3 world: one 40x40 map with
 * no ownership recorded, coordinates running 0..39.
 *
 * Built by taking the middle cell of a current farm and shifting everything
 * back by one cell — the exact inverse of the migration, which is what makes it
 * a fair test of it rather than a fabricated shape the game never wrote.
 */
function oldWorldSave(state) {
  const data = JSON.parse(JSON.stringify(serialize(state)));
  data.version = 1;

  data.map = { w: CELL_W, h: CELL_H, ground: [], objects: [] };
  for (let y = 0; y < CELL_H; y++) {
    for (let x = 0; x < CELL_W; x++) {
      data.map.ground.push(state.grid.getGround(x + CELL_W, y + CELL_H));
      data.map.objects.push(state.grid.getObject(x + CELL_W, y + CELL_H));
    }
  }

  const back = (p) => { p.x -= CELL_W; p.y -= CELL_H; };
  back(data.farmer);
  (data.farmer.path || []).forEach(back);
  (data.farmer.trail || []).forEach(back);
  for (const a of data.animals || []) {
    back(a);
    if (typeof a.px === 'number') { a.px -= CELL_W; a.py -= CELL_H; }
    (a.path || []).forEach(back);
  }
  for (const b of data.buildings || []) back(b);
  for (const t of data.tasks || []) back(t);
  for (const key of ['crops', 'wetUntil', 'tillDir', 'troughs']) {
    const out = {};
    for (const [k, v] of Object.entries(data[key] || {})) {
      const comma = k.indexOf(',');
      out[`${+k.slice(0, comma) - CELL_W},${+k.slice(comma + 1) - CELL_H}`] = v;
    }
    data[key] = out;
  }
  return data;
}

function ownEverything(s) {
  for (let i = 0; i < totalPlots(s); i++) s.grid.owned.add(i);
  return s;
}

function twinGames(seed) {
  const a = newGame(seed);
  const b = newGame(seed);
  b.lastTickTime = a.lastTickTime;
  return [a, b];
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'not equal'}\n  expected: ${e}\n  actual:   ${a}`);
}

// --- rng ----------------------------------------------------------------

test('rng is deterministic for a given seed', () => {
  const a = makeRng(12345);
  const b = makeRng(12345);
  const seqA = Array.from({ length: 20 }, () => a.next());
  const seqB = Array.from({ length: 20 }, () => b.next());
  assertEqual(seqA, seqB, 'same seed must produce the same sequence');
});

test('rng state round-trips, so a reload resumes the same stream', () => {
  const a = makeRng(999);
  for (let i = 0; i < 50; i++) a.next();
  const saved = a.getState();
  const expected = Array.from({ length: 10 }, () => a.next());

  const b = makeRng(999);
  b.setState(saved);
  const actual = Array.from({ length: 10 }, () => b.next());
  assertEqual(actual, expected, 'restored rng must continue the same stream');
});

test('hash2d is stable and varies across coordinates', () => {
  assert(hash2d(3, 7) === hash2d(3, 7), 'must be stable');
  assert(hash2d(3, 7) !== hash2d(7, 3), 'must not be symmetric');
});

// --- grid ---------------------------------------------------------------

test('grid walkability distinguishes farmer from animal at gates', () => {
  const g = openGrid(4, 4);
  g.setObject(1, 1, OBJ.GATE);
  g.setObject(2, 2, OBJ.FENCE);

  assert(g.isWalkable(1, 1, 'farmer'), 'farmer opens gates');
  assert(!g.isWalkable(1, 1, 'animal'), 'animals cannot open gates');
  assert(!g.isWalkable(2, 2, 'farmer'), 'fences block everyone');
  assert(!g.isWalkable(2, 2, 'animal'), 'fences block everyone');
});

test('grid treats out-of-bounds as unwalkable', () => {
  const g = openGrid(4, 4);
  assert(!g.isWalkable(-1, 0), 'negative x');
  assert(!g.isWalkable(0, 4), 'past height');
});

test('grid round-trips through JSON', () => {
  const g = openGrid(6, 5);
  g.setGround(2, 3, GROUND.TILLED);
  g.setObject(4, 1, OBJ.TREE);

  const back = Grid.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assertEqual([back.w, back.h], [6, 5], 'dimensions');
  assertEqual(back.getGround(2, 3), GROUND.TILLED, 'ground preserved');
  assertEqual(back.getObject(4, 1), OBJ.TREE, 'object preserved');
});

// --- worldgen -----------------------------------------------------------

test('worldgen is reproducible from a seed', () => {
  const a = generateWorld(makeRng(4242)).grid.toJSON();
  const b = generateWorld(makeRng(4242)).grid.toJSON();
  assertEqual(a.objects, b.objects, 'same seed must produce the same map');
});

test('worldgen leaves the spawn area clear and reachable', () => {
  const { grid, spawn } = generateWorld(makeRng(7));
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      assert(
        grid.isWalkable(spawn.x + dx, spawn.y + dy, 'farmer'),
        `spawn area blocked at ${dx},${dy}`,
      );
    }
  }
});

test('a new farm starts with exactly one barn, in front of the farmer', () => {
  const s = newGame(1234);

  assertEqual(s.buildings.length, 1, 'one barn to start');
  assertEqual(s.buildings[0].type, 'barn', 'and it is a barn');
  assertEqual(animalCapacity(s), BARN_CAPACITY, 'so animals are possible from day one');

  const barn = startingBarnAnchor({ x: s.farmer.x, y: s.farmer.y });
  assertEqual([s.buildings[0].x, s.buildings[0].y], [barn.x, barn.y], 'sited off the spawn');

  // The farmer must not begin standing inside his own barn.
  assert(!insideBox(barn.x, barn.y, 3, 2, s.farmer.x, s.farmer.y), 'farmer is outside it');
  assert(s.grid.isWalkable(s.farmer.x, s.farmer.y, 'farmer'), 'and on walkable ground');

  for (const t of footprint('barn', barn.x, barn.y)) {
    assertEqual(s.grid.getObject(t.x, t.y), OBJ.BUILDING, `footprint tile ${t.x},${t.y} marked`);
  }
});

test('the starting barn sits on the map with room for its roof', () => {
  // The roof draws three rows above the footprint; off the top of the map it
  // would simply vanish.
  for (const seed of [1, 2, 3, 99]) {
    const s = newGame(seed);
    const b = s.buildings[0];
    assert(b.y - 3 >= 0, `seed ${seed}: roof would run off the top`);
    assert(b.x >= 0 && b.x + 2 < s.grid.w, `seed ${seed}: barn hangs off the side`);
  }
});

test('the starting barn can be demolished like any other', () => {
  const s = newGame(4321);
  const b = s.buildings[0];
  s.inventory = {};

  const res = demolish(s, b.x + 1, b.y + 1);
  assert(res.ok, 'it comes down');
  assertEqual(s.buildings.length, 0, 'and is gone');
  assertEqual(animalCapacity(s), 0, 'taking its capacity with it');
  assertEqual(res.refund, { wood: 25, stone: 10 }, 'refunding half, same as any barn');
});

test('worldgen actually scatters obstacles', () => {
  const { grid } = generateWorld(makeRng(11));
  const count = grid.objects.reduce((n, v) => n + (v !== OBJ.NONE ? 1 : 0), 0);
  assert(count > 50, `expected a cluttered plot, got ${count} objects`);
});

// --- save round-trip ----------------------------------------------------

test('state round-trips through serialize/deserialize', () => {
  const s = newGame(2024);
  for (let i = 0; i < 25; i++) tick(s);

  const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));

  assertEqual(back.tickCount, s.tickCount, 'tickCount');
  assertEqual(back.lastTickTime, s.lastTickTime, 'lastTickTime');
  assertEqual(back.money, s.money, 'money');
  assertEqual(back.rng.getState(), s.rng.getState(), 'rng position');
  assertEqual(Array.from(back.grid.objects), Array.from(s.grid.objects), 'map objects');
});

test('a reloaded farm continues identically to one that never stopped', () => {
  // This is the property the whole offline-catch-up design rests on: saving,
  // reloading, and resuming must be indistinguishable from running straight
  // through.
  const live = newGame(31337);
  const forked = deserialize(JSON.parse(JSON.stringify(serialize(live))));

  for (let i = 0; i < 100; i++) tick(live);
  for (let i = 0; i < 100; i++) tick(forked);

  assertEqual(serialize(forked), serialize(live), 'resumed run diverged from continuous run');
});

// --- catch-up arithmetic ------------------------------------------------

test('N ticks advance the clock by exactly N * TICK_MS', () => {
  const s = newGame(5);
  const t0 = s.lastTickTime;
  for (let i = 0; i < 3600; i++) tick(s);

  assertEqual(s.tickCount, 3600, 'tick count');
  assertEqual(s.lastTickTime - t0, 3600 * TICK_MS, 'sim clock must track ticks exactly');
});

test('an hour of catch-up equals an hour of live ticking', () => {
  const [offline, online] = twinGames(808);

  const hours = 3600;
  for (let i = 0; i < hours; i++) tick(offline);   // replayed in one burst
  for (let i = 0; i < hours; i++) tick(online);    // as if ticked live

  assertEqual(serialize(offline), serialize(online), 'catch-up must match live play');
});

// --- migrations ---------------------------------------------------------

test('migrate accepts a current-version save', () => {
  const data = serialize(newGame(1));
  assert(migrate(data) !== null, 'current version should load');
});

test('migrate refuses a save from the future', () => {
  const data = serialize(newGame(1));
  data.version = SAVE_VERSION + 1;
  assertEqual(migrate(data), null, 'a newer save must be refused, not misread');
});

test('a disabled autosaver refuses to write, even on an explicit save', () => {
  // Guards the wipe path: the page fires pagehide on its way out, and a live
  // autosaver would write the discarded farm back over the cleared slot.
  let writes = 0;
  const a = new Autosaver(() => { writes++; return {}; });

  a.disable();
  a.markDirty(0);
  a.maybeSave(999999);
  assertEqual(a.saveNow(), false, 'saveNow must report that it did not write');
  assertEqual(writes, 0, 'nothing should have been serialized');
});

test('migrate refuses junk', () => {
  assertEqual(migrate(null), null, 'null');
  assertEqual(migrate({}), null, 'no version field');
});

// --- pathfinding --------------------------------------------------------

test('findPath walks a straight line on open ground', () => {
  const g = openGrid(10, 10);
  const path = findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 });
  assertEqual(path.length, 4, 'four steps to move four tiles');
  assertEqual(path[path.length - 1], { x: 4, y: 0 }, 'ends on the goal');
});

test('findPath routes around a wall', () => {
  const g = openGrid(7, 7);
  for (let y = 0; y < 6; y++) g.setObject(3, y, OBJ.FENCE);   // wall with a gap at y=6

  const path = findPath(g, { x: 0, y: 0 }, { x: 6, y: 0 });
  assert(path !== null, 'a way around exists');
  for (const step of path) {
    assert(g.isWalkable(step.x, step.y, 'farmer'), `path crosses a fence at ${step.x},${step.y}`);
  }
  assertEqual(path[path.length - 1], { x: 6, y: 0 }, 'still reaches the goal');
});

test('findPath returns null when the goal is walled off', () => {
  const g = openGrid(7, 7);
  for (let y = 0; y < 7; y++) g.setObject(3, y, OBJ.FENCE);   // full-height wall
  assertEqual(findPath(g, { x: 0, y: 0 }, { x: 6, y: 0 }), null, 'no route should exist');
});

test('findPath in adjacent mode stops next to a blocking target', () => {
  const g = openGrid(8, 8);
  g.setObject(4, 4, OBJ.TREE);   // cannot be stood on

  const path = findPath(g, { x: 0, y: 4 }, { x: 4, y: 4 }, { adjacent: true });
  assert(path !== null, 'should reach a neighbouring tile');
  const end = path[path.length - 1];
  assertEqual(Math.abs(end.x - 4) + Math.abs(end.y - 4), 1, 'ends orthogonally adjacent');
  assert(g.isWalkable(end.x, end.y, 'farmer'), 'ends somewhere standable');
});

test('findPath lets the farmer through a gate but not an animal', () => {
  const g = openGrid(5, 3);
  for (let y = 0; y < 3; y++) g.setObject(2, y, OBJ.FENCE);
  g.setObject(2, 1, OBJ.GATE);   // the only way through

  assert(findPath(g, { x: 0, y: 1 }, { x: 4, y: 1 }, { actor: 'farmer' }) !== null,
    'farmer opens the gate');
  assertEqual(findPath(g, { x: 0, y: 1 }, { x: 4, y: 1 }, { actor: 'animal' }), null,
    'animals must not escape through gates');
});

test('findPath is deterministic across runs', () => {
  const g = openGrid(12, 12);
  g.setObject(5, 5, OBJ.ROCK);
  const a = findPath(g, { x: 0, y: 0 }, { x: 11, y: 11 });
  const b = findPath(g, { x: 0, y: 0 }, { x: 11, y: 11 });
  assertEqual(a, b, 'identical inputs must give an identical route');
});

// --- tasks and the farmer -----------------------------------------------

test('taskForTile offers chopping for a tree and nothing for bare grass', () => {
  const s = newGame(3);
  s.grid.objects.fill(OBJ.NONE);
  s.grid.setObject(10, 10, OBJ.TREE);

  const t = taskForTile(s, 10, 10);
  assertEqual(t.type, 'chop', 'trees are chopped');
  assert(t.adjacent, 'a tree is worked on from beside it');
  assertEqual(taskForTile(s, 11, 11), null, 'nothing to do on empty grass');
});

test('the same tile cannot be queued twice', () => {
  const s = newGame(3);
  s.grid.setObject(10, 10, OBJ.ROCK);

  assert(addTask(s, taskForTile(s, 10, 10)) !== null, 'first queue works');
  assertEqual(addTask(s, taskForTile(s, 10, 10)), null, 'duplicate is rejected');
  assertEqual(s.tasks.length, 1, 'queue holds one task');
});

test('prioritizeTask moves work to the front', () => {
  const s = newGame(3);
  s.grid.setObject(10, 10, OBJ.ROCK);
  s.grid.setObject(12, 10, OBJ.ROCK);
  const first = addTask(s, taskForTile(s, 10, 10));
  const second = addTask(s, taskForTile(s, 12, 10));

  prioritizeTask(s, second.id);
  assertEqual(s.tasks[0].id, second.id, 'bumped task is now first');
  assertEqual(s.tasks[1].id, first.id, 'the other task follows');
});

test('cancelTask removes work and releases the farmer', () => {
  const s = newGame(3);
  s.grid.setObject(s.farmer.x + 2, s.farmer.y, OBJ.ROCK);
  const t = addTask(s, taskForTile(s, s.farmer.x + 2, s.farmer.y));

  for (let i = 0; i < 5; i++) tick(s);          // farmer claims and walks to it
  cancelTask(s, t.id);

  assertEqual(s.tasks.length, 0, 'task is gone');
  assertEqual(s.farmer.taskId, null, 'farmer is no longer holding it');
});

test('the farmer walks to a rock and clears it, yielding stone', () => {
  const s = newGame(77);
  // A clean, known plot so the test is about the farmer, not worldgen.
  s.grid.objects.fill(OBJ.NONE);
  const rx = s.farmer.x + 3;
  const ry = s.farmer.y;
  s.grid.setObject(rx, ry, OBJ.ROCK);

  addTask(s, taskForTile(s, rx, ry));
  for (let i = 0; i < 200; i++) tick(s);

  assertEqual(s.grid.getObject(rx, ry), OBJ.NONE, 'the rock should be gone');
  assertEqual(s.tasks.length, 0, 'the task should be finished');
  assert((s.inventory.stone || 0) >= 2, `expected stone in the bag, got ${s.inventory.stone}`);
});

test('the farmer covers FARMER_SPEED tiles per tick while travelling', () => {
  const s = newGame(606);
  s.grid.objects.fill(OBJ.NONE);
  const startX = s.farmer.x;
  const far = startX + 12;
  s.grid.setObject(far, s.farmer.y, OBJ.ROCK);
  addTask(s, taskForTile(s, far, s.farmer.y));

  tick(s);   // claims the task and takes its first step
  assertEqual(s.farmer.x - startX, FARMER_SPEED, 'should walk FARMER_SPEED tiles in one tick');
});

test('the trail records every tile stepped through, so turns are not cut', () => {
  const s = newGame(707);
  s.grid.objects.fill(OBJ.NONE);
  // Force an L-shaped route by walling off the direct line.
  const tx = s.farmer.x + 4;
  const ty = s.farmer.y + 4;
  s.grid.setObject(tx, ty, OBJ.ROCK);
  addTask(s, taskForTile(s, tx, ty));

  for (let i = 0; i < 6; i++) {
    tick(s);
    const trail = s.farmer.trail;
    // Consecutive trail entries must always be orthogonal neighbours; a cut
    // corner would show up here as a diagonal or a jump.
    for (let j = 1; j < trail.length; j++) {
      const d = Math.abs(trail[j].x - trail[j - 1].x) + Math.abs(trail[j].y - trail[j - 1].y);
      assertEqual(d, 1, `trail step ${j} was not a single orthogonal move`);
    }
  }
});

test('an unreachable task is deferred, not left blocking the queue', () => {
  const s = newGame(88);
  s.grid.objects.fill(OBJ.NONE);

  // Wall a rock into a sealed box the farmer cannot enter or stand beside.
  const bx = s.farmer.x + 6;
  const by = s.farmer.y;
  s.grid.setObject(bx, by, OBJ.ROCK);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    s.grid.setObject(bx + dx, by + dy, OBJ.FENCE);
  }

  const blocked = addTask(s, { type: 'clear', x: bx, y: by, work: 5, adjacent: true });

  // A reachable rock queued behind it must still get done.
  const ox = s.farmer.x + 2;
  s.grid.setObject(ox, s.farmer.y, OBJ.ROCK);
  addTask(s, taskForTile(s, ox, s.farmer.y));

  for (let i = 0; i < 300; i++) tick(s);

  assertEqual(s.grid.getObject(ox, s.farmer.y), OBJ.NONE, 'reachable rock got cleared');
  assert(s.tasks.some((t) => t.id === blocked.id), 'unreachable task is still queued');
  assert(s.tasks.find((t) => t.id === blocked.id).retries > 0, 'and was retried');
});

test('the farmer keeps the sim deterministic while wandering', () => {
  const [a, b] = twinGames(4321);
  for (let i = 0; i < 500; i++) { tick(a); tick(b); }
  assertEqual(serialize(a), serialize(b), 'idle wandering must stay deterministic');
});

// --- tilling in rows ----------------------------------------------------

test('tillRow snaps a diagonal selection to the longer axis', () => {
  const wide = tillRow({ x: 2, y: 5 }, { x: 8, y: 7 });
  assertEqual(wide.dir, 'h', 'a mostly-horizontal drag makes a horizontal row');
  assertEqual(wide.tiles.length, 7, 'x from 2..8 inclusive');
  assert(wide.tiles.every((t) => t.y === 5), 'every tile keeps the anchor row');

  const tall = tillRow({ x: 3, y: 1 }, { x: 5, y: 9 });
  assertEqual(tall.dir, 'v', 'a mostly-vertical drag makes a vertical row');
  assertEqual(tall.tiles.length, 9, 'y from 1..9 inclusive');
  assert(tall.tiles.every((t) => t.x === 3), 'every tile keeps the anchor column');
});

test('tillRow works backwards and for a single tile', () => {
  const back = tillRow({ x: 9, y: 4 }, { x: 6, y: 4 });
  assertEqual(back.tiles.length, 4, 'right-to-left still covers the span');

  const one = tillRow({ x: 4, y: 4 }, { x: 4, y: 4 });
  assertEqual(one.tiles.length, 1, 'a single tile is a legitimate bed');
});

test('queueTillRow skips blocked tiles instead of abandoning the row', () => {
  const s = newGame(321);
  s.grid.objects.fill(OBJ.NONE);
  const y = s.farmer.y + 3;
  s.grid.setObject(s.farmer.x + 2, y, OBJ.ROCK);   // one stray rock mid-row

  const res = queueTillRow(s, { x: s.farmer.x, y }, { x: s.farmer.x + 4, y });
  assertEqual(res.dir, 'h', 'horizontal row');
  assertEqual(res.queued, 4, 'the four clear tiles are queued');
  assertEqual(res.skipped, 1, 'the rock tile is skipped, not fatal');
});

test('tilling records the row axis on each tile', () => {
  const s = newGame(654);
  s.grid.objects.fill(OBJ.NONE);
  // Capture the row up front: the farmer wanders once the queue empties, so
  // reading his position after ticking would point at the wrong tiles.
  const x = s.farmer.x;
  const y0 = s.farmer.y + 2;
  const y1 = s.farmer.y + 5;
  queueTillRow(s, { x, y: y0 }, { x, y: y1 });

  for (let i = 0; i < 400; i++) tick(s);

  for (let y = y0; y <= y1; y++) {
    assertEqual(s.grid.getGround(x, y), GROUND.TILLED, `tile ${x},${y} tilled`);
    assertEqual(s.tillDir[`${x},${y}`], 'v', `tile ${x},${y} remembers a vertical row`);
  }
});

test('two stacked horizontal rows stay separate rows, not a grid', () => {
  // The point of storing an axis: adjacent rows must not merge into a blob.
  const s = newGame(987);
  s.grid.objects.fill(OBJ.NONE);
  const x0 = s.farmer.x;
  const y = s.farmer.y + 2;

  queueTillRow(s, { x: x0, y }, { x: x0 + 3, y });
  queueTillRow(s, { x: x0, y: y + 1 }, { x: x0 + 3, y: y + 1 });
  for (let i = 0; i < 800; i++) tick(s);

  for (const row of [y, y + 1]) {
    for (let x = x0; x <= x0 + 3; x++) {
      assertEqual(s.tillDir[`${x},${row}`], 'h', `tile ${x},${row} is part of a horizontal row`);
    }
  }
  // Both rows are horizontal, so neither joins its vertical neighbour: the
  // renderer caps each row independently.
  assertEqual(s.tillDir[`${x0},${y}`], s.tillDir[`${x0},${y + 1}`], 'both rows share the axis');
});

test('clearing an empty bed reverts it to grass and forgets its row', () => {
  const s = newGame(2468);
  s.grid.objects.fill(OBJ.NONE);
  const x = s.farmer.x + 2;
  const y = s.farmer.y;

  queueTillRow(s, { x, y }, { x, y });
  for (let i = 0; i < 200; i++) tick(s);
  assertEqual(s.grid.getGround(x, y), GROUND.TILLED, 'bed exists to begin with');

  addTask(s, taskForTile(s, x, y, 'clear'));
  for (let i = 0; i < 200; i++) tick(s);

  assertEqual(s.grid.getGround(x, y), GROUND.GRASS, 'bed reverted to grass');
  assertEqual(s.tillDir[`${x},${y}`], undefined, 'row axis forgotten');
});

test('clearing a bed also forgets that it was watered', () => {
  // A stale wetUntil entry would later dry a tile that is no longer a bed.
  const s = newGame(1357);
  s.grid.objects.fill(OBJ.NONE);
  const x = s.farmer.x + 2;
  const y = s.farmer.y;

  queueTillRow(s, { x, y }, { x, y });
  for (let i = 0; i < 200; i++) tick(s);
  waterTile(s, x, y);
  assert(s.wetUntil[`${x},${y}`] !== undefined, 'bed is wet');

  addTask(s, taskForTile(s, x, y, 'clear'));
  for (let i = 0; i < 200; i++) tick(s);

  assertEqual(s.wetUntil[`${x},${y}`], undefined, 'wetness forgotten with the bed');
  assertEqual(s.grid.getGround(x, y), GROUND.GRASS, 'and it really is grass');
});

test('clear refuses to destroy a bed that has a crop growing in it', () => {
  // Crops represent real waiting time; only a deliberate harvest removes them.
  const s = newGame(8642);
  s.grid.objects.fill(OBJ.NONE);
  const x = s.farmer.x + 2;
  const y = s.farmer.y;
  s.grid.setGround(x, y, GROUND.TILLED);
  plantCrop(s, x, y, 'corn');

  assertEqual(taskForTile(s, x, y, 'clear'), null, 'a planted bed is not clearable');

  // Once the crop is gone the bed can be undone as normal.
  harvestCrop(s, x, y);
  delete s.crops[`${x},${y}`];
  assert(taskForTile(s, x, y, 'clear') !== null, 'an empty bed is clearable again');
});

test('clear still prefers obstacles over undoing a bed', () => {
  const s = newGame(9753);
  s.grid.objects.fill(OBJ.NONE);
  const x = s.farmer.x + 2;
  const y = s.farmer.y;
  s.grid.setGround(x, y, GROUND.TILLED);
  s.grid.setObject(x, y, OBJ.ROCK);

  assertEqual(taskForTile(s, x, y, 'clear').type, 'clear', 'the rock is dealt with first');
});

test('a re-tilled tile picks up the new row axis, not the old one', () => {
  const s = newGame(4680);
  s.grid.objects.fill(OBJ.NONE);
  const x = s.farmer.x + 2;
  const y = s.farmer.y;

  queueTillRow(s, { x, y }, { x: x + 2, y });
  for (let i = 0; i < 400; i++) tick(s);
  assertEqual(s.tillDir[`${x},${y}`], 'h', 'first pass is horizontal');

  addTask(s, taskForTile(s, x, y, 'clear'));
  for (let i = 0; i < 200; i++) tick(s);

  queueTillRow(s, { x, y }, { x, y: y + 2 });
  for (let i = 0; i < 400; i++) tick(s);
  assertEqual(s.tillDir[`${x},${y}`], 'v', 'second pass is vertical');
});

test('tillDir survives a save and reload', () => {
  const s = newGame(112);
  s.grid.objects.fill(OBJ.NONE);
  const y = s.farmer.y + 2;
  queueTillRow(s, { x: s.farmer.x, y }, { x: s.farmer.x + 2, y });
  for (let i = 0; i < 400; i++) tick(s);

  const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));
  assertEqual(back.tillDir, s.tillDir, 'row axes must persist with the farm');
});

// --- crops and watering -------------------------------------------------

/** A farm with a clear plot and one tilled tile next to the farmer. */
function farmWithBed(seed = 1000) {
  const s = newGame(seed);
  // The barn's record goes with its tiles. Wiping the objects alone leaves a
  // barn nothing collides with — which loading now notices and repairs, so a
  // save/reload comparison would differ for reasons that have nothing to do
  // with crops.
  s.grid.objects.fill(OBJ.NONE);
  s.buildings = [];
  const x = s.farmer.x + 1;
  const y = s.farmer.y;
  s.grid.setGround(x, y, GROUND.TILLED);
  return { s, x, y };
}

test('a watered crop grows all the way to ripe', () => {
  const { s, x, y } = farmWithBed();
  plantCrop(s, x, y, 'carrot');
  waterTile(s, x, y);

  for (let i = 0; i < CROPS.carrot.growTicks + 5; i++) tick(s);

  const crop = cropAt(s, x, y);
  assert(!crop.dead, 'a watered crop must not die');
  assert(isRipe(crop), 'it should be ripe by the end of its life cycle');
});

test('an unwatered seed never grows, and is never lost', () => {
  // This is what makes planting a big field safe: nothing is at risk until the
  // farmer gets round to watering it.
  const { s, x, y } = farmWithBed();
  plantCrop(s, x, y, 'carrot');

  for (let i = 0; i < CROPS.carrot.growTicks * 4; i++) tick(s);

  const crop = cropAt(s, x, y);
  assert(!crop.dead, 'an unwatered seed must never die');
  assertEqual(crop.age, 0, 'and must not have aged at all');
  assert(!isRipe(crop), 'so it cannot be ripe');
  assert(isStalled(crop), 'it reports itself as waiting for water');
});

test('watering starts the clock, however late it comes', () => {
  const { s, x, y } = farmWithBed();
  plantCrop(s, x, y, 'corn');

  for (let i = 0; i < 5000; i++) tick(s);      // a long neglectful wait
  assertEqual(cropAt(s, x, y).age, 0, 'still dormant');

  waterTile(s, x, y);
  for (let i = 0; i < CROPS.corn.growTicks; i++) tick(s);

  const crop = cropAt(s, x, y);
  assert(!crop.dead, 'watering late is still fine');
  assert(isRipe(crop), 'and it grows the full cycle from when it was watered');
});

test('watering is only needed once, even after the soil dries out', () => {
  const { s, x, y } = farmWithBed();
  plantCrop(s, x, y, 'cabbage');
  waterTile(s, x, y);

  for (let i = 0; i < SOIL_DRY_TICKS + 50; i++) tick(s);

  assertEqual(s.grid.getGround(x, y), GROUND.TILLED, 'soil should have dried out');
  const crop = cropAt(s, x, y);
  assert(!crop.dead, 'the crop keeps growing regardless');
  assert(crop.age > 0, 'and it really is still growing');
});

test('planting into damp soil starts the crop growing straight away', () => {
  // The two-pass workflow: water the bed, then plant into it. Each seed grows
  // from the moment it goes in, rather than waiting for a third pass.
  const { s, x, y } = farmWithBed();
  waterTile(s, x, y);
  const crop = plantCrop(s, x, y, 'carrot');

  assert(crop.watered, 'the water was already there');
  assert(!isStalled(crop), 'so it is not waiting for anything');

  for (let i = 0; i < 50; i++) tick(s);
  assert(cropAt(s, x, y).age > 0, 'and it really is growing');
});

test('planting into dry soil still waits for the can, as it always did', () => {
  const { s, x, y } = farmWithBed();
  const crop = plantCrop(s, x, y, 'carrot');

  assert(!crop.watered, 'dry soil plants a dry seed');
  assert(isStalled(crop), 'which reports itself as waiting');

  for (let i = 0; i < 200; i++) tick(s);
  assertEqual(cropAt(s, x, y).age, 0, 'and it has not aged');

  waterTile(s, x, y);
  for (let i = 0; i < 50; i++) tick(s);
  assert(cropAt(s, x, y).age > 0, 'watering later starts it, exactly as before');
});

test('soil that has dried out plants a dry seed again', () => {
  const { s, x, y } = farmWithBed();
  waterTile(s, x, y);
  for (let i = 0; i < SOIL_DRY_TICKS + 5; i++) tick(s);
  assertEqual(s.grid.getGround(x, y), GROUND.TILLED, 'the bed dried out');

  assert(!plantCrop(s, x, y, 'carrot').watered, 'so there is no water to inherit');
});

test('watering skips beds that would gain nothing by it', () => {
  const { s, x, y } = farmWithBed();

  assert(taskForTile(s, x, y, 'water') !== null, 'a dry bed wants watering');
  waterTile(s, x, y);
  plantCrop(s, x, y, 'carrot');

  assertEqual(taskForTile(s, x, y, 'water'), null, 'a growing crop on damp soil does not');

  // Ripe: finished growing, so water is no use to it whatever the soil is like.
  const ripe = farmWithBed(717);
  plantCrop(ripe.s, ripe.x, ripe.y, 'carrot');
  waterTile(ripe.s, ripe.x, ripe.y);
  for (let i = 0; i < CROPS.carrot.growTicks + 5; i++) tick(ripe.s);
  assert(isRipe(cropAt(ripe.s, ripe.x, ripe.y)), 'it ripened');
  assertEqual(taskForTile(ripe.s, ripe.x, ripe.y, 'water'), null, 'and is not worth watering');
});

test('watering still reaches the beds that do need it', () => {
  // The other half of skipping: the tiles that matter must survive the filter,
  // or a drag across a field would queue nothing at all.
  const { s, x, y } = farmWithBed();
  plantCrop(s, x, y, 'carrot');          // dry soil, stalled seed
  assert(taskForTile(s, x, y, 'water') !== null, 'a stalled seed still wants water');

  // Bare wet soil is deliberately still waterable: topping it up extends the
  // window in which planting starts a crop already watered.
  const bed = farmWithBed(718);
  waterTile(bed.s, bed.x, bed.y);
  assert(taskForTile(bed.s, bed.x, bed.y, 'water') !== null, 'a damp empty bed can be topped up');
});

test('a watering drag over a ripening field shortens as it ripens', () => {
  // The point of the whole change, measured: the same drag costs less work as
  // more of the field comes good.
  const s = farmWithMaterials(7788);
  const y = s.farmer.y + 2;
  const xs = [];
  for (let i = 0; i < 8; i++) {
    const x = s.farmer.x - 4 + i;
    s.grid.setGround(x, y, GROUND.TILLED);
    xs.push(x);
  }
  const waterable = () => xs.filter((x) => taskForTile(s, x, y, 'water') !== null).length;

  assertEqual(waterable(), 8, 'a fresh bed needs the lot');

  for (const x of xs) { waterTile(s, x, y); plantCrop(s, x, y, 'carrot'); }
  assertEqual(waterable(), 0, 'once planted into damp soil, none of it needs a second pass');

  for (let i = 0; i < CROPS.carrot.growTicks + 5; i++) tick(s);
  assertEqual(waterable(), 0, 'and a ripe field needs none either');
});

test('the short crops are slow enough for a game you check on twice a day', () => {
  // The frame in the balance note is a game checked on twice a day. A carrot
  // that ripens in four minutes turns a field of any size into a treadmill.
  assert(CROPS.carrot.growTicks >= 480, 'carrot is not a four-minute crop');
  assert(CROPS.wheat.growTicks >= 600, 'nor is wheat a five-minute one');
  assert(CROPS.carrot.growTicks < CROPS.corn.growTicks
    || CROPS.carrot.growTicks < CROPS.tomato.growTicks, 'but they are still the quick ones');
});

test('watering darkens the soil and it dries back on schedule', () => {
  const { s, x, y } = farmWithBed();
  waterTile(s, x, y);
  assertEqual(s.grid.getGround(x, y), GROUND.TILLED_WET, 'soil turns wet immediately');

  for (let i = 0; i < SOIL_DRY_TICKS - 1; i++) { s.tickCount++; updateCrops(s); }
  assertEqual(s.grid.getGround(x, y), GROUND.TILLED_WET, 'still wet just before the deadline');

  s.tickCount++; updateCrops(s);
  assertEqual(s.grid.getGround(x, y), GROUND.TILLED, 'and dry once it expires');
});

test('a ripe crop spoils after 48 hours unpicked', () => {
  const { s, x, y } = farmWithBed();
  plantCrop(s, x, y, 'carrot');
  waterTile(s, x, y);
  for (let i = 0; i < CROPS.carrot.growTicks; i++) tick(s);
  assert(isRipe(cropAt(s, x, y)), 'ripe to begin with');

  for (let i = 0; i < SPOIL_TICKS - 1; i++) tick(s);
  assert(!cropAt(s, x, y).dead, 'still good just before the deadline');

  tick(s);
  assert(cropAt(s, x, y).dead, 'spoiled once 48 hours have passed');
});

test('harvesting in time avoids spoilage entirely', () => {
  const { s, x, y } = farmWithBed();
  plantCrop(s, x, y, 'carrot');
  waterTile(s, x, y);
  for (let i = 0; i < CROPS.carrot.growTicks; i++) tick(s);

  for (let i = 0; i < SPOIL_TICKS - 100; i++) tick(s);
  const gained = harvestCrop(s, x, y);
  assert(gained && gained.carrot >= 1, 'picked with time to spare');
});

test('spoilRemaining counts down only once a crop is ripe', () => {
  const { s, x, y } = farmWithBed();
  plantCrop(s, x, y, 'carrot');
  assertEqual(spoilRemaining(s, cropAt(s, x, y)), null, 'no clock while dormant');

  waterTile(s, x, y);
  for (let i = 0; i < 10; i++) tick(s);
  assertEqual(spoilRemaining(s, cropAt(s, x, y)), null, 'no clock while growing');

  // Land exactly on the tick it ripens, so the window is untouched.
  for (let i = 0; i < CROPS.carrot.growTicks - 10; i++) tick(s);
  assertEqual(spoilRemaining(s, cropAt(s, x, y)), SPOIL_TICKS, 'full window when it ripens');

  for (let i = 0; i < 600; i++) tick(s);
  assertEqual(spoilRemaining(s, cropAt(s, x, y)), SPOIL_TICKS - 600, 'and it ticks down');
});

test('a big field planted faster than it can be watered loses nothing', () => {
  // The exact scenario the old thirst rule destroyed: 30 tiles planted in a
  // batch, watered only afterwards.
  const s = newGame(4242);
  s.grid.ground.fill(GROUND.GRASS);
  s.grid.objects.fill(OBJ.NONE);
  s.inventory = { carrot_seed: 30 };

  const tiles = [];
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 10; i++) {
      const x = 3 + i;
      const y = 5 + row * 2;
      s.grid.setGround(x, y, GROUND.TILLED);
      tiles.push({ x, y });
    }
  }
  s.farmer.x = 3; s.farmer.y = 5; s.farmer.taskId = null; s.farmer.path = [];

  for (const t of tiles) addTask(s, taskForTile(s, t.x, t.y, 'plant', { cropType: 'carrot' }));
  for (const t of tiles) addTask(s, taskForTile(s, t.x, t.y, 'water'));

  let guard = 0;
  while (s.tasks.length > 0 && guard++ < 20000) tick(s);

  const crops = Object.values(s.crops);
  assertEqual(crops.length, 30, 'all 30 got planted');
  assertEqual(crops.filter((c) => c.dead).length, 0, 'and none were lost waiting for water');
  assert(crops.every((c) => c.watered), 'every one ended up watered');
});

test('a ripe crop is harvested into the bag; a dead one just clears', () => {
  const { s, x, y } = farmWithBed();
  plantCrop(s, x, y, 'carrot');
  waterTile(s, x, y);
  for (let i = 0; i < CROPS.carrot.growTicks; i++) updateCrops(s);

  const gained = harvestCrop(s, x, y);
  assert(gained && gained.carrot >= 1, `expected carrots, got ${JSON.stringify(gained)}`);
  assertEqual(cropAt(s, x, y), null, 'the bed is empty again');
  assertEqual(s.grid.getGround(x, y), GROUND.TILLED, 'and ready to replant');

  // Now the dead case: a crop that ripened and was left to spoil.
  plantCrop(s, x, y, 'carrot');
  waterTile(s, x, y);
  for (let i = 0; i < CROPS.carrot.growTicks + SPOIL_TICKS; i++) tick(s);
  assert(cropAt(s, x, y).dead, 'unpicked crop spoiled');
  assertEqual(harvestCrop(s, x, y), {}, 'clearing a dead crop yields nothing');
  assertEqual(cropAt(s, x, y), null, 'but does tidy the bed');
});

test('an unripe living crop cannot be harvested early', () => {
  const { s, x, y } = farmWithBed();
  plantCrop(s, x, y, 'corn');
  waterTile(s, x, y);
  for (let i = 0; i < 10; i++) tick(s);

  assertEqual(harvestCrop(s, x, y), null, 'too early to pick');
  assert(cropAt(s, x, y) !== null, 'and the crop is still growing');
});

test('the farmer tills, plants, waters and harvests a bed end to end', () => {
  const s = newGame(555);
  s.grid.objects.fill(OBJ.NONE);
  const x = s.farmer.x + 2;
  const y = s.farmer.y;
  s.inventory = { carrot_seed: 1 };

  addTask(s, taskForTile(s, x, y, 'till'));
  for (let i = 0; i < 60; i++) tick(s);
  assertEqual(s.grid.getGround(x, y), GROUND.TILLED, 'tilled the bed');

  addTask(s, taskForTile(s, x, y, 'plant', { cropType: 'carrot' }));
  for (let i = 0; i < 40; i++) tick(s);
  assert(cropAt(s, x, y) !== null, 'planted a carrot');
  assertEqual(s.inventory.carrot_seed, undefined, 'and the seed left the bag');

  addTask(s, taskForTile(s, x, y, 'water'));
  for (let i = 0; i < 40; i++) tick(s);
  assert(cropAt(s, x, y).watered, 'watered it');

  for (let i = 0; i < CROPS.carrot.growTicks; i++) tick(s);
  addTask(s, taskForTile(s, x, y, 'harvest'));
  for (let i = 0; i < 40; i++) tick(s);

  assert((s.inventory.carrot || 0) >= 1, `expected carrots in the bag, got ${s.inventory.carrot}`);
  assertEqual(cropAt(s, x, y), null, 'bed is clear for replanting');
});

test('planting is only queueable on tilled soil, watering only on soil', () => {
  const s = newGame(4);
  s.grid.objects.fill(OBJ.NONE);
  const x = s.farmer.x + 3;
  const y = s.farmer.y;

  assertEqual(taskForTile(s, x, y, 'plant', { cropType: 'carrot' }), null, 'grass is not plantable');
  assertEqual(taskForTile(s, x, y, 'water'), null, 'grass is not waterable');

  s.grid.setGround(x, y, GROUND.TILLED);
  assert(taskForTile(s, x, y, 'plant', { cropType: 'carrot' }) !== null, 'tilled soil is plantable');
  assert(taskForTile(s, x, y, 'water') !== null, 'tilled soil is waterable');
});

test('crop growth survives a save/reload unchanged', () => {
  const { s, x, y } = farmWithBed(90210);
  plantCrop(s, x, y, 'corn');
  waterTile(s, x, y);
  for (let i = 0; i < 50; i++) tick(s);

  const reloaded = deserialize(JSON.parse(JSON.stringify(serialize(s))));
  for (let i = 0; i < 200; i++) { tick(s); tick(reloaded); }

  assertEqual(serialize(reloaded), serialize(s), 'crops must survive persistence exactly');
});

test('a crop ripening while away spoils only after its 48 hours', () => {
  // Offline catch-up must apply spoilage exactly as live play would.
  const { s, x, y } = farmWithBed(1234);
  plantCrop(s, x, y, 'carrot');
  waterTile(s, x, y);

  for (let i = 0; i < CROPS.carrot.growTicks + SPOIL_TICKS - 1; i++) tick(s);
  assert(!cropAt(s, x, y).dead, 'still good on the last tick of the window');

  tick(s);
  assert(cropAt(s, x, y).dead, 'and gone once the window closes');
});

// --- construction -------------------------------------------------------

/**
 * A blank farm with plenty of materials — no obstacles, and crucially none of
 * the starting barn, so tests about buildings control their own world. Clearing
 * the object grid alone would strip the barn's tiles but leave its record
 * behind, which is worse than either extreme.
 */
function farmWithMaterials(seed = 500) {
  const s = newGame(seed);
  s.grid.ground.fill(GROUND.GRASS);
  s.grid.objects.fill(OBJ.NONE);
  s.mushrooms = {};                      // see weedableFarm
  s.buildings = [];
  s.troughs = {};
  s.animals = [];
  s.inventory = { wood: 500, stone: 500 };
  return s;
}

test('placement is refused on occupied, planted or tilled ground', () => {
  const s = farmWithMaterials();
  const y = 10;

  s.grid.setObject(4, y, OBJ.ROCK);
  assert(!canPlaceAt(s, 'fence', 4, y), 'not on top of a rock');

  s.grid.setGround(5, y, GROUND.TILLED);
  assert(!canPlaceAt(s, 'fence', 5, y), 'not on a bed');

  s.grid.setGround(6, y, GROUND.TILLED);
  plantCrop(s, 6, y, 'carrot');
  assert(!canPlaceAt(s, 'fence', 6, y), 'not on a crop');

  assert(canPlaceAt(s, 'fence', 7, y), 'but plain grass is fine');
});

test('a trough needs two clear tiles side by side', () => {
  const s = farmWithMaterials();
  assertEqual(footprint('waterTrough', 3, 3).length, 2, 'a trough covers two tiles');

  assert(canPlaceAt(s, 'waterTrough', 3, 3), 'two clear tiles is fine');

  s.grid.setObject(4, 3, OBJ.ROCK);
  assert(!canPlaceAt(s, 'waterTrough', 3, 3), 'blocked on its right-hand tile');
  assert(!canPlaceAt(s, 'waterTrough', 4, 3), 'or on its anchor');

  // Right at the map edge there is no room for the second tile.
  assert(!canPlaceAt(s, 'waterTrough', s.grid.w - 1, 3), 'must not hang off the map');
});

test('affordability counts work already queued, not just the bag', () => {
  const s = farmWithMaterials();
  s.inventory = { wood: 5 };   // enough for two fences (2 each), not three

  assert(canAfford(s, 'fence').ok, 'first is affordable');
  addTask(s, taskForTile(s, 3, 3, 'build', { buildKind: 'fence' }));
  assert(canAfford(s, 'fence').ok, 'second is affordable');
  addTask(s, taskForTile(s, 4, 3, 'build', { buildKind: 'fence' }));

  const third = canAfford(s, 'fence');
  assert(!third.ok, 'the third must be refused: the wood is already promised');
  assertEqual(third.missing, 'wood', 'and it should say what is short');
});

test('materials are spent on completion, so cancelling costs nothing', () => {
  const s = farmWithMaterials();
  s.inventory = { wood: 10 };

  const task = addTask(s, taskForTile(s, s.farmer.x + 2, s.farmer.y, 'build', { buildKind: 'fence' }));
  assertEqual(s.inventory.wood, 10, 'queueing must not charge the player');

  cancelTask(s, task.id);
  assertEqual(s.inventory.wood, 10, 'and cancelling refunds nothing because nothing was taken');
});

test('the farmer builds a fence, spending the wood exactly once', () => {
  const s = farmWithMaterials(501);
  s.inventory = { wood: 10 };
  const x = s.farmer.x + 3;
  const y = s.farmer.y;

  addTask(s, taskForTile(s, x, y, 'build', { buildKind: 'fence' }));
  for (let i = 0; i < 300; i++) tick(s);

  assertEqual(s.grid.getObject(x, y), OBJ.FENCE, 'the fence exists');
  assertEqual(s.inventory.wood, 8, 'exactly one fence worth of wood was spent');
  assertEqual(s.tasks.length, 0, 'and the task finished');
});

test('a built trough occupies both tiles and registers its contents', () => {
  const s = farmWithMaterials(502);
  const x = s.farmer.x + 3;
  const y = s.farmer.y;

  addTask(s, taskForTile(s, x, y, 'build', { buildKind: 'waterTrough' }));
  for (let i = 0; i < 400; i++) tick(s);

  assertEqual(s.grid.getObject(x, y), OBJ.TROUGH_WATER, 'anchor tile marked');
  assertEqual(s.grid.getObject(x + 1, y), OBJ.TROUGH_WATER, 'second tile marked too');
  assert(s.troughs[`${x},${y}`], 'and the trough itself is recorded at its anchor');
  assertEqual(s.troughs[`${x},${y}`].kind, 'water', 'as a water trough');
  assert(troughAnchorAt(s, x + 1, y) !== null, 'the right-hand tile maps back to the anchor');
});

test('building is refused when the materials ran out mid-queue', () => {
  const s = farmWithMaterials(503);
  s.inventory = { wood: 2 };
  const x = s.farmer.x + 2;
  const y = s.farmer.y;

  addTask(s, taskForTile(s, x, y, 'build', { buildKind: 'fence' }));
  s.inventory = {};   // the wood is spent elsewhere before the farmer arrives

  for (let i = 0; i < 300; i++) tick(s);
  assertEqual(s.grid.getObject(x, y), OBJ.NONE, 'nothing should be built for free');
});

test('a fenced pen with a gate holds animals but lets the farmer through', () => {
  // The milestone's acceptance test, done in code: a closed pen with one gate.
  const s = farmWithMaterials(504);
  const x0 = 5, y0 = 5, x1 = 10, y1 = 9;

  for (let x = x0; x <= x1; x++) { s.grid.setObject(x, y0, OBJ.FENCE); s.grid.setObject(x, y1, OBJ.FENCE); }
  for (let y = y0; y <= y1; y++) { s.grid.setObject(x0, y, OBJ.FENCE); s.grid.setObject(x1, y, OBJ.FENCE); }
  s.grid.setObject(x0, 7, OBJ.GATE);   // the only way in or out

  const inside = { x: x0 + 2, y: 7 };
  const outside = { x: 1, y: 7 };

  assert(findPath(s.grid, outside, inside, { actor: 'farmer' }) !== null,
    'the farmer can walk in through the gate');
  assertEqual(findPath(s.grid, inside, outside, { actor: 'animal' }), null,
    'an animal cannot get out');

  // Seal the gate with a fence and even the farmer is shut out.
  s.grid.setObject(x0, 7, OBJ.FENCE);
  assertEqual(findPath(s.grid, outside, inside, { actor: 'farmer' }), null,
    'with no gate, nobody gets in');
});

test('roads change the ground and stay walkable', () => {
  const s = farmWithMaterials(505);
  const x = s.farmer.x + 2;
  const y = s.farmer.y;

  addTask(s, taskForTile(s, x, y, 'build', { buildKind: 'road' }));
  for (let i = 0; i < 300; i++) tick(s);

  assertEqual(s.grid.getGround(x, y), GROUND.ROAD, 'ground became road');
  assert(s.grid.isWalkable(x, y, 'farmer'), 'and roads are walkable');
  assertEqual(taskForTile(s, x, y, 'build', { buildKind: 'road' }), null,
    'paving the same tile twice is pointless and should be refused');
});

test('structures survive a save and reload', () => {
  const s = farmWithMaterials(506);
  const x = s.farmer.x + 3;
  const y = s.farmer.y;
  addTask(s, taskForTile(s, x, y, 'build', { buildKind: 'feedTrough' }));
  for (let i = 0; i < 400; i++) tick(s);

  const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));
  assertEqual(back.troughs, s.troughs, 'troughs persist');
  assertEqual(back.grid.getObject(x + 1, y), OBJ.TROUGH_FOOD, 'and so do their grid marks');
});

// --- barns (multi-tile buildings) ---------------------------------------

test('a barn occupies a 3x2 footprint and nothing else', () => {
  const s = farmWithMaterials(700);
  assertEqual(footprint('barn', 5, 5).length, 6, 'three wide by two deep');

  completeBuild(s, { buildKind: 'barn', x: 5, y: 5 });

  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      assertEqual(s.grid.getObject(5 + dx, 5 + dy), OBJ.BUILDING, `tile ${dx},${dy} marked`);
      assert(!s.grid.isWalkable(5 + dx, 5 + dy, 'farmer'), 'a barn is solid');
    }
  }
  // The roof overhangs upward but must not block anything.
  assert(s.grid.isWalkable(6, 4, 'farmer'), 'the tile under the roof overhang stays walkable');
  assert(s.grid.isWalkable(5, 7, 'farmer'), 'and the tile below is clear');
});

test('structure tasks carry their footprint, so the UI can outline all of it', () => {
  const s = farmWithMaterials(708);

  const barn = taskForTile(s, 5, 5, 'build', { buildKind: 'barn' });
  assertEqual([barn.w, barn.h], [3, 2], 'a barn build task spans its 3x2 footprint');

  const trough = taskForTile(s, 5, 10, 'build', { buildKind: 'waterTrough' });
  assertEqual([trough.w, trough.h], [2, 1], 'and a trough spans two tiles');

  completeBuild(s, { buildKind: 'barn', x: 15, y: 15 });
  const remove = taskForTile(s, 16, 16, 'clear');
  assertEqual([remove.x, remove.y], [15, 15], 'demolition anchors on the building');
  assertEqual([remove.w, remove.h], [3, 2], 'and carries the footprint too');

  // Single-tile work leaves them unset; the renderer defaults to 1x1.
  const fence = taskForTile(s, 5, 12, 'build', { buildKind: 'fence' });
  assertEqual([fence.w, fence.h], [1, 1], 'a fence is one tile');
});

test('the farmer builds a barn from outside its footprint, not inside it', () => {
  // Measuring "adjacent" against the anchor alone let him work from a tile the
  // barn was about to occupy, leaving him embedded in the finished wall.
  const s = farmWithMaterials(709);
  const bx = 8, by = 8;
  s.farmer.x = 2; s.farmer.y = 8; s.farmer.taskId = null; s.farmer.path = [];

  addTask(s, taskForTile(s, bx, by, 'build', { buildKind: 'barn' }));

  let guard = 0;
  while (s.tasks.length > 0 && guard++ < 5000) {
    tick(s);
    if (s.farmer.work > 0) {
      assert(!insideBox(bx, by, 3, 2, s.farmer.x, s.farmer.y),
        `farmer worked from inside the footprint at ${s.farmer.x},${s.farmer.y}`);
      assert(besideBox(bx, by, 3, 2, s.farmer.x, s.farmer.y),
        'and should be standing right beside it');
    }
  }
  assertEqual(s.buildings.length, 1, 'the barn still got built');
  assert(!insideBox(bx, by, 3, 2, s.farmer.x, s.farmer.y), 'and he is not stuck inside it');
});

test('besideBox accepts every tile touching a footprint and no others', () => {
  // A 3x2 box has 10 orthogonal neighbours: 3 above, 3 below, 2 each side.
  let touching = 0;
  for (let y = 6; y <= 12; y++) {
    for (let x = 6; x <= 13; x++) {
      if (besideBox(8, 8, 3, 2, x, y)) touching++;
      assert(!(besideBox(8, 8, 3, 2, x, y) && insideBox(8, 8, 3, 2, x, y)),
        'a tile cannot be both inside and beside');
    }
  }
  assertEqual(touching, 10, 'three above, three below, two each side');
});

test('a barn may be sited over scenery, but not over anything deliberate', () => {
  // A farm is scattered with trees, rocks and weeds. Requiring a bare
  // rectangle made the biggest barn impossible to place anywhere on a new
  // farm — measured at nought sites in 576 — so the farmer clears the site as
  // part of the job instead. Things the player put there still refuse.
  const s = farmWithMaterials(701);
  assert(canPlaceAt(s, 'barn', 5, 5), 'open ground is fine');

  for (const obj of [OBJ.ROCK, OBJ.TREE, OBJ.WEED, OBJ.BUSH]) {
    s.grid.setObject(7, 6, obj);
    assert(canPlaceAt(s, 'barn', 5, 5), `the farmer can clear a ${objDef(obj).name} first`);
  }

  s.grid.setObject(7, 6, OBJ.FENCE);
  assert(!canPlaceAt(s, 'barn', 5, 5), 'but not a fence the player built');
  assertEqual(placementProblem(s, 'barn', 5, 5), 'there is a fence in the way', 'and says so');

  s.grid.setObject(7, 6, OBJ.NONE);
  assert(!canPlaceAt(s, 'barn', s.grid.w - 2, 5), 'and it must not hang off the map');
});

test('a stale building mark does not refuse an empty field', () => {
  // Reported from play: "it says there's a building in the way but there's
  // not". The grid's BUILDING marks are an index over state.buildings, and an
  // index can go stale — a mark with no record behind it was refusing ground
  // the player could see was bare. The record is the source of truth.
  const s = farmWithMaterials(4245);
  placeStructure(s, 'barn', 10, 10, [3, 2]);
  s.buildings = [];                                  // the record goes, marks stay

  assertEqual(placementProblem(s, 'barn', 10, 10, [3, 2]), null,
    'ground with nothing standing on it takes a barn');

  const fixed = reconcileBuildings(s);
  assertEqual(fixed.cleared, 6, 'and the marks are swept up');
  assertEqual(fixed.restored, 0, 'with nothing to put back');
  assertEqual(s.grid.getObject(10, 10), OBJ.NONE, 'the tile is clear afterwards');
});

test('a building missing its marks gets them back', () => {
  // The other direction, which is worse: a barn nothing collides with is a
  // barn animals walk through.
  const s = farmWithMaterials(4246);
  placeStructure(s, 'barn', 10, 10, [5, 3]);
  for (let x = 10; x < 15; x++) s.grid.setObject(x, 11, OBJ.NONE);

  const fixed = reconcileBuildings(s);
  assertEqual(fixed.restored, 5, 'the missing row is stamped back');
  assertEqual(fixed.cleared, 0, 'and nothing else is disturbed');
  assertEqual(s.grid.getObject(12, 11), OBJ.BUILDING, 'the wall is solid again');
});

test('a farm repairs its building marks when it loads', () => {
  const s = farmWithMaterials(4247);
  placeStructure(s, 'barn', 10, 10, [3, 2]);
  const saved = JSON.parse(JSON.stringify(serialize(s)));
  saved.buildings = [];                              // however it happened

  const loaded = deserialize(saved);
  assertEqual(loaded.grid.getObject(10, 10), OBJ.NONE, 'the farm comes back consistent');
});

test('a refused barn says which rule it broke', () => {
  // This is the whole reason placementProblem exists. Every rejection used to
  // read "something is in the way", so a rectangle that had merely crossed the
  // edge of the player's land sent them hunting for scenery that was not
  // there. Reported from real play, and the screenshots showed the boundary.
  // newGameRaw, not newGame: the helpers here hand over the whole valley, and
  // the boundary of the player's one plot is the whole point of this test.
  const s = newGameRaw(4244);
  s.inventory = { wood: 500, stone: 500 };

  let edge = null;
  for (let x = s.farmer.x; x < s.grid.w && !edge; x++) {
    if (!s.grid.isOwned(x, s.farmer.y)) edge = { x: x - 1, y: s.farmer.y };
  }
  assert(edge, 'the farm has an edge to run off');
  assertEqual(placementProblem(s, 'barn', edge.x, edge.y, [3, 2]), "you don't own all that land",
    'the edge of the farm is named, not blamed on clutter');

  const clear = { x: s.farmer.x + 4, y: s.farmer.y };
  for (const t of footprint('barn', clear.x, clear.y, [3, 2])) s.grid.setObject(t.x, t.y, OBJ.NONE);
  assertEqual(placementProblem(s, 'barn', clear.x, clear.y, [3, 2]), null, 'good ground passes');

  addTask(s, taskForTile(s, clear.x, clear.y, 'build', { buildKind: 'barn', size: [3, 2] }));
  assertEqual(placementProblem(s, 'barn', clear.x, clear.y, [3, 2]), 'something else is queued there',
    'and a queued barn holds its ground');
});

test('the building record is the source of truth, found from any of its tiles', () => {
  const s = farmWithMaterials(702);
  completeBuild(s, { buildKind: 'barn', x: 5, y: 5 });

  assertEqual(s.buildings.length, 1, 'one barn recorded');
  assertEqual(s.buildings[0].type, 'barn', 'recorded as a barn');

  // Every footprint tile carries the same generic marker, so only the record
  // can say which building a tile belongs to.
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      const found = buildingAt(s, 5 + dx, 5 + dy);
      assert(found !== null, `tile ${dx},${dy} maps back to the barn`);
      assertEqual([found.x, found.y], [5, 5], 'and reports the anchor');
    }
  }
  assertEqual(buildingAt(s, 8, 5), null, 'a tile just outside belongs to nothing');
});

// --- the camera ---------------------------------------------------------

test('the view can be pushed past the map, but only as far as the bars', () => {
  // The top bar and the bottom controls float over the canvas, so a tile
  // beneath one can be seen but not tapped. Running the view on past the edge
  // by the height of each bar is what makes the first and last rows of the
  // valley reachable at all.
  const cam = new Camera(120, 120);
  cam.setViewport(400, 600);
  cam.setInset({ top: 52, bottom: 106 });

  cam.centerOnTile(60, 0);
  cam.panBy(0, 9999);                       // shove upward as far as it goes
  assertEqual(Math.round(cam.y), Math.round(-52 / cam.zoom), 'stops one bar past the top');

  cam.centerOnTile(60, 119);
  cam.panBy(0, -9999);
  const floor = 120 * TILE - 600 / cam.zoom + 106 / cam.zoom;
  assertEqual(Math.round(cam.y), Math.round(floor), 'and one bar past the bottom');

  // Sideways, where nothing covers the map, it still stops at the edge.
  cam.panBy(9999, 0);
  assertEqual(cam.x, 0, 'no overscroll where there is no bar');
});

test('overscroll is measured in screen pixels, not world ones', () => {
  // A bar covers the same amount of *screen* however far the map is zoomed in,
  // so the allowance has to shrink in world terms as the zoom grows.
  const far = new Camera(120, 120);
  far.setViewport(400, 600);
  far.setInset({ top: 60 });
  far.zoom = 1;
  far.centerOnTile(60, 0);
  far.panBy(0, 9999);
  const atOne = far.y;

  far.zoom = 3;
  far.centerOnTile(60, 0);
  far.panBy(0, 9999);
  assert(far.y > atOne, 'zoomed in, the same bar is fewer world pixels');
  assertEqual(Math.round(far.y * 3), Math.round(atOne), 'and exactly proportionally so');
});

// --- flowers ------------------------------------------------------------

test('the sheet is still drawn in the three greys the genome replaces', () => {
  // The whole feature rests on flowers.png being greyscale in exactly these
  // three values. If the art is redrawn with 254 instead of 255, every flower
  // silently stops taking colour and nothing else here would notice.
  const sheet = decodePng('assets/flora/flowers.png');
  assertEqual(sheet.height, TILE, 'one row');
  assertEqual(sheet.width / TILE, FLOWER_KINDS.length, 'one sprite per kind');

  const seen = new Set();
  for (let i = 0; i < sheet.rgba.length; i += 4) {
    if (sheet.rgba[i + 3] === 0) continue;
    seen.add(`${sheet.rgba[i]},${sheet.rgba[i + 1]},${sheet.rgba[i + 2]}`);
  }
  for (const key of KEYS) {
    assert(seen.has(key.join(',')), `the sheet still uses ${key.join(',')}`);
  }
});

test('a genome survives the round trip through a seed id', () => {
  // The id *is* the storage: a seed carries its colour in its own name so the
  // inventory can stay a flat map of counts. If that trip is lossy, a player's
  // seeds quietly turn into different flowers.
  for (const genome of [makeGenome(0), makeGenome(137), makeGenome(200, 90, true), makeGenome(359, 15)]) {
    const id = flowerSeedId('daisy', genome);
    const read = readSeedId(id);
    assertEqual(read.kind, 'daisy', 'the kind comes back');
    assertEqual(read.genome, genome, `${id} comes back unchanged`);
  }
  assertEqual(readSeedId('carrot_seed'), null, 'and it ignores ordinary seeds');
});

test('seeds of the same colour stack, and near-misses do not', () => {
  const a = flowerSeedId('poppy', makeGenome(120));
  const b = flowerSeedId('poppy', makeGenome(120));
  const c = flowerSeedId('poppy', makeGenome(135));
  assertEqual(a, b, 'the same flower gives the same id');
  assert(a !== c, 'a different hue gives a different one');
  assert(flowerSeedId('daisy', makeGenome(120)) !== a, 'and so does a different kind');
});

test('wild flowers only ever come in the two dozen wild colours', () => {
  // Everything between them is what breeding is for. A wild roll that landed
  // anywhere on the wheel would hand the player the whole collection for free.
  const s = { rng: makeRng(31337) };
  const hues = new Set();
  for (let i = 0; i < 600; i++) {
    const g = rollWildGenome(s.rng);
    assertEqual(new Set(g.hues).size, 1, 'a wild flower is all one colour');
    hues.add(petalHue(g));
  }
  assertEqual(hues.size, WILD_HUES, 'exactly the ring, no more');
  for (const hue of hues) assertEqual(hue % HUE_STEP, 0, `${hue} sits on the ring`);
});

test('picking a flower gives its seeds and remembers the colour', () => {
  const s = weedableFarm(9401);
  const genome = makeGenome(210);
  plantFlower(s, s.farmer.x + 1, s.farmer.y, 'peony', genome);

  const gained = pickFlower(s, s.farmer.x + 1, s.farmer.y);
  const id = flowerSeedId('peony', genome);
  assert(gained[id] > 0, 'seeds of that exact flower');
  assertEqual(countItem(s, id), gained[id], 'and they went in the bag');
  assertEqual(flowerAt(s, s.farmer.x + 1, s.farmer.y), null, 'the flower is gone');
  assertEqual(s.grid.getObject(s.farmer.x + 1, s.farmer.y), OBJ.NONE, 'and so is its tile marker');

  assertEqual(pickedCount(s, 'peony'), 1, 'the journal counted it');
  assert(hasFound(s, 'peony', 210), 'and remembers that colour');
  assert(!hasFound(s, 'peony', 30), 'but not one never seen');
  assert(!hasFound(s, 'daisy', 210), 'nor the same colour of another kind');
});

test('the flower itself never goes in the bag', () => {
  // Flowers do not sell and are not carried. What you take away is seeds and
  // the memory of having seen it.
  const s = weedableFarm(9402);
  plantFlower(s, s.farmer.x + 1, s.farmer.y, 'crocus', makeGenome(60));
  const gained = pickFlower(s, s.farmer.x + 1, s.farmer.y);
  for (const id of Object.keys(gained)) {
    assert(isFlowerSeed(id), `${id} should be seeds, not a flower`);
  }
  assertEqual(countItem(s, 'crocus'), 0, 'no flower item exists to hold');
});

test('flowers grow only on open ground you own, and stop at a cap', () => {
  const s = weedableFarm(9403);
  const x = s.farmer.x + 3;
  const y = s.farmer.y + 3;
  assert(canBloom(s, x, y), 'open owned grass will do');

  s.grid.setObject(x, y, OBJ.ROCK);
  assert(!canBloom(s, x, y), 'not where something is standing');
  s.grid.setObject(x, y, OBJ.NONE);

  s.grid.setGround(x, y, GROUND.TILLED);
  assert(!canBloom(s, x, y), 'not in a bed');
  s.grid.setGround(x, y, GROUND.GRASS);

  // Run long enough that the cap, not the clock, is what stops it.
  for (let i = 0; i < FLOWER_INTERVAL * 400; i++) tick(s);
  const owned = s.grid.owned.size * PLOT * PLOT;
  assert(Object.keys(s.flowers).length <= Math.max(1, Math.floor(owned * FLOWER_MAX_FRACTION)),
    'a week away cannot carpet the farm');
  assert(Object.keys(s.flowers).length > 0, 'but some did grow');
});

test('flowers and their journal survive a save round trip', () => {
  const s = weedableFarm(9404);
  plantFlower(s, s.farmer.x + 1, s.farmer.y, 'phlox', makeGenome(300, 85, true));
  pickFlower(s, s.farmer.x + 1, s.farmer.y);
  plantFlower(s, s.farmer.x + 2, s.farmer.y, 'bluebell', makeGenome(45));

  const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));
  const still = flowerAt(back, s.farmer.x + 2, s.farmer.y);
  assertEqual(still.kind, 'bluebell', 'the flower is still standing');
  assertEqual(still.genome, makeGenome(45), 'with its colour intact');
  assertEqual(pickedCount(back, 'phlox'), 1, 'and the journal came too');
  assert(hasFound(back, 'phlox', 300), 'colour and all');
});

test('the seed drawer is grouped by flower, and sorted round the wheel', () => {
  const s = weedableFarm(9405);
  s.inventory = {
    wood: 20,
    [flowerSeedId('daisy', makeGenome(200))]: 3,
    [flowerSeedId('daisy', makeGenome(40))]: 1,
    [flowerSeedId('poppy', makeGenome(90))]: 5,
  };
  const groups = seedGroups(s);
  assertEqual(groups.map((g) => g.kind), ['daisy', 'poppy'], 'a group per flower, in sheet order');
  assertEqual(groups[0].seeds.map((x) => petalHue(x.genome)), [40, 200], 'sorted by colour within it');
  assertEqual(groups[1].seeds[0].qty, 5, 'carrying the counts');
});

test('the farmer can plant on the square he is standing on', () => {
  // He walks onto the tile to plant it, so asking "is anyone standing here" at
  // the moment of planting is asking whether he exists. Sharing one rule with
  // wild growth made every single planting fail with "nowhere to plant it now".
  const s = weedableFarm(9406);
  const at = { x: s.farmer.x, y: s.farmer.y };
  s.grid.setObject(at.x, at.y, OBJ.NONE);
  s.grid.setGround(at.x, at.y, GROUND.GRASS);

  assert(!canBloom(s, at.x, at.y), 'nothing comes up wild under his boots');
  assert(canPlantAt(s, at.x, at.y), 'but he may put one there himself');
});

test('planting a saved colour puts that exact flower back', () => {
  const s = weedableFarm(9407);
  const genome = makeGenome(285);
  const id = flowerSeedId('crocus', genome);
  s.inventory = { [id]: 2 };

  const at = { x: s.farmer.x + 2, y: s.farmer.y };
  s.grid.setObject(at.x, at.y, OBJ.NONE);
  addTask(s, taskForTile(s, at.x, at.y, 'plantflower', { seedId: id }));
  for (let i = 0; i < 900 && s.tasks.length; i++) tick(s);

  const grown = flowerAt(s, at.x, at.y);
  assertEqual(grown.kind, 'crocus', 'the right flower');
  assertEqual(grown.genome, genome, 'in the colour those seeds held');
  assertEqual(countItem(s, id), 1, 'and one seed was spent');
  assertEqual(s.grid.getObject(at.x, at.y), OBJ.FLOWER, 'the tile says so too');
});

test('a queued planting costs nothing if it is cancelled', () => {
  // The same promise planting a crop makes: the seed leaves the bag when it
  // goes in the ground, not when the job is ordered.
  const s = weedableFarm(9408);
  const id = flowerSeedId('daisy', makeGenome(15));
  s.inventory = { [id]: 1 };
  const at = { x: s.farmer.x + 2, y: s.farmer.y };
  s.grid.setObject(at.x, at.y, OBJ.NONE);

  const task = addTask(s, taskForTile(s, at.x, at.y, 'plantflower', { seedId: id }));
  assertEqual(countItem(s, id), 1, 'still in the bag while it waits');
  cancelTask(s, task.id);
  assertEqual(countItem(s, id), 1, 'and still there afterwards');
});

test('a flower record with no tile behind it is swept up on load', () => {
  // The tile marker is what the world draws and what a tap finds, so a record
  // without one is invisible and unreachable — but it would still hold its
  // square against planting and count against the spawn cap.
  const s = weedableFarm(9409);
  const at = { x: s.farmer.x + 1, y: s.farmer.y };
  s.grid.setGround(at.x, at.y, GROUND.GRASS);
  s.grid.setObject(at.x, at.y, OBJ.NONE);
  plantFlower(s, at.x, at.y, 'peony', makeGenome(100));
  s.grid.setObject(at.x, at.y, OBJ.NONE);   // however it happened

  const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));
  assertEqual(flowerAt(back, at.x, at.y), null, 'the ghost is gone');
  assert(canPlantAt(back, at.x, at.y), 'and the square is free again');
});

test('a child takes the short way round the colour wheel', () => {
  // The whole reason hue is an angle. As plain numbers, 350 and 10 average to
  // 180 — the exact opposite colour — where anybody looking at two red flowers
  // expects red.
  const rng = makeRng(11);
  assertEqual(blendHue(350, 10, rng), 0, 'red and red make red');
  assertEqual(blendHue(0, 90, rng), 45, 'and the ordinary case still works');
  assertEqual(blendHue(300, 60, rng), 0, 'wrapping through zero');

  // Directly opposite parents have no halfway: it takes after one of them.
  const opposite = blendHue(0, 180, rng);
  assert(opposite === 0 || opposite === 180, 'rather than landing somewhere arbitrary');
});

test('two flowers of a kind raise a third that takes after both', () => {
  const s = weedableFarm(9410);
  const at = { x: s.farmer.x + 3, y: s.farmer.y + 3 };
  for (let dy = -1; dy <= 2; dy++) {
    for (let dx = -1; dx <= 2; dx++) {
      s.grid.setGround(at.x + dx, at.y + dy, GROUND.GRASS);
      s.grid.setObject(at.x + dx, at.y + dy, OBJ.NONE);
    }
  }
  plantFlower(s, at.x, at.y, 'poppy', makeGenome(30));
  plantFlower(s, at.x + 1, at.y, 'poppy', makeGenome(90));
  waterFlower(s, at.x, at.y);

  let child = null;
  for (let i = 0; i < 200 && !child; i++) child = breedAt(s, at.x, at.y);
  assert(child, 'a cross eventually took');
  assertEqual(child.kind, 'poppy', 'of their own kind');
  // Either blended to somewhere between them, or inherited from one outright —
  // both are crossings, and both stay within the span of the parents.
  assert(petalHue(child.genome) >= 30 && petalHue(child.genome) <= 90,
    `its colour comes from its parents (got ${petalHue(child.genome)})`);
});

test('a dry bed is a bed left alone', () => {
  // Watering is the whole of the player's control over breeding. A bed they
  // like exactly as it is has to stay exactly as it is, and stopping should be
  // as easy as not doing something.
  const s = weedableFarm(9414);
  const at = { x: s.farmer.x + 3, y: s.farmer.y + 3 };
  for (let dy = -1; dy <= 2; dy++) {
    for (let dx = -1; dx <= 2; dx++) {
      s.grid.setGround(at.x + dx, at.y + dy, GROUND.GRASS);
      s.grid.setObject(at.x + dx, at.y + dy, OBJ.NONE);
    }
  }
  plantFlower(s, at.x, at.y, 'bluebell', makeGenome(30));
  plantFlower(s, at.x + 1, at.y, 'bluebell', makeGenome(90));

  for (let i = 0; i < 200; i++) assertEqual(breedAt(s, at.x, at.y), null, 'dry flowers keep to themselves');

  waterFlower(s, at.x, at.y);
  assert(isWatered(s, at.x, at.y), 'watering takes');
  let child = null;
  for (let i = 0; i < 200 && !child; i++) child = breedAt(s, at.x, at.y);
  assert(child, 'and now it will cross');
});

test('a watering outlasts the gap between breeding attempts', () => {
  // Set to the time soil takes to dry at first, which sounded right and was
  // not: soil dries faster than breeding is attempted, so a watering wore off
  // before a single attempt was made and the can appeared to do nothing.
  assert(FLOWER_WET_TICKS > BREED_INTERVAL * 2,
    'a watering must buy several attempts, or the control is a coin toss');
});

test('a watering wears off, and the bed goes quiet again', () => {
  const s = weedableFarm(9415);
  const at = { x: s.farmer.x + 3, y: s.farmer.y + 3 };
  for (let dy = -1; dy <= 2; dy++) {
    for (let dx = -1; dx <= 2; dx++) {
      s.grid.setGround(at.x + dx, at.y + dy, GROUND.GRASS);
      s.grid.setObject(at.x + dx, at.y + dy, OBJ.NONE);
    }
  }
  plantFlower(s, at.x, at.y, 'phlox', makeGenome(30));
  plantFlower(s, at.x + 1, at.y, 'phlox', makeGenome(90));
  waterFlower(s, at.x, at.y);

  s.tickCount += FLOWER_WET_TICKS + 1;
  assert(!isWatered(s, at.x, at.y), 'it has dried out');
  for (let i = 0; i < 200; i++) assertEqual(breedAt(s, at.x, at.y), null, 'and stopped crossing');
});

test('the harvest tool gathers mushrooms as well as crops', () => {
  // A mushroom is gathered rather than grown, but it is still something you
  // reach out and take. Clearing the tile still works, as it always has.
  const s = weedableFarm(9418);
  const at = { x: s.farmer.x + 2, y: s.farmer.y };
  s.grid.setGround(at.x, at.y, GROUND.GRASS);
  s.grid.setObject(at.x, at.y, OBJ.NONE);
  sprout(s, at.x, at.y, 'red_toadstool');

  const picked = taskForTile(s, at.x, at.y, 'harvest');
  assert(picked, 'the harvest tool offers itself on a mushroom');
  assertEqual(picked.type, 'forage', 'as a foraging job');
  assertEqual(picked.detail, 'Red toadstool', 'and says which one');
  assertEqual(taskForTile(s, at.x, at.y, 'clear').type, 'forage', 'clearing still picks it too');

  addTask(s, picked);
  for (let i = 0; i < 600 && s.tasks.length; i++) tick(s);
  assertEqual(mushroomAt(s, at.x, at.y), null, 'the farmer picked it');
  assert(countItem(s, SPECIES.toadstool.item) > 0, 'and it went in the bag');
});

test('a tap waters a flower; picking it takes the harvest tool', () => {
  // Watering is what a player does to the same bed again and again, so it
  // belongs on the tool already in their hand. Picking is the thing they do
  // once and cannot undo, and a tap is far too easy to make by accident to be
  // allowed to destroy a colour that took a week to breed.
  const s = weedableFarm(9417);
  const at = { x: s.farmer.x + 2, y: s.farmer.y };
  s.grid.setGround(at.x, at.y, GROUND.GRASS);
  s.grid.setObject(at.x, at.y, OBJ.NONE);
  plantFlower(s, at.x, at.y, 'daisy', makeGenome(0));

  assertEqual(taskForTile(s, at.x, at.y, 'auto').type, 'water', 'a plain tap waters it');
  assertEqual(taskForTile(s, at.x, at.y, 'harvest').type, 'pick', 'harvest picks it');
  assertEqual(taskForTile(s, at.x, at.y, 'clear').type, 'pick', 'and so does clearing the tile');
});

test('watering a flower is work the farmer does', () => {
  const s = weedableFarm(9416);
  const at = { x: s.farmer.x + 2, y: s.farmer.y };
  s.grid.setGround(at.x, at.y, GROUND.GRASS);
  s.grid.setObject(at.x, at.y, OBJ.NONE);
  plantFlower(s, at.x, at.y, 'crocus', makeGenome(180));

  const spec = taskForTile(s, at.x, at.y, 'water');
  assert(spec, 'the water tool offers itself on a flower');
  assertEqual(spec.detail, 'Teal crocus', 'and says which one');

  addTask(s, spec);
  for (let i = 0; i < 600 && s.tasks.length; i++) tick(s);
  assert(isWatered(s, at.x, at.y), 'the farmer watered it');
});

test('only flowers of the same kind will cross', () => {
  const s = weedableFarm(9411);
  const at = { x: s.farmer.x + 3, y: s.farmer.y + 3 };
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 2; dx++) {
      s.grid.setGround(at.x + dx, at.y + dy, GROUND.GRASS);
      s.grid.setObject(at.x + dx, at.y + dy, OBJ.NONE);
    }
  }
  plantFlower(s, at.x, at.y, 'poppy', makeGenome(30));
  plantFlower(s, at.x + 1, at.y, 'daisy', makeGenome(90));
  waterFlower(s, at.x, at.y);

  for (let i = 0; i < 200; i++) assertEqual(breedAt(s, at.x, at.y), null, 'a poppy and a daisy do not');
});

test('breeding needs somewhere to put the child, and stops at a ceiling', () => {
  const s = weedableFarm(9412);
  const at = { x: s.farmer.x + 3, y: s.farmer.y + 3 };
  // Two parents boxed in by rocks: nowhere for a child to go.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 2; dx++) {
      s.grid.setGround(at.x + dx, at.y + dy, GROUND.GRASS);
      s.grid.setObject(at.x + dx, at.y + dy, OBJ.ROCK);
    }
  }
  s.grid.setObject(at.x, at.y, OBJ.NONE);
  s.grid.setObject(at.x + 1, at.y, OBJ.NONE);
  plantFlower(s, at.x, at.y, 'peony', makeGenome(30));
  plantFlower(s, at.x + 1, at.y, 'peony', makeGenome(90));
  waterFlower(s, at.x, at.y);
  assertEqual(breedAt(s, at.x, at.y), null, 'no bare ground, no child');

  // And the ceiling holds however long a farm is left alone.
  const roomy = weedableFarm(9413);
  for (let i = 0; i < BREED_INTERVAL * 2000; i++) tick(roomy);
  assert(Object.keys(roomy.flowers).length <= totalCap(roomy),
    'a fortnight away cannot bury the farm');
});

test('the recolour cache does not grow without end', () => {
  // Breeding invents colours that have never existed before, so a long session
  // meets a great many of them. A cache that only ever grows is a slow leak
  // however small the entries are.
  for (let hue = 0; hue < CACHE_LIMIT + 80; hue++) {
    flowerCanvas('daisy', makeGenome(hue % 360, 40 + (hue % 60)));
  }
  assert(cacheSize() <= CACHE_LIMIT, `kept ${cacheSize()}, which is over the limit`);
});

test('a child is sometimes blended and sometimes inherited', () => {
  // Both routes are needed, for opposite reasons. Blending finds colours that
  // neither parent had; inheriting keeps the ones they did. Blending alone
  // converges — every generation pulls toward the average, and a bed left
  // crossing long enough goes quietly uniform.
  const rng = makeRng(4242);
  const mum = makeGenome(0, 70);
  const dad = makeGenome(120, 95);

  let inherited = 0;
  let blended = 0;
  for (let i = 0; i < 400; i++) {
    const child = crossGenomes(mum, dad, rng);
    const hueFromParent = child.hue === mum.hue || child.hue === dad.hue;
    const satFromParent = child.sat === mum.sat || child.sat === dad.sat;
    if (hueFromParent && satFromParent) inherited++;
    else blended++;
  }
  assert(inherited > 40, `some children take after a parent outright (got ${inherited})`);
  assert(blended > 40, `and some are a mix of the two (got ${blended})`);
});

test('an inherited gene is copied faithfully', () => {
  // The point of inheriting is that a colour worth having survives another
  // generation intact. A mutation on this path would average it away slowly
  // instead of quickly.
  const rng = makeRng(77);
  const mum = makeGenome(30, 60);
  const dad = makeGenome(210, 90);
  for (let i = 0; i < 400; i++) {
    const child = crossGenomes(mum, dad, rng);
    if (child.hue !== mum.hue && child.hue !== dad.hue) continue;   // a blend
    if (child.sat !== mum.sat && child.sat !== dad.sat) continue;
    assert([mum.hue, dad.hue].includes(child.hue), 'the hue is exactly one parent\u2019s');
    assert([mum.sat, dad.sat].includes(child.sat), 'and so is the strength');
  }
});

test('a bed keeps its extremes instead of going muddy', () => {
  // Measured rather than argued. A bed of red, green and blue is filled in by
  // crossing; with blending alone the colours crowd toward the middle, and the
  // striking ones that went in are gone.
  const spread = (hues) => {
    const x = hues.reduce((n, h) => n + Math.cos((h * Math.PI) / 180), 0) / hues.length;
    const y = hues.reduce((n, h) => n + Math.sin((h * Math.PI) / 180), 0) / hues.length;
    return 1 - Math.hypot(x, y);
  };
  const grow = (rng) => {
    const bed = [makeGenome(0), makeGenome(120), makeGenome(240)];
    while (bed.length < 40) {
      bed.push(crossGenomes(bed[rng.int(bed.length)], bed[rng.int(bed.length)], rng));
    }
    return bed.map(petalHue);
  };

  let total = 0;
  const seeds = [1, 2, 3, 4, 5, 6];
  for (const seed of seeds) total += spread(grow(makeRng(seed)));
  const average = total / seeds.length;
  assert(average > 0.5, `the bed stayed colourful (spread ${average.toFixed(2)})`);
});

test('flowers saved by the one-hue build still open', () => {
  // The single-hue version shipped before the genome became three genes, so
  // there are saves in the wild carrying the old shape — and the new code does
  // not degrade on it, it throws. Both the flowers in the ground and the seeds
  // in the bag have to be rewritten to the flower they always looked like.
  const before = {
    version: 8,
    flowers: {
      '10,10': { kind: 'daisy', hue: 120, sat: 70, split: false },
      '11,10': { kind: 'poppy', hue: 200, sat: 85, split: true },
    },
    inventory: {
      wood: 5,
      flowerseed_daisy_h120: 3,
      flowerseed_poppy_h200s85t: 2,
    },
  };

  const after = migrate(before);
  assertEqual(after.version, SAVE_VERSION, 'brought up to date');

  assertEqual(after.flowers['10,10'].hues, [120, 120, 120], 'a plain flower stays plain');
  assertEqual(after.flowers['10,10'].hue, undefined, 'and loses the old field');
  // The old `split` swung the middle tone 35 degrees; the flower has to keep
  // looking like itself.
  assertEqual(after.flowers['11,10'].hues, [200, 235, 200], 'a two-tone one keeps both tones');

  assertEqual(after.inventory.flowerseed_daisy_h120, 3, 'a plain seed id still works as it was');
  assertEqual(after.inventory['flowerseed_poppy_h200-235-200s85'], 2, 'a two-tone seed is rewritten');
  assertEqual(after.inventory.flowerseed_poppy_h200s85t, undefined, 'and the old id is gone');
  assertEqual(after.inventory.wood, 5, 'everything else is untouched');
});

test('two old seed ids that become one keep their seeds', () => {
  // The old code left the saturation off when it was the default, so the same
  // flower could be written either way. Both land on one id now, and the
  // player should not lose a packet to the tidying up.
  const before = {
    version: 8,
    flowers: {},
    inventory: { flowerseed_daisy_h120t: 2, flowerseed_daisy_h120s70t: 3 },
  };
  const after = migrate(before);
  assertEqual(after.inventory['flowerseed_daisy_h120-155-120'], 5,
    'the counts are added, not overwritten');
});

test('a bred colour says so, and a wild one does not', () => {
  // A crossed colour is the one thing in the bag that cannot be found again by
  // walking around: lose the seeds and it is gone. It should not look like the
  // wild ones in a list of packets.
  const wild = makeGenome(HUE_STEP * 3);
  assert(!isCross(wild), 'straight off the wild ring');
  assertEqual(seedName(flowerSeedId('daisy', wild)), 'Amber daisy seeds', 'named plainly');

  for (const bred of [makeGenome(23), makeGenome(45, 90), makeGenome([45, 120, 45])]) {
    assert(isCross(bred), `${JSON.stringify(bred)} came from parents`);
    assert(seedName(flowerSeedId('daisy', bred)).startsWith('Crossed '), 'and says so');
  }

  // One capital, at the front, wherever the words came from.
  assertEqual(seedName(flowerSeedId('bird', makeGenome(23))),
    'Crossed orange bird of paradise seeds', 'no stray capitals mid-sentence');
});

test('a wild flower is one colour in three shades', () => {
  const [light, mid, dark] = palette(makeGenome(0));
  assert(light[0] > mid[0] && mid[0] > dark[0], 'light to dark');
  for (const tone of [light, mid, dark]) {
    assert(tone[0] > tone[1] && tone[0] > tone[2], 'and all of them red');
  }
});

test('each of the three tones is its own gene', () => {
  // The sheet gives three colours to replace, and a gene apiece is what makes
  // crossing worth doing: a child can take its petals from one parent and its
  // shadow from the other.
  const three = palette(makeGenome([0, 120, 240]));
  assert(three[0][0] > three[0][1], 'petals red');
  assert(three[1][1] > three[1][0], 'middle green');
  assert(three[2][2] > three[2][0], 'shadow blue');

  // The lightnesses are not inherited, so no cross can come out flat or with
  // its shadow brighter than its face.
  const bright = (c) => c[0] + c[1] + c[2];
  assert(bright(three[0]) > bright(three[1]) && bright(three[1]) > bright(three[2]),
    'still lit face, middle and shadow whatever the hues');
});

// --- the market ---------------------------------------------------------

/** Sells `perDay` worth of each good, in dribbles, for a number of days. */
function trade(s, days, perDay) {
  for (let t = 0; t < days * TICKS_PER_DAY; t++) {
    s.tickCount++;
    if (s.tickCount % 600 === 0) {
      for (const [id, value] of Object.entries(perDay)) recordSale(s, id, 1, value / 144);
    }
    updateMarket(s);
  }
}

/** What the player actually realises on a given sales mix, as a multiplier. */
function realised(s, mix) {
  let earned = 0;
  let base = 0;
  for (const [id, value] of Object.entries(mix)) {
    earned += value * priceMultiplier(s, id);
    base += value;
  }
  return earned / base;
}

function marketFarm(seed = 900) {
  return { tickCount: 0, rng: makeRng(seed), market: newMarket() };
}

/**
 * What a sales mix realises, averaged over several weeks.
 *
 * Averaged on purpose. Whether the town happens to want eggplant this week
 * swings a single run a long way, and that swing *is* the feature — a farmer
 * who catches a good week should do well out of it. What has to hold underneath
 * is the gradient: growing several things beats growing one.
 */
function overSeeds(mix, days = 4) {
  const seeds = [1, 7, 42, 99, 900];
  return seeds.reduce((sum, seed) => {
    const s = marketFarm(seed);
    trade(s, days, mix);
    return sum + realised(s, mix);
  }, 0) / seeds.length;
}

test('a farm that has sold nothing sees ordinary prices', () => {
  // The market opens balanced. Anything else would hand an established farm a
  // windfall or a pay cut for a day's play it had already done.
  const s = marketFarm();
  for (const id of TRADED) {
    assertEqual(priceOf(s, id), basePrice(id), `${id} starts at its usual price`);
  }
});

test('the price curve bottoms out only under a real monoculture', () => {
  assertEqual(multiplierFor(1), 1, 'selling a normal share is full price');
  assertEqual(multiplierFor(0), PRICE_CEILING, 'bringing none of it pays the most');
  assertEqual(multiplierFor(GLUT_RATIO), PRICE_FLOOR, 'and the floor needs a glut');
  assert(multiplierFor(2) > 0.85, 'twice your usual share is barely marked down');
  assertEqual(multiplierFor(GLUT_RATIO * 4), PRICE_FLOOR, 'nothing goes below the floor');
});

test('selling one thing and nothing else drives its price down', () => {
  const paid = overSeeds({ eggplant: 50000 });
  assert(paid < 0.8, `a monoculture averages x${paid.toFixed(2)} of full price`);

  const s = marketFarm();
  trade(s, 4, { eggplant: 50000 });
  assertEqual(priceOf(s, 'eggplant'),
    Math.round(basePrice('eggplant') * priceMultiplier(s, 'eggplant')),
    'and the price follows the multiplier');
});

test('what nobody is bringing is worth more than what you are flooding', () => {
  const s = marketFarm();
  trade(s, 4, { eggplant: 50000 });
  const flooded = priceMultiplier(s, 'eggplant');
  const others = TRADED.filter((id) => id !== 'eggplant').map((id) => priceMultiplier(s, id));
  assert(Math.max(...others) > flooded + 0.4, 'with a gap worth switching a few plots over');
});

test('the town has opinions about what it wants, not just what it has', () => {
  // Demand has to reach the price of things you are *not* selling, or the panel
  // has nothing to say: dividing by a drifting number cancels the drift, and
  // every good you did not grow came out at an identical price.
  const s = marketFarm(31);
  trade(s, 6, { eggplant: 50000 });
  const untraded = TRADED.filter((id) => id !== 'eggplant').map((id) => priceMultiplier(s, id));
  const spread = Math.max(...untraded) - Math.min(...untraded);
  assert(spread > 0.15, `the goods she is not selling differ by ${spread.toFixed(2)}`);
});

test('a varied farm is paid close to full price', () => {
  // The point of the whole feature: the gradient between growing one thing and
  // growing several has to be worth the trouble of switching.
  const mono = { eggplant: 50000 };
  const four = { eggplant: 25000, cabbage: 12000, milk: 8000, egg: 5000 };
  const seven = {
    eggplant: 20000, cabbage: 8000, tomato: 6000, corn: 5000,
    milk: 6000, egg: 3000, wool: 2000,
  };

  const over = overSeeds;

  const one = over(mono);
  const some = over(four);
  const many = over(seven);
  assert(one < 0.8, `one crop earns ${one.toFixed(2)} of full price`);
  assert(some > one + 0.1, `four goods earn more (${some.toFixed(2)} against ${one.toFixed(2)})`);
  assert(many > some, `and seven more still (${many.toFixed(2)})`);
  assert(many > 0.95, `a varied farm is paid near full price (${many.toFixed(2)})`);
});

test('a beginner selling their first crops is left alone', () => {
  // The early game has no choice: carrots and wheat are what you can afford.
  // Pricing that as a monoculture would punish a player for being new.
  const paid = overSeeds({ carrot: 150, wheat: 120 });
  assert(paid > 0.9, `a beginner is paid x${paid.toFixed(2)}, near enough full price`);
});

test('a glut clears if you stop flooding it', () => {
  // Measured on the glut alone, with the town's changing appetite held out of
  // it — otherwise this is testing the weather rather than the mechanism.
  const s = marketFarm();
  trade(s, 4, { eggplant: 50000 });
  const glutted = glutRatio(s.market, 'eggplant');
  assert(glutted > 2, 'the town is holding a lot of it to begin with');

  trade(s, 4, { cabbage: 20000 });          // sell something else for a while
  assert(glutRatio(s.market, 'eggplant') < glutted / 2,
    'and works through it once she stops bringing more');
});

test('the market is deterministic, so catching up twice agrees', () => {
  // Same rule as weeds and mushrooms: state.rng only, driven by tickCount.
  // Two farms replaying the same days must arrive at the same prices.
  const a = marketFarm(4321);
  const b = marketFarm(4321);
  trade(a, 5, { corn: 3000, milk: 2000 });
  trade(b, 5, { corn: 3000, milk: 2000 });
  assertEqual(a.market.demand, b.market.demand, 'demand drifted identically');
  assertEqual(TRADED.map((id) => priceOf(a, id)), TRADED.map((id) => priceOf(b, id)),
    'and the prices match');
});

test('demand drifts rather than being redrawn', () => {
  // Drift is what gives the market panel something to show: a good climbing two
  // days running is a trend you can act on, where a fresh roll every twelve
  // hours would be noise you could only react to.
  const s = marketFarm(77);
  const before = { ...s.market.demand };
  trade(s, 1, {});
  let moved = 0;
  for (const id of TRADED) {
    const change = Math.abs(s.market.demand[id] - before[id]) / before[id];
    assert(change < 0.8, `${id} moved by ${(change * 100).toFixed(0)}% in a day, which is a jump`);
    if (change > 0.01) moved++;
  }
  assert(moved >= TRADED.length - 1, 'but everything did move');
});

test('selling records against the market, and only for traded goods', () => {
  const s = farmWithMaterials(902);
  s.inventory = { eggplant: 10, wood: 50 };

  sell(s, 'eggplant', 10);
  assert(s.market.supply.eggplant > 0, 'the town now holds the eggplants');

  sell(s, 'wood', 50);
  assertEqual(s.market.supply.wood, undefined, 'but building materials are not traded');
});

test('an old save opens on a balanced market', () => {
  const old = { version: 6, buildings: [], tasks: [] };
  const out = migrate(old);
  assertEqual(out.version, SAVE_VERSION, 'brought up to date');
  assert(out.market && out.market.demand.eggplant > 0, 'and given a market to trade on');
});

// --- barns the player sizes ---------------------------------------------

test('the smallest barn costs exactly what a barn has always cost', () => {
  // The balance is settled and well liked; making barns sizable is not a
  // licence to reprice the one everybody already has.
  assertEqual(barnCost(3, 2), { wood: 50, stone: 20 }, 'unchanged');
  assertEqual(barnWork(3, 2), 120, 'and takes as long as it always did');
  assertEqual(barnCapacity(3, 2), 4, 'and holds four');
});

test('a bigger barn costs more, but less per tile', () => {
  const small = barnCost(3, 2), big = barnCost(9, 4);
  assert(big.wood > small.wood, 'more wood outright');
  assert(big.wood / 36 < small.wood / 6, 'but cheaper by the tile');
  assertEqual(barnCapacity(9, 4), 24, 'and holds six times as many animals');
});

test('a barn quotes the price of the size actually drawn', () => {
  // The recipe's own cost is the smallest barn's. Everything that shows a
  // price has to ask for the size, or the player is told 50 wood and charged
  // three hundred.
  assertEqual(costLabel('barn'), '50 wood, 20 stone', 'the recipe quotes the smallest');
  assertEqual(costLabel('barn', [9, 5]), '206 wood, 98 stone', 'a big one quotes its own');
  assertEqual(costLabel('fence'), costLabel('fence', [1, 1]), 'fixed things are unaffected');
  assert(BUILDABLES.barn.sizable, 'and the barn is flagged as the one that varies');
});

test('a dragged rectangle snaps to a barn that can be built', () => {
  // Always downward: the barn fits inside what was drawn rather than spilling
  // past it, so the rectangle is a promise about the ground being spent.
  assertEqual(snapBarn(10, 10, 12, 11), { x: 10, y: 10, w: 3, h: 2 }, 'exact fit');
  assertEqual(snapBarn(10, 10, 13, 11), { x: 10, y: 10, w: 3, h: 2 }, 'even width rounds down');
  assertEqual(snapBarn(12, 11, 10, 10), { x: 10, y: 10, w: 3, h: 2 }, 'dragged backwards');
  assertEqual(snapBarn(0, 0, 40, 40), { x: 0, y: 0, w: 9, h: 5 }, 'clamped to the maximum');
  assertEqual(snapBarn(5, 5, 6, 6), null, 'too small to be a barn');
  assertEqual(snapBarn(5, 5, 9, 5), null, 'wide enough but only one row deep');
});

test('a sized barn keeps its size through building, saving and demolishing', () => {
  const s = farmWithMaterials(4242);
  const at = { x: s.farmer.x + 4, y: s.farmer.y };

  const task = addTask(s, taskForTile(s, at.x, at.y, 'build', {
    buildKind: 'barn', size: [7, 3],
  }));
  assertEqual([task.w, task.h], [7, 3], 'the task carries the footprint');
  assertEqual(reservedTiles(s).size, 21, 'and reserves all of it');
  assertEqual(task.work, barnWork(7, 3), 'and takes as long as its size says');

  for (let i = 0; i < 900; i++) tick(s);
  assertEqual(s.buildings.length, 1, 'the barn got built');
  const barn = s.buildings[0];
  assertEqual([barn.w, barn.h], [7, 3], 'the building remembers what was built');
  assertEqual(animalCapacity(s), barnCapacity(7, 3), 'capacity follows the size');

  const reloaded = deserialize(JSON.parse(JSON.stringify(serialize(s))));
  assertEqual([reloaded.buildings[0].w, reloaded.buildings[0].h], [7, 3], 'and survives a save');

  // Every tile of it answers as the same building, not just the anchor.
  assertEqual(buildingAt(s, barn.x + 6, barn.y + 2).id, barn.id, 'the far corner belongs to it');
  const found = structureAt(s, barn.x + 4, barn.y + 1);
  assertEqual([found.x, found.y], [barn.x, barn.y], 'and reports the anchor');

  const { ok, refund } = demolish(s, barn.x + 4, barn.y + 1);
  assert(ok, 'it comes down');
  assertEqual(refund, refundFor('barn', [7, 3]), 'refunded at its own size, not the recipe’s');
  assert(refund.wood > 25, 'which is more than a small barn would give back');
  assertEqual(buildingAt(s, barn.x, barn.y), null, 'and the whole footprint is clear');
});

test('an old save gets its barns stamped with the size they always had', () => {
  const old = { version: 5, buildings: [{ id: 1, type: 'barn', x: 10, y: 10 }],
    tasks: [{ type: 'build', buildKind: 'barn', x: 20, y: 20 }] };
  const out = migrate(old);
  assertEqual(out.version, SAVE_VERSION, 'brought up to date');
  assertEqual([out.buildings[0].w, out.buildings[0].h], [3, 2], 'the barn is 3x2, as it was');
  assertEqual([out.tasks[0].w, out.tasks[0].h], [3, 2], 'and so is one caught mid-build');
});

test('hands are hired against the animals housed, not the barn count', () => {
  const s = farmWithMaterials(4243);
  assertEqual(handCapacity(s), 0, 'nowhere to house anything, nobody to hire');

  placeStructure(s, 'barn', 5, 5, [3, 2]);
  assertEqual(handCapacity(s), 1, 'a 3x2 barn allows one hand, as it always did');

  placeStructure(s, 'barn', 5, 12, [9, 4]);
  assertEqual(handCapacity(s), 1 + Math.floor(barnCapacity(9, 4) / 4),
    'a big barn brings the hands to work it');
});

test('barns set animal capacity, and only finished ones count', () => {
  const s = farmWithMaterials(703);
  assertEqual(animalCapacity(s), 0, 'no barn, no animals');

  addTask(s, taskForTile(s, 5, 5, 'build', { buildKind: 'barn' }));
  assertEqual(animalCapacity(s), 0, 'a queued barn houses nothing yet');

  for (let i = 0; i < 600; i++) tick(s);
  assertEqual(animalCapacity(s), BARN_CAPACITY, 'one finished barn holds its share');

  completeBuild(s, { buildKind: 'barn', x: 10, y: 10 });
  assertEqual(animalCapacity(s), BARN_CAPACITY * 2, 'capacity is the sum over barns');
});

test('the farmer builds a barn, spending both materials', () => {
  const s = farmWithMaterials(704);
  s.inventory = { wood: 60, stone: 25 };

  addTask(s, taskForTile(s, s.farmer.x + 3, s.farmer.y, 'build', { buildKind: 'barn' }));
  for (let i = 0; i < 900; i++) tick(s);

  assertEqual(s.buildings.length, 1, 'the barn got built');
  assertEqual(s.inventory.wood, 10, '50 wood spent');
  assertEqual(s.inventory.stone, 5, '20 stone spent');
});

test('demolishing a barn clears every tile and refunds half of both materials', () => {
  const s = farmWithMaterials(705);
  completeBuild(s, { buildKind: 'barn', x: 5, y: 5 });

  const res = demolish(s, 6, 6);   // tapped a middle tile, not the anchor
  assert(res.ok, 'demolition should succeed from any footprint tile');
  assertEqual(res.refund, { wood: 25, stone: 10 }, 'half of both materials');
  assertEqual(s.buildings.length, 0, 'the record is gone');

  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      assertEqual(s.grid.getObject(5 + dx, 5 + dy), OBJ.NONE, `tile ${dx},${dy} freed`);
    }
  }
  assertEqual(animalCapacity(s), 0, 'and the capacity goes with it');
});

test('barns survive a save and reload, marks and all', () => {
  const s = farmWithMaterials(706);
  completeBuild(s, { buildKind: 'barn', x: 5, y: 5 });

  const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));
  assertEqual(back.buildings, s.buildings, 'the records persist');
  assertEqual(back.grid.getObject(7, 6), OBJ.BUILDING, 'and so do the footprint marks');
  assertEqual(animalCapacity(back), BARN_CAPACITY, 'capacity survives too');
});

test('two barns cannot overlap', () => {
  const s = farmWithMaterials(707);
  completeBuild(s, { buildKind: 'barn', x: 5, y: 5 });
  assert(!canPlaceAt(s, 'barn', 6, 5), 'overlapping placement is refused');
  assert(!canPlaceAt(s, 'barn', 4, 6), 'even by a single tile');
  assert(canPlaceAt(s, 'barn', 9, 5), 'clear of it is fine');
});

// --- demolition ---------------------------------------------------------

test('everything the player can build can also be taken down', () => {
  // The gap this closed: built structures used to be permanent.
  const s = farmWithMaterials(600);
  for (const kind of Object.keys(BUILDABLES)) {
    const x = 4, y = 4;
    s.grid.ground.fill(GROUND.GRASS);
    s.grid.objects.fill(OBJ.NONE);
    s.troughs = {};

    completeBuild(s, { buildKind: kind, x, y });
    assert(structureAt(s, x, y) !== null, `${kind} should be recognised once built`);
    assert(taskForTile(s, x, y, 'clear') !== null, `${kind} must be removable`);
  }
});

test('demolishing refunds half the materials, rounded down', () => {
  const s = farmWithMaterials(601);   // needs materials to build in the first place
  completeBuild(s, { buildKind: 'waterTrough', x: 4, y: 4 });   // costs 8 wood

  const res = demolish(s, 4, 4);
  assert(res.ok, 'demolition should succeed');
  assertEqual(res.refund, { wood: 4 }, 'half of 8 wood comes back');

  // A road costs 1 stone, so half of it rounds down to nothing.
  completeBuild(s, { buildKind: 'road', x: 6, y: 6 });
  assertEqual(demolish(s, 6, 6).refund, {}, 'cheap things can refund nothing');
});

test('building then removing is a net loss, never a materials loop', () => {
  const s = farmWithMaterials(602);
  s.inventory = { wood: 100 };
  const before = s.inventory.wood;

  completeBuild(s, { buildKind: 'fence', x: 4, y: 4 });
  const res = demolish(s, 4, 4);
  addItems(s, res.refund);

  assert(s.inventory.wood < before, 'the player must not profit from churn');
  assertEqual(s.inventory.wood, before - 1, 'fence costs 2, refunds 1');
});

test('demolishing a fence clears the tile and reopens the path', () => {
  const s = farmWithMaterials(603);
  const x = s.farmer.x + 3;
  const y = s.farmer.y;

  completeBuild(s, { buildKind: 'fence', x, y });
  assert(!s.grid.isWalkable(x, y, 'farmer'), 'the fence blocks to begin with');

  addTask(s, taskForTile(s, x, y, 'clear'));
  for (let i = 0; i < 300; i++) tick(s);

  assertEqual(s.grid.getObject(x, y), OBJ.NONE, 'the fence is gone');
  assert(s.grid.isWalkable(x, y, 'farmer'), 'and the tile is walkable again');
  assert((s.inventory.wood || 0) > 0, 'materials came back');
});

test('removing a trough from either half takes down the whole thing', () => {
  for (const tapOffset of [0, 1]) {
    const s = farmWithMaterials(604);
    const x = s.farmer.x + 3;
    const y = s.farmer.y;
    completeBuild(s, { buildKind: 'feedTrough', x, y });

    const spec = taskForTile(s, x + tapOffset, y, 'clear');
    assert(spec !== null, `tapping half ${tapOffset} should offer removal`);
    assertEqual(spec.x, x, 'and the task targets the anchor either way');

    addTask(s, spec);
    for (let i = 0; i < 400; i++) tick(s);

    assertEqual(s.grid.getObject(x, y), OBJ.NONE, 'left half cleared');
    assertEqual(s.grid.getObject(x + 1, y), OBJ.NONE, 'right half cleared too');
    assertEqual(Object.keys(s.troughs).length, 0, 'and the record is gone');
  }
});

test('a demolished road goes back to grass, not bare earth', () => {
  const s = farmWithMaterials(605);
  const x = s.farmer.x + 2;
  const y = s.farmer.y;
  completeBuild(s, { buildKind: 'road', x, y });

  addTask(s, taskForTile(s, x, y, 'clear'));
  for (let i = 0; i < 300; i++) tick(s);
  assertEqual(s.grid.getGround(x, y), GROUND.GRASS, 'road reverts to grass');
});

test('the auto tool never demolishes anything', () => {
  // A stray tap must not be able to destroy something the player paid for.
  const s = farmWithMaterials(606);
  for (const kind of ['fence', 'gate', 'waterTrough', 'road']) {
    s.grid.ground.fill(GROUND.GRASS);
    s.grid.objects.fill(OBJ.NONE);
    s.troughs = {};
    completeBuild(s, { buildKind: kind, x: 4, y: 4 });
    const t = taskForTile(s, 4, 4, 'auto');
    // Auto may offer something useful here (filling a trough, say) — what it
    // must never do is tear the structure down.
    assert(t === null || t.type !== 'demolish', `auto must not demolish a ${kind}`);
  }
});

test('natural obstacles still clear normally, not as demolition', () => {
  const s = farmWithMaterials(607);
  s.grid.setObject(4, 4, OBJ.TREE);
  assertEqual(taskForTile(s, 4, 4, 'clear').type, 'chop', 'a tree is chopped, not demolished');
  s.grid.setObject(5, 4, OBJ.ROCK);
  assertEqual(taskForTile(s, 5, 4, 'clear').type, 'clear', 'a rock is cleared');
});

// --- animals ------------------------------------------------------------

/** A cleared farm with a barn, both troughs filled, and one animal. */
function farmWithAnimal(type = 'chicken', seed = 800) {
  const s = farmWithMaterials(seed);
  s.lastTickTime = 0;                    // see weedableFarm
  completeBuild(s, { buildKind: 'barn', x: 20, y: 2 });
  completeBuild(s, { buildKind: 'waterTrough', x: 4, y: 4 });
  completeBuild(s, { buildKind: 'feedTrough', x: 4, y: 6 });
  s.troughs['4,4'].level = TROUGH_CAPACITY;
  s.troughs['4,6'].level = TROUGH_CAPACITY;
  const animal = makeAnimal(s, type, 6, 5);
  return { s, animal };
}

test('animals never die, no matter how long they are neglected', () => {
  // The rule the whole system is built around. A week of nothing must leave the
  // animal standing there, just unproductive.
  const { s, animal } = farmWithAnimal('cow', 801);
  s.troughs = {};                       // no food, no water, anywhere

  for (let i = 0; i < 7 * 24 * 60 * 60; i++) tick(s);

  assertEqual(s.animals.length, 1, 'the cow is still here after a week');
  assert(s.animals[0] === animal, 'and it is the same animal');
  assert(isNeglected(animal), 'it is hungry and thirsty');
  assert(!('health' in animal), 'there should be no health value to drain');
});

test('neglect pauses production without losing progress', () => {
  const { s, animal } = farmWithAnimal('chicken', 802);
  s.troughs = {};
  // Run the rations down early, so it stalls well before it would be ready
  // (a fed chicken lays in 20 minutes, long before it gets thirsty).
  animal.food = 100;
  animal.water = 100;

  for (let i = 0; i < 100; i++) tick(s);
  const stalled = animal.progress;
  assert(stalled > 0, 'it produced while it still had rations');
  assert(isNeglected(animal), 'and is now going without');

  for (let i = 0; i < ANIMALS.chicken.produceTicks * 3; i++) tick(s);
  assertEqual(animal.progress, stalled, 'progress is frozen while neglected');
  assert(!isReady(animal), 'and it never becomes ready');
});

test('feeding a stalled animal resumes production from where it stopped', () => {
  const { s, animal } = farmWithAnimal('chicken', 803);
  s.troughs = {};
  animal.food = 50;
  animal.water = 50;

  for (let i = 0; i < 200; i++) tick(s);
  const stalled = animal.progress;
  assert(isNeglected(animal), 'stalled to begin with');

  animal.food = FOOD_DURATION;
  animal.water = WATER_DURATION;
  for (let i = 0; i < 200; i++) tick(s);

  assert(animal.progress > stalled, 'it picks up again');
  assertEqual(animal.progress, stalled + 200, 'exactly where it left off, nothing lost');
});

test('a fed chicken lays an egg on the ground, not into the bag', () => {
  const { s, animal } = farmWithAnimal('chicken', 804);
  animal.x = 5; animal.y = 5;

  for (let i = 0; i < ANIMALS.chicken.produceTicks + 10; i++) tick(s);

  assert(!isReady(animal), 'a hen is never "ready to collect from"');
  assertEqual(s.inventory.egg, undefined, 'nothing goes straight into the bag');

  const eggs = [...s.grid.objects].filter((o) => o === OBJ.EGG).length;
  assert(eggs >= 1, 'there should be an egg lying about');
  // It reset on laying and has been working again since, so it's well short of
  // another egg rather than exactly zero.
  assert(animal.progress < ANIMALS.chicken.produceTicks, 'and the hen started over');
});

test('an egg on the ground is picked up like anything else lying there', () => {
  const s = farmWithMaterials(8041);
  s.grid.setObject(6, 6, OBJ.EGG);

  const spec = taskForTile(s, 6, 6, 'clear');
  assert(spec !== null, 'the clear tool offers it');
  assertEqual(spec.type, 'pickup', 'as a pick-up');
  assert(s.grid.isWalkable(6, 6, 'farmer'), 'an egg never blocks the way');

  s.farmer.x = 4; s.farmer.y = 6; s.farmer.taskId = null; s.farmer.path = [];
  addTask(s, spec);
  for (let i = 0; i < 200; i++) tick(s);

  assertEqual(s.grid.getObject(6, 6), OBJ.NONE, 'the egg is gone from the ground');
  assertEqual(s.inventory.egg, 1, 'and is in the bag');
});

test('the auto tool picks up eggs too', () => {
  const s = farmWithMaterials(8042);
  s.grid.setObject(6, 6, OBJ.EGG);
  assertEqual(taskForTile(s, 6, 6, 'auto').type, 'pickup', 'tapping an egg picks it up');
});

test('a cow is still milked directly rather than dropping anything', () => {
  const { s, animal } = farmWithAnimal('cow', 8043);
  for (let i = 0; i < ANIMALS.cow.produceTicks + 10; i++) tick(s);

  assert(isReady(animal), 'the cow should be ready to milk');
  assertEqual([...s.grid.objects].filter((o) => o === OBJ.EGG).length, 0, 'and drops nothing');

  const gained = collectFrom(s, animal);
  assertEqual(gained, { milk: 1 }, 'milking yields milk');
  assertEqual(s.inventory.milk, 1, 'straight into the bag');
  assertEqual(animal.stock, 0, 'and the churn is empty again');
});

test('a milked animal banks a few units instead of stopping at one', () => {
  // Without this the expensive animals were far worse than chickens overnight:
  // a hen drops her egg and carries on, while a cow produced one thing and
  // stood idle for the rest of the night.
  const { s, animal } = farmWithAnimal('cow', 8045);
  const each = ANIMALS.cow.produceTicks;

  for (let i = 0; i < each * 2 + 10; i++) tick(s);
  assertEqual(animal.stock, 2, 'two milkings while you were away');

  // ...but not forever. There's a ceiling, so an animal is still worth visiting.
  for (let i = 0; i < each * 10; i++) tick(s);
  assertEqual(animal.stock, PRODUCE_CAP, 'it fills up and then waits');

  const gained = collectFrom(s, animal);
  assertEqual(gained, { milk: PRODUCE_CAP }, 'and the whole lot comes in one tap');
  assertEqual(s.inventory.milk, PRODUCE_CAP, 'not one tap per churn');
});

test('a full animal starts working again the moment you collect', () => {
  const { s, animal } = farmWithAnimal('sheep', 8046);
  for (let i = 0; i < ANIMALS.sheep.produceTicks * (PRODUCE_CAP + 2); i++) tick(s);
  assertEqual(animal.stock, PRODUCE_CAP, 'full');

  collectFrom(s, animal);
  for (let i = 0; i < ANIMALS.sheep.produceTicks + 5; i++) tick(s);
  assertEqual(animal.stock, 1, 'shearing it lets it get back to work');
});

test('hens are not capped — their eggs go on the ground', () => {
  const { s } = farmWithAnimal('chicken', 8047);
  for (let i = 0; i < ANIMALS.chicken.produceTicks * (PRODUCE_CAP + 3); i++) tick(s);

  const eggs = [...s.grid.objects].filter((o) => o === OBJ.EGG).length;
  assert(eggs > PRODUCE_CAP, `a hen keeps laying (${eggs} eggs), the cap is for banking`);
});

test('a save from before banking keeps the milk it was owed', () => {
  const { s, animal } = farmWithAnimal('cow', 8048);
  for (let i = 0; i < ANIMALS.cow.produceTicks + 5; i++) tick(s);
  assertEqual(animal.stock, 1, 'a cow ready to milk');

  // How that farm was written before animals could bank. Pinned to 3 rather
  // than SAVE_VERSION - 1: the point is *that* schema, and the relative form
  // quietly stopped meaning it the moment a version was added after it.
  const old = JSON.parse(JSON.stringify(serialize(s)));
  old.version = 3;
  for (const a of old.animals) { a.ready = a.stock > 0; delete a.stock; }

  const back = deserialize(migrate(old));
  assert(isReady(back.animals[0]), 'the milk it had earned is still there');
  assertEqual(back.animals[0].stock, 1, 'as one unit of stock');
});

test('a hen with nowhere to lay keeps its egg rather than losing it', () => {
  const { s, animal } = farmWithAnimal('chicken', 8044);
  animal.x = 5; animal.y = 5;
  // Box the hen in with rocks so every candidate tile is occupied.
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    s.grid.setObject(5 + dx, 5 + dy, OBJ.ROCK);
  }

  for (let i = 0; i < ANIMALS.chicken.produceTicks + 200; i++) tick(s);
  assertEqual([...s.grid.objects].filter((o) => o === OBJ.EGG).length, 0, 'no egg could be laid');
  assert(animal.progress >= ANIMALS.chicken.produceTicks, 'but the hen stays ready to lay');

  // Clear a space and it lays immediately.
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    s.grid.setObject(5 + dx, 5 + dy, OBJ.NONE);
  }
  tick(s);
  assert([...s.grid.objects].filter((o) => o === OBJ.EGG).length >= 1, 'the egg arrives once there is room');
});

test('animals drink and eat from troughs, draining them', () => {
  const { s, animal } = farmWithAnimal('cow', 805);
  animal.x = 5; animal.y = 4;          // right next to the water trough
  animal.water = 1;                     // parched

  const before = s.troughs['4,4'].level;
  for (let i = 0; i < 40; i++) tick(s);

  assert(s.troughs['4,4'].level < before, 'the trough was drained');
  assert(animal.water > SEEK_THRESHOLD, 'and the cow topped up');
});

test('an animal walks to a trough it can reach', () => {
  const { s, animal } = farmWithAnimal('cow', 806);
  animal.x = 12; animal.y = 12;        // some way off
  animal.water = 1;

  for (let i = 0; i < 600; i++) tick(s);
  assert(animal.water > SEEK_THRESHOLD, 'it found its way to water');
});

test('a fenced-in animal cannot reach an outside trough, but still survives', () => {
  const { s, animal } = farmWithAnimal('cow', 807);
  // Wall the cow into a small pen well away from the troughs.
  for (let x = 10; x <= 14; x++) { s.grid.setObject(x, 10, OBJ.FENCE); s.grid.setObject(x, 14, OBJ.FENCE); }
  for (let y = 10; y <= 14; y++) { s.grid.setObject(10, y, OBJ.FENCE); s.grid.setObject(14, y, OBJ.FENCE); }
  animal.x = 12; animal.y = 12;
  animal.water = 1; animal.food = 1;

  for (let i = 0; i < 5000; i++) tick(s);

  assert(isNeglected(animal), 'it cannot reach the troughs');
  assertEqual(s.animals.length, 1, 'but it is emphatically still alive');
  assert(animal.x > 10 && animal.x < 14 && animal.y > 10 && animal.y < 14,
    'and it stayed inside the pen');
});

test('a gate keeps an animal in while letting the farmer through', () => {
  const { s, animal } = farmWithAnimal('cow', 808);
  for (let x = 10; x <= 14; x++) { s.grid.setObject(x, 10, OBJ.FENCE); s.grid.setObject(x, 14, OBJ.FENCE); }
  for (let y = 10; y <= 14; y++) { s.grid.setObject(10, y, OBJ.FENCE); s.grid.setObject(14, y, OBJ.FENCE); }
  s.grid.setObject(10, 12, OBJ.GATE);
  animal.x = 12; animal.y = 12;
  animal.water = 1;

  for (let i = 0; i < 3000; i++) tick(s);
  assert(animal.x > 10 && animal.x < 14, 'the gate held the cow in');
  assert(findPath(s.grid, { x: 2, y: 12 }, { x: 12, y: 12 }, { actor: 'farmer' }) !== null,
    'while the farmer can still walk in to tend it');
});

test('filling troughs: water is free, feed costs the cheapest crop you have', () => {
  const { s } = farmWithAnimal('chicken', 809);
  s.troughs['4,4'].level = 0;
  s.troughs['4,6'].level = 0;
  s.inventory = { carrot: 10, eggplant: 10 };   // carrot is the cheaper one

  assert(fillWaterTrough(s, 4, 4).ok, 'water always works');
  assertEqual(s.troughs['4,4'].level, TROUGH_CAPACITY, 'and fills it up');

  const fed = fillFeedTrough(s, 4, 6);
  assert(fed.ok, 'feeding should work');
  assertEqual(fed.food, 'carrot', 'it reaches for the cheapest crop');
  assertEqual(s.inventory.carrot, 10 - FEED_COST, 'which is consumed');
  assertEqual(s.inventory.eggplant, 10, 'and the pricey crop is left alone');
});

test('bought feed is a fallback, never used while crops are to hand', () => {
  const { s } = farmWithAnimal('chicken', 8091);
  s.troughs['4,6'].level = 0;
  s.inventory = { carrot: 10, feed: 10 };

  assertEqual(pickFeed(s), 'carrot', 'crops come first even with feed in the bag');
  const fed = fillFeedTrough(s, 4, 6);
  assertEqual(fed.food, 'carrot', 'and that is what gets used');
  assertEqual(s.inventory.feed, 10, 'the bought feed is untouched');
});

test('bought feed keeps animals fed when the larder is empty', () => {
  const { s } = farmWithAnimal('chicken', 8092);
  s.troughs['4,6'].level = 0;
  s.inventory = { feed: 5 };                    // no crops at all

  assertEqual(pickFeed(s), 'feed', 'feed is the fallback');
  const fed = fillFeedTrough(s, 4, 6);
  assert(fed.ok, 'the trough still fills');
  assertEqual(fed.food, 'feed', 'using bought feed');
  assertEqual(s.inventory.feed, 5 - FEED_COST, 'which is consumed');
  assertEqual(s.troughs['4,6'].level, TROUGH_CAPACITY, 'to the brim');
});

test('feed is never eaten as a crop, and produce is never fed back', () => {
  const { s } = farmWithAnimal('chicken', 8093);
  // Only ineligible things in the bag: feed is a fallback, the rest never count.
  s.inventory = { wood: 50, stone: 50, egg: 50, milk: 50, carrot_seed: 50 };
  assertEqual(pickFeed(s), null, 'none of these are animal food');

  s.inventory.feed = FEED_COST;
  assertEqual(pickFeed(s), 'feed', 'but bought feed is');
});

test('feed costs more than growing it yourself', () => {
  // The whole point of feed: convenience at a premium, not the sensible choice.
  const cheapestCrop = Math.min(...Object.keys(CROPS).map((c) => ITEMS[c].sell));
  assert(MATERIALS.feed.buy > cheapestCrop,
    `feed at $${MATERIALS.feed.buy} should cost more than a $${cheapestCrop} crop`);
});

test('feeding is refused when there is nothing to spare', () => {
  const { s } = farmWithAnimal('chicken', 810);
  s.inventory = { carrot: FEED_COST - 1, feed: FEED_COST - 1 };
  const res = fillFeedTrough(s, 4, 6);
  assert(!res.ok, 'cannot feed with less than a full helping of either');
  assertEqual(s.inventory.carrot, FEED_COST - 1, 'and nothing is taken');
  assertEqual(s.inventory.feed, FEED_COST - 1, 'from either source');
});

test('buying livestock is gated on barn capacity', () => {
  const s = farmWithMaterials(811);
  s.money = 10000;

  assert(!buyAnimal(s, 'chicken', 5, 5).ok, 'no barn, no animals');

  completeBuild(s, { buildKind: 'barn', x: 20, y: 2 });
  for (let i = 0; i < BARN_CAPACITY; i++) {
    assert(buyAnimal(s, 'chicken', 5 + i, 5).ok, `chicken ${i + 1} fits`);
  }
  const overflow = buyAnimal(s, 'chicken', 5, 6);
  assert(!overflow.ok, 'the barn is full');
  assertEqual(s.animals.length, BARN_CAPACITY, 'and no extra animal appeared');

  completeBuild(s, { buildKind: 'barn', x: 20, y: 6 });
  assert(buyAnimal(s, 'cow', 5, 7).ok, 'a second barn makes room');
});

test('buying an animal costs money and puts it on the map', () => {
  const s = farmWithMaterials(812);
  s.money = 1000;
  completeBuild(s, { buildKind: 'barn', x: 20, y: 2 });

  const res = buyAnimal(s, 'cow', 7, 9);
  assert(res.ok, 'purchase should succeed');
  assertEqual(s.money, 1000 - ANIMALS.cow.price, 'money spent');
  assertEqual(s.animals.length, 1, 'and a cow exists');
  assertEqual([res.animal.x, res.animal.y], [7, 9], 'exactly where the player put it');
});

test('an animal is placed where the player says, and refused where it cannot stand', () => {
  const s = farmWithMaterials(815);
  s.money = 1000;
  completeBuild(s, { buildKind: 'barn', x: 20, y: 2 });
  s.grid.setObject(6, 6, OBJ.FENCE);

  assert(!canPlaceAnimal(s, 6, 6), 'not on a fence');
  assert(!canPlaceAnimal(s, 20, 2), 'not inside a barn');
  assert(!canPlaceAnimal(s, -1, 5), 'not off the map');
  assert(canPlaceAnimal(s, 8, 8), 'open ground is fine');

  const bad = buyAnimal(s, 'cow', 6, 6);
  assert(!bad.ok, 'buying onto a blocked tile is refused');
  assertEqual(s.money, 1000, 'and costs nothing');
  assertEqual(s.animals.length, 0, 'with no animal created');
});

test('checking affordability does not charge for the animal', () => {
  // The shop asks canBuyAnimal() before sending the player off to pick a spot;
  // backing out of that must cost nothing.
  const s = farmWithMaterials(816);
  s.money = 1000;
  completeBuild(s, { buildKind: 'barn', x: 20, y: 2 });

  assert(canBuyAnimal(s, 'cow').ok, 'affordable');
  assertEqual(s.money, 1000, 'but no money has moved');
  assertEqual(s.animals.length, 0, 'and no animal exists yet');
});

test('animals survive a save and reload mid-production', () => {
  const { s } = farmWithAnimal('cow', 813);
  for (let i = 0; i < 500; i++) tick(s);

  const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));
  for (let i = 0; i < 500; i++) { tick(s); tick(back); }

  assertEqual(serialize(back), serialize(s), 'animals must replay identically');
});

test('production while away matches production while watching', () => {
  // Offline catch-up is the whole premise; animals must obey it too.
  const a = farmWithAnimal('chicken', 814);
  const b = farmWithAnimal('chicken', 814);
  b.s.lastTickTime = a.s.lastTickTime;

  for (let i = 0; i < ANIMALS.chicken.produceTicks * 2; i++) tick(a.s);
  for (let i = 0; i < ANIMALS.chicken.produceTicks * 2; i++) tick(b.s);

  assertEqual(serialize(b.s), serialize(a.s), 'catch-up must match live play');
});

// --- shop ---------------------------------------------------------------

test('staple seeds are always in stock', () => {
  const s = newGame(1);
  // Whatever the rotation, a player must never be stranded with nothing to plant.
  for (let r = 0; r < 12; r++) {
    s.tickCount = r * ROTATION_TICKS;
    const stock = stockedSeedCrops(s);
    for (const staple of STAPLE_SEEDS) {
      assert(stock.includes(staple), `rotation ${r} dropped the staple ${staple}`);
    }
  }
});

test('the rotating selection offers exactly two extra crops', () => {
  const s = newGame(42);
  for (let r = 0; r < 12; r++) {
    s.tickCount = r * ROTATION_TICKS;
    const stock = stockedSeedCrops(s);
    const rotating = stock.filter((c) => !STAPLE_SEEDS.includes(c));
    assertEqual(rotating.length, ROTATING_COUNT, `rotation ${r} offered the wrong count`);
    assertEqual(new Set(stock).size, stock.length, 'no duplicates in the stock list');
  }
});

test('every rotation stocks something slow enough to leave overnight', () => {
  // The rotation once drew both slow crops out at the same time, which left a
  // player checking in at bedtime with nothing but 4- and 5-minute crops to
  // plant. One seed comes from each tier now, so that cannot happen.
  const slow = ROTATING_TIERS[ROTATING_TIERS.length - 1];
  for (const seed of [11, 12, 13]) {
    const s = newGame(seed);
    for (let r = 0; r < 40; r++) {
      s.tickCount = r * ROTATION_TICKS;
      const stock = stockedSeedCrops(s);
      assert(stock.some((c) => slow.includes(c)),
        `seed ${seed} rotation ${r} offered nothing slow: ${stock.join(', ')}`);
    }
  }
});

test('the rotation still moves — no tier is stuck on one crop', () => {
  const s = newGame(14);
  const seen = new Set();
  for (let r = 0; r < 40; r++) {
    s.tickCount = r * ROTATION_TICKS;
    for (const c of stockedSeedCrops(s)) seen.add(c);
  }
  for (const crop of ROTATING_TIERS.flat()) {
    assert(seen.has(crop), `${crop} never came up across 40 rotations`);
  }
});

test('stock is stable within a rotation and changes across rotations', () => {
  const s = newGame(77);

  s.tickCount = 5;
  const early = stockedSeedCrops(s).join();
  s.tickCount = ROTATION_TICKS - 1;
  assertEqual(stockedSeedCrops(s).join(), early, 'stock must not shift mid-rotation');

  // Over many rotations the selection must actually vary, or it isn't a rotation.
  const seen = new Set();
  for (let r = 0; r < 20; r++) {
    s.tickCount = r * ROTATION_TICKS;
    seen.add(stockedSeedCrops(s).join());
  }
  assert(seen.size > 1, 'the rotating selection never changed');
});

test('stock is derived, so it needs no save data and survives a reload', () => {
  const s = newGame(2718);
  s.tickCount = 3 * ROTATION_TICKS + 500;
  const expected = stockedSeedCrops(s);

  const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));
  assertEqual(stockedSeedCrops(back), expected, 'stock must survive persistence');
});

test('choosing shop stock does not disturb the simulation rng', () => {
  // The shop must be a pure observer: if it consumed state.rng, opening the
  // panel would change how the farmer wanders.
  const s = newGame(31415);
  const before = s.rng.getState();
  stockedSeedCrops(s);
  buyList(s);
  assertEqual(s.rng.getState(), before, 'shop must not consume the simulation rng');
});

test('buying moves money into the bag, and refuses when short', () => {
  const s = newGame(9);
  s.money = 20;
  s.inventory = {};

  const ok = buy(s, 'carrot_seed', 2);
  assert(ok.ok, `expected the purchase to succeed: ${ok.reason}`);
  assertEqual(s.money, 20 - CROPS.carrot.seedCost * 2, 'money deducted');
  assertEqual(s.inventory.carrot_seed, 2, 'seeds delivered');

  const broke = buy(s, 'carrot_seed', 99);
  assert(!broke.ok, 'should refuse when it costs more than you have');
  assertEqual(s.inventory.carrot_seed, 2, 'and change nothing');
});

test('buying refuses seeds that are not in this rotation', () => {
  const s = newGame(11);
  s.money = 10000;
  const stocked = stockedSeedCrops(s);
  const missing = Object.keys(CROPS).find((c) => !stocked.includes(c));

  const res = buy(s, `${missing}_seed`, 1);
  assert(!res.ok, `${missing} is out of stock and must not be purchasable`);
  assertEqual(s.money, 10000, 'no money moved');
});

test('selling empties the stack and pays out', () => {
  const s = newGame(9);
  s.money = 0;
  s.inventory = { corn: 3 };

  const res = sell(s, 'corn', 2);
  assert(res.ok, 'sale should succeed');
  assertEqual(s.money, ITEMS.corn.sell * 2, 'paid the sell price');
  assertEqual(s.inventory.corn, 1, 'stack reduced');

  const all = sellAll(s, 'corn');
  assert(all.ok, 'sell-all should succeed');
  assertEqual(s.inventory.corn, undefined, 'stack cleared');
});

test('selling refuses more than you own and pays nothing for junk', () => {
  const s = newGame(9);
  s.money = 0;
  s.inventory = { corn: 1 };

  assert(!sell(s, 'corn', 5).ok, 'cannot sell what you do not have');
  assertEqual(s.money, 0, 'no money created');
  assert(!sell(s, 'nonsense', 1).ok, 'unknown items are not sellable');
});

test('seeds resell at half price, so there is no money loop', () => {
  const s = newGame(9);
  s.money = 1000;
  s.inventory = {};

  const before = s.money;
  buy(s, 'carrot_seed', 4);
  sellAll(s, 'carrot_seed');
  assert(s.money < before, 'buying then reselling must lose money, never gain it');
});

test('every crop turns a profit, and the long ones pay far more per planting', () => {
  // The balance shape the game leans on: short crops win per minute, long crops
  // win per planting. If this inverts, nobody would ever plant the slow ones.
  const rows = Object.entries(CROPS).map(([id, def]) => {
    const avgYield = (def.yield[0] + def.yield[1]) / 2;
    const profit = avgYield * ITEMS[id].sell - def.seedCost;
    return { id, mins: def.growTicks / 60, profit, perMin: profit / (def.growTicks / 60) };
  }).sort((a, b) => a.mins - b.mins);

  for (const r of rows) {
    assert(r.profit > 0, `${r.id} loses money: ${r.profit}`);
  }

  const shortest = rows[0];
  const longest = rows[rows.length - 1];
  assert(longest.profit > shortest.profit * 5,
    `long crops must be worth the wait: ${longest.id} ${longest.profit} vs ${shortest.id} ${shortest.profit}`);
  assert(shortest.perMin > longest.perMin,
    'short crops should still win on profit per minute, to reward active play');
});

test('a new farm can afford to get started', () => {
  const s = newGame(5);
  const cheapest = Math.min(...stockedSeedCrops(s).map((c) => CROPS[c].seedCost));
  assert(s.money >= cheapest * 3,
    `a new player should be able to buy a few seeds: $${s.money} vs $${cheapest} each`);
});

// --- the away summary ---------------------------------------------------

test('suspended events are counted instead of dispatched', () => {
  // Catch-up suspends events so a two-day replay doesn't fire thousands of
  // toasts. The tally is how the summary gets built without the simulation
  // knowing anyone is listening.
  let heard = 0;
  const off = on('task:done', () => { heard++; });

  suspend();
  startTally();
  emitUnlessSuspended('task:done', { task: { type: 'harvest' }, gained: { corn: 3 } });
  emitUnlessSuspended('task:done', { task: { type: 'harvest' }, gained: { corn: 2 } });
  emitUnlessSuspended('crop:died', { type: 'carrot' });
  const tally = stopTally();
  resume();
  off();

  assertEqual(heard, 0, 'nothing should have been dispatched while suspended');
  assertEqual(tally.counts['task:done'], 2, 'both tasks counted');
  assertEqual(tally.counts['task:harvest'], 2, 'and counted by kind');
  assertEqual(tally.counts['crop:died'], 1, 'other events counted too');
  assertEqual(tally.items.corn, 5, 'and the haul is added up');
});

test('events dispatch normally again once the tally stops', () => {
  let heard = 0;
  const off = on('task:done', () => { heard++; });
  emitUnlessSuspended('task:done', { task: { type: 'chop' } });
  off();
  assertEqual(heard, 1, 'live play is unaffected');
});

test('catch-up returns a tally of what happened while away', async () => {
  const s = newGame(9001);
  s.grid.objects.fill(OBJ.NONE);
  const x = s.farmer.x + 2;
  const y = s.farmer.y;
  s.grid.setObject(x, y, OBJ.ROCK);
  addTask(s, taskForTile(s, x, y, 'clear'));

  let done = 0;
  const off = on('task:done', () => { done++; });
  const result = await runCatchup(600 * TICK_MS, () => tick(s));
  off();

  assertEqual(done, 0, 'the replay must stay silent');
  assert(result.tally !== null, 'but it reports what it saw');
  assertEqual(result.tally.counts['task:clear'], 1, 'the rock got cleared');
  assert((result.tally.items.stone || 0) >= 2, 'and the stone was counted');
});

test('a short absence is not worth a summary', () => {
  const s = newGame(9002);
  assertEqual(buildSummary(s, { ticks: 30, tally: null }), null, 'half a minute is not news');
});

test('the summary reports work, hauls and losses', () => {
  const s = newGame(9003);
  const summary = buildSummary(s, {
    ticks: 7200,
    tally: {
      counts: { 'task:done': 5, 'crop:ripe': 4, 'crop:died': 2, 'animal:ready': 1 },
      items: { corn: 12, egg: 2 },
    },
  });

  assert(summary !== null, 'two hours of work deserves a summary');
  assert(summary.headline.includes('2 hours'), `headline should say how long: ${summary.headline}`);
  const text = summary.lines.join(' | ');
  assert(text.includes('5 jobs finished'), `expected the job count: ${text}`);
  assert(text.includes('12 corn'), `expected the haul: ${text}`);
  assert(text.includes('spoiled'), `expected the losses: ${text}`);
});

test('the summary nudges about neglected animals and unwatered seeds', () => {
  // Animals never die, so this is the only place neglect ever surfaces.
  const { s, animal } = farmWithAnimal('cow', 9004);
  animal.food = 0;
  animal.water = 0;
  const bed = { x: s.farmer.x + 1, y: s.farmer.y };
  s.grid.setGround(bed.x, bed.y, GROUND.TILLED);
  plantCrop(s, bed.x, bed.y, 'carrot');          // planted, never watered

  const summary = buildSummary(s, { ticks: 3600, tally: { counts: {}, items: {} } });

  assert(summary !== null, 'nudges alone are worth showing');
  const nudges = summary.nudges.join(' | ');
  assert(/animal is/.test(nudges), `expected the animal nudge: ${nudges}`);
  assert(/waiting to be watered/.test(nudges), `expected the seed nudge: ${nudges}`);
});

test('a quiet absence with nothing to report shows nothing', () => {
  const s = newGame(9005);
  s.crops = {};
  s.animals = [];
  assertEqual(buildSummary(s, { ticks: 3600, tally: { counts: {}, items: {} } }), null,
    'no work, no losses, nothing needing attention');
});

test('a sheep grows wool, sheared directly like a cow is milked', () => {
  const { s, animal } = farmWithAnimal('sheep', 8200);
  const def = animalDef('sheep');

  for (let i = 0; i < def.produceTicks + 5; i++) tick(s);

  assert(isReady(animal), 'the fleece is ready after its full time');
  let dropped = 0;
  s.grid.objects.forEach((o) => { if (o === OBJ.EGG) dropped++; });
  assertEqual(dropped, 0, 'a sheep leaves nothing lying in the grass');

  const gained = collectFrom(s, animal);
  assertEqual(gained, { wool: 1 }, 'shearing yields wool');
  assertEqual(countItem(s, 'wool'), 1, 'and it lands in the bag');
});

test('wool takes longer than milk and is worth more when it comes', () => {
  // The point of a sheep: fewer, bigger collections. It's the animal for
  // someone who looks in twice a day, the way the slow crops are the seed for
  // someone planting before bed.
  assert(animalDef('sheep').produceTicks > animalDef('cow').produceTicks,
    'wool is slower than milk');
  assert(ITEMS.wool.sell > ITEMS.milk.sell, 'and a fleece is worth more than a churn');

  const cow = farmWithAnimal('cow', 8201);
  const sheep = farmWithAnimal('sheep', 8201);
  for (let i = 0; i < animalDef('cow').produceTicks + 5; i++) { tick(cow.s); tick(sheep.s); }

  assert(isReady(cow.animal), 'the cow is ready first');
  assert(!isReady(sheep.animal), 'the sheep is still growing its fleece');
});

// --- the sell list, grouped ---------------------------------------------

test('everything sellable belongs to a known group', () => {
  // A new item added without a group would silently land in Materials, which
  // is the sort of thing nobody notices until a cow's milk turns up there.
  const known = new Set(ITEM_GROUPS.map((g) => g.id));
  for (const [id, def] of Object.entries(ITEMS)) {
    if (!def.sell) continue;
    assert(def.group, `${id} has no group`);
    assert(known.has(def.group), `${id} is in an unknown group: ${def.group}`);
  }
  // Seeds are generated per crop rather than listed, so they're recognised by
  // shape. If that ever stops working they'd scatter through Materials.
  for (const crop of Object.keys(CROPS)) {
    assertEqual(itemGroup(seedIdFor(crop)), 'seed', `${crop} seeds`);
  }
});

test('the sell list comes back under headings, in a fixed order', () => {
  const s = farmWithMaterials(9980);
  s.inventory = {
    carrot: 4, wool: 2, mushroom_morel: 1, wood: 10, carrot_seed: 3,
  };

  const groups = sellGroups(s);
  assertEqual(groups.map((g) => g.id), ['crop', 'produce', 'foraged', 'material', 'seed'],
    'the order is the one declared, not whatever the bag happens to hold');
  assertEqual(groups.map((g) => g.rows.length), [1, 1, 1, 1, 1], 'one of each');
});

test('a group vanishes once the last of it is sold', () => {
  const s = farmWithMaterials(9981);
  s.inventory = { carrot: 4, wool: 2 };
  assertEqual(sellGroups(s).map((g) => g.id), ['crop', 'produce'], 'both present');

  sellAll(s, 'wool');
  assertEqual(sellGroups(s).map((g) => g.id), ['crop'], 'and the empty heading goes with it');

  sellAll(s, 'carrot');
  assertEqual(sellGroups(s), [], 'an empty bag has no headings at all');
});

test('a heading is worth what the whole group is worth', () => {
  const s = farmWithMaterials(9982);
  s.inventory = { carrot: 3, cabbage: 2 };            // 3x10 + 2x40

  const [crops] = sellGroups(s);
  assertEqual(groupValue(crops), 3 * ITEMS.carrot.sell + 2 * ITEMS.cabbage.sell,
    'the number beside the heading is the money in that group');
});

test('grouping does not change what is sellable', () => {
  // The flat list is still the source of truth; grouping only arranges it.
  const s = farmWithMaterials(9983);
  s.inventory = {
    carrot: 4, wool: 2, mushroom_bolete: 3, stone: 7, wheat_seed: 2, feed: 1,
  };
  const flat = sellList(s).map((r) => r.id).sort();
  const grouped = sellGroups(s).flatMap((g) => g.rows.map((r) => r.id)).sort();
  assertEqual(grouped, flat, 'every row appears exactly once, under exactly one heading');
});

// --- decorations --------------------------------------------------------

test('a decoration always costs more than clearing it gives back', () => {
  // Otherwise it's a money press: buy a tree, chop it, sell the wood, repeat.
  for (const kind of Object.keys(DECOR)) {
    const back = salvageValue(kind);
    assert(DECOR[kind].price > back,
      `${kind} costs $${DECOR[kind].price} and gives back $${back}`);
  }
});

test('buying a decoration puts it on the map and takes the money', () => {
  const s = farmWithMaterials(9960);
  s.money = 1000;
  const x = s.farmer.x + 4;
  const y = s.farmer.y + 4;

  const res = placeDecor(s, 'tree', x, y);
  assert(res.ok, 'placed');
  assertEqual(s.money, 1000 - DECOR.tree.price, 'and paid for');
  assertEqual(s.grid.getObject(x, y), OBJ.TREE, 'a real tree, same as any other');

  // ...which means the clear tool already knows what to do with it.
  assertEqual(taskForTile(s, x, y, 'clear').type, 'chop', 'and it chops like one');
});

test('a decoration is refused where it would be in the way', () => {
  const s = farmWithMaterials(9961);
  s.money = 1000;
  const x = s.farmer.x + 4;
  const y = s.farmer.y + 4;

  s.grid.setObject(x, y, OBJ.ROCK);
  assert(!canPlaceDecor(s, x, y), 'not on top of something else');

  s.grid.setObject(x, y, OBJ.NONE);
  assert(canPlaceDecor(s, x, y), 'but open ground is fine');

  // The helper hands over the whole valley, so take a corner back first.
  s.grid.owned.delete(plotIndex(0, 0, s.grid.w));
  assert(!canPlaceDecor(s, 2, 2), 'and never on land you do not own');
});

test('a decoration you cannot afford costs nothing', () => {
  const s = farmWithMaterials(9962);
  s.money = 5;
  const res = placeDecor(s, 'tree', s.farmer.x + 4, s.farmer.y + 4);
  assert(!res.ok, 'refused');
  assertEqual(s.money, 5, 'and not charged');
  assertEqual(s.grid.getObject(s.farmer.x + 4, s.farmer.y + 4), OBJ.NONE, 'and nothing placed');
});

// --- picking things up and putting them down ----------------------------

test('the move tool finds whatever is standing on a tile', () => {
  const { s, hand } = farmWithHand(9970);
  const cow = makeAnimal(s, 'cow', s.farmer.x + 3, s.farmer.y);

  assertEqual(movableAt(s, cow.x, cow.y).kind, 'animal', 'a cow');
  assertEqual(movableAt(s, hand.x, hand.y).kind, 'hand', 'a farmhand');
  assertEqual(movableAt(s, s.farmer.x, s.farmer.y).kind, 'farmer', 'the farmer himself');
  assertEqual(movableAt(s, s.farmer.x + 9, s.farmer.y + 9), null, 'and nothing on bare grass');
});

test('moving something puts it down and forgets what it was doing', () => {
  // Anything left over would have it slide back across the map from where it
  // was picked up, or carry on to a job it can no longer sensibly reach.
  const { s, hand } = farmWithHand(9971);
  // Far enough that it is still walking to the job when we interrupt it.
  const cow = makeAnimal(s, 'cow', s.farmer.x + 12, s.farmer.y + 6);
  cow.stock = 1;
  for (let i = 0; i < 4; i++) tick(s);
  assert(hand.target, 'the hand has taken a job on');
  assert(hand.path.length > 0, 'and is on its way');

  const to = { x: s.farmer.x - 6, y: s.farmer.y + 6 };
  assert(moveTo(s, movableAt(s, hand.x, hand.y), to.x, to.y).ok, 'moved');

  assertEqual({ x: hand.x, y: hand.y }, to, 'it is where it was put');
  assertEqual({ x: hand.px, y: hand.py }, to, 'and does not slide back from where it was');
  assertEqual(hand.target, null, 'the job it was walking to is dropped');
  assertEqual(hand.path.length, 0, 'along with the route');
});

test('moving the farmer cancels what he was in the middle of', () => {
  const s = farmWithMaterials(9972);
  s.grid.setObject(s.farmer.x + 3, s.farmer.y, OBJ.ROCK);
  addTask(s, taskForTile(s, s.farmer.x + 3, s.farmer.y, 'clear'));
  for (let i = 0; i < 5; i++) tick(s);

  const to = { x: s.farmer.x - 8, y: s.farmer.y - 4 };
  moveTo(s, movableAt(s, s.farmer.x, s.farmer.y), to.x, to.y);

  assertEqual({ x: s.farmer.x, y: s.farmer.y }, to, 'he is where he was put');
  assertEqual(s.farmer.taskId, null, 'and has let go of the job');
  assertEqual(s.farmer.trail, [{ x: to.x, y: to.y }], 'with no trail dragging him back');
});

test('things cannot be dropped where they could not stand', () => {
  const { s } = farmWithHand(9973);
  const cow = makeAnimal(s, 'cow', s.farmer.x + 3, s.farmer.y);
  const movable = movableAt(s, cow.x, cow.y);

  const water = { x: s.farmer.x + 5, y: s.farmer.y + 5 };
  s.grid.setGround(water.x, water.y, GROUND.WATER);
  assert(!canMoveTo(s, movable, water.x, water.y), 'a cow cannot be put in the pond');
  assert(!moveTo(s, movable, water.x, water.y).ok, 'so the move is refused');
  assertEqual({ x: cow.x, y: cow.y }, { x: s.farmer.x + 3, y: s.farmer.y }, 'it has not budged');

  s.grid.owned.delete(plotIndex(0, 0, s.grid.w));
  assert(!canMoveTo(s, movable, 2, 2), 'nor onto land you do not own');
});

test('a duck can be put in the pond, because a duck swims', () => {
  const { s } = farmWithHand(9974);
  const duck = makeAnimal(s, 'duck', s.farmer.x + 3, s.farmer.y);
  const water = { x: s.farmer.x + 5, y: s.farmer.y + 5 };
  s.grid.setGround(water.x, water.y, GROUND.WATER);

  assert(moveTo(s, movableAt(s, duck.x, duck.y), water.x, water.y).ok, 'in it goes');
  assertEqual({ x: duck.x, y: duck.y }, water, 'and there it is');
});

// --- the farmhand -------------------------------------------------------

/** A cleared farm with a barn, some stocked animals, and one hand hired. */
function farmWithHand(seed = 9900) {
  const s = farmWithMaterials(seed);
  s.money = 99999;
  completeBuild(s, { buildKind: 'barn', x: s.farmer.x - 1, y: s.farmer.y - 5 });
  const hand = hireHand(s, s.farmer.x, s.farmer.y + 1).hand;
  return { s, hand };
}

test('a farmhand needs a barn to bring things to, and one per barn', () => {
  const s = farmWithMaterials(9901);
  s.money = 99999;
  assert(!canHireHand(s).ok, 'no barn, no farmhand');

  completeBuild(s, { buildKind: 'barn', x: s.farmer.x - 1, y: s.farmer.y - 5 });
  assert(canHireHand(s).ok, 'a barn is somewhere to bring things');
  assert(hireHand(s, s.farmer.x, s.farmer.y + 1).ok, 'hired');
  assert(!canHireHand(s).ok, 'and that barn is spoken for');

  completeBuild(s, { buildKind: 'barn', x: s.farmer.x + 6, y: s.farmer.y - 5 });
  assert(canHireHand(s).ok, 'a second barn, a second pair of hands');
});

test('hiring costs money, and costs nothing if it fails', () => {
  const s = farmWithMaterials(9902);
  completeBuild(s, { buildKind: 'barn', x: s.farmer.x - 1, y: s.farmer.y - 5 });
  s.money = HAND_PRICE - 1;

  const broke = hireHand(s, s.farmer.x, s.farmer.y + 1);
  assert(!broke.ok, 'refused');
  assertEqual(s.money, HAND_PRICE - 1, 'and not charged');
  assertEqual(handCount(s), 0, 'and nobody turned up');

  s.money = HAND_PRICE;
  assert(hireHand(s, s.farmer.x, s.farmer.y + 1).ok, 'hired at exactly the price');
  assertEqual(s.money, 0, 'paid in full');
});

test('a farmhand milks, shears and picks up eggs on its own', () => {
  const { s, hand } = farmWithHand(9903);
  const cow = makeAnimal(s, 'cow', s.farmer.x + 3, s.farmer.y);
  const sheep = makeAnimal(s, 'sheep', s.farmer.x + 5, s.farmer.y);
  cow.stock = 2;
  sheep.stock = 1;
  s.grid.setObject(s.farmer.x + 4, s.farmer.y + 3, OBJ.EGG);

  for (let i = 0; i < 600; i++) tick(s);

  assertEqual(hand.carrying.milk, 2, 'the cow was milked');
  assertEqual(hand.carrying.wool, 1, 'the sheep was sheared');
  assertEqual(hand.carrying.egg, 1, 'and the egg picked up');
  assertEqual(s.grid.getObject(s.farmer.x + 4, s.farmer.y + 3), OBJ.NONE, 'off the ground');
  assertEqual(countItem(s, 'milk'), 0, 'none of it is in your bag yet — they are holding it');
});

test('a farmhand carries only so much, and never destroys the surplus', () => {
  // The trap: a cow with four milk and a hand with room for one. The other
  // three have to stay on the cow, not vanish into full pockets.
  const { s, hand } = farmWithHand(9904);
  hand.carrying = { egg: HAND_CAPACITY - 1 };
  const cow = makeAnimal(s, 'cow', s.farmer.x + 2, s.farmer.y);
  cow.stock = 4;

  for (let i = 0; i < 600; i++) tick(s);

  assertEqual(carriedTotal(hand), HAND_CAPACITY, 'filled to the brim, no further');
  assertEqual(hand.carrying.milk, 1, 'took the one it could carry');
  assertEqual(cow.stock, 3, 'and left the rest on the cow');
});

test('the farmer takes what the farmhand is holding', () => {
  const { s, hand } = farmWithHand(9906);
  hand.carrying = { egg: 12, milk: 5, wool: 2 };

  const spec = taskForTile(s, hand.x, hand.y, 'auto');
  assertEqual(spec.type, 'gather', 'tapping them offers to take it');
  addTask(s, spec);
  assertEqual(addTask(s, taskForTile(s, hand.x, hand.y, 'auto')), null, 'and only once');

  let n = 0;
  while (s.tasks.length && n < 2000) { tick(s); n++; }

  assertEqual(countItem(s, 'egg'), 12, 'the eggs are yours now');
  assertEqual(countItem(s, 'milk'), 5, 'and the milk');
  assertEqual(countItem(s, 'wool'), 2, 'and the wool');
  assertEqual(carriedTotal(hand), 0, 'and their hands are empty again');
});

test('an empty farmhand is not worth walking over to', () => {
  const { s, hand } = farmWithHand(9907);
  assertEqual(carriedTotal(hand), 0, 'carrying nothing');
  const spec = taskForTile(s, hand.x, hand.y, 'auto');
  assert(!spec || spec.type !== 'gather', 'nothing to take');
});

test('work aimed at a farmhand follows them as they walk', () => {
  const { s, hand } = farmWithHand(9908);
  hand.carrying = { egg: 3 };
  const task = addTask(s, taskForTile(s, hand.x, hand.y, 'auto'));

  hand.x += 5;
  hand.y += 4;
  followTargets(s);

  assertEqual(task.x, hand.x, 'the task went with them');
  assertEqual(task.y, hand.y, 'on both axes');
});

test('an animal stands still for the farmhand too', () => {
  // Otherwise the hand trails after a wandering cow the same way the farmer
  // used to.
  const { s, hand } = farmWithHand(9909);
  const cow = makeAnimal(s, 'cow', s.farmer.x + 6, s.farmer.y + 4);
  cow.stock = 1;

  // Let the hand pick its target, then watch the cow.
  for (let i = 0; i < 30; i++) tick(s);
  const held = { x: cow.x, y: cow.y };
  for (let i = 0; i < 40 && cow.stock > 0; i++) tick(s);

  assertEqual({ x: cow.x, y: cow.y }, held, 'it waited to be milked');
});

/** A farm with three barns and three hands, for the crowd behaviours. */
function farmWithCrew(seed = 9920) {
  const s = farmWithMaterials(seed);
  s.money = 999999;
  const fx = s.farmer.x;
  const fy = s.farmer.y;
  completeBuild(s, { buildKind: 'barn', x: fx - 1, y: fy - 6 });
  completeBuild(s, { buildKind: 'barn', x: fx + 5, y: fy - 6 });
  completeBuild(s, { buildKind: 'barn', x: fx - 8, y: fy - 6 });
  const hands = [0, 1, 2].map((i) => hireHand(s, fx + i, fy + 1).hand);
  return { s, hands };
}

test('two farmhands never claim the same job', () => {
  // They all pick the nearest job, and left to themselves that is the *same*
  // job: three converge on one cow, one milks it, two arrive to find it done.
  const { s, hands } = farmWithCrew(9920);
  const cow = makeAnimal(s, 'cow', s.farmer.x + 6, s.farmer.y + 5);
  cow.stock = 4;
  cow.food = 1e9;
  cow.water = 1e9;

  for (let i = 0; i < 60; i++) {
    tick(s);
    const claims = hands.map((h) => h.target && h.target.kind + (h.target.id ?? '')).filter(Boolean);
    assertEqual(new Set(claims).size, claims.length, `two hands chased the same job: ${claims}`);
  }
});

test('farmhands do not settle on top of each other', () => {
  // Passing through each other for a tick is fine and barely visible. What is
  // not fine is a crew that comes to rest in a single stack, which is what the
  // player actually sees.
  const { s, hands } = farmWithCrew(9921);
  for (const [dx, dy] of [[6, 5], [9, 2], [3, 7]]) {
    const cow = makeAnimal(s, 'cow', s.farmer.x + dx, s.farmer.y + dy);
    cow.stock = 2;
    cow.food = 1e9;
    cow.water = 1e9;
  }

  let overlapTicks = 0;
  for (let i = 0; i < 400; i++) {
    tick(s);
    const tiles = hands.map((h) => `${h.x},${h.y}`);
    if (new Set(tiles).size !== tiles.length) overlapTicks++;
  }

  const settled = hands.map((h) => `${h.x},${h.y}`);
  assertEqual(new Set(settled).size, settled.length, `they came to rest stacked: ${settled}`);
  assert(overlapTicks < 40, `overlapping on ${overlapTicks} of 400 ticks is more than passing`);
});

test('a farmhand is not stopped by one standing in its way', () => {
  // The livelock: a hand parked by the barn sat on the only route to a job,
  // the hand behind it cleared its path, re-planned the same route, and was
  // blocked again — for ever. It spent 96% of its life re-planning a walk it
  // never took, and the farm silently stopped being serviced.
  const { s, hands } = farmWithCrew(9926);
  const [walker, blocker, spare] = hands;

  walker.x = s.farmer.x;
  walker.y = s.farmer.y + 6;
  blocker.x = s.farmer.x;
  blocker.y = s.farmer.y + 5;
  blocker.carrying = { egg: HAND_CAPACITY };          // full, so it stays put
  spare.x = s.farmer.x - 10;
  spare.y = s.farmer.y - 10;

  const cow = makeAnimal(s, 'cow', s.farmer.x, s.farmer.y + 1);
  cow.stock = 2;
  cow.food = 1e9;
  cow.water = 1e9;

  for (let i = 0; i < 400; i++) tick(s);
  assertEqual(cow.stock, 0, 'it got past and did the job');
});

test('a farmhand that cannot make progress gives up and looks elsewhere', () => {
  // Insurance against the next livelock, whatever causes it: a job held
  // without moving for long enough is dropped rather than held for a week.
  const { s, hand } = farmWithHand(9927);
  const cow = makeAnimal(s, 'cow', s.farmer.x + 6, s.farmer.y);
  cow.stock = 1;
  cow.food = 1e9;
  cow.water = 1e9;

  for (let i = 0; i < 12; i++) tick(s);
  assert(hand.target, 'it has taken the job on');

  // Wall it in completely, so the job becomes unreachable mid-walk.
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
    s.grid.setObject(hand.x + dx, hand.y + dy, OBJ.FENCE);
  }
  for (let i = 0; i < 150; i++) tick(s);
  assertEqual(hand.target, null, 'it let the job go rather than holding it for ever');
});

test('idle farmhands wait by a barn rather than wherever they stopped', () => {
  // They used to simply halt where the last job left them, which looked less
  // like hired help on a break than like someone loitering in a hedge.
  const { s, hands } = farmWithCrew(9922);
  for (const hand of hands) { hand.x = s.farmer.x + 9; hand.y = s.farmer.y + 9; }

  for (let i = 0; i < 300; i++) tick(s);

  for (const hand of hands) {
    const barn = s.buildings.find((b) => besideBox(b.x, b.y, 3, 2, hand.x, hand.y));
    assert(barn, `a hand is loitering at ${hand.x},${hand.y}`);
    // Not tucked under the roof, which is drawn three rows above the
    // footprint — waiting there hides them behind the barn entirely.
    assert(hand.y >= barn.y, `a hand is waiting under the eaves at ${hand.x},${hand.y}`);
  }
  const tiles = hands.map((h) => `${h.x},${h.y}`);
  assertEqual(new Set(tiles).size, 3, 'and each has its own spot');
});

test('a crew shares the work out instead of following each other around', () => {
  const { s, hands } = farmWithCrew(9923);
  for (const [dx, dy] of [[6, 5], [9, 2], [3, 7]]) {
    const cow = makeAnimal(s, 'cow', s.farmer.x + dx, s.farmer.y + dy);
    cow.stock = 2;
    cow.food = 1e9;
    cow.water = 1e9;
  }

  for (let i = 0; i < 200; i++) tick(s);

  assertEqual(s.animals.every((a) => a.stock === 0), true, 'every cow was milked');
  for (const hand of hands) {
    assert(carriedTotal(hand) > 0, 'every hand did some of it');
  }
});

test('a full farmhand still goes home when there is work about', () => {
  // One hand, so nobody else can do the job and muddy the point.
  const { s, hand } = farmWithHand(9924);
  hand.carrying = { egg: HAND_CAPACITY };
  hand.x = s.farmer.x + 9;
  hand.y = s.farmer.y + 9;
  const cow = makeAnimal(s, 'cow', hand.x + 1, hand.y);
  cow.stock = 4;

  for (let i = 0; i < 300; i++) tick(s);

  assert(s.buildings.some((b) => besideBox(b.x, b.y, 3, 2, hand.x, hand.y)),
    'it went to a barn');
  assertEqual(cow.stock, 4, 'and walked past the cow rather than working with full hands');
});

test('a farmhand crosses the farm for work rather than only what is underfoot', () => {
  // A real farm is wider than any sensible sight radius. Animals are a short
  // list, so there is no reason to cap how far a hand will walk for one — and
  // capping it left a third of a real farm never serviced.
  const { s, hand } = farmWithHand(9925);
  const cow = makeAnimal(s, 'cow', s.farmer.x + 18, s.farmer.y + 12);
  cow.stock = 2;
  cow.food = 1e9;
  cow.water = 1e9;

  for (let i = 0; i < 900; i++) tick(s);
  assertEqual(cow.stock, 0, 'it walked the whole way and milked her');
});

// --- crates -------------------------------------------------------------

/** A farm with a hand and a crate two tiles east of the farmer. */
function farmWithCrate(seed = 9950) {
  const { s, hand } = farmWithHand(seed);
  const cx = s.farmer.x + 2;
  const cy = s.farmer.y;
  completeBuild(s, { buildKind: 'crate', x: cx, y: cy });
  return { s, hand, cx, cy };
}

test('a crate takes its type from the first thing put in it', () => {
  const { s, cx, cy } = farmWithCrate(9950);
  const crate = crateAt(s, cx, cy);
  assertEqual(crate.item, null, 'a new crate is nothing in particular');
  assert(crateAccepts(crate, 'egg'), 'so it will take eggs');
  assert(crateAccepts(crate, 'milk'), 'or milk');

  depositInto(s, cx, cy, { egg: 5 });
  assertEqual(crate.item, 'egg', 'the first delivery decided');
  assertEqual(crate.qty, 5, 'and it holds them');
  assert(crateAccepts(crate, 'egg'), 'more eggs are welcome');
  assert(!crateAccepts(crate, 'milk'), 'but milk is not — one kind to a crate');
});

test('emptying a crate frees it to hold something else', () => {
  const { s, cx, cy } = farmWithCrate(9951);
  depositInto(s, cx, cy, { egg: 5 });

  assertEqual(emptyCrate(s, cx, cy), { egg: 5 }, 'everything comes out');
  const crate = crateAt(s, cx, cy);
  assertEqual(crate.qty, 0, 'leaving it empty');
  assertEqual(crate.item, null, 'and unclaimed again');
  assert(crateAccepts(crate, 'milk'), 'so it will take milk now');
  assertEqual(emptyCrate(s, cx, cy), {}, 'and emptying an empty crate yields nothing');
});

test('a crate takes what fits and never destroys the rest', () => {
  const { s, cx, cy } = farmWithCrate(9952);
  depositInto(s, cx, cy, { egg: CRATE_CAPACITY - 3 });

  const took = depositInto(s, cx, cy, { egg: 10 });
  assertEqual(took, { egg: 3 }, 'only the three there was room for');
  assertEqual(crateAt(s, cx, cy).qty, CRATE_CAPACITY, 'full, not over');
  assertEqual(crateRoom(crateAt(s, cx, cy)), 0, 'and no room left');
  assertEqual(depositInto(s, cx, cy, { egg: 1 }), {}, 'a full crate takes nothing');
});

test('a crate only takes the part of a mixed load it is holding', () => {
  const { s, cx, cy } = farmWithCrate(9953);
  depositInto(s, cx, cy, { egg: 1 });

  const took = depositInto(s, cx, cy, { egg: 4, milk: 6, wool: 2 });
  assertEqual(took, { egg: 4 }, 'the eggs went in, the rest did not');
  assertEqual(crateAt(s, cx, cy).qty, 5, 'five eggs all told');
});

test('a full farmhand stows its load in a crate and gets back to work', () => {
  const { s, hand, cx, cy } = farmWithCrate(9954);
  hand.carrying = { egg: HAND_CAPACITY };
  assert(isFull(hand), 'pockets full — nothing else can be gathered');

  for (let i = 0; i < 400; i++) tick(s);

  assertEqual(carriedTotal(hand), 0, 'the hand is empty again');
  assertEqual(crateAt(s, cx, cy).qty, HAND_CAPACITY, 'it is all in the crate');
  assertEqual(crateAt(s, cx, cy).item, 'egg', 'which is an egg crate now');
  assertEqual(countItem(s, 'egg'), 0, 'and still none of it in your bag');
});

test('a hand keeps what the crate will not take and finds another for it', () => {
  // The mixed-cargo case: an egg crate takes the eggs, and the milk has to go
  // somewhere else rather than being dropped or stuck.
  const { s, hand, cx, cy } = farmWithCrate(9955);
  depositInto(s, cx, cy, { egg: 1 });
  // Noted now rather than read back later: the farmer walks, so s.farmer.x
  // after a few hundred ticks is not where the crate was put.
  const mx = s.farmer.x + 4;
  const my = s.farmer.y;
  completeBuild(s, { buildKind: 'crate', x: mx, y: my });
  hand.carrying = { egg: 10, milk: 8 };

  for (let i = 0; i < 600; i++) tick(s);

  assertEqual(crateAt(s, cx, cy).qty, 11, 'the eggs joined the egg crate');
  assertEqual(crateAt(s, mx, my).item, 'milk', 'the milk found its own');
  assertEqual(crateAt(s, mx, my).qty, 8, 'all of it');
  assertEqual(carriedTotal(hand), 0, 'and the hand is empty');
});

test('with no crate that will take it, a hand waits by the barn as it always did', () => {
  const { s, hand, cx, cy } = farmWithCrate(9956);
  depositInto(s, cx, cy, { egg: CRATE_CAPACITY });     // full, and eggs only
  hand.carrying = { milk: HAND_CAPACITY };

  for (let i = 0; i < 400; i++) tick(s);

  assertEqual(carriedTotal(hand), HAND_CAPACITY, 'still holding the milk');
  assertEqual(crateAt(s, cx, cy).qty, CRATE_CAPACITY, 'the full crate is untouched');
  const barn = s.buildings.find((b) => b.type === 'barn');
  const near = Math.abs(hand.x - barn.x) <= barn.w + 1 && Math.abs(hand.y - barn.y) <= barn.h + 1;
  assert(near, 'and waiting by the barn for you');
});

test('gathering beats stowing: a hand with room milks the cow first', () => {
  const { s, hand, cx, cy } = farmWithCrate(9957);
  hand.carrying = { egg: 2 };
  const cow = makeAnimal(s, 'cow', s.farmer.x + 1, s.farmer.y + 1);
  cow.stock = 2;

  for (let i = 0; i < 120; i++) tick(s);

  assert(cow.stock < 2, 'the cow was seen to before the errand');
});

test('tapping a crate empties it into your bag', () => {
  const { s, cx, cy } = farmWithCrate(9958);
  depositInto(s, cx, cy, { egg: 40 });

  const spec = taskForTile(s, cx, cy, 'auto');
  assertEqual(spec.type, 'unload', 'tapping it offers to empty it');
  addTask(s, spec);

  let n = 0;
  while (s.tasks.length && n < 3000) { tick(s); n++; }

  assertEqual(countItem(s, 'egg'), 40, 'the eggs are yours');
  assertEqual(crateAt(s, cx, cy).qty, 0, 'and the crate is empty');
});

test('an empty crate is not worth walking over to', () => {
  const { s, cx, cy } = farmWithCrate(9959);
  const spec = taskForTile(s, cx, cy, 'auto');
  assert(!spec || spec.type !== 'unload', 'nothing in it to take');
});

test('taking a crate down hands back its contents as well as its timber', () => {
  const { s, cx, cy } = farmWithCrate(9960);
  depositInto(s, cx, cy, { milk: 12 });
  const before = countItem(s, 'wood');

  addTask(s, taskForTile(s, cx, cy, 'clear'));
  let n = 0;
  while (s.tasks.length && n < 3000) { tick(s); n++; }

  assertEqual(countItem(s, 'milk'), 12, 'the milk was not burnt with the box');
  assert(countItem(s, 'wood') > before, 'and some timber came back');
  assertEqual(crateAt(s, cx, cy), null, 'the crate is gone');
  assertEqual(s.grid.getObject(cx, cy), OBJ.NONE, 'and so is its mark');
});

test('crates survive a save round trip, contents and all', () => {
  const { s, cx, cy } = farmWithCrate(9961);
  depositInto(s, cx, cy, { wool: 33 });

  const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));
  assertEqual(crateAt(back, cx, cy), { item: 'wool', qty: 33 }, 'still a wool crate');
  assertEqual(back.grid.getObject(cx, cy), OBJ.CRATE, 'still standing there');
});

test('a farm saved before crates existed loads without any', () => {
  const s = farmWithMaterials(9962);
  const data = JSON.parse(JSON.stringify(serialize(s)));
  delete data.crates;                       // exactly what an older save looks like

  const back = deserialize(data);
  assertEqual(back.crates, {}, 'no crates, and nothing broken');
  assertEqual(crateAt(back, 5, 5), null, 'looking one up is simply nothing');
});

test('crate records and grid marks are put back in step on load', () => {
  const { s, cx, cy } = farmWithCrate(9963);
  depositInto(s, cx, cy, { egg: 4 });

  // A record whose tile is no longer a crate, and a mark with no record.
  s.crates['3,3'] = { item: 'milk', qty: 9 };
  s.grid.setObject(cx + 2, cy, OBJ.CRATE);

  const fixed = reconcileCrates(s);
  assertEqual(fixed.dropped, 1, 'the record standing on nothing was dropped');
  assertEqual(fixed.adopted, 1, 'and the unrecorded crate adopted');
  assertEqual(crateAt(s, 3, 3), null, 'gone');
  assertEqual(crateAt(s, cx + 2, cy), { item: null, qty: 0 }, 'and the new one is empty');
  assertEqual(crateAt(s, cx, cy).qty, 4, 'the real crate was left alone');
});

test('the nearest crate that will take it is the one chosen', () => {
  const { s, cx, cy } = farmWithCrate(9964);
  completeBuild(s, { buildKind: 'crate', x: s.farmer.x + 6, y: s.farmer.y });
  depositInto(s, cx, cy, { milk: 1 });          // near, but it is a milk crate

  const spot = findCrateFor(s, { egg: 3 }, { x: s.farmer.x, y: s.farmer.y });
  assertEqual(spot, { x: s.farmer.x + 6, y: s.farmer.y }, 'walked past the one that would not take eggs');

  assertEqual(findCrateFor(s, {}, { x: s.farmer.x, y: s.farmer.y }), null, 'carrying nothing, no errand');
  assertEqual(findCrateFor(s, { egg: 0 }, { x: s.farmer.x, y: s.farmer.y }), null, 'nor for nothing');
});

test('a crate holds more than a farmhand, which is the point of it', () => {
  assert(CRATE_CAPACITY > HAND_CAPACITY, 'otherwise it would not be worth the walk');
});

test('farmhands survive a save round trip, cargo and all', () => {
  const { s, hand } = farmWithHand(9910);
  hand.carrying = { egg: 4, milk: 1 };
  hand.facing = 'left';

  const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));
  assertEqual(back.hands.length, 1, 'still hired');
  assertEqual(back.hands[0].carrying, { egg: 4, milk: 1 }, 'still holding what they held');
  assertEqual(back.hands[0].id, hand.id, 'and still the same person');
});

test('a farmhand gathers while you are away, and it shows up on your return', () => {
  const { s, hand } = farmWithHand(9911);
  const cow = makeAnimal(s, 'cow', s.farmer.x + 4, s.farmer.y + 2);
  cow.food = 1e9;
  cow.water = 1e9;

  suspend();
  startTally();
  for (let i = 0; i < 4 * 60 * 60; i++) tick(s);
  const tally = stopTally();
  resume();

  assert(carriedTotal(hand) > 0, 'they worked while nobody was watching');
  assert((tally.counts['hand:gathered'] || 0) > 0, 'and it was counted for the summary');
});

// --- ducks --------------------------------------------------------------

test('a duck swims and everything else does not', () => {
  assert(SWIMMERS.has('duck'), 'the duck is the swimmer');
  for (const type of ['chicken', 'cow', 'sheep']) {
    assert(!SWIMMERS.has(type), `a ${type} cannot swim`);
  }

  const s = farmWithMaterials(9800);
  const x = s.farmer.x + 4;
  const y = s.farmer.y;
  s.grid.setGround(x, y, GROUND.WATER);
  assert(canPlaceAnimal(s, x, y, 'duck'), 'a duck can be put straight on the pond');
  assert(!canPlaceAnimal(s, x, y, 'chicken'), 'a hen cannot');
});

test('a duck heads for the water when it has nothing else to do', () => {
  const s = farmWithMaterials(9801);
  completeBuild(s, { buildKind: 'barn', x: s.farmer.x - 1, y: s.farmer.y - 4 });
  // A pond a few tiles away, and a duck on dry land beside it.
  const px = s.farmer.x + 4;
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
    s.grid.setGround(px + dx, s.farmer.y + dy, GROUND.WATER);
  }
  const duck = makeAnimal(s, 'duck', px - 1, s.farmer.y);
  duck.food = 1e9;
  duck.water = 1e9;

  let onWater = false;
  for (let i = 0; i < 2000 && !onWater; i++) {
    tick(s);
    onWater = isWater(s.grid.getGround(duck.x, duck.y));
  }
  assert(onWater, 'it should have taken to the water');
});

test('a duck spends its life on the water, going ashore only to lay', () => {
  // Measured as time spent wet, not as where it happens to be standing when
  // the test stops. A duck ashore on a laying errand is a duck doing its job,
  // and a snapshot catches one at random — that assertion passed or failed on
  // the seed rather than on the behaviour, and adding flowers to the tick
  // shifted the dice enough to expose it.
  const s = farmWithMaterials(9804);
  completeBuild(s, { buildKind: 'barn', x: s.farmer.x - 1, y: s.farmer.y - 4 });
  const px = s.farmer.x + 4;
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
    s.grid.setGround(px + dx, s.farmer.y + dy, GROUND.WATER);
  }
  const duck = makeAnimal(s, 'duck', px + 1, s.farmer.y + 1);
  duck.food = 1e9;
  duck.water = 1e9;

  // Long enough to lay several times over, so any inland drift would compound.
  let wet = 0;
  const ticks = ANIMALS.duck.produceTicks * 4;
  for (let i = 0; i < ticks; i++) {
    tick(s);
    if (isWater(s.grid.getGround(duck.x, duck.y))) wet++;
  }

  const share = wet / ticks;
  assert(share > 0.9, `it was only on the water ${Math.round(share * 100)}% of the time`);
});

test('a duck comes ashore to lay, and never lays on the pond', () => {
  const s = farmWithMaterials(9802);
  completeBuild(s, { buildKind: 'barn', x: s.farmer.x - 1, y: s.farmer.y - 4 });
  const px = s.farmer.x + 4;
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
    s.grid.setGround(px + dx, s.farmer.y + dy, GROUND.WATER);
  }
  const duck = makeAnimal(s, 'duck', px + 1, s.farmer.y + 1);   // mid-pond
  duck.food = 1e9;
  duck.water = 1e9;

  for (let i = 0; i < ANIMALS.duck.produceTicks * 3; i++) tick(s);

  const eggs = [];
  s.grid.objects.forEach((o, i) => {
    if (o === OBJ.EGG) eggs.push({ x: i % s.grid.w, y: Math.floor(i / s.grid.w) });
  });
  assert(eggs.length > 0, 'it laid at least one egg');
  for (const e of eggs) {
    assert(!isWater(s.grid.getGround(e.x, e.y)), `an egg is floating at ${e.x},${e.y}`);
    assert(s.grid.isOwned(e.x, e.y), 'and it is somewhere it can be picked up');
  }
});

test('an egg is never laid where it could never be collected', () => {
  // Both cases are permanent losses: nothing can be picked up off water, and
  // no task at all can be queued on land the player does not own.
  const s = farmWithMaterials(9803);
  const x = s.farmer.x + 3;
  const y = s.farmer.y;

  assert(canLayAt(s, x, y), 'open owned grass is fine');

  s.grid.setGround(x, y, GROUND.WATER);
  assert(!canLayAt(s, x, y), 'not on water');

  s.grid.setGround(x, y, GROUND.GRASS);
  const outside = { x: 5, y: 5 };                 // far outside the starting cell
  s.grid.owned.delete(plotIndex(0, 0, s.grid.w));
  assert(!s.grid.isOwned(outside.x, outside.y), 'the test tile is off the farm');
  assert(!canLayAt(s, outside.x, outside.y), 'nor on land you do not own');
});

test('a duck lays faster than a hen, for a higher price', () => {
  assert(ANIMALS.duck.produceTicks < ANIMALS.chicken.produceTicks, 'ducks lay sooner');
  assert(ANIMALS.duck.price > ANIMALS.chicken.price, 'and cost more up front');
  assertEqual(ANIMALS.duck.produces, 'egg', 'both give eggs');
  assert(ANIMALS.duck.laysOnGround, 'and a duck drops them like a hen does');
});

// --- affection ----------------------------------------------------------

test('petting an animal raises its affection, up to a limit', () => {
  const { s, animal } = farmWithAnimal('cow', 8100);
  assertEqual(animal.affection, 0, 'a new animal is unattached');

  const first = petAnimal(s, animal);
  assertEqual(first.gained, PET_GAIN, 'a fuss counts for something');
  assertEqual(animal.affection, PET_GAIN, 'and lands on the animal');

  for (let i = 0; i < 50; i++) {
    s.tickCount += PET_COOLDOWN + 1;
    petAnimal(s, animal);
  }
  assertEqual(animal.affection, AFFECTION_MAX, 'affection tops out rather than running away');
});

test('petting again straight away is welcome but does not count', () => {
  // Affection is earned by visiting often, not by tapping fast.
  const { s, animal } = farmWithAnimal('chicken', 8101);
  petAnimal(s, animal);

  const again = petAnimal(s, animal);
  assertEqual(again.gained, 0, 'no second helping within the cooldown');
  assertEqual(animal.affection, PET_GAIN, 'affection is unchanged');

  s.tickCount += PET_COOLDOWN + 1;
  assertEqual(petAnimal(s, animal).gained, PET_GAIN, 'but later it counts again');
});

test('petting too often does not push the reward further away', () => {
  // The trap: stamping the cooldown on every tap slides the window forward, so
  // a player who greets their animals on every visit gains nothing, ever.
  const { s, animal } = farmWithAnimal('cow', 8109);
  petAnimal(s, animal);
  assertEqual(animal.affection, PET_GAIN, 'the first fuss counts');

  // Keep petting throughout the cooldown, as anyone actually playing would.
  for (let i = 0; i < PET_COOLDOWN; i++) {
    s.tickCount += 1;
    petAnimal(s, animal);
  }
  assertEqual(animal.affection, PET_GAIN * 2,
    'the moment the cooldown is up, the next fuss counts — no matter how many came before');
});

test('a loved animal eats and drinks less', () => {
  const plain = farmWithAnimal('cow', 8102);
  const loved = farmWithAnimal('cow', 8102);
  loved.animal.affection = AFFECTION_MAX;

  for (let i = 0; i < 600; i++) { tick(plain.s); tick(loved.s); }

  assert(loved.animal.food > plain.animal.food,
    `loved ${loved.animal.food} should outlast plain ${plain.animal.food}`);
  assert(loved.animal.water > plain.animal.water, 'and stay watered longer');
});

test('a loved animal produces faster', () => {
  const plain = farmWithAnimal('cow', 8103);
  const loved = farmWithAnimal('cow', 8103);
  loved.animal.affection = AFFECTION_MAX;

  for (let i = 0; i < 600; i++) { tick(plain.s); tick(loved.s); }

  assert(loved.animal.progress > plain.animal.progress,
    `loved ${loved.animal.progress} should be ahead of plain ${plain.animal.progress}`);
});

test('affection never decays, however long you are away', () => {
  // Same reasoning as animals never dying: a week's absence must not undo
  // something the player did deliberately.
  const { s, animal } = farmWithAnimal('cow', 8104);
  animal.affection = AFFECTION_MAX;

  for (let i = 0; i < 7 * 24 * 60 * 60; i++) tick(s);

  assertEqual(animal.affection, AFFECTION_MAX, 'still just as fond of you');
});

test('affection survives a save round trip', () => {
  const { s, animal } = farmWithAnimal('chicken', 8105);
  petAnimal(s, animal);

  const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));
  assertEqual(back.animals[0].affection, PET_GAIN, 'affection is part of the farm');
  // -Infinity would come back as null and read as "never petted", which would
  // hand out a free helping of affection on every reload.
  assertEqual(back.animals[0].pettedAt, s.tickCount, 'and so is when it was last petted');
  assertEqual(petAnimal(back, back.animals[0]).gained, 0, 'so the cooldown still applies');
});

test('an animal says what it needs before it says how it feels', () => {
  const { s, animal } = farmWithAnimal('cow', 8106);
  animal.affection = AFFECTION_MAX;

  animal.water = 0;
  assertEqual(pickEmote(s, animal), 'droplets', 'thirst comes first');

  animal.food = 0;
  assertEqual(pickEmote(s, animal), 'angry', 'hungry *and* thirsty is worth saying loudly');

  animal.water = 9999;
  assertEqual(pickEmote(s, animal), 'sad', 'then hunger on its own');

  animal.food = 9999;
  animal.stock = 1;
  assertEqual(pickEmote(s, animal), 'star', 'then something to collect');

  animal.stock = 0;
  assertEqual(pickEmote(s, animal), 'heart', 'and only then, how it feels about you');

  animal.affection = 0;
  assert(['sleep', 'dots'].includes(pickEmote(s, animal)), 'an indifferent animal is dull');
});

test('petting shows hearts, and emotes expire on their own', () => {
  const { s, animal } = farmWithAnimal('chicken', 8107);
  petAnimal(s, animal);
  assertEqual(currentEmote(animal, s.tickCount), 'hearts', 'a fuss is worth a bubble');

  assertEqual(currentEmote(animal, s.tickCount + EMOTE_TICKS), null, 'and it does not stick');
});

test('emotes are part of the sim, so they replay identically', () => {
  const a = farmWithAnimal('cow', 8108);
  const b = farmWithAnimal('cow', 8108);
  for (let i = 0; i < 2000; i++) { tick(a.s); tick(b.s); }
  assertEqual(serialize(b.s), serialize(a.s), 'two identical farms must stay identical');
});

// --- animal colours -----------------------------------------------------

/** Width and height of a PNG, straight out of its IHDR chunk. */
function pngSize(path) {
  const buf = readFileSync(path);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

test('every barn edge tile actually carries its edge', () => {
  // The sheet is generated (tools/make-barn-sheet.mjs), and a generated asset
  // fails quietly: an edge that never got stamped just leaves a roof with a
  // gap in it, which nothing else here would notice. This caught exactly that
  // — an edit removed the two lines that draw the near edge, and the roof went
  // out with a bottom edge only under its ridge.
  const sheet = decodePng('assets/barn.png');
  const OUTLINE = [0x3f, 0x26, 0x31];

  const rowIs = (col, row, y, colour) => {
    for (let x = 0; x < TILE; x++) {
      const i = ((row * TILE + y) * sheet.width + col * TILE + x) * 4;
      // The ridge board runs to the edge rather than being cut by it.
      const isBoard = sheet.rgba[i] === 0xdf && sheet.rgba[i + 1] === 0xa9;
      if (isBoard) continue;
      if (sheet.rgba[i] !== colour[0] || sheet.rgba[i + 1] !== colour[1]
        || sheet.rgba[i + 2] !== colour[2]) return false;
    }
    return true;
  };

  for (const [name, col, row] of [['topD', 10, 0], ['topL', 11, 0], ['topRidge', 10, 1]]) {
    assert(rowIs(col, row, 0, OUTLINE) && rowIs(col, row, 1, OUTLINE),
      `${name} should be outlined along its top`);
  }
  for (const [name, col, row] of [['botD', 8, 1], ['botL', 9, 1], ['botRidge', 11, 1]]) {
    assert(rowIs(col, row, 14, OUTLINE) && rowIs(col, row, 15, OUTLINE),
      `${name} should be outlined along its bottom`);
  }

  // And the fills must have no edge at all, or a wide roof grows stripes.
  for (const [name, col, row] of [['fillD', 8, 0], ['fillL', 9, 0]]) {
    assert(!rowIs(col, row, 0, OUTLINE), `${name} should be plain roof, not an edge`);
    assert(!rowIs(col, row, 15, OUTLINE), `${name} should be plain roof, not an edge`);
  }
});

test('a barn is laid out to the same height however wide it gets', () => {
  // The whole reason for this roof shape. A gable climbs a row for every tile
  // of width, which is what buried the farm behind a big barn.
  const small = barnGrid(3, 2);
  assertEqual(small.above, 2, 'the smallest barn hangs two rows over its footprint');
  assertEqual(small.wall.length, 2, 'and its wall is the footprint');

  assertEqual(barnGrid(5, 3).above, 2, 'five wide, still two');
  assertEqual(barnGrid(7, 3).above, 2, 'seven wide, still two');
  assert(barnGrid(9, 5).above <= 3, 'nine wide grows by one row, not four');

  // Every roof row is the full width of the barn, gaps included, and the wall
  // sits exactly under it.
  const big = barnGrid(9, 4);
  for (const row of big.rows) assertEqual(row.length, 9, 'roof rows span the barn');
  for (const row of big.wall) assertEqual(row.length, 9, 'so do wall rows');
  assertEqual(big.wall.length, 4, 'wall is as deep as the footprint');
});

test('the animal sheet and the animal definitions agree', () => {
  // The sheet is art the game indexes into by row and column. If a row is
  // added to ANIMALS without a row on the sheet, that animal draws nothing —
  // and nothing else would catch it, since the renderer has no canvas here.
  const { w, h } = pngSize('assets/animals/farm.png');
  const cols = w / TILE;
  const rows = h / TILE;
  assertEqual(w % TILE, 0, 'the sheet is a whole number of tiles wide');
  assertEqual(h % TILE, 0, 'and tall');

  for (const [type, def] of Object.entries(ANIMALS)) {
    assert(Number.isInteger(def.row), `${type} needs a row on the sheet`);
    assert(def.row < rows, `${type} wants row ${def.row}, the sheet has ${rows}`);
  }
  assertEqual(new Set(Object.values(ANIMALS).map((d) => d.row)).size,
    Object.keys(ANIMALS).length, 'every animal has its own row');

  // Whatever the sheet's width, that's how many colours the game offers.
  setAnimalVariants(cols);
  assertEqual(animalVariantCount(), cols, 'the count comes off the sheet');
  setAnimalVariants(ANIMAL_VARIANTS);
});

test('a bought animal gets a colour, and not always the same one', () => {
  const s = farmWithMaterials(9400);
  completeBuild(s, { buildKind: 'barn', x: s.farmer.x - 1, y: s.farmer.y - 4 });
  s.money = 100000;

  const seen = new Set();
  for (let i = 0; i < 24; i++) {
    const animal = makeAnimal(s, 'cow', s.farmer.x + 1, s.farmer.y);
    assert(Number.isInteger(animal.variant), 'every animal is born some colour');
    assert(animal.variant >= 0 && animal.variant < animalVariantCount(),
      `variant ${animal.variant} is off the sheet`);
    seen.add(animal.variant);
  }
  assert(seen.size > 1, 'two dozen cows should not all be the same colour');
});

test('an animal keeps its colour for life, and through a save', () => {
  const { s, animal } = farmWithAnimal('sheep', 9401);
  const born = animal.variant;

  for (let i = 0; i < 60 * 60; i++) tick(s);
  assertEqual(animal.variant, born, 'an hour of wandering does not change it');

  const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));
  assertEqual(back.animals[0].variant, born, 'nor does putting the farm away');
});

test('buying is deterministic, so catching up agrees on the colours', () => {
  const a = farmWithAnimal('cow', 9402);
  const b = farmWithAnimal('cow', 9402);
  assertEqual(b.animal.variant, a.animal.variant, 'same seed, same colour');
});

test('an animal from a sheet with more colours than we have now still draws', () => {
  // Variants are stored on the animal. If the sheet ever loses a column, the
  // stored index would point off the end of it and the animal would vanish.
  const { animal } = farmWithAnimal('cow', 9403);
  animal.variant = 99;
  assertEqual(variantOf(animal), animalVariantCount() - 1, 'clamped to a real column');
});

test('animals from before colours are spread across them, not all identical', () => {
  const s = farmWithMaterials(9404);
  completeBuild(s, { buildKind: 'barn', x: s.farmer.x - 1, y: s.farmer.y - 4 });
  for (let i = 0; i < 4; i++) makeAnimal(s, 'chicken', s.farmer.x + 1, s.farmer.y);

  // How that farm was written before animals had a colour.
  const old = JSON.parse(JSON.stringify(serialize(s)));
  old.version = 4;
  for (const a of old.animals) delete a.variant;

  const back = deserialize(migrate(old));
  for (const a of back.animals) {
    assert(Number.isInteger(a.variant), 'every old animal is given a colour');
    assert(a.variant >= 0 && a.variant < ANIMAL_VARIANTS, 'a real one');
  }
  assert(new Set(back.animals.map((a) => a.variant)).size > 1,
    'an established farm should not turn into a herd of clones');
});

// --- work follows the animal --------------------------------------------

test('milking happens at the cow, not where it was when you tapped it', () => {
  const { s, animal } = farmWithAnimal('cow', 9700);
  animal.stock = 1;

  const task = addTask(s, taskForTile(s, animal.x, animal.y, 'auto'));
  assertEqual(task.type, 'collect', 'tapping a ready cow queues a milking');
  const queuedAt = { x: task.x, y: task.y };

  // The cow wanders off before the farmer gets there.
  animal.x += 6;
  animal.y += 3;
  followTargets(s);

  assertEqual(task.x, animal.x, 'the task went with it');
  assertEqual(task.y, animal.y, 'on both axes');
  assert(task.x !== queuedAt.x || task.y !== queuedAt.y, 'and is no longer where it was tapped');
});

test('the farmer walks to the cow and comes back with the milk', () => {
  const { s, animal } = farmWithAnimal('cow', 9701);
  animal.stock = 2;
  animal.x = s.farmer.x + 10;                       // well across the field
  animal.y = s.farmer.y + 6;

  addTask(s, taskForTile(s, animal.x, animal.y, 'auto'));
  let n = 0;
  while (s.tasks.length && n < 2000) { tick(s); n++; }

  assertEqual(countItem(s, 'milk'), 2, 'the milk is in the bag');
  assertEqual(animal.stock, 0, 'and the cow has been emptied');
  // He has to have actually got there — collecting from across the farm is the
  // bug this is guarding.
  const away = Math.abs(s.farmer.x - animal.x) + Math.abs(s.farmer.y - animal.y);
  assert(away <= 2, `the farmer should be at the cow, not ${away} tiles away`);
});

test('an animal stands still while it is being tended', () => {
  const { s, animal } = farmWithAnimal('sheep', 9702);
  animal.stock = 1;
  addTask(s, taskForTile(s, animal.x, animal.y, 'auto'));

  // Give the farmer time to claim it, then watch the sheep for a good while.
  tick(s);
  const held = { x: animal.x, y: animal.y };
  for (let i = 0; i < 60 && s.tasks.length; i++) tick(s);

  assertEqual({ x: animal.x, y: animal.y }, held, 'it waited to be sheared');
});

test('tapping a ready animal twice queues one job, not two', () => {
  // The task moves with the animal, so the one-per-tile check cannot catch a
  // second tap from a different spot.
  const { s, animal } = farmWithAnimal('cow', 9703);
  animal.stock = 1;

  assert(addTask(s, taskForTile(s, animal.x, animal.y, 'auto')), 'first tap queues it');
  animal.x += 3;
  followTargets(s);
  assertEqual(addTask(s, taskForTile(s, animal.x, animal.y, 'auto')), null,
    'the second tap is refused, wherever it lands');
  assertEqual(s.tasks.length, 1, 'one milking, not two');
});

test('work aimed at a sold animal is dropped, not left pointing at nothing', () => {
  const { s, animal } = farmWithAnimal('cow', 9704);
  animal.stock = 1;
  addTask(s, taskForTile(s, animal.x, animal.y, 'auto'));

  s.animals = [];                                   // sold at the shop
  followTargets(s);
  assertEqual(s.tasks.length, 0, 'the milking went with it');
});

// --- a build site is reserved while it waits ----------------------------

test('a queued build reserves the ground it will stand on', () => {
  const s = farmWithMaterials(9600);
  const x = s.farmer.x + 4;
  const y = s.farmer.y + 4;
  addTask(s, taskForTile(s, x, y, 'build', { buildKind: 'barn' }));

  const tiles = footprint('barn', x, y);
  for (const t of tiles) assert(isReserved(s, t.x, t.y), `${t.x},${t.y} is spoken for`);
  assert(!isReserved(s, x - 1, y), 'but only the footprint');
});

test('nothing sprouts on a site a build is waiting for', () => {
  // A barn takes two minutes. Without this, a mushroom appearing in the
  // footprint is paved over and its record stranded — unforageable forever,
  // and permanently eating a slot in the spawn cap.
  const s = farmWithMaterials(9601);
  const x = s.farmer.x + 4;
  const y = s.farmer.y + 4;
  addTask(s, taskForTile(s, x, y, 'build', { buildKind: 'barn' }));

  for (const t of footprint('barn', x, y)) {
    assert(!canSproutShroom(s, t.x, t.y), 'no mushrooms on the site');
    assert(!canSprout(s, t.x, t.y), 'and no weeds either');
  }
});

test('two builds cannot claim the same ground', () => {
  const s = farmWithMaterials(9602);
  const x = s.farmer.x + 4;
  const y = s.farmer.y + 4;
  addTask(s, taskForTile(s, x, y, 'build', { buildKind: 'barn' }));

  // Overlapping, not identical — the queue's own duplicate check wouldn't
  // catch this, and the second build would pay for one that overwrote the first.
  assert(!canPlaceAt(s, 'barn', x + 1, y), 'no overlapping barn');
  assert(!canPlaceAt(s, 'fence', x, y), 'nor a fence through the middle of it');
  assertEqual(taskForTile(s, x + 1, y, 'build', { buildKind: 'barn' }), null,
    'so no task is offered');
  assert(canPlaceAt(s, 'barn', x + 4, y), 'clear of it is still fine');
});

test('a build site cannot be ploughed out from under itself', () => {
  const s = farmWithMaterials(9603);
  const x = s.farmer.x + 4;
  const y = s.farmer.y + 4;
  addTask(s, taskForTile(s, x, y, 'build', { buildKind: 'barn' }));

  assertEqual(taskForTile(s, x, y, 'till'), null, 'no tilling the site');
  // Clearing is still allowed: pulling a rock off the site helps, not hinders.
  s.grid.setObject(x, y, OBJ.ROCK);
  assert(taskForTile(s, x, y, 'clear'), 'but a rock in the way can still be cleared');
});

test('the farmer clears the site and keeps what he finds', () => {
  // A hen lays where she stands, so an egg can still turn up on a reserved
  // site. The build must not be cancelled and the egg must not vanish.
  const s = farmWithMaterials(9604);
  const x = s.farmer.x + 4;
  const y = s.farmer.y + 4;
  const task = taskForTile(s, x, y, 'build', { buildKind: 'barn' });
  addTask(s, task);

  const spot = footprint('barn', x, y)[1];
  s.grid.setObject(spot.x, spot.y, OBJ.EGG);

  const gained = clearBuildSite(s, task);
  assertEqual(gained, { egg: 1 }, 'the egg goes in the bag');
  assertEqual(countItem(s, 'egg'), 1, 'really in the bag');
  assertEqual(s.grid.getObject(spot.x, spot.y), OBJ.NONE, 'and off the site');

  assert(completeBuild(s, task), 'and the barn still goes up');
  assertEqual(s.buildings.length, 1, 'exactly one barn');
});

test('a mushroom on a build site is picked, not paved over', () => {
  const s = farmWithMaterials(9605);
  const x = s.farmer.x + 4;
  const y = s.farmer.y + 4;
  const task = taskForTile(s, x, y, 'build', { buildKind: 'barn' });
  addTask(s, task);

  const spot = footprint('barn', x, y)[2];
  sprout(s, spot.x, spot.y, 'red_toadstool');

  clearBuildSite(s, task);
  completeBuild(s, task);

  assertEqual(countItem(s, 'mushroom_toadstool'), 1, 'it went in the bag');
  assertEqual(journalCount(s, 'red_toadstool'), 1, 'and into the journal');
  assertEqual(s.mushrooms[`${spot.x},${spot.y}`], undefined,
    'and left no record stranded under the barn');
});

test('an unaffordable build costs nothing, not even what is lying on the site', () => {
  const s = farmWithMaterials(9606);
  s.inventory = {};                                  // no materials at all
  const x = s.farmer.x + 4;
  const y = s.farmer.y + 4;
  const task = { type: 'build', buildKind: 'barn', x, y, work: 1, progress: 0 };

  const spot = footprint('barn', x, y)[0];
  s.grid.setObject(spot.x, spot.y, OBJ.EGG);

  assert(!canCompleteBuild(s, task), 'it cannot be paid for');
  assertEqual(s.grid.getObject(spot.x, spot.y), OBJ.EGG,
    'so the site is left alone rather than cleared for nothing');
});

test('the reservation lifts when the build is done or cancelled', () => {
  const s = farmWithMaterials(9607);
  const x = s.farmer.x + 4;
  const y = s.farmer.y + 4;
  const task = addTask(s, taskForTile(s, x, y, 'build', { buildKind: 'barn' }));
  assert(isReserved(s, x, y), 'reserved while it waits');

  cancelTask(s, task.id);
  assert(!isReserved(s, x, y), 'and free again once the order is cancelled');
  assert(canSproutShroom(s, x, y), 'so mushrooms may come back');
});

// --- water --------------------------------------------------------------

test('water is dug for free and can be filled back in', () => {
  const s = farmWithMaterials(9500);
  s.inventory = {};
  const x = s.farmer.x + 6;
  const y = s.farmer.y + 6;

  for (const kind of ['pond', 'river']) {
    assert(canAfford(s, kind).ok, `${kind} costs only the digging`);
    assert(canPlaceAt(s, kind, x, y), `${kind} goes on open grass`);
    completeBuild(s, { buildKind: kind, x, y });
    assert(isWater(s.grid.getGround(x, y)), `${kind} leaves water behind`);
    assertEqual(structureAt(s, x, y).kind, kind, 'the clear tool can find it');
    assert(demolish(s, x, y).ok, 'and fill it back in');
    assertEqual(s.grid.getGround(x, y), GROUND.GRASS, 'leaving grass');
  }
});

test('nobody walks on water', () => {
  const s = farmWithMaterials(9501);
  const x = s.farmer.x + 4;
  const y = s.farmer.y;
  s.grid.setGround(x, y, GROUND.WATER);

  assert(!s.grid.isWalkable(x, y, 'farmer'), 'the farmer stays out');
  assert(!s.grid.isWalkable(x, y, 'animal'), 'and so does the livestock');
  assert(s.grid.isWalkable(x, y, 'swimmer'), 'but a swimmer could cross it');

  s.grid.setGround(x, y, GROUND.RIVER);
  assert(!s.grid.isWalkable(x, y, 'farmer'), 'a river stops him too');
});

test('a swimmer is still livestock: a gate holds it in', () => {
  // The seam for ducks must not accidentally let them through fences.
  const s = farmWithMaterials(9502);
  const x = s.farmer.x + 2;
  const y = s.farmer.y;
  s.grid.setObject(x, y, OBJ.GATE);

  assert(s.grid.isWalkable(x, y, 'farmer'), 'the farmer opens gates');
  assert(!s.grid.isWalkable(x, y, 'swimmer'), 'a swimmer does not');
});

test('water is never dug out from under anyone', () => {
  // It blocks, so an animal standing there would be marooned on its own tile.
  const s = farmWithMaterials(9503);
  completeBuild(s, { buildKind: 'barn', x: s.farmer.x - 1, y: s.farmer.y - 4 });
  const animal = makeAnimal(s, 'cow', s.farmer.x + 3, s.farmer.y);

  assert(!canPlaceAt(s, 'pond', animal.x, animal.y), 'not under the cow');
  assert(!canPlaceAt(s, 'pond', s.farmer.x, s.farmer.y), 'nor under the farmer');
  assert(canPlaceAt(s, 'pond', s.farmer.x + 5, s.farmer.y), 'but open ground is fine');

  // A road may still be laid underfoot — it doesn't block, so nobody is stuck.
  assert(canPlaceAt(s, 'dirtRoad', s.farmer.x, s.farmer.y), 'a path underfoot is harmless');
});

test('nothing can be built on water', () => {
  const s = farmWithMaterials(9504);
  const x = s.farmer.x + 4;
  const y = s.farmer.y + 4;
  s.grid.setGround(x, y, GROUND.WATER);

  assert(!canPlaceAt(s, 'fence', x, y), 'no fence in a pond');
  assert(!canPlaceAt(s, 'dirtRoad', x, y), 'and no path across it — take it up first');
  assertEqual(taskForTile(s, x, y, 'till'), null, 'nor can it be ploughed');
});

test('an animal drinks from a pond it can reach', () => {
  const { s, animal } = farmWithAnimal('cow', 9505);
  s.troughs = {};                                   // no trough anywhere
  s.grid.setGround(animal.x + 2, animal.y, GROUND.WATER);
  animal.water = 1;

  for (let i = 0; i < 200; i++) tick(s);

  assert(animal.water > SEEK_THRESHOLD, `it should have found the pond (water ${animal.water})`);
  assert(!isThirsty(animal), 'and stopped being thirsty');
});

test('a pond never runs dry, unlike a trough', () => {
  // The reward for digging one: an animal that can reach water stops needing
  // you to carry any.
  const { s, animal } = farmWithAnimal('sheep', 9506);
  s.troughs = {};
  s.grid.setGround(animal.x + 2, animal.y, GROUND.WATER);

  for (let i = 0; i < 6 * 60 * 60; i++) tick(s);
  assert(!isThirsty(animal), 'six hours later it is still watered');
});

test('an animal fenced away from water still goes thirsty', () => {
  const { s, animal } = farmWithAnimal('cow', 9507);
  s.troughs = {};
  // Penned in on all four sides — a line of fence isn't enough, it would just
  // walk round the end.
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
    s.grid.setObject(animal.x + dx, animal.y + dy, OBJ.FENCE);
  }
  s.grid.setGround(animal.x + 2, animal.y, GROUND.WATER);
  animal.water = 1;

  for (let i = 0; i < 600; i++) tick(s);
  assert(isThirsty(animal), 'it cannot drink what it cannot get to');
  assert(s.animals.includes(animal), 'and it is still alive, as ever');
});

test('a river picks its piece from what it connects to', () => {
  const s = farmWithMaterials(9508);
  const ox = 20;
  const oy = 20;
  const lay = (dx, dy) => s.grid.setGround(ox + dx, oy + dy, GROUND.RIVER);
  const at = (dx, dy) => riverPieceAt(s, ox + dx, oy + dy);

  // A vertical run, then a bend east along the bottom.
  for (let i = 0; i < 4; i++) lay(0, i);
  for (let i = 1; i < 4; i++) lay(i, 3);

  assertEqual(at(0, 1).sprite, RIVER.straight, 'the run is a straight');
  assertEqual(at(0, 1).turns, 0, 'unturned, because it runs north-south');
  assertEqual(at(0, 3).sprite, RIVER.NE, 'the bend comes from the north, leaves east');
  assertEqual(at(2, 3).sprite, RIVER.straight, 'the arm is a straight');
  assertEqual(at(2, 3).turns, 1, 'turned a quarter, because it runs east-west');
});

test('a river junction and a lone tile both fall back to open water', () => {
  // Neither has a tile on the sheet, and a pool is a fair reading of both.
  const s = farmWithMaterials(9509);
  const ox = 20;
  const oy = 20;

  assertEqual(riverPieceAt(s, ox, oy).sprite, RIVER.pool, 'nothing connected yet');

  for (const [dx, dy] of [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
    s.grid.setGround(ox + dx, oy + dy, GROUND.RIVER);
  }
  assertEqual(riverPieceAt(s, ox, oy).sprite, RIVER.pool, 'a crossroads is a pool');
});

test('a river runs into a pond without a seam', () => {
  // The two grounds autotile against each other, or the join would show as a
  // hard edge between them.
  const s = farmWithMaterials(9510);
  const ox = 20;
  const oy = 20;
  s.grid.setGround(ox, oy - 1, GROUND.RIVER);
  s.grid.setGround(ox, oy, GROUND.RIVER);
  s.grid.setGround(ox, oy + 1, GROUND.WATER);

  assertEqual(riverPieceAt(s, ox, oy).sprite, RIVER.straight, 'the river reads as continuing');
  // And the pond counts the river as water on its northern edge.
  const pond = autotileQuadrants(isWaterAt(s), ox, oy + 1);
  assert(pond.tl !== 'innerTL' && pond.tr !== 'innerTR', 'no notch where they meet');
});

test('a pond autotiles like the dirt road, corners and all', () => {
  const s = farmWithMaterials(9511);
  const ox = 20;
  const oy = 20;
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
    s.grid.setGround(ox + dx, oy + dy, GROUND.WATER);
  }
  const at = (dx, dy) => autotileQuadrants(isWaterAt(s), ox + dx, oy + dy);

  assertEqual(at(0, 0).tl, 'TL', 'top-left bank');
  assertEqual(at(1, 1), { tl: 'C', tr: 'C', bl: 'C', br: 'C' }, 'open water in the middle');
  assertEqual(at(2, 2).br, 'BR', 'bottom-right bank');

  // Dig an L and the inside of the bend gets a wedge, as the dirt road does.
  const l = farmWithMaterials(9512);
  for (const [dx, dy] of [[1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]]) {
    l.grid.setGround(ox + dx, oy + dy, GROUND.WATER);
  }
  assertEqual(autotileQuadrants(isWaterAt(l), ox + 1, oy + 1).tl, 'innerTL',
    'grass tucked into the bend');
});

test('a half-dug pond has no bare edges and no beach in the middle', () => {
  // The shape that started this: a 3x2 pond with the top-middle tile not yet
  // dug. Every tile around the gap must be banked on every side that touches
  // grass — including the two that have grass on three sides at once, which a
  // nine-slice has no tile for and used to draw as a hard cut.
  const s = farmWithMaterials(9513);
  const ox = 20;
  const oy = 20;
  for (const [dx, dy] of [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]]) {
    s.grid.setGround(ox + dx, oy + dy, GROUND.WATER);
  }
  const at = (dx, dy) => autotileQuadrants(isWaterAt(s), ox + dx, oy + dy);

  assertEqual(at(0, 0), { tl: 'TL', tr: 'TR', bl: 'L', br: 'R' },
    'the arm beside the gap is banked on both sides, not cut off square');
  assertEqual(at(2, 0), { tl: 'TL', tr: 'TR', bl: 'L', br: 'R' }, 'and so is the other one');
});

test('water still to be dug is drawn as part of the pond', () => {
  // Queued but not yet dug: counted as water while working out the banks, so
  // the outline is right from the moment it is ordered. Otherwise the pond
  // grows a fresh set of wrong edges after every tile the farmer finishes.
  const s = farmWithMaterials(9514);
  const ox = 20;
  const oy = 20;
  for (const [dx, dy] of [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]]) {
    s.grid.setGround(ox + dx, oy + dy, GROUND.WATER);
  }
  addTask(s, taskForTile(s, ox + 1, oy, 'build', { buildKind: 'pond' }));

  const planned = pendingWaterTiles(s);
  assert(planned.has(`${ox + 1},${oy}`), 'the ordered tile counts as water-to-be');

  const at = (dx, dy) => autotileQuadrants(isWaterAt(s, planned), ox + dx, oy + dy);
  assertEqual(at(0, 0), { tl: 'TL', tr: 'T', bl: 'L', br: 'C' },
    'the arm now reads as the side of a pond, not a spur');
  assertEqual(at(1, 0), { tl: 'T', tr: 'T', bl: 'C', br: 'C' },
    'and the gap is drawn as the top edge it is about to become');
});

// --- the dirt road ------------------------------------------------------

test('a dirt road costs nothing but the walking, and reverts to grass', () => {
  const s = farmWithMaterials(9300);
  s.inventory = {};                       // empty bag on purpose
  const x = s.farmer.x + 5;
  const y = s.farmer.y + 5;

  assert(canAfford(s, 'dirtRoad').ok, 'earth is free; the cost is the farmer\'s time');
  assert(canPlaceAt(s, 'dirtRoad', x, y), 'it goes on open grass');
  completeBuild(s, { buildKind: 'dirtRoad', x, y });
  assertEqual(s.grid.getGround(x, y), GROUND.DIRT, 'and lays bare earth');

  assert(!canPlaceAt(s, 'dirtRoad', x, y), 'laying it twice is a no-op, not a double charge');
  assertEqual(structureAt(s, x, y).kind, 'dirtRoad', 'the clear tool can find it again');
  assert(demolish(s, x, y).ok, 'and take it up');
  assertEqual(s.grid.getGround(x, y), GROUND.GRASS, 'leaving grass, not a scar');
});

test('a dirt road is not the same thing as the stone road', () => {
  // Two separate buildables sharing one tool; mixing their ground ids up would
  // make demolishing one take up the other.
  assert(buildDef('road').ground !== buildDef('dirtRoad').ground, 'different ground');
  assertEqual(kindForGround(GROUND.DIRT), 'dirtRoad', 'earth belongs to the dirt road');
  assertEqual(kindForGround(GROUND.ROAD), 'road', 'and cobbles to the stone one');
});

test('a dirt road draws its edges and corners from the right pieces', () => {
  // A nine-slice is easy to get subtly wrong, and wrong here means a farm full
  // of hard square edges. Assert the piece each quarter of each tile comes from.
  const s = farmWithMaterials(9301);
  const ox = 20;
  const oy = 20;
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
    s.grid.setGround(ox + dx, oy + dy, GROUND.DIRT);
  }
  const at = (dx, dy) => autotileQuadrants(isDirt(s), ox + dx, oy + dy);

  assertEqual(at(0, 0), { tl: 'TL', tr: 'T', bl: 'L', br: 'C' }, 'top-left tile');
  assertEqual(at(1, 0), { tl: 'T', tr: 'T', bl: 'C', br: 'C' }, 'top edge');
  assertEqual(at(2, 0), { tl: 'T', tr: 'TR', bl: 'C', br: 'R' }, 'top-right tile');
  assertEqual(at(1, 1), { tl: 'C', tr: 'C', bl: 'C', br: 'C' }, 'the middle is plain earth');
  assertEqual(at(0, 2), { tl: 'L', tr: 'C', bl: 'BL', br: 'B' }, 'bottom-left tile');
  assertEqual(at(2, 2), { tl: 'C', tr: 'R', bl: 'B', br: 'BR' }, 'bottom-right tile');
});

test('the inside of a bend gets a grass wedge, not plain earth', () => {
  // This is what the sheet's four extra pieces exist for. Without them the
  // turn draws as solid earth with a square notch of grass sitting in it.
  const ox = 20;
  const oy = 20;
  const around = [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]];

  const bend = (missing) => {
    const s = farmWithMaterials(9302);
    for (const [dx, dy] of around) {
      if (dx === missing[0] && dy === missing[1]) continue;
      s.grid.setGround(ox + dx, oy + dy, GROUND.DIRT);
    }
    return autotileQuadrants(isDirt(s), ox + 1, oy + 1);
  };

  assertEqual(bend([0, 0]).tl, 'innerTL', 'grass tucked into the top-left of the bend');
  assertEqual(bend([2, 0]).tr, 'innerTR', 'top-right');
  assertEqual(bend([0, 2]).bl, 'innerBL', 'bottom-left');
  assertEqual(bend([2, 2]).br, 'innerBR', 'bottom-right');
  assertEqual(bend([0, 0]).br, 'C', 'and the far side of the tile is untouched');
});

test('a crossroads gets all four wedges, not one of them', () => {
  // Every diagonal is grass here. Picking a single tile for the cell could
  // only ever get one of the four corners right.
  const s = farmWithMaterials(9303);
  const ox = 20;
  const oy = 20;
  for (let i = 0; i < 5; i++) {
    s.grid.setGround(ox + i, oy + 2, GROUND.DIRT);
    s.grid.setGround(ox + 2, oy + i, GROUND.DIRT);
  }
  assertEqual(autotileQuadrants(isDirt(s), ox + 2, oy + 2),
    { tl: 'innerTL', tr: 'innerTR', bl: 'innerBL', br: 'innerBR' },
    'a wedge in every corner');
});

test('a dirt road still to be laid is drawn as part of the path', () => {
  // Same treatment as water: the ordered tiles count while the edges are
  // worked out, so a path has the shape it is going to be rather than growing
  // a new end cap after every tile the farmer finishes.
  const s = farmWithMaterials(9307);
  const ox = 20;
  const oy = 20;
  for (let i = 0; i < 3; i++) s.grid.setGround(ox + i, oy, GROUND.DIRT);
  addTask(s, taskForTile(s, ox + 3, oy, 'build', { buildKind: 'dirtRoad' }));

  const planned = pendingGroundTiles(s);
  assertEqual(planned.get(`${ox + 3},${oy}`), GROUND.DIRT, 'the ordered tile knows what it will be');

  const plannedDirt = new Set([...planned].filter(([, g]) => g === GROUND.DIRT).map(([k]) => k));
  const laid = autotileQuadrants(isDirt(s), ox + 2, oy);
  const withPlan = autotileQuadrants(isDirt(s, plannedDirt), ox + 2, oy);

  assertEqual(laid.tr, 'TR', 'on its own the path ends in a cap');
  assertEqual(withPlan.tr, 'T', 'but with the rest ordered it reads as carrying on');
});

test('a pending build of something that is not ground is ignored', () => {
  // Only ground buildables have a preview; a barn is drawn by its own record.
  const s = farmWithMaterials(9308);
  addTask(s, taskForTile(s, 20, 20, 'build', { buildKind: 'barn' }));
  assertEqual(pendingGroundTiles(s).size, 0, 'nothing to preview');
});

test('a one-tile-wide arm is banked on both sides', () => {
  // The case a nine-slice cannot express: grass on three sides at once. It
  // used to fall back to a straight edge and leave two sides of the tile as
  // bare fill butting into grass — the hard cut at the end of every path.
  const s = farmWithMaterials(9304);
  const ox = 20;
  const oy = 20;
  s.grid.setGround(ox, oy, GROUND.DIRT);          // the tip
  s.grid.setGround(ox, oy + 1, GROUND.DIRT);      // ...of a vertical arm

  assertEqual(autotileQuadrants(isDirt(s), ox, oy),
    { tl: 'TL', tr: 'TR', bl: 'L', br: 'R' },
    'capped on top, banked left and right');
});

test('a single lonely tile is banked on all four sides', () => {
  const s = farmWithMaterials(9305);
  s.grid.setGround(20, 20, GROUND.DIRT);
  assertEqual(autotileQuadrants(isDirt(s), 20, 20),
    { tl: 'TL', tr: 'TR', bl: 'BL', br: 'BR' }, 'a tile on its own is all corners');
});

test('a solid field needs no wedges at all', () => {
  const s = farmWithMaterials(9306);
  for (let dy = 0; dy < 5; dy++) for (let dx = 0; dx < 5; dx++) {
    s.grid.setGround(20 + dx, 20 + dy, GROUND.DIRT);
  }
  assertEqual(autotileQuadrants(isDirt(s), 22, 22),
    { tl: 'C', tr: 'C', bl: 'C', br: 'C' }, 'nothing to tuck in');
});

// --- mushrooms ----------------------------------------------------------

test('the sheet is fully catalogued: seven kinds, five colours each', () => {
  const kinds = Object.keys(SPECIES).length;
  const expected = kinds * COLOURS_PER_SPECIES;
  assertEqual(MUSHROOMS.length, expected, `${expected} mushrooms in the catalogue`);
  assertEqual(new Set(MUSHROOMS.map((m) => m.sprite)).size, expected, 'each with its own sprite');
  assertEqual(new Set(MUSHROOMS.map((m) => m.id)).size, expected, 'and its own name');
  for (const [species, def] of Object.entries(SPECIES)) {
    assertEqual(MUSHROOMS.filter((m) => m.species === species).length, COLOURS_PER_SPECIES,
      `${species} should have five colours`);
    assert(ITEMS[def.item], `${species} needs somewhere to go in the bag`);
    assert(def.sell > 0, `${species} needs to be worth something`);
  }
});

test('the catalogue matches the sheet on disk', () => {
  // The sprites are indices into one long row, and the sheet is art that gets
  // replaced from outside the code. A mushroom pointing past the end of it
  // draws nothing at all, and nothing else here would notice.
  const { w, h } = pngSize('assets/flora/mushrooms.png');
  assertEqual(h, TILE, 'the sheet is a single row');
  assertEqual(w % TILE, 0, 'a whole number of sprites wide');
  assertEqual(w / TILE, MUSHROOMS.length, 'with exactly as many sprites as there are mushrooms');
  for (const m of MUSHROOMS) {
    assert(m.sprite >= 0 && m.sprite < w / TILE, `${m.id} points at a sprite that exists`);
  }
});

test('the rainbow one is the rare find', () => {
  // It is the fifth colour of every kind and it looks like a prize, so it must
  // not turn up as often as the other four. Rolled rather than reasoned: the
  // weights and the roll have to agree.
  const s = { rng: makeRng(4242) };
  let rainbows = 0;
  const rolls = 4000;
  for (let i = 0; i < rolls; i++) if (isRainbow(rollColour(s, 'button'))) rainbows++;
  const rate = rainbows / rolls;
  assert(rate > 0.02 && rate < 0.06, `about one in twenty-five, got one in ${Math.round(1 / rate)}`);
});

test('adding colours did not rename anything already found', () => {
  // A journal entry is keyed by colour and species. Reordering the colours
  // would quietly rename every mushroom anybody has ever collected, so the
  // four that were always there keep their ids and their order.
  for (const id of ['tan_button', 'red_toadstool', 'umber_bolete', 'ash_morel']) {
    assert(MUSHROOMS_BY_ID[id], `${id} is still in the catalogue`);
  }
  const toadstools = MUSHROOMS.filter((m) => m.species === 'toadstool').map((m) => m.id);
  assertEqual(toadstools.slice(0, 4),
    ['red_toadstool', 'green_toadstool', 'pink_toadstool', 'navy_toadstool'],
    'in the order they have always been in');
  assertEqual(toadstools[4], 'rainbow_toadstool', 'with the new one appended');
});

test('a new farm has mushrooms already up, near the farmhouse', () => {
  // Otherwise the first one appears somewhere on 1,600 tiles at some point in
  // the first hour, which is a poor way to discover the game has foraging.
  const s = newGameRaw(9100);
  const keys = Object.keys(s.mushrooms);
  assert(keys.length >= 1, 'at least one is waiting to be found');

  for (const key of keys) {
    const [x, y] = key.split(',').map(Number);
    const away = Math.max(Math.abs(x - s.farmer.x), Math.abs(y - s.farmer.y));
    assert(away <= 6, `${key} is ${away} tiles off — it should be in plain sight`);
    assertEqual(s.grid.getObject(x, y), OBJ.MUSHROOM, 'and drawn on the grid');
    assert(mushroomAt(s, x, y), 'and knows which mushroom it is');
  }
});

test('rarer mushrooms are worth more', () => {
  const byWeight = Object.values(SPECIES).slice().sort((a, b) => b.weight - a.weight);
  for (let i = 1; i < byWeight.length; i++) {
    assert(byWeight[i].sell > byWeight[i - 1].sell,
      `${byWeight[i].name} is rarer than ${byWeight[i - 1].name}, so it must pay better`);
  }
});

test('mushrooms come up on open grass, and are capped', () => {
  const s = weedableFarm(9001);
  const seeded = Object.keys(s.mushrooms).length;   // the starting few

  for (let i = 0; i < 24 * 60 * 60; i++) tick(s);

  const cap = Math.max(1, Math.floor(s.grid.owned.size * PLOT * PLOT * MUSHROOM_MAX_FRACTION));
  const grown = Object.keys(s.mushrooms).length;
  assert(grown > seeded, 'a day should turn up more than the farm started with');
  assert(grown <= cap, `${grown} mushrooms against a cap of ${cap}`);

  // Every one has a tile marked for it, or the renderer would draw nothing.
  for (const key of Object.keys(s.mushrooms)) {
    const [x, y] = key.split(',').map(Number);
    assertEqual(s.grid.getObject(x, y), OBJ.MUSHROOM, `${key} is marked on the grid`);
    assert(s.grid.isOwned(x, y), 'and is on land you own');
  }
});

test('mushrooms never take a bed, a crop or an occupied tile', () => {
  const s = weedableFarm(9002);
  const x = s.farmer.x + 2;
  const y = s.farmer.y - 4;

  s.grid.setGround(x, y, GROUND.TILLED);
  assert(!canSproutShroom(s, x, y), 'not on a bed');

  s.grid.setGround(x, y, GROUND.GRASS);
  s.grid.setObject(x, y, OBJ.WEED);
  assert(!canSproutShroom(s, x, y), 'not where a weed already is');

  s.grid.setObject(x, y, OBJ.NONE);
  assert(canSproutShroom(s, x, y), 'but open grass, yes');
});

test('picking a mushroom banks it and writes it into the journal', () => {
  const s = weedableFarm(9003);
  const x = s.farmer.x + 2;
  const y = s.farmer.y;
  sprout(s, x, y, 'red_toadstool');

  // The clear tool is what picks it up, like anything else lying about.
  const spec = taskForTile(s, x, y, 'clear');
  assertEqual(spec.type, 'forage', 'the clear tool offers to pick it');
  assertEqual(spec.detail, 'Red toadstool', 'and says which one it is');

  const gained = forage(s, x, y);
  assertEqual(gained, { mushroom_toadstool: 1 }, 'a toadstool goes in the bag');
  assertEqual(countItem(s, 'mushroom_toadstool'), 1, 'as its species, not its colour');
  assertEqual(journalCount(s, 'red_toadstool'), 1, 'the journal remembers the colour');
  assertEqual(s.grid.getObject(x, y), OBJ.NONE, 'and the tile is clear again');
  assertEqual(s.mushrooms[`${x},${y}`], undefined, 'with nothing left behind');
});

test('selling mushrooms never erases what you found', () => {
  // The journal is a record of finds, not a view of the bag. Cashing in a
  // collection you spent a week building would be a rotten thing to do.
  const s = weedableFarm(9004);
  sprout(s, s.farmer.x + 1, s.farmer.y, 'ash_morel');
  forage(s, s.farmer.x + 1, s.farmer.y);

  sellAll(s, 'mushroom_morel');
  assertEqual(countItem(s, 'mushroom_morel'), 0, 'sold');
  assertEqual(journalCount(s, 'ash_morel'), 1, 'still found');
  assertEqual(journalFound(s), 1, 'and still counted in the journal');
});

test('the journal counts finds, not what you are carrying', () => {
  const s = weedableFarm(9005);
  for (let i = 0; i < 3; i++) {
    sprout(s, s.farmer.x + 1, s.farmer.y, 'blue_button');
    forage(s, s.farmer.x + 1, s.farmer.y);
  }
  assertEqual(journalCount(s, 'blue_button'), 3, 'three of that colour picked');
  assertEqual(journalFound(s), 1, 'but only one kind discovered');

  const rows = journalRows(s);
  assertEqual(rows.length, MUSHROOMS.length, 'the journal lists every kind, found or not');
  assertEqual(rows.filter((r) => r.found === 0).length, MUSHROOMS.length - 1,
    'the rest are still out there');
});

test('mushrooms and the journal survive a save round trip', () => {
  const s = weedableFarm(9006);
  sprout(s, s.farmer.x + 1, s.farmer.y, 'orange_bolete');
  sprout(s, s.farmer.x + 2, s.farmer.y, 'pink_morel');
  forage(s, s.farmer.x + 1, s.farmer.y);

  const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));
  assertEqual(back.journal, s.journal, 'the journal is part of the farm');
  assertEqual(back.mushrooms, s.mushrooms, 'and so is what is still growing');
  // The one still standing must be the same one, not a fresh roll.
  assertEqual(mushroomAt(back, s.farmer.x + 2, s.farmer.y).id, 'pink_morel',
    'a find stays the find it was');
});

test('foraging replays identically, so catching up finds the same mushrooms', () => {
  const a = weedableFarm(9007);
  const b = weedableFarm(9007);
  for (let i = 0; i < 6 * 60 * 60; i++) { tick(a); tick(b); }
  assertEqual(serialize(b), serialize(a), 'two identical farms must stay identical');
  assert(Object.keys(a.mushrooms).length > 0, 'and that run should have grown some');
});

test('common mushrooms turn up far more often than rare ones', () => {
  const s = weedableFarm(9008);
  const rolled = {};
  for (let i = 0; i < 4000; i++) {
    const id = rollSpecies(s);
    const sp = MUSHROOMS_BY_ID[id].species;
    rolled[sp] = (rolled[sp] || 0) + 1;
  }
  assert(rolled.button > rolled.toadstool, 'buttons beat toadstools');
  assert(rolled.toadstool > rolled.bolete, 'toadstools beat boletes');
  assert(rolled.bolete > (rolled.morel || 0), 'and a morel is a genuine find');
  assert((rolled.morel || 0) > 0, 'though one does turn up eventually');
});

// --- weeds regrowing ----------------------------------------------------

/** A farm with one plot, cleared of everything, so weeds are the only variable. */
function weedableFarm(seed = 7000) {
  const s = newGameRaw(seed);
  s.grid.objects.fill(OBJ.NONE);
  // The object grid and state.mushrooms have to agree: clearing the grid alone
  // would leave mushrooms recorded on tiles that no longer show one.
  s.mushrooms = {};
  s.buildings = [];
  // newGame stamps Date.now(), so two farms built either side of a millisecond
  // boundary aren't identical. Pin it, the way twinGames does.
  s.lastTickTime = 0;
  return s;
}

test('weeds come back on cleared land', () => {
  const s = weedableFarm(7001);
  assertEqual(countWeeds(s), 0, 'starts clear');

  for (let i = 0; i < WEED_INTERVAL * 3 + 1; i++) tick(s);
  assert(countWeeds(s) > 0, 'a tidied farm does not stay tidy forever');
});

test('weeds stop at a fraction of the land, however long you are away', () => {
  // The property that makes this safe to leave running: a week away must not
  // bury the farm. Whatever the elapsed time, the worst case is the same.
  const s = weedableFarm(7002);
  const cap = Math.floor(s.grid.owned.size * PLOT * PLOT * WEED_MAX_FRACTION);

  for (let i = 0; i < 7 * 24 * 60 * 60; i++) tick(s);

  const weeds = countWeeds(s);
  assert(weeds <= cap, `a week away left ${weeds} weeds, cap is ${cap}`);
  assert(weeds >= cap - 1, `and it should reach the cap, not stall at ${weeds}`);
});

test('owning more land means more weeds to keep down', () => {
  const small = weedableFarm(7003);
  const big = weedableFarm(7003);
  const { px, py } = plotOfTile(big.farmer.x, big.farmer.y);
  big.money = 100000;
  buyPlot(big, px + 1, py);
  buyPlot(big, px - 1, py);
  for (let i = big.grid.w * 0; i < 1; i++) big.grid.objects.fill(OBJ.NONE);

  for (let i = 0; i < 24 * 60 * 60; i++) { tick(small); tick(big); }

  assert(countWeeds(big) > countWeeds(small),
    'upkeep should scale with the farm, not stay fixed');
});

test('weeds never sprout on beds, crops, roads or anything already there', () => {
  const s = weedableFarm(7004);
  const { x, y } = { x: s.farmer.x + 2, y: s.farmer.y - 4 };

  s.grid.setGround(x, y, GROUND.TILLED);
  assert(!canSprout(s, x, y), 'not on a bed');

  s.grid.setGround(x, y, GROUND.GRASS);
  plantCrop(s, x, y, 'carrot');
  assert(!canSprout(s, x, y), 'not on a crop');
  delete s.crops[`${x},${y}`];

  s.grid.setGround(x, y, GROUND.ROAD);
  assert(!canSprout(s, x, y), 'not on a road');

  s.grid.setGround(x, y, GROUND.GRASS);
  s.grid.setObject(x, y, OBJ.ROCK);
  assert(!canSprout(s, x, y), 'not on top of a rock');

  s.grid.setObject(x, y, OBJ.NONE);
  assert(canSprout(s, x, y), 'but plain grass, yes');

  assert(!canSprout(s, s.farmer.x, s.farmer.y), 'and never underfoot');
});

test('weeds never sprout on land you do not own', () => {
  const s = weedableFarm(7005);
  const { px, py } = plotOfTile(s.farmer.x, s.farmer.y);
  const outside = plotBounds(px, py).x0 - 1;
  assert(!canSprout(s, outside, s.farmer.y), 'the neighbour keeps his own weeds');

  // A long run must not touch it either.
  for (let i = 0; i < 24 * 60 * 60; i++) tick(s);
  assertEqual(s.grid.getObject(outside, s.farmer.y), OBJ.NONE, 'still clear over there');
});

test('weed regrowth is deterministic, so catching up twice agrees', () => {
  // The whole offline design rests on this: replaying the same elapsed time
  // must produce the same farm, weeds included.
  const a = weedableFarm(7006);
  const b = weedableFarm(7006);
  for (let i = 0; i < WEED_INTERVAL * 40; i++) { tick(a); tick(b); }
  assertEqual(serialize(b), serialize(a), 'two identical farms must stay identical');
});

test('a weed that grows while you are away is counted for the summary', () => {
  const s = weedableFarm(7007);
  suspend();
  startTally();
  for (let i = 0; i < WEED_INTERVAL * 3 + 1; i++) tick(s);
  const tally = stopTally();
  resume();

  assert((tally.counts['weed:grown'] || 0) > 0, 'the summary can say weeds sprang up');
});

test('clearing a weed makes room for another', () => {
  // Regrowth replaces what you clear rather than piling on top of it, which is
  // what keeps the chore constant instead of compounding.
  const s = weedableFarm(7008);
  for (let i = 0; i < 24 * 60 * 60; i++) tick(s);
  const atCap = countWeeds(s);

  // Pull one by hand, as the farmer would.
  outer: for (let y = 0; y < s.grid.h; y++) {
    for (let x = 0; x < s.grid.w; x++) {
      if (s.grid.getObject(x, y) === OBJ.WEED && s.grid.isOwned(x, y)) {
        s.grid.setObject(x, y, OBJ.NONE);
        break outer;
      }
    }
  }
  assertEqual(countWeeds(s), atCap - 1, 'one fewer for now');

  for (let i = 0; i < WEED_INTERVAL * 8; i++) tick(s);
  assertEqual(countWeeds(s), atCap, 'and it grows back');
});

// --- land ---------------------------------------------------------------

test('a new farm owns exactly one plot, and the whole farmstead is inside it', () => {
  const s = newGameRaw(6100);
  assertEqual(s.grid.owned.size, 1, 'one plot to start');

  const { px, py } = plotOfTile(s.farmer.x, s.farmer.y);
  const b = plotBounds(px, py);
  assert(s.grid.owned.has(plotIndex(px, py, s.grid.w)), 'the plot you stand in');

  // The barn is five rows tall as drawn: three of overhanging roof above two of
  // body. All of it has to sit inside owned land or the roof renders dimmed.
  const barn = s.buildings[0];
  assert(barn, 'a new farm has its barn');
  assert(barn.y - 3 >= b.y0, `barn roof starts at ${barn.y - 3}, plot at ${b.y0}`);
  assert(barn.y + 1 < b.y1, 'barn body ends inside the plot');
  assert(barn.x >= b.x0 && barn.x + 2 < b.x1, 'barn fits across the plot');
});

test('nothing can be queued on land you do not own', () => {
  const s = newGameRaw(6101);
  const { px, py } = plotOfTile(s.farmer.x, s.farmer.y);
  const outside = { x: plotBounds(px, py).x0 - 1, y: s.farmer.y };
  assert(!s.grid.isOwned(outside.x, outside.y), 'the test tile is off the farm');

  // A tree just over the line is still a tree; it just isn't the player's.
  s.grid.setObject(outside.x, outside.y, OBJ.TREE);
  assertEqual(taskForTile(s, outside.x, outside.y, 'chop'), null, 'no chopping it');
  assertEqual(taskForTile(s, outside.x, outside.y, 'auto'), null, 'nor by the auto tool');
  assert(!canPlaceAt(s, 'fence', outside.x, outside.y), 'nothing built on it either');
});

test('the farmer and the animals both stop at the boundary', () => {
  const s = newGameRaw(6102);
  const { px, py } = plotOfTile(s.farmer.x, s.farmer.y);
  const b = plotBounds(px, py);
  s.grid.objects.fill(OBJ.NONE);

  assert(s.grid.isWalkable(b.x0, s.farmer.y, 'farmer'), 'inside is walkable');
  assert(!s.grid.isWalkable(b.x0 - 1, s.farmer.y, 'farmer'), 'the farmer stays in');
  assert(!s.grid.isWalkable(b.x0 - 1, s.farmer.y, 'animal'), 'and so do the animals');

  // Pathfinding must not route through unowned land to save a step.
  const path = findPath(s.grid, { x: b.x0, y: b.y0 }, { x: b.x1 - 1, y: b.y1 - 1 });
  assert(path, 'a path across your own land exists');
  assert(path.every((t) => s.grid.isOwned(t.x, t.y)), 'and never leaves it');
});

test('land is bought a plot at a time, and only next to what you own', () => {
  const s = newGameRaw(6103);
  const { px, py } = plotOfTile(s.farmer.x, s.farmer.y);
  s.money = 100000;

  assert(!canBuyPlot(s, px, py).ok, 'not the plot you already own');
  assert(!canBuyPlot(s, px + 1, py - 1).ok, 'not a corner, which only touches diagonally');
  assert(!canBuyPlot(s, px + 1, py + 1).ok, 'not diagonally — corners do not touch');
  assert(canBuyPlot(s, px + 1, py).ok, 'the plot next door, yes');

  const price = nextLandPrice(s);
  const res = buyPlot(s, px + 1, py);
  assert(res.ok, 'the purchase goes through');
  assertEqual(s.money, 100000 - price, 'and costs what it said it would');
  assertEqual(s.grid.owned.size, 2, 'two plots now');

  // Owning it changes what is reachable next: the corner beyond it now has an
  // orthogonal neighbour, so it comes up for sale.
  assert(canBuyPlot(s, px + 1, py - 1).ok, 'the corner opens up once its neighbour is yours');
});

test('land you cannot afford is refused without charging you', () => {
  const s = newGameRaw(6104);
  const { px, py } = plotOfTile(s.farmer.x, s.farmer.y);
  s.money = 10;

  const res = buyPlot(s, px + 1, py);
  assert(!res.ok, 'refused');
  assertEqual(s.money, 10, 'and nothing taken');
  assertEqual(s.grid.owned.size, 1, 'and no land granted');
});

test('each plot costs more than the last', () => {
  assertEqual(landPrice(1) < landPrice(2), true, 'the second is dearer than the first');
  assertEqual(landPrice(5) < landPrice(6), true, 'and it keeps climbing');

  // The whole valley should be a long game, not an afternoon's harvest.
  const s = newGameRaw(6105);
  let total = 0;
  for (let n = 1; n < totalPlots(s); n++) total += landPrice(n);
  assert(total > 20000, `buying the map should be a real goal, not $${total}`);
});

test('buying land where you own everything offers nothing', () => {
  const s = ownEverything(newGameRaw(6106));
  assertEqual(buyablePlots(s).length, 0, 'nothing left to buy');
});

test('ownership survives a save round trip', () => {
  const s = newGameRaw(6107);
  const { px, py } = plotOfTile(s.farmer.x, s.farmer.y);
  s.money = 100000;
  buyPlot(s, px + 1, py);

  const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));
  assertEqual(Array.from(back.grid.owned).sort(), Array.from(s.grid.owned).sort(),
    'the deeds are part of the save');
});

test('an old save keeps the whole of its map, not just the parts it used', () => {
  // Before this, a farm was a single 40x40 map and every tile of it was the
  // player's. That map becomes the middle cell and they keep all of it — the
  // land they gain the option to buy is new country beyond it.
  const s = newGameRaw(6108);
  const v1 = oldWorldSave(s);

  const migrated = migrate(v1);
  const live = deserialize(migrated);

  assertEqual(live.grid.owned.size, 1, 'exactly the cell they had');
  assertEqual(Array.from(live.grid.owned), [centreCellIndex()], 'the middle one');

  // Every tile of the old map, corners included, is theirs — not just the
  // parts they happened to have built on.
  for (const [x, y] of [[0, 0], [CELL_W - 1, 0], [0, CELL_H - 1], [CELL_W - 1, CELL_H - 1]]) {
    assert(live.grid.isOwned(x + CELL_W, y + CELL_H), `old tile ${x},${y} is still theirs`);
  }
  assert(!live.grid.isOwned(0, 0), 'and the new country around it is not');
});

test('migrating moves the whole farm into the middle cell together', () => {
  // A farm with one of everything that carries a coordinate, all of it inside
  // the cell that becomes the middle one.
  const s = newGameRaw(6109);
  const bed = { x: s.farmer.x + 3, y: s.farmer.y + 3 };
  s.grid.setObject(bed.x, bed.y, OBJ.NONE);
  s.grid.setGround(bed.x, bed.y, GROUND.TILLED);
  plantCrop(s, bed.x, bed.y, 'carrot');
  waterTile(s, bed.x, bed.y);

  const chicken = makeAnimal(s, 'chicken', s.farmer.x + 5, s.farmer.y + 5);
  s.tasks = [{ id: 1, type: 'clear', x: s.farmer.x + 7, y: s.farmer.y, work: 5, progress: 0 }];
  const trough = { x: s.farmer.x - 6, y: s.farmer.y + 6 };
  placeStructure(s, 'waterTrough', trough.x, trough.y);

  const was = {
    farmer: { ...s.farmer }, barn: { ...s.buildings[0] },
    chicken: { x: chicken.x, y: chicken.y },
  };
  const live = deserialize(migrate(oldWorldSave(s)));

  // Everything lands back where it started: shifted out by a cell to build the
  // old save, shifted back in by the migration. Anything the migration forgets
  // to move would arrive a cell away from the rest of the farm.
  assertEqual(live.farmer.x, was.farmer.x, 'the farmer moved with his farm');
  assertEqual(live.farmer.y, was.farmer.y, 'on both axes');
  assertEqual(live.buildings[0].x, was.barn.x, 'and so did the barn');
  assertEqual(live.buildings[0].y, was.barn.y, 'both ways');
  assertEqual(live.animals[0].x, was.chicken.x, 'and the chicken');
  assertEqual(live.animals[0].px, was.chicken.x, 'including where it is drawn');
  assertEqual(live.tasks[0].x, s.farmer.x + 7, 'and the queued work');
  assert(live.crops[`${bed.x},${bed.y}`], 'and the planted carrot');
  assert(live.wetUntil[`${bed.x},${bed.y}`], 'and the fact that it was watered');
  assert(live.troughs[`${trough.x},${trough.y}`], 'and the trough');

  // The farm has to still work afterwards, not just look right.
  assert(live.grid.isOwned(live.farmer.x, live.farmer.y), 'the farmer stands on his own land');
  assert(isTilled(live.grid.getGround(bed.x, bed.y)), 'the bed came too, still watered');
});

test('migrating generates new land around the old farm', () => {
  const s = newGameRaw(6110);
  const live = deserialize(migrate(oldWorldSave(s)));

  assertEqual(live.grid.w, MAP_W, 'the world is nine cells wide now');
  assertEqual(live.grid.h, MAP_H, 'and nine tall');

  // The new cells must look lived-in, not like blank lawn.
  let obstacles = 0;
  for (let y = 0; y < CELL_H; y++) {
    for (let x = 0; x < CELL_W; x++) if (live.grid.getObject(x, y) !== OBJ.NONE) obstacles++;
  }
  assert(obstacles > 100, `the new corner cell should be overgrown, found ${obstacles}`);
});

test('migrating an old save is deterministic', () => {
  // Two players on the same save must get the same new land, and reloading
  // must not reshuffle it.
  const s = newGameRaw(6111);
  const a = deserialize(migrate(oldWorldSave(s)));
  const b = deserialize(migrate(oldWorldSave(s)));
  assertEqual(serialize(b), serialize(a), 'the new country is generated from the seed');
});

test('a save from the short-lived 8x8-plot version migrates too', () => {
  // Land ownership shipped once with a different geometry, so saves in the
  // wild can be v1 or v2. Both have a 40x40 map; v2 also has plot indices that
  // mean nothing now. Either way the player ends up owning their whole map.
  const s = newGameRaw(6113);
  const v2 = oldWorldSave(s);
  v2.version = 2;
  v2.map.owned = [0, 1, 5];            // meaningless under the new geometry

  const live = deserialize(migrate(v2));
  assertEqual(Array.from(live.grid.owned), [centreCellIndex()], 'one cell, the middle one');
  assert(live.grid.isOwned(live.farmer.x, live.farmer.y), 'with the farmer on it');
  assertEqual(live.grid.w, MAP_W, 'in the expanded world');
});

test('a migrated farm can buy the land next door', () => {
  const s = newGameRaw(6112);
  const live = deserialize(migrate(oldWorldSave(s)));
  live.money = 100000;

  const { px, py } = plotOfTile(live.farmer.x, live.farmer.y);
  assertEqual(`${px},${py}`, '1,1', 'a migrated farm sits in the middle of the nine');
  assert(canBuyPlot(live, px, py + 1).ok, 'the cell to the south is for sale');
  assert(!canBuyPlot(live, px + 1, py + 1).ok, 'the corner still needs a neighbour first');
  assert(buyPlot(live, px, py + 1).ok, 'and the purchase goes through');
});

// --- drawing only when there is something to draw -----------------------

test('a still farm is recognised as still', () => {
  // The whole saving depends on this: if it were wrong in this direction the
  // game would draw 300 sprites sixty times a second to show nothing new.
  const s = newGame(9950);
  s.farmer.trail = [{ x: s.farmer.x, y: s.farmer.y }];
  assert(!anythingMoving(s), 'nobody is going anywhere');
});

test('anything mid-move is spotted, or the game looks frozen', () => {
  // A false negative here is far worse than a false positive: it would stop
  // the frame that shows something actually moving.
  const walking = newGame(9951);
  walking.farmer.trail = [{ x: 10, y: 10 }, { x: 11, y: 10 }];
  assert(anythingMoving(walking), 'the farmer walks several tiles a tick');

  const withCow = newGame(9952);
  withCow.farmer.trail = [{ x: withCow.farmer.x, y: withCow.farmer.y }];
  withCow.animals = [{ id: 1, type: 'cow', x: 5, y: 5, px: 4, py: 5 }];
  assert(anythingMoving(withCow), 'an animal between two tiles counts');

  withCow.animals[0].px = 5;
  assert(!anythingMoving(withCow), 'and stops counting once it has arrived');

  const withHand = newGame(9953);
  withHand.farmer.trail = [{ x: withHand.farmer.x, y: withHand.farmer.y }];
  withHand.hands = [{ id: 1, x: 8, y: 8, px: 8, py: 7 }];
  assert(anythingMoving(withHand), 'a farmhand on the move counts too');
});

test('a farm with no animals or hands at all is still handled', () => {
  const s = newGame(9954);
  s.farmer.trail = [{ x: s.farmer.x, y: s.farmer.y }];
  delete s.animals;
  delete s.hands;
  assertEqual(anythingMoving(s), false, 'missing lists must not throw');
});

// --- the tick clock -----------------------------------------------------

/** A GameLoop that counts ticks and never touches the DOM. */
function countingLoop(opts) {
  let ticks = 0;
  const loop = new GameLoop(() => { ticks++; }, () => {}, opts);
  loop.nextTickTime = 1000 + TICK_MS;             // as start(1000) would leave it
  return { loop, ticks: () => ticks };
}

test('pump runs one tick per elapsed second, and no more', () => {
  const { loop, ticks } = countingLoop();
  loop.pump(1000);
  assertEqual(ticks(), 0, 'nothing is due yet');

  loop.pump(1000 + TICK_MS * 3);
  assertEqual(ticks(), 3, 'three seconds, three ticks');

  loop.pump(1000 + TICK_MS * 3);
  assertEqual(ticks(), 3, 'and pumping again without time passing does nothing');
});

test('pump refuses to run an unbounded backlog in one frame', () => {
  // A throttled-but-alive tab can come back hours behind. Running it all in
  // one frame would lock the page up.
  const { loop, ticks } = countingLoop();
  loop.pump(1000 + TICK_MS * 5000);

  assertEqual(ticks(), loop.maxTicksPerFrame, 'it stops at the budget');
  // ...and gives up on the rest rather than spending every future frame on it.
  loop.pump(1000 + TICK_MS * 5000);
  assertEqual(ticks(), loop.maxTicksPerFrame, 'the backlog was written off, not carried');
});

test('a big burst runs quietly, and says so', () => {
  // Minutes of backlog dispatched live is a wall of simultaneous toasts for
  // things that happened while nobody was looking.
  let heard = 0;
  let refreshed = 0;
  const off = on('tasks:changed', () => { heard++; });
  const { loop } = countingLoop({ onQuietCatchup: () => { refreshed++; } });
  loop.tick = () => emitUnlessSuspended('tasks:changed');

  loop.pump(1000 + TICK_MS * 200);
  assertEqual(heard, 0, 'the burst is silent');
  assertEqual(refreshed, 1, 'and the caller is told to refresh once');

  // A normal frame still talks.
  loop.pump(1000 + TICK_MS * 201);
  assertEqual(heard, 1, 'ordinary ticks are not suppressed');
  off();
});

test('alpha stays between 0 and 1 whatever the timing', () => {
  const { loop } = countingLoop();
  const seen = [];
  loop.render = (a) => seen.push(a);
  for (const t of [1000, 1000 + TICK_MS / 2, 1000 + TICK_MS * 3, 1000 + TICK_MS * 9000]) {
    loop.pump(t);
  }
  for (const a of seen) assert(a >= 0 && a <= 1, `alpha ${a} is out of range`);
});

test('resync puts the clock back in step without running anything', () => {
  const { loop, ticks } = countingLoop();
  loop.resync(50_000);
  loop.pump(50_000);
  assertEqual(ticks(), 0, 'no replay of the stretch that was caught up elsewhere');
});

test('catch-up replays long absences in chunks, reporting progress', async () => {
  // The chunked path was untested: the only catch-up test ran 600 ticks, well
  // under the chunk size, so it never yielded once.
  let ticks = 0;
  const progress = [];
  const result = await runCatchup((CATCHUP_CHUNK * 2 + 5) * TICK_MS,
    () => { ticks++; }, (done, total) => progress.push([done, total]));

  assertEqual(ticks, CATCHUP_CHUNK * 2 + 5, 'every tick ran');
  assertEqual(result.ticks, ticks, 'and is reported');
  assert(progress.length >= 3, `progress should be reported per chunk, got ${progress.length}`);
  assertEqual(progress[progress.length - 1][0], ticks, 'ending at the total');
});

test('catch-up caps a very long absence and reports what it skipped', () => {
  const wanted = MAX_CATCHUP_TICKS + 5000;
  return runCatchup(wanted * TICK_MS, () => {}).then((result) => {
    assertEqual(result.ticks, MAX_CATCHUP_TICKS, 'it replays the cap, not the lot');
    assert(result.capped, 'and says it capped');
    assertEqual(result.skipped, 5000, 'and how much it refused to replay');
  });
});

test('skipped time is written off, not left on the clock', () => {
  // The cap did not actually cap: lastTickTime only advanced by the ticks that
  // ran, so a month away replayed seven days, then seven more on the next
  // load, and so on. Four catch-ups to arrive where one belongs.
  const s = newGameRaw(9900);
  const monthAgo = 30 * 24 * 60 * 60 * 1000;
  s.lastTickTime = 1_000_000;

  const catchup = { ticks: MAX_CATCHUP_TICKS, capped: true, skipped: 1234 };
  const before = s.lastTickTime;
  assertEqual(discardSkipped(s, catchup), 1234, 'it reports what it discarded');
  assertEqual(s.lastTickTime, before + 1234 * TICK_MS, 'and moves the clock past it');

  // Nothing to discard when the absence fitted inside the cap.
  assertEqual(discardSkipped(s, { ticks: 10, capped: false, skipped: 0 }), 0, 'no-op');
  assert(monthAgo > MAX_CATCHUP_TICKS * TICK_MS, 'a month really does exceed the cap');
});

test('a capped absence does not come back as a fresh backlog', () => {
  // End to end: replay the cap, discard the rest, and the farm is level with
  // the wall clock rather than owing another seven days.
  const s = newGameRaw(9901);
  const now = s.lastTickTime + 30 * 24 * 60 * 60 * 1000;

  return runCatchup(now - s.lastTickTime, () => tick(s)).then((catchup) => {
    discardSkipped(s, catchup);
    const stillOwed = Math.floor((now - s.lastTickTime) / TICK_MS);
    assertEqual(stillOwed, 0, `the farm should be up to date, still owes ${stillOwed} ticks`);
  });
});

// --- a save that is not a farm ------------------------------------------

test('a save that parses but has no farm in it does not brick the game', () => {
  // A write cut short by a full disk or a killed tab leaves something that
  // parses perfectly and contains nothing. It used to reach boot and die on
  // state.farmer.x — no backup, no fresh start, and no way back without
  // clearing localStorage by hand, which is not a thing to ask of a player.
  const store = fakeStorage();
  const gutted = JSON.stringify({ version: SAVE_VERSION });
  store.setItem(SAVE_KEY, gutted);

  const loaded = withStorage(store, () => loadSave());
  assertEqual(loaded, null, 'it is refused rather than half-loaded');
  assertEqual(store.getItem(SAVE_KEY + '.corrupt'), gutted,
    'and kept aside, so nothing is thrown away');
});

test('an unparseable save is kept aside too', () => {
  const store = fakeStorage();
  store.setItem(SAVE_KEY, '{not json at all');

  assertEqual(withStorage(store, () => loadSave()), null, 'refused');
  assert(store.getItem(SAVE_KEY + '.corrupt'), 'and kept');
});

test('a farm with a map and a farmer still loads', () => {
  // The guard must not be so keen that it rejects real saves.
  const store = fakeStorage();
  store.setItem(SAVE_KEY, JSON.stringify(serialize(newGameRaw(9800))));

  const loaded = withStorage(store, () => loadSave());
  assert(loaded, 'a real save loads');
  assertEqual(store.getItem(SAVE_KEY + '.corrupt'), null, 'and is not treated as corrupt');
  assert(deserialize(loaded).grid.isOwned(loaded.farmer.x, loaded.farmer.y),
    'and comes back playable');
});

test('deserialize never hands back a world nobody can walk on', () => {
  // Unreachable through loadSave now, but a grid that owns nothing is a grid
  // where nothing can move — a far more baffling failure than an empty map.
  const bare = deserialize({ version: SAVE_VERSION, farmer: { x: 60, y: 60 }, seed: 1 });
  assert(bare.grid.owned.size > 0, 'it owns somewhere');
  assert(bare.grid.isWalkable(60, 60, 'farmer'), 'and the farmer can stand on it');
});

// --- backups before migrating -------------------------------------------

/** A stand-in for localStorage, so the real load path can be exercised here. */
function fakeStorage() {
  const m = new Map();
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i],
    get length() { return m.size; },
  };
}

/** Runs fn with localStorage swapped out, then puts it back. */
function withStorage(store, fn) {
  const real = globalThis.localStorage;
  globalThis.localStorage = store;
  try { return fn(); } finally { globalThis.localStorage = real; }
}

test('migrating an old save keeps a copy of it first', () => {
  // A migration rewrites a farm on a schema the code that wrote it never saw.
  // The original has to survive that, or a bad migration is final.
  const store = fakeStorage();
  const old = oldWorldSave(newGameRaw(9200));
  store.setItem(SAVE_KEY, JSON.stringify(old));

  const loaded = withStorage(store, () => loadSave());
  assertEqual(loaded.version, SAVE_VERSION, 'the farm came back migrated');

  const kept = store.getItem(backupKey(1));
  assert(kept, 'and the v1 original was kept');
  assertEqual(JSON.parse(kept).version, 1, 'exactly as it was, unmigrated');
  assertEqual(JSON.parse(kept).map.w, CELL_W, 'still the old 40x40 map');
});

test('a save that needs no migration is not backed up', () => {
  // Otherwise every single load would rewrite the backup, and the copy from
  // before the update — the one that matters — would be lost immediately.
  const store = fakeStorage();
  store.setItem(SAVE_KEY, JSON.stringify(serialize(newGameRaw(9201))));

  withStorage(store, () => loadSave());
  assertEqual(store.length, 1, 'only the save itself is stored');
});

test('a second load never overwrites a backup with a broken farm', () => {
  // The scenario this exists for: the migration went wrong, and the player
  // reloads hoping it sorts itself out. The good copy must still be there.
  const store = fakeStorage();
  const original = JSON.stringify(oldWorldSave(newGameRaw(9202)));
  store.setItem(SAVE_KEY, original);

  withStorage(store, () => loadSave());
  store.setItem(SAVE_KEY, JSON.stringify({ version: 1, ruined: true }));
  withStorage(store, () => loadSave());

  assertEqual(store.getItem(backupKey(1)), original, 'the first copy is untouched');
});

test('backups are listed newest schema first, and are importable', () => {
  const store = fakeStorage();
  const old = oldWorldSave(newGameRaw(9203));
  store.setItem(SAVE_KEY, JSON.stringify(old));
  withStorage(store, () => loadSave());

  const found = withStorage(store, () => listBackups());
  assertEqual(found.length, 1, 'one backup');
  assertEqual(found[0].version, 1, 'from v1');

  // It has to be something the restore box will actually accept, or offering
  // it to the player is a cruel joke.
  const check = validateSave(found[0].text);
  assert(check.ok, `the backup must import cleanly: ${check.reason}`);
  const live = deserialize(check.data);
  assert(live.grid.isOwned(live.farmer.x, live.farmer.y), 'and give back a playable farm');
});

test('a backup that cannot be written does not stop the farm loading', () => {
  // Refusing to open someone's farm because there was no room for a safety
  // copy would be a worse outcome than the risk it guards against.
  const store = fakeStorage();
  store.setItem(SAVE_KEY, JSON.stringify(oldWorldSave(newGameRaw(9204))));
  const full = { ...store, setItem: (k) => { if (k !== SAVE_KEY) throw new Error('quota'); } };

  const loaded = withStorage(full, () => loadSave());
  assert(loaded, 'the farm still loads');
  assertEqual(loaded.version, SAVE_VERSION, 'and is still migrated');
});

// --- save export / import -----------------------------------------------

test('a farm survives a round trip through export and import', () => {
  const s = farmWithMaterials(9100);
  s.money = 777;
  for (let i = 0; i < 50; i++) tick(s);

  const text = exportSave(serialize(s));
  assert(typeof text === 'string' && text.length > 0, 'export produces text');

  const check = validateSave(text);
  assert(check.ok, `import should accept our own export: ${check.reason}`);

  const restored = deserialize(check.data);
  assertEqual(serialize(restored), serialize(s), 'and restore the farm exactly');
});

test('an imported farm keeps ticking identically to the original', () => {
  const s = farmWithMaterials(9101);
  for (let i = 0; i < 30; i++) tick(s);

  const restored = deserialize(validateSave(exportSave(serialize(s))).data);
  for (let i = 0; i < 300; i++) { tick(s); tick(restored); }

  assertEqual(serialize(restored), serialize(s), 'an imported save is not a lossy copy');
});

test('import refuses junk rather than half-loading it', () => {
  // This replaces a farm that might be weeks old, so anything doubtful must be
  // rejected outright.
  assert(!validateSave('').ok, 'empty');
  assert(!validateSave('   ').ok, 'whitespace');
  assert(!validateSave('not json at all').ok, 'not json');
  assert(!validateSave('[1,2,3]').ok, 'json, but not a save');
  assert(!validateSave('{"hello":"world"}').ok, 'an object with no version');
  assert(!validateSave(null).ok, 'not even a string');
});

test('import refuses a save from a newer version of the game', () => {
  const data = serialize(newGame(9102));
  data.version = SAVE_VERSION + 1;
  const check = validateSave(JSON.stringify(data));
  assert(!check.ok, 'a future save must not be misread');
  assert(/version/i.test(check.reason), `the reason should say why: ${check.reason}`);
});

test('import refuses a versioned object that has no farm in it', () => {
  // migrate() only checks the version, so this is the case that would otherwise
  // sail through and crash on load.
  const check = validateSave(JSON.stringify({ version: SAVE_VERSION, money: 10 }));
  assert(!check.ok, 'no map and no farmer is not a save');
});

// --- offline shell ------------------------------------------------------

test('every module is precached by the service worker', () => {
  // The shell list in sw.js is hand-written and drifts: a new module that isn't
  // in it is fetched from the network, and since main.js imports statically, a
  // cold offline open fails the whole module graph rather than losing one
  // feature. This caught js/ui/summary.js going missing.
  const sw = readFileSync('sw.js', 'utf8');
  const shell = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);

  const modules = shippedFiles('js', ['.js']);

  const missing = modules.filter((m) => !shell.includes(m));
  assertEqual(missing, [], 'these modules would 404 when the game is opened offline');
});

test('every asset the game actually asks for is precached', () => {
  // The check above only walked js/. Every art sheet so far has been added to
  // the shell by hand, and a missed one is a 404 offline with nothing to catch
  // it — assets/animals/farm.png was exactly this near-miss.
  //
  // Referenced files, not every file on disk: an unused sheet sitting in
  // assets/ shouldn't be forced into the shell, where it would cost every
  // player a download for something nothing loads.
  const sw = readFileSync('sw.js', 'utf8');
  const shell = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);

  const sources = [
    'index.html', 'manifest.json',
    ...shippedFiles('css', ['.css']),
    ...shippedFiles('js', ['.js']),
  ];
  const referenced = new Set();
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:\.\.\/)?((?:assets|icons|css)\/[\w./-]+\.(?:png|css|json))/g)) {
      referenced.add(m[1]);
    }
  }

  assert(referenced.size >= 8, `expected to find the art sheets, found ${referenced.size}`);
  const missing = [...referenced].filter((p) => !shell.includes(p)).sort();
  assertEqual(missing, [], 'these would 404 when the game is opened offline');
});

test('the service worker does not precache files that no longer exist', () => {
  const sw = readFileSync('sw.js', 'utf8');
  const shell = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);
  // './' is the navigation entry, not a file on disk.
  const stale = shell.filter((p) => p !== '' && !existsSync(p));
  assertEqual(stale, [], 'the install step would fail to cache these');
});

/** Files of the given kinds under a directory, as shell-relative paths. */
function shippedFiles(dir, extensions) {
  const out = [];
  (function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else if (extensions.some((ext) => p.endsWith(ext))) out.push(p.replace(/^\.\//, ''));
    }
  }(dir));
  return out;
}

// --- report -------------------------------------------------------------

await runAll();

for (const { name, err } of failures) {
  console.error(`FAIL  ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
