// Canvas setup and the top-level draw call.

import { COLORS } from '../config.js';
import { drawGround, drawCrops, drawObjects } from './tilerender.js';
import { drawFarmer, drawTaskMarkers, drawTillAnchor, drawPlacementGhost } from './entityrender.js';

export class Renderer {
  constructor(canvas, sheets, camera) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.sheets = sheets;
    this.camera = camera;
    this.dpr = 1;
    this.resize();
  }

  /** Sizes the backing store to CSS pixels x devicePixelRatio for crisp art. */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);

    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.cssW = cssW;
    this.cssH = cssH;
    this.camera.setViewport(cssW, cssH);
    this.ctx.imageSmoothingEnabled = false;
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
    drawObjects(ctx, this.sheets, state, view);
    drawFarmer(ctx, this.sheets, state, alpha);
    if (overlay?.tillAnchor) drawTillAnchor(ctx, overlay.tillAnchor, state.tickCount);
    if (overlay?.pending) drawPlacementGhost(ctx, this.sheets, overlay.pending);

    ctx.restore();
  }
}
