// Touch and mouse input for the world canvas.
//
// Gesture rules (kept deliberately simple, since disambiguation is the easiest
// thing to get wrong on a phone):
//   tap (no movement, short) -> onTap(tileX, tileY)
//   press on a movable thing -> pick it up and carry it (move tool only)
//   one finger drag          -> pan, or paint tasks when paint mode is on
//   two finger pinch         -> zoom, anchored at the midpoint
//   two finger drag          -> pan (works in either mode, so the player can
//                               always move the view without leaving paint mode)
// Pointer Events cover mouse, touch, and trackpad in one path.

const TAP_MOVE_TOLERANCE = 8;   // CSS px of slop still counted as a tap
const TAP_MAX_MS = 350;

/**
 * How close to the edge a carried thing has to be dragged before the view
 * follows, and how fast it goes. Without this you can only move something as
 * far as you can see, which on a phone is about eight tiles.
 */
const EDGE_MARGIN = 56;
const EDGE_SPEED = 6;

/**
 * @param {object} handlers
 * @param {(x:number,y:number)=>void} [handlers.onTap]
 * @param {(x:number,y:number)=>void} [handlers.onPaint] called for each tile a
 *   paint-drag passes over, never twice for the same tile in one stroke.
 * @param {()=>boolean} [handlers.isPaintMode]
 * @param {(x:number,y:number)=>boolean} [handlers.onGrab] returns true if there
 *   was something at this tile to pick up; if so the drag carries it instead of
 *   panning the view.
 * @param {(x:number,y:number)=>void} [handlers.onCarry]
 * @param {(x:number,y:number)=>void} [handlers.onDrop]
 */
export function attachInput(canvas, camera, {
  onTap, onPaint, isPaintMode, onGrab, onCarry, onDrop,
} = {}) {
  const pointers = new Map();
  let panning = false;
  let carrying = false;
  let edgeTimer = 0;
  let lastCarryPos = null;
  let pinchDist = 0;
  let pinchMid = { x: 0, y: 0 };
  let downAt = 0;
  let moved = 0;
  let painting = false;
  const paintedThisStroke = new Set();

  const localPos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, localPos(e));

    if (pointers.size === 1) {
      panning = true;
      downAt = performance.now();
      moved = 0;
      painting = !!(isPaintMode && isPaintMode());
      paintedThisStroke.clear();

      // Pressing on something movable picks it up. Pressing on bare ground
      // still pans, so the move tool never traps the view.
      const pos = localPos(e);
      const tile = camera.screenToTile(pos.x, pos.y);
      carrying = !!(onGrab && onGrab(tile.x, tile.y));
      if (carrying) { painting = false; startEdgeScroll(); }
    } else if (pointers.size === 2) {
      panning = false;      // a second finger cancels any pending tap
      painting = false;     // ...and any paint stroke, so pinch never paints
      const [a, b] = [...pointers.values()];
      pinchDist = dist(a, b);
      pinchMid = mid(a, b);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const pos = localPos(e);
    pointers.set(e.pointerId, pos);

    if (pointers.size === 1 && carrying) {
      lastCarryPos = pos;
      const tile = camera.screenToTile(pos.x, pos.y);
      onCarry?.(tile.x, tile.y);
    } else if (pointers.size === 1 && panning) {
      const dx = pos.x - prev.x;
      const dy = pos.y - prev.y;
      moved += Math.abs(dx) + Math.abs(dy);

      if (painting) {
        // Only start painting once the stroke is clearly a drag, so a tap in
        // paint mode still goes through the single-tile tap path.
        if (moved >= TAP_MOVE_TOLERANCE) paintAt(prev, pos);
      } else {
        camera.panBy(dx, dy);
      }
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = dist(a, b);
      const m = mid(a, b);
      if (pinchDist > 0) {
        camera.zoomAt(m.x, m.y, d / pinchDist);
        // Two-finger drag also pans, which feels natural alongside pinch.
        camera.panBy(m.x - pinchMid.x, m.y - pinchMid.y);
      }
      pinchDist = d;
      pinchMid = m;
    }
  });

  /**
   * Paints every tile between two pointer samples. A fast swipe can jump many
   * tiles between pointermove events, so sampling only the endpoint would leave
   * gaps in the painted row.
   */
  function paintAt(from, to) {
    if (!onPaint) return;
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 4));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const sx = from.x + (to.x - from.x) * t;
      const sy = from.y + (to.y - from.y) * t;
      const tile = camera.screenToTile(sx, sy);
      const key = `${tile.x},${tile.y}`;
      if (paintedThisStroke.has(key)) continue;
      paintedThisStroke.add(key);
      onPaint(tile.x, tile.y);
    }
  }

  const endPointer = (e) => {
    const pos = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);

    if (pointers.size === 0) {
      if (carrying) {
        stopEdgeScroll();
        if (pos) {
          const t = camera.screenToTile(pos.x, pos.y);
          onDrop?.(t.x, t.y);
        }
        carrying = false;
      } else {
        const quick = performance.now() - downAt < TAP_MAX_MS;
        if (panning && quick && moved < TAP_MOVE_TOLERANCE && pos && onTap) {
          const t = camera.screenToTile(pos.x, pos.y);
          onTap(t.x, t.y);
        }
      }
      panning = false;
      painting = false;
    } else if (pointers.size === 1) {
      // Lifting one finger of a pinch shouldn't jump the view.
      pinchDist = 0;
      panning = false;
      painting = false;
    }
  };

  /**
   * While something is being carried, holding it near an edge scrolls the view.
   *
   * On a timer rather than on pointermove: a finger held still at the edge
   * produces no move events, and that is exactly when the view most needs to
   * keep going.
   */
  function startEdgeScroll() {
    stopEdgeScroll();
    edgeTimer = setInterval(() => {
      // Stop rather than idle: a timer that outlives its drag would tick on
      // for the rest of the session, which is exactly the sort of thing that
      // keeps a phone awake.
      if (!carrying) { stopEdgeScroll(); return; }
      const pos = lastCarryPos;
      if (!pos) return;
      const r = canvas.getBoundingClientRect();
      let dx = 0;
      let dy = 0;
      if (pos.x < EDGE_MARGIN) dx = EDGE_SPEED;
      else if (pos.x > r.width - EDGE_MARGIN) dx = -EDGE_SPEED;
      if (pos.y < EDGE_MARGIN) dy = EDGE_SPEED;
      else if (pos.y > r.height - EDGE_MARGIN) dy = -EDGE_SPEED;
      if (!dx && !dy) return;

      camera.panBy(dx, dy);
      // The finger hasn't moved but the world under it has, so what's being
      // carried has to follow the tile now beneath it.
      const tile = camera.screenToTile(pos.x, pos.y);
      onCarry?.(tile.x, tile.y);
    }, 1000 / 30);
  }

  function stopEdgeScroll() {
    if (edgeTimer) clearInterval(edgeTimer);
    edgeTimer = 0;
    lastCarryPos = null;
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // Desktop convenience; harmless on touch devices.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = localPos(e);
    camera.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  // Safari fires these for pinch on the page; suppress so the whole UI doesn't zoom.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    canvas.addEventListener(type, (e) => e.preventDefault());
  }
}

function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
