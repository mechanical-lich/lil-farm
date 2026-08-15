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

## New Game State
When you first start the game you are given a plot of land that has to be cleaned up.   There will be rocks, trees, dead trees, and weeds.   You can queue tasks to remove obstacles, pull weeds, and cut trees.   

## Inventory
Some tasks suchs as harvesting a crop, cutting a tree, milking a cow, collecting eggs, etc will add items to your inventory. 

## Shop
There is a shop where you can sell items in your inventory and buy new items such as crops from a rotating selection, livestock, and materials like lumber for construction.

- Buy and sell are two tabs of one panel.  Quantities are coarse (1 / 5 / all) rather than a stepper, because tapping "+" ten times on a phone is miserable.
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

### Animals never die
**Animals can not die, ever.**  Neglect costs you production, never the animal itself.

- If an animal doesn't get food or water it simply stops progressing toward being harvestable — no eggs, no milk.  It keeps wandering and waiting.
- Feeding and watering it again resumes production.  There is no permanent penalty and no way to lose an animal you paid for.
- This is deliberately **different from crops**, which do die if they aren't watered in time.  The asymmetry is the point: a crop is a cheap, replaceable seed, while an animal is an expensive purchase.  In a game you're meant to be able to walk away from for days, coming back to a dead cow you bought would feel awful.  Do not "fix" this inconsistency by adding animal death.
- A neglected animal must be visibly neglected — a hungry/thirsty marker — so an idle barn reads as "they need feeding", not as a bug.

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