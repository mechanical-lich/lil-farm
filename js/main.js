// Entry point: load or create a farm, replay the time you were away, then run.

import { TILE, TICK_MS, START_INVENTORY, TESTING } from './config.js';
import { loadSheets } from './render/sprites.js';
import { Renderer } from './render/renderer.js';
import { Camera } from './render/camera.js';
import { GameLoop, runCatchup, discardSkipped } from './engine/loop.js';
import { loadSave, clearSave, Autosaver } from './engine/save.js';
import { newGame, serialize, deserialize } from './state.js';
import { tick as simTick } from './sim/tick.js';
import { addTask, taskForTile, taskLabel, queueTillRow, taskCovering, cancelTask } from './sim/tasks.js';
import { itemName, addItem } from './sim/inventory.js';
import {
  canAfford, buildDef, canPlaceAt, isReserved,
  snapBarn, BARN_LIMITS, barnCapacity, costLabel, placementProblem,
} from './sim/build.js';
import { drawBuilding } from './render/tilerender.js';
import { flowerCanvas } from './render/flowerart.js';
import { addCatch } from './render/effects.js';
import { canPlantAt } from './sim/flowers.js';
import { cropAt, isRipe } from './sim/crops.js';
import { readSeedId, seedName } from './sim/flowergenes.js';
import { drawAnimalSprite, drawHandSprite } from './render/entityrender.js';
import { drawObjectSprite } from './render/tilerender.js';
import { DECOR, decorDef, canPlaceDecor, placeDecor } from './sim/decor.js';
import { movableAt, canMoveTo, moveTo } from './sim/moving.js';
import {
  animalDef, animalAt, petAnimal, isReady, animalVariantCount,
} from './sim/animals.js';
import { buyAnimal, canPlaceAnimal, hireHand } from './sim/shop.js';
import { PLOT, plotBounds } from './world/land.js';
import { attachInput } from './ui/input.js';
import { initToolbar, TOOLS } from './ui/toolbar.js';
import { initTaskPanel } from './ui/taskpanel.js';
import { initMarketPanel } from './ui/marketpanel.js';
import { initShopPanel } from './ui/shoppanel.js';
import { initSettingsPanel } from './ui/settingspanel.js';
import { initHud } from './ui/hud.js';
import { initToasts, toast } from './ui/toast.js';
import { buildSummary, showSummary } from './ui/summary.js';
import * as events from './engine/events.js';

const els = {
  canvas: document.getElementById('game'),
  boot: document.getElementById('boot'),
  bootText: document.getElementById('boot-text'),
  debug: document.getElementById('debug'),
  paintToggle: document.getElementById('paint-toggle'),
};

/**
 * Development handle. Populated during boot so the console can poke at the
 * live farm (inspect state, force a save, wipe and regenerate).
 */
window.lilfarm = { events };

boot().catch((err) => {
  console.error(err);
  els.bootText.textContent = `Something went wrong: ${err.message}`;
});

async function boot() {
  const sheets = await loadSheets();

  const saved = loadSave();
  const state = saved ? deserialize(saved) : newGame();
  const isNew = !saved;

  const camera = new Camera(state.grid.w, state.grid.h);
  const renderer = new Renderer(els.canvas, sheets, camera);
  camera.centerOnTile(state.farmer.x, state.farmer.y);

  // Replay the time the tab was closed before the first paint, so the player
  // never sees a stale farm snap forward a moment later.
  const away = Date.now() - state.lastTickTime;
  const catchup = await runCatchup(away, () => simTick(state), (done, total) => {
    els.bootText.textContent = `Catching up… ${Math.round((done / total) * 100)}%`;
  });
  // Anything past the cap is written off rather than left on the clock, or it
  // comes back as a fresh seven-day backlog every time the game is opened.
  discardSkipped(state, catchup);

  initToasts();
  const autosaver = new Autosaver(() => serialize(state));
  const hud = initHud(state, {
    // From the seed drawer straight out to the map: the journal steps aside,
    // the flower is sited, and the drawer comes back exactly as it was left.
    onPlantFlower: (seedId, reopen) => {
      const at = camera.centreTile();
      beginPlacement(flowerPlacement(state, seedId, reopen), at.x, at.y);
    },
  });
  initTaskPanel(state);
  initMarketPanel(state);
  initShopPanel(state, {
    onMessage: (msg, kind) => toast(msg, kind),
    // Land is bought from the little map in the shop, so nothing to site here —
    // just take the player out to look at what they just bought.
    onLandBought: (px, py) => {
      const b = plotBounds(px, py);
      camera.centerOnTile(b.x0 + PLOT / 2, b.y0 + PLOT / 2);
    },
    // Every one of these starts its ghost in the middle of what is already on
    // screen, and moves the camera nowhere.
    //
    // They used to start it on the farmer and centre on him, which was the
    // wrong end of the problem: the farmer is usually off doing a job at the
    // far side of the farm, so buying something threw the player away from the
    // spot they had just navigated to in order to put it there. Where you are
    // looking is where you meant to build.
    onPlaceDecor: (kind, reopenShop) => {
      const at = camera.centreTile();
      beginPlacement(decorPlacement(state, kind, reopenShop), at.x, at.y);
      toast(`Tap where the ${decorDef(kind).name.toLowerCase()} should go`);
    },
    onPlaceHand: () => {
      const at = camera.centreTile();
      beginPlacement(handPlacement(state), at.x, at.y);
      toast('Tap where your farmhand should start');
    },
    onPlaceAnimal: (type) => {
      const at = camera.centreTile();
      beginPlacement(animalPlacement(state, type), at.x, at.y);
      toast(`Tap where your ${type} should go`);
    },
  });
  // A landed fish flies from the water to whoever caught it. Started from the
  // event rather than polled, and suppressed during catch-up like every other
  // event, so a week away does not come back to a screenful of them.
  events.on('fish:caught', ({ x, y, sprite, name, first }) => {
    addCatch(performance.now(), {
      fromX: x, fromY: y, toX: state.farmer.x, toY: state.farmer.y, sprite,
    });
    toast(first ? `A ${name.toLowerCase()} — your first!` : `Caught a ${name.toLowerCase()}`);
  });

  wireToastFeedback();

  const toolbar = initToolbar(state, {
    // One-shot buttons on the bar, which do something and leave the tool alone.
    onAction: (id) => {
      if (id !== 'findFarmer') return;
      camera.centerOnTile(state.farmer.x, state.farmer.y);
      renderer.invalidate?.();
    },
    onToolChange: (t) => {
      // Leaving the till tool mid-selection must not strand a dangling anchor.
      tillSelection.tillAnchor = null;
      clearPlacement();
      const def = TOOLS.find((x) => x.id === t);
      if (def) toast(def.hint);
    },
  });
  initSettingsPanel(state, {
    serialize: () => serialize(state),
    autosaver,
    onMessage: (msg, kind) => toast(msg, kind),
  });
  const paintMode = wirePaintToggle();
  wirePlacementButtons();
  wirePanelTracking();
  wireLifecycle(autosaver, renderer, camera);

  attachInput(els.canvas, camera, {
    onTap: (x, y) => queueTileTask(state, toolbar, x, y, { announce: true }),
    onPaint: (x, y) => queueTileTask(state, toolbar, x, y, { announce: false }),
    isPaintMode: () => paintMode.isOn(),

    // Carrying things about, with the move tool selected.
    onGrab: (x, y) => {
      if (toolbar.getTool() !== 'move' || openPanel || placement.pending) return false;
      const found = movableAt(state, x, y);
      if (!found) return false;
      carried.what = found;
      carried.x = x;
      carried.y = y;
      carried.valid = true;
      return true;
    },
    onCarry: (x, y) => {
      if (!carried.what) return;
      carried.x = x;
      carried.y = y;
      carried.valid = canMoveTo(state, carried.what, x, y);
    },
    onDrop: (x, y) => {
      const what = carried.what;
      carried.what = null;
      if (!what) return;
      const res = moveTo(state, what, x, y);
      toast(res.ok ? `Moved the ${what.name}` : res.reason, res.ok ? undefined : 'warn');
    },
  });

  const loop = new GameLoop(
    () => {
      simTick(state);
      autosaver.markDirty(Date.now());
    },
    (alpha) => {
      const now = Date.now();
      // Everything below the save is only worth doing on a frame that actually
      // drew — the HUD and the debug line are DOM writes, and the point of
      // skipping the frame is not to touch anything.
      const drew = renderer.drawIfNeeded(
        state, alpha,
        { ...tillSelection, pending: placement.pending, carried: carried.what ? carried : null },
        now,
      );
      autosaver.maybeSave(now);
      if (drew) {
        hud.renderStatus();
        updateDebug(state, catchup, isNew);
      }
    },
    // A burst run with events suspended leaves the HUD showing whatever it
    // showed before; a full redraw puts the money and the bag back in step.
    { onQuietCatchup: () => hud.render() },
  );

  loop.start(Date.now());
  wireWakeUp(state, loop);

  Object.assign(window.lilfarm, {
    state, camera, renderer, loop, autosaver,
    // Exposed for poking at siting flows from the console; the ghost is
    // otherwise invisible to anything but the renderer.
    placement,
    save: () => autosaver.saveNow(),
    // Order matters: stop autosaving before clearing, or the unload handlers
    // write this farm straight back over the cleared slot.
    wipe: () => { autosaver.disable(); clearSave(); location.reload(); },

    /**
     * Top up a farm in progress, e.g. lilfarm.give({ wood: 200 }) or
     * lilfarm.give() for the full testing kit. Beats wiping when you want to
     * keep the farm you were already testing on.
     */
    give: (items = START_INVENTORY, money = 0) => {
      for (const [id, qty] of Object.entries(items)) addItem(state, id, qty);
      if (money) { state.money += money; events.emit('money:changed', { delta: money }); }
      return { money: state.money, inventory: state.inventory };
    },
  });

  els.boot.classList.add('hidden');
  reportReturn(state, catchup, isNew);
  registerServiceWorker();
}

/**
 * Registers the service worker, which makes the game installable to the home
 * screen and openable with no connection.
 *
 * Worth doing beyond convenience: Safari clears script-writable storage for
 * sites that go unvisited for a stretch, and a home-screen web app is treated
 * more durably than a tab. Installing is the main protection for the save.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // Skipped during local development: the worker serves assets cache-first, so
  // with it running an edited file keeps showing the old version until the
  // cache is cleared, which is a miserable way to work. Append ?sw=1 to test
  // the installable build locally.
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const forced = new URLSearchParams(location.search).has('sw');
  if (local && !forced) {
    // Tidy up after a previous ?sw=1 run, so a stale worker can't linger and
    // start masking edits later.
    navigator.serviceWorker.getRegistrations()
      .then((regs) => regs.forEach((r) => r.unregister()))
      .catch(() => {});
    return;
  }

  // A page that already has a controller and then gets a new one is looking at
  // a fresh deploy: the new worker called skipWaiting and claimed this client,
  // but the modules already running came from the old cache. Reload once so the
  // player actually sees the update instead of the previous build.
  //
  // Guarded twice: `hadController` skips the very first install (where a
  // controller appearing is normal, not an update), and `reloading` stops any
  // chance of a loop.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  // Relative path, so it works from a GitHub Pages subpath as well as a root.
  navigator.serviceWorker.register('sw.js').catch((err) => {
    // Not fatal — the game runs fine unregistered, just not offline.
    console.warn('service worker registration failed', err);
  });
}

/**
 * Tilling is a two-tap gesture rather than a per-tile one: the first tap sets
 * one end of a row, the second the other. The row is snapped to a single axis,
 * because beds run in rows and the soil art can only cap a row's two ends.
 */
const tillSelection = { tillAnchor: null };

function handleTillTap(state, x, y) {
  if (!state.grid.inBounds(x, y)) return;

  if (!tillSelection.tillAnchor) {
    tillSelection.tillAnchor = { x, y };
    toast('Now tap the other end of the row');
    return;
  }

  const a = tillSelection.tillAnchor;
  tillSelection.tillAnchor = null;

  // Tapping the same tile twice means a single-tile bed, which is legitimate.
  const { queued, skipped, dir } = queueTillRow(state, a, { x, y });

  if (queued === 0) {
    toast('Nothing tillable along that row');
    return;
  }
  const axis = dir === 'h' ? 'across' : 'down';
  toast(skipped
    ? `Tilling ${queued} ${axis} (${skipped} skipped)`
    : `Tilling ${queued} ${axis}`);
}

/**
 * Siting a large structure. Small things drop straight onto the tapped tile,
 * but a barn is three tiles by two and costs 50 wood, so it gets a ghost
 * preview and an explicit confirmation instead of being placed blind.
 */
const placement = { pending: null };

/**
 * What the player currently has hold of with the move tool: the thing itself,
 * and where it would land if they let go now.
 */
const carried = { what: null, x: 0, y: 0, valid: false };

/**
 * Which sliding panel is up, if any. Tracked here so a tap on the map can
 * dismiss it instead of acting on the tile underneath.
 */
let openPanel = null;

function wirePanelTracking() {
  events.on('panel:open', (name) => {
    openPanel = name;
    carried.what = null;
    // Opening a panel abandons any half-finished siting or row selection, so
    // nothing is left armed behind it.
    tillSelection.tillAnchor = null;
    clearPlacement();
  });
  events.on('panel:close', (name) => {
    if (openPanel === name) openPanel = null;
  });
}

/**
 * Starts siting something. The spec supplies its own footprint, validity rule,
 * ghost drawing and what to do on confirm, so the same flow serves a barn (a
 * queued build task) and a livestock purchase (an immediate transaction).
 */
function beginPlacement(spec, x, y) {
  placement.pending = { ...spec, ...pointAt(spec, x, y) };
  renderConfirmBar();
}

function movePlacement(x, y) {
  const p = placement.pending;
  if (!p) return;
  Object.assign(p, pointAt(p, x, y));
  renderConfirmBar();
}

/**
 * Where a tap puts the thing being sited, and whether it may go there.
 *
 * Most specs answer straight away. A barn answers differently the second time
 * it is asked, because the player is picking two corners rather than one spot,
 * so `pick` owns both the geometry and the verdict.
 */
function pointAt(spec, x, y) {
  if (spec.pick) return spec.pick(x, y);
  const at = spec.snap ? spec.snap(x, y) : { x, y };
  return { ...at, valid: spec.validate(at.x, at.y) };
}

function clearPlacement() {
  placement.pending = null;
  renderConfirmBar();
}

function renderConfirmBar() {
  const bar = document.getElementById('confirm-bar');
  const ok = document.getElementById('confirm-place');
  const hint = document.getElementById('place-hint');
  const p = placement.pending;
  bar.classList.toggle('open', p !== null);
  if (p) {
    ok.disabled = !p.valid;
    ok.textContent = p.label || p.confirmLabel || '✓ Place here';
    hint.textContent = p.hint || '';
    hint.classList.toggle('warn', Boolean(p.hint) && !p.valid);
  }
}

/** Siting a structure: confirming queues a build task for the farmer. */
function buildingPlacement(state, kind, size) {
  const def = buildDef(kind);
  const [w, h] = size || def.size;
  return {
    w, h,
    confirmLabel: `✓ Build ${def.name.toLowerCase()} here`,
    validate: (x, y) => canPlaceAt(state, kind, x, y, [w, h]),
    draw: (ctx, sheets, at) => drawBuilding(ctx, sheets, { ...at, type: kind, w, h }),
    confirm: (x, y) => {
      const spec = taskForTile(state, x, y, 'build', { buildKind: kind, size: [w, h] });
      if (!spec) return { ok: false, reason: "that won't fit there" };
      addTask(state, spec);
      return { ok: true, message: `Queued: ${def.name}` };
    },
  };
}

/**
 * Siting a barn — the one structure whose size the player chooses.
 *
 * Two taps, not one: a corner, then the opposite corner. A single tap can only
 * ever place a fixed stamp, and the whole point here is that the player decides
 * how much of the farm the building takes.
 *
 * The rectangle is snapped *down* to something buildable, so what is drawn is
 * never larger than what was asked for — the barn fits inside the ground you
 * marked out rather than spilling past it. Everything the choice costs is on
 * screen before it is confirmed, because at three hundred wood a wrong barn is
 * an expensive thing to find out about afterwards.
 */
function barnPlacement(state, kind) {
  const def = buildDef(kind);
  // Barns and houses are both dragged out, and they don't agree on what a legal
  // rectangle is — a barn insists on an odd width for its ridge board, a house
  // has no ridge to miss. The recipe carries its own limits, and the label says
  // whichever thing is actually being built.
  const limits = def.limits || BARN_LIMITS;
  const noun = def.name.toLowerCase();
  let anchor = null;

  return {
    w: 1,
    h: 1,
    // The ghost draws itself at whatever size the two corners currently imply.
    draw: (ctx, sheets, at) => {
      if (at.w < limits.minW || at.h < limits.minH) return;
      drawBuilding(ctx, sheets, { ...at, type: def.building });
    },
    pick: (x, y) => {
      if (!anchor) {
        anchor = { x, y };
        return {
          x, y, w: 1, h: 1, valid: false,
          label: `✓ Build ${noun}`, hint: 'Now tap the opposite corner',
        };
      }

      const box = snapBarn(anchor.x, anchor.y, x, y, limits);
      if (!box) {
        // Show the rectangle they actually drew, so it is obvious how short it
        // falls rather than the ghost silently refusing to appear.
        return {
          x: Math.min(anchor.x, x), y: Math.min(anchor.y, y),
          w: Math.abs(x - anchor.x) + 1, h: Math.abs(y - anchor.y) + 1,
          valid: false, label: `✓ Build ${noun}`,
          hint: `A ${noun} is at least ${limits.minW} by ${limits.minH}`,
        };
      }

      const size = [box.w, box.h];
      const problem = placementProblem(state, kind, box.x, box.y, size);
      const afford = canAfford(state, kind, size);
      const label = `✓ Build ${box.w}×${box.h} ${noun}`;
      if (problem) {
        // Say which rule was broken. "Something is in the way" covered running
        // off the edge of the player's own land too, and sent them hunting for
        // scenery that wasn't there.
        return { ...box, valid: false, label, hint: problem[0].toUpperCase() + problem.slice(1) };
      }
      if (!afford.ok) {
        return {
          ...box, valid: false, label,
          hint: `Needs ${costLabel(kind, size)} — not enough ${itemName(afford.missing).toLowerCase()}`,
        };
      }
      return {
        ...box, valid: true, label,
        hint: `${costLabel(kind, size)} · houses ${barnCapacity(box.w, box.h)}`,
      };
    },
    confirm: (x, y) => {
      const p = placement.pending;
      const size = [p.w, p.h];
      const spec = taskForTile(state, x, y, 'build', { buildKind: kind, size });
      if (!spec) return { ok: false, reason: "that won't fit there" };
      addTask(state, spec);
      return { ok: true, message: `Queued: ${p.w}×${p.h} ${def.name.toLowerCase()}` };
    },
  };
}

/**
 * Siting a flower from the seed drawer.
 *
 * The ghost is the flower itself, in the colour those seeds will actually
 * grow — the whole point of keeping a particular seed is its colour, so
 * showing a generic sprite would be showing the one thing that does not
 * matter. Confirming queues the planting for the farmer rather than putting
 * the flower straight in the ground: it is work, like everything else.
 */
function flowerPlacement(state, seedId, reopen) {
  const seed = readSeedId(seedId);
  const label = seedName(seedId).replace(/ seeds$/, '');
  return {
    w: 1,
    h: 1,
    after: reopen,
    confirmLabel: `✓ Plant the ${label.toLowerCase()} here`,
    validate: (x, y) => !!seed && canPlantAt(state, x, y),
    draw: (ctx, sheets, at) => {
      const art = seed && flowerCanvas(seed.kind, seed.genome);
      if (art) ctx.drawImage(art, at.x * TILE, at.y * TILE);
    },
    confirm: (x, y) => {
      const spec = taskForTile(state, x, y, 'plantflower', { seedId });
      if (!spec) return { ok: false, reason: "it won't grow there" };
      addTask(state, spec);
      return { ok: true, message: `Queued: plant ${label.toLowerCase()}` };
    },
  };
}

/**
 * Siting a livestock purchase. Money changes hands only on confirm, so backing
 * out costs nothing — and the player gets to say where the animal lives rather
 * than having it dumped wherever the farmer happened to be standing.
 */
function animalPlacement(state, type) {
  const def = animalDef(type);
  return {
    w: 1, h: 1,
    confirmLabel: `✓ Put ${def.name.toLowerCase()} here`,
    validate: (x, y) => canPlaceAnimal(state, x, y, type),
    // The colour is rolled when the sale goes through, so the ghost can't know
    // it. Rather than show one and hand over another, it cycles through the
    // colours — which says "you'll get one of these" without promising which.
    draw: (ctx, sheets, at) => drawAnimalSprite(ctx, sheets, type, at,
      Math.floor(state.tickCount / 2) % animalVariantCount()),
    confirm: (x, y) => {
      const res = buyAnimal(state, type, x, y);
      return res.ok
        ? { ok: true, message: `${def.name} bought for $${res.spent}` }
        : { ok: false, reason: res.reason };
    },
  };
}

/** Siting a decoration. Nothing is charged until it's put down. */
function decorPlacement(state, kind, onPlaced) {
  const def = decorDef(kind);
  return {
    w: 1, h: 1,
    // Straight back to the shop, on the same tab and at the same scroll
    // position, so a row of bushes is six taps rather than thirty.
    after: onPlaced,
    confirmLabel: `✓ Put the ${def.name.toLowerCase()} here ($${def.price})`,
    validate: (x, y) => canPlaceDecor(state, x, y),
    draw: (ctx, sheets, at) => drawObjectSprite(ctx, sheets, state, def.obj, at),
    confirm: (x, y) => {
      const res = placeDecor(state, kind, x, y);
      return res.ok
        ? { ok: true, message: `${def.name} placed for $${res.spent}` }
        : { ok: false, reason: res.reason };
    },
  };
}

/** Siting a new farmhand. Same flow as livestock: nothing is paid until you say. */
function handPlacement(state) {
  return {
    w: 1, h: 1,
    confirmLabel: '✓ Start them here',
    validate: (x, y) => canPlaceAnimal(state, x, y),
    draw: (ctx, sheets, at) => drawHandSprite(ctx, sheets, at),
    confirm: (x, y) => {
      const res = hireHand(state, x, y);
      return res.ok
        ? { ok: true, message: `Farmhand hired for $${res.spent}` }
        : { ok: false, reason: res.reason };
    },
  };
}

function wirePlacementButtons() {
  document.getElementById('cancel-place').addEventListener('click', clearPlacement);
  document.getElementById('confirm-place').addEventListener('click', () => {
    const p = placement.pending;
    if (!p || !p.valid) return;

    const res = p.confirm(p.x, p.y);
    if (!res.ok) { toast(res.reason, 'warn'); return; }
    toast(res.message);
    clearPlacement();
    p.after?.();
  });
}

/** Queues the action the current tool implies for a tile, if any. */
function queueTileTask(state, toolbar, x, y, { announce }) {
  const tool = toolbar.getTool();

  // A panel only covers part of the screen. Tapping the map while one is open
  // dismisses it rather than acting on the tile — otherwise a stray tap on the
  // visible strip does farm work the player never meant to queue.
  if (openPanel) {
    if (announce) events.emit('panel:dismiss');
    return;
  }

  // While something is being sited, taps reposition the ghost rather than doing
  // whatever the current tool would normally do.
  if (placement.pending) {
    if (announce) movePlacement(x, y);
    return;
  }

  // Calling work off rather than adding any. It sits after the panel and
  // placement guards — a tap meant to dismiss a panel must not cancel work
  // instead — but before every tool below, because it is the one that wants
  // tiles the others refuse: ground already spoken for by a queued build is
  // exactly where the thing you are trying to call off is standing.
  if (tool === 'cancel') {
    const task = taskCovering(state, x, y);
    if (!task) {
      if (announce) toast('Nothing queued there');
      return;
    }
    const what = taskLabel(task);
    cancelTask(state, task.id);
    // Drag-painting cancels a swathe, which is how a mis-drag is undone by the
    // same gesture that made it — so only a deliberate tap says anything.
    if (announce) toast(`Called off: ${what}`);
    return;
  }

  if (tool === 'till') {
    // Painting is meaningless here; the row gesture replaces it entirely.
    if (announce) handleTillTap(state, x, y);
    return;
  }

  // Building is gated on materials, and the check has to account for everything
  // already queued — otherwise you could order ten fences with wood for two.
  if (tool === 'build') {
    const kind = toolbar.getBuildKind();
    const afford = canAfford(state, kind);
    if (!afford.ok) {
      if (announce) toast(`Not enough ${itemName(afford.missing).toLowerCase()}`, 'warn');
      return;
    }
    // Buildings are sited with a preview; everything else drops on the tap.
    if (buildDef(kind).building) {
      if (announce) {
        beginPlacement(buildDef(kind).sizable
          ? barnPlacement(state, kind)
          : buildingPlacement(state, kind), x, y);
      }
      return;
    }
  }

  // Unowned land absorbs every tool, so say why rather than looking broken.
  if (!state.grid.isOwned(x, y)) {
    if (announce) toast("You don't own that land — buy it from the shop", 'warn');
    return;
  }

  // Tapping an animal that doesn't want anything is petting it. Not a task:
  // the farmer isn't sent to do this, the player is doing it themselves. An
  // animal with something to give still hands it over first — you'd rather have
  // the egg than the cuddle, and the cuddle is still there afterwards.
  if (tool === 'auto' && announce) {
    const animal = animalAt(state, x, y);
    if (animal && !isReady(animal)) {
      const name = animalDef(animal.type).name.toLowerCase();
      const { gained } = petAnimal(state, animal);
      toast(gained
        ? `The ${name} loves the attention`
        : `The ${name} has had plenty of fuss for now`);
      return;
    }
  }

  const spec = taskForTile(state, x, y, tool, {
    cropType: toolbar.getCropType(),
    buildKind: toolbar.getBuildKind(),
  });
  if (!spec) {
    if (announce) toast(noWorkReason(state, tool, toolbar, x, y));
    return;
  }
  const task = addTask(state, spec);
  if (task && announce) toast(`Queued: ${taskLabel(task)}`);
}

/** Explains an ignored tap, since silence just reads as a broken button. */
function noWorkReason(state, tool, toolbar, x, y) {
  // A tile promised to a queued build looks empty but refuses everything, so
  // say which it is rather than leaving the player prodding at it.
  if (isReserved(state, x, y)) return "You've already got something queued there";

  switch (tool) {
    case 'build': {
      const def = buildDef(toolbar.getBuildKind());
      return def && def.size[0] > 1
        ? `A ${def.name.toLowerCase()} needs two clear tiles side by side`
        : 'Something is already there';
    }
    case 'till': return 'Till needs clear, empty ground';
    case 'plant': return 'Plant on tilled soil — and pick a seed you own';
    case 'water': {
      // Since watering skips tiles it would do nothing to, the commonest
      // ignored tap is now a bed that simply doesn't need it — saying "only
      // tilled soil" there would be answering a question nobody asked.
      const crop = cropAt(state, x, y);
      if (crop && !crop.dead) {
        if (isRipe(crop)) return 'That one is ready to pick, not water';
        if (crop.watered) return 'That bed is already growing nicely';
      }
      return 'Only tilled soil can be watered';
    }
    case 'harvest': return 'Nothing ready to harvest there';
    case 'clear': return 'Nothing to clear there (harvest a bed before clearing it)';
    default: return 'Nothing to do there';
  }
}

function wirePaintToggle() {
  let on = false;
  const render = () => {
    els.paintToggle.classList.toggle('on', on);
    els.paintToggle.textContent = on ? '🖌 Paint' : '✋ Pan';
  };
  els.paintToggle.addEventListener('click', () => {
    on = !on;
    render();
    toast(on ? 'Drag across the farm to queue work' : 'Drag to move the view');
  });
  render();
  return { isOn: () => on };
}

/** Turns simulation events into player-visible feedback. */
function wireToastFeedback() {
  events.on('mushroom:found', ({ name, first }) => {
    toast(first ? `New find: ${name}!` : `Picked a ${name.toLowerCase()}`);
  });

  events.on('task:done', ({ gained }) => {
    if (!gained) return;
    const parts = Object.entries(gained).map(([id, n]) => `+${n} ${itemName(id)}`);
    if (parts.length) toast(parts.join(', '));
  });

  // Losing a crop is the one thing a player must never discover only by
  // noticing an empty field later.
  events.on('crop:died', ({ type }) => {
    toast(`Your ${type} spoiled — it sat unharvested too long`, 'warn');
  });

  events.on('task:failed', ({ reason }) => toast(`Couldn't finish: ${reason}`, 'warn'));

  events.on('animal:ready', ({ type }) => toast(`Your ${type} has something for you`));

  // The design doc calls for unreachable tasks to be retried later rather than
  // silently dropped; say so, or the player thinks the farmer is stuck.
  let lastWarn = 0;
  events.on('task:unreachable', ({ task }) => {
    const now = Date.now();
    if (now - lastWarn < 4000) return;   // one grumble at a time
    lastWarn = now;
    toast(`Can't reach that ${task.detail || 'spot'} — trying later`, 'warn');
  });
}

/**
 * Catches the farm up when the tab comes back.
 *
 * Nothing runs in a backgrounded tab — requestAnimationFrame stops — so the
 * simulation falls behind wall-clock for as long as it's hidden. It used to
 * stay behind for the rest of the session: pump runs at most a few hundred
 * ticks and then resyncs its own clock, writing off the rest, and only a
 * reload put it right. Replaying the gap on the way back in, quietly, is what
 * makes "the farm keeps running" true within a session as well as across one.
 */
const WAKE_SUMMARY_MIN_MS = 10 * 60 * 1000;

function wireWakeUp(state, loop) {
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;

    const away = Date.now() - state.lastTickTime;
    if (away < TICK_MS * 2) return;              // a glance away; pump will cope

    const catchup = await runCatchup(away, () => simTick(state));
    discardSkipped(state, catchup);
    // The simulation is now level with the wall clock, so the loop must not
    // also try to make up the same stretch of time.
    loop.resync(Date.now());

    // Only for a real absence. The card is a "welcome back", and getting one
    // for glancing at another tab for two minutes is nagging, not news.
    if (away >= WAKE_SUMMARY_MIN_MS) {
      const summary = buildSummary(state, catchup);
      if (summary) showSummary(summary);
    }
  });
}

function wireLifecycle(autosaver, renderer, camera) {
  // iOS Safari suspends and eventually kills background tabs, often without a
  // second chance to run code. Write on every hide, not just on unload.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosaver.saveNow();
  });
  window.addEventListener('pagehide', () => autosaver.saveNow());

  /**
   * How far the view may be pushed past the edge of the map.
   *
   * The top bar and the bottom controls float *over* the canvas, so the tiles
   * beneath them can be seen but not tapped. Letting the view run on by the
   * height of each bar is what makes the first and last rows of the valley
   * reachable — scroll the row out from under the bar and into the open.
   *
   * Measured from the bars themselves rather than written down, because they
   * change height: the build tools add a second row, siting something adds the
   * confirm bar above that, and a phone in landscape is different again.
   */
  const applyInsets = () => {
    const hud = document.getElementById('hud');
    const bottom = document.getElementById('bottom');
    const view = renderer.canvas?.clientHeight || window.innerHeight;
    camera.setInset({
      top: Math.round(hud.getBoundingClientRect().bottom),
      bottom: Math.round(view - bottom.getBoundingClientRect().top),
    });
    renderer.invalidate();
  };

  let resizeTimer = 0;
  const doResize = () => { renderer.resize(); applyInsets(); };
  // The bottom stack grows and shrinks as tools are picked and things are
  // sited — the build tools add a row, siting one adds the confirm bar above
  // that — and the reachable area has to follow it. Watched rather than
  // wired to a list of events, because the list would be a list of everything
  // that can change a height, and it would be wrong the first time somebody
  // added a row without knowing to update it.
  applyInsets();
  if (typeof ResizeObserver === 'function') {
    const watch = new ResizeObserver(applyInsets);
    watch.observe(document.getElementById('bottom'));
    watch.observe(document.getElementById('hud'));
  }

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(doResize, 100);
  });
  window.addEventListener('orientationchange', () => setTimeout(doResize, 200));
}

function reportReturn(state, catchup, isNew) {
  if (isNew) {
    toast('Welcome to your lil farm!');
    return;
  }
  // A card rather than a toast: coming back to a farm that ran without you is
  // the point of the whole design, and it deserves more than a line that fades.
  showSummary(buildSummary(state, catchup));
}

function updateDebug(state, catchup, isNew) {
  if (!els.debug) return;
  const behind = Math.max(0, Math.round((Date.now() - state.lastTickTime) / TICK_MS));
  els.debug.textContent =
    `tick ${state.tickCount} | behind ${behind} | catchup ${catchup.ticks}` +
    `${catchup.capped ? ' (capped)' : ''} | ${isNew ? 'new' : 'loaded'} | ` +
    `farmer ${state.farmer.x},${state.farmer.y} | tasks ${state.tasks.length}` +
    // Loud on purpose: shipping with the testing kit on would skip the whole
    // early game without anyone noticing.
    `${TESTING ? ' | ⚠ TESTING START' : ''}`;
}
