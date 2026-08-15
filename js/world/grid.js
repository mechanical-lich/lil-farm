// The tile grid: two parallel layers (ground + objects) stored as flat typed
// arrays. Serializes to plain number arrays for JSON.

import { GROUND, OBJ, objDef } from './tiledefs.js';

export class Grid {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.ground = new Uint8Array(w * h);
    this.objects = new Uint8Array(w * h);
  }

  idx(x, y) { return y * this.w + x; }

  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }

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
    };
  }

  static fromJSON(data) {
    const g = new Grid(data.w, data.h);
    g.ground.set(data.ground);
    g.objects.set(data.objects);
    return g;
  }
}
