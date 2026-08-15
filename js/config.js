// All tuning constants live here so balance changes never require hunting through logic.

export const TILE = 16;

// --- Simulation ---------------------------------------------------------
export const TICK_MS = 1000;            // one simulation tick = 1 second
export const MAX_CATCHUP_DAYS = 7;      // safety valve on offline catch-up
export const MAX_CATCHUP_TICKS = MAX_CATCHUP_DAYS * 24 * 60 * 60 * 1000 / TICK_MS;
export const CATCHUP_CHUNK = 20000;     // ticks per chunk before yielding to the browser

// --- Persistence --------------------------------------------------------
export const SAVE_KEY = 'lilfarm.save.v1';
export const SAVE_VERSION = 2;
export const AUTOSAVE_MIN_MS = 1000;    // never write more often than this
export const AUTOSAVE_MAX_MS = 10000;   // always write at least this often when dirty

// --- The farmer ---------------------------------------------------------
// Tiles walked per tick. The renderer interpolates along every tile stepped
// through, so raising this speeds travel up without making movement look like
// teleporting. Work durations are separate and unaffected.
export const FARMER_SPEED = 3;

// --- Starting resources -------------------------------------------------
//
// TESTING hands a new farm enough of everything to reach any part of the game
// immediately. It is off for anyone actually playing: the real starting kit is
// deliberately meagre, and skipping that is skipping the early game. Flip it on
// to test something deep in the game without farming your way there first —
// the settings panel says loudly when it's on.
export const TESTING = false;

const REAL_START = {
  money: 50,
  inventory: { carrot_seed: 6, wheat_seed: 4 },
};

const TESTING_START = {
  money: 2000,
  inventory: {
    wood: 500, stone: 300, fiber: 50,
    carrot_seed: 25, wheat_seed: 25, corn_seed: 25,
    tomato_seed: 25, cabbage_seed: 25, eggplant_seed: 25,
  },
};

export const START_MONEY = TESTING ? TESTING_START.money : REAL_START.money;
export const START_INVENTORY = TESTING ? TESTING_START.inventory : REAL_START.inventory;

// --- World --------------------------------------------------------------
export const MAP_W = 40;
export const MAP_H = 40;

// What each new plot of land costs: this many dollars times the number of
// plots already owned, so the second plot is one step and the last is
// twenty-four. Guesswork until the economy has been played properly — a good
// eggplant field clears a few hundred an hour, so the first plot should be a
// couple of decent harvests away and the far corners of the map a long game.
export const LAND_PRICE_STEP = 250;

// Density of starting obstacles, as a fraction of map tiles.
export const GEN = {
  tree: 0.055,
  deadTree: 0.018,
  rock: 0.035,
  weed: 0.07,
  bush: 0.02,
  clearingRadius: 4,   // tiles around the farmer spawn kept clear
};

// --- Camera -------------------------------------------------------------
export const ZOOM_MIN = 2;
export const ZOOM_MAX = 6;
export const ZOOM_DEFAULT = 3;

// --- Colors (sampled from the tilesheet so procedural fills match art) ---
export const COLORS = {
  grass: '#84c669',
  grassDark: '#6bb356',
  dirt: '#cf8254',
  dirtDark: '#b86542',
  sky: '#5b8c4a',
};
