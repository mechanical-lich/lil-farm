// Seeded PRNG (mulberry32). The simulation must never call Math.random():
// offline catch-up replays ticks, and only a serializable generator makes that
// replay deterministic and bugs reproducible.

export function makeRng(seed) {
  let state = seed >>> 0;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    range: (min, maxExclusive) => min + Math.floor(next() * (maxExclusive - min)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    getState: () => state >>> 0,
    setState: (s) => { state = s >>> 0; },
  };
}

// Stable hash for "random-looking but fixed" per-tile decor. Not part of sim
// state, so it stays identical across sessions without being saved.
export function hash2d(x, y) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
