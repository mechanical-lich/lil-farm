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

import { MAP_W, MAP_H, CELL_W, LAND_PRICE_STEP } from '../config.js';

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
 * What the next plot costs. Each one is dearer than the last, and each is a
 * whole farm's worth of land, so these are deliberately large: the first is a
 * serious goal and the ninth is a long game.
 *
 * Linear in the number already owned, so the price is easy to predict: plot
 * two is one step, plot three is two steps, and so on.
 */
export function landPrice(ownedCount) {
  return LAND_PRICE_STEP * Math.max(1, ownedCount);
}

export function ownedCount(state) { return state.grid.owned.size; }

export function nextLandPrice(state) { return landPrice(ownedCount(state)); }

/**
 * Buyable plots must touch land you already own, so the farm stays one connected
 * property instead of a scatter of islands with the farmer marooned between.
 */
export function isPlotAdjacentToOwned(state, px, py) {
  const { grid } = state;
  const around = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  return around.some(([dx, dy]) => {
    const nx = px + dx;
    const ny = py + dy;
    if (!plotInBounds(nx, ny, grid.w, grid.h)) return false;
    return grid.owned.has(plotIndex(nx, ny, grid.w));
  });
}

/**
 * @returns {{ok: boolean, reason?: string, price: number}}
 */
export function canBuyPlot(state, px, py) {
  const price = nextLandPrice(state);
  if (!plotInBounds(px, py, state.grid.w, state.grid.h)) {
    return { ok: false, reason: "that's past the edge of the valley", price };
  }
  if (state.grid.owned.has(plotIndex(px, py, state.grid.w))) {
    return { ok: false, reason: 'you already own that land', price };
  }
  if (!isPlotAdjacentToOwned(state, px, py)) {
    return { ok: false, reason: 'land has to border your farm', price };
  }
  if (state.money < price) {
    return { ok: false, reason: `that costs $${price}`, price };
  }
  return { ok: true, price };
}

/** Buys a plot outright. Land is not a task — the farmer doesn't fetch a deed. */
export function buyPlot(state, px, py) {
  const check = canBuyPlot(state, px, py);
  if (!check.ok) return check;

  state.money -= check.price;
  state.grid.own(px, py);
  return { ok: true, price: check.price };
}

/** Every plot that could be bought right now, cheapest question first. */
export function buyablePlots(state) {
  const out = [];
  for (let py = 0; py < plotsDown(state.grid.h); py++) {
    for (let px = 0; px < plotsAcross(state.grid.w); px++) {
      const idx = plotIndex(px, py, state.grid.w);
      if (state.grid.owned.has(idx)) continue;
      if (!isPlotAdjacentToOwned(state, px, py)) continue;
      out.push({ px, py });
    }
  }
  return out;
}

export function totalPlots(state) {
  return plotsAcross(state.grid.w) * plotsDown(state.grid.h);
}
