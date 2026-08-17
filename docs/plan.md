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
- **Settings panel — complete.** Backup, restore, and the debug switches that
  used to live only on `window.lilfarm`, now reachable from a phone. See below.
- **Land expansion — complete.** The world is a 3x3 grid of cells, each a full
  40x40 farm; you start in the middle and buy outward. See below.
- **`TESTING` is off.** New farms get $50 and ten seeds, as intended.
- **Weeds regrow — complete.** Capped, seeded, replayable; see `sim/weeds.js`.
- **The status bar is the task button.** One fewer button in the bottom row.
- **Affection and emotes — complete.** Tap an animal to pet it; see design.md.
- **Sheep — complete.** The slow, valuable animal: wool over 75 minutes at $100.
- **Milked animals bank up to 4 units** rather than stopping at one.
- **Mushrooms and the journal — complete.** Foraging, 16 kinds; see design.md.

**The settings panel and the save.** The farm lives in localStorage, which the
browser is entitled to clear, so exporting a copy is the only real protection
besides installing to the home screen. `validateSave()` in `engine/save.js` does
the checking — parse, migrate, then assert the object actually has a map and a
farmer, since `migrate()` only looks at the version and a stray JSON object would
otherwise sail through and crash on load. It returns `{ok, reason, data}` and
never writes anything; the panel decides.

Importing runs `autosaver.disable()` *before* writing and reloading. This is the
same trap that made `wipe()` silently do nothing: the page fires `pagehide` on
its way out and a live autosaver writes the in-memory farm straight back over
what was just written. Any new code path that replaces or clears the save has to
disable the autosaver first.

Both destructive buttons use a two-tap confirm (`confirmable()`) rather than
`confirm()`: it stays in the game's own styling and can't be dismissed by a
stray swipe. Taps re-arm for 4s and reset when the panel closes.

**Land ownership lives on the Grid, not beside it.** `grid.owned` is a Set of
plot indices, and `isWalkable()` consults it. That one placement is why the
farmer, the animals and the pathfinder can't disagree about where the farm ends
— they all already funnel through that method. `taskForTile` and `canPlaceAt`
check `isOwned` explicitly, which covers every tool at once rather than per tool.

**The world grew rather than being subdivided.** A cell is 40x40 — the entire
map as it was — and the world is 3x3 of them, so a new farm has exactly as much
land as it always did and expansion is new country. This was a correction: the
first attempt cut the existing 40x40 map into 8x8 plots, which took land away
from players instead of offering them more.

`world/expand.js` is the v2 -> v3 migration: the old map goes into the centre
cell, eight cells are generated around it from a generator seeded off the save's
own seed (so it's deterministic and can't disturb `state.rng` mid-stream), and
**every coordinate in the save shifts by one cell**. That last part is the risky
half — farmer, path, trail, animals and their pixel positions, buildings, tasks,
and the `"x,y"`-keyed crops/wetUntil/tillDir/troughs. Anything new that carries
a tile coordinate has to be added to `shiftCoordinates` or it will point at the
wrong tile forever. The test builds its "old save" by running that shift in
reverse on a real farm, so a forgotten field shows up as a farm scattered a cell
apart rather than as a passing assertion.

Saves in the wild can be v1 or v2 (ownership shipped once with the 8x8 geometry);
both are 40x40 maps and both converge on the same expansion, which discards the
old plot indices and grants the whole cell.

A save is ~57KB now — nine times the tiles. Well inside localStorage's ~5MB and
still fine to paste into the settings panel's backup box.

**Development is served by `tools/devserver.mjs`, not `python -m http.server`.**
The only meaningful difference is `Cache-Control: no-store`. Python sends no
cache headers, which lets the browser heuristically cache ES modules, and a
half-stale module graph produces baffling errors about exports that plainly
exist. This cost hours more than once. Don't switch back.

**Weeds are the template for anything that spawns over time** (mushrooms next).
Three properties, all tested: capped as a fraction of owned land so a week away
can't bury the farm; only real work on one tick in `WEED_INTERVAL`, because
catch-up runs it 604,800 times in a row; and `state.rng` only, so replaying the
same elapsed time twice gives the same farm. `countWeeds` counts *owned* tiles
only — counting the whole map would put a new farm hundreds over its cap and
nothing would ever grow back.

**The seed rotation draws one crop per tier, not two from one pool.** The old
version could take cabbage and eggplant out together, leaving a player checking
in at bedtime with nothing but 4- and 5-minute crops — the slow crops are the
entire point of an overnight field. Reported from real play.

**Petting is not a task.** Every other interaction queues work for the farmer;
this one happens on the tap. It sits in `main.js` ahead of `taskForTile`, gated
to the auto tool and to real taps (so drag-painting doesn't pet), and it defers
to an animal that has something to collect.

Affection has **no decay**, deliberately, and it changes rates rather than
thresholds: `upkeepRate` and `productionRate` return multipliers that feed
fractional debt counters on the animal (`foodDebt`, `workDebt`), so a 40%
discount on upkeep doesn't need a second clock. `pettedAt` is `null` when never
petted, **not `-Infinity`** — JSON turns Infinity into null, so the save would
come back meaning something different from what was written and hand out a free
helping of affection on every reload. There's a test pinning that.

Emotes are chosen in `sim/`, so they replay deterministically and are part of
the save. They're drawn *after* everything else rather than in the row pass:
a bubble floats onto the row above the animal, where scenery would paint over
it. It's a caption, not part of the scene.

**`a.stock` replaced `a.ready`.** Milked and sheared animals bank up to
`PRODUCE_CAP` units; `isReady(a)` is the one place that asks. This fixed a real
hole: a cow used to produce one thing and stall, so eight hours away was $600 of
eggs against $60 of milk, and the animals you pay most for were the worst ones
to own overnight. Now it's $600 / $240 / $400 — and the hen's $600 costs 24
separate pickups against one tap. Hens are deliberately exempt from the cap;
their eggs go on the ground, so there's nothing to bank.

The v3 -> v4 migration converts `ready` to `stock`, because a cow standing there
ready had earned its milk and shouldn't quietly lose it on an update.

**The tick clock, in three parts** — all of it previously untested, which is
exactly where the bugs were:

- `runCatchup` reports `skipped`, and `discardSkipped` writes that time off the
  farm's clock. Without it the cap didn't cap: `lastTickTime` only advanced by
  the ticks that ran, so a month away replayed seven days, then seven more next
  load, and so on. Four catch-ups to arrive where one belongs.
- A hidden tab runs nothing, so the simulation falls behind wall-clock and used
  to *stay* behind for the session — `pump` runs at most `maxTicksPerFrame` and
  then resyncs its own clock, writing off the rest. `wireWakeUp` replays the gap
  on `visibilitychange` and calls `loop.resync()` so pump doesn't redo it.
- `nextFrame` is a timer, not `requestAnimationFrame`. rAF never fires in a
  hidden tab, so a PWA restored in the background sat at "Catching up…" forever
  waiting for a frame that only arrives if someone looks at it. The timer is
  throttled there but completes — and it's why the chunked path can be tested
  in Node at all.

`pump` also runs bursts over `quietBurst` ticks with events suspended and calls
`onQuietCatchup` afterwards, because a sleeping laptop otherwise wakes to a wall
of simultaneous toasts. The hook exists so the loop doesn't need to know which
events refresh which bit of UI.

**The service worker serves from its own cache**, not `caches.match()`. The bare
form searches every cache including the previous version's, which still exists
between install and activate — a stale module served from it would be written
into the new cache and pinned there for good.

**The precache guard checks referenced assets, not every file on disk.** An
unused sheet in `assets/` shouldn't be forced into the shell, where it costs
every player a download for something nothing loads. I confirmed the guard fails
when an asset is removed from the shell.

**A save that parses is not necessarily a farm.** `loadSave` checks
`isPlayableFarm` (a map and a farmer) after migrating, and keeps anything that
fails at `SAVE_KEY.corrupt` before starting fresh. A write cut short by a full
disk leaves valid JSON with nothing in it; that used to reach boot, die on
`state.farmer.x`, and leave the game unopenable until someone cleared
localStorage by hand. `validateSave` shares the same check.

**Work aimed at an animal follows the animal.** A `collect` task carries an
`animalId` and `followAnimals` refreshes its x/y every tick before the farmer
moves; a task whose animal was sold is dropped. Two consequences that had to be
handled with it: `addTask` dedupes animal work by id rather than by tile (the
task moves, so the one-per-tile check can't see a second tap from a new spot),
and an animal being tended holds still, or the farmer trails after it.

**Tests run one at a time.** They used to run as declared, with async ones left
to finish in the background — so an async test's `await` handed control to the
*next* tests while its event listeners were still registered, and a later test
firing `task:done` was counted by an earlier test's listener. The failure then
surfaced in the innocent test. This bit while adding the milking tests and cost
real time to diagnose; sequential costs nothing measurable.

**A queued build reserves its ground, not just its materials.** `reservedTiles`
sits next to `pendingMaterials` in `build.js` and exists for the same reason:
the check has to account for what's already queued or two orders both pass.
Spawners (`canSprout` in both weeds and mushrooms), `canPlaceAt` and the till
branch of `taskForTile` all consult it. Clearing deliberately still works — a
rock on the site is a thing to remove, not a conflict.

`clearBuildSite` in `tasks.js` handles the one case reservation can't prevent, a
hen laying on the site. It lives in tasks.js rather than build.js on purpose:
build.js must not import mushrooms.js, because mushrooms.js imports build.js for
`isReserved` and the cycle would be real. tasks.js already imported both.

Two ordering traps, both tested: the material check runs *before* the site is
cleared, so a build that can't be paid for doesn't cost an egg on its way to
failing; and `forage()` banks the mushroom itself, so `clearBuildSite` records
it for the report but must not bank it again. The first version double-counted
and a test caught it.

**Rendering is skipped unless the frame would look different.** `drawIfNeeded`
compares a small frame signature — tick, camera translation, placement ghost,
till anchor — and draws only if it changed or something is mid-move. Measured
on the phone-sized viewport: an idle farm went from ~18,000 sprite draws a
second (60Hz; twice that on a 120Hz phone) to 287.

Three details that are easy to get wrong and were:

- The camera part of the signature keys on `Math.round(camera.x * zoom * dpr)`,
  the exact device pixel `draw()` translates to. Keying on the raw camera
  position drops frames during a slow drag that really does move the picture.
- The frame gate is `1000 / MAX_FPS - 2`. Frame times are whole milliseconds,
  so a 60Hz display offers frames at 0, 17, 33 and an exact 33.33ms gate
  rejects the one at 33 — giving 20fps when 30 was asked for.
- The farmer's working bob was driven by `alpha`. Standing still to chop
  produces no frames between ticks, so it has to be driven by the tick.

`anythingMoving` is exported and tested because a false negative there freezes
the picture, which is much worse than the wasted frame a false positive costs.

**The farmhand is a second mover, not a second farmer.** `sim/farmhand.js` runs
its own tiny state machine (work timer -> full? -> target -> walk -> job) and
touches nothing the farmer's task pipeline owns. It has no task queue: giving it
one would have meant either sharing the player's queue, which would let hired
help steal work the player asked for, or a second queue and a second UI.

`takeFromAnimal(state, animal, max)` was split out of `collectFrom` so a hand
can take only what it can carry. That was the one real correctness risk here —
without a max, a hand with room for one and a cow holding four would have
silently destroyed three.

Two existing pieces generalised rather than being duplicated: `followAnimals`
became `followTargets` (animalId *or* handId), and `beingTended` now counts a
hand on its way, so animals hold still for either.

Idle hands rescan for work only every `SCAN_INTERVAL` ticks. Same reasoning as
the duck's water search: an unbounded per-tick scan is fine in play and ruinous
across a seven-day catch-up.

**The duck is what the `'swimmer'` seam was for.** `SWIMMERS` is now derived
from the `swims` flag on the animal table rather than hand-listed, so adding
another swimmer is a data change. Nothing else moved: gates still stop it,
because the gate check keys off "not the farmer" rather than off the actor
name.

Two behaviours came with it. A swimmer that is off the water and has nothing
else to do paths back onto it — plain wandering drifts inland a little further
after every trip ashore, which reads as the opposite of preferring water. And
`canLayAt` gates egg-laying on owned, dry, empty ground, which is both what
sends a duck ashore and the fix for eggs being laid on land the player doesn't
own (they could never be picked up).

**Water is the only blocking *ground*.** The check sits in `Grid.isWalkable`
beside the ownership one, for the same reason: the farmer, the animals and the
pathfinder all funnel through that method, so they can't disagree about where
the water's edge is. `isWalkable` now takes a third actor, `'swimmer'`, which
water lets through and gates still stop — nothing is one yet, but ducks are
planned and this is the seam. `SWIMMERS` in `sim/animals.js` is the only place
that will need to know about them.

Two consequences that needed handling explicitly: build and demolish tasks for
water are `adjacent`, since the farmer can't stand in it to dig or fill it; and
`canPlaceAt` refuses water on a tile with anyone on it, or the animal standing
there would be marooned on a one-tile island.

**Animals drink from open water** the same way they drink from a trough, and a
pond never empties. `nearestWater` searches ring by ring out to a fixed radius
and an animal that finds nothing waits `WATER_SCAN_COOLDOWN` before looking
again — catch-up replays that loop hundreds of thousands of times, and an
unbounded scan of a 14,400-tile map would make a week away crawl.

The pond reuses the dirt road's autotiler unchanged (`ninePiece` plus
quadrant-composited concave corners), which is what that generalisation was
for. The river is different in kind — a one-tile path, so it picks its tile from
its *connections* rather than from an area fill — and `blitTurned` supplies the
east-west straight the sheet doesn't have.

**Animal colours are counted off the sheet, not hardcoded.** `loadSheets` reads
`assets/animals.png`'s width and calls `setAnimalVariants(width / TILE)`, so
adding a column to the image puts a new colour in the game with no code change —
which is what the artist actually wants. `ANIMAL_VARIANTS` in config is only the
headless fallback, for tests and the save migration.

The variant is **stored on the animal**, rolled once at purchase from
`state.rng`. That keeps replay deterministic and means an animal's colour is
part of the farm rather than a function of where it happens to be standing.
`variantOf()` clamps for drawing: a save made when the sheet had more columns
than it has now would otherwise index off the end and draw nothing.

A test reads the PNG's own header and asserts every animal's `row` exists on the
sheet and that each has its own. Adding an animal to `ANIMALS` without adding a
row to the image would otherwise draw nothing, and no other test would catch it
— there's no canvas in the headless suite.

**Pin old save versions by number in tests, not `SAVE_VERSION - 1`.** The
banking migration test used the relative form and quietly stopped exercising the
migration it was named after the moment a version was added after it.

**Queued ground is previewed, for every ground buildable.**
`pendingGroundTiles` returns tile -> ground id for anything queued, and
`drawGround` paints the real ground then the planned ground over it at 45%.
Both go through the same `paintGround`, so the preview can't drift from the
real thing. The planned tiles are also fed into the autotile predicates, which
is the point: a shape has the outline it's going to have from the moment it's
ordered rather than re-deciding its edges after every tile.

**Autotiling picks a piece per quarter-tile, not per tile.**
`autotileQuadrants` returns four keys; `blitAutotile` draws four 8x8 source
sub-rects (no clipping, no canvas state changes). Dirt and water share it.

This replaced a nine-slice that could not express **grass on three sides** —
a one-tile-wide arm, a dead end, a half-dug pond — where it fell back to a
straight edge and left two sides of the tile as bare fill against grass. It
also couldn't draw a crossroads: four diagonals needing a wedge, one tile able
to supply one. Per-quarter handles every arrangement from the same 13 pieces,
and the whole thing is smaller than what it replaced.

Tested without a canvas by asserting the four keys — a nine-slice is easy to
get subtly wrong and the result is a farm full of hard square edges, which is
exactly what nobody spots by looking.

The town sheet's tiles were catalogued by **sampling the PNG's pixels**, not by
eye: for each candidate tile, which edges and corners are green. That's how the
four concave corners at (3,3)-(6,3) were confirmed. Worth repeating for any new
tile set — this project has mis-catalogued sprites by eye more than once.

**Mushrooms reuse the weed spawner's shape** — capped, one-tick-in-N, `state.rng`
only — which is exactly what that file said it was there to be. What's different
is that *which* mushroom grew is state, not a hash of the tile: it lives in
`state.mushrooms` keyed by tile, the way crops do, because the object grid is one
byte per tile and there are sixteen. A find has to still be the same find after
a reload.

The journal (`state.journal`) counts finds and is deliberately **not** derived
from the inventory, so selling a collection doesn't erase it. No migration was
needed — both fields default to `{}` on load, so old saves open fine.

**New tab rows must be added to the `#shop-tabs, #inv-tabs` selectors in
style.css.** `#ui button` is an ID selector, so a bare `.tabs button.on` rule
loses to it and the selected tab silently never highlights. This has now caught
us twice.

**Migrations back the save up first.** `loadSave` copies the raw text to
`lilfarm.save.v1.backup.v<from>` before `migrate` touches it. Three rules, each
with a test: only when a migration will actually run (or every load would
overwrite the copy that matters); **never overwrite an existing backup** (the
scenario is a bad migration followed by the player reloading, and the good copy
has to survive that); and a backup that can't be written is a warning, not a
failure — refusing to open someone's farm because there was no room for a safety
copy is worse than the risk it guards against. The settings panel lists them.

**`state.mushrooms` and the object grid must agree.** Anything that clears the
object layer has to clear the mushroom map too, or a tile is recorded as having
a mushroom that isn't drawn and can't be picked. The test helpers got this wrong
first time.

195 headless tests pass via `npm test`.

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
`touch-action: pan-x` so a horizontal drag is unambiguously a scroll. Confirmed
fixed on a real iPhone — this is not something a desktop browser can tell you,
so any future change to `#ui` pointer handling needs re-checking on the phone.

Panels (`shop` / `tasks` / `bag`) coordinate through `panel:open`, `panel:close` and
`panel:dismiss` events rather than holding references to each other. Opening one
resets the tool to `auto`, closes the sub-picker, and clears any pending placement;
while one is open a map tap dismisses it instead of doing farm work. This exists
because a panel covers only part of the screen, so leaving Build armed behind it let
a stray tap on the visible strip queue work the player never intended.

Farmer travel speed is `FARMER_SPEED` in `config.js` (tiles walked per tick,
currently 3). Work durations are separate and unaffected by it.

Run it with `node tools/devserver.mjs 8146` and open `/index.html`. `window.lilfarm`
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
- Battle sheet water, all confirmed by sampling pixels: pond nine-slice at
  `(0,1)`–`(2,3)` (sand along the north shore, grass along the south), concave
  corners at `(0,5)` TL, `(1,5)` TR, `(2,5)` BR, `(3,5)` BL. River straight
  (north-south only) at `(3,3)`; bends at `(3,1)` NE, `(4,1)` NW, `(3,0)` SE,
  `(4,0)` SW. There is **no east-west straight** — it's the vertical one turned.
- Town sheet `(3,3)`–`(6,3)` are the dirt set's **concave corners** — flat on every edge
  with a grass wedge in one corner (TL, TR, BR, BL in that order). Confirmed by sampling
  the PNG's pixels, not by eye. They complete the nine-slice at `(0,1)`–`(2,3)`.

273 headless tests pass via `npm test`.

## 0. Ground rules

- **No third-party libraries.** No npm dependencies, no bundler. Plain ES modules
  (`<script type="module">`) served as static files. `node tools/devserver.mjs` (or any
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
