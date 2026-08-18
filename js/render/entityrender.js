// Draws the farmer (and later animals), interpolated between simulation ticks.
//
// The sim moves one whole tile per tick. Drawing that raw would look like a
// 1 fps hop, so we lerp from the previous tile to the current one using the
// loop's alpha (0..1 progress toward the next tick).

import { TILE } from '../config.js';
import { SPRITES, EMOTES } from './sprites.js';
import { blit } from './tilerender.js';
import {
  animalDef, isNeglected, isThirsty, currentEmote, isReady, variantOf,
} from '../sim/animals.js';
import { carriedTotal, isFull } from '../sim/farmhand.js';

/**
 * Everything that moves, bucketed by the tile row it should sort into.
 *
 * The object pass draws row by row, so handing it these lets a mover slot into
 * the same ordering as scenery: someone standing on a tile the barn roof
 * overhangs is drawn *before* the barn and ends up behind it, instead of
 * appearing to walk across the roof.
 *
 * @returns {Map<number, Array<(ctx, sheets) => void>>}
 */
/**
 * Emote bubbles, drawn after everything else rather than in the row pass.
 *
 * A bubble floats above the animal's head, which means it lands on the row
 * above — where scenery on that row would paint straight over it. Sorting it
 * with the animal would be wrong for the same reason. So it goes last, on top
 * of the world: it's a caption, not part of the scene.
 */
export function drawEmotes(ctx, sheets, state, view, alpha) {
  for (const a of state.animals || []) {
    const id = currentEmote(a, state.tickCount);
    if (!id || !EMOTES[id]) continue;
    if (a.x < view.x0 - 1 || a.x > view.x1 + 1) continue;
    if (a.y < view.y0 - 1 || a.y > view.y1 + 1) continue;

    const x = lerp(a.px ?? a.x, a.x, alpha) * TILE;
    const y = lerp(a.py ?? a.y, a.y, alpha) * TILE;
    // A slow bob, so a bubble that hangs around for a few seconds still reads
    // as alive rather than pasted on.
    const bob = Math.floor(state.tickCount / 2) % 2 === 0 ? -1 : 0;
    blit(ctx, sheets, EMOTES[id], Math.round(x), Math.round(y) - TILE + bob);
  }
}

export function entitiesByRow(state, alpha) {
  const rows = new Map();
  const add = (y, fn) => {
    const key = Math.round(y);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(fn);
  };

  for (const a of state.animals || []) {
    const pos = { x: lerp(a.px ?? a.x, a.x, alpha), y: lerp(a.py ?? a.y, a.y, alpha) };
    add(pos.y, (ctx, sheets) => drawAnimal(ctx, sheets, state, a, pos));
  }

  for (const h of state.hands || []) {
    const pos = { x: lerp(h.px ?? h.x, h.x, alpha), y: lerp(h.py ?? h.y, h.y, alpha) };
    add(pos.y, (ctx, sheets) => drawHand(ctx, sheets, state, h, pos));
  }

  const f = state.farmer;
  const fp = alongTrail(f, alpha);
  add(fp.y, (ctx, sheets) => drawFarmerAt(ctx, sheets, state, fp, alpha));

  return rows;
}

/**
 * The hired help: the same character without the hat, which is the sheet's own
 * way of saying "one of these is the boss".
 */
function drawHand(ctx, sheets, state, hand, pos) {
  const x = pos.x * TILE;
  const y = pos.y * TILE;
  const working = hand.work > 0;
  const bob = working && Math.floor(state.tickCount) % 2 === 0 ? -1 : 0;

  blit(ctx, sheets, SPRITES.farmer, Math.round(x), Math.round(y) - 2 + bob, hand.facing === 'left');

  // Carrying something worth taking off them: the same badge a ready animal
  // wears, since it means the same thing — there is something here for you.
  if (carriedTotal(hand) > 0) {
    const full = isFull(hand);
    drawBadge(ctx, x + TILE - 6, y - 3, full ? '#ffe680' : '#cbb27a', '#8a6a10');
  }
}

function drawFarmerAt(ctx, sheets, state, pos, alpha) {
  const f = state.farmer;
  const x = pos.x * TILE;
  const y = pos.y * TILE;

  const working = f.taskId !== null && f.work > 0;
  // A one-pixel bob while working reads as effort without needing animation
  // frames, which this sheet doesn't have. Driven by the tick alone, not by
  // alpha: a farmer standing still to chop produces no frames between ticks,
  // so an alpha-driven bob would just stutter at whatever rate frames happened
  // to be drawn.
  const bob = working && state.tickCount % 2 === 0 ? -1 : 0;

  // The farmer sprite is a head-and-shoulders tile; nudge it up slightly so it
  // sits on the tile rather than dead-center in it.
  blit(ctx, sheets, SPRITES.farmerHat, Math.round(x), Math.round(y) - 2 + bob, f.facing === 'left');

  if (working) drawWorkBar(ctx, state, x, y);
}

function drawWorkBar(ctx, state, x, y) {
  const task = state.tasks.find((t) => t.id === state.farmer.taskId);
  if (!task || !task.work) return;

  const pct = Math.min(1, (task.progress || 0) / task.work);
  const w = TILE - 4;
  const bx = x + 2;
  const by = y - 6;

  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(bx - 1, by - 1, w + 2, 4);
  ctx.fillStyle = '#f4e4c1';
  ctx.fillRect(bx, by, w, 2);
  ctx.fillStyle = '#5ec24f';
  ctx.fillRect(bx, by, Math.round(w * pct), 2);
}

/**
 * Marks the first corner of a tilling row while the player picks the second.
 * Without this the game looks unresponsive to that first tap.
 */
export function drawTillAnchor(ctx, anchor, tickCount) {
  const x = anchor.x * TILE;
  const y = anchor.y * TILE;

  ctx.globalAlpha = 0.35 + 0.2 * Math.sin(tickCount / 1.5);
  ctx.fillStyle = '#ffe680';
  ctx.fillRect(x, y, TILE, TILE);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = '#fff3b0';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
}

/**
 * Animals, interpolated like the farmer. Two markers matter here: a neglected
 * animal has stopped producing, and a ready one is waiting to be collected.
 * Neither is ever fatal, so the neglect marker is a nudge rather than an alarm —
 * but without it an idle barn is indistinguishable from a broken one.
 */
function drawAnimal(ctx, sheets, state, a, pos) {
  const def = animalDef(a.type);
  if (!def) return;

  const x = pos.x * TILE;
  const y = pos.y * TILE;
  // Row picks the animal, column picks the colour it was born.
  blit(ctx, sheets, [variantOf(a), def.row, 'animals'],
    Math.round(x), Math.round(y) - 1, a.facing === 'left');

  if (isReady(a)) {
    // A gentle bob so a collectable animal catches the eye while panning.
    const bob = Math.sin(state.tickCount / 3) < 0 ? -1 : 0;
    drawBadge(ctx, x + TILE - 6, y - 3 + bob, '#ffe680', '#8a6a10');
  } else if (isNeglected(a)) {
    drawBadge(ctx, x + TILE - 6, y - 2,
      isThirsty(a) ? '#4aa3e0' : '#d9a441', 'rgba(0,0,0,0.45)');
  }
}

/**
 * What the player is carrying with the move tool, shown where it would land.
 *
 * The same sprite as the thing itself, half faded, over a tinted square that
 * says whether letting go here would work — the same green-and-red language
 * siting a barn already uses.
 */
export function drawCarriedGhost(ctx, sheets, state, carried) {
  const { what, x, y, valid } = carried;
  if (!what) return;

  ctx.save();
  ctx.globalAlpha = 0.6;
  if (what.kind === 'animal') drawAnimalSprite(ctx, sheets, what.ref.type, { x, y }, variantOf(what.ref));
  else if (what.kind === 'hand') drawHandSprite(ctx, sheets, { x, y });
  else blit(ctx, sheets, SPRITES.farmerHat, x * TILE, y * TILE - 2);
  ctx.restore();

  ctx.globalAlpha = 0.3;
  ctx.fillStyle = valid ? '#5ec24f' : '#e5533d';
  ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = valid ? '#bdf5b0' : '#ffb4a6';
  ctx.lineWidth = 1;
  ctx.strokeRect(x * TILE + 0.5, y * TILE + 0.5, TILE - 1, TILE - 1);
}

/** One farmhand sprite at a tile, used for the placement ghost. */
export function drawHandSprite(ctx, sheets, at) {
  blit(ctx, sheets, SPRITES.farmer, at.x * TILE, at.y * TILE - 2);
}

/** One animal sprite at a tile, used for the placement ghost. */
export function drawAnimalSprite(ctx, sheets, type, at, variant = 0) {
  const def = animalDef(type);
  if (!def) return;
  blit(ctx, sheets, [variant, def.row, 'animals'], at.x * TILE, at.y * TILE - 1);
}

function drawBadge(ctx, x, y, fill, edge) {
  ctx.fillStyle = edge;
  ctx.fillRect(x - 1, y - 1, 6, 6);
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, 4, 4);
}

/**
 * Ghost preview while siting a large structure: the building drawn faintly
 * where it would go, with its footprint tinted green or red. Without this a
 * 3x2 barn is dropped blind and costs 50 wood to get wrong.
 */
export function drawPlacementGhost(ctx, sheets, pending) {
  const { x, y, w, h, valid } = pending;

  ctx.save();
  ctx.globalAlpha = 0.55;
  if (pending.draw) pending.draw(ctx, sheets, { x, y });
  ctx.restore();

  ctx.globalAlpha = 0.35;
  ctx.fillStyle = valid ? '#5ec24f' : '#e5533d';
  ctx.fillRect(x * TILE, y * TILE, w * TILE, h * TILE);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = valid ? '#bdf5b0' : '#ffb4a6';
  ctx.lineWidth = 1;
  ctx.strokeRect(x * TILE + 0.5, y * TILE + 0.5, w * TILE - 1, h * TILE - 1);
}

/** Highlights tiles that have queued work, so the player can see the plan. */
export function drawTaskMarkers(ctx, state, view) {
  const time = state.tickCount;
  for (const task of state.tasks) {
    // Most tasks cover one tile; structures carry their own footprint, so a
    // queued barn is outlined across all six tiles it will stand on rather
    // than just its anchor.
    const w = task.w || 1;
    const h = task.h || 1;
    if (task.x + w - 1 < view.x0 || task.x > view.x1) continue;
    if (task.y + h - 1 < view.y0 || task.y > view.y1) continue;

    const active = task.id === state.farmer.taskId;
    const x = task.x * TILE;
    const y = task.y * TILE;
    const pw = w * TILE;
    const ph = h * TILE;

    if (active) {
      // Pulse the current task so it's obvious what the farmer is heading for.
      ctx.globalAlpha = 0.25 + 0.15 * Math.sin(time / 2);
      ctx.fillStyle = '#ffe680';
      ctx.fillRect(x, y, pw, ph);
      ctx.globalAlpha = 1;
    }

    ctx.strokeStyle = active ? '#ffe680' : 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, pw - 1, ph - 1);

    // Multi-tile work also gets its interior tile edges hinted, so the player
    // can count the ground it will take up.
    if (w > 1 || h > 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      for (let i = 1; i < w; i++) {
        ctx.beginPath();
        ctx.moveTo(x + i * TILE + 0.5, y + 1);
        ctx.lineTo(x + i * TILE + 0.5, y + ph - 1);
        ctx.stroke();
      }
      for (let j = 1; j < h; j++) {
        ctx.beginPath();
        ctx.moveTo(x + 1, y + j * TILE + 0.5);
        ctx.lineTo(x + pw - 1, y + j * TILE + 0.5);
        ctx.stroke();
      }
    }
  }
}

/**
 * Position along the tiles the farmer stepped through this tick, spreading
 * alpha evenly across the segments. Following the polyline (rather than lerping
 * straight from first tile to last) keeps a multi-tile step on the actual route
 * when it turns a corner.
 */
function alongTrail(f, alpha) {
  const trail = f.trail && f.trail.length ? f.trail : [{ x: f.x, y: f.y }];
  if (trail.length === 1) return trail[0];

  const segments = trail.length - 1;
  const t = clamp01(alpha) * segments;
  const i = Math.min(segments - 1, Math.floor(t));
  const local = t - i;
  const a = trail[i];
  const b = trail[i + 1];

  return { x: lerp(a.x, b.x, local), y: lerp(a.y, b.y, local) };
}

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
