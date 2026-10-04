// The heavy dark outline every sprite on the flower and mushroom sheets wears,
// as a rule rather than as pixels.
//
// Measured against the artist's own sprites: an empty pixel is outline when a
// coloured one is within two of it, except at the four diagonal corners at
// exactly two. That reproduces the sunflower, the daisy and every hand-drawn
// mushroom cap pixel for pixel, so a sprite drawn here as text wears the same
// line as one drawn by hand — which is most of what makes it look like it
// belongs on the sheet.
//
// The one thing it means for drawing: any gap narrower than about four pixels
// fills in with outline.

/**
 * Whether the empty pixel at x,y is outline.
 * @param {(x: number, y: number) => boolean} inside  is there colour here?
 */
export function isOutline(inside, x, y) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (Math.abs(dx) === 2 && Math.abs(dy) === 2) continue;   // round the corners
      if (inside(x + dx, y + dy)) return true;
    }
  }
  return false;
}
