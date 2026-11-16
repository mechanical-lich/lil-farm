// Which land the player actually owns.
//
// The world is a 3x3 grid of plots, each a full 40x40 farm, and the player
// starts owning the middle one and buys outward. A starting farm is therefore
// exactly as big as the whole map used to be — buying land adds new country
// rather than handing back pieces of what you already had. Everything past the
// boundary is drawn dimmed: visible, obviously yours-to-take, and completely
// inert until it's paid for.
//
// Ownership lives on the Grid rather than beside it, because that's what makes
// `isWalkable` able to answer it. Pathfinding, animal wandering and task
// validation all funnel through that one method, so containment falls out for
// free instead of being re-checked in four places that could disagree.
//
// This module deliberately imports nothing from grid.js — grid.js imports the
// plot maths from here.

import {
  MAP_W, MAP_H, CELL_W, LAND_PRICE_STEP, CITY_LOT_PRICE_STEP, SANCTUARY_LOT_PRICE_STEP,
} from '../config.js';

/** Tiles along one edge of a plot: a whole 40x40 farm's worth. */
export const PLOT = CELL_W;

export function plotsAcross(w = MAP_W) { return Math.ceil(w / PLOT); }
export function plotsDown(h = MAP_H) { return Math.ceil(h / PLOT); }

/** Plot index for a tile. The one piece of maths grid.js needs from here. */
export function plotIndexFor(w, x, y) {
  return Math.floor(y / PLOT) * plotsAcross(w) + Math.floor(x / PLOT);
}

export function plotIndex(px, py, w = MAP_W) { return py * plotsAcross(w) + px; }

export function plotCoords(idx, w = MAP_W) {
  const across = plotsAcross(w);
  return { px: idx % across, py: Math.floor(idx / across) };
}

/** Tile bounds of a plot, inclusive of x0/y0 and exclusive of x1/y1. */
export function plotBounds(px, py) {
  return { x0: px * PLOT, y0: py * PLOT, x1: (px + 1) * PLOT, y1: (py + 1) * PLOT };
}

export function plotOfTile(x, y) {
  return { px: Math.floor(x / PLOT), py: Math.floor(y / PLOT) };
}

export function plotInBounds(px, py, w = MAP_W, h = MAP_H) {
  return px >= 0 && py >= 0 && px < plotsAcross(w) && py < plotsDown(h);
}

/** The plot a new farm starts with: whichever one the spawn point lands in. */
export function startingPlot(spawn) {
  return plotOfTile(spawn.x, spawn.y);
}


/**
 * The three places land is bought in: the farm's valley, and the city's and
 * the sanctuary's lots. All three are the same 3x3 of 40x40 cells with the
 * middle one to start with, and every map keeps what it owns as a Set of cell
 * indices called `owned` (the farm's on its Grid, the others on the place
 * itself), so the buying below is written once.
 *
 * `step` is what each cell costs times the number already owned.
 */
export const LANDS = {
  farm: { step: LAND_PRICE_STEP, noun: 'plot', map: (state) => state.grid },
  city: { step: CITY_LOT_PRICE_STEP, noun: 'lot', map: (state) => state.city },
  sanctuary: { step: SANCTUARY_LOT_PRICE_STEP, noun: 'lot', map: (state) => state.sanctuary },
};

function landOf(where) { return LANDS[where] || LANDS.farm; }
function landMap(state, where) { return landOf(where).map(state); }

/**
 * What the next plot costs. Each one is dearer than the last, and each is a
 * whole farm's worth of land, so these are deliberately large: the first is a
 * serious goal and the ninth is a long game.
 *
 * Linear in the number already owned, so the price is easy to predict: plot
 * two is one step, plot three is two steps, and so on.
 */
export function landPrice(ownedCount, step = LAND_PRICE_STEP) {
  return step * Math.max(1, ownedCount);
}

export function ownedCount(state, where = 'farm') { return landMap(state, where).owned.size; }

export function nextLandPrice(state, where = 'farm') {
  return landPrice(ownedCount(state, where), landOf(where).step);
}

/**
 * Buyable plots must touch land you already own, so the farm stays one connected
 * property instead of a scatter of islands with the farmer marooned between.
 * The same goes for a city's lots: one city, not three villages.
 */
export function isPlotAdjacentToOwned(state, px, py, where = 'farm') {
  const map = landMap(state, where);
  const around = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  return around.some(([dx, dy]) => {
    const nx = px + dx;
    const ny = py + dy;
    if (!plotInBounds(nx, ny, map.w, map.h)) return false;
    return map.owned.has(plotIndex(nx, ny, map.w));
  });
}

/**
 * @returns {{ok: boolean, reason?: string, price: number}}
 */
export function canBuyPlot(state, px, py, where = 'farm') {
  const map = landMap(state, where);
  const { noun } = landOf(where);
  const price = nextLandPrice(state, where);
  if (!plotInBounds(px, py, map.w, map.h)) {
    return { ok: false, reason: where === 'farm' ? "that's past the edge of the valley" : "that's past the edge", price };
  }
  if (map.owned.has(plotIndex(px, py, map.w))) {
    return { ok: false, reason: `you already own that ${noun === 'plot' ? 'land' : noun}`, price };
  }
  if (!isPlotAdjacentToOwned(state, px, py, where)) {
    return { ok: false, reason: where === 'farm' ? 'land has to border your farm' : 'a lot has to border one you own', price };
  }
  if (state.money < price) {
    return { ok: false, reason: `that costs $${price}`, price };
  }
  return { ok: true, price };
}

/** Buys a plot outright. Land is not a task — the farmer doesn't fetch a deed. */
export function buyPlot(state, px, py, where = 'farm') {
  const check = canBuyPlot(state, px, py, where);
  if (!check.ok) return check;

  const map = landMap(state, where);
  state.money -= check.price;
  map.owned.add(plotIndex(px, py, map.w));
  // A built place keeps facts worked out from its layout until `rev` moves.
  if (where !== 'farm') map.rev = (map.rev || 0) + 1;
  return { ok: true, price: check.price };
}

/** Every plot that could be bought right now, cheapest question first. */
export function buyablePlots(state, where = 'farm') {
  const map = landMap(state, where);
  const out = [];
  for (let py = 0; py < plotsDown(map.h); py++) {
    for (let px = 0; px < plotsAcross(map.w); px++) {
      const idx = plotIndex(px, py, map.w);
      if (map.owned.has(idx)) continue;
      if (!isPlotAdjacentToOwned(state, px, py, where)) continue;
      out.push({ px, py });
    }
  }
  return out;
}

export function totalPlots(state, where = 'farm') {
  const map = landMap(state, where);
  return plotsAcross(map.w) * plotsDown(map.h);
}

/** The middle cell of a map: where a city or sanctuary starts. */
export function middlePlot(w, h) {
  return { px: Math.floor(plotsAcross(w) / 2), py: Math.floor(plotsDown(h) / 2) };
}
