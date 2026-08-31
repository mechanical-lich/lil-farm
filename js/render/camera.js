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
    // How far past the edge of the map the view may be pushed, in CSS pixels.
    // The bars along the top and bottom sit *over* the map, so a tile beneath
    // one cannot be tapped; letting the view run on past the edge is what makes
    // the first and last rows of the valley reachable at all. Set from the real
    // heights of those bars — see main.js.
    this.inset = { top: 0, bottom: 0, left: 0, right: 0 };
  }

  /** @param {{top?: number, bottom?: number, left?: number, right?: number}} inset */
  setInset(inset) {
    this.inset = { ...this.inset, ...inset };
    this.clamp();
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

    // The overscroll is measured in screen pixels and used in world ones, so it
    // has to be divided by the zoom: the bars cover the same amount of *screen*
    // however far in the map is zoomed.
    const top = this.inset.top / this.zoom;
    const bottom = this.inset.bottom / this.zoom;
    const left = this.inset.left / this.zoom;
    const right = this.inset.right / this.zoom;

    // If the map is smaller than the view, centre it instead of clamping.
    this.x = visW >= worldW
      ? (worldW - visW) / 2
      : clampNum(this.x, -left, worldW - visW + right);
    this.y = visH >= worldH
      ? (worldH - visH) / 2
      : clampNum(this.y, -top, worldH - visH + bottom);
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

  /**
   * The tile in the middle of what is on screen right now.
   *
   * Where a placement ghost starts. It used to start on the farmer and drag the
   * camera along with it, which moved the player away from whatever they had
   * navigated to in order to build there — the farmer is usually off doing a
   * job somewhere else entirely.
   */
  centreTile() {
    return this.screenToTile(this.viewW / 2, this.viewH / 2);
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
