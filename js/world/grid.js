// The tile grid: two parallel layers (ground + objects) stored as flat typed
// arrays. Serializes to plain number arrays for JSON.

import { GROUND, OBJ, objDef } from './tiledefs.js';
import { plotIndexFor, plotIndex } from './land.js';

export class Grid {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.ground = new Uint8Array(w * h);
    this.objects = new Uint8Array(w * h);
    /**
     * Plot indices the player has bought. Everything outside is scenery: it
     * renders, but nothing can walk on it, be worked, or be built on. See
     * land.js for why this lives here and not on the state beside it.
     * @type {Set<number>}
     */
    this.owned = new Set();
  }

  idx(x, y) { return y * this.w + x; }

  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }

  /** Is this tile on land the player has bought? */
  isOwned(x, y) {
    return this.inBounds(x, y) && this.owned.has(plotIndexFor(this.w, x, y));
  }

  own(px, py) { this.owned.add(plotIndex(px, py, this.w)); }

  getGround(x, y) { return this.inBounds(x, y) ? this.ground[this.idx(x, y)] : GROUND.GRASS; }
  getObject(x, y) { return this.inBounds(x, y) ? this.objects[this.idx(x, y)] : OBJ.NONE; }

  setGround(x, y, id) {
    if (this.inBounds(x, y)) this.ground[this.idx(x, y)] = id;
  }

  setObject(x, y, id) {
    if (this.inBounds(x, y)) this.objects[this.idx(x, y)] = id;
  }

  /**
   * @param {'farmer'|'animal'} actor Gates are passable for the farmer (who can
   *   open them) but not for animals, so walkability depends on who is asking.
   */
  isWalkable(x, y, actor = 'farmer') {
    if (!this.inBounds(x, y)) return false;
    // Unbought land is the edge of the world as far as anyone living here is
    // concerned. Doing this here rather than at each call site is what keeps
    // the farmer and the animals from ever disagreeing about the boundary.
    if (!this.owned.has(plotIndexFor(this.w, x, y))) return false;
    const def = objDef(this.objects[this.idx(x, y)]);
    if (def.blocks) return false;
    if (actor === 'animal' && def.blocksAnimals) return false;
    return true;
  }

  forEach(fn) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        fn(x, y, this.ground[this.idx(x, y)], this.objects[this.idx(x, y)]);
      }
    }
  }

  toJSON() {
    return {
      w: this.w,
      h: this.h,
      ground: Array.from(this.ground),
      objects: Array.from(this.objects),
      owned: Array.from(this.owned),
    };
  }

  static fromJSON(data) {
    const g = new Grid(data.w, data.h);
    g.ground.set(data.ground);
    g.objects.set(data.objects);
    for (const idx of data.owned || []) g.owned.add(idx);
    return g;
  }
}
