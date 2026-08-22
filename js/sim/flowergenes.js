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

/** The three greys on the sheet, and so the three genes: lightest first. */
export const TONE_COUNT = 3;

const clampSat = (s) => Math.max(10, Math.min(100, Math.round(s)));
const wrap = (h) => ((Math.round(h) % 360) + 360) % 360;

/**
 * A genome: one hue for each of the three greys the sheet is drawn in, and a
 * saturation shared by all of them.
 *
 * Three hues rather than one, because the sheet gives three colours to replace
 * and a gene apiece is what makes crossing worth doing. With a single hue
 * driving all three tones there was almost nothing to recombine — a child could
 * take "the colour" from one parent or the other and that was the whole of it.
 * With three, a flower can have its mother's petals over its father's shadow,
 * which is a thing neither parent was and neither could produce alone.
 *
 * The three *lightnesses* are fixed (see render/flowerart.js). Only the hues
 * are inherited, so a flower always reads as lit face, middle and shadow
 * however wild its colours get, and no cross can come out flat or inside out.
 *
 * Accepts a single number for the common case of a flower that is all one
 * colour, which is every wild one.
 */
export function makeGenome(hues, sat = WILD_SATURATION) {
  const list = Array.isArray(hues) ? hues : [hues, hues, hues];
  const out = [];
  for (let i = 0; i < TONE_COUNT; i++) out.push(wrap(list[i] ?? list[0]));
  return { hues: out, sat: clampSat(sat) };
}

/** The colour a flower reads as: its petals, the lightest of the three. */
export const petalHue = (g) => g.hues[0];

/**
 * A wild colour: one of the two dozen on the ring, all three tones alike.
 *
 * Wild flowers are deliberately of one colour. A three-toned flower is
 * therefore visibly the work of a gardener, which makes the first one a player
 * breeds unmistakable without anything having to announce it.
 */
export function rollWildGenome(rng) {
  return makeGenome(rng.int(WILD_HUES) * HUE_STEP);
}

/**
 * Genomes are written into item ids, so they have to survive a round trip
 * through a string. Kept readable rather than packed — a save you can read is
 * a save you can debug, and this game has needed that more than once.
 */
export function genomeCode(g) {
  const [a, b, c] = g.hues;
  // One colour writes itself once. Most flowers are wild, and a save full of
  // `h120-120-120` would be noise in something meant to stay readable.
  const hues = a === b && b === c ? `h${a}` : `h${a}-${b}-${c}`;
  return g.sat === WILD_SATURATION ? hues : `${hues}s${g.sat}`;
}

export function parseGenome(code) {
  const hues = /h(\d+)(?:-(\d+)-(\d+))?/.exec(code);
  if (!hues) return null;
  const sat = /s(\d+)/.exec(code);
  const list = hues[2] === undefined
    ? +hues[1]
    : [+hues[1], +hues[2], +hues[3]];
  return makeGenome(list, sat ? +sat[1] : WILD_SATURATION);
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
  const [a, b, c] = g.hues;
  return a === b && b === c && a % HUE_STEP === 0 && g.sat === WILD_SATURATION;
}

export const isCross = (g) => !isWildGenome(g);

/**
 * What a flower is called: its colour, its kind, and whether it was bred.
 * Returned in lower case, so a caller can put it mid-sentence or capitalise it
 * once at the front — anything else leaves a capital stranded in the middle.
 */
export function flowerLabel(kind, genome) {
  const name = `${hueName(petalHue(genome)).toLowerCase()} ${FLOWERS[kind].name.toLowerCase()}`;
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
 * How often a child is a blend of its parents rather than an inheritance.
 *
 * Both are needed, and for opposite reasons. Blending is what *finds* colours:
 * halfway between two parents is somewhere neither of them was, which is how
 * the gaps in the wild ring get filled. But blending alone converges — every
 * generation pulls toward the average, so a bed left crossing long enough goes
 * quietly uniform and muddy, and the striking colours that went into it are
 * gone for good.
 *
 * Inheriting instead keeps them. A child that takes its hue whole from one
 * parent is a colour that survives another generation intact, so a shade worth
 * having can spread through a bed rather than being averaged away by its own
 * offspring.
 */
export const BLEND_CHANCE = 0.6;

/**
 * A child of two flowers, by one of two routes.
 *
 * **Blended:** halfway between its parents and then nudged. The nudge matters —
 * a child that is exactly the midpoint every time makes breeding a calculator
 * rather than a garden, and it is what eventually reaches the colours no pair
 * of wild flowers sits either side of.
 *
 * **Inherited:** each gene taken whole from one parent or the other, and taken
 * faithfully. A flower may end up with its mother's colour at its father's
 * strength, which is a combination neither parent had without being a colour
 * neither parent could pass on.
 */
export function crossGenomes(a, b, rng) {
  if (rng.chance(BLEND_CHANCE)) {
    const hues = a.hues.map((hue, i) => blendHue(hue, b.hues[i], rng)
      + rng.range(-MUTATION, MUTATION + 1));
    return makeGenome(hues, Math.round((a.sat + b.sat) / 2) + rng.range(-5, 6));
  }

  // Each tone rolled on its own, which is where the interesting flowers come
  // from: a child can take its petals from one parent and its shadow from the
  // other, and be a thing neither of them was.
  const hues = a.hues.map((hue, i) => (rng.chance(0.5) ? hue : b.hues[i]));
  return makeGenome(hues, rng.chance(0.5) ? a.sat : b.sat);
}

/** Which of the wild ring's slots a hue falls in — the unit a journal counts. */
export function hueSlot(hue) {
  const h = ((hue % 360) + 360) % 360;
  return Math.round(h / HUE_STEP) % WILD_HUES;
}

/** How many of a flower's three tones differ — 1 for a plain one, up to 3. */
export function toneCount(g) {
  return new Set(g.hues).size;
}
