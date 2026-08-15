// Entry point: load or create a farm, replay the time you were away, then run.

import { TICK_MS, START_INVENTORY, TESTING } from './config.js';
import { loadSheets } from './render/sprites.js';
import { Renderer } from './render/renderer.js';
import { Camera } from './render/camera.js';
import { GameLoop, runCatchup } from './engine/loop.js';
import { loadSave, clearSave, Autosaver } from './engine/save.js';
import { newGame, serialize, deserialize } from './state.js';
import { tick as simTick } from './sim/tick.js';
import { addTask, taskForTile, taskLabel, queueTillRow } from './sim/tasks.js';
import { itemName, addItem } from './sim/inventory.js';
import { canAfford, buildDef, canPlaceAt } from './sim/build.js';
import { drawBuilding } from './render/tilerender.js';
import { drawAnimalSprite } from './render/entityrender.js';
import { animalDef, animalAt, petAnimal, isReady } from './sim/animals.js';
import { buyAnimal, canPlaceAnimal } from './sim/shop.js';
import { PLOT, plotBounds } from './world/land.js';
import { attachInput } from './ui/input.js';
import { initToolbar, TOOLS } from './ui/toolbar.js';
import { initTaskPanel } from './ui/taskpanel.js';
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

  initToasts();
  const autosaver = new Autosaver(() => serialize(state));
  const hud = initHud(state);
  initTaskPanel(state);
  initShopPanel(state, {
    onMessage: (msg, kind) => toast(msg, kind),
    // Land is bought from the little map in the shop, so nothing to site here —
    // just take the player out to look at what they just bought.
    onLandBought: (px, py) => {
      const b = plotBounds(px, py);
      camera.centerOnTile(b.x0 + PLOT / 2, b.y0 + PLOT / 2);
    },
    onPlaceAnimal: (type) => {
      // Start the ghost on the farmer, so something is visible immediately and
      // the player can see the animal before choosing where it goes.
      beginPlacement(animalPlacement(state, type), state.farmer.x, state.farmer.y);
      camera.centerOnTile(state.farmer.x, state.farmer.y);
      toast(`Tap where your ${type} should go`);
    },
  });
  wireToastFeedback();

  const toolbar = initToolbar(state, {
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
  wireLifecycle(autosaver, renderer);

  attachInput(els.canvas, camera, {
    onTap: (x, y) => queueTileTask(state, toolbar, x, y, { announce: true }),
    onPaint: (x, y) => queueTileTask(state, toolbar, x, y, { announce: false }),
    isPaintMode: () => paintMode.isOn(),
  });

  const loop = new GameLoop(
    () => {
      simTick(state);
      autosaver.markDirty(Date.now());
    },
    (alpha) => {
      renderer.draw(state, alpha, { ...tillSelection, pending: placement.pending });
      hud.renderStatus();
      autosaver.maybeSave(Date.now());
      updateDebug(state, catchup, isNew);
    },
  );

  loop.start(Date.now());

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
 * Which sliding panel is up, if any. Tracked here so a tap on the map can
 * dismiss it instead of acting on the tile underneath.
 */
let openPanel = null;

function wirePanelTracking() {
  events.on('panel:open', (name) => {
    openPanel = name;
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
  // A spec may snap the tap to its own grid.
  const at = spec.snap ? spec.snap(x, y) : { x, y };
  placement.pending = { ...spec, ...at, valid: spec.validate(at.x, at.y) };
  renderConfirmBar();
}

function movePlacement(x, y) {
  const p = placement.pending;
  if (!p) return;
  const at = p.snap ? p.snap(x, y) : { x, y };
  p.x = at.x;
  p.y = at.y;
  p.valid = p.validate(at.x, at.y);
  renderConfirmBar();
}

function clearPlacement() {
  placement.pending = null;
  renderConfirmBar();
}

function renderConfirmBar() {
  const bar = document.getElementById('confirm-bar');
  const ok = document.getElementById('confirm-place');
  const p = placement.pending;
  bar.classList.toggle('open', p !== null);
  if (p) {
    ok.disabled = !p.valid;
    ok.textContent = p.confirmLabel || '✓ Place here';
  }
}

/** Siting a structure: confirming queues a build task for the farmer. */
function buildingPlacement(state, kind) {
  const def = buildDef(kind);
  return {
    w: def.size[0], h: def.size[1],
    confirmLabel: `✓ Build ${def.name.toLowerCase()} here`,
    validate: (x, y) => canPlaceAt(state, kind, x, y),
    draw: (ctx, sheets, at) => drawBuilding(ctx, sheets, { ...at, type: kind }),
    confirm: (x, y) => {
      const spec = taskForTile(state, x, y, 'build', { buildKind: kind });
      if (!spec) return { ok: false, reason: "that won't fit there" };
      addTask(state, spec);
      return { ok: true, message: `Queued: ${def.name}` };
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
    validate: (x, y) => canPlaceAnimal(state, x, y),
    draw: (ctx, sheets, at) => drawAnimalSprite(ctx, sheets, type, at),
    confirm: (x, y) => {
      const res = buyAnimal(state, type, x, y);
      return res.ok
        ? { ok: true, message: `${def.name} bought for $${res.spent}` }
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
      if (announce) beginPlacement(buildingPlacement(state, kind), x, y);
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
    if (announce) toast(noWorkReason(state, tool, toolbar));
    return;
  }
  const task = addTask(state, spec);
  if (task && announce) toast(`Queued: ${taskLabel(task)}`);
}

/** Explains an ignored tap, since silence just reads as a broken button. */
function noWorkReason(state, tool, toolbar) {
  switch (tool) {
    case 'build': {
      const def = buildDef(toolbar.getBuildKind());
      return def && def.size[0] > 1
        ? `A ${def.name.toLowerCase()} needs two clear tiles side by side`
        : 'Something is already there';
    }
    case 'till': return 'Till needs clear, empty ground';
    case 'plant': return 'Plant on tilled soil — and pick a seed you own';
    case 'water': return 'Only tilled soil can be watered';
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

function wireLifecycle(autosaver, renderer) {
  // iOS Safari suspends and eventually kills background tabs, often without a
  // second chance to run code. Write on every hide, not just on unload.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosaver.saveNow();
  });
  window.addEventListener('pagehide', () => autosaver.saveNow());

  let resizeTimer = 0;
  const doResize = () => renderer.resize();
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
