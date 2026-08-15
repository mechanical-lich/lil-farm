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
import { attachInput } from './ui/input.js';
import { initToolbar, TOOLS } from './ui/toolbar.js';
import { initTaskPanel } from './ui/taskpanel.js';
import { initShopPanel } from './ui/shoppanel.js';
import { initHud } from './ui/hud.js';
import { initToasts, toast } from './ui/toast.js';
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
  const hud = initHud(state);
  initTaskPanel(state);
  initShopPanel(state, { onMessage: (msg, kind) => toast(msg, kind) });
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
  const paintMode = wirePaintToggle();
  wirePlacementButtons(state);
  const autosaver = new Autosaver(() => serialize(state));
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
  reportReturn(catchup, isNew);
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

function beginOrMovePlacement(state, kind, x, y) {
  const def = buildDef(kind);
  const [w, h] = def.size;
  placement.pending = {
    kind, x, y, w, h,
    valid: canPlaceAt(state, kind, x, y),
    draw: (ctx, sheets, at) => drawBuilding(ctx, sheets, { ...at, type: kind }),
  };
  renderConfirmBar();
}

function clearPlacement() {
  placement.pending = null;
  renderConfirmBar();
}

function renderConfirmBar() {
  const bar = document.getElementById('confirm-bar');
  const ok = document.getElementById('confirm-place');
  bar.classList.toggle('open', placement.pending !== null);
  if (placement.pending) ok.disabled = !placement.pending.valid;
}

function wirePlacementButtons(state) {
  document.getElementById('cancel-place').addEventListener('click', clearPlacement);
  document.getElementById('confirm-place').addEventListener('click', () => {
    const p = placement.pending;
    if (!p || !p.valid) return;

    const spec = taskForTile(state, p.x, p.y, 'build', { buildKind: p.kind });
    if (!spec) { toast("That won't fit there", 'warn'); return; }
    addTask(state, spec);
    toast(`Queued: ${buildDef(p.kind).name}`);
    clearPlacement();
  });
}

/** Queues the action the current tool implies for a tile, if any. */
function queueTileTask(state, toolbar, x, y, { announce }) {
  const tool = toolbar.getTool();

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
      if (announce) beginOrMovePlacement(state, kind, x, y);
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

function reportReturn(catchup, isNew) {
  if (isNew) {
    toast('Welcome to your lil farm!');
    return;
  }
  if (catchup.ticks > 60) {
    const mins = Math.round(catchup.ticks / 60);
    const label = mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`;
    toast(`Your farmer worked for ${label} while you were away`);
  }
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
