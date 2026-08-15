// Tool selection. The chosen tool decides what tapping (or drag-painting) a
// tile queues. 'auto' is the default because it lets the player just tap things
// without thinking about modes; the explicit tools exist so that drag-painting
// a whole field does one predictable thing.
//
// Two tools need a second choice (which seed, which structure). Both share one
// sub-picker row rather than each having their own, so the bottom of the screen
// never grows by more than a single row.

import { CROPS, seedIdFor } from '../sim/crops.js';
import { BUILDABLES, canAfford, costLabel } from '../sim/build.js';
import { countItem } from '../sim/inventory.js';
import { on } from '../engine/events.js';

export const TOOLS = [
  { id: 'auto', label: '👆 Tap', hint: 'Do whatever the tile needs' },
  { id: 'clear', label: '🪓 Clear', hint: 'Chop, clear, and take down what you built' },
  { id: 'till', label: '🚜 Till', hint: 'Tap both ends of a row to plough it' },
  { id: 'plant', label: '🌱 Plant', hint: 'Sow the selected seed' },
  { id: 'water', label: '💧 Water', hint: 'Seeds only start growing once watered' },
  { id: 'harvest', label: '🧺 Harvest', hint: 'Pick ripe crops before they spoil' },
  { id: 'build', label: '🔨 Build', hint: 'Fences, gates, roads and troughs' },
];

export function initToolbar(state, { onToolChange } = {}) {
  const bar = document.getElementById('toolbar');
  const subRow = document.getElementById('sub-row');

  let tool = 'auto';
  let cropType = 'carrot';
  let buildKind = 'fence';

  bar.innerHTML = TOOLS.map((t) => (
    `<button class="tool" data-tool="${t.id}" title="${t.hint}">${t.label}</button>`
  )).join('');

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tool]');
    if (!btn) return;
    tool = btn.dataset.tool;
    render();
    if (onToolChange) onToolChange(tool);
  });

  subRow.addEventListener('click', (e) => {
    const crop = e.target.closest('button[data-crop]');
    if (crop) { cropType = crop.dataset.crop; render(); return; }
    const build = e.target.closest('button[data-build]');
    if (build) { buildKind = build.dataset.build; render(); }
  });

  function renderSeeds() {
    // Only seeds actually in the bag are offered, so the player can't queue a
    // planting they have no way to fulfil.
    const owned = Object.keys(CROPS)
      .map((type) => ({ type, qty: countItem(state, seedIdFor(type)) }))
      .filter((s) => s.qty > 0);

    if (owned.length === 0) {
      subRow.innerHTML = '<span class="sub-empty">No seeds — buy some at the shop.</span>';
      return;
    }
    if (!owned.some((s) => s.type === cropType)) cropType = owned[0].type;

    subRow.innerHTML = owned.map((s) => (
      `<button class="${s.type === cropType ? 'on' : ''}" data-crop="${s.type}">` +
      `${CROPS[s.type].name} <b>${s.qty}</b></button>`
    )).join('');
  }

  function renderBuildables() {
    subRow.innerHTML = Object.entries(BUILDABLES).map(([kind, def]) => {
      // Greyed out rather than hidden: the player should see what exists and
      // what it would cost, even when they can't afford it yet.
      const afford = canAfford(state, kind).ok;
      return `<button class="${kind === buildKind ? 'on' : ''}${afford ? '' : ' short'}" ` +
        `data-build="${kind}" title="${def.hint}">${def.name} <b>${costLabel(kind)}</b></button>`;
    }).join('');
  }

  function render() {
    for (const btn of bar.querySelectorAll('button[data-tool]')) {
      btn.classList.toggle('on', btn.dataset.tool === tool);
    }

    const needsSub = tool === 'plant' || tool === 'build';
    subRow.classList.toggle('open', needsSub);
    if (tool === 'plant') renderSeeds();
    else if (tool === 'build') renderBuildables();
  }

  // Materials and seeds both change as the farmer works, so keep the picker
  // honest about what's affordable right now.
  on('inventory:changed', () => { if (tool === 'plant' || tool === 'build') render(); });
  on('tasks:changed', () => { if (tool === 'build') renderBuildables(); });
  render();

  return {
    getTool: () => tool,
    getCropType: () => cropType,
    getBuildKind: () => buildKind,
    setTool: (t) => { tool = t; render(); },
  };
}
