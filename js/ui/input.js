// Touch and mouse input for the world canvas.
//
// Gesture rules (kept deliberately simple, since disambiguation is the easiest
// thing to get wrong on a phone):
//   tap (no movement, short) -> onTap(tileX, tileY)
//   one finger drag          -> pan, or paint tasks when paint mode is on
//   two finger pinch         -> zoom, anchored at the midpoint
//   two finger drag          -> pan (works in either mode, so the player can
//                               always move the view without leaving paint mode)
// Pointer Events cover mouse, touch, and trackpad in one path.

const TAP_MOVE_TOLERANCE = 8;   // CSS px of slop still counted as a tap
const TAP_MAX_MS = 350;

/**
 * @param {object} handlers
 * @param {(x:number,y:number)=>void} [handlers.onTap]
 * @param {(x:number,y:number)=>void} [handlers.onPaint] called for each tile a
 *   paint-drag passes over, never twice for the same tile in one stroke.
 * @param {()=>boolean} [handlers.isPaintMode]
 */
export function attachInput(canvas, camera, { onTap, onPaint, isPaintMode } = {}) {
  const pointers = new Map();
  let panning = false;
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

    if (pointers.size === 1 && panning) {
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
      const quick = performance.now() - downAt < TAP_MAX_MS;
      if (panning && quick && moved < TAP_MOVE_TOLERANCE && pos && onTap) {
        const t = camera.screenToTile(pos.x, pos.y);
        onTap(t.x, t.y);
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
