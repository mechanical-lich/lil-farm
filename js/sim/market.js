// The market: what the town wants this evening, and what it is sick of.
//
// The farm it was written for had seventy-two plots of eggplant and nothing
// else — and three hundred cabbage seeds sitting unplanted in the bag. Eggplant
// is not even efficient (wheat earns more than twice as much per minute); it
// wins because nobody plants for you, so the only crop worth growing is the one
// that survives being left alone. Price alone will not fix that. What it can
// fix is the choice *between* the crops you can walk away from, and that is
// what this is for.
//
// WHAT IT MEASURES, AND WHY IT IS A MIX
//
// The obvious design — "the town wants forty eggplants a day" — breaks on a
// real farm. That farm sells over a thousand a day, so it would sit at the
// floor price permanently, in every good, forever: a flat pay cut and no
// variety at all. Any fixed appetite is either too small to survive the late
// game or too large to matter in the early one.
//
// So the town has no fixed appetite. It takes whatever volume you bring, and
// has opinions only about the *proportions*. Sell it a third eggplant when it
// wanted a third eggplant and you get full price. Sell it nothing but eggplant
// and the price sags while everything you are not bringing climbs. Doubling the
// size of the farm changes nothing; changing what you plant changes everything,
// which is the only thing this feature is trying to do.
//
// THREE PROPERTIES IT HAS TO HAVE, being simulation:
//
//   - Deterministic. state.rng only, driven by tickCount, never the wall clock,
//     or catching up twice would arrive at two different markets.
//   - Cheap to replay. Catch-up runs this hundreds of thousands of times, so it
//     does real work on one tick in MARKET_INTERVAL, as weeds and mushrooms do.
//   - Gentle at the edges. A beginner's first five carrots must not crater the
//     carrot price, and no glut may ever make a harvest worthless.

import { emitUnlessSuspended } from '../engine/events.js';
import { CROPS } from './crops.js';
import { ITEMS } from './inventory.js';

/** One tick is a second, so a day is this many. */
export const TICKS_PER_DAY = 24 * 60 * 60;

/** Demand is re-rolled twice a day. */
export const ROLL_INTERVAL = TICKS_PER_DAY / 2;

/** Real work happens on one tick in sixty. Catch-up replays a lot of these. */
export const MARKET_INTERVAL = 60;

/**
 * What the market trades: things you grow and things your animals make.
 *
 * Deliberately not wood or stone — they are what buildings are made of, and a
 * barn whose price wandered would be a nuisance rather than a decision. Nor
 * mushrooms: those are the foraging fantasy, and haggling over a morel cheapens
 * finding one.
 */
export const TRADED = [...Object.keys(CROPS), 'egg', 'milk', 'wool'];

/**
 * What share of the market each good normally accounts for.
 *
 * Not equal shares, and this is the whole difficulty of the thing. An even
 * split would be asking for equal *value* of carrots and eggplants, and a
 * carrot is worth a tenth of an eggplant — matching one plot of eggplant would
 * mean ten times the sowing, on a farm where nobody sows but the player. A
 * market built that way prices a genuinely varied farm as a monoculture, which
 * was exactly what the first version did.
 *
 * So the shares are weighted roughly by what a plot or an animal actually
 * returns for one visit. The reading is "this is what a normal farm brings to
 * market", and the price asks only how far you have strayed from it. Sell the
 * ordinary mix and everything is at full price; sell one thing and nothing
 * else and you will feel it.
 */
export const BASE_SHARE = {
  carrot: 3, wheat: 4, corn: 7, tomato: 10, cabbage: 16, eggplant: 24,
  egg: 10, milk: 14, wool: 12,
};

export const PRICE_FLOOR = 0.5;
export const PRICE_CEILING = 1.5;

/**
 * How far over its normal share a good must be sold before it hits the floor.
 *
 * Five, against shares that already describe a normal farm — so selling only
 * eggplant, which is four times its usual share of the market, lands near the
 * bottom, while a farm that grows several things sits close to full price even
 * when the mix is untidy. A curve rather than a cliff: mild imbalance is barely
 * marked down.
 */
export const GLUT_RATIO = 5;

/**
 * Value of stock the town is assumed to hold regardless, in coins.
 *
 * This is what stops the market lurching on tiny volumes: until a farm is
 * selling more than this in a day, its sales are diluted by the town's own
 * stock and prices stay near normal. A beginner therefore sees a calm market,
 * and it wakes up as the farm grows into it. Past a few thousand a day this
 * number stops mattering and the mix alone decides, which is what keeps the
 * whole thing scale-free at the top end.
 */
export const MARKET_DEPTH = 10000;

/** How far a good's share may drift from its normal one, as a multiple. */
const WEIGHT_MIN = 0.5;
const WEIGHT_MAX = 1.8;

/** How far a share may move in one roll. Small enough to read as a trend. */
const DRIFT = 0.35;

/** How hard today's appetite pulls on the price, as a power. */
const DEMAND_TILT = 0.6;

/** Stock left after a day, at average demand. Recent sales are what count. */
const KEEP_PER_DAY = 0.35;

/** The slowest anything clears, relative to average. See consume(). */
const APPETITE_FLOOR = 0.45;

/** A market where the town wants a little of everything and holds no glut. */
export function newMarket() {
  const demand = {};
  for (const id of TRADED) demand[id] = BASE_SHARE[id] || 1;
  return { demand, supply: {}, nextRoll: ROLL_INTERVAL };
}

/** The base price a good would fetch if the market were perfectly balanced. */
export function basePrice(id) {
  return ITEMS[id]?.sell || 0;
}

/** What each good is normally worth to the market, normalised to sum to one. */
export function baseShares() {
  const total = TRADED.reduce((n, id) => n + (BASE_SHARE[id] || 0), 0) || 1;
  const out = {};
  for (const id of TRADED) out[id] = (BASE_SHARE[id] || 0) / total;
  return out;
}

/** Demand shares as they stand today, normalised to sum to one. */
export function wantedShares(market) {
  const total = TRADED.reduce((n, id) => n + (market.demand[id] || 0), 0) || 1;
  const out = {};
  for (const id of TRADED) out[id] = (market.demand[id] || 0) / total;
  return out;
}

/**
 * What the town is holding, by value, as a share of everything it holds.
 *
 * MARKET_DEPTH is folded in *along the wanted shares*, which is what makes an
 * empty market read as balanced rather than as a shortage of everything: with
 * nothing sold, every share equals its wanted share and every price is normal.
 */
export function stockShares(market) {
  const wanted = baseShares();
  let total = MARKET_DEPTH;
  const value = {};
  for (const id of TRADED) {
    value[id] = (market.supply[id] || 0) + MARKET_DEPTH * wanted[id];
    total += market.supply[id] || 0;
  }
  const out = {};
  for (const id of TRADED) out[id] = value[id] / total;
  return out;
}

/**
 * How over-supplied a good is: its share of the town's stock against the share
 * a normal farm would bring. One is balanced, nought is nobody-is-bringing-any.
 *
 * Measured against the *normal* share rather than today's demand, and that is
 * deliberate. Dividing by a drifting number cancels the drift out: every good
 * you were not selling came out at exactly the same price, whatever the town
 * happened to want, and the market panel showed eight identical rows and no
 * answer to the only question worth asking — which of these should I grow?
 * Demand is applied separately, as a tilt, so that it can be seen.
 */
export function glutRatio(market, id) {
  const normal = baseShares()[id] || 0;
  if (normal <= 0) return 1;
  return (stockShares(market)[id] || 0) / normal;
}

/**
 * What the town's current appetite does to the price, on top of the glut.
 *
 * This is the part the player can act on without selling anything first: a good
 * the town has taken a liking to pays more even if nobody is bringing any yet.
 * Softened by a power so that a doubling of demand is a healthy premium rather
 * than a doubling of the price.
 */
export function demandTilt(market, id) {
  const normal = baseShares()[id] || 0;
  const wanted = wantedShares(market)[id] || 0;
  if (normal <= 0) return 1;
  return (wanted / normal) ** DEMAND_TILT;
}

/**
 * The price multiplier for a ratio. Ceiling when none is being brought, normal
 * at the wanted share, falling to the floor only under a real monoculture.
 */
export function multiplierFor(ratio) {
  if (ratio <= 1) {
    return PRICE_CEILING - (PRICE_CEILING - 1) * ratio;
  }
  const over = Math.min(ratio, GLUT_RATIO) - 1;
  return 1 - (1 - PRICE_FLOOR) * (over / (GLUT_RATIO - 1));
}

/** What one of these fetches right now, rounded to coins. */
export function priceOf(state, id) {
  const base = basePrice(id);
  if (!base || !state.market || !TRADED.includes(id)) return base;
  return Math.max(1, Math.round(base * priceMultiplier(state, id)));
}

/** The multiplier alone, for anything that wants to show which way prices moved. */
export function priceMultiplier(state, id) {
  if (!state.market || !TRADED.includes(id)) return 1;
  const raw = multiplierFor(glutRatio(state.market, id)) * demandTilt(state.market, id);
  return Math.min(PRICE_CEILING, Math.max(PRICE_FLOOR, raw));
}

/**
 * Records a sale. Supply is tracked by *value*, so a hundred carrots and two
 * sheep's wool weigh against each other the way the town would see them.
 */
export function recordSale(state, id, qty, earned) {
  if (!state.market || !TRADED.includes(id) || qty <= 0) return;
  state.market.supply[id] = (state.market.supply[id] || 0) + earned;
}

/** Advances the market. Called every tick; does real work rarely. */
export function updateMarket(state) {
  const market = state.market;
  if (!market) return;
  if (state.tickCount % MARKET_INTERVAL !== 0) return;

  consume(market);
  while (state.tickCount >= market.nextRoll) {
    rollDemand(state, market);
    market.nextRoll += ROLL_INTERVAL;
  }
}

/**
 * The town eating its way through what it holds.
 *
 * Proportional to demand, so a glut of something everyone wants clears quickly
 * and a glut of something nobody wants lingers — which is the difference
 * between a bad week and a bad month for whoever grew it.
 */
function consume(market) {
  const wanted = wantedShares(market);
  const average = 1 / TRADED.length;
  const fraction = MARKET_INTERVAL / TICKS_PER_DAY;
  for (const id of TRADED) {
    const stock = market.supply[id] || 0;
    if (stock <= 0) { delete market.supply[id]; continue; }
    // Floored, so a good nobody much wants still clears rather than piling up
    // for ever: an unwanted glut should be a bad month, not a permanent state.
    const appetite = APPETITE_FLOOR + (1 - APPETITE_FLOOR) * ((wanted[id] || 0) / average);
    const left = stock * KEEP_PER_DAY ** (fraction * appetite);
    market.supply[id] = left < 1 ? 0 : left;
  }
}

/**
 * Nudges what the town wants, rather than redrawing it.
 *
 * Drifting means the modal has something to show: a good climbing for two days
 * running is a trend the player can act on, where a fresh roll every twelve
 * hours would be noise they could only react to.
 */
function rollDemand(state, market) {
  const before = wantedShares(market);
  for (const id of TRADED) {
    const base = BASE_SHARE[id] || 1;
    const move = 1 + (state.rng.next() * 2 - 1) * DRIFT;
    const next = (market.demand[id] || base) * move;
    // Bounded around the good's normal share, not around one, so a drift never
    // wanders somewhere the farm could not possibly follow.
    market.demand[id] = Math.min(base * WEIGHT_MAX, Math.max(base * WEIGHT_MIN, next));
  }
  const after = wantedShares(market);
  const moved = TRADED
    .map((id) => ({ id, by: after[id] - before[id] }))
    .sort((a, b) => b.by - a.by);
  emitUnlessSuspended('market:rolled', { rising: moved[0].id, falling: moved[moved.length - 1].id });
}

/**
 * Every traded good with what it costs and why, for the market panel.
 * Sorted by how well it is paying, since that is the question being asked.
 */
export function marketRows(state) {
  const market = state.market;
  if (!market) return [];
  const wanted = wantedShares(market);
  const normal = baseShares();
  const stock = stockShares(market);
  return TRADED.map((id) => ({
    id,
    name: ITEMS[id]?.name || id,
    base: basePrice(id),
    price: priceOf(state, id),
    multiplier: priceMultiplier(state, id),
    // How keen the town is on this today, as a multiple of its usual appetite.
    appetite: normal[id] > 0 ? wanted[id] / normal[id] : 1,
    wanted: wanted[id],
    stocked: stock[id],
    ratio: glutRatio(market, id),
  })).sort((a, b) => b.multiplier - a.multiplier);
}
