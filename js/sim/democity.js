// A finished city, laid out by hand, for looking at.
//
// Building a city worth judging costs a few hundred thousand dollars and a
// week of waiting for people to move in, which is no way to find out whether
// the thing looks right. This puts one down for nothing, already full, so the
// art, the street furniture, the townsfolk and the factory can all be seen at
// once. It is a testing tool, reached from the console as lilfarm.demoCity();
// nothing in the game calls it.
//
// It goes through cityBuild like a player would, so the layout obeys every
// placement rule and anything that would not fit is reported rather than
// forced in. No randomness: the same city every time.

import { newCity, cityBuild } from './city.js';
import { plotBounds, middlePlot } from '../world/land.js';
import { housingCapacity } from './citylife.js';
import { newSanctuary, sendToSanctuary, sanctuaryCapacity, donationBoxCap } from './sanctuary.js';
import { makeAnimal, GIFT_ANIMALS } from './animals.js';
import { WILD_IDS } from './wildkinds.js';

/**
 * Replaces the city with the demonstration one.
 *
 * Refuses if anything is already built, unless forced: this throws away what
 * is there, and a city somebody paid for is not for a testing tool to clear.
 * Money is untouched — the pieces are bought from a purse that is put back.
 *
 * @returns {{ok: boolean, reason?: string, pieces?: number, population?: number,
 *   refused?: Array<{kind: string, x: number, y: number, reason: string}>}}
 */
export function buildDemoCity(state, { force = false } = {}) {
  const old = state.city;
  const built = old && (old.pieces.length > 0 || old.ground.some((g) => g !== 0));
  if (built && !force) return { ok: false, reason: 'there is already a city here' };

  const purse = state.money;
  state.money = Number.MAX_SAFE_INTEGER;
  state.city = newCity();
  const refused = [];

  // Laid out in lot coordinates, and put down in the middle lot, the one a
  // new city owns.
  const { x0: ox, y0: oy } = plotBounds(middlePlot(state.city.w, state.city.h).px, middlePlot(state.city.w, state.city.h).py);
  const put = (kind, lx, ly, size) => {
    const x = lx + ox;
    const y = ly + oy;
    const res = cityBuild(state, kind, x, y, size);
    // Streets cross, so laying one over another is expected, not a fault.
    if (!res.ok && !/already/.test(res.reason)) refused.push({ kind, x, y, reason: res.reason });
  };
  const fill = (kind, x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(kind, x, y);
  };
  const row = (kind, y, x0, x1, step = 1) => { for (let x = x0; x <= x1; x += step) put(kind, x, y); };
  const col = (kind, x, y0, y1, step = 1) => { for (let y = y0; y <= y1; y += step) put(kind, x, y); };

  // --- streets ----------------------------------------------------------
  //
  // A main street running east-west and an avenue running north-south cut the
  // map into four quarters; two side streets serve the blocks set back from
  // the crossing. Every road is two tiles wide, which is what a van needs,
  // with a strip of paving either side.

  fill('road', 2, 18, 37, 19);     // Main Street
  fill('road', 19, 2, 20, 37);     // the avenue
  fill('road', 2, 9, 18, 10);      // north side street
  fill('road', 2, 28, 18, 29);     // south side street

  row('pavement', 17, 2, 18); row('pavement', 17, 21, 37);
  row('pavement', 20, 2, 18); row('pavement', 20, 21, 37);
  col('pavement', 18, 2, 8); col('pavement', 18, 11, 16);
  col('pavement', 18, 21, 27); col('pavement', 18, 30, 37);
  col('pavement', 21, 2, 16); col('pavement', 21, 21, 37);
  row('pavement', 8, 2, 17); row('pavement', 11, 2, 17);
  row('pavement', 27, 2, 17); row('pavement', 30, 2, 17);

  // --- north-west: where people live -----------------------------------

  put('apartments', 3, 3, [8, 5]);
  put('apartments', 12, 4, [6, 4]);
  put('apartments', 3, 12, [6, 5]);
  put('apartments', 11, 13, [5, 4]);

  put('topiaryGreen', 1, 7); put('topiaryOrange', 11, 7);
  put('lamp', 11, 8); put('lamp', 2, 11); put('lamp', 9, 11); put('lamp', 16, 11);
  put('bench', 9, 16); put('pottedGreen', 16, 16); put('pottedOrange', 17, 16);
  put('lamp', 9, 17); put('lamp', 17, 17);
  put('hydrant', 2, 17); put('bin', 16, 17);

  // --- north-east: the shops, and a park behind them -------------------

  put('bakery', 23, 13, [4, 4]);
  put('grocer', 28, 13, [5, 4]);
  put('dairy', 34, 13, [4, 4]);
  put('lamp', 22, 17); put('lamp', 27, 17); put('lamp', 33, 17);
  put('bin', 27, 16); put('pottedGreen', 33, 16);

  // The park: a picket fence with a gap for the path, trees, somewhere to sit.
  row('picketFence', 3, 23, 37); row('picketFence', 11, 23, 37);
  col('picketFence', 23, 4, 6); col('picketFence', 23, 8, 10);
  col('picketFence', 37, 4, 10);
  row('pavement', 7, 22, 35);
  col('pavement', 30, 5, 9);
  put('topiaryGreen', 25, 5); put('topiaryOrange', 27, 5); put('topiaryGreen', 33, 5); put('topiaryOrange', 35, 5);
  put('topiaryOrange', 25, 10); put('topiaryGreen', 27, 10); put('topiaryOrange', 33, 10); put('topiaryGreen', 35, 10);
  put('planter', 26, 8); put('planter', 32, 8);
  put('bench', 26, 6); put('bench', 32, 6);
  put('lamp', 29, 6); put('lamp', 31, 9);

  // --- south-west: more flats, and the tailor --------------------------

  put('apartments', 3, 22, [7, 5]);
  put('tailor', 12, 23, [5, 4]);
  put('apartments', 4, 31, [8, 6]);
  row('pavement', 37, 3, 17);

  put('busShelter', 5, 20); put('busSign', 8, 20);
  put('lamp', 11, 20); put('lamp', 17, 20);
  put('topiaryGreen', 10, 26); put('bench', 10, 27); put('lamp', 2, 27); put('lamp', 17, 27);
  put('topiaryOrange', 14, 33); put('topiaryGreen', 16, 33); put('topiaryOrange', 14, 35); put('topiaryGreen', 16, 35);
  put('bench', 13, 37); put('lamp', 3, 37); put('hydrant', 17, 30);
  put('stopSign', 2, 30); put('stopSign', 2, 8);

  // --- south-east: the factory district --------------------------------
  //
  // One line to a row, each with a pair of machines on a belt running from a
  // stack of boxes to a crate: mill, cannery, creamery, loom.

  col('powerPole', 21, 23, 35, 4);
  put('lamp', 21, 20); put('lamp', 28, 20); put('lamp', 35, 20);
  row('chainFence', 22, 23, 37); col('chainFence', 37, 23, 36); row('chainFence', 36, 23, 36);
  col('chainFence', 23, 23, 27); col('chainFence', 23, 31, 35);

  fill('floor', 22, 28, 23, 30);          // the way in, off the avenue
  fill('floor', 24, 23, 36, 35);
  col('hazard', 24, 28, 30);

  const lines = [['mill', 24], ['cannery', 27], ['creamery', 31], ['loom', 34]];
  for (const [machine, y] of lines) {
    put('boxes', 26, y);
    row('conveyor', y, 27, 28);
    put(machine, 29, y);
    row('conveyorTrim', y, 30, 31);
    put(machine, 32, y);
    put('conveyor', 33, y);
    put('crate', 34, y);
  }
  col('pipe', 35, 24, 34);
  put('forklift', 26, 29); put('crate', 30, 29); put('crate', 31, 29); put('boxes', 33, 29);

  // --- and the people ---------------------------------------------------
  //
  // Moving in takes hours. For looking at, everyone is home already; the
  // townsfolk and the vans turn up over the next few minutes of ticks.
  state.city.population = housingCapacity(state.city);
  state.money = purse;

  return {
    ok: true,
    pieces: state.city.pieces.length,
    population: state.city.population,
    refused,
  };
}

/**
 * Replaces the sanctuary with a demonstration one: four enclosures with their
 * comforts, trails between them, a visitor centre, and one of every animal the
 * sanctuary takes for as long as there is room. Console only, as the city's is:
 * lilfarm.demoSanctuary().
 *
 * The animals are made for the purpose rather than taken from the farm, so the
 * farm's own are left where they are.
 *
 * @returns {{ok: boolean, reason?: string, pieces?: number, animals?: number,
 *   refused?: Array<{kind: string, x: number, y: number, reason: string}>}}
 */
export function buildDemoSanctuary(state, { force = false } = {}) {
  const old = state.sanctuary;
  const built = old && (old.pieces.length > 0 || old.residents.length > 0 || old.ground.some((g) => g !== 0));
  if (built && !force) return { ok: false, reason: 'there is already a sanctuary here' };

  const purse = state.money;
  state.money = Number.MAX_SAFE_INTEGER;
  state.sanctuary = newSanctuary();
  const place = state.sanctuary;
  const refused = [];

  const { x0: ox, y0: oy } = plotBounds(middlePlot(place.w, place.h).px, middlePlot(place.w, place.h).py);
  const put = (kind, lx, ly, size) => {
    const x = lx + ox;
    const y = ly + oy;
    const res = cityBuild(state, kind, x, y, size, place);
    if (!res.ok && !/already/.test(res.reason)) refused.push({ kind, x, y, reason: res.reason });
  };
  const fill = (kind, x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(kind, x, y);
  };

  // --- paths ------------------------------------------------------------
  //
  // A paved forecourt by the visitor centre, and a trail out from it that
  // runs between the enclosures, so visitors have somewhere to stand at each.

  fill('pavement', 16, 32, 24, 34);
  fill('trail', 19, 6, 20, 31);        // the spine, north from the forecourt
  fill('trail', 4, 18, 35, 19);        // and a cross trail between the rows

  put('visitorCentre', 18, 36, [5, 2]);
  put('bench', 16, 33); put('bench', 23, 33);
  put('lamp', 16, 32); put('lamp', 24, 32);
  put('bin', 18, 32); put('pottedGreen', 22, 32);
  put('planter', 19, 34);
  put('wishingWell', 21, 30);
  put('signpost', 18, 30); put('signpost', 18, 17); put('signpost', 21, 20);

  // --- enclosures -------------------------------------------------------
  //
  // Four, each with a different mix inside: woodland, a pool, rocks and
  // scrub, open meadow with hay. Every comfort makes room for more.

  put('paddock', 4, 5, [14, 12]);      // north-west: woodland
  put('oak', 6, 8); put('pine', 9, 7); put('maple', 13, 9); put('oak', 11, 13); put('pine', 7, 13);
  put('shrub', 14, 7); put('shrub', 8, 10);

  put('paddock', 22, 5, [14, 12]);     // north-east: the pool
  fill('pool', 26, 9, 30, 12);
  put('oak', 24, 7); put('shrub', 33, 8); put('boulder', 32, 13); put('drinker', 24, 14);

  put('paddock', 4, 21, [14, 10]);     // south-west: rocks and scrub
  put('boulder', 7, 24); put('boulder', 12, 26); put('boulder', 9, 27);
  put('shrub', 14, 23); put('shrub', 6, 28); put('maple', 13, 28);

  put('paddock', 22, 21, [14, 10]);    // south-east: meadow
  put('hayRack', 25, 24); put('hayRack', 31, 27); put('drinker', 28, 23);
  put('oak', 33, 24); put('pine', 24, 28);

  put('picketFence', 15, 31); put('picketFence', 15, 35);
  put('picketFence', 25, 31); put('picketFence', 25, 35);

  // --- and the animals --------------------------------------------------
  //
  // One of each kind the sanctuary takes, the mythicals first, for as long as
  // there is room. Made beside the farmer and sent straight over.
  const kinds = [...GIFT_ANIMALS, ...WILD_IDS];
  let animals = 0;
  for (const type of kinds) {
    if (place.residents.length >= sanctuaryCapacity(place)) break;
    const a = makeAnimal(state, type, state.farmer.x, state.farmer.y);
    if (sendToSanctuary(state, a).ok) animals++;
    else state.animals.splice(state.animals.indexOf(a), 1);
  }

  // A full box, so collecting from the visitor centre can be tried at once.
  place.donations = donationBoxCap(state);
  state.money = purse;

  return { ok: true, pieces: place.pieces.length, animals, refused };
}
