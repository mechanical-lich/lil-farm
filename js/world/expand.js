// Growing an old save into the 3x3 world.
//
// Farms saved before this were a single 40x40 map with the farmhouse near the
// middle. That map is now one cell of nine, so migrating means dropping the old
// world into the centre cell, generating the eight cells around it, and moving
// every coordinate in the save by the offset.
//
// The player keeps **the whole cell**, not the parts of it they had built on.
// Their old map was entirely theirs and it stays entirely theirs; the land they
// gain the option to buy is all new country beyond it.
//
// This runs on the serialized shape inside migrate(), before there is a live
// state to work with — hence the hand translation of every keyed map below.
// Anything added to the save that carries tile coordinates has to be added
// here too, or it will end up pointing at the wrong tile forever.

import { MAP_W, MAP_H, CELL_W, CELL_H, CELLS_X, CELLS_Y } from '../config.js';
import { makeRng } from '../engine/rng.js';
import { Grid } from './grid.js';
import { GROUND } from './tiledefs.js';
import { scatterObstacles, centreCellOrigin } from './worldgen.js';
import { plotIndex, plotOfTile } from './land.js';

export function expandSaveToCells(data) {
  const old = data.map || {};
  const oldW = old.w || CELL_W;
  const oldH = old.h || CELL_H;
  const { x: dx, y: dy } = centreCellOrigin();

  const grid = new Grid(MAP_W, MAP_H);
  grid.ground.fill(GROUND.GRASS);

  // The old farm, verbatim, in the middle.
  for (let y = 0; y < oldH; y++) {
    for (let x = 0; x < oldW; x++) {
      const from = y * oldW + x;
      grid.setGround(x + dx, y + dy, (old.ground || [])[from] || GROUND.GRASS);
      grid.setObject(x + dx, y + dy, (old.objects || [])[from] || 0);
    }
  }

  // New country around it, generated cell by cell so the density matches and
  // the farm's own cell is never touched. Its own generator, seeded from the
  // save's seed: deterministic, and it can't disturb state.rng mid-stream.
  const rng = makeRng(((data.seed >>> 0) ^ 0x9e3779b9) >>> 0);
  for (let cy = 0; cy < CELLS_Y; cy++) {
    for (let cx = 0; cx < CELLS_X; cx++) {
      if (cx * CELL_W === dx && cy * CELL_H === dy) continue;
      scatterObstacles(grid, rng, {
        x0: cx * CELL_W, y0: cy * CELL_H, w: CELL_W, h: CELL_H,
      });
    }
  }

  const centre = plotOfTile(dx, dy);
  grid.own(centre.px, centre.py);

  data.map = grid.toJSON();
  shiftCoordinates(data, dx, dy);
  return data;
}

/** Moves every tile coordinate in a save by (dx, dy). */
function shiftCoordinates(data, dx, dy) {
  const movePoint = (p) => { if (p) { p.x += dx; p.y += dy; } };
  const movePath = (path) => (path || []).forEach(movePoint);

  movePoint(data.farmer);
  movePath(data.farmer?.path);
  movePath(data.farmer?.trail);

  for (const a of data.animals || []) {
    movePoint(a);
    movePath(a.path);
    // Animals carry their previous pixel position for interpolation.
    if (typeof a.px === 'number') a.px += dx;
    if (typeof a.py === 'number') a.py += dy;
  }

  for (const b of data.buildings || []) movePoint(b);
  for (const t of data.tasks || []) movePoint(t);

  for (const key of ['crops', 'wetUntil', 'tillDir', 'troughs', 'crates']) {
    data[key] = shiftKeys(data[key], dx, dy);
  }
}

/** Rebuilds an "x,y"-keyed map with every key moved. */
function shiftKeys(map, dx, dy) {
  if (!map) return map;
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    const comma = key.indexOf(',');
    const x = +key.slice(0, comma) + dx;
    const y = +key.slice(comma + 1) + dy;
    out[`${x},${y}`] = value;
  }
  return out;
}

/** Plot index of the cell a migrated farm keeps. Exported for the tests. */
export function centreCellIndex() {
  const { x, y } = centreCellOrigin();
  const { px, py } = plotOfTile(x, y);
  return plotIndex(px, py, MAP_W);
}
