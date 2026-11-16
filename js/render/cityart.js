// The road's autotile set, assembled from the city sheet's own pixels.
//
// The farm's dirt and water have a 13-piece set drawn for them: a nine-slice
// and four concave corners. The city sheet's road has no such set. What it has
// is a two-lane road drawn in a few fixed shapes — a straight, a bend, a
// junction — and in those shapes, every situation a kerb can be in appears at
// least once:
//
//   a straight kerb       (3,5), its top quarter
//   the outside of a bend (5,5), top-right quarter
//   the inside of a bend  (5,6), top-right quarter
//   plain asphalt         (3,5), the band below the kerb
//
// Those four quarters, mirrored and turned, are all thirteen pieces. The kerb is
// a dashed line two pixels in from the edge whose dashes are symmetric, so a
// mirrored kerb is indistinguishable from a drawn one. No pixel is repainted:
// every pixel of the output is a pixel of the sheet, moved.
//
// Pure arithmetic on RGBA arrays, so the tests can run it on the PNG itself.

const T = 16;
const H = T / 2;

/** Where each source quarter lives on the city sheet, in pixels. */
export const ROAD_SOURCES = {
  edge: { x: 3 * T, y: 5 * T },            // kerb along the top, top-left quarter
  outer: { x: 5 * T + H, y: 5 * T },       // outside corner, as the top-right
  inner: { x: 5 * T + H, y: 6 * T },       // inside corner, as the top-right
  plain: { x: 3 * T, y: 5 * T + 4 },       // eight rows of nothing but asphalt
};

/** The pieces, in the order they sit on the strip. */
export const ROAD_PIECES = ['TL', 'T', 'TR', 'L', 'C', 'R', 'BL', 'B', 'BR',
  'innerTL', 'innerTR', 'innerBL', 'innerBR'];

/**
 * How each quarter of each piece is made: which source, and how it is turned.
 *
 * `t` transposes (swaps x and y, turning a top kerb into a left one), then
 * `fx`/`fy` mirror. Only the quarters the autotiler actually reads are listed —
 * a TL piece is only ever asked for its top-left — and every other quarter is
 * plain asphalt, so the strip reads sensibly in the atlas viewer too.
 */
const RECIPES = {
  TL: { tl: ['outer', { fx: 1 }], tr: ['edge', { fx: 1 }], bl: ['edge', { t: 1 }] },
  T: { tl: ['edge', {}], tr: ['edge', { fx: 1 }] },
  TR: { tl: ['edge', {}], tr: ['outer', {}], br: ['edge', { t: 1, fx: 1, fy: 1 }] },
  L: { tl: ['edge', { t: 1 }], bl: ['edge', { t: 1, fy: 1 }] },
  C: {},
  R: { tr: ['edge', { t: 1, fx: 1 }], br: ['edge', { t: 1, fx: 1, fy: 1 }] },
  BL: { tl: ['edge', { t: 1 }], bl: ['outer', { fx: 1, fy: 1 }], br: ['edge', { fy: 1 }] },
  B: { bl: ['edge', { fy: 1 }], br: ['edge', { fx: 1, fy: 1 }] },
  BR: { tr: ['edge', { t: 1, fx: 1 }], br: ['outer', { fy: 1 }], bl: ['edge', { fy: 1 }] },
  innerTL: { tl: ['inner', { fx: 1 }] },
  innerTR: { tr: ['inner', {}] },
  innerBL: { bl: ['inner', { fx: 1, fy: 1 }] },
  innerBR: { br: ['inner', { fy: 1 }] },
};

const QUARTERS = { tl: [0, 0], tr: [H, 0], bl: [0, H], br: [H, H] };

/**
 * Builds the strip: thirteen 16px pieces in a row, in ROAD_PIECES order.
 *
 * Mirroring a quarter that is drawn as a top-right corner into the top-left
 * moves it with the mirror, which is why the recipes name the *source* turn
 * and the quarter it lands in separately.
 *
 * @param {Uint8Array|Uint8ClampedArray} src RGBA of the whole city sheet
 * @param {number} srcW the sheet's width in pixels
 * @returns {{width: number, height: number, rgba: Uint8ClampedArray}}
 */
export function buildRoadStrip(src, srcW) {
  const width = ROAD_PIECES.length * T;
  const out = new Uint8ClampedArray(width * T * 4);

  const copyQuarter = (source, turn, ox, oy) => {
    const s = ROAD_SOURCES[source];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < H; x++) {
        // Where in the source quarter this output pixel comes from.
        let u = turn.fx ? H - 1 - x : x;
        let v = turn.fy ? H - 1 - y : y;
        if (turn.t) [u, v] = [v, u];
        const si = ((s.y + v) * srcW + s.x + u) * 4;
        const di = ((oy + y) * width + ox + x) * 4;
        out[di] = src[si];
        out[di + 1] = src[si + 1];
        out[di + 2] = src[si + 2];
        out[di + 3] = src[si + 3];
      }
    }
  };

  ROAD_PIECES.forEach((key, i) => {
    const recipe = RECIPES[key];
    for (const [q, [qx, qy]] of Object.entries(QUARTERS)) {
      const [source, turn] = recipe[q] || ['plain', {}];
      copyQuarter(source, turn, i * T + qx, qy);
    }
  });

  return { width, height: T, rgba: out };
}
