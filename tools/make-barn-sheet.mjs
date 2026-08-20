// Builds assets/barn.png: `node tools/make-barn-sheet.mjs`
//
// The barn art lives scattered across two corners of tilemap_packed.png, and
// that sheet is completely full — 12x11 with not one blank cell — so there is
// nowhere to draw the pieces a wider roof needs. This gathers the barn into a
// sheet of its own, laid out by what each piece *is*, with room to grow.
//
// Everything here is copied pixel-for-pixel from the original except the eight
// drafts on the right, which are stitched together out of the original's own
// pixels (see below). They are meant to be painted over, not kept.
//
// LAYOUT (16px tiles)
//
//        c0       c1        c2   |  c4      c5       c6    |  c8      c9      c10     c11
//   r0    ·      apex        ·   |   ·       ·        ·    | fillD   fillL   topD    topL
//   r1  slopeL  ridgeTop  slopeR | braceL  braceM  braceR  | botD    botL   topRidge botRidge
//   r2  planeL  ridge     planeR | plankL  plankM  plankR  |
//   r3  notchL  notch     notchR | plank2L plank2M plank2R |
//   r4  eaveL     ·       eaveR  | doorBig door    window  |
//   r5..r7                    free space
//
// Left of the divide is the roof, read top to bottom as it is drawn; right of
// it is the wall, likewise. Both are Kenney's, unchanged.
//
// THE SHAPE THESE BUILD
//
// A flat top, corners cut away at 45 degrees, then vertical sides — the roof
// of a round-shouldered barn, in four folds. Every one of those edges already
// existed: slopeL and slopeR step exactly one tile across per tile up, so a
// corner of any depth is the same tile placed again a row lower, and planeL
// and planeR carry the barge boards down the sides. What the original had no
// piece for was a *straight* edge, top or bottom, because a gable never needs
// one. That is what the drafts are.
//
// The virtue of the shape is that it does not care how wide the barn is. A
// gable climbs a row for every tile of width, so a nine-wide one hangs five
// rows up the screen over ground the farmer still walks on; this stays at two.
//
// THE DRAFTS, and how they were made:
//   fillD/fillL  a clean 16px window of plane with no border in it, taken from
//                the run of flat colour that spans planeL into ridge (and
//                ridge into planeR). Real fill tiles, just without new speckles.
//   topD/topL    fill with the roof's far edge laid along the top.
//   botD/botL    fill with the roof's near edge laid along the bottom.
//   topRidge     the same edges across the ridge tile, so the roof's dark/light
//   botRidge     split stays under the board on the rows that carry an edge.
//
// The two planes are shaded differently in the original and the drafts keep
// that: the dark plane takes a 1px light highlight inside its border, the
// light plane takes a 3px shadow. Compare slopeL against slopeR to see it.

import { writeFileSync } from 'node:fs';
import { decodePng, encodePng } from './png.mjs';

const TILE = 16;
const COLS = 12;
const ROWS = 8;

/** The sheet's palette, sampled from the barn itself. */
const OUTLINE = [0x3f, 0x26, 0x31, 255];
const PLANE_DARK = [0x4e, 0x97, 0x4c, 255];    // left of the ridge
const PLANE_LIGHT = [0x84, 0xc6, 0x69, 255];   // right of the ridge

const source = decodePng('assets/tilemap_packed.png');
const src = source;
const src_w = source.width;
const out = Buffer.alloc(COLS * TILE * ROWS * TILE * 4);   // transparent

const W = COLS * TILE;

/**
 * Copies a tile-sized window out of the source sheet. The source is in pixels
 * (the fills below deliberately start mid-tile); the destination is in tiles.
 */
function copy(sx, sy, dc, dr, w = TILE, h = TILE) {
  const dx = dc * TILE;
  const dy = dr * TILE;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((sy + y) * src.width + (sx + x)) * 4;
      const d = ((dy + y) * W + (dx + x)) * 4;
      src.rgba.copy(out, d, s, s + 4);
    }
  }
}

/** Copies one whole tile, by tile coordinates on each side. */
const tile = (sc, sr, dc, dr) => copy(sc * TILE, sr * TILE, dc, dr);

/** Paints a horizontal band across a tile. */
function band(dc, dr, y0, y1, colour) {
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < TILE; x++) {
      out.set(colour, ((dr * TILE + y) * W + dc * TILE + x) * 4);
    }
  }
}

// --- the roof, as it is drawn -------------------------------------------

tile(10, 6, 1, 0);                                   // apex
[9, 10, 11].forEach((c, i) => {
  tile(c, 7, i, 1);                                  // slope row
  tile(c, 8, i, 2);                                  // plane row (repeats)
  tile(c, 9, i, 3);                                  // notch row
});
tile(9, 10, 0, 4);                                   // eave corners; the middle
tile(11, 10, 2, 4);                                  // of that row is empty

// --- the walls ----------------------------------------------------------

[7, 8, 9, 10].forEach((r, i) => {
  [6, 7, 8].forEach((c, j) => tile(c, r, 4 + j, 1 + i));
});

// --- drafts: the pieces a wider roof needs ------------------------------
//
// The fills are windows of flat colour that happen to span a tile boundary.
// planeL's border ends at x=2 and ridge's board starts at x=7, so x=147 gives
// 16 clean pixels of dark; the same trick on the other side of the ridge gives
// the light one. Nothing is invented — these are the sheet's own pixels.

copy(9 * TILE + 3, 8 * TILE, 8, 0);                  // fillD
copy(10 * TILE + 9, 8 * TILE, 9, 0);                 // fillL
copy(9 * TILE + 3, 8 * TILE, 10, 0);                 // topD  \  fills, about
copy(10 * TILE + 9, 8 * TILE, 11, 0);                // topL  /  to get an edge
copy(9 * TILE + 3, 8 * TILE, 8, 1);                  // botD
copy(10 * TILE + 9, 8 * TILE, 9, 1);                 // botL
tile(10, 8, 10, 1);                                  // topRidge (the ridge tile)
tile(10, 8, 11, 1);                                  // botRidge (likewise)

// The far edge: 2px of outline, and on the dark plane a 1px highlight inside
// it. The light plane meets its border with nothing in between — that is how
// slopeR is drawn, and copying it keeps the two roof faces reading as one roof
// lit from one side.
band(10, 0, 0, 1, OUTLINE);
band(10, 0, 2, 2, PLANE_LIGHT);                      // highlight on dark plane
band(11, 0, 0, 1, OUTLINE);

// The near edge, mirrored: the eaves overhang, so the light plane picks up a
// 3px shadow under its lip where the dark plane picks up a highlight.
band(8, 1, 13, 13, PLANE_LIGHT);
band(8, 1, 14, 15, OUTLINE);
band(9, 1, 11, 13, PLANE_DARK);                      // shadow on light plane
band(9, 1, 14, 15, OUTLINE);

// The ridge tile needs both edges too, or the roof's dark/light split steps
// half a tile sideways at the row where the ridge board stops — which is
// exactly the kind of thing the eye catches immediately.
//
// The accents follow each half: highlight on the dark side, shadow on the
// light one, same as botD and botL. The board itself is put back afterwards,
// since it runs to the roof's edge rather than being cut by it.
band(10, 1, 0, 1, OUTLINE);                          // topRidge: far edge
for (let x = 0; x < 8; x++) out.set(PLANE_LIGHT, ((1 * TILE + 2) * W + 10 * TILE + x) * 4);

band(11, 1, 14, 15, OUTLINE);                        // botRidge: near edge
for (let x = 0; x < 8; x++) out.set(PLANE_LIGHT, ((1 * TILE + 13) * W + 11 * TILE + x) * 4);
for (let y = 11; y <= 13; y++) {
  for (let x = 8; x < TILE; x++) out.set(PLANE_DARK, ((1 * TILE + y) * W + 11 * TILE + x) * 4);
}
for (const [dc, y0, y1] of [[10, 2, 15], [11, 0, 13]]) {   // put the board back
  for (let y = y0; y <= y1; y++) {
    for (let x = 7; x <= 8; x++) {
      const src = ((8 * TILE + y) * src_w + 10 * TILE + x) * 4;
      out.set(source.rgba.subarray(src, src + 4), ((1 * TILE + y) * W + dc * TILE + x) * 4);
    }
  }
}

writeFileSync('assets/barn.png', encodePng(COLS * TILE, ROWS * TILE, out));
console.log(`wrote assets/barn.png (${COLS}x${ROWS} tiles, ${COLS * TILE}x${ROWS * TILE}px)`);
