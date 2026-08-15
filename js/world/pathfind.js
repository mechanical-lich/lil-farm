// A* over the tile grid, 4-directional.
//
// Runs inside the simulation, so it must stay deterministic: ties are broken by
// a stable rule, never by iteration order of a hash map or by Math.random().

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** Is (x,y) inside the w x h box anchored at (bx,by)? */
export function insideBox(bx, by, w, h, x, y) {
  return x >= bx && x < bx + w && y >= by && y < by + h;
}

/**
 * Is (x,y) orthogonally touching the box without being inside it?
 *
 * Multi-tile structures need this: "stand next to the barn" means beside any of
 * its six tiles, not beside its anchor corner. Measuring against the anchor
 * alone would let the farmer work from a tile the building is about to occupy,
 * leaving him embedded in the finished wall.
 */
export function besideBox(bx, by, w, h, x, y) {
  if (insideBox(bx, by, w, h, x, y)) return false;
  const inCols = x >= bx && x < bx + w;
  const inRows = y >= by && y < by + h;
  return (inCols && (y === by - 1 || y === by + h))
      || (inRows && (x === bx - 1 || x === bx + w));
}

/**
 * @param {import('./grid.js').Grid} grid
 * @param {{x:number,y:number}} start
 * @param {{x:number,y:number}} goal
 * @param {object} [opts]
 * @param {'farmer'|'animal'} [opts.actor]
 * @param {boolean} [opts.adjacent] Stop on any tile orthogonally touching the
 *   goal instead of the goal itself. Used for working on blocking things like
 *   trees and rocks, which the farmer must stand next to rather than on.
 * @param {number} [opts.maxNodes] Search budget; prevents a walled-off target
 *   from scanning the whole map every retry.
 * @returns {Array<{x:number,y:number}>|null} Path excluding the start tile.
 */
export function findPath(grid, start, goal, opts = {}) {
  const actor = opts.actor || 'farmer';
  const adjacent = !!opts.adjacent;
  const maxNodes = opts.maxNodes || 6000;

  const w = grid.w;
  const key = (x, y) => y * w + x;
  const startKey = key(start.x, start.y);

  // Goals may be a multi-tile box (a barn); default is a single tile.
  const gw = opts.w || 1;
  const gh = opts.h || 1;

  const isGoal = adjacent
    ? (x, y) => besideBox(goal.x, goal.y, gw, gh, x, y)
    : (x, y) => insideBox(goal.x, goal.y, gw, gh, x, y);

  // Standing on the target already counts when we only need to be adjacent.
  if (isGoal(start.x, start.y)) return [];
  if (!adjacent && !grid.isWalkable(goal.x, goal.y, actor)) return null;

  const open = new MinHeap();
  const cameFrom = new Map();
  const gScore = new Map([[startKey, 0]]);
  const closed = new Set();

  open.push({ x: start.x, y: start.y, f: heuristic(start, goal), k: startKey });

  let expanded = 0;
  while (open.size > 0) {
    const cur = open.pop();
    if (closed.has(cur.k)) continue;
    closed.add(cur.k);

    if (isGoal(cur.x, cur.y)) return reconstruct(cameFrom, cur.k, start, w);
    if (++expanded > maxNodes) return null;

    const curG = gScore.get(cur.k);
    for (const [dx, dy] of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!grid.inBounds(nx, ny)) continue;
      if (!grid.isWalkable(nx, ny, actor)) continue;

      const nk = key(nx, ny);
      if (closed.has(nk)) continue;

      const tentative = curG + 1;
      if (tentative < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, tentative);
        cameFrom.set(nk, cur.k);
        open.push({ x: nx, y: ny, f: tentative + heuristic({ x: nx, y: ny }, goal), k: nk });
      }
    }
  }

  return null;
}

function heuristic(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function reconstruct(cameFrom, endKey, start, w) {
  const path = [];
  let k = endKey;
  const startKey = start.y * w + start.x;
  while (k !== startKey) {
    path.push({ x: k % w, y: Math.floor(k / w) });
    k = cameFrom.get(k);
    if (k === undefined) return null;
  }
  return path.reverse();
}

/** Binary heap keyed on f, with the node key as a stable tiebreaker. */
class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }

  push(node) {
    const a = this.items;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break;
    }
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && less(a[l], a[m])) m = l;
        if (r < a.length && less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

function less(a, b) {
  return a.f !== b.f ? a.f < b.f : a.k < b.k;
}
