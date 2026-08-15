// Minimal no-framework test runner: `node tests/run.js`
//
// Only headless modules are testable here (engine/, world/, sim/, state.js).
// Anything under render/ or ui/ touches the DOM by design and is verified in
// the browser instead.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { makeRng, hash2d } from '../js/engine/rng.js';
import { Grid } from '../js/world/grid.js';
import { GROUND, OBJ } from '../js/world/tiledefs.js';
import { generateWorld, startingBarnAnchor } from '../js/world/worldgen.js';
import { findPath, besideBox, insideBox } from '../js/world/pathfind.js';
import { addTask, cancelTask, prioritizeTask, taskForTile, tillRow, queueTillRow } from '../js/sim/tasks.js';
import {
  CROPS, SOIL_DRY_TICKS, plantCrop, waterTile, harvestCrop,
  cropAt, isRipe, isStalled, spoilRemaining, SPOIL_TICKS, updateCrops,
} from '../js/sim/crops.js';
import {
  ROTATION_TICKS, STAPLE_SEEDS, ROTATING_COUNT, stockedSeedCrops, buyList,
  buy, sell, sellAll, buyAnimal, canBuyAnimal, canPlaceAnimal, MATERIALS,
} from '../js/sim/shop.js';
import { ITEMS } from '../js/sim/inventory.js';
import {
  ANIMALS, TROUGH_CAPACITY, FEED_COST, FOOD_DURATION, WATER_DURATION, SEEK_THRESHOLD,
  makeAnimal, collectFrom, isNeglected, fillWaterTrough, fillFeedTrough, pickFeed,
} from '../js/sim/animals.js';
import {
  BUILDABLES, canPlaceAt, canAfford, footprint, troughAnchorAt,
  completeBuild, demolish, structureAt, buildingAt, animalCapacity, BARN_CAPACITY,
} from '../js/sim/build.js';
import { addItems } from '../js/sim/inventory.js';
import { newGame, serialize, deserialize } from '../js/state.js';
import { tick } from '../js/sim/tick.js';
import { migrate, Autosaver, exportSave, validateSave } from '../js/engine/save.js';
import { runCatchup } from '../js/engine/loop.js';
import {
  on, suspend, resume, startTally, stopTally, emitUnlessSuspended,
} from '../js/engine/events.js';
import { buildSummary } from '../js/ui/summary.js';
import { TICK_MS, SAVE_VERSION, FARMER_SPEED } from '../js/config.js';

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
  const g = new Grid(4, 4);
  g.setObject(1, 1, OBJ.GATE);
  g.setObject(2, 2, OBJ.FENCE);

  assert(g.isWalkable(1, 1, 'farmer'), 'farmer opens gates');
  assert(!g.isWalkable(1, 1, 'animal'), 'animals cannot open gates');
  assert(!g.isWalkable(2, 2, 'farmer'), 'fences block everyone');
  assert(!g.isWalkable(2, 2, 'animal'), 'fences block everyone');
});

test('grid treats out-of-bounds as unwalkable', () => {
  const g = new Grid(4, 4);
  assert(!g.isWalkable(-1, 0), 'negative x');
  assert(!g.isWalkable(0, 4), 'past height');
});

test('grid round-trips through JSON', () => {
  const g = new Grid(6, 5);
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
  const g = new Grid(10, 10);
  const path = findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 });
  assertEqual(path.length, 4, 'four steps to move four tiles');
  assertEqual(path[path.length - 1], { x: 4, y: 0 }, 'ends on the goal');
});

test('findPath routes around a wall', () => {
  const g = new Grid(7, 7);
  for (let y = 0; y < 6; y++) g.setObject(3, y, OBJ.FENCE);   // wall with a gap at y=6

  const path = findPath(g, { x: 0, y: 0 }, { x: 6, y: 0 });
  assert(path !== null, 'a way around exists');
  for (const step of path) {
    assert(g.isWalkable(step.x, step.y, 'farmer'), `path crosses a fence at ${step.x},${step.y}`);
  }
  assertEqual(path[path.length - 1], { x: 6, y: 0 }, 'still reaches the goal');
});

test('findPath returns null when the goal is walled off', () => {
  const g = new Grid(7, 7);
  for (let y = 0; y < 7; y++) g.setObject(3, y, OBJ.FENCE);   // full-height wall
  assertEqual(findPath(g, { x: 0, y: 0 }, { x: 6, y: 0 }), null, 'no route should exist');
});

test('findPath in adjacent mode stops next to a blocking target', () => {
  const g = new Grid(8, 8);
  g.setObject(4, 4, OBJ.TREE);   // cannot be stood on

  const path = findPath(g, { x: 0, y: 4 }, { x: 4, y: 4 }, { adjacent: true });
  assert(path !== null, 'should reach a neighbouring tile');
  const end = path[path.length - 1];
  assertEqual(Math.abs(end.x - 4) + Math.abs(end.y - 4), 1, 'ends orthogonally adjacent');
  assert(g.isWalkable(end.x, end.y, 'farmer'), 'ends somewhere standable');
});

test('findPath lets the farmer through a gate but not an animal', () => {
  const g = new Grid(5, 3);
  for (let y = 0; y < 3; y++) g.setObject(2, y, OBJ.FENCE);
  g.setObject(2, 1, OBJ.GATE);   // the only way through

  assert(findPath(g, { x: 0, y: 1 }, { x: 4, y: 1 }, { actor: 'farmer' }) !== null,
    'farmer opens the gate');
  assertEqual(findPath(g, { x: 0, y: 1 }, { x: 4, y: 1 }, { actor: 'animal' }), null,
    'animals must not escape through gates');
});

test('findPath is deterministic across runs', () => {
  const g = new Grid(12, 12);
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
  assert(!animal.ready, 'and it never becomes ready');
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

  assert(!animal.ready, 'a hen is never "ready to collect from"');
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

  assert(animal.ready, 'the cow should be ready to milk');
  assertEqual([...s.grid.objects].filter((o) => o === OBJ.EGG).length, 0, 'and drops nothing');

  const gained = collectFrom(s, animal);
  assertEqual(gained, { milk: 1 }, 'milking yields milk');
  assertEqual(s.inventory.milk, 1, 'straight into the bag');
  assertEqual(animal.progress, 0, 'and it starts over');
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
