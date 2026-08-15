// Tiny pub/sub. This is the only channel the simulation uses to talk outward,
// which is what keeps sim/ headless and therefore replayable during catch-up.

const listeners = new Map();

export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => off(name, fn);
}

export function off(name, fn) {
  const set = listeners.get(name);
  if (set) set.delete(fn);
}

export function emit(name, payload) {
  const set = listeners.get(name);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`listener for "${name}" threw`, err);
    }
  }
}

// During offline catch-up we replay thousands of ticks; firing UI events for
// each one is pointless work. Suspend, replay, then resume with one refresh.
let suspended = false;
export function isSuspended() { return suspended; }
export function suspend() { suspended = true; }
export function resume() { suspended = false; }

export function emitUnlessSuspended(name, payload) {
  if (!suspended) emit(name, payload);
}
