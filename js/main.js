// Entry point: load or create a farm, replay the time you were away, then run.

import {
  TILE, TICK_MS, START_INVENTORY, TESTING, CATCHUP_SLICE_MS, CATCHUP_HIDDEN_SLICE_MS,
  MAX_CATCHUP_TICKS,
} from './config.js';
import { loadSheets, GOURD_DECOR } from './render/sprites.js';
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
import { cropAt, isRipe, CROPS } from './sim/crops.js';
import { canPlaceGourd, placeGourd } from './sim/gourddecor.js';
import { fishAt } from './sim/fish.js';
import { notePlayDay, earnedSince, achievementDef, notePet } from './sim/achievements.js';
import { noteParty } from './sim/balloons.js';
import { noteHalloween } from './sim/lanterns.js';
import { noteThanksgiving } from './sim/thanksgiving.js';
import { befriend, shoo } from './sim/wildlife.js';
import { readSeedId, seedName } from './sim/flowergenes.js';
import { drawAnimalSprite, drawHandSprite } from './render/entityrender.js';
import { drawObjectSprite, blit } from './render/tilerender.js';
import { DECOR, decorDef, canPlaceDecor, placeDecor } from './sim/decor.js';
import { movableAt, canMoveTo, moveTo } from './sim/moving.js';
import {
  animalDef, animalAt, animalShownAt, petAnimal, isReady, animalVariantCount,
  nameAnimal, calledAs,
} from './sim/animals.js';
import { buyAnimal, canPlaceAnimal, hireHand } from './sim/shop.js';
import { PLOT, plotBounds } from './world/land.js';
import { attachInput } from './ui/input.js';
import { initToolbar, TOOLS, CITY_TOOLS, SANCTUARY_TOOLS } from './ui/toolbar.js';
import { initTaskPanel } from './ui/taskpanel.js';
import { initMarketPanel } from './ui/marketpanel.js';
import { initShopPanel } from './ui/shoppanel.js';
import { initSettingsPanel } from './ui/settingspanel.js';
import { initHud } from './ui/hud.js';
import { initJournal } from './ui/journal.js';
import { initToasts, toast } from './ui/toast.js';
import { initAwards, showAward, clearAwards } from './ui/award.js';
import { buildSummary, showSummary } from './ui/summary.js';
import { openNamePanel, namePanelOpen } from './ui/namepanel.js';
import {
  cityDef, cityBuild, cityCost, cityPlacementProblem, cityStructureAt, cityDemolish, isBuilding,
  runTiles, cityRunPlan, cityBuildRun,
} from './sim/city.js';
import { drawPieceGhost } from './render/cityrender.js';
import { buildDemoCity, buildDemoSanctuary } from './sim/democity.js';
import {
  canSendToSanctuary, sendToSanctuary, bringHome, isSanctuaryKind, residentAt, residentsOf, penCapacity,
  penComforts, sanctuaryDemolish, collectDonations, donationsPerDay, kindsKept,
  residentMoveProblem, moveResident, residentLabel,
} from './sim/sanctuary.js';
import { hasAccess, housed, amenitiesNear, workingMachines } from './sim/citylife.js';
import { LINES, lineOn, setLine, lineRate } from './sim/factory.js';
import * as events from './engine/events.js';

const els = {
  canvas: document.getElementById('game'),
  boot: document.getElementById('boot'),
  bootText: document.getElementById('boot-text'),
  bootBar: document.getElementById('boot-bar'),
  bootFill: document.getElementById('boot-fill'),
  bootSub: document.getElementById('boot-sub'),
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
  sceneView.camera = camera;
  const renderer = new Renderer(els.canvas, sheets, camera);
  camera.centerOnTile(state.farmer.x, state.farmer.y);

  // Replay the time the tab was closed before the first paint, so the player
  // never sees a stale farm snap forward a moment later.
  const returnedAt = state.tickCount;
  const away = Date.now() - state.lastTickTime;
  const screen = catchupScreen(away);
  const catchup = await runCatchup(away, () => simTick(state), screen.onProgress, { sliceMs: catchupSlice });
  screen.done();
  // Anything past the cap is written off rather than left on the clock, or it
  // comes back as a fresh seven-day backlog every time the game is opened.
  discardSkipped(state, catchup);
  // Anything the farm earned while nobody was watching. Taken now, before
  // anything else can add to the list: events are suspended through catch-up
  // by design, so these never toasted, and the record's tick stamps are the
  // only way to find them again.
  const missed = earnedSince(state, returnedAt);

  initToasts();
  initAwards();
  const autosaver = new Autosaver(() => serialize(state));
  const hud = initHud(state, {
    // A gourd from the bag, set out on the farm. Starts where you are looking,
    // like everything else that gets put down.
    onPlaceGourd: (type, reopen) => {
      const at = camera.centreTile();
      beginPlacement(gourdPlacement(state, type, reopen), at.x, at.y);
      toast(`Tap where the ${CROPS[type].name.toLowerCase()} should go`);
    },
  });
  initJournal(state, {
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
    // A city or sanctuary lot takes the player to that place first.
    onLandBought: (px, py, where = 'farm') => {
      if (where !== sceneView.scene) sceneView.goTo?.(where);
      if (where !== 'farm') events.emit('city:changed', {});
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
    addCatch({ fromX: x, fromY: y, toX: state.farmer.x, toY: state.farmer.y, sprite });
    toast(first ? `A ${name.toLowerCase()} — your first!` : `Caught a ${name.toLowerCase()}`);
  });

  wireToastFeedback(state);

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
      // Each place has its own tool list, and its own words for what a tool
      // does there: the farm's Clear chops trees, the city's Demolish does not.
      const list = sceneView.scene === 'city' ? CITY_TOOLS : sceneView.scene === 'sanctuary' ? SANCTUARY_TOOLS : TOOLS;
      const def = list.find((x) => x.id === t);
      if (def) toast(def.hint);
    },
  });
  initSettingsPanel(state, {
    serialize: () => serialize(state),
    autosaver,
    onMessage: (msg, kind) => toast(msg, kind),
  });
  sceneView.goTo = wireSceneToggle(state, camera, renderer, toolbar).goTo;
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
      if (sceneView.scene === 'city') return false;
      if (toolbar.getTool() !== 'move' || openPanel || placement.pending) return false;
      // In the sanctuary the move tool picks up a resident, to put down
      // elsewhere in its enclosure or in another one with room.
      if (sceneView.scene === 'sanctuary') {
        const resident = residentAt(state.sanctuary, x, y);
        if (!resident) return false;
        carried.what = { kind: 'animal', ref: resident, resident: true };
        carried.x = x;
        carried.y = y;
        carried.valid = true;
        return true;
      }
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
      carried.valid = carried.what.resident
        ? !residentMoveProblem(state, carried.what.ref, x, y)
        : canMoveTo(state, carried.what, x, y);
    },
    onDrop: (x, y) => {
      const what = carried.what;
      carried.what = null;
      if (!what) return;
      if (what.resident) {
        const stayed = what.ref.x === x && what.ref.y === y;
        const res = moveResident(state, what.ref, x, y);
        const who = capitalise(residentLabel(what.ref));
        if (!res.ok) toast(capitalise(res.reason), 'warn');
        else if (res.moved) toast(`${who} moved to another enclosure`);
        else if (!stayed) toast(`Moved ${residentLabel(what.ref)}`);
        return;
      }
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
    wipe: () => { autosaver.disable(); clearAwards(); clearSave(); location.reload(); },

    /**
     * Top up a farm in progress, e.g. lilfarm.give({ wood: 200 }) or
     * lilfarm.give() for the full testing kit. Beats wiping when you want to
     * keep the farm you were already testing on.
     */
    /**
     * Puts down a finished, fully lived-in city for looking at — see
     * sim/democity.js. lilfarm.demoCity(true) replaces a city already built.
     */
    demoCity: (force = false) => {
      const res = buildDemoCity(state, { force });
      if (res.ok) { renderer.invalidate(); hud.render(); autosaver.saveNow(); }
      return res;
    },

    /** The same for the sanctuary: enclosures, trails and one of every animal. */
    demoSanctuary: (force = false) => {
      const res = buildDemoSanctuary(state, { force });
      if (res.ok) { renderer.invalidate(); hud.render(); autosaver.saveNow(); }
      return res;
    },

    give: (items = START_INVENTORY, money = 0) => {
      for (const [id, qty] of Object.entries(items)) addItem(state, id, qty);
      if (money) { state.money += money; events.emit('money:changed', { delta: money }); }
      return { money: state.money, inventory: state.inventory };
    },
  });

  els.boot.classList.add('hidden');
  reportReturn(state, catchup, isNew);
  for (const id of missed) announceAward(achievementDef(id));
  // Opening the game at all is what the day streak counts, so this goes in
  // once per boot — after the toasts exist, since it can earn one outright.
  notePlayDay(state, today());

  // And the balloons, which are only out for the week of her birthday. The
  // simulation cannot read a clock, so the date is handed in here and the
  // spawner runs off what this decides. See sim/balloons.js.
  const party = noteParty(state, today());
  if (party.fresh) {
    toast(party.birthday
      ? '🎈 Happy birthday! There are balloons out on the farm'
      : '🎈 There are balloons out on the farm');
  }
  // And October's jack-o'-lanterns, the same way. See sim/lanterns.js.
  const spooky = noteHalloween(state, today());
  if (spooky.fresh) {
    toast(spooky.halloween
      ? "🎃 Happy Halloween! There are jack-o'-lanterns out on the farm"
      : "🎃 There are jack-o'-lanterns out on the farm");
  }
  // And November's leaves and turkeys. See sim/thanksgiving.js; the day's
  // turkey announces itself when it arrives, a moment after this.
  const harvest = noteThanksgiving(state, today());
  if (harvest.fresh) {
    toast(harvest.thanksgiving
      ? '🦃 Happy Thanksgiving! There are leaves to collect out on the farm'
      : '🍂 There are fallen leaves to collect out on the farm');
  }
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

/** Setting a gourd out. It leaves the bag only when it is put down. */
function gourdPlacement(state, type, onPlaced) {
  const name = CROPS[type].name.toLowerCase();
  return {
    w: 1, h: 1,
    after: onPlaced,
    confirmLabel: `✓ Put the ${name} here`,
    validate: (x, y) => canPlaceGourd(state, x, y),
    draw: (ctx, sheets, at) => blit(ctx, sheets, GOURD_DECOR[type], at.x * TILE, at.y * TILE),
    confirm: (x, y) => {
      const res = placeGourd(state, type, x, y);
      return res.ok
        ? { ok: true, message: `Set out a ${name}` }
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

  // The city has its own short list of tools and none of them queue work.
  if (sceneView.scene !== 'farm') {
    cityTap(state, toolbar, x, y, { announce });
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

  // Shoo acts on an animal rather than a tile, and acts at once — it is the
  // player waving their arms, not a job for the farmer. Works under a drag
  // too, so a sweep across a field clears it, but only a deliberate tap talks.
  if (tool === 'shoo') {
    const animal = animalShownAt(state, x, y);
    if (!animal) {
      if (announce) toast('Nothing there to shoo');
      return;
    }
    const who = capitalise(calledAs(animal));
    const wasWild = !!animal.wild;
    const res = shoo(state, animal);
    if (announce) {
      toast(wasWild
        ? `Shoo! ${who} runs off the farm`
        : res.ran ? `${who} bolts, then settles` : `${who} has nowhere to run`);
    }
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
    // Wild ones first, and looked for where they are drawn rather than only
    // where they logically stand — a restless one is mid-step most of the time.
    const wild = animalShownAt(state, x, y);
    if (wild && wild.wild) {
      const name = animalDef(wild.type).name.toLowerCase();
      const res = befriend(state, wild);
      if (!res.counted) toast(`The ${name} is too skittish — wait for it to settle`);
      else if (!res.befriended) toast(`The ${name} bolts! It trusts you a little more (${res.trust}/${res.tame})`);
      // Befriending gets the banner; see 'wild:befriended' in wireToastFeedback.
      return;
    }

    const animal = animalAt(state, x, y);
    if (animal && !isReady(animal)) {
      const who = capitalise(calledAs(animal));
      const { gained } = petAnimal(state, animal);
      // Counted here rather than inside petAnimal, which would close an import
      // cycle — see notePet. Nothing else in the game pets an animal.
      notePet(state, gained);
      // The first tap is the fuss, as it always was. A tap on an animal that
      // has just been fussed over had nothing left to do but say so, and that
      // is the tap that now opens its naming card — so naming needs no tool of
      // its own on a bar that is already full, and never gets in the way of
      // working down a row of animals petting each once.
      if (gained) {
        toast(animal.name
          ? `${who} loves the attention`
          : `${who} loves the attention — tap again to name it`);
      } else {
        askName(state, animal);
      }
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

  // A fish you can see but cannot get a line to. Only reachable banks count as
  // somewhere to fish from, so an island in the middle of a pond leaves fish
  // around it with nowhere to be worked from — and silence there reads as a
  // broken tap on something plainly visible.
  if (fishAt(state, x, y)) return "You can't get to the bank for that one";

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

/**
 * Which map is on screen, and where the view was left on each.
 *
 * One camera serves both maps, re-pointed at whichever is showing, so input,
 * the renderer and the overscroll insets need to know nothing about there
 * being two. Each map remembers its own position and zoom: going to the city
 * and back puts you where you were on the farm.
 */
const sceneView = { scene: 'farm', camera: null, saved: { farm: null, city: null, sanctuary: null } };

/** The places there are to be, and what is said on arriving at each. */
const PLACES = {
  farm: { icon: '🌾', name: 'The farm', hello: 'Back on the farm' },
  city: { icon: '🏙️', name: 'The city', hello: 'The city — build it with money. The farm keeps working.' },
  sanctuary: {
    icon: '🐾', name: 'The sanctuary',
    hello: 'The sanctuary — a home for animals you have befriended. The farm keeps working.',
  },
};

/** The map a scene shows: the farm's grid, or one of the built places. */
function placeMap(state, scene = sceneView.scene) {
  return scene === 'city' ? state.city : scene === 'sanctuary' ? state.sanctuary : state.grid;
}

/**
 * The place button. With two places it was a toggle; with three it opens a
 * short menu of the two that are not on screen.
 */
function wireSceneToggle(state, camera, renderer, toolbar) {
  const btn = document.getElementById('scene-toggle');
  const menu = document.getElementById('place-menu');

  const setMenu = (open) => {
    menu.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      menu.innerHTML = Object.entries(PLACES)
        .filter(([id]) => id !== sceneView.scene)
        .map(([id, p]) => `<button role="menuitem" data-place="${id}">${p.icon} ${p.name}</button>`)
        .join('');
    }
  };

  const render = () => {
    const scene = sceneView.scene;
    btn.classList.toggle('on', scene !== 'farm');
    document.body.classList.toggle('in-city', scene === 'city');
    document.body.classList.toggle('in-sanctuary', scene === 'sanctuary');
  };

  const goTo = (next) => {
    if (!PLACES[next] || next === sceneView.scene) return;
    sceneView.saved[sceneView.scene] = { x: camera.x, y: camera.y, zoom: camera.zoom };
    sceneView.scene = next;
    // Anything half-done on one map means nothing on the other.
    clearPlacement();
    tillSelection.tillAnchor = null;
    carried.what = null;
    events.emit('panel:dismiss');

    const map = placeMap(state, next);
    camera.mapW = map.w;
    camera.mapH = map.h;
    const back = sceneView.saved[next];
    if (back) {
      camera.zoom = back.zoom;
      camera.x = back.x;
      camera.y = back.y;
      camera.clamp();
    } else {
      // The first visit opens on the middle of the map, where building it
      // would naturally start.
      camera.centerOnTile(Math.floor(map.w / 2), Math.floor(map.h / 2));
    }
    toolbar.setMode(next);
    renderer.setScene(next);
    render();
    events.emit('scene:changed', next);
    toast(PLACES[next].hello);
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenu(!menu.classList.contains('open'));
  });
  menu.addEventListener('click', (e) => {
    const hit = e.target.closest('button[data-place]');
    if (!hit) return;
    setMenu(false);
    goTo(hit.dataset.place);
  });
  // A tap anywhere else puts the menu away, as it does every other panel.
  document.addEventListener('pointerdown', (e) => {
    if (!menu.contains(e.target) && e.target !== btn) setMenu(false);
  });
  events.on('panel:open', () => setMenu(false));

  events.on('city:changed', () => renderer.invalidate());
  render();
  return { goTo };
}

/**
 * A tap on the city. Building is paid for and appears at once; there is no
 * farmer to send and nothing to queue. Big things — a building, or taking
 * one down — go through the confirm bar, because a stray tap should not cost
 * thousands either way.
 */
function cityTap(state, toolbar, x, y, { announce }) {
  const tool = toolbar.getTool();
  const city = placeMap(state);
  const inSanctuary = sceneView.scene === 'sanctuary';
  if (x < 0 || y < 0 || x >= city.w || y >= city.h) return;

  if (tool === 'build') {
    const kind = toolbar.getCityKind();
    const def = cityDef(kind);
    if (!def) return;
    if (def.building) {
      if (announce) beginPlacement(cityBuildingPlacement(state, kind, city), x, y);
      return;
    }
    // Fences and the rest that join up are laid in runs, from a tap at each
    // end. A drag in paint mode still lays them a tile at a time.
    if (def.line && announce) {
      beginPlacement(cityRunPlacement(state, kind, city), x, y);
      return;
    }
    const res = cityBuild(state, kind, x, y, undefined, city);
    if (!res.ok) {
      if (announce) toast(capitalise(res.reason), 'warn');
      return;
    }
    if (announce) toast(`${def.name} — $${res.spent.toLocaleString('en-US')}`);
    return;
  }

  if (tool === 'clear') {
    const found = cityStructureAt(city, x, y);
    if (!found) {
      if (announce) toast('Nothing built there');
      return;
    }
    // A building is thousands of dollars; taking one down asks first. Paint
    // never demolishes one, so dragging across a street to lift the paving
    // cannot take a block of flats with it.
    if (found.piece && isBuilding(found.piece)) {
      if (announce) beginPlacement(cityDemolishPlacement(state, found.piece, city), found.piece.x, found.piece.y);
      return;
    }
    const res = cityDemolish(state, x, y, city);
    if (res.ok && announce) {
      toast(`Took down the ${cityDef(res.kind).name.toLowerCase()}${res.refund ? ` — $${res.refund} back` : ''}`);
    }
    return;
  }

  // A tap with the move tool, rather than a press and drag, says how it works.
  if (tool === 'move') {
    if (announce) toast('Press on an animal and drag it where you want it');
    return;
  }

  if (inSanctuary) {
    if (announce) sanctuaryTap(state, x, y);
    return;
  }

  // A machine is the one thing in the city a tap does something to: it offers
  // to switch that machine's whole line on or off, through the confirm bar so
  // a stray tap only ever asks.
  const piece = cityStructureAt(city, x, y)?.piece;
  const line = piece && cityDef(piece.kind)?.machine;
  if (line && announce) {
    beginPlacement(lineSwitchPlacement(state, line, piece), piece.x, piece.y);
    return;
  }

  if (announce) toast(describeCityTile(state, x, y));
}

/**
 * Switching a factory line on or off. The bar says what the line is doing now
 * and what it would do, which is the whole of what the player needs to decide.
 */
function lineSwitchPlacement(state, line, piece) {
  const def = LINES[line];
  const on = lineOn(state.city, line);
  const machines = workingMachines(state.city)[line] || 0;
  const perHour = Math.round(lineRate(line, machines) * 60);
  const what = `${itemName(def.input).toLowerCase()} into ${itemName(def.output).toLowerCase()}`;
  return {
    w: 1,
    h: 1,
    snap: () => ({ x: piece.x, y: piece.y }),
    validate: () => true,
    confirmLabel: on ? `⏸ Switch the ${def.name.toLowerCase()} off` : `▶ Switch the ${def.name.toLowerCase()} on`,
    hint: machines
      ? `${def.name}: ${perHour} ${what} an hour, from your bag${on ? '' : ' — switched off'}`
      : `${def.name}: not running — machines only work on factory floor`,
    confirm: () => {
      setLine(state.city, line, !on);
      return { ok: true, message: `${def.name} switched ${on ? 'off' : 'on'}` };
    },
  };
}

/** What a tap with the plain tool says about a city tile. */
function describeCityTile(state, x, y) {
  const found = cityStructureAt(state.city, x, y);
  if (!found) return 'Open ground — pick Build to put something here';
  const def = cityDef(found.kind);
  const p = found.piece;
  if (!p || !isBuilding(p)) {
    if (def.amenity || def.tree) return `${def.name} — folk like living near one`;
    if (found.kind === 'floor') return 'Factory floor — machines work standing on this';
    return def.name;
  }
  // A building with no way to the road is the commonest thing to get wrong,
  // and the least visible, so it is the first thing said.
  if (!hasAccess(state.city, p)) return `${def.name} — needs a road or pavement to the road beside it`;
  if (p.kind === 'apartments') {
    const near = amenitiesNear(state.city, p);
    return `Apartments — room for ${Math.round(housed(state.city, p))}`
      + (near
        ? `, helped by ${near === 1 ? 'a nearby lamp, bench or tree' : `${near} nearby lamps, benches and trees`}`
        : ' — lamps, benches and trees nearby make room for more');
  }
  const goods = def.goods.map((id) => itemName(id).toLowerCase());
  // Said as what it does to the price. "The town wants more wheat" was read as
  // a request — something to deliver — when there is nothing to do but sell.
  const list = goods.length > 1 ? `${goods.slice(0, -1).join(', ')} and ${goods.at(-1)}` : goods[0];
  return `${def.name} — ${list} ${goods.length > 1 ? 'sell' : 'sells'} for more while it's open`;
}

/**
 * A tap in the sanctuary with the plain tool. An animal opens its card, the
 * visitor centre empties its donation box, and anything else says what it is.
 */
function sanctuaryTap(state, x, y) {
  const place = state.sanctuary;
  const resident = residentAt(place, x, y);
  if (resident) {
    askName(state, resident);
    return;
  }

  const found = cityStructureAt(place, x, y);
  if (!found) {
    toast('Open ground — pick Build to put something here');
    return;
  }
  const def = cityDef(found.kind);
  const p = found.piece;

  if (found.kind === 'visitorCentre') {
    const got = collectDonations(state);
    if (got.ok) { toast(`Collected $${got.got.toLocaleString('en-US')} from the donation box`); return; }
    const perDay = Math.round(donationsPerDay(state));
    if (perDay > 0) toast(`Visitor centre — about $${perDay} a day in donations; the box is empty just now`);
    else if (kindsKept(place) === 0) toast('Visitor centre — visitors come once there are animals to see');
    else toast('Visitor centre — visitors come out from the city, once people live there');
    return;
  }

  if (p && def.pen) {
    const here = residentsOf(place, p).length;
    const room = penCapacity(place, p);
    const comforts = penComforts(place, p);
    toast(`Enclosure — ${here} of ${room} ${room === 1 ? 'animal' : 'animals'}`
      + (comforts ? `, with ${comforts} ${comforts === 1 ? 'comfort' : 'comforts'} inside`
        : ' — trees, water and hay inside make room for more'));
    return;
  }

  toast(def.inPen ? `${def.name} — in an enclosure, it makes room for more animals` : def.name);
}

function capitalise(text) { return text ? text[0].toUpperCase() + text.slice(1) : text; }

/**
 * Siting a city building: two taps for the corners, as a barn is sized, and a
 * confirm that says what the drawn rectangle costs before any money moves.
 */
function cityBuildingPlacement(state, kind, city = state.city) {
  const def = cityDef(kind);
  const limits = def.limits;
  const noun = def.name.toLowerCase();
  let anchor = null;

  return {
    w: 1,
    h: 1,
    draw: (ctx, sheets, at) => {
      if (at.w < limits.minW || at.h < limits.minH) return;
      drawPieceGhost(ctx, sheets, city, kind, at);
    },
    pick: (x, y) => {
      if (!anchor) {
        anchor = { x, y };
        return { x, y, w: 1, h: 1, valid: false, label: `✓ Build ${noun}`, hint: 'Now tap the opposite corner' };
      }
      const box = snapBarn(anchor.x, anchor.y, x, y, limits);
      if (!box) {
        return {
          x: Math.min(anchor.x, x), y: Math.min(anchor.y, y),
          w: Math.abs(x - anchor.x) + 1, h: Math.abs(y - anchor.y) + 1,
          valid: false, label: `✓ Build ${noun}`,
          hint: `${def.name} must be at least ${limits.minW} by ${limits.minH}`,
        };
      }
      const size = [box.w, box.h];
      const cost = cityCost(kind, size);
      const label = `✓ Build ${box.w}×${box.h} for $${cost.toLocaleString('en-US')}`;
      const problem = cityPlacementProblem(state, kind, box.x, box.y, size, city);
      if (problem) return { ...box, valid: false, label, hint: capitalise(problem) };
      if (state.money < cost) {
        return { ...box, valid: false, label, hint: `Needs $${cost.toLocaleString('en-US')} — you have $${state.money.toLocaleString('en-US')}` };
      }
      return { ...box, valid: true, label, hint: `${def.name}, ${box.w}×${box.h}` };
    },
    confirm: (x, y) => {
      const p = placement.pending;
      const res = cityBuild(state, kind, x, y, [p.w, p.h], city);
      return res.ok
        ? { ok: true, message: `Built ${p.w}×${p.h} ${noun} for $${res.spent.toLocaleString('en-US')}` }
        : { ok: false, reason: capitalise(res.reason) };
    },
  };
}

/**
 * Laying a run of fence (or conveyor, pipe or hazard strip). The first tap is
 * one end and can be confirmed on its own, for a single piece; a second tap is
 * the other end of a straight run, or the opposite corner of a ring round the
 * rectangle between. The bar says how many pieces and what they cost, and how
 * many tiles were skipped because something stands there.
 */
function cityRunPlacement(state, kind, city = state.city) {
  const def = cityDef(kind);
  const noun = def.name.toLowerCase();
  let anchor = null;
  let tiles = [];

  const verdict = (box, ring) => {
    const plan = cityRunPlan(state, kind, tiles, city);
    const skip = new Set(plan.skipped.map((t) => `${t.x},${t.y}`));
    tiles = tiles.map((t) => ({ x: t.x, y: t.y, skip: skip.has(`${t.x},${t.y}`) }));
    const n = plan.lay.length;
    const label = `✓ Lay ${n} for $${plan.cost.toLocaleString('en-US')}`;
    const out = { ...box, tiles };
    if (n === 0) return { ...out, valid: false, label, hint: capitalise(plan.problem || `That is all ${noun} already`) };
    if (state.money < plan.cost) {
      return { ...out, valid: false, label, hint: `Needs $${plan.cost.toLocaleString('en-US')} — you have $${state.money.toLocaleString('en-US')}` };
    }
    const what = !anchor || (box.w === 1 && box.h === 1)
      ? 'Tap the other end for a run, or the opposite corner for a ring'
      : ring ? `A ${box.w}×${box.h} ring of ${noun}` : `${n} ${noun}`;
    const skipped = plan.skipped.length
      ? ` — ${plan.skipped.length} skipped: ${plan.problem}`
      : '';
    return { ...out, valid: true, label, hint: `${what}${skipped}` };
  };

  return {
    w: 1,
    h: 1,
    // Drawn against the run itself, so the ghost fence joins up the way the
    // real one will: a fence picks its art from its neighbours.
    draw: (ctx, sheets) => {
      const run = tiles.filter((t) => !t.skip).map((t) => ({ kind, x: t.x, y: t.y, w: 1, h: 1 }));
      const preview = { ...city, pieces: city.pieces.filter((p) => p.kind === kind).concat(run) };
      for (const t of run) drawPieceGhost(ctx, sheets, preview, kind, t);
    },
    pick: (x, y) => {
      if (!anchor) {
        anchor = { x, y };
        tiles = [{ x, y }];
        return verdict({ x, y, w: 1, h: 1 }, false);
      }
      tiles = runTiles(anchor.x, anchor.y, x, y);
      const box = {
        x: Math.min(anchor.x, x), y: Math.min(anchor.y, y),
        w: Math.abs(x - anchor.x) + 1, h: Math.abs(y - anchor.y) + 1,
      };
      return verdict(box, box.w > 1 && box.h > 1);
    },
    confirm: () => {
      const res = cityBuildRun(state, kind, tiles, city);
      return res.ok
        ? { ok: true, message: `Laid ${res.count} ${noun} for $${res.spent.toLocaleString('en-US')}` }
        : { ok: false, reason: capitalise(res.reason) };
    },
  };
}

/** Taking a building down: the confirm bar says what comes back first. */
function cityDemolishPlacement(state, piece, city = state.city) {
  const def = cityDef(piece.kind);
  const found = cityStructureAt(city, piece.x, piece.y);
  const takeDown = () => (city === state.sanctuary
    ? sanctuaryDemolish(state, piece.x, piece.y)
    : cityDemolish(state, piece.x, piece.y, city));
  return {
    w: piece.w,
    h: piece.h,
    // Pinned to the building: tapping elsewhere does not move the target.
    snap: () => ({ x: piece.x, y: piece.y }),
    validate: () => city.pieces.includes(piece),
    danger: true,
    confirmLabel: `✓ Demolish for $${found.refund.toLocaleString('en-US')} back`,
    hint: `Take down the ${def.name.toLowerCase()}? It cost $${cityCost(piece.kind, [piece.w, piece.h]).toLocaleString('en-US')}`,
    confirm: () => {
      const res = takeDown();
      return res.ok
        ? { ok: true, message: `Took down the ${def.name.toLowerCase()} — $${res.refund.toLocaleString('en-US')} back` }
        : { ok: false, reason: capitalise(res.reason || 'it is already gone') };
    },
  };
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

/** Today's date in the player's own timezone, as 'YYYY-MM-DD'. */
function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** One award, said properly. See ui/award.js for why this isn't a toast. */
function announceAward(def) {
  if (def) showAward({ name: def.name, blurb: def.blurb });
}

/**
 * Puts up an animal's card and applies whatever comes back: its name, and —
 * for the animals the sanctuary takes — the button that sends it there or
 * fetches it home. One card for both, so there is one place to go for
 * anything that is about a particular animal rather than about the farm.
 *
 * Held by id rather than by reference across the wait: the card can sit open
 * while the farm ticks, and an animal could in principle be gone by the time
 * the player presses a button.
 */
function askName(state, animal, title) {
  if (namePanelOpen()) return;
  const kind = animalDef(animal.type).name.toLowerCase();
  const id = animal.id;
  const away = state.sanctuary.residents.includes(animal);
  const find = () => (away
    ? state.sanctuary.residents.find((x) => x.id === id)
    : state.animals.find((x) => x.id === id));

  let action = null;
  if (away) {
    action = {
      label: '🌾 Bring back to the farm',
      onClick: () => {
        const r = find();
        if (!r) return;
        const who = capitalise(calledAs(r));
        const res = bringHome(state, r);
        toast(res.ok ? `${who} is back on the farm, beside the farmer` : capitalise(res.reason), res.ok ? undefined : 'warn');
      },
    };
  } else if (isSanctuaryKind(animal.type) && !animal.wild) {
    const can = canSendToSanctuary(state, animal);
    action = {
      label: '🐾 Send to the sanctuary',
      disabled: !can.ok,
      note: can.ok ? '' : capitalise(can.reason),
      onClick: () => {
        const a = find();
        if (!a) return;
        const who = capitalise(calledAs(a));
        const res = sendToSanctuary(state, a);
        toast(res.ok ? `${who} has gone to live in the sanctuary` : capitalise(res.reason), res.ok ? undefined : 'warn');
      },
    };
  }

  openNamePanel({
    title: title || (animal.name ? `Rename ${animal.name}` : `Name your ${kind}`),
    current: animal.name || '',
    action,
    onSave: (text) => {
      const a = find();
      if (!a) return;
      const had = a.name;
      const res = nameAnimal(state, a, text);
      if (!res.ok) return;
      if (res.name) toast(`The ${kind} is now called ${res.name}`);
      else if (had) toast(`The ${kind} goes without a name again`);
    },
  });
}

/** Turns simulation events into player-visible feedback. */
function wireToastFeedback(state) {
  // Deliberately the loudest thing the game says: an achievement is rare, and
  // it is the only toast that is worth interrupting whatever else is on screen.
  events.on('achievement:earned', ({ id }) => announceAward(achievementDef(id)));

  // Something wild has wandered in. Said out loud because the farm is large and
  // a visitor nobody noticed is a visitor who leaves a day later unmet.
  events.on('wild:arrived', ({ type }) => {
    const name = animalDef(type).name.toLowerCase();
    // "An elephant", not "a elephant" — and the same for the emu and the owl.
    const article = /^[aeiou]/.test(name) ? 'An' : 'A';
    toast(`${article} ${name} has wandered onto the farm`);
  });
  events.on('wild:met', ({ name }) => toast(`New find: ${name}! It's in your journal`));
  // Winning one over is a moment, so it gets the banner rather than a toast.
  events.on('wild:befriended', ({ id, name, first }) => {
    showAward({
      icon: '❤️',
      kicker: first ? 'New friend' : 'Another friend',
      name,
      blurb: 'has decided you are all right, and is staying',
    });
    // And the moment it becomes hers is the moment to ask what it is called.
    // Skippable, and it can be named any time afterwards by tapping it twice.
    const friend = state.animals.find((a) => a.id === id);
    if (friend) askName(state, friend, 'Name your new friend');
  });

  // A mythical gets the achievement banner, because it is the same size of
  // moment and the furniture already exists — it just says something other
  // than "achievement" above the name.
  events.on('balloon:mythical', ({ type }) => {
    showAward({
      icon: '🎈',
      kicker: 'Happy birthday',
      name: animalDef(type).name,
      blurb: 'stepped out of a birthday balloon',
    });
  });

  // A leaf puts nothing in the bag, so the task's own toast has nothing to
  // say; this is the only word she gets that it was picked up.
  events.on('leaf:collected', ({ name, first }) => {
    toast(first
      ? `New find: ${name} leaf! It's in your journal`
      : `Picked up a ${name.toLowerCase()} leaf`);
  });

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

/** How long a wake-up catch-up may run before the progress screen covers the farm. */
const WAKE_SCREEN_AFTER_MS = 400;

/** How long each chunk of catch-up may run: short while watched, long while hidden. */
function catchupSlice() {
  return document.hidden ? CATCHUP_HIDDEN_SLICE_MS : CATCHUP_SLICE_MS;
}

/** "3 days", "5 hours", "20 minutes" — how long she was away, roughly. */
function awayText(ms) {
  const mins = Math.round(ms / 60000);
  const say = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (mins < 90) return say(Math.max(1, mins), 'minute');
  const hours = Math.round(mins / 60);
  if (hours < 36) return say(hours, 'hour');
  return say(Math.round(hours / 24), 'day');
}

/**
 * The progress bar shown while time away is replayed.
 *
 * The boot screen's own furniture: on a cold start it is already up and this
 * only fills it in; on a wake-up it is brought back, and only once the replay
 * has been running for `after` milliseconds.
 *
 * @param {number} awayMs how long is being replayed, for the wording
 * @param {{after?: number}} [opts]
 * @returns {{onProgress: (done: number, total: number) => void,
 *   done: (opts?: {hide?: boolean}) => void}}
 */
function catchupScreen(awayMs, { after = 0 } = {}) {
  const began = performance.now();
  let shown = false;

  const show = () => {
    shown = true;
    // Never more than the cap: a month away replays a week, and the bar
    // should not promise the month.
    const replayed = Math.min(awayMs, MAX_CATCHUP_TICKS * TICK_MS);
    els.bootText.textContent = `Catching up on ${awayText(replayed)} away…`;
    els.bootBar.hidden = false;
    els.boot.classList.remove('hidden');
  };

  return {
    onProgress(done, total) {
      if (!shown) {
        if (performance.now() - began < after) return;
        show();
      }
      const fraction = total > 0 ? done / total : 1;
      const pct = Math.floor(fraction * 100);
      els.bootFill.style.transform = `scaleX(${fraction})`;
      els.bootBar.setAttribute('aria-valuenow', String(pct));
      els.bootSub.textContent = `${pct}%`;
    },
    done({ hide = false } = {}) {
      els.bootBar.hidden = true;
      els.bootSub.textContent = '';
      els.bootFill.style.transform = 'scaleX(0)';
      if (hide && shown) els.boot.classList.add('hidden');
    },
  };
}

function wireWakeUp(state, loop) {
  // One catch-up at a time. Flicking away and back while one is running fires
  // this again, and a second replay started from a clock the first is still
  // moving would run the same stretch of time twice.
  let catchingUp = false;

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || catchingUp) return;

    const away = Date.now() - state.lastTickTime;
    if (away < TICK_MS * 2) return;              // a glance away; pump will cope

    catchingUp = true;
    // The loop stands down while the time away is replayed. Left running, its
    // own pump sees the same backlog and makes up to ten minutes of it a
    // second time — and draws a half-caught-up farm while it does.
    loop.stop();
    // The screen only comes up if this turns out to be slow: a few minutes
    // away replays in a blink, and flashing a card for that is worse than
    // nothing. A long absence on a busy farm gets the same bar as a cold start.
    const screen = catchupScreen(away, { after: WAKE_SCREEN_AFTER_MS });
    let catchup;
    try {
      catchup = await runCatchup(away, () => simTick(state), screen.onProgress, { sliceMs: catchupSlice });
      discardSkipped(state, catchup);
    } finally {
      screen.done({ hide: true });
      catchingUp = false;
      // start() puts the tick clock level with the wall clock, so the loop
      // doesn't then try to make up the stretch that was just replayed.
      loop.start(Date.now());
    }

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
