// All tuning constants live here so balance changes never require hunting through logic.

export const TILE = 16;

// --- Simulation ---------------------------------------------------------
export const TICK_MS = 1000;            // one simulation tick = 1 second
export const MAX_CATCHUP_DAYS = 7;      // safety valve on offline catch-up
export const MAX_CATCHUP_TICKS = MAX_CATCHUP_DAYS * 24 * 60 * 60 * 1000 / TICK_MS;
export const CATCHUP_CHUNK = 20000;     // ticks per chunk before yielding to the browser

// --- Persistence --------------------------------------------------------
export const SAVE_KEY = 'lilfarm.save.v1';
export const SAVE_VERSION = 5;
export const AUTOSAVE_MIN_MS = 1000;    // never write more often than this
export const AUTOSAVE_MAX_MS = 10000;   // always write at least this often when dirty

// --- Animals ------------------------------------------------------------
//
// Colour variations per animal: the number of columns on assets/animals.png.
// This is only the fallback — the real count is read off the sheet when it
// loads (see setAnimalVariants), so adding a column to the image is all it
// takes to put a new colour in the game. It's here so the simulation has an
// answer when it runs headless, in tests and in the save migration.
export const ANIMAL_VARIANTS = 3;

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
//
// The world is a 3x3 grid of cells, each one a full 40x40 farm. You start
// owning the middle cell and buy the eight around it, so the map the player
// sees at the start is the whole map they used to get — expansion adds new
// country rather than subdividing what was already there.
export const CELL_W = 40;
export const CELL_H = 40;
export const CELLS_X = 3;
export const CELLS_Y = 3;

export const MAP_W = CELL_W * CELLS_X;
export const MAP_H = CELL_H * CELLS_Y;

// What each new cell of land costs: this many dollars times the number of cells
// already owned, so the second is one step and the ninth is eight. A cell is a
// whole 40x40 farm, so these are large numbers on purpose — $72,000 for the
// full valley. Guesswork until the economy has been played properly; a good
// eggplant field clears a few thousand an hour once it's running.
export const LAND_PRICE_STEP = 2000;

// Density of starting obstacles, as a fraction of map tiles.
export const GEN = {
  tree: 0.055,
  deadTree: 0.018,
  rock: 0.035,
  weed: 0.07,
  bush: 0.02,
  clearingRadius: 4,   // tiles around the farmer spawn kept clear
};

// --- Rendering ----------------------------------------------------------
//
// The simulation runs at 1Hz and the renderer interpolates between ticks, so
// there is nothing to gain from drawing at the display's refresh rate. Left
// uncapped this drew ~300 sprites 60 times a second — 120 on a ProMotion
// phone — to show a world that changes once a second, which is what made the
// device run hot. 30 is more than enough to keep a walking farmer smooth.
export const MAX_FPS = 30;

/**
 * Ceiling on the backing-store scale.
 *
 * The art is 16px pixel art drawn with smoothing off, so beyond 2x the extra
 * pixels buy nothing you can see — but they cost fill rate everywhere. At 3x
 * on a 393x852 phone that's 2.7 million pixels a frame instead of 1.2.
 */
export const MAX_DPR = 2;

// --- Camera -------------------------------------------------------------
// Lowered when the world became nine cells: at 2 you can see about a tenth of
// one cell, which makes crossing the valley a lot of dragging.
export const ZOOM_MIN = 1;
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
