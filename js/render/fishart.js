// Fish, and the shadows they cast.
//
// A fish under water is the same sprite with every colour taken out of it —
// one flat dark shape, because that is what you see looking down into a pond.
// Reading pixels back is far too slow to do while drawing, so each silhouette
// is made once when the sheet loads and every draw after that is an ordinary
// blit. The renderer never learns anything unusual is happening.
//
// There are fourteen of them and they are 16x16, so the whole set is a few
// kilobytes. No eviction, no bookkeeping — unlike the flowers, which invent
// new colours as they breed, the fish are a fixed list.

import { TILE } from '../config.js';

/**
 * The colour a shadow is painted in.
 *
 * Not pure black: a shadow with a little of the pond's blue in it sits *in* the
 * water rather than on top of it. How faint it ends up is set where it is
 * drawn, not here — see SHADOW_ALPHA.
 */
const SHADOW = [16, 34, 56];

/** How faint. Low enough to be under the surface, dark enough to spot. */
export const SHADOW_ALPHA = 0.42;

/**
 * Below this luminance a pixel is the sprite's outline rather than the fish.
 *
 * These sprites are drawn with a heavy two-pixel border, and it is most of
 * them: measured, between 62% and 67% of every fish's opaque pixels are that
 * dark edge. Silhouetting the whole sprite therefore produces a fat rounded
 * blob with a fish somewhere inside it, which is what the first attempt looked
 * like in the water — an object floating on the pond rather than a shape under
 * it. Taking the outline out leaves the fish's own body, which is the shape a
 * shadow should be.
 */
const OUTLINE_MAX = 72;

let shadows = [];

/**
 * Builds a silhouette per fish from the aquatic sheet.
 *
 * Called once when the sheets load, because reading pixels back is far too slow
 * to do while drawing. Every body pixel becomes the same flat colour — a shadow
 * has no markings, and keeping the fish's own colours was the other half of why
 * the first attempt read as a fish sitting on the water.
 */
export function useAquaticSheet(img) {
  const rows = Math.round(img.height / TILE);
  shadows = [];

  const scratch = document.createElement('canvas');
  scratch.width = TILE;
  scratch.height = TILE;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });

  for (let i = 0; i < rows; i++) {
    sctx.clearRect(0, 0, TILE, TILE);
    sctx.drawImage(img, 0, i * TILE, TILE, TILE, 0, 0, TILE, TILE);
    const px = sctx.getImageData(0, 0, TILE, TILE);
    const d = px.data;

    for (let p = 0; p < d.length; p += 4) {
      const lum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      if (d[p + 3] === 0 || lum < OUTLINE_MAX) {
        d[p + 3] = 0;                       // transparent: outline, or nothing
        continue;
      }
      [d[p], d[p + 1], d[p + 2]] = SHADOW;
      d[p + 3] = 255;
    }

    const c = document.createElement('canvas');
    c.width = TILE;
    c.height = TILE;
    c.getContext('2d').putImageData(px, 0, 0);
    shadows.push(c);
  }
}

/** The silhouette for a sprite row, or null before the sheets have loaded. */
export function shadowFor(sprite) {
  return shadows[sprite] || null;
}

/** How many silhouettes exist — the drift-guard's way of asking. */
export function shadowCount() { return shadows.length; }
