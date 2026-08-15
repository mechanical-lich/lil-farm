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
export function suspend() { suspended = true; }
export function resume() { suspended = false; }

/**
 * While suspended, events can still be *counted* even though nobody is
 * listening. That's how the "while you were away" summary is built: replaying
 * two days would fire thousands of toasts, but tallying integers costs nothing,
 * and the simulation stays entirely unaware that anyone is watching.
 *
 * @type {{counts: Record<string, number>, items: Record<string, number>}|null}
 */
let tally = null;

export function startTally() {
  tally = { counts: {}, items: {} };
}

/** Stops counting and hands back what was seen. */
export function stopTally() {
  const result = tally;
  tally = null;
  return result;
}

function record(name, payload) {
  tally.counts[name] = (tally.counts[name] || 0) + 1;

  // Tasks are the interesting ones: count them by kind, and add up anything
  // they put in the bag so the summary can say "+12 corn" rather than just
  // "8 tasks done".
  if (name === 'task:done' && payload) {
    const type = payload.task?.type;
    if (type) tally.counts[`task:${type}`] = (tally.counts[`task:${type}`] || 0) + 1;
    for (const [id, n] of Object.entries(payload.gained || {})) {
      tally.items[id] = (tally.items[id] || 0) + n;
    }
  }
}

export function emitUnlessSuspended(name, payload) {
  if (!suspended) {
    emit(name, payload);
    return;
  }
  if (tally) record(name, payload);
}
