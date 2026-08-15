# Lil Farm — Development Plan

Companion to [design.md](design.md). This is the implementation plan for building Lil Farm:
a client-only, mobile-first HTML5 farming game in **raw JavaScript** (no frameworks, no
build step), with state persisted to `localStorage` and offline "catch-up" simulation.

Target device: iPhone 15 Safari (393×852 CSS px, 3x DPR). Must also work fine on desktop
for development.

---

## Progress

- **M0 — complete.** Renderer, camera, gestures, fixed-tick loop, save/load, and
  offline catch-up all working and verified on a 393×852 (iPhone 15) viewport.
- **M1 — complete.** Farmer with A* pathfinding, the task queue (cancel /
  bump-to-top / retry-unreachable), clearing land, and inventory.
- **M2 — complete.** Till, plant, water, harvest; six crops with growth stages,
  the watering rule, dead crops, and drag-to-paint over a field.
- **M3 — complete.** Shop with buy/sell, a rotating seed selection, materials,
  and a full balance pass across every crop.
- **M4 — complete.** Build tool with fences, gates, roads and two-tile troughs;
  materials checked against the queue and spent on completion.
- **Demolition — complete.** Anything built can be cleared again for half its
  materials back; see design.md. Closes the gap where a misplaced fence was
  permanent.
- **Assets — both sheets in use.** The town sheet supplies real grass, nine-slice
  dirt, cobblestone paving, proper fences with corners, and fuller trees.
- **Barns — complete.** Multi-tile buildings with ghost-preview placement,
  3x2 footprint, overhanging roof, and animal capacity.
- **M5 — complete.** Cows and chickens: free-range wandering, trough seeking,
  production gated on food and water, and the never-die rule.
- **PWA — complete.** Installable to the home screen, works offline, icons
  generated from the game's own art. See [deploying.md](deploying.md).
- **Away summary — complete.** Returning shows what happened and what needs
  attention. Built by *tallying* events during catch-up rather than dispatching
  them (`startTally` / `stopTally` in `engine/events.js`), so replaying two days
  costs a few integer increments and the simulation stays unaware anyone is
  watching.
- **Next: M6 remainder** — save export/import, land expansion.

**Planned: a Settings panel.** Save export/import belongs in a general settings
menu rather than bolted onto the shop, alongside the debug/cheat switches that
currently only exist on `window.lilfarm` (`give`, `wipe`) and the `TESTING` flag.
Build the panel when export/import lands, and move those in.

135 headless tests pass via `npm test`.

Tilling is a two-point row gesture and beds are drawn with the capsule art — see
section 8. Adjacent rows stay visually separate rather than merging into a grid.
The clear tool undoes an empty bed back to grass (task type `untill`), but refuses
a bed with a crop in it.

**Movers are drawn inside the object pass, not after it.** `entitiesByRow()` buckets
the farmer and animals by tile row, and `drawObjects` paints each row's movers right
after that row's scenery. That's what stops an NPC standing on a barn's roof-overhang
tiles from appearing to walk across the roof — on those rows they're drawn *before*
the barn and end up behind it. Characters on the sheet all face right, so `blit()`
takes a `flip` argument and each mover carries a `facing` updated only on horizontal
movement.

**The bottom UI rows must keep `pointer-events: auto`.** `#ui` is
`pointer-events: none` so the map shows through it, and for a long time only the
*buttons* inside were re-enabled. That broke two things visible only on a touch
device: the horizontally scrolling rows couldn't be the target of a drag, so they
never scrolled on iPhone; and a tap landing in the 6px gap between two buttons
fell through to the canvas and did farm work. The rows also declare
`touch-action: pan-x` so a horizontal drag is unambiguously a scroll.

Panels (`shop` / `tasks` / `bag`) coordinate through `panel:open`, `panel:close` and
`panel:dismiss` events rather than holding references to each other. Opening one
resets the tool to `auto`, closes the sub-picker, and clears any pending placement;
while one is open a map tap dismisses it instead of doing farm work. This exists
because a panel covers only part of the screen, so leaving Build armed behind it let
a stray tap on the visible strip queue work the player never intended.

Farmer travel speed is `FARMER_SPEED` in `config.js` (tiles walked per tick,
currently 3). Work durations are separate and unaffected by it.

Run it with `python3 -m http.server 8145` and open `/index.html`. `window.lilfarm`
exposes `state`, `camera`, `save()`, `wipe()`, and `give()` for poking at a live farm.

> ⚠ **`TESTING` in `config.js` is currently `true`**, which starts a new farm with
> $2000, 500 wood, 300 stone and 25 of every seed so any part of the game is
> reachable immediately. **Set it to `false` before a real player touches this** —
> the honest starting kit is $50 and ten seeds, and the early game is most of the
> game right now. While it's on, the debug line reads `⚠ TESTING START`.
>
> `lilfarm.give()` tops up a farm already in progress (`give({wood: 200})`, or
> `give({}, 500)` for money) without wiping what you were testing on.

**Deploying:** see [deploying.md](deploying.md). Everything is relative so the
game runs from a GitHub Pages subpath; the two things to remember before a
deploy are turning `TESTING` off and bumping `CACHE_VERSION` in `sw.js`.

### Tilesheet notes (don't rediscover these)

There are **two** Kenney sheets, each 12x11 tiles of 16px, and they share a palette
(`#84c669` grass, `#eaa56c` dirt) so tiles from both sit together seamlessly:

- `assets/tilemap_packed.png` (**'farm'**) — crops, tilled-soil capsules, animals,
  barn pieces, troughs, the farmer.
- `assets/town_tilemap_packed.png` (**'town'**) — grass, dirt, paving, fences, trees.

A sprite reference is `[col, row]` for the farm sheet or `[col, row, 'town']` for the
town sheet; `blit()` resolves which image to use. Town-sheet coordinates live in the
`TOWN` map in `render/sprites.js`.

`tools/atlas-viewer.html` draws a sheet magnified with col/row labels — append
`?sheet=town` for the second one. Use it whenever a sprite looks wrong.

**Ground (town sheet), verified pixel by pixel:**

- `(0,0)` is 100% grass with no decoration; `(1,0)` and `(2,0)` are the same grass with
  clumps and flowers. Scattered deterministically by `hash2d`.
- Dirt is a true 3x3 nine-slice at `(0,1)`–`(2,3)`. `(1,2)` is 100% dirt with no edges
  (the interior); the ring around it carries the grass boundary. `ninePiece()` picks the
  piece from a tile's four orthogonal neighbours, so a cleared patch gets a proper grassy
  edge instead of a hard square.
- `(7,3)` is cobblestone paving, used for `GROUND.ROAD`.

**Fences (town sheet)** are a complete set: straight runs with end posts
(`(8,6)`–`(10,6)` horizontal, `(11,3)`–`(11,5)` vertical) plus a nine-slice enclosure
whose four corners are at `(8,3)`, `(10,3)`, `(8,5)`, `(10,5)`. `fencePiece()` picks from
all four neighbours so pens turn corners properly. There is **no gate sprite on either
sheet** — a closed gate draws its fence piece plus a small pale latch, and draws nothing
at all while the farmer is on it, which reads as swung open.

**Farm sheet gotchas:**

- **Tilled beds use the farm sheet's capsule set**, which is a rows-only autotile: rounded
  end caps and straight middles, with **no inner or outer corners**. That is why tilling
  is a row operation (section 8). Vertical pieces are rows 0–3 with moisture by *column*
  (col 0 dry, col 1 wet): r0 single, r1 top cap, r2 middle, r3 bottom cap. Horizontal
  pieces are rows 4–5 with moisture by *row* (row 4 wet, row 5 dry): c0 left cap, c1
  middle, c2 right cap, c3 single.
- The capsule art is **not centred in its tile** — the dirt sits flush to one edge with a
  few pixels of grass on the other. That is what produces the gap between stacked rows, so
  don't "fix" it. Its grass background is colour-keyed to transparency at boot
  (`CAPSULES`), so a bed sits correctly on any ground.
- **Crop rows** read left-to-right in cols 4–8 of rows 0–5, but there are only *three*
  growth stages: col 4 seedling, col 5 young, col 6 ripe. **Col 7 is the withered/dead
  version of the same plant, not a fourth growth stage.** Col 8 is the harvested item
  icon, col 9 the seed packet, col 11 a crate. One crop per row: carrot, eggplant, corn,
  tomato, cabbage, wheat.
- Farm sheet `(6,7)`–`(8,7)` look like fence panels but are **barn siding** — the barn
  occupies cols 6–8 rows 7–10 with its roof at cols 9–11. Use the town fences instead.
- Farm sheet `(5,6)` and `(5,7)` really are rocks (grey boulders), despite looking
  tool-shaped at small sizes.
- `DERIVED.dirt` still exists in `sprites.js` but is now unused by the ground layer; the
  town sheet's real dirt replaced it.

## 0. Ground rules

- **No third-party libraries.** No npm dependencies, no bundler. Plain ES modules
  (`<script type="module">`) served as static files. `python3 -m http.server` (or any
  static server) is the dev workflow.
- **Many small files.** One module per concern (see file layout below). No file should
  grow past ~300 lines without a good reason.
- **Client only.** All state in `localStorage` (not cookies — cookies are size-limited to
  ~4KB and sent nowhere useful here; localStorage gives us ~5MB). One save slot to start.
- **Everything renders to a single `<canvas>`** for the world; game UI (task queue,
  inventory, shop) is HTML/CSS overlaid on top — far easier to make touch-friendly than
  canvas-drawn UI.

## 1. Core architectural decision: deterministic fixed-timestep simulation

The whole "keeps playing while the tab is closed" premise means the simulation must be
**decoupled from rendering and from wall-clock frame timing**:

- The sim advances in fixed ticks. **Tick length: 1000ms** (1 tick/sec). Task durations of
  5s–15min and crop growth don't need finer granularity; the farmer's *movement* can be
  visually interpolated between ticks so it still looks smooth at 60fps.
- Game state stores `lastTickTime` (epoch ms). On load: `elapsed = now - lastTickTime`,
  run `floor(elapsed / TICK_MS)` ticks in a loop before the first render. Ticks are pure
  state updates with no rendering/DOM access, so thousands of catch-up ticks are cheap.
- **Catch-up cap:** cap offline catch-up at e.g. 7 days of ticks (604,800 ticks) as a
  safety valve. If catch-up takes >1 frame budget, run it in chunks with a "Your farm was
  busy…" progress overlay so first paint isn't blocked.
- **No `Math.random()` in the sim.** Use a seeded PRNG (e.g. mulberry32) stored in the
  save. This makes catch-up deterministic and bugs reproducible. Rendering-only effects
  may use `Math.random()` freely.
- The render loop (`requestAnimationFrame`) is separate: each frame it runs any due ticks
  (`while (now >= nextTickTime) tick()`), then draws with interpolation.
- `visibilitychange` → save immediately on hide, and on show run catch-up. This handles
  iOS Safari killing/suspending background tabs, which it will do aggressively.

## 2. File layout

```
index.html                  canvas + UI overlay containers, loads js/main.js
css/style.css               UI overlay styling, safe-area insets, touch sizing
assets/tilemap_packed.png        Kenney farm sheet  (12 × 11 tiles of 16px)
assets/town_tilemap_packed.png   Kenney town sheet  (12 × 11 tiles of 16px)
js/
  main.js                   entry point: boot, load save, catch-up, start loops
  config.js                 all tuning constants (tick length, durations, prices, thresholds)
  engine/
    loop.js                 rAF render loop + fixed-tick scheduler + catch-up runner
    rng.js                  seeded PRNG (mulberry32), serializable state
    save.js                 localStorage save/load, schema version + migrations, autosave throttle
    events.js               tiny pub/sub so sim modules never touch UI/DOM directly
  render/
    renderer.js             canvas setup, DPR scaling, pixelated integer zoom, draw ordering
    camera.js               pan/zoom state, world<->screen transforms, clamping to map
    sprites.js              tilesheet atlas: named sprite -> {col,row} in the 12×11 sheet
    tilerender.js           draws ground layer + object layer from the grid
    entityrender.js         draws farmer + animals with movement interpolation & bob
  world/
    grid.js                 tile grid store; get/set tile, walkability, serialization
    tiledefs.js             data table of tile types (grass, soil, tilled, rock, tree, fence, gate, road, trough…)
    worldgen.js             new-game map: starting plot scattered with rocks/trees/weeds
    pathfind.js             A* on the walkability grid; gates walkable for farmer only
  sim/
    tick.js                 orchestrates one tick: farmer, crops, animals, autosave check
    tasks.js                task queue: add/cancel/prioritize, retry-to-back, task defs & durations
    farmer.js               farmer state machine: idle-wander / walk-to-task / work / open gate
    crops.js                crop defs + growth stages, tilled-soil drying, per-tile growth timers
    animals.js              animal wander, eat/drink from troughs, harvestable thresholds
    inventory.js            item stacks, add/remove, item defs (crops, wood, eggs, milk, materials)
    shop.js                 buy/sell logic, price table, rotating seed selection (tick-driven)
  ui/
    hud.js                  money, clock, current-task readout, pause of UI (never of sim)
    taskpanel.js            queue list: reorder-to-top, cancel, current task highlight
    inventorypanel.js       grid of item stacks
    shoppanel.js            buy/sell tabs
    toolbar.js              tool selection: select / clear / till / plant / build / harvest…
    input.js                touch+mouse: tap, drag-to-paint tiles, two-finger pan, pinch zoom
    toast.js                small transient messages ("+3 corn", "task can't be reached")
```

**Dependency direction:** `sim/` and `world/` never import from `render/` or `ui/`. They
communicate outward only via `events.js` (e.g. `emit('inventory:changed')`). UI and
renderer read game state directly but only mutate it through task/shop/inventory APIs.
This keeps the sim headless — which is what makes catch-up and testing possible.

## 3. Data model (the save)

Single JSON object, versioned. Target: comfortably under 200KB.

```js
{
  version: 1,
  lastTickTime: 1723600000000,     // epoch ms of last completed tick
  rngState: 123456789,
  money: 50,
  map: {
    w: 40, h: 40,
    ground: [...],                 // Uint8-ish array of ground tile ids (grass/soil/tilled/road)
    objects: [...],                // object layer: rock/tree/weed/fence/gate/building/0
  },
  crops: { "x,y": { type: "corn", plantedTick, stage } },   // sparse, keyed by tile
  farmer: { x, y, taskId, path: [...], workRemaining },
  animals: [ { id, type: "cow", x, y, food, water, readyAt } ],
  troughs: { "x,y": { kind: "food"|"water", level, foodType } },
  tasks: [ { id, type: "chop", x, y, duration, retries } ],
  inventory: { corn: 12, wood: 5, egg: 2 },
  shop: { rotationSeed, lastRotationTick },
}
```

- Serialize with `JSON.stringify`; tile arrays as plain number arrays (fine at 40×40;
  revisit base64-packing only if land expansion makes saves large).
- **Autosave:** dirty-flag + throttle, min 1s / max 10s between writes per the design doc;
  plus immediate save on `visibilitychange`/`pagehide`.
- `save.js` owns a `migrations[version]` map from day one, so schema changes never nuke
  an existing farm — this game's whole point is a long-lived save. **Never ship a change
  that breaks the fiancée's farm.**

## 4. Tilesheet atlas

`assets/tilemap_packed.png` is 192×176 = 12×11 grid of 16×16 tiles (Kenney farm pack,
CC0). An early task is cataloging it in `render/sprites.js` as a named map, e.g.:

```js
export const SPRITES = {
  grass: [0, 0], tilledSoil: […], rock: […], treeTop: […], treeBottom: […],
  fenceH: […], gateClosed: […], gateOpen: […],
  cornStage0: […], cornStage1: […], cornStage2: […], cornRipe: […],
  farmerDown: […], cow: […], chicken: […], …
};
```

Do this by opening the PNG at 8–10× zoom and recording coordinates by hand once
(includes: terrain & paths, fences/gates, rocks/trees/stumps/weeds, 4+ crops with 3–4
growth stages each, barn/building pieces, troughs/barrels/chests, farmer sprites in
4 directions, cow/chicken/goat/sheep + baby variants). Some objects (trees, barn) are
taller than one tile — the atlas should support multi-tile sprites drawn with a y-sort
so the farmer can walk "behind" them.

## 5. Milestones

Each milestone ends in a **playable, saveable state** — vertical slices, not layers.
Verify each on a phone (or DevTools mobile emulation + touch) before moving on.

### M0 — Skeleton & renderer
- `index.html`, canvas sized to viewport with DPR handling, `image-rendering: pixelated`,
  `viewport-fit=cover` + safe-area CSS, prevent double-tap zoom / pull-to-refresh.
- Sprite atlas started (terrain + a few objects). Render a hardcoded grid. Camera pan
  (one-finger drag on empty space) & pinch zoom with integer scale snapping.
- Fixed-tick loop running with a visible tick counter. Save/load of a trivial state,
  autosave throttle, catch-up scaffold (log "ran N ticks").
- **Done when:** you can pan/zoom around a drawn map on a phone; reload restores state.

### M1 — Farmer, tasks, clearing land
- Worldgen: starting plot littered with rocks, trees, dead trees, weeds.
- A* pathfinding; farmer walks with interpolation, wanders when idle.
- Task queue: tap an obstacle → "Clear" task. Farmer paths to it, works for the task's
  duration (progress bar over head), tile clears, wood/stone → inventory (data only).
- Task panel UI: list, cancel, move-to-top. Unreachable task → goes to back of queue with
  a toast.
- **Done when:** queue 10 clear tasks, close the tab 5 minutes, reopen → work happened.

### M2 — Farming loop ✅
- Tools: till (drag-to-paint tiles → one task per tile), plant (pick seed from inventory),
  water, harvest (drag-paint over ripe crops).
- Crop growth in ticks with 3 sprite stages; harvest adds crops to inventory.
- **Watering rule:** watering is what *starts* a crop growing; an unwatered seed waits
  forever and is never lost. A ripe crop then spoils if unpicked for 48 hours. See
  design.md for why the pressure sits at the harvest end — the earlier "water before
  halfway or it dies" rule wiped entire large fields, because planting N tiles takes
  O(N) farmer-time against a fixed deadline. Do not reintroduce a plant-side deadline.
- Inventory panel UI. Start the player with a few free seeds.
- **Done when:** till → plant → water → wait offline → harvest → see crops in inventory.

### M3 — Economy ✅
- Shop panel with buy/sell tabs, coarse 1/5/all quantities, and affordability-aware
  buttons. Money in the HUD, updating live.
- Rotating seed selection (`sim/shop.js`): staples always stocked, two slow crops
  rotating every 6 hours. **The stock is derived from the tick count, not stored** —
  so offline catch-up needs no rotation bookkeeping and there is nothing to migrate.
  It also must never consume `state.rng`, or opening the shop would change how the
  farmer wanders; there's a test pinning that.
- Balance pass across all six crops (see the note in `sim/crops.js`): profit per
  planting climbs ~17 → ~180 from carrot to eggplant, while profit per minute slides
  ~4.3 → ~2.0. A test asserts this shape holds, since inverting it would make the
  slow crops pointless.
- **Done when:** full loop clear → till → plant → water → harvest → sell → buy better
  seeds. Verified end-to-end: 5 corn seeds ($70) → 16 corn → $256.

### M4 — Construction ✅
- Build tool with a shared sub-picker row (the same row the seed picker uses, so the
  bottom of the screen never grows by more than one line). Fence, gate, road, water
  trough, feed trough — each showing its cost, dimmed when unaffordable.
- **Materials are checked at queue time against everything already queued**
  (`canAfford` + `pendingMaterials`), so you can't order ten fences with wood for two,
  but they're only *spent* on completion — cancelling a build costs nothing, matching
  how planting handles seeds. `completeBuild` verifies the whole cost before spending
  any of it, so a half-paid structure is impossible.
- **Troughs are two tiles wide** — the first multi-tile structure. The pattern that
  barns will reuse: the trough record lives in `state.troughs` keyed by its left-hand
  anchor and is the source of truth; the object grid marks both tiles purely so
  existing walkability and tap handling keep working. Rendering iterates the anchors,
  not the grid, so the halves can never come apart.
- Fences join into runs at draw time (end posts, repeating middle), like tilled beds.
  Gates simply aren't drawn while the farmer stands on them, which reads as the gate
  swung open — the sheet has no open-gate sprite and none is needed.
- **Done when:** you can fence a pasture with a gate the farmer walks through and
  animals can't escape. Verified: a 10x8 pen with one gate — farmer paths in, animal
  pathfinding out returns null.

Structures can be taken back down with the clear tool for half their materials
(`structureAt` / `demolish` in `sim/build.js`). Matching happens on what the
structure left in the world rather than anything stored per-tile, so farms saved
before demolition existed can still be dismantled. The `auto` tool deliberately
never offers demolition — only the explicit clear tool does.

**Gotcha worth knowing:** a player can seal the farmer inside (or outside) a fully
closed ring, since fences block everyone. It's recoverable — the farmer can clear a
fence from whichever side he's on — and unreachable tasks defer rather than jam, so
nothing breaks permanently. Not worth a placement-time reachability check.

### M5 — Animals ✅
- Buy cow/chicken from shop; animal wanders (random walk, fence/gate-constrained),
  seeks troughs when hungry/thirsty, drains trough levels.
- Fill-trough tasks (water free, food consumes a crop type from inventory).
- Threshold met (time + food + water) → harvestable badge → milk/collect-egg task.
- Animal state fully tick-driven so offline catch-up covers feeding & production.
- **Animals never die** (see design.md). Going hungry or thirsty only stalls
  progress toward being harvestable; feeding resumes it with no lasting penalty.
  There is no health value and no removal path — an animal leaves the farm only if
  the player sells it. Note this is deliberately *unlike* crops, which do wither:
  resist the urge to unify the two systems.
- Because neglect is invisible in the numbers, a hungry or thirsty animal needs an
  on-sprite marker, and the return-from-away summary should mention stalled
  production ("your cow was thirsty") rather than staying silent.
- **Done when:** a fenced, fed cow produces milk overnight (offline) and it can be
  collected and sold — and a cow left with empty troughs for a week is still there,
  just unproductive. **Both verified**, the second by ticking a full simulated week
  with no troughs at all and asserting the animal is untouched.

**Implementation notes.** `sim/animals.js` holds the lot. Production only advances
while `!isNeglected(a)`; there is deliberately **no health value and no removal
path** — an animal leaves only when sold. Progress is *paused*, never lost, so
refeeding resumes exactly where it stopped (there's a test for that specific
number). Animals path with `actor: 'animal'`, which is what makes gates one-way.
Trough seeking re-plans only when the path empties and tries just the three
nearest troughs, so a fenced-out animal doesn't scan the farm every tick.

Feed cost picks the **cheapest** crop the player has enough of, which avoids
adding another picker to the UI and stops a stray fill consuming the eggplants.

### M6 — Polish & ship
- Offline-return summary ("While you were away: 6 tasks done, 12 corn harvested").
- PWA-ify: `manifest.json` + icon so it installs to the iPhone home screen; simple
  service worker caching the static files so it opens instantly (still no backend).
- Sound-free by design (phone game), but add small juice: tick bob for working farmer,
  particles on harvest, toast messages.
- Save export/import (copy-paste JSON blob) as a backup path since localStorage can be
  evicted by iOS — surface a gentle "back up your farm" prompt occasionally.
- Land expansion purchase (design doc "buy more land"): grow `map.w/h`, migrate arrays.

## 6. Mobile specifics (do these in M0, not at the end)

- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">`
- Canvas backing store = CSS px × `devicePixelRatio`; draw at integer zoom multiples of
  16px tiles to keep pixels crisp; `ctx.imageSmoothingEnabled = false`.
- `touch-action: none` on canvas; `overscroll-behavior: none` on body.
- Tap targets in HTML UI ≥ 44px. Panels slide up from the bottom (thumb reach).
- Gesture rules: tap = select/queue on tile; drag with paint-tool active = paint tasks;
  one-finger drag with select tool = pan; pinch = zoom. Keep it simple and test early —
  gesture disambiguation is the riskiest UI item.

## 7. Testing

- Because the sim is headless and deterministic, add a tiny no-framework test runner
  (`tests/run.js` executed with `node`) asserting things like: N ticks grow corn to
  stage 2; catch-up(2h) equals 7200 live ticks; task retry ordering; pathfinding around
  fences; save→load round-trip equality; migration from each old schema version.
- Manual device checklist per milestone: rotate, backgrounding, force-kill Safari and
  reopen, airplane mode (should not matter), low-power mode frame rate.

## 8. How tilled soil is drawn — resolved

**Decision: tilling is a row operation, and beds are drawn with the capsule art.**

The constraint that drove this: the sheet's soil art is a **capsule set**, not a blob
autotile set. It has rounded end-caps and straight middles for horizontal and
vertical runs, but **no inner or outer corner pieces**, so there is no way to
outline an arbitrary 2D region. A 47-tile blob autotile is simply not available
here — which is fine, because tilling in rows is truer to the subject anyway.

How it works:

- The till tool takes **two points** and snaps them to one axis (`tillRow` in
  `sim/tasks.js`), so a row is always purely horizontal or purely vertical.
- Each tilled tile stores its row's axis in `state.tillDir` (`'h'` / `'v'`).
- `tilledPiece()` in `render/tilerender.js` picks cap/middle/single by checking
  whether the neighbours **along that same axis** are tilled with the same axis.
  Cross-axis neighbours deliberately do not join, which is what keeps two stacked
  horizontal rows reading as two beds rather than one grid.
- The capsules have their baked-in grass background colour-keyed to transparency
  at boot (`CAPSULES` in `render/sprites.js`), so a bed sits correctly on grass or
  on the bare earth left by a felled tree.

Paths and cleared earth (`GROUND.DIRT`) are arbitrary shapes that the farm sheet's
capsule art cannot cap. They now use the **town sheet's 3x3 nine-slice dirt**, which
handles arbitrary regions properly — so a cleared patch gets a real grassy boundary
rather than the hard-edged flat fill it used to have.

## 9. Multi-tile buildings

Barns are the first real multi-tile structure, and the pattern generalises to sheds,
coops, or anything else later:

- **`state.buildings` is the source of truth** — `{id, type, x, y}`, anchored at the
  top-left of the footprint. The object grid marks every footprint tile with a generic
  `OBJ.BUILDING`, purely so walkability, pathfinding and tap handling keep working
  without knowing buildings exist. Only the record can say *which* building a tile
  belongs to, which is what `buildingAt()` is for.
- **Footprint is not artwork size.** A barn occupies 3x2 on the ground but draws 3x5:
  three roof rows stacked above the two body rows. The roof overhangs tiles that stay
  walkable, exactly as trees have always done.
- **Draw order:** buildings are drawn during the object row loop, at the row where
  their *bottom* row sits. That makes them y-sort against everything else — things
  lower on screen overlap them, things above are overlapped.
- **Placement UI** is generic (`beginPlacement` in `main.js`). A placement spec supplies
  its own footprint, validity rule, ghost drawing, and confirm action, so the same flow
  serves a barn (which queues a build task) and a livestock purchase (an immediate
  transaction). Anything with `def.building` uses it, as does buying an animal — both
  are expensive enough that dropping them blind is a bad trade. Troughs and fences
  still place instantly on the tap.
- **A new farm starts with one barn**, sited by `startingBarnAnchor()` in `worldgen.js`
  and stood up by `placeStructure()` from `newGame()`. `placeStructure` is the
  cost-free half of `completeBuild` — the split exists precisely so worldgen can put a
  finished structure in the world without inventing a fake transaction.
- **Nothing is charged until confirm**, for buildings and animals alike, so cancelling
  a placement always costs nothing. `canBuyAnimal()` checks affordability *before*
  sending the player off to pick a spot; `buyAnimal(state, type, x, y)` is what actually
  takes the money.
- Capacity comes from `animalCapacity()` = finished barns x `BARN_CAPACITY` (4).
- **Tasks carry their footprint** (`task.w` / `task.h`, defaulting to 1x1). That lets
  the task marker outline the whole structure — a queued barn is outlined across all
  six tiles with its interior divisions hinted — without the renderer knowing anything
  about build recipes.
- **"Adjacent" means beside the whole footprint, not beside the anchor.** `besideBox()`
  in `world/pathfind.js` is used by both `findPath` and the farmer's `inPosition`, and
  the two must agree exactly or the farmer walks somewhere the route accepted and then
  refuses to start work. Measuring against the anchor alone let him build a barn from
  a tile the barn was about to occupy, leaving him embedded in the finished wall.

## 10. Open questions (from design doc "Thoughts")

- Farm-building tiles: suggest barn = animal capacity gate (each barn houses N animals),
  giving construction a purpose. Decide by M4.
- Multiple save slots / "new game" confirmation — cheap, decide at M6.
