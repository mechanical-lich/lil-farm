# Lil Farm Design Doc

# Idea
Lil Farm is a "always running" HTML 5 game meant to be playable on an IPhone 15.  

The main premise of the game is that you are managing a farm made of 16x16 sprites.   You queue tasks that are done in order by a NPC farmer.   Each task takes anywhere between 5s to 15 minutes (or more).   So after quueing the tasks the player is able close the tab but the game will keep playing behind the scenes.    

To simulate the "playing behind the scenes" I want to use a cookie or local storage to store when the last tick happened and the game state.  This autosave is going to be limited to every second to 10 seconds.  It'll depend on performance.   When the game first loads the save it'll check the last timestamp, and then tick the game to catchup to the current time.  

## Art
Two Kenney tilesheets (CC0), both 16x16 tiles and sharing a palette so they mix freely:

- `tilemap_packed.png` — crops, tilled soil, animals, barn, troughs, the farmer.
- `town_tilemap_packed.png` — grass, dirt, cobblestone paving, fences, trees.

## World
The game is made up of 16x16 tiles.   Tiles can various things from a fence, grass, road, tilled soil, tree, etc.

### Buying land
The valley is a **3x3 grid of cells, each one a full 40x40 farm**. You start owning the middle cell and buy the eight around it. A starting farm is therefore exactly as big as the whole map used to be — buying land adds new country rather than handing back pieces of what you already had.

- Land you don't own is **drawn but dimmed**, scenery and all. It reads as somewhere you could go rather than as a wall.
- Unowned land is completely inert: nothing can be queued on it, nothing built on it, and **neither the farmer nor the animals will walk onto it**. That last part is a quiet bonus — your animals can't wander off to the far side of the valley.
- A cell must **border land you already own**, so the farm stays one connected property. The four corners of the valley only open up once you own one of their neighbours.
- Land is bought from a **little 3x3 map in the shop's Land tab**, not by tapping the world. A cell is five screens wide, so a highlight laid over the map would just wash the whole view green with no way to tell which cell you had. Nine buttons say it in one glance. Tap a cell to arm it, tap again to buy — these cost thousands.
- **Each cell costs more than the last** ($2,000 x the number you already own), so the whole valley is $72,000 and a long game.

Farms that predate this keep **the whole of their old map**. It was entirely theirs and it stays entirely theirs, dropped into the middle cell with eight new cells generated around it.

## New Game State
When you first start the game you are given a plot of land that has to be cleaned up.   There will be rocks, trees, dead trees, and weeds.   You can queue tasks to remove obstacles, pull weeds, and cut trees.   Cleared land goes back to **plain grass** — leaving bare earth behind made a tidied farm look scarred rather than cleared.

A new farm starts with **one barn** already standing, on the two rows directly above the farmer, with his dirt yard in front of it.  It gives the opening view something to sit around instead of an empty field, and it means keeping animals is something to work toward from day one rather than only after saving 50 wood and 20 stone.  It can be demolished like any other barn if you'd rather put it somewhere else.

### Weeds come back
Cleared land doesn't stay clear. Weeds sprout again on open grass you own, slowly and forever, so a farm is something you keep rather than something you finish.

- Only on **plain grass you own** — never on a bed, a crop, a road, a built tile, or under someone's feet. A weed appearing in a planted row would read as a bug.
- **Capped at 12% of the land you own.** Coming back after a week must never mean a farm buried in weeds; this is a game built to be left alone, so the worst case is always the same modest tidy-up. Worldgen's weeds count toward the cap, which means weeds return to *replace* what you clear rather than piling up on top of it.
- Owning more land means more weeds to keep down, so expanding costs a little upkeep as well as money.
- Pull them with the clear tool, same as always; each one is a fiber.

The same shape — slow, capped, seeded scatter over open grass — is what the mushrooms will want later.

## Inventory
Some tasks suchs as harvesting a crop, cutting a tree, milking a cow, collecting eggs, etc will add items to your inventory. 

## Shop
There is a shop where you can sell items in your inventory and buy new items such as crops from a rotating selection, livestock, and materials like lumber for construction.

- Buy, animals and sell are tabs of one panel, styled as tabs sitting on a shared baseline with the selected one filled green, matching how the tool buttons show selection.  Quantities are coarse (1 / 5 / all) rather than a stepper, because tapping "+" ten times on a phone is miserable.
- The seed selection **rotates every 6 hours**.  Carrot and wheat are always stocked so the player can never be stranded with nothing to plant; two of the slower crops rotate alongside them.
- The rotation is derived from the game clock rather than stored, so coming back after days away shows the right stock with no bookkeeping to replay.
- Seeds resell at half price — enough to undo a misbuy, never a money loop.
- **Balance shape:** short crops pay better per minute, long crops pay far better per planting.  A 4-minute carrot is great while you're watching and wastes eleven hours while you're not, so the slow crops have to be the obvious choice for an overnight field.

## Farming
There is a task to prepare the land for farming which changes the tile to tilled.  You can then queue a task to add a seed from inventory to the tilled tile to plant it.   After some time it will start growing and eventually it'll be harvestable.  

### Tilling is done in rows
Tilling is a **row** operation, not a paint-any-shape operation, because that is how tilling actually works and it is what the soil art supports.

- Selecting the till tool requires **two points**.  The row is snapped to whichever axis the player moved furthest along, so a row is always purely horizontal or purely vertical.
- When each tile is tilled it remembers the axis of the row it belongs to.  The tile then picks its sprite from that axis and its neighbours: a rounded cap at each end of the row, straight middles between, and a small standalone oval for a one-tile bed.
- Only neighbours **in the same-axis row** join up.  So two horizontal rows stacked on top of each other stay two visibly separate beds with a gap between them, instead of merging into one undifferentiated grid.
- Tiles that can't be tilled (a rock, an existing bed) are skipped rather than cancelling the whole row.
- **Tilling can be undone.**  The clear task works on an empty bed and reverts it to grass, so a misplaced row isn't permanent.  Clearing part of a row is fine: the remaining tiles re-cap themselves, because a tile's sprite is worked out from its neighbours when drawn rather than fixed when it was tilled.
- Clear will **not** touch a bed with a crop in it.  A growing crop represents real waiting time, so it has to be harvested (or cleared, if it died) deliberately first.  Obstacles still take priority: clearing a tile with a rock on it removes the rock, not the bed.
Harvesting is a task that can then be queued for each planted tile.  Harvesting add the crop to inventory to either be sold, replanted, or fed to animals. 

### Watering and spoiling
Tilled land has a dry and a wet version in the tilesheet, and each crop has a yellowed "dead" sprite.

- There is a **water** task that can be queued on tilled soil.
- **Watering is what starts a crop growing.**  A planted seed does nothing at all until it is watered — it waits as a seedling indefinitely and is never lost.  There is no deadline to water by.
- **A fully grown crop must be harvested within 48 hours or it spoils**, turning into the dead/yellowed sprite.  This is the only way a crop can be lost.
- Watering is tracked on the crop, not the tile: once a crop is growing, the soil drying out doesn't stop it.  The wet/dry look of the soil is a visual cue that a bed has been seen to, not a second rule to satisfy.
- Watered soil dries back to the dry tile after a while, so a bed can be re-watered and still looks alive.
- A dead crop is cleared with the harvest task and yields nothing.
- Seeds waiting on water show a blue marker; ripe crops show a red one as their 48 hours run down.  Losing a crop should never be a silent surprise.

**Why the pressure sits at the harvest end.**  An earlier version of this rule killed crops that went unwatered past the halfway point of their life.  That turned out to punish ambition badly: the farmer plants tiles one at a time, so a 30-tile field took longer to plant than the deadline allowed, and *the entire field* died before the farmer could get round to watering it — with bigger fields failing worse.  Gating growth on watering instead means planting is always safe no matter how much you queue, and the deadline that remains is one the player can actually see and act on: a ripe field sitting there waiting to be picked.

## Construction
You can build things like farms, fences, barrels, water/feed troughs, and roads.  

- The build tool offers fence, gate, road, water trough and feed trough, each showing its material cost.  Materials come from chopping trees and clearing rocks, or from the shop.
- **Materials are reserved when work is queued and spent when it's finished.**  You can't queue more building than you have materials for, but cancelling a build costs nothing.
- Fences block everyone.  Gates block animals but the farmer opens them, so a pen needs exactly one gate to be usable and secure.
- Troughs are **two tiles wide** and need two clear tiles side by side.

### Barns
Barns are the answer to "what are the farm tiles for" — they're what lets you keep animals.

- A barn is **3 tiles wide and 2 deep** on the ground, and costs 50 wood and 20 stone.  Its roof draws three rows higher and hangs over tiles the farmer can still walk through, the same way a tree's canopy does.
- **Each barn houses 4 animals.**  Your capacity is the total across all finished barns, and the shop won't sell you an animal when you're full.  A barn that's only queued doesn't count yet.
- Because a barn is big and expensive, placing one is a **two-step gesture**: tap to put a ghost preview where it would go, with its footprint tinted green or red, then confirm.  Tapping again moves the ghost.  Everything smaller still drops on a single tap.
- Barns can be demolished like anything else, refunding half of both materials.
- Fences drawn next to each other join into a continuous run automatically.

### Taking things down
**Anything you build can be removed again, and gives back half its materials** (rounded down, so a 1-stone road refunds nothing).

- Use the clear task, the same one that chops trees and undoes beds.
- Removing part of a fence run is fine: the remaining fence re-caps its ends automatically, because a fence tile works out its own sprite from its neighbours when drawn.
- Tapping either half of a two-tile trough removes the whole trough.
- A removed road goes back to grass, not to bare earth.
- Building and immediately removing something is always a net loss, so there's no way to farm materials by churning structures.
- The **tap** tool deliberately never demolishes.  Only the explicit clear tool does, so a stray tap can't destroy something you paid for.

Note that a fully closed fence ring with no gate will shut the farmer in or out.  That's recoverable — he can clear a fence from whichever side he's on — so it's left as the player's problem rather than being prevented.

## Animals
Animals will wander around random and eat/drink as necessary.   Each animal type has a threshold of time + water + food that when met will cause them to be "harvestable" which means they'll either lay and egg or be ready to milk.   
There are tasks to fill food and water troughs.  Water is infinite, but food must be from inventory.   Food is the same as crops, so if you are adding corn it can be harvested corn or bought from the shop.  

Animals can not open gates.

### How animals work
- Three animals, in order of patience: a **chicken** ($120) drops an **egg** every 20 minutes, a **cow** ($500) is ready to **milk** after 30 minutes, and a **sheep** ($800) grows a **fleece** over 75 minutes.  All of them need food and water to make progress; the clock only runs while they have both.
- **Wool is the slow, valuable one.**  A fleece sells for $100 against milk's $60, so a sheep is the animal for someone who looks in twice a day and the wrong one for someone watching the farm — the same shape as the slow crops being the seed you plant before bed.
- **Milked and sheared animals bank up to 4 units** and then wait.  Without that a cow produced one thing and stood idle however long you were away, which made the animals you pay the most for far worse than chickens overnight.  A full cow fills in 2 hours and a sheep in 5, so the cow is the animal to own if you're watching and the sheep if you're not:

  | 8 hours away | price | waiting | taps to collect |
  |---|---|---|---|
  | Chicken | $120 | $600 | 24 |
  | Cow | $500 | $240 | 1 |
  | Sheep | $800 | $400 | 1 |

  Chickens still earn the most while you're gone, but every egg is a separate pickup and they litter the ground.  That's the trade: hens are the highest-yield and highest-effort animal, and the expensive ones are the ones you can leave.
- **Collecting takes the whole bank in one tap.**  One tap per churn would recreate exactly the fiddliness that picking eggs up off the ground already has.
- **Chickens are not collected from.**  A hen with enough food, water and time **drops an egg on the ground** where it stands, and the egg is picked up with the clear task like anything else lying in the grass.  Eggs don't block movement, and a hen with nowhere to put one simply waits rather than losing it.
- **Cows and sheep are collected from directly** — you tap the animal.  That difference is deliberate: you pick an egg up off the ground, you milk a cow and you shear a sheep.
- **Animals are free-range.**  Nothing forces you to fence them.  Fences and gates are how you *choose* to keep them near their troughs, since a gate stops an animal but not the farmer.
- You need a **barn before you can buy an animal**, and each barn holds 4.
- **You choose where a new animal goes.**  Pressing Buy closes the shop and hands you a ghost of the animal; tap to move it, then confirm.  Nothing is charged until you confirm a spot, so backing out is free — the same rule building follows.
- An animal whose food or water runs low walks to the nearest trough it can reach and takes a helping, which drains the trough.  If it can't reach one, it just carries on being hungry.
- Filling a **water trough is free** — the work is carrying it, not finding it.
- Filling a **feed trough** consumes 3 units of food, chosen automatically: the **cheapest crop** you have enough of, so a stray tap never burns the eggplants.
- **Feed can also be bought** from the shop at $15 a unit.  It's deliberately dearer than using your own crops — about $45 a trough against roughly $30 of carrots — and is only ever used as a **fallback** when no crop is spare.  It exists so an empty larder never means hungry animals, not as the everyday choice.  Feed resells for far less than it costs, so stockpiling it is convenience rather than a way to store value.
- Tapping an animal that's ready collects from it; tapping an egg picks it up; tapping a trough fills it.  Tapping an animal that wants nothing **pets** it — see Affection below.
- Neglected animals show a marker (blue when thirsty, amber when hungry) and ready ones bob with a badge.

### Animals never die
**Animals can not die, ever.**  Neglect costs you production, never the animal itself.

- If an animal doesn't get food or water it simply stops progressing toward being harvestable — no eggs, no milk.  It keeps wandering and waiting.
- Feeding and watering it again resumes production.  There is no permanent penalty and no way to lose an animal you paid for.
- This is deliberately **different from crops**, which do die if they aren't watered in time.  The asymmetry is the point: a crop is a cheap, replaceable seed, while an animal is an expensive purchase.  In a game you're meant to be able to walk away from for days, coming back to a dead cow you bought would feel awful.  Do not "fix" this inconsistency by adding animal death.
- A neglected animal must be visibly neglected — a hungry/thirsty marker — so an idle barn reads as "they need feeding", not as a bug.

### Affection
Tapping an animal that doesn't want anything **pets it**. This is the one thing the player does themselves rather than queueing for the farmer — sending someone else to go and fuss your cow rather misses the point.

- An animal with something to give hands it over first. You'd rather have the egg than the cuddle, and the cuddle is still there afterwards.
- A fuss only counts **once every 20 minutes**, so affection is earned by visiting often rather than by tapping fast. Petting again in between is still welcome, it just doesn't add anything.
- Affection makes an animal **cheaper to keep** (down to 60% of the usual food and water) and **quicker to produce** (up to half as fast again).
- **Affection never decays.** A week away must not undo something the player did deliberately — same reasoning as animals never dying.

### Emotes
Animals show a speech bubble now and again, from the Kenney emote sheet. What they say is decided in the simulation rather than the renderer, so it's part of the saved farm: come back after an hour and they're already saying how they've been getting on.

Needs come first, because a thirsty animal telling you how happy it is would be useless: hungry *and* thirsty is an angry face, thirsty is droplets, hungry is a sad face, something to collect is a star. Only after all that does it say how it feels about you — a heart, music, a smile, or a bored "zzz" if it barely knows you. **The fonder an animal is, the more often it pipes up**, and a neglected one speaks up regardless.

## Coming back
The whole premise is that the farm runs with the tab closed, so returning shows a **"while you were away" card** rather than silently presenting a changed field.

- It reports what happened — jobs finished, what was collected, crops ripened, crops spoiled, animals with something to collect.
- It also reports what needs attention *now*, in a warning colour: animals that are hungry or thirsty and so not producing, and seeds still waiting to be watered.  Since animals never die, this is the only place neglect ever surfaces.
- Nothing to say means no card.  An absence under a minute isn't news either.

## Panels and modes
The status bar at the top is also the task-queue button: it already tells you what the farmer is doing, so it's where you reach when you want to know what's next, and it carries the queue count. This keeps the bottom row down to three buttons on a phone-width screen.

The sliding panels (Shop, Tasks, Bag) only cover part of the screen, so the map stays visible above them.  That made it easy to be "still in Build mode" while shopping and quietly put down a fence with a stray tap.

- Opening any panel **drops the tool back to plain Tap** and closes the tool's sub-picker, so nothing destructive stays armed behind it.
- Opening a panel also abandons a half-finished tilling row or placement ghost.
- **Tapping the map while a panel is open dismisses the panel** rather than acting on the tile.  One tap to get out, and it can't cost you anything.
- Only one panel is up at a time; opening one closes the others.

## Settings

The gear button opens a settings panel, which is where anything that isn't
playing the farm lives.

**Back up your farm.** The whole save as text, with a Copy button. Browsers clear
site data on their own schedule, so a player who cares about a long-running farm
should keep a copy somewhere. If the clipboard is refused (iOS does this), the
text is selected instead so it can be copied by hand.

**Restore a farm.** Paste a backup and confirm. Anything doubtful is rejected
outright with a reason — an import replaces a farm that might be weeks old, so
half-loading is worse than failing. Saves from older versions are migrated on the
way in; saves from a newer version are refused.

**Debug.** Top up supplies, and start a new farm. These were console-only, which
is no use on the phone the game is actually played on.

## Task management
- Tasks should be cancelable. 
- There should be a way to prioritize tasks to the top of the queue
- When building things like roads or tilling/harvesting, while each tile is its own task the UI should allow us to drag to "paint"

# Tasks
Include but not limted too:
- harvest - harvests crop / milks cow
- build <x>
- pick up - puts into inventory
- chop tree - puts wood into inventory

## The Farmer
The farmer is an NPC that does each task in their queue in order.   He/She has the ability to pathfind to each task and moves to the task's location to complete it.   If it can't complete a task that task goes to the end of the list and retried later.  When there are no tasks, the farmer randomly moves about.   

Farmers can automatically open/close gates to move through them

## Thoughts 
- There's farm tiles but IDK what to do with them gameplay wise yet.
- It should be possible to buy more land at some point