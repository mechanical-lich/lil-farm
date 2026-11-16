// The sanctuary: a third map, where the animals she has won over can live.
//
// A farm that befriends everything ends up with hundreds of animals on it, and
// every one of them wants feeding and watering and is walked through the
// simulation every tick. The sanctuary is somewhere for them to go: a place
// built with money, the way the city is, where an animal wants nothing, costs
// nothing to keep, and can be visited — and fetched back whenever she likes.
//
// It is the same kind of map as the city (see sim/city.js): a ground layer and
// a list of pieces, bought outright and placed at once. What is different is
// the menu, which mixes the farm's trees and water with the town's fences and
// houses and the city's benches and lamps, and the one new idea: an enclosure
// is a piece other pieces can stand inside.
//
// WHO CAN GO
//
// Animals she found or was given: anything befriended from the wild, and the
// birthday mythicals. Not bought livestock — a cow is there to give milk, and
// "does it still give milk in the sanctuary?" has no good answer.
//
// WHAT AN ANIMAL IS WHILE IT IS HERE
//
// A resident is the animal's own record with a place in an enclosure. It
// keeps its name, its affection and its colour; it loses hunger and thirst,
// which are put back full when it comes home. It leaves state.animals
// entirely, which is the point: nothing on the farm has to think about it.
//
// Hard rules, as everywhere in sim/: no DOM, no Math.random(), no Date.now().

import { SANCTUARY_W, SANCTUARY_H } from '../config.js';
import { emitUnlessSuspended } from '../engine/events.js';
import {
  CITY_GROUND, newCity, cityToJSON, cityFromJSON, cityDef, registerBuildables,
  cityDemolish, cityStructureAt, isPen, insidePen,
} from './city.js';
import { animalDef, makeAnimal, freeSpotNear, calledAs } from './animals.js';
import { CITY_FULL_POPULATION } from './citylife.js';
import { TICKS_PER_DAY } from './market.js';

// --- prices -------------------------------------------------------------
//
// Guesses, set against the city's: an enclosure is the sanctuary's block of
// flats and is priced like a small one.

export const PEN_BASE = 1500;
export const PEN_PER_TILE = 150;
export const PEN_LIMITS = { minW: 4, maxW: 14, minH: 4, maxH: 12 };
export function penCost(w, h) { return PEN_BASE + PEN_PER_TILE * w * h; }

export const CENTRE_BASE = 4000;
export const CENTRE_PER_TILE = 300;
export const CENTRE_LIMITS = { minW: 3, maxW: 6, minH: 2, maxH: 3 };
export function centreCost(w, h) { return CENTRE_BASE + CENTRE_PER_TILE * w * h; }

/**
 * What only the sanctuary's menu puts down. `inPen` pieces may stand inside an
 * enclosure, and there they are comforts: each one makes room for more.
 * `rise` is how many rows of art stand above the footprint, as `tall` is one.
 */
export const SANCTUARY_BUILDABLES = {
  paddock: {
    name: 'Enclosure', building: 'paddock', pen: true, limits: PEN_LIMITS, cost: penCost,
    hint: 'Fenced grass for animals — drag out its corners',
  },
  visitorCentre: {
    name: 'Visitor centre', building: 'lodge', limits: CENTRE_LIMITS, cost: centreCost, rise: 2,
    hint: 'Visitors from the city leave donations here — drag out its corners',
  },
  trail: {
    name: 'Trail', ground: CITY_GROUND.TRAIL, price: 15,
    hint: 'Trodden earth, for visitors to walk on',
  },
  pool: {
    name: 'Pool', ground: CITY_GROUND.WATER, price: 60, inPen: true,
    hint: 'Still water — animals like one in their enclosure',
  },
  oak: { name: 'Tree', price: 250, size: [1, 1], tall: true, inPen: true, tree: true, hint: 'Shade, in or out of an enclosure' },
  pine: { name: 'Pine', price: 250, size: [1, 1], tall: true, inPen: true, tree: true, hint: 'Shade, in or out of an enclosure' },
  maple: { name: 'Autumn tree', price: 250, size: [1, 1], tall: true, inPen: true, tree: true, hint: 'Shade, in or out of an enclosure' },
  shrub: { name: 'Bush', price: 120, size: [1, 1], inPen: true, hint: 'Somewhere to hide' },
  boulder: { name: 'Rocks', price: 120, size: [1, 1], inPen: true, hint: 'Something to climb on' },
  hayRack: { name: 'Hay', price: 150, size: [1, 1], inPen: true, hint: 'A bale to pick at' },
  drinker: { name: 'Trough', price: 200, size: [2, 1], inPen: true, hint: 'Two tiles wide' },
  signpost: { name: 'Signpost', price: 100, size: [1, 1], hint: 'Says who lives where' },
  wishingWell: { name: 'Well', price: 400, size: [1, 1], tall: true, hint: 'Visitors throw coins in' },
};

registerBuildables(SANCTUARY_BUILDABLES);

/**
 * The sanctuary's menu. Four groups, as the city has and for the same reason.
 * The Visit shelf borrows the city's own street furniture by name — a bench
 * here is the same bench, at the same price.
 */
export const SANCTUARY_GROUPS = [
  { id: 'homes', name: 'Homes', kinds: ['paddock', 'visitorCentre'] },
  { id: 'comforts', name: 'Comforts', kinds: ['pool', 'oak', 'pine', 'maple', 'shrub', 'boulder', 'hayRack', 'drinker'] },
  { id: 'paths', name: 'Paths', kinds: ['trail', 'pavement', 'picketFence', 'signpost'] },
  { id: 'visit', name: 'Visit', kinds: ['bench', 'lamp', 'bin', 'planter', 'pottedGreen', 'wishingWell'] },
];

export function sanctuaryGroup(id) { return SANCTUARY_GROUPS.find((g) => g.id === id) || null; }

// --- the map ------------------------------------------------------------

/** An empty sanctuary: all grass, nothing built, nobody living there. */
export function newSanctuary(w = SANCTUARY_W, h = SANCTUARY_H) {
  return { ...newCity(w, h), residents: [], donations: 0 };
}

export function sanctuaryToJSON(place) {
  const { population, lines, ...map } = cityToJSON(place);
  return { ...map, residents: place.residents || [], donations: place.donations || 0 };
}

export function sanctuaryFromJSON(data) {
  if (!data || !(data.w > 0) || !(data.h > 0)) return newSanctuary();
  const place = { ...cityFromJSON(data), residents: [], donations: Math.max(0, data.donations || 0) };
  // A resident needs an enclosure that still exists and a kind the game still
  // knows. One that has lost either cannot be drawn or fetched; rather than
  // lose the animal, it is handed back to the farm by the caller — see
  // reconcileSanctuary.
  place.residents = Array.isArray(data.residents) ? data.residents.filter((r) => r && r.type) : [];
  return place;
}

// --- enclosures ---------------------------------------------------------

/** Floor an animal needs to itself. */
export const TILES_PER_ANIMAL = 4;
/** Each comfort inside an enclosure makes this much more room, up to a cap. */
export const COMFORT_BONUS = 0.1;
export const COMFORT_CAP = 5;

export function pens(place) { return place.pieces.filter(isPen); }

/**
 * Layout facts, worked out once per change to the map and kept — the same
 * bargain sim/citylife.js makes, since residents ask where they may stand
 * every time one of them moves.
 */
const derived = new WeakMap();

function facts(place) {
  const rev = place.rev || 0;
  const cached = derived.get(place);
  if (cached && cached.rev === rev) return cached;

  const blocked = new Set();
  for (const p of place.pieces) {
    if (isPen(p)) continue;
    for (let dy = 0; dy < p.h; dy++) for (let dx = 0; dx < p.w; dx++) blocked.add((p.y + dy) * place.w + p.x + dx);
  }

  const byPen = new Map();
  for (const pen of pens(place)) {
    const spots = [];
    let water = false;
    for (let y = pen.y + 1; y < pen.y + pen.h - 1; y++) {
      for (let x = pen.x + 1; x < pen.x + pen.w - 1; x++) {
        const i = y * place.w + x;
        if (place.ground[i] === CITY_GROUND.WATER) { water = true; continue; }
        if (!blocked.has(i)) spots.push(i);
      }
    }
    let comforts = water ? 1 : 0;
    for (const q of place.pieces) {
      if (!isPen(q) && cityDef(q.kind)?.inPen && insidePen(pen, q.x, q.y)) comforts++;
    }
    const floor = (pen.w - 2) * (pen.h - 2);
    const room = Math.floor((floor / TILES_PER_ANIMAL) * (1 + COMFORT_BONUS * Math.min(COMFORT_CAP, comforts)));
    // Never more animals than there are tiles to stand them on.
    byPen.set(pen.id, { spots, spotSet: new Set(spots), comforts, capacity: Math.max(0, Math.min(room, spots.length)) });
  }

  // Where visitors may stand: any trail or paving with nothing on it.
  const paths = [];
  for (let i = 0; i < place.ground.length; i++) {
    const g = place.ground[i];
    if ((g === CITY_GROUND.TRAIL || g === CITY_GROUND.PAVEMENT) && !blocked.has(i)) paths.push(i);
  }

  const out = {
    rev, byPen, paths, pathSet: new Set(paths),
    centres: place.pieces.filter((p) => p.kind === 'visitorCentre').length,
  };
  derived.set(place, out);
  return out;
}

/** How many animals an enclosure has room for, its comforts included. */
export function penCapacity(place, pen) { return facts(place).byPen.get(pen.id)?.capacity || 0; }

/** How many comforts an enclosure has inside it. */
export function penComforts(place, pen) { return facts(place).byPen.get(pen.id)?.comforts || 0; }

export function residentsOf(place, pen) { return (place.residents || []).filter((r) => r.pen === pen.id); }

/** Room for everybody, across every enclosure. */
export function sanctuaryCapacity(place) {
  return pens(place).reduce((n, pen) => n + penCapacity(place, pen), 0);
}

export function residentAt(place, x, y) {
  return (place.residents || []).find((r) => r.x === x && r.y === y) || null;
}

/** How many different kinds of animal live here. What visitors come for. */
export function kindsKept(place) {
  return new Set((place.residents || []).map((r) => r.type)).size;
}

// --- there and back -----------------------------------------------------

/** Is this the sort of animal the sanctuary takes? See the note at the top. */
export function isSanctuaryKind(type) {
  const def = animalDef(type);
  return !!def && !!(def.wild || def.gift);
}

/** The enclosure with the most room to spare, or null if none has any. */
function roomiestPen(place) {
  let best = null;
  let most = 0;
  for (const pen of pens(place)) {
    const free = penCapacity(place, pen) - residentsOf(place, pen).length;
    if (free > most) { most = free; best = pen; }
  }
  return best;
}

/** Why this animal can't go, in words, or ok. Nothing is changed. */
export function canSendToSanctuary(state, animal) {
  if (!animal) return { ok: false, reason: 'no such animal' };
  if (animal.wild) return { ok: false, reason: 'it is still wild' };
  if (!isSanctuaryKind(animal.type)) {
    return { ok: false, reason: 'the sanctuary is for animals you befriended or were given' };
  }
  const place = state.sanctuary;
  if (!place || pens(place).length === 0) return { ok: false, reason: 'build an enclosure in the sanctuary first' };
  if (!roomiestPen(place)) return { ok: false, reason: 'the sanctuary is full — it needs another enclosure' };
  return { ok: true };
}

function freeSpotIn(state, place, pen) {
  const taken = new Set(place.residents.map((r) => r.y * place.w + r.x));
  const open = facts(place).byPen.get(pen.id).spots.filter((i) => !taken.has(i));
  if (open.length === 0) return null;
  return open[Math.floor(state.rng.next() * open.length)];
}

// --- moving one by hand -------------------------------------------------
//
// With the Move tool an animal can be picked up and put down somewhere else:
// another spot in its own enclosure, or a different enclosure with room. It is
// the farm's move tool brought over, and like it, it is instant and free.

/**
 * Why this animal can't be put down here, in words, or null if it can.
 * Nothing is changed.
 */
export function residentMoveProblem(state, resident, x, y) {
  const place = state.sanctuary;
  if (!place || !resident || !place.residents.includes(resident)) return 'no such animal';
  if (resident.x === x && resident.y === y) return null;
  const pen = pens(place).find((p) => insidePen(p, x, y));
  if (!pen) return 'animals stay inside an enclosure';
  const fact = facts(place).byPen.get(pen.id);
  if (!fact.spotSet.has(y * place.w + x)) {
    return place.ground[y * place.w + x] === CITY_GROUND.WATER ? 'that is water' : 'something is standing there';
  }
  if (place.residents.some((r) => r !== resident && r.x === x && r.y === y)) return 'another animal is there';
  if (pen.id !== resident.pen && residentsOf(place, pen).length >= fact.capacity) return 'that enclosure is full';
  return null;
}

/**
 * Puts a resident down at this tile, moving it to that enclosure if it is a
 * different one. It arrives standing still, rather than sliding there.
 *
 * @returns {{ok: boolean, reason?: string, moved?: boolean}}
 */
export function moveResident(state, resident, x, y) {
  const problem = residentMoveProblem(state, resident, x, y);
  if (problem) return { ok: false, reason: problem };
  const pen = pens(state.sanctuary).find((p) => insidePen(p, x, y));
  const moved = pen.id !== resident.pen;
  resident.pen = pen.id;
  resident.x = resident.px = x;
  resident.y = resident.py = y;
  emitUnlessSuspended('city:changed', {});
  return { ok: true, moved };
}

/** How long a resident stands before it thinks about moving, in ticks. */
export const RESIDENT_REST_MIN = 20;
export const RESIDENT_REST_SPREAD = 60;

/**
 * Moves an animal off the farm and into the roomiest enclosure.
 *
 * @returns {{ok: boolean, reason?: string, resident?: object}}
 */
export function sendToSanctuary(state, animal) {
  const can = canSendToSanctuary(state, animal);
  if (!can.ok) return can;
  const place = state.sanctuary;
  const pen = roomiestPen(place);
  const at = freeSpotIn(state, place, pen);
  if (at == null) return { ok: false, reason: 'the sanctuary is full — it needs another enclosure' };

  const i = state.animals.indexOf(animal);
  if (i >= 0) state.animals.splice(i, 1);

  const x = at % place.w;
  const y = Math.floor(at / place.w);
  // Who it is, and nothing about how it was getting on: hunger, thirst, where
  // it was walking to and what it was running from all stay behind.
  const resident = {
    id: animal.id, type: animal.type, variant: animal.variant,
    affection: animal.affection || 0, pettedAt: animal.pettedAt ?? null,
    facing: animal.facing || 'right',
    pen: pen.id, x, y, px: x, py: y,
    next: state.tickCount + RESIDENT_REST_MIN + Math.floor(state.rng.next() * RESIDENT_REST_SPREAD),
  };
  if (animal.name) resident.name = animal.name;
  if (animal.trust != null) resident.trust = animal.trust;
  place.residents.push(resident);

  emitUnlessSuspended('sanctuary:arrived', { id: resident.id, type: resident.type, name: resident.name || null });
  emitUnlessSuspended('city:changed', {});
  return { ok: true, resident };
}

/**
 * Brings a resident home, to the nearest free spot by the farmer. It arrives
 * fed and watered, as a bought animal does, so coming home is never a chore.
 *
 * @returns {{ok: boolean, reason?: string, animal?: object}}
 */
export function bringHome(state, resident) {
  const place = state.sanctuary;
  const i = place.residents.indexOf(resident);
  if (i < 0) return { ok: false, reason: 'it is not in the sanctuary' };
  const spot = freeSpotNear(state, state.farmer.x, state.farmer.y, resident.type, 12);
  if (!spot) return { ok: false, reason: 'there is no room beside the farmer for it' };

  place.residents.splice(i, 1);
  const animal = makeAnimal(state, resident.type, spot.x, spot.y, resident.variant);
  animal.affection = resident.affection || 0;
  animal.pettedAt = resident.pettedAt ?? null;
  animal.facing = resident.facing || 'right';
  if (resident.name) animal.name = resident.name;
  if (resident.trust != null) animal.trust = resident.trust;

  emitUnlessSuspended('sanctuary:left', { id: animal.id, type: animal.type, name: animal.name || null });
  emitUnlessSuspended('city:changed', {});
  return { ok: true, animal };
}

/**
 * Takes something down in the sanctuary. The same as the city's, except that
 * an enclosure with animals in it stays up: they have to go home first.
 */
export function sanctuaryDemolish(state, x, y) {
  const place = state.sanctuary;
  const found = cityStructureAt(place, x, y);
  if (found?.piece && isPen(found.piece) && residentsOf(place, found.piece).length > 0) {
    return { ok: false, reason: 'bring its animals home first' };
  }
  return cityDemolish(state, x, y, place);
}

// --- visitors and what they leave ---------------------------------------
//
// People come out from the city to see the animals, and leave a little in the
// box at the visitor centre. How much turns on how many *kinds* there are to
// see, not how many animals — thirty rabbits are one thing to look at — and on
// how many people the city has to send. It is small on purpose: the sanctuary
// is somewhere to spend, and this is a thank-you rather than a business.

/** Dollars a day for each kind kept, with the city full. */
export const DONATION_PER_KIND = 15;
/** The box holds this many days' donations and then stops filling. */
export const DONATION_BOX_DAYS = 3;
/** Real work is done one tick in this many. */
export const SANCTUARY_INTERVAL = 60;
/** One visitor in view for this many city folk, up to a cap. */
export const PEOPLE_PER_VISITOR = 60;
export const VISITOR_MAX = 12;

/** What the box is taking a day right now, in dollars. */
export function donationsPerDay(state) {
  const place = state.sanctuary;
  if (!place || facts(place).centres === 0) return 0;
  const crowd = Math.min(1, Math.round(state.city?.population || 0) / CITY_FULL_POPULATION);
  return DONATION_PER_KIND * kindsKept(place) * crowd;
}

/** How much the box holds before it stops filling. */
export function donationBoxCap(state) { return donationsPerDay(state) * DONATION_BOX_DAYS; }

/** Empties the box into the purse. */
export function collectDonations(state) {
  const place = state.sanctuary;
  const got = Math.floor(place.donations || 0);
  if (got <= 0) return { ok: false, got: 0 };
  place.donations -= got;
  state.money += got;
  emitUnlessSuspended('money:changed', { delta: got });
  return { ok: true, got };
}

/** How many visitors a city of this size sends, with something to see. */
export function visitorsWanted(state) {
  const place = state.sanctuary;
  if (!place || facts(place).centres === 0 || kindsKept(place) === 0) return 0;
  return Math.min(VISITOR_MAX, Math.floor(Math.round(state.city?.population || 0) / PEOPLE_PER_VISITOR));
}

// --- the clock ----------------------------------------------------------

/** Advances the sanctuary. Called every tick; does little on most of them. */
export function updateSanctuary(state) {
  const place = state.sanctuary;
  if (!place) return;

  if (state.tickCount % SANCTUARY_INTERVAL === 0) {
    const perDay = donationsPerDay(state);
    if (perDay > 0) {
      const cap = perDay * DONATION_BOX_DAYS;
      place.donations = Math.min(Math.max(cap, place.donations || 0),
        (place.donations || 0) + perDay * (SANCTUARY_INTERVAL / TICKS_PER_DAY));
    }
    settle(state, place);
  }

  step(state, place);
}

/**
 * Puts everyone somewhere they may stand, after the map has changed under
 * them, and brings the visitors into line with how many there should be.
 */
function settle(state, place) {
  const f = facts(place);
  for (const r of place.residents) {
    const pen = f.byPen.get(r.pen);
    if (pen && pen.spotSet.has(r.y * place.w + r.x)) continue;
    const home = place.pieces.find((p) => p.id === r.pen);
    const at = home ? freeSpotIn(state, place, home) : null;
    if (at == null) continue;
    r.x = r.px = at % place.w;
    r.y = r.py = Math.floor(at / place.w);
  }

  place.folk = place.folk || [];
  const want = f.paths.length ? visitorsWanted(state) : 0;
  for (let i = place.folk.length; i < want; i++) {
    const at = f.paths[Math.floor(state.rng.next() * f.paths.length)];
    place.folk.push({
      kind: 'folk', sprite: Math.floor(state.rng.next() * 3),
      x: at % place.w, y: Math.floor(at / place.w), px: at % place.w, py: Math.floor(at / place.w),
      flip: state.rng.next() < 0.5,
      next: state.tickCount + RESIDENT_REST_MIN + Math.floor(state.rng.next() * RESIDENT_REST_SPREAD),
    });
  }
  if (place.folk.length > want) place.folk.length = want;
  for (const m of place.folk) {
    if (f.pathSet.has(m.y * place.w + m.x)) continue;
    const at = f.paths[Math.floor(state.rng.next() * f.paths.length)];
    m.x = m.px = at % place.w;
    m.y = m.py = Math.floor(at / place.w);
  }
}

const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * One tick of standing about, for residents and visitors alike: whoever's rest
 * is over takes one step to a neighbouring tile they may stand on, or stays
 * put, and rests again. The same single-tile move the farm's animals make and
 * nothing more — no bobbing, no sliding about.
 */
function step(state, place) {
  const movers = [place.residents, place.folk || []];
  let f = null;
  for (const list of movers) {
    for (const m of list) {
      if (m.px !== m.x || m.py !== m.y) { m.px = m.x; m.py = m.y; }
      if (state.tickCount < m.next) continue;
      f = f || facts(place);
      const [dx, dy] = STEPS[Math.floor(state.rng.next() * STEPS.length)];
      const nx = m.x + dx;
      const ny = m.y + dy;
      const i = ny * place.w + nx;
      const allowed = list === place.residents ? f.byPen.get(m.pen)?.spotSet : f.pathSet;
      if (nx >= 0 && nx < place.w && allowed?.has(i) && !list.some((o) => o !== m && o.x === nx && o.y === ny)) {
        m.x = nx;
        m.y = ny;
        if (dx) {
          if (list === place.residents) m.facing = dx < 0 ? 'left' : 'right';
          else m.flip = dx < 0;
        }
      }
      m.next = state.tickCount + RESIDENT_REST_MIN + Math.floor(state.rng.next() * RESIDENT_REST_SPREAD);
    }
  }
}

/** Is anyone in the sanctuary partway between two tiles? For the renderer. */
export function sanctuaryMoving(state) {
  const place = state.sanctuary;
  if (!place) return false;
  return place.residents.some((m) => m.px !== m.x || m.py !== m.y)
    || (place.folk || []).some((m) => m.px !== m.x || m.py !== m.y);
}

/**
 * Hands home any resident the sanctuary can no longer hold: one whose
 * enclosure is gone, or whose kind the game no longer knows (dropped, since
 * it cannot be drawn anywhere). Run on load, so a save never strands one.
 *
 * @returns {{returned: number, dropped: number}}
 */
export function reconcileSanctuary(state) {
  const place = state.sanctuary;
  if (!place) return { returned: 0, dropped: 0 };
  const penIds = new Set(pens(place).map((p) => p.id));
  let returned = 0;
  let dropped = 0;
  for (const r of [...place.residents]) {
    if (!animalDef(r.type)) {
      place.residents.splice(place.residents.indexOf(r), 1);
      dropped++;
    } else if (!penIds.has(r.pen)) {
      if (bringHome(state, r).ok) returned++;
    }
  }
  return { returned, dropped };
}

/** "Biscuit the fox", or "the fox": how the sanctuary speaks of a resident. */
export function residentLabel(resident) {
  const kind = animalDef(resident.type).name.toLowerCase();
  return resident.name ? `${resident.name} the ${kind}` : calledAs(resident);
}
