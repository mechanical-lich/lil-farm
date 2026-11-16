// Life in the city: who lives there, who you can see about, and what it does
// to the farm's market.
//
// Same rules as everything the tick calls: state.rng only, no clock, and cheap
// under catch-up. The real work — capacity, drift, the market's view of the
// city — happens on one tick in CITY_INTERVAL, as the market's does. What
// happens every tick is only the townsfolk deciding whether to take a step,
// which is a handful of comparisons, and nothing at all in an empty city.
//
// HOW THE CITY REACHES THE MARKET
//
// The market is deliberately scale-free: it prices the *mix* a farm sells, not
// the volume, so that doubling a farm changes nothing and changing what it
// grows changes everything. The city must not undo that by simply raising
// prices. So it acts on the market in three ways that leave the mix in charge:
//
//   - Shops change what the town *wants*. A bakery raises the share of wheat
//     the town asks for, so wheat pays better and clears faster — and a farm
//     that sells nothing but wheat still gluts it, because the glut is measured
//     against the normal share.
//   - People deepen it. The town's own stock grows with its population, so a
//     farm's sales are diluted further and prices sit calmer. At the top end,
//     where a farm sells far more than the town holds, depth stops mattering
//     and the mix decides, exactly as before.
//   - A full city pays a little more for everything, capped. Small enough that
//     a monoculture in a full city is still paid well under a varied farm in an
//     empty one.
//
// The city writes what it is doing into state.market.city once a minute, and
// the market reads it from there; an empty city writes nothing, so a farm
// without one trades on exactly the market it always had.

import {
  CITY_GROUND, cityDef, cityGroundAt, inCity, isBuilding,
} from './city.js';
import { LINE_MACHINE_CAP, runLines } from './factory.js';

/** Real work happens on one tick in this many. */
export const CITY_INTERVAL = 60;

/** People a tile of apartments houses, before amenities. A 3x3 houses 36. */
export const RESIDENTS_PER_TILE = 4;

/** Each lamp, bench or tree near a block raises what it houses by this much... */
export const AMENITY_BONUS = 0.05;
/** ...up to this many of them. Six is +30%. */
export const AMENITY_CAP = 6;
/** "Near" is within this many tiles of the building's edge. */
export const AMENITY_RADIUS = 3;

/**
 * How slowly people arrive and leave: the gap to capacity closes by about two
 * thirds over this many ticks. Six hours — a new block fills up over a day,
 * not a minute, so it is something you come back to see.
 */
export const POPULATION_TIME = 6 * 60 * 60;

/** The population at which the city's effect on the market is at its fullest. */
export const CITY_FULL_POPULATION = 1000;

/** How much deeper the market is with a full city: 0.5 is half as deep again. */
export const CITY_DEPTH_GAIN = 0.5;

/** The price premium a full city pays on everything traded. Capped here. */
export const CITY_PREMIUM_MAX = 0.15;

/** How much more of its goods the town wants for each shop that sells them... */
export const SHOP_APPETITE = 0.15;
/** ...counting at most this many shops of a trade. Three is +45%. */
export const SHOP_APPETITE_CAP = 3;

/** One townsperson in view for this many residents, up to FOLK_MAX. */
export const PEOPLE_PER_FOLK = 25;
export const FOLK_MAX = 24;
/** One vehicle parked about for this many residents, up to VEHICLE_MAX. */
export const PEOPLE_PER_VEHICLE = 100;
export const VEHICLE_MAX = 6;
/** Townsfolk stand about this long, give or take, between steps. */
export const FOLK_REST_MIN = 30;
export const FOLK_REST_SPREAD = 90;
/**
 * Vehicles wait far less: asked for after seeing a full city, where a van that
 * moved a tile every minute or two read as parked. A few seconds between tiles
 * is a van pottering down the street.
 */
export const CAR_REST_MIN = 2;
export const CAR_REST_SPREAD = 5;

/** Advances the city. Called every tick; does real work rarely. */
export function updateCity(state) {
  const city = state.city;
  if (!city) return;

  if (state.tickCount % CITY_INTERVAL === 0) {
    const cap = housingCapacity(city);
    const gap = cap - city.population;
    // Snapped once it is within a person, so it settles rather than creeping
    // towards a number it never reaches.
    city.population = Math.abs(gap) < 0.5 ? cap : city.population + gap * (CITY_INTERVAL / POPULATION_TIME);
    applyToMarket(state);
    settleFolk(state);
    // The factory lines, a minute's work at a time. Machines only count on
    // factory floor, which the layout facts already know.
    const machines = facts(city).machines;
    runLines(state, (line) => machines[line] || 0);
  }
  stepFolk(state);
}

// --- who lives here -----------------------------------------------------

/**
 * Derived facts about a city that only change when something is built or
 * taken down, worked out once per change and kept. The population update runs
 * every minute of a week-long catch-up; scanning forty by forty tiles each
 * time would be most of its cost, for an answer that has not changed.
 */
const derived = new WeakMap();

function facts(city) {
  const rev = city.rev || 0;
  const cached = derived.get(city);
  if (cached && cached.rev === rev) return cached;

  const occupied = new Set();
  for (const p of city.pieces) {
    for (let dy = 0; dy < p.h; dy++) for (let dx = 0; dx < p.w; dx++) occupied.add((p.y + dy) * city.w + p.x + dx);
  }

  let capacity = 0;
  const shops = {};
  const machines = {};
  for (const p of city.pieces) {
    const line = cityDef(p.kind)?.machine;
    if (line && cityGroundAt(city, p.x, p.y) === CITY_GROUND.FLOOR) {
      machines[line] = Math.min(LINE_MACHINE_CAP, (machines[line] || 0) + 1);
    }
  }
  for (const p of city.pieces) {
    if (!isBuilding(p) || !hasAccess(city, p)) continue;
    const def = cityDef(p.kind);
    if (p.kind === 'apartments') capacity += housed(city, p);
    if (def.goods) shops[p.kind] = (shops[p.kind] || 0) + 1;
  }

  // Where townsfolk may stand: pavement if there is any, which is where people
  // in a town are; otherwise the open grass beside the buildings.
  const pavement = [];
  const verge = [];
  const lanes = [];
  for (let y = 0; y < city.h; y++) {
    for (let x = 0; x < city.w; x++) {
      const i = y * city.w + x;
      if (occupied.has(i)) continue;
      const g = city.ground[i];
      if (g === CITY_GROUND.PAVEMENT) pavement.push(i);
      else if (g === CITY_GROUND.ROAD) {
        // A vehicle is two tiles wide, so it needs road on its right too.
        if (x + 1 < city.w && city.ground[i + 1] === CITY_GROUND.ROAD && !occupied.has(i + 1)) lanes.push(i);
      } else if (g === CITY_GROUND.GRASS && nearBuilding(city, x, y)) verge.push(i);
    }
  }

  const standing = pavement.length ? pavement : verge;
  const out = {
    rev, capacity: Math.round(capacity), shops, machines, occupied,
    standing, lanes, standingSet: new Set(standing), laneSet: new Set(lanes),
  };
  derived.set(city, out);
  return out;
}

/** How many people the city has room for: apartments with a way to the road. */
export function housingCapacity(city) { return facts(city).capacity; }

/** How many machines each factory line has working, capped. */
export function workingMachines(city) { return facts(city).machines; }

/** How many shops of each trade are open, i.e. reachable from a road. */
export function openShops(city) { return facts(city).shops; }

/**
 * Can people get to it? A building counts once a road touches it, or a strip
 * of pavement does that itself touches a road — a block set back behind the
 * paving is the ordinary arrangement, and refusing it would make pavement a
 * trap.
 */
export function hasAccess(city, p) {
  const road = (x, y) => cityGroundAt(city, x, y) === CITY_GROUND.ROAD;
  const reaches = (x, y) => {
    if (!inCity(city, x, y)) return false;
    if (road(x, y)) return true;
    return cityGroundAt(city, x, y) === CITY_GROUND.PAVEMENT
      && (road(x - 1, y) || road(x + 1, y) || road(x, y - 1) || road(x, y + 1));
  };
  for (let x = p.x; x < p.x + p.w; x++) {
    if (reaches(x, p.y - 1) || reaches(x, p.y + p.h)) return true;
  }
  for (let y = p.y; y < p.y + p.h; y++) {
    if (reaches(p.x - 1, y) || reaches(p.x + p.w, y)) return true;
  }
  return false;
}

/** How many a block of flats houses, its amenities included. */
export function housed(city, p) {
  return p.w * p.h * RESIDENTS_PER_TILE * (1 + AMENITY_BONUS * Math.min(AMENITY_CAP, amenitiesNear(city, p)));
}

/** Lamps, benches and trees within AMENITY_RADIUS of a building's edge. */
export function amenitiesNear(city, p) {
  let n = 0;
  for (const q of city.pieces) {
    const def = cityDef(q.kind);
    if (!def || !(def.amenity || def.tree)) continue;
    const gapX = Math.max(p.x - (q.x + q.w - 1), q.x - (p.x + p.w - 1), 0);
    const gapY = Math.max(p.y - (q.y + q.h - 1), q.y - (p.y + p.h - 1), 0);
    if (Math.max(gapX, gapY) <= AMENITY_RADIUS) n++;
  }
  return n;
}

function nearBuilding(city, x, y) {
  return city.pieces.some((p) => isBuilding(p)
    && x >= p.x - 1 && x <= p.x + p.w && y >= p.y - 1 && y <= p.y + p.h);
}

// --- what it does to the market -----------------------------------------

/**
 * What the city does to the market right now, from its population and shops.
 * Null for a city with nobody in it and nothing open, which the market reads
 * as "no city at all" — that is what keeps a beginner's market unchanged.
 *
 * @returns {{depth: number, premium: number, appetite: Record<string, number>,
 *   population: number}|null}
 */
export function cityMarketEffect(city) {
  const pop = Math.round(city.population || 0);
  const shops = openShops(city);
  if (pop <= 0 && Object.keys(shops).length === 0) return null;

  const fill = Math.min(1, pop / CITY_FULL_POPULATION);
  const appetite = {};
  for (const [kind, count] of Object.entries(shops)) {
    const boost = 1 + SHOP_APPETITE * Math.min(SHOP_APPETITE_CAP, count);
    for (const id of cityDef(kind).goods) appetite[id] = Math.max(appetite[id] || 1, boost);
  }
  return {
    population: pop,
    depth: 1 + CITY_DEPTH_GAIN * fill,
    premium: 1 + CITY_PREMIUM_MAX * fill,
    appetite,
  };
}

/**
 * What the city is doing to the market, in words the market panel can show.
 * Null when it is doing nothing.
 *
 * @returns {{population: number, premium: number, depth: number,
 *   shops: Array<{kind: string, name: string, count: number, goods: string[]}>}|null}
 */
export function cityMarketSummary(state) {
  const effect = state.market?.city;
  if (!effect) return null;
  const shops = Object.entries(openShops(state.city)).map(([kind, count]) => ({
    kind, name: cityDef(kind).name, count, goods: cityDef(kind).goods,
  }));
  return {
    population: effect.population,
    premium: Math.round((effect.premium - 1) * 100),
    depth: effect.depth,
    shops,
  };
}

/**
 * The goods the city's shops have tipped the town towards: those it wants more
 * of than the average good, once every shop's appetite is counted. Appetites
 * are shares, so a boost every good gets is no boost at all.
 */
export function cityFavours(market) {
  const appetite = market?.city?.appetite;
  if (!appetite) return new Set();
  const ids = Object.keys(market.demand);
  const weight = ids.reduce((n, id) => n + market.demand[id], 0) || 1;
  const mean = ids.reduce((n, id) => n + market.demand[id] * (appetite[id] || 1), 0) / weight;
  return new Set(ids.filter((id) => (appetite[id] || 1) > mean * 1.01));
}

function applyToMarket(state) {
  if (!state.market) return;
  const effect = cityMarketEffect(state.city);
  if (effect) state.market.city = effect;
  else delete state.market.city;
}

// --- who you can see about ------------------------------------------------
//
// Townsfolk and vehicles in proportion to the population. They stand about
// and now and then take one step, the way the farm's animals do — the same
// one-tile move the renderer already interpolates, and nothing else. There is
// no bobbing, sliding or walking cycle: decorative motion was built once and
// turned down as too much movement.

/** How many townsfolk and vehicles a population of this size shows. */
export function folkWanted(population) {
  const pop = Math.round(population || 0);
  return {
    folk: Math.min(FOLK_MAX, Math.ceil(pop / PEOPLE_PER_FOLK)),
    vehicles: Math.min(VEHICLE_MAX, Math.floor(pop / PEOPLE_PER_VEHICLE)),
  };
}

/**
 * Brings the crowd into line with the population and the streets: arrivals
 * appear somewhere they may stand, departures leave from the end of the list,
 * and anyone whose spot has been built over moves somewhere that is not.
 */
function settleFolk(state) {
  const city = state.city;
  city.folk = city.folk || [];
  const f = facts(city);
  const want = folkWanted(city.population);
  const where = (kind) => (kind === 'car' ? f.lanes : f.standing);

  for (const kind of ['folk', 'car']) {
    const spots = where(kind);
    const wanted = spots.length ? (kind === 'car' ? want.vehicles : want.folk) : 0;
    const mine = city.folk.filter((m) => m.kind === kind);
    for (let i = mine.length; i < wanted; i++) {
      const at = spots[Math.floor(state.rng.next() * spots.length)];
      city.folk.push({
        kind,
        sprite: Math.floor(state.rng.next() * (kind === 'car' ? 2 : 3)),
        x: at % city.w, y: Math.floor(at / city.w), px: at % city.w, py: Math.floor(at / city.w),
        flip: state.rng.next() < 0.5,
        next: state.tickCount + FOLK_REST_MIN + Math.floor(state.rng.next() * FOLK_REST_SPREAD),
      });
    }
    let extra = mine.length - wanted;
    for (let i = city.folk.length - 1; i >= 0 && extra > 0; i--) {
      if (city.folk[i].kind === kind) { city.folk.splice(i, 1); extra--; }
    }
  }

  // Built over, or the road dug up from under a parked car.
  for (const m of city.folk) {
    if (canStand(city, f, m.kind, m.x, m.y)) continue;
    const spots = where(m.kind);
    if (!spots.length) continue;
    const at = spots[Math.floor(state.rng.next() * spots.length)];
    m.x = m.px = at % city.w;
    m.y = m.py = Math.floor(at / city.w);
  }
  city.folk = city.folk.filter((m) => canStand(city, f, m.kind, m.x, m.y));
}

function canStand(city, f, kind, x, y) {
  if (!inCity(city, x, y)) return false;
  const i = y * city.w + x;
  if (kind === 'car') return f.laneSet.has(i);
  // Pavement if the city has any; otherwise grass by a building. Never the
  // road, never under anything — the list already leaves those out.
  return f.standingSet.has(i);
}

/**
 * One tick of standing about. Anyone whose rest is over takes a single step to
 * a neighbouring spot they may stand on, or stays put if there is none, and
 * rests again. A vehicle keeps to its lane and rests far more briefly.
 */
function stepFolk(state) {
  const folk = state.city.folk;
  if (!folk || folk.length === 0) return;
  const city = state.city;
  let f = null;
  for (const m of folk) {
    // Last tick's step has been drawn; from here it is standing still.
    if (m.px !== m.x || m.py !== m.y) { m.px = m.x; m.py = m.y; }
    if (state.tickCount < m.next) continue;

    f = f || facts(city);
    const car = m.kind === 'car';
    const free = (x, y) => canStand(city, f, m.kind, x, y) && !folk.some((o) => o !== m && o.x === x && o.y === y);
    let dx;
    let dy = 0;
    if (car) {
      // A vehicle carries on the way it is facing and turns round only at the
      // end of the street or behind another one. Moving this often, a random
      // left-or-right each time would be a van shuffling on the spot.
      dx = m.flip ? -1 : 1;
      if (!free(m.x + dx, m.y)) dx = -dx;
    } else {
      const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      [dx, dy] = steps[Math.floor(state.rng.next() * steps.length)];
    }
    if (free(m.x + dx, m.y + dy)) {
      m.x += dx;
      m.y += dy;
      if (dx) m.flip = dx < 0;
    }
    const [restMin, restSpread] = car ? [CAR_REST_MIN, CAR_REST_SPREAD] : [FOLK_REST_MIN, FOLK_REST_SPREAD];
    m.next = state.tickCount + restMin + Math.floor(state.rng.next() * restSpread);
  }
}

/** Is anyone in the city partway between two tiles? For the renderer. */
export function cityMoving(state) {
  return (state.city?.folk || []).some((m) => m.px !== m.x || m.py !== m.y);
}
