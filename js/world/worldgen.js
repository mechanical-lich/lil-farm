// New-game map generation: an overgrown plot the player has to clean up.

import { Grid } from './grid.js';
import { GROUND, OBJ } from './tiledefs.js';
import { MAP_W, MAP_H, GEN } from '../config.js';

/**
 * @param {ReturnType<import('../engine/rng.js').makeRng>} rng
 * @returns {{grid: Grid, spawn: {x:number, y:number}}}
 */
export function generateWorld(rng) {
  const grid = new Grid(MAP_W, MAP_H);
  grid.ground.fill(GROUND.GRASS);

  const spawn = { x: Math.floor(MAP_W / 2), y: Math.floor(MAP_H / 2) };

  // Scatter obstacles. Order matters: later types only land on empty tiles, so
  // trees (placed first) get priority over weeds.
  const scatter = (objId, density) => {
    const count = Math.floor(MAP_W * MAP_H * density);
    for (let i = 0; i < count; i++) {
      const x = rng.int(MAP_W);
      const y = rng.int(MAP_H);
      if (grid.getObject(x, y) !== OBJ.NONE) continue;
      if (inClearing(x, y, spawn)) continue;
      grid.setObject(x, y, objId);
    }
  };

  scatter(OBJ.TREE, GEN.tree);
  scatter(OBJ.DEAD_TREE, GEN.deadTree);
  scatter(OBJ.ROCK, GEN.rock);
  scatter(OBJ.BUSH, GEN.bush);
  scatter(OBJ.WEED, GEN.weed);

  // A small patch of bare dirt under the spawn so the starting area reads as
  // "your yard" rather than an arbitrary spot in a field.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      grid.setGround(spawn.x + dx, spawn.y + dy, GROUND.DIRT);
    }
  }

  return { grid, spawn };
}

function inClearing(x, y, spawn) {
  const dx = x - spawn.x;
  const dy = y - spawn.y;
  return dx * dx + dy * dy <= GEN.clearingRadius * GEN.clearingRadius;
}
