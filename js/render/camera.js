// Camera: world<->screen transforms, pan and zoom, clamped to the map.

import { TILE, ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT } from '../config.js';

export class Camera {
  constructor(mapW, mapH) {
    this.mapW = mapW;
    this.mapH = mapH;
    this.zoom = ZOOM_DEFAULT;   // screen pixels per source pixel
    this.x = 0;                 // top-left of the view, in world pixels
    this.y = 0;
    this.viewW = 1;             // CSS pixels
    this.viewH = 1;
  }

  setViewport(w, h) {
    this.viewW = w;
    this.viewH = h;
    this.clamp();
  }

  centerOnTile(tx, ty) {
    this.x = (tx + 0.5) * TILE - this.viewW / (2 * this.zoom);
    this.y = (ty + 0.5) * TILE - this.viewH / (2 * this.zoom);
    this.clamp();
  }

  panBy(dxScreen, dyScreen) {
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
    this.clamp();
  }

  /** Zoom about a fixed screen point so pinch/scroll feels anchored. */
  zoomAt(screenX, screenY, factor) {
    const before = this.screenToWorld(screenX, screenY);
    this.zoom = clampNum(this.zoom * factor, ZOOM_MIN, ZOOM_MAX);
    const after = this.screenToWorld(screenX, screenY);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }

  clamp() {
    const worldW = this.mapW * TILE;
    const worldH = this.mapH * TILE;
    const visW = this.viewW / this.zoom;
    const visH = this.viewH / this.zoom;

    // If the map is smaller than the view, center it instead of clamping.
    this.x = visW >= worldW ? (worldW - visW) / 2 : clampNum(this.x, 0, worldW - visW);
    this.y = visH >= worldH ? (worldH - visH) / 2 : clampNum(this.y, 0, worldH - visH);
  }

  screenToWorld(sx, sy) {
    return { x: this.x + sx / this.zoom, y: this.y + sy / this.zoom };
  }

  worldToScreen(wx, wy) {
    return { x: (wx - this.x) * this.zoom, y: (wy - this.y) * this.zoom };
  }

  screenToTile(sx, sy) {
    const w = this.screenToWorld(sx, sy);
    return { x: Math.floor(w.x / TILE), y: Math.floor(w.y / TILE) };
  }

  /** Inclusive tile bounds currently visible, padded for tall sprites. */
  visibleTiles(pad = 1) {
    return {
      x0: Math.max(0, Math.floor(this.x / TILE) - pad),
      y0: Math.max(0, Math.floor(this.y / TILE) - pad),
      x1: Math.min(this.mapW - 1, Math.floor((this.x + this.viewW / this.zoom) / TILE) + pad),
      y1: Math.min(this.mapH - 1, Math.floor((this.y + this.viewH / this.zoom) / TILE) + pad),
    };
  }
}

function clampNum(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
