// Which land the player actually owns.
//
// The map is a fixed 40x40, but a farm that starts as 1600 tiles has no room
// left to grow into. So the map is divided into 8x8 plots and the player begins
// owning exactly one — the plot the farmhouse sits in — and buys outward from
// there. Everything past the fence line is drawn dimmed: visible, obviously
// yours-to-take, and completely inert until it's paid for.
//
// Ownership lives on the Grid rather than beside it, because that's what makes
// `isWalkable` able to answer it. Pathfinding, animal wandering and task
// validation all funnel through that one method, so containment falls out for
// free instead of being re-checked in four places that could disagree.
//
// This module deliberately imports nothing from grid.js — grid.js imports the
// plot maths from here.

import { MAP_W, MAP_H, LAND_PRICE_STEP } from '../config.js';
import { GROUND, OBJ } from './tiledefs.js';

/** Tiles along one edge of a plot. 8x8 = 64 tiles, a decent field. */
export const PLOT = 8;

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
 * What the next plot costs. Each one is dearer than the last — the first is
 * within reach of a few good harvests, and filling the whole map is a long game
 * rather than something a good tomato season pays for outright.
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

/**
 * Grants land to a save written before land could be owned.
 *
 * A v1 farm effectively owned the whole map, so anything this doesn't grant is
 * something taken away from someone who already had it. It therefore errs
 * heavily toward generosity: every plot showing any sign of use is granted, on
 * the reasoning that a plot with a fence post or a tilled row in it is one the
 * player built on and would be furious to find fenced off.
 *
 * Works on the serialized shape, not a live state — this runs inside migrate(),
 * before there is a Grid to ask.
 *
 * @param {object} data a v1 save
 * @returns {number[]} plot indices to grant
 */
export function grantLegacyLand(data) {
  const map = data.map || {};
  const w = map.w || MAP_W;
  const h = map.h || MAP_H;
  const granted = new Set();
  const grantTile = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    granted.add(plotIndexFor(w, x, y));
  };

  if (data.farmer) grantTile(data.farmer.x, data.farmer.y);
  for (const b of data.buildings || []) {
    // The whole footprint, not just the anchor: a barn can straddle two plots.
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 3; dx++) grantTile(b.x + dx, b.y + dy);
  }
  for (const a of data.animals || []) grantTile(a.x, a.y);
  for (const t of data.tasks || []) grantTile(t.x, t.y);
  for (const key of Object.keys(data.troughs || {})) {
    const comma = key.indexOf(',');
    grantTile(+key.slice(0, comma), +key.slice(comma + 1));
    grantTile(+key.slice(0, comma) + 1, +key.slice(comma + 1));
  }
  for (const key of Object.keys(data.crops || {})) {
    const comma = key.indexOf(',');
    grantTile(+key.slice(0, comma), +key.slice(comma + 1));
  }

  // Anything worked or built: tilled soil, roads, fences, gates, troughs. Bare
  // dirt counts too — it's what clearing a tile used to leave behind.
  const ground = map.ground || [];
  const objects = map.objects || [];
  for (let i = 0; i < ground.length; i++) {
    const worked = ground[i] !== GROUND.GRASS || WORKED_OBJECTS.has(objects[i]);
    if (worked) grantTile(i % w, Math.floor(i / w));
  }

  // A save with nothing at all in it still has to be playable.
  if (granted.size === 0) {
    const centre = plotOfTile(Math.floor(w / 2), Math.floor(h / 2));
    granted.add(plotIndex(centre.px, centre.py, w));
  }
  return Array.from(granted).sort((a, b) => a - b);
}

/** Objects that only exist because a player put them there. */
const WORKED_OBJECTS = new Set([
  OBJ.FENCE, OBJ.GATE, OBJ.TROUGH_WATER, OBJ.TROUGH_FOOD, OBJ.BARREL, OBJ.BUILDING,
]);
