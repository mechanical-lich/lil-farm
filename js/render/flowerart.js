// Turning a flower's genes into pixels.
//
// The sheet is drawn in three greys and nothing else: 255 for the lit face of
// a petal, 198 for its middle, 141 for its shadow. Everything else on the
// sprite — stems, the sunflower's brown eye, the daisy's dark one — is left
// alone, which is why a flower still reads as itself whatever colour it turns.
//
// Recolouring means reading the sprite's pixels back and writing new ones, and
// that is far too slow to do while drawing. So each genome is recoloured once,
// the result kept as a little canvas, and every draw after that is an ordinary
// blit. The renderer never learns that anything unusual is happening.
//
// The cache is bounded by how many colours actually exist rather than by how
// many are possible: a farm holds a few dozen at a time, each a 16x16 canvas of
// about a kilobyte. A thousand distinct flowers would cost a megabyte, and a
// thousand distinct flowers is a farm nobody has.

import { TILE } from '../config.js';
import { FLOWERS } from '../sim/flowergenes.js';

/** The three greys the artist left to be replaced, lightest first. */
export const KEYS = [[255, 255, 255], [198, 198, 198], [141, 141, 141]];

/**
 * Lightness of each of the three tones, lightest first.
 *
 * Fixed, and not inherited. The hues are the genes; the lightnesses are what
 * keep a flower legible as a flower — lit face, middle, shadow — however wild
 * its colours get. Let these vary and a cross could come out flat, or inside
 * out with its shadow brighter than its petals.
 */
const TONES = [0.82, 0.62, 0.42];

/**
 * How many recoloured flowers to keep.
 *
 * Breeding invents colours that have never existed before, so a long session
 * can meet a great many of them — and a cache that only ever grows is a slow
 * leak whatever the entries cost. A few hundred covers everything on screen and
 * everything in the drawer several times over; past that the oldest goes, and
 * if it is needed again it costs one redraw to get back.
 */
const CACHE_LIMIT = 400;

const cache = new Map();
let sheet = null;

/** Handed the loaded image once, at startup. */
export function useFlowerSheet(img) {
  sheet = img;
  cache.clear();
}

/**
 * The three colours a genome produces, lightest first — one per gene.
 *
 * A wild flower has all three hues alike and so comes out as one colour in
 * three shades. A bred one may have three different hues, which is what a
 * gardener's flower looks like and what nothing found in the grass ever does.
 */
export function palette(genome) {
  const sat = genome.sat / 100;
  return TONES.map((light, i) => hsl(
    genome.hues[i],
    i === 2 ? Math.min(1, sat + 0.05) : sat,
    light,
  ));
}

/** HSL to RGB, the short way. h in degrees, s and l as fractions. */
export function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const at = (n) => {
    const k = (n + (((h % 360) + 360) % 360) / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [at(0), at(8), at(4)];
}

/** A key that two identical flowers share and two different ones do not. */
const keyFor = (kind, g) => `${kind}:${g.hues.join('-')}:${g.sat}`;

/**
 * The canvas for one flower, recoloured and kept.
 * @returns {HTMLCanvasElement|null} null until the sheet has loaded
 */
export function flowerCanvas(kind, genome) {
  const def = FLOWERS[kind];
  if (!def || !sheet) return null;

  const key = keyFor(kind, genome);
  const had = cache.get(key);
  if (had) return had;

  const canvas = document.createElement('canvas');
  canvas.width = TILE;
  canvas.height = TILE;
  // willReadFrequently: this canvas exists to be read back once, like the soil
  // capsules in sprites.js.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sheet, def.sprite * TILE, 0, TILE, TILE, 0, 0, TILE, TILE);

  const image = ctx.getImageData(0, 0, TILE, TILE);
  const px = image.data;
  const colours = palette(genome);
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    for (let k = 0; k < KEYS.length; k++) {
      if (px[i] === KEYS[k][0] && px[i + 1] === KEYS[k][1] && px[i + 2] === KEYS[k][2]) {
        px[i] = colours[k][0];
        px[i + 1] = colours[k][1];
        px[i + 2] = colours[k][2];
        break;
      }
    }
  }
  ctx.putImageData(image, 0, 0);

  // Map keeps insertion order, so the first key out is the least recently made.
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, canvas);
  return canvas;
}

/** For the journal, which wants a picture it can put in an <img>. */
export function flowerDataUrl(kind, genome) {
  return flowerCanvas(kind, genome)?.toDataURL() || '';
}

/** Exported for the tests, and for anything that wants to know the cost. */
export function cacheSize() { return cache.size; }

export { CACHE_LIMIT };
