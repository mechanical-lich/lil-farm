// Preferences: the handful of choices that belong to the person, not the farm.
//
// Deliberately kept in their own localStorage key rather than in the save. A
// preference is about this phone and whoever is holding it — it should survive
// starting a new farm, and importing somebody else's backup should not silently
// change how the game looks.
//
// Everything degrades to the default rather than throwing. Safari in private
// mode refuses localStorage outright, and no preference is worth a white
// screen.

const PREFS_KEY = 'lilfarm.prefs';

const DEFAULTS = {
  // Labels on the tool buttons. On a small phone the bar scrolls sideways, and
  // dropping to icons alone fits every tool on screen at once.
  toolLabels: true,
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function getPref(key) {
  const prefs = load();
  return key in prefs ? prefs[key] : DEFAULTS[key];
}

export function setPref(key, value) {
  const prefs = load();
  prefs[key] = value;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not fatal: the choice holds for this session and is forgotten later.
  }
  return value;
}

/** Test seam: forget what was read, so the next get goes back to storage. */
export function forgetPrefs() { cache = null; }
