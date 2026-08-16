// Minimal no-framework test runner: `node tests/run.js`
//
// Only headless modules are testable here (engine/, world/, sim/, state.js).
// Anything under render/ or ui/ touches the DOM by design and is verified in
// the browser instead.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { makeRng, hash2d } from '../js/engine/rng.js';
import { Grid } from '../js/world/grid.js';
import { GROUND, OBJ, isTilled } from '../js/world/tiledefs.js';
import { generateWorld, startingBarnAnchor } from '../js/world/worldgen.js';
import { findPath, besideBox, insideBox } from '../js/world/pathfind.js';
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
  canSprout as canSproutShroom,
} from '../js/sim/mushrooms.js';
import { addTask, cancelTask, prioritizeTask, taskForTile, tillRow, queueTillRow } from '../js/sim/tasks.js';
import {
  CROPS, SOIL_DRY_TICKS, plantCrop, waterTile, harvestCrop,
  cropAt, isRipe, isStalled, spoilRemaining, SPOIL_TICKS, updateCrops,
} from '../js/sim/crops.js';
import {
  ROTATION_TICKS, STAPLE_SEEDS, ROTATING_COUNT, ROTATING_TIERS, stockedSeedCrops, buyList,
  buy, sell, sellAll, buyAnimal, canBuyAnimal, canPlaceAnimal, MATERIALS,
} from '../js/sim/shop.js';
import { ITEMS, countItem } from '../js/sim/inventory.js';
import {
  ANIMALS, TROUGH_CAPACITY, FEED_COST, FOOD_DURATION, WATER_DURATION, SEEK_THRESHOLD,
  makeAnimal, collectFrom, isNeglected, fillWaterTrough, fillFeedTrough, pickFeed, animalDef,
  petAnimal, pickEmote, currentEmote, animalAt, isReady, PRODUCE_CAP,
  setAnimalVariants, animalVariantCount, variantOf,
  AFFECTION_MAX, PET_GAIN, PET_COOLDOWN, EMOTE_TICKS,
} from '../js/sim/animals.js';
import {
  BUILDABLES, canPlaceAt, canAfford, footprint, troughAnchorAt,
  completeBuild, demolish, structureAt, buildingAt, animalCapacity, BARN_CAPACITY,
  placeStructure, buildDef, kindForGround,
} from '../js/sim/build.js';
import { TOWN } from '../js/render/sprites.js';
import { dirtPieceAt, dirtCornersAt } from '../js/render/tilerender.js';
import { addItems } from '../js/sim/inventory.js';
import { newGame as newGameRaw, serialize, deserialize } from '../js/state.js';
import { tick } from '../js/sim/tick.js';
import {
  migrate, Autosaver, exportSave, validateSave, loadSave, listBackups, backupKey,
} from '../js/engine/save.js';
import { runCatchup } from '../js/engine/loop.js';
import {
  on, suspend, resume, startTally, stopTally, emitUnlessSuspended,
} from '../js/engine/events.js';
import { buildSummary } from '../js/ui/summary.js';
import {
  TICK_MS, SAVE_VERSION, FARMER_SPEED, MAP_W, MAP_H, CELL_W, CELL_H, SAVE_KEY,
  TILE, ANIMAL_VARIANTS,
} from '../js/config.js';

let passed = 0;
const failures = [];
// Async tests are rare here (only the catch-up integration needs one), so they
// are collected and awaited at the end rather than serialising the whole run.
const pending = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(result.then(
        () => { passed++; },
        (err) => { failures.push({ name, err }); },
      ));
    } else {
      passed++;
    }
  } catch (err) {
    failures.push({ name, err });
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
  s.grid.objects.fill(OBJ.NONE);
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

test('a barn needs its whole footprint free', () => {
  const s = farmWithMaterials(701);
  assert(canPlaceAt(s, 'barn', 5, 5), 'open ground is fine');

  s.grid.setObject(7, 6, OBJ.ROCK);   // bottom-right of the footprint
  assert(!canPlaceAt(s, 'barn', 5, 5), 'one rock anywhere in the footprint blocks it');

  s.grid.setObject(7, 6, OBJ.NONE);
  assert(!canPlaceAt(s, 'barn', s.grid.w - 2, 5), 'and it must not hang off the map');
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

test('the animal sheet and the animal definitions agree', () => {
  // The sheet is art the game indexes into by row and column. If a row is
  // added to ANIMALS without a row on the sheet, that animal draws nothing —
  // and nothing else would catch it, since the renderer has no canvas here.
  const { w, h } = pngSize('assets/animals.png');
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

test('a dirt road draws its edges, corners and bends from the right tiles', () => {
  // The nine-slice is easy to get subtly wrong, and wrong here means a farm
  // full of hard square edges. Assert the actual sprite chosen for each case.
  const s = farmWithMaterials(9301);
  const ox = 20;
  const oy = 20;
  const lay = (dx, dy) => s.grid.setGround(ox + dx, oy + dy, GROUND.DIRT);

  // A solid 3x3 block: every edge and convex corner in one shape.
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) lay(dx, dy);

  const at = (dx, dy) => dirtPieceAt(s, ox + dx, oy + dy);
  assertEqual(at(0, 0), TOWN.dirtTL, 'top-left');
  assertEqual(at(1, 0), TOWN.dirtT, 'top edge');
  assertEqual(at(2, 0), TOWN.dirtTR, 'top-right');
  assertEqual(at(0, 1), TOWN.dirtL, 'left edge');
  assertEqual(at(1, 1), TOWN.dirtC, 'the middle is plain earth');
  assertEqual(at(2, 1), TOWN.dirtR, 'right edge');
  assertEqual(at(0, 2), TOWN.dirtBL, 'bottom-left');
  assertEqual(at(1, 2), TOWN.dirtB, 'bottom edge');
  assertEqual(at(2, 2), TOWN.dirtBR, 'bottom-right');
});

test('the inside of a bend gets a grass wedge, not plain earth', () => {
  // This is what the sheet's four extra tiles exist for. Without them the turn
  // draws as solid earth with a square notch of grass sitting in it.
  const ox = 20;
  const oy = 20;
  const around = [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]];

  const bend = (missing) => {
    const s = farmWithMaterials(9302);
    for (const [dx, dy] of around) {
      if (dx === missing[0] && dy === missing[1]) continue;
      s.grid.setGround(ox + dx, oy + dy, GROUND.DIRT);
    }
    return dirtCornersAt(s, ox + 1, oy + 1);
  };

  assertEqual(bend([0, 0]), ['innerTL'], 'grass tucked into the top-left of the bend');
  assertEqual(bend([2, 0]), ['innerTR'], 'top-right');
  assertEqual(bend([0, 2]), ['innerBL'], 'bottom-left');
  assertEqual(bend([2, 2]), ['innerBR'], 'bottom-right');
});

test('a crossroads gets all four wedges, not one of them', () => {
  // The reason the corners are composited a quarter-tile at a time instead of
  // being chosen as a single tile: here every diagonal is grass, and picking
  // one inner-corner tile would leave three corners wrong.
  const s = farmWithMaterials(9303);
  const ox = 20;
  const oy = 20;
  for (let i = 0; i < 5; i++) {
    s.grid.setGround(ox + i, oy + 2, GROUND.DIRT);
    s.grid.setGround(ox + 2, oy + i, GROUND.DIRT);
  }

  assertEqual(dirtPieceAt(s, ox + 2, oy + 2), TOWN.dirtC, 'the junction itself is solid earth');
  assertEqual(dirtCornersAt(s, ox + 2, oy + 2).sort(),
    ['innerBL', 'innerBR', 'innerTL', 'innerTR'], 'with a wedge in every corner');
});

test('a solid field of dirt needs no wedges at all', () => {
  const s = farmWithMaterials(9304);
  const ox = 20;
  const oy = 20;
  for (let dy = 0; dy < 5; dy++) for (let dx = 0; dx < 5; dx++) {
    s.grid.setGround(ox + dx, oy + dy, GROUND.DIRT);
  }
  assertEqual(dirtCornersAt(s, ox + 2, oy + 2), [], 'nothing to tuck in');
});

// --- mushrooms ----------------------------------------------------------

test('the sheet is fully catalogued: four kinds, four colours each', () => {
  assertEqual(MUSHROOMS.length, 16, 'sixteen mushrooms on the sheet');
  assertEqual(new Set(MUSHROOMS.map((m) => m.sprite)).size, 16, 'each with its own sprite');
  assertEqual(new Set(MUSHROOMS.map((m) => m.id)).size, 16, 'and its own name');
  for (const [species, def] of Object.entries(SPECIES)) {
    assertEqual(MUSHROOMS.filter((m) => m.species === species).length, 4,
      `${species} should have four colours`);
    assert(ITEMS[def.item], `${species} needs somewhere to go in the bag`);
  }
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
  assertEqual(rows.length, 16, 'the journal lists every kind, found or not');
  assertEqual(rows.filter((r) => r.found === 0).length, 15, 'the rest are still out there');
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

  const modules = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith('.js')) modules.push(p.replace(/^\.\//, ''));
    }
  }('js'));

  const missing = modules.filter((m) => !shell.includes(m));
  assertEqual(missing, [], 'these modules would 404 when the game is opened offline');
});

test('the service worker does not precache files that no longer exist', () => {
  const sw = readFileSync('sw.js', 'utf8');
  const shell = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);
  // './' is the navigation entry, not a file on disk.
  const stale = shell.filter((p) => p !== '' && !existsSync(p));
  assertEqual(stale, [], 'the install step would fail to cache these');
});

// --- report -------------------------------------------------------------

await Promise.all(pending);

for (const { name, err } of failures) {
  console.error(`FAIL  ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
