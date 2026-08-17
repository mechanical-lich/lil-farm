// Canvas setup and the top-level draw call.

import { COLORS, MAX_FPS, MAX_DPR } from '../config.js';
import { drawGround, drawCrops, drawObjects, drawUnowned } from './tilerender.js';
import {
  entitiesByRow, drawTaskMarkers, drawTillAnchor, drawPlacementGhost, drawEmotes,
} from './entityrender.js';

export class Renderer {
  constructor(canvas, sheets, camera) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.sheets = sheets;
    this.camera = camera;
    this.dpr = 1;

    // Frame skipping. This is an idle game: most of the time nothing on screen
    // is different from the last frame, and redrawing it anyway is pure heat.
    // A couple of milliseconds under the true interval. Frame times are whole
    // milliseconds, so a 60Hz display offers frames at 0, 17, 33, 50... and an
    // exact 33.33ms gate rejects the one at 33 — leaving every third frame, or
    // 20fps, when 30 was asked for. The slop makes the gate land where it
    // should on 60Hz and 120Hz alike.
    this.minFrameMs = 1000 / MAX_FPS - 2;
    this.lastDrawAt = 0;
    // The last frame's visual signature, kept as separate numbers rather than
    // a string: this is compared on every animation frame, and building a
    // string 120 times a second to throw it away is exactly the sort of litter
    // this whole change exists to avoid.
    this.last = { tick: -1, cx: 0, cy: 0, zoom: 0, gx: -1, gy: -1, gok: 0, ax: -1, ay: -1 };
    this.forceNext = true;
    this.resize();
  }

  /** Sizes the backing store to CSS pixels x devicePixelRatio for crisp art. */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.cssW = cssW;
    this.cssH = cssH;
    this.camera.setViewport(cssW, cssH);
    this.ctx.imageSmoothingEnabled = false;
    this.forceNext = true;         // the canvas was just cleared by resizing
  }

  /** Redraw on the next opportunity even if nothing looks different. */
  invalidate() { this.forceNext = true; }

  /**
   * Draws only if there is any point.
   *
   * Two questions: has anything changed, and is anything mid-move? The world
   * only changes on a tick, and between ticks the only thing that moves is an
   * entity being interpolated toward its next tile. If neither is true the
   * frame would be identical to the last one.
   *
   * The saving is the whole point of the exercise: an idle farm goes from ~300
   * sprite draws sixty times a second to ~300 once a second.
   *
   * @returns {boolean} whether it actually drew
   */
  drawIfNeeded(state, alpha, overlay, now) {
    const key = frameKey(state, this.camera, overlay, this.dpr);
    const same = sameFrame(this.last, key);

    if (!this.forceNext && same && !anythingMoving(state)) return false;
    // Even when there is something to show, there is no sense drawing it more
    // often than MAX_FPS.
    if (!this.forceNext && now - this.lastDrawAt < this.minFrameMs) return false;

    this.draw(state, alpha, overlay);
    this.last = key;
    this.lastDrawAt = now;
    this.forceNext = false;
    return true;
  }

  draw(state, alpha = 1, overlay = null) {
    const { ctx, camera } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = COLORS.sky;
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    // Work in world pixels: translate by the camera, scale by zoom. Rounding
    // the translation to whole device pixels prevents shimmering seams.
    ctx.save();
    const tx = -Math.round(camera.x * camera.zoom * this.dpr) / this.dpr;
    const ty = -Math.round(camera.y * camera.zoom * this.dpr) / this.dpr;
    ctx.translate(tx, ty);
    ctx.scale(camera.zoom, camera.zoom);

    const view = camera.visibleTiles();
    drawGround(ctx, this.sheets, state, view);
    drawTaskMarkers(ctx, state, view);
    drawCrops(ctx, this.sheets, state, view);
    // Movers are handed to the object pass so they sort by row alongside
    // scenery rather than always being painted on top of it.
    drawObjects(ctx, this.sheets, state, view, entitiesByRow(state, alpha));
    drawUnowned(ctx, state, view);
    drawEmotes(ctx, this.sheets, state, view, alpha);
    if (overlay?.tillAnchor) drawTillAnchor(ctx, overlay.tillAnchor, state.tickCount);
    if (overlay?.pending) drawPlacementGhost(ctx, this.sheets, overlay.pending);

    ctx.restore();
  }
}

/**
 * Is anything partway between two tiles?
 *
 * Movers record where they were at the start of the tick (px/py) and the
 * renderer lerps from there, so "moved this tick" is exactly "px differs from
 * x". The farmer walks several tiles a tick and leaves a trail of them, so for
 * him a trail longer than one entry means he is on the move.
 */
export function anythingMoving(state) {
  if ((state.farmer.trail?.length || 0) > 1) return true;
  for (const a of state.animals || []) if (a.px !== a.x || a.py !== a.y) return true;
  for (const h of state.hands || []) if (h.px !== h.x || h.py !== h.y) return true;
  return false;
}

/**
 * Everything that can change what a still frame looks like: the simulation's
 * clock, where the camera is, and whatever the player is currently placing.
 */
function frameKey(state, camera, overlay, dpr) {
  const ghost = overlay?.pending;
  const anchor = overlay?.tillAnchor;
  return {
    tick: state.tickCount,
    // The *device pixel* the view is translated to, which is what draw()
    // actually rounds to. Keying on the raw camera position would skip frames
    // during a slow drag that really does move the picture, and redraw for
    // sub-pixel changes that don't.
    cx: Math.round(camera.x * camera.zoom * dpr),
    cy: Math.round(camera.y * camera.zoom * dpr),
    zoom: camera.zoom,
    gx: ghost ? ghost.x : -1,
    gy: ghost ? ghost.y : -1,
    gok: ghost && ghost.valid ? 1 : 0,
    ax: anchor ? anchor.x : -1,
    ay: anchor ? anchor.y : -1,
  };
}

function sameFrame(a, b) {
  return a.tick === b.tick && a.cx === b.cx && a.cy === b.cy && a.zoom === b.zoom
    && a.gx === b.gx && a.gy === b.gy && a.gok === b.gok
    && a.ax === b.ax && a.ay === b.ay;
}
