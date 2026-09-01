// Short-lived things drawn over the world: at present, a landed fish.
//
// Everything else the renderer draws is a picture of the simulation, and a
// still farm draws no frames at all — the frame key is keyed on the tick, so
// nothing moves between ticks unless somebody is walking. That is exactly wrong
// for a catch. A tick is a whole second and the fish should come out of the
// water in rather less, so this runs on the wall clock instead and tells the
// renderer to keep drawing while it does.
//
// Deliberately outside the simulation. Nothing here is saved, nothing here is
// replayed during catch-up, and a farm that has been away for a week does not
// come back to a screen full of fish flying about — the events that start these
// are suppressed while the world is fast-forwarded.

import { TILE } from '../config.js';

/**
 * Effects keep their own clock, and every one of them reads it from here.
 *
 * They used to be handed the time by their callers, which was one clock too
 * many: the catch was stamped with performance.now() (milliseconds since the
 * page loaded) and compared against the renderer's Date.now() (milliseconds
 * since 1970). The difference is about seventeen hundred billion, so every
 * effect was already expired before its first frame and the animation simply
 * never appeared. One source, no arguments, no way to get it wrong.
 */
const clock = () => Date.now();

/** How long a fish takes to come out of the water and into the bag. */
const CATCH_MS = 700;

/** How high it arcs on the way. Enough to read as a lift, not a launch. */
const ARC = 10;

const catches = [];

/**
 * A fish on its way from the water to the farmer.
 *
 * Coordinates are tiles; the draw works in world pixels like everything else
 * inside the camera transform.
 */
export function addCatch({ fromX, fromY, toX, toY, sprite }) {
  catches.push({ fromX, fromY, toX, toY, sprite, start: clock() });
}

/** Is anything still in flight? The renderer asks before deciding to skip. */
export function anyEffects() {
  const now = clock();
  return catches.some((c) => now - c.start < CATCH_MS);
}

/** Thrown away when the player is not looking, so nothing piles up unseen. */
export function clearEffects() { catches.length = 0; }

export function drawEffects(ctx, sheets) {
  const now = clock();
  for (let i = catches.length - 1; i >= 0; i--) {
    const c = catches[i];
    const t = (now - c.start) / CATCH_MS;
    if (t >= 1) { catches.splice(i, 1); continue; }

    // Ease out: it leaves the water quickly and slows as it reaches the hand,
    // which reads as being pulled rather than thrown.
    const e = 1 - (1 - t) * (1 - t);
    const x = (c.fromX + (c.toX - c.fromX) * e) * TILE;
    const y = (c.fromY + (c.toY - c.fromY) * e) * TILE - Math.sin(t * Math.PI) * ARC;

    const sheet = sheets.aquatic;
    if (!sheet) continue;
    ctx.save();
    // Fades only at the very end, so it is a fish for almost all of the flight
    // and not a ghost for half of it.
    ctx.globalAlpha = t > 0.8 ? (1 - t) / 0.2 : 1;
    ctx.drawImage(sheet, 0, c.sprite * TILE, TILE, TILE, Math.round(x), Math.round(y), TILE, TILE);
    ctx.restore();
  }
}

/**
 * The line from the farmer to the water while he is working a fish.
 *
 * Drawn from the simulation rather than kept here: it lasts exactly as long as
 * the task does, so there is nothing to time and nothing to clean up.
 */
export function drawCastLine(ctx, state) {
  const f = state.farmer;
  if (f.taskId == null) return;
  const task = (state.tasks || []).find((t) => t.id === f.taskId);
  if (!task || task.type !== 'fish') return;

  // Only once he is actually fishing. taskId is set when he *claims* the job,
  // which is the moment he sets off — drawing on that alone had a line
  // stretching across the farm from a walking farmer to a pond he had not
  // reached. Progress is the honest test: it only advances from doWork, and
  // doWork only runs once he is standing where the task told him to stand.
  if ((task.progress || 0) <= 0) return;

  const hand = (f.x + 0.5) * TILE;
  const handY = (f.y + 0.4) * TILE;
  const spot = (task.x + 0.5) * TILE;
  const spotY = (task.y + 0.5) * TILE;

  ctx.save();
  ctx.strokeStyle = 'rgba(240, 240, 230, 0.75)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(hand, handY);
  // A slack line rather than a taut one: the dip is what makes it read as
  // string instead of a drawn ruler.
  ctx.quadraticCurveTo((hand + spot) / 2, Math.max(handY, spotY) + 4, spot, spotY);
  ctx.stroke();

  // The float, bobbing on the tick so the water looks like it is doing
  // something even while the farmer stands still.
  const bob = Math.sin(state.tickCount / 2) > 0 ? 0 : 1;
  ctx.fillStyle = '#e8503a';
  ctx.fillRect(Math.round(spot) - 1, Math.round(spotY) - 1 + bob, 2, 2);
  ctx.restore();
}
