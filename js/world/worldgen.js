// New-game map generation: an overgrown plot the player has to clean up.

import { Grid } from './grid.js';
import { GROUND, OBJ } from './tiledefs.js';
import { MAP_W, MAP_H, CELL_W, CELL_H, CELLS_X, CELLS_Y, GEN } from '../config.js';
import { startingPlot } from './land.js';

/**
 * Where the farm's starting barn stands, relative to the farmer's spawn: three
 * tiles wide, on the two rows directly above him, so he begins standing in his
 * own yard looking at it. Its roof overhangs three rows higher still, which is
 * well inside the cleared radius.
 */
export function startingBarnAnchor(spawn) {
  return { x: spawn.x - 1, y: spawn.y - 2 };
}

/** The middle cell of the 3x3 world — the one a new farm starts owning. */
export function centreCellOrigin() {
  return {
    x: Math.floor(CELLS_X / 2) * CELL_W,
    y: Math.floor(CELLS_Y / 2) * CELL_H,
  };
}

/**
 * @param {ReturnType<import('../engine/rng.js').makeRng>} rng
 * @returns {{grid: Grid, spawn: {x:number, y:number}}}
 */
export function generateWorld(rng) {
  const grid = new Grid(MAP_W, MAP_H);
  grid.ground.fill(GROUND.GRASS);

  // Dead centre of the whole world, which is also the centre of the middle
  // cell. A cell is 40x40, so the farmstead has room to spare on every side.
  const spawn = { x: Math.floor(MAP_W / 2), y: Math.floor(MAP_H / 2) };

  // You start owning exactly the cell you're standing in; the eight around it
  // are bought one at a time. See land.js.
  const start = startingPlot(spawn);
  grid.own(start.px, start.py);

  scatterObstacles(grid, rng, { x0: 0, y0: 0, w: MAP_W, h: MAP_H }, spawn);
  layYard(grid, spawn);

  return { grid, spawn };
}

/**
 * Scatters the starting obstacles over a rectangle of the grid.
 *
 * Taken out of generateWorld so the save migration can generate the eight new
 * cells around an existing farm with the same hand — land bought later has to
 * look like land that was always there.
 *
 * Order matters: later types only land on empty tiles, so trees (placed first)
 * get priority over weeds.
 *
 * @param {{x0:number,y0:number,w:number,h:number}} area
 * @param {{x:number,y:number}|null} spawn kept clear, when it's in this area
 */
export function scatterObstacles(grid, rng, area, spawn = null) {
  const scatter = (objId, density) => {
    const count = Math.floor(area.w * area.h * density);
    for (let i = 0; i < count; i++) {
      const x = area.x0 + rng.int(area.w);
      const y = area.y0 + rng.int(area.h);
      if (grid.getObject(x, y) !== OBJ.NONE) continue;
      if (grid.getGround(x, y) !== GROUND.GRASS) continue;
      if (spawn && inClearing(x, y, spawn)) continue;
      grid.setObject(x, y, objId);
    }
  };

  scatter(OBJ.TREE, GEN.tree);
  scatter(OBJ.DEAD_TREE, GEN.deadTree);
  scatter(OBJ.ROCK, GEN.rock);
  scatter(OBJ.BUSH, GEN.bush);
  scatter(OBJ.WEED, GEN.weed);
}

/**
 * A patch of bare dirt in front of where the starting barn goes, so the opening
 * view reads as "your yard" rather than an arbitrary spot in a field. Kept in
 * step with startingBarnAnchor: the barn stands on the two rows above.
 */
function layYard(grid, spawn) {
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      grid.setGround(spawn.x + dx, spawn.y + dy, GROUND.DIRT);
    }
  }
}

function inClearing(x, y, spawn) {
  const dx = x - spawn.x;
  const dy = y - spawn.y;
  return dx * dx + dy * dy <= GEN.clearingRadius * GEN.clearingRadius;
}
