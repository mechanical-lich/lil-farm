// The city: a second map, built with money rather than with the farmer's time.
//
// The farm earns more than it can spend. Once the valley is bought — $72,000,
// a long game — money piles up with nowhere to go, and a number that only
// climbs stops meaning anything. The city is where it goes: a separate map,
// built the way the farm is built, at prices big enough to take a farm's
// income seriously.
//
// WHY IT IS ITS OWN MAP
//
// Everything that lives on the farm acts on state.grid: weeds sprout on its
// grass, mushrooms and flowers come up in it, wild animals wander in across it,
// balloons and lanterns land on it. None of that belongs in a street. Giving
// the city its own small map, rather than a district of the farm's, means none
// of those systems has to learn that some grass is not for them — they simply
// never see it.
//
// WHY IT IS INSTANT
//
// The farmer stays on the farm. A city has no task queue: you pay and it is
// there. That is the trade the player is making — the farm is built with time,
// the city with money — and it keeps the farmer's queue about the farm.
//
// What is built is a list of pieces, each with a footprint, over a ground
// layer of grass, road and pavement. The list is the truth; nothing indexes it,
// because a city is a few hundred pieces at most and every lookup is either the
// player tapping or the once-a-minute population sum.

import { CITY_W, CITY_H } from '../config.js';
import { emitUnlessSuspended } from '../engine/events.js';
import { LINES, MACHINE_PRICE } from './factory.js';
import { plotIndex, plotIndexFor, middlePlot } from '../world/land.js';

/** The ground a city tile can have. Numeric because it is stored per tile. */
export const CITY_GROUND = {
  GRASS: 0,
  ROAD: 1,
  PAVEMENT: 2,
  FLOOR: 3,       // factory floor: the only ground a machine will run on
  TRAIL: 4,       // trodden earth, in the sanctuary
  WATER: 5,       // a pool, in the sanctuary
};

/** Fraction of the price handed back when something is taken down. */
export const CITY_REFUND = 0.5;

// --- prices -------------------------------------------------------------
//
// All guesses, against a whole valley of land at $72,000 and a running farm
// that clears a few thousand an hour. Named so they can be tuned without
// hunting: a road is pocket money, a lamp is a treat, a building is a decision.

export const ROAD_PRICE = 30;
export const PAVEMENT_PRICE = 20;
export const FLOOR_PRICE = 40;

/**
 * A building is a flat base plus a rate per tile, the shape a barn is priced
 * in, so committing to one big block beats dotting small ones about. The
 * smallest apartments (3x3) come to $8,000 and the smallest shop to $5,000.
 */
export const APARTMENT_BASE = 4400;
export const APARTMENT_PER_TILE = 400;
export const SHOP_BASE = 3200;
export const SHOP_PER_TILE = 200;

/** How big each building may be dragged out. Depth includes the roof. */
export const APARTMENT_LIMITS = { minW: 3, maxW: 8, minH: 3, maxH: 6 };
export const SHOP_LIMITS = { minW: 3, maxW: 6, minH: 3, maxH: 4 };

export function apartmentCost(w, h) { return APARTMENT_BASE + APARTMENT_PER_TILE * w * h; }
export function shopCost(w, h) { return SHOP_BASE + SHOP_PER_TILE * w * h; }

/**
 * Everything the city menu can put down.
 *
 * `ground` lays a surface; `building` is dragged out by its corners; anything
 * else is a fixed piece of street furniture with a footprint of `size`. `tall`
 * pieces draw a row of art above the tile they stand on, the way a tree's
 * canopy does on the farm. `line` pieces join up with their neighbours.
 */
export const CITY_BUILDABLES = {
  road: {
    name: 'Road', ground: CITY_GROUND.ROAD, price: ROAD_PRICE,
    hint: 'Asphalt with a kerb — buildings need one at the door',
  },
  pavement: {
    name: 'Pavement', ground: CITY_GROUND.PAVEMENT, price: PAVEMENT_PRICE,
    hint: 'Paving slabs, for walking on',
  },
  apartments: {
    name: 'Apartments', building: 'apartments', limits: APARTMENT_LIMITS, cost: apartmentCost,
    hint: 'Red brick, flat roof — drag out its corners',
  },
  // Shops: one building in four trades. Each wants particular goods from the
  // farm, which is how the city reaches the market — see sim/citylife.js. They
  // share the brown brick and differ in what they sell, which the sign on the
  // roof says.
  bakery: {
    name: 'Bakery', building: 'shop', limits: SHOP_LIMITS, cost: shopCost, goods: ['wheat'],
    hint: 'Wheat sells for more — drag out its corners',
  },
  grocer: {
    name: 'Grocer', building: 'shop', limits: SHOP_LIMITS, cost: shopCost,
    goods: ['carrot', 'corn', 'tomato', 'cabbage', 'eggplant'],
    hint: 'Vegetables sell for more — drag out its corners',
  },
  dairy: {
    name: 'Dairy', building: 'shop', limits: SHOP_LIMITS, cost: shopCost, goods: ['milk', 'goat_milk', 'egg'],
    hint: 'Milk and eggs sell for more — drag out its corners',
  },
  tailor: {
    name: 'Tailor', building: 'shop', limits: SHOP_LIMITS, cost: shopCost, goods: ['wool'],
    hint: 'Wool sells for more — drag out its corners',
  },
  // `amenity` is what makes a street somewhere people want to live: lamps,
  // benches and trees near a block of flats raise how many it houses.
  lamp: { name: 'Lamp', price: 250, size: [1, 1], tall: true, amenity: true, hint: 'Folk like to live near one' },
  streetLight: { name: 'Street light', price: 220, size: [1, 1], tall: true, amenity: true, hint: 'Folk like to live near one' },
  bench: { name: 'Bench', price: 200, size: [2, 1], amenity: true, hint: 'Folk like to live near one' },
  busShelter: { name: 'Bus shelter', price: 400, size: [2, 1], tall: true, hint: 'Two tiles wide' },
  hydrant: { name: 'Hydrant', price: 120, size: [1, 1], hint: 'For the fire brigade' },
  bin: { name: 'Bin', price: 100, size: [1, 1], hint: 'Keeps the streets tidy' },
  stopSign: { name: 'No entry', price: 150, size: [1, 1], hint: 'A road sign' },
  busSign: { name: 'Bus stop', price: 150, size: [1, 1], hint: 'A bus stop sign' },
  powerPole: { name: 'Power pole', price: 200, size: [1, 1], tall: true, hint: 'Keeps the lights on' },
  topiaryOrange: { name: 'Autumn tree', price: 300, size: [1, 1], tall: true, tree: true, hint: 'A clipped tree' },
  topiaryGreen: { name: 'Green tree', price: 300, size: [1, 1], tall: true, tree: true, hint: 'A clipped tree' },
  pottedOrange: { name: 'Potted tree', price: 150, size: [1, 1], tree: true, hint: 'A little tree in a box' },
  pottedGreen: { name: 'Potted shrub', price: 150, size: [1, 1], tree: true, hint: 'A little shrub in a box' },
  planter: { name: 'Planter', price: 350, size: [3, 1], tree: true, hint: 'Three tiles of shrubs' },
  planterBox: { name: 'Box', price: 100, size: [1, 1], hint: 'An empty planter' },
  picketFence: { name: 'Picket fence', price: 50, size: [1, 1], line: true, hint: 'Joins up as you lay it' },
  chainFence: { name: 'Wire fence', price: 40, size: [1, 1], line: true, hint: 'Joins up as you lay it' },

  // The factory district. Floor first: machines only run standing on it, which
  // is what makes the district a place rather than machines dotted about.
  floor: {
    name: 'Factory floor', ground: CITY_GROUND.FLOOR, price: FLOOR_PRICE,
    hint: 'Machines go on this',
  },
  // One machine per line, coloured as the sheet colours them. See sim/factory.js.
  ...Object.fromEntries(Object.entries(LINES).map(([kind, l]) => [kind, {
    name: l.name, price: MACHINE_PRICE, size: [1, 1], machine: kind,
    hint: `Turns ${l.input.replace('_', ' ')} from your bag into ${l.output}`,
  }])),
  // Fittings: they join up and do nothing, which is the point of them — a
  // factory floor should look like one.
  conveyor: { name: 'Conveyor', price: 60, size: [1, 1], line: true, hint: 'Joins up as you lay it' },
  conveyorTrim: { name: 'Yellow belt', price: 70, size: [1, 1], line: true, hint: 'Joins up as you lay it' },
  pipe: { name: 'Pipe', price: 60, size: [1, 1], line: true, hint: 'Joins up as you lay it' },
  hazard: { name: 'Hazard strip', price: 30, size: [1, 1], line: true, hint: 'Joins up as you lay it' },
  crate: { name: 'Crate', price: 120, size: [1, 1], hint: 'Just for the look of it' },
  boxes: { name: 'Boxes', price: 150, size: [1, 1], tall: true, hint: 'Just for the look of it' },
  forklift: { name: 'Forklift', price: 400, size: [1, 1], hint: 'Just for the look of it' },
};

/**
 * The city menu, grouped the way the farm's is and for the same reason: a flat
 * row of twenty-one things is nine screens of swiping on the phone this is
 * played on. Membership is written out because the order matters, and a test
 * holds every buildable to exactly one group.
 */
export const CITY_GROUPS = [
  // The road and the paving come first in the street they make, rather than in
  // a shelf of their own: a fifth group would not fit the phone's row, measured,
  // and laying a street is the first thing anyone opens this menu to do.
  {
    id: 'street',
    name: 'Street',
    kinds: ['road', 'pavement', 'lamp', 'streetLight', 'bench', 'busShelter', 'hydrant', 'bin',
      'busSign', 'stopSign', 'powerPole'],
  },
  // 'Blocks', not 'Buildings': the four names have to fit 377px with their
  // counts, and 'Buildings' alone cost the Factory shelf its place on the row.
  { id: 'blocks', name: 'Blocks', kinds: ['apartments', 'bakery', 'grocer', 'dairy', 'tailor'] },
  // 'Park', not 'Green' or 'Garden': with Factory on the end the row measured
  // 385px of the 385 it has, and four letters buys back the margin the farm's
  // own row keeps.
  {
    id: 'park',
    name: 'Park',
    kinds: ['topiaryGreen', 'topiaryOrange', 'pottedGreen', 'pottedOrange', 'planter', 'planterBox',
      'picketFence', 'chainFence'],
  },
  // The machines come straight after the floor they need, before the
  // fittings, because they are what anyone opening this shelf is after.
  {
    id: 'factory',
    name: 'Factory',
    kinds: ['floor', 'mill', 'cannery', 'creamery', 'loom',
      'conveyor', 'conveyorTrim', 'pipe', 'hazard', 'crate', 'boxes', 'forklift'],
  },
];

export function cityGroup(id) { return CITY_GROUPS.find((g) => g.id === id) || null; }

/**
 * Everything any place built this way can put down, by kind.
 *
 * The city's own catalogue is CITY_BUILDABLES and stays that: it is what the
 * city's menu is made of. But the sanctuary is the same sort of map with a
 * different menu, and its pieces have to be looked up, priced, placed and
 * loaded by the same code — so its catalogue is added here when its module
 * loads, and cityDef answers for both.
 */
const ALL_BUILDABLES = { ...CITY_BUILDABLES };

export function registerBuildables(defs) {
  for (const [kind, def] of Object.entries(defs)) {
    if (ALL_BUILDABLES[kind] && ALL_BUILDABLES[kind] !== def) throw new Error(`buildable ${kind} is already taken`);
    ALL_BUILDABLES[kind] = def;
  }
}

export function cityDef(kind) { return ALL_BUILDABLES[kind] || null; }

// --- the map ------------------------------------------------------------

/**
 * An empty city: all grass, nothing built, nobody living there, and only the
 * middle lot of the nine owned.
 *
 * The map is laid out as the valley is — see world/land.js — and `owned` is a
 * Set of lot indices just like the farm Grid's, so the shop's Land tab buys a
 * city lot with the same code that buys farmland. Nothing can be put down on a
 * lot that is not owned; the lots around it are drawn dimmed until bought.
 */
export function newCity(w = CITY_W, h = CITY_H) {
  // `rev` counts changes, so anything worked out from the layout can be kept
  // until the layout changes. It is not saved: a loaded city is a new object
  // and starts its caches afresh.
  const { px, py } = middlePlot(w, h);
  return {
    w, h, ground: new Uint8Array(w * h), pieces: [], nextPieceId: 1, population: 0, folk: [], lines: {}, rev: 0,
    owned: new Set([plotIndex(px, py, w)]),
  };
}

/** Is this tile on a lot the player has bought? */
export function ownsTile(city, x, y) {
  return inCity(city, x, y) && (!city.owned || city.owned.has(plotIndexFor(city.w, x, y)));
}

export function cityToJSON(city) {
  return {
    w: city.w,
    h: city.h,
    ground: Array.from(city.ground),
    pieces: city.pieces,
    nextPieceId: city.nextPieceId,
    population: city.population,
    folk: city.folk || [],
    lines: city.lines || {},
    lots: Array.from(city.owned || []),
  };
}

/**
 * The inverse of cityToJSON. A save with no city — every farm from before
 * there was one — gets an empty one, which is the whole of the migration.
 */
export function cityFromJSON(data) {
  if (!data || !(data.w > 0) || !(data.h > 0)) return newCity();
  const city = newCity(data.w, data.h);
  if (Array.isArray(data.ground)) city.ground.set(data.ground.slice(0, data.w * data.h));
  city.pieces = (data.pieces || []).filter((p) => cityDef(p.kind));
  city.nextPieceId = data.nextPieceId || city.pieces.reduce((n, p) => Math.max(n, p.id + 1), 1);
  city.population = data.population || 0;
  city.folk = Array.isArray(data.folk) ? data.folk : [];
  city.lines = data.lines || {};
  // A save without `lots` is older than lots; save migration 12 moved what it
  // had built into the middle one, which newCity already owns.
  if (Array.isArray(data.lots) && data.lots.length) city.owned = new Set(data.lots);
  return city;
}

export function inCity(city, x, y) { return x >= 0 && y >= 0 && x < city.w && y < city.h; }

export function cityGroundAt(city, x, y) {
  return inCity(city, x, y) ? city.ground[y * city.w + x] : CITY_GROUND.GRASS;
}

function setCityGround(city, x, y, g) {
  if (inCity(city, x, y)) city.ground[y * city.w + x] = g;
}

/** The piece whose footprint covers this tile, if any. */
export function pieceAt(city, x, y) {
  // Something standing inside an enclosure is found before the enclosure
  // around it, so a tap on a tree in a paddock is a tap on the tree.
  let pen = null;
  for (const p of city.pieces) {
    if (x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) {
      if (!isPen(p)) return p;
      pen = p;
    }
  }
  return pen;
}

/** An enclosure: the one kind of piece other things may stand inside. */
export function isPen(piece) { return !!cityDef(piece?.kind)?.pen; }

/** Inside an enclosure's fence, not on it. */
export function insidePen(pen, x, y) {
  return x > pen.x && x < pen.x + pen.w - 1 && y > pen.y && y < pen.y + pen.h - 1;
}

/**
 * Is something already here that stops this going down? An enclosure does not
 * stop the things made to go inside one, as long as they keep off its fence.
 */
function blockerAt(city, def, x, y) {
  const other = pieceAt(city, x, y);
  if (!other) return null;
  if (isPen(other) && def.inPen && insidePen(other, x, y)) return null;
  return other;
}

/** "a bench is", "an autumn tree is", "apartments are". */
function inTheWay(noun) {
  if (/s$/.test(noun)) return `${noun} are in the way`;
  return `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun} is in the way`;
}

export function isBuilding(piece) { return !!cityDef(piece?.kind)?.building; }

// --- prices and placement ----------------------------------------------

/** What one of these costs, at this size if it is a building. */
export function cityCost(kind, size) {
  const def = cityDef(kind);
  if (!def) return 0;
  if (def.building) {
    const [w, h] = size || [def.limits.minW, def.limits.minH];
    return def.cost(w, h);
  }
  return def.price;
}

/** What taking one down hands back. Rounded down: churning never pays. */
export function cityRefund(kind, size) {
  return Math.floor(cityCost(kind, size) * CITY_REFUND);
}

/** The footprint size a kind is placed at, for anything that isn't dragged. */
function sizeFor(kind, size) {
  const def = cityDef(kind);
  if (!def) return [1, 1];
  if (def.building) return size || [def.limits.minW, def.limits.minH];
  return def.size || [1, 1];
}

/** Said of a tile on a lot not bought yet. The shop is where it is bought. */
export const NOT_OWNED = "you don't own that lot — buy it from the shop's Land tab";

/**
 * Why this can't go here, in words, or null if it can. Ignores money, which
 * the caller checks separately so the two refusals can be told apart.
 */
export function cityPlacementProblem(state, kind, x, y, size, city = state.city) {
  const def = cityDef(kind);
  if (!def) return 'unknown structure';

  if (def.ground != null) {
    if (!inCity(city, x, y)) return 'off the edge of the city';
    if (!ownsTile(city, x, y)) return NOT_OWNED;
    const standing = blockerAt(city, def, x, y);
    if (standing) return inTheWay(cityDef(standing.kind).name.toLowerCase());
    if (cityGroundAt(city, x, y) === def.ground) return `that is already ${def.name.toLowerCase()}`;
    return null;
  }

  const [w, h] = sizeFor(kind, size);
  // A machine is the factory district's reason for being, and it only runs on
  // factory floor — so it is only put down on factory floor, rather than put
  // down anywhere and left mysteriously idle.
  if (def.machine && inCity(city, x, y) && cityGroundAt(city, x, y) !== CITY_GROUND.FLOOR) {
    return 'machines go on factory floor';
  }
  if (def.building) {
    const { minW, maxW, minH, maxH } = def.limits;
    if (w < minW || h < minH) return `${def.name} must be at least ${minW} by ${minH}`;
    if (w > maxW || h > maxH) return `${def.name} can be at most ${maxW} by ${maxH}`;
  }
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (!inCity(city, tx, ty)) return 'off the edge of the city';
      if (!ownsTile(city, tx, ty)) return NOT_OWNED;
      // Nothing stands in the road: that is where the traffic goes, and a
      // building over a road would cut a street in half without saying so.
      const ground = cityGroundAt(city, tx, ty);
      if (ground === CITY_GROUND.ROAD) return 'that is the road';
      if (ground === CITY_GROUND.WATER) return 'that is water';
      // An enclosure is fenced grass; paving or a path under its fence would
      // leave the fence standing on a street.
      if (def.pen && ground !== CITY_GROUND.GRASS) return 'an enclosure needs open grass';
      const other = def.pen ? pieceAt(city, tx, ty) : blockerAt(city, def, tx, ty);
      if (other) return inTheWay(cityDef(other.kind).name.toLowerCase());
    }
  }
  return null;
}

/**
 * Pays for something and puts it straight into the city. Nothing is queued:
 * the farmer stays on the farm, and money is the whole of the price.
 *
 * @returns {{ok: boolean, reason?: string, spent?: number, piece?: object}}
 */
export function cityBuild(state, kind, x, y, size, city = state.city) {
  const def = cityDef(kind);
  if (!def) return { ok: false, reason: 'unknown structure' };
  const problem = cityPlacementProblem(state, kind, x, y, size, city);
  if (problem) return { ok: false, reason: problem };

  const cost = cityCost(kind, size);
  if (state.money < cost) return { ok: false, reason: `that costs $${cost}` };

  state.money -= cost;
  let piece = null;
  if (def.ground != null) {
    setCityGround(city, x, y, def.ground);
  } else {
    const [w, h] = sizeFor(kind, size);
    piece = { id: city.nextPieceId++, kind, x, y, w, h };
    city.pieces.push(piece);
  }
  city.rev = (city.rev || 0) + 1;
  emitUnlessSuspended('money:changed', { delta: -cost });
  emitUnlessSuspended('city:changed', { x, y });
  return { ok: true, spent: cost, piece };
}

// --- runs ---------------------------------------------------------------
//
// Fences, conveyors, pipes and the hazard strip join up with their neighbours,
// so they are laid in runs. One tap a tile made a fenced square of eight by
// eight thirty exact taps on a phone, and a missed one left a gap that was
// hard to spot. A run is two taps instead: the two ends of a straight line, or
// two opposite corners for a ring round the rectangle between them.

/**
 * The tiles a run covers between two taps: a straight line if they share a
 * row or column, otherwise the outline of the rectangle they are corners of.
 * Each tile once, in order round the ring.
 */
export function runTiles(ax, ay, bx, by) {
  const x0 = Math.min(ax, bx);
  const x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by);
  const y1 = Math.max(ay, by);
  const out = [];
  if (x0 === x1 || y0 === y1) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ x, y });
    return out;
  }
  for (let x = x0; x <= x1; x++) out.push({ x, y: y0 });
  for (let y = y0 + 1; y <= y1; y++) out.push({ x: x1, y });
  for (let x = x1 - 1; x >= x0; x--) out.push({ x, y: y1 });
  for (let y = y1 - 1; y > y0; y--) out.push({ x: x0, y });
  return out;
}

/**
 * What laying a run here would do: which tiles get a new piece, which already
 * have one of the same kind (left alone and not charged for), and which are
 * skipped because something else is in the way, with the first reason why.
 * A run goes round what it cannot go through rather than refusing outright —
 * a fence round a paddock with a tree on its line still goes up — and the
 * caller says how many were skipped and why.
 *
 * @returns {{lay: Array<{x:number,y:number}>, skipped: Array<{x:number,y:number}>,
 *   already: number, problem: string|null, cost: number}}
 */
export function cityRunPlan(state, kind, tiles, city = state.city) {
  const def = cityDef(kind);
  const lay = [];
  const skipped = [];
  let already = 0;
  let problem = null;
  for (const t of tiles) {
    const there = pieceAt(city, t.x, t.y);
    if (there && there.kind === kind) { already++; continue; }
    const why = cityPlacementProblem(state, kind, t.x, t.y, undefined, city);
    if (why) {
      skipped.push(t);
      problem = problem || why;
      continue;
    }
    lay.push(t);
  }
  return { lay, skipped, already, problem, cost: lay.length * (def?.price || 0) };
}

/**
 * Lays a whole run, paid for at once, or none of it if it cannot be afforded.
 *
 * @returns {{ok: boolean, reason?: string, spent?: number, count?: number}}
 */
export function cityBuildRun(state, kind, tiles, city = state.city) {
  const def = cityDef(kind);
  if (!def?.line) return { ok: false, reason: 'that is not laid in runs' };
  const plan = cityRunPlan(state, kind, tiles, city);
  if (plan.lay.length === 0) {
    return { ok: false, reason: plan.problem || `that is all ${def.name.toLowerCase()} already` };
  }
  if (state.money < plan.cost) return { ok: false, reason: `that costs $${plan.cost}` };
  let spent = 0;
  for (const t of plan.lay) {
    const res = cityBuild(state, kind, t.x, t.y, undefined, city);
    if (res.ok) spent += res.spent;
  }
  return { ok: true, spent, count: plan.lay.length };
}

/** Which buildable lays each kind of ground, for taking it up again. */
const GROUND_KIND = {
  [CITY_GROUND.ROAD]: 'road',
  [CITY_GROUND.PAVEMENT]: 'pavement',
  [CITY_GROUND.FLOOR]: 'floor',
  [CITY_GROUND.TRAIL]: 'trail',
  [CITY_GROUND.WATER]: 'pool',
};

/**
 * What the player would be taking down by demolishing this tile: the piece
 * standing on it, or failing that the road or pavement under it.
 *
 * @returns {{kind: string, piece: object|null, refund: number}|null}
 */
export function cityStructureAt(city, x, y) {
  const piece = pieceAt(city, x, y);
  if (piece) return { kind: piece.kind, piece, refund: cityRefund(piece.kind, [piece.w, piece.h]) };
  const g = cityGroundAt(city, x, y);
  if (g === CITY_GROUND.GRASS) return null;
  const kind = GROUND_KIND[g] || 'pavement';
  return { kind, piece: null, refund: cityRefund(kind) };
}

/**
 * Takes down whatever is on this tile and hands back part of what it cost.
 * A building goes in one piece, whichever of its tiles was tapped.
 *
 * @returns {{ok: boolean, kind?: string, refund?: number}}
 */
export function cityDemolish(state, x, y, city = state.city) {
  const found = cityStructureAt(city, x, y);
  if (!found) return { ok: false };
  if (found.piece) {
    city.pieces = city.pieces.filter((p) => p !== found.piece);
  } else {
    setCityGround(city, x, y, CITY_GROUND.GRASS);
  }
  city.rev = (city.rev || 0) + 1;
  if (found.refund > 0) {
    state.money += found.refund;
    emitUnlessSuspended('money:changed', { delta: found.refund });
  }
  emitUnlessSuspended('city:changed', { x, y });
  return { ok: true, kind: found.kind, refund: found.refund };
}

/** How much has been sunk into the city, at today's prices. */
export function cityValue(city) {
  let total = 0;
  for (const g of city.ground) {
    if (g === CITY_GROUND.ROAD) total += ROAD_PRICE;
    else if (g === CITY_GROUND.PAVEMENT) total += PAVEMENT_PRICE;
    else if (g === CITY_GROUND.FLOOR) total += FLOOR_PRICE;
  }
  for (const p of city.pieces) total += cityCost(p.kind, [p.w, p.h]);
  return total;
}
