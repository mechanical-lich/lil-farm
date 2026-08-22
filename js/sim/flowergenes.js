// Flower genetics: what a genome is, and how it survives being written down.
//
// Pure data and string handling, with no idea that a world exists. It sits at
// the bottom of the pile because the inventory needs to name a seed and the
// renderer needs to colour a petal, and neither should have to reach through
// the module that makes flowers grow in order to do it.
//
// WHY HUE IS A NUMBER OF DEGREES
//
// Breeding is coming: two flowers of a kind standing next to each other will
// raise a third that shares their genes, and a child's colour is its parents'
// colours averaged. Averaging two indices into a palette is meaningless;
// averaging two angles is exactly the right answer. Building it any other way
// today would mean migrating every seed anybody owns tomorrow.
//
// Wild flowers are drawn from a coarse ring of WILD_HUES — the player finds two
// dozen colours out in the grass, and everything between them has to be bred.
// That gap is the point: a wheel with holes in it is an invitation, where a
// wheel already full is a shelf.

/**
 * The eight on the sheet, in sheet order. `sprite` is the column.
 *
 * They are told apart by shape alone, since colour belongs to the genome — so
 * the names describe silhouettes, not petals.
 */
export const FLOWERS = {
  sunflower: { name: 'Sunflower', sprite: 0 },
  bird: { name: 'Bird of Paradise', sprite: 1 },
  daisy: { name: 'Daisy', sprite: 2 },
  peony: { name: 'Peony', sprite: 3 },
  poppy: { name: 'Poppy', sprite: 4 },
  bluebell: { name: 'Bluebell', sprite: 5 },
  crocus: { name: 'Crocus', sprite: 6 },
  phlox: { name: 'Phlox', sprite: 7 },
};

export const FLOWER_KINDS = Object.keys(FLOWERS);

export function flowerDef(kind) { return FLOWERS[kind] || null; }

/** How many colours grow wild, per kind. Everything else must be bred. */
export const WILD_HUES = 24;

/** The wild ring, in degrees. */
export const HUE_STEP = 360 / WILD_HUES;

/** How strongly a wild flower is coloured. Bred ones may drift from this. */
export const WILD_SATURATION = 70;

const clampSat = (s) => Math.max(10, Math.min(100, Math.round(s)));

/**
 * A genome. Hue is degrees around the wheel, saturation a percentage, and
 * `split` says whether the middle of the three tones swings to a neighbouring
 * hue — which is what makes a two-tone flower.
 */
export function makeGenome(hue, sat = WILD_SATURATION, split = false) {
  return { hue: ((Math.round(hue) % 360) + 360) % 360, sat: clampSat(sat), split: !!split };
}

/** A wild colour: one of the two dozen on the ring, at the wild saturation. */
export function rollWildGenome(rng) {
  return makeGenome(rng.int(WILD_HUES) * HUE_STEP);
}

/**
 * Genomes are written into item ids, so they have to survive a round trip
 * through a string. Kept readable rather than packed — a save you can read is
 * a save you can debug, and this game has needed that more than once.
 */
export function genomeCode(g) {
  const parts = [`h${g.hue}`];
  if (g.sat !== WILD_SATURATION) parts.push(`s${g.sat}`);
  if (g.split) parts.push('t');
  return parts.join('');
}

export function parseGenome(code) {
  const hue = /h(\d+)/.exec(code);
  if (!hue) return null;
  const sat = /s(\d+)/.exec(code);
  return makeGenome(+hue[1], sat ? +sat[1] : WILD_SATURATION, /t/.test(code));
}

// --- seeds ---------------------------------------------------------------
//
// A seed carries its flower's genome in its own id, which means the inventory
// stays the flat map of counts it has always been: two seeds of the very same
// colour stack, and two of nearly the same colour do not. Nothing about the
// save's shape had to change to hold a thousand possible colours.

export const SEED_PREFIX = 'flowerseed_';

export function seedIdFor(kind, genome) {
  return `${SEED_PREFIX}${kind}_${genomeCode(genome)}`;
}

export function isFlowerSeed(id) {
  return typeof id === 'string' && id.startsWith(SEED_PREFIX);
}

/** @returns {{kind: string, genome: object}|null} */
export function readSeedId(id) {
  if (!isFlowerSeed(id)) return null;
  const rest = id.slice(SEED_PREFIX.length);
  const cut = rest.indexOf('_');
  if (cut < 0) return null;
  const kind = rest.slice(0, cut);
  const genome = parseGenome(rest.slice(cut + 1));
  return FLOWERS[kind] && genome ? { kind, genome } : null;
}

/**
 * Whether this is a colour that grows wild, or one that only exists because
 * somebody bred it.
 *
 * Wild flowers come off a coarse ring at a fixed strength; anything that is not
 * exactly on that ring came from a pair of parents. It is worth saying out
 * loud, because a crossed colour is the one thing in the bag that cannot be
 * found again by walking around — lose the seeds and it is gone.
 */
export function isWildGenome(g) {
  return g.hue % HUE_STEP === 0 && g.sat === WILD_SATURATION && !g.split;
}

export const isCross = (g) => !isWildGenome(g);

/**
 * What a flower is called: its colour, its kind, and whether it was bred.
 * Returned in lower case, so a caller can put it mid-sentence or capitalise it
 * once at the front — anything else leaves a capital stranded in the middle.
 */
export function flowerLabel(kind, genome) {
  const name = `${hueName(genome.hue).toLowerCase()} ${FLOWERS[kind].name.toLowerCase()}`;
  return isCross(genome) ? `crossed ${name}` : name;
}

/** The same, with its first letter up, for the start of a line. */
export function sentenceCase(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What a seed calls itself in the bag. */
export function seedName(id) {
  const seed = readSeedId(id);
  if (!seed) return id;
  return `${sentenceCase(flowerLabel(seed.kind, seed.genome))} seeds`;
}

/**
 * A colour in words. Twelve names around the wheel, which is enough to tell two
 * seeds apart in a list without pretending to more precision than a player can
 * see — the swatch beside it is the real answer.
 */
const HUE_NAMES = [
  'Red', 'Orange', 'Amber', 'Yellow', 'Lime', 'Green',
  'Teal', 'Cyan', 'Sky', 'Blue', 'Violet', 'Pink',
];

export function hueName(hue) {
  const h = ((hue % 360) + 360) % 360;
  return HUE_NAMES[Math.round(h / 30) % HUE_NAMES.length];
}

// --- breeding ------------------------------------------------------------

/** How far a child may stray from halfway between its parents, in degrees. */
export const MUTATION = 8;

/**
 * The colour halfway between two hues, going the short way round.
 *
 * This is the reason hue is stored as an angle. Averaging 350 and 10 as plain
 * numbers gives 180 — the exact opposite colour — where the answer anybody
 * looking at two red flowers expects is red. Averaging them as points on a
 * circle gives 0, which is why the parents are turned into vectors first.
 */
export function blendHue(a, b, rng) {
  const rad = (d) => (d * Math.PI) / 180;
  const x = Math.cos(rad(a)) + Math.cos(rad(b));
  const y = Math.sin(rad(a)) + Math.sin(rad(b));

  // Directly opposite parents cancel out, and there is no halfway between them
  // — both quarter-turns are equally far. Rather than let the maths pick by
  // rounding error, the child takes after one parent or the other.
  if (Math.hypot(x, y) < 1e-9) return rng.chance(0.5) ? a : b;

  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return ((Math.round(deg) % 360) + 360) % 360;
}

/**
 * A child of two flowers.
 *
 * Halfway between its parents and then nudged, because a child that is exactly
 * the midpoint every time makes breeding a calculator rather than a garden —
 * and because the nudge is what eventually reaches the colours no pair of wild
 * flowers sits either side of.
 */
export function crossGenomes(a, b, rng) {
  const hue = blendHue(a.hue, b.hue, rng) + rng.range(-MUTATION, MUTATION + 1);
  const sat = Math.round((a.sat + b.sat) / 2) + rng.range(-5, 6);
  // Two-tone is carried by one parent or the other rather than blended: it is
  // a thing a flower either does or does not do.
  const split = rng.chance(0.5) ? a.split : b.split;
  return makeGenome(hue, sat, split);
}

/** Which of the wild ring's slots a hue falls in — the unit a journal counts. */
export function hueSlot(hue) {
  const h = ((hue % 360) + 360) % 360;
  return Math.round(h / HUE_STEP) % WILD_HUES;
}
