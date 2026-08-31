// Tool selection. The chosen tool decides what tapping (or drag-painting) a
// tile queues. 'auto' is the default because it lets the player just tap things
// without thinking about modes; the explicit tools exist so that drag-painting
// a whole field does one predictable thing.
//
// Two tools need a second choice (which seed, which structure). Both share one
// sub-picker row rather than each having their own, so the bottom of the screen
// never grows by more than a single row.

import { CROPS, seedIdFor } from '../sim/crops.js';
import { BUILDABLES, BUILD_GROUPS, buildGroup, canAfford, costLabel } from '../sim/build.js';
import { getPref } from '../engine/prefs.js';
import { countItem } from '../sim/inventory.js';
import { on } from '../engine/events.js';

/**
 * The tools, in the order they sit on the bar.
 *
 * Ordered by how often a hand reaches for them rather than by the order a
 * field is worked. The bar scrolls sideways on a phone, so the first few are
 * the ones always in reach — and the things done every visit (take what is
 * ready, water what is growing) should not be the ones you have to scroll for.
 * Setting up a field is the rarer job, so tilling and building sit at the far
 * end where a deliberate trip is no hardship.
 */
export const TOOLS = [
  { id: 'auto', icon: '👆', name: 'Tap', hint: 'Do whatever the tile needs' },
  // Next to Tap because they're the two that act on what's already there,
  // rather than on the ground: tap it, or pick it up and move it.
  { id: 'move', icon: '✊', name: 'Move', hint: 'Drag your animals and people where you want them' },
  { id: 'harvest', icon: '🧺', name: 'Harvest', hint: 'Pick ripe crops, mushrooms and flowers' },
  { id: 'water', icon: '💧', name: 'Water', hint: 'Seeds only start growing once watered' },
  { id: 'plant', icon: '🌱', name: 'Plant', hint: 'Sow the selected seed' },
  { id: 'clear', icon: '🪓', name: 'Clear', hint: 'Chop, clear, and take down what you built' },
  { id: 'till', icon: '🚜', name: 'Till', hint: 'Tap both ends of a row to plough it' },
  { id: 'build', icon: '🔨', name: 'Build', hint: 'Buildings, land and decorations' },
  // Last, because calling work off is rarer than putting it on — but it drags
  // like the others, so a mis-drag is undone the same way it was made.
  { id: 'cancel', icon: '🚫', name: 'Cancel', hint: 'Tap queued work to call it off' },
  // Not a mode: it does its thing and leaves whichever tool you were holding
  // selected. `action` is what says so — the bar is where a player's thumb
  // already is, so a one-shot button belongs here even though nothing about it
  // changes what a tap on the map does.
  {
    id: 'findFarmer', icon: '🧑‍🌾', name: 'Find', action: true,
    hint: 'Bring the view back to your farmer',
  },
];

export function initToolbar(state, { onToolChange, onAction } = {}) {
  const bar = document.getElementById('toolbar');
  const subRow = document.getElementById('sub-row');

  let tool = 'auto';
  let cropType = 'carrot';
  let buildKind = 'fence';
  // Which group of buildables the row is showing, or null for the group list
  // itself. Kept between visits: someone laying a row of fences should not have
  // to walk back in through the menu for every one.
  let openGroup = null;

  /**
   * Draws the bar. Icon-only is a preference because the bar scrolls sideways
   * on a phone, and the words are what make it scroll: measured at 375px, four
   * tools are reachable with the labels on and seven without. Eight will not
   * fit either way — that would need more width than the phone has, once every
   * button clears the minimum tap target.
   *
   * The name still goes in the button's label for screen readers and as its
   * tooltip, so nothing is lost but the pixels.
   */
  function renderTools() {
    const labels = getPref('toolLabels');
    bar.classList.toggle('icons-only', !labels);
    bar.innerHTML = TOOLS.map((t) => (
      `<button class="tool" data-tool="${t.id}" title="${t.name} — ${t.hint}"`
      + ` aria-label="${t.name}">${t.icon}${labels ? ` ${t.name}` : ''}</button>`
    )).join('');
    render();
  }

  renderTools();
  on('prefs:changed', (key) => { if (key === 'toolLabels') renderTools(); });

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tool]');
    if (!btn) return;
    const chosen = TOOLS.find((t) => t.id === btn.dataset.tool);
    // A one-shot button fires and changes nothing: the tool in hand stays in
    // hand, so finding the farmer mid-job doesn't cost you your place.
    if (chosen?.action) { if (onAction) onAction(chosen.id); return; }
    tool = btn.dataset.tool;
    render();
    if (onToolChange) onToolChange(tool);
  });

  subRow.addEventListener('click', (e) => {
    const crop = e.target.closest('button[data-crop]');
    if (crop) { cropType = crop.dataset.crop; render(); return; }
    const group = e.target.closest('button[data-buildgroup]');
    if (group) { openGroup = group.dataset.buildgroup || null; renderBuildables(); return; }
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

  /**
   * The build picker: groups first, then the things in one group.
   *
   * Two taps to reach a fence instead of one, which buys back nearly nine
   * screens of sideways swiping — the flat list had grown to twenty-one entries
   * and put the barn at the far end of all of them. The row stays one line tall
   * either way, which is the constraint the whole sub-picker exists under.
   */
  function renderBuildables() {
    const group = buildGroup(openGroup);
    if (!group) {
      subRow.innerHTML = BUILD_GROUPS.map((g) => {
        // Say how many are in there, so the groups read as shelves rather than
        // as three buttons that might do anything.
        const n = g.kinds.length;
        return `<button data-buildgroup="${g.id}" title="${g.name}">` +
          `${g.name} <b>${n}</b></button>`;
      }).join('');
      return;
    }

    const back = '<button class="sub-back" data-buildgroup="" title="Back to the groups">‹</button>';
    subRow.innerHTML = back + group.kinds.map((kind) => {
      const def = BUILDABLES[kind];
      if (!def) return '';
      // Greyed out rather than hidden: the player should see what exists and
      // what it would cost, even when they can't afford it yet.
      const afford = canAfford(state, kind).ok;
      // A barn is priced by its size, so the row can only quote the smallest
      // one — saying "from" stops that reading as the whole story.
      const price = def.sizable ? `from ${costLabel(kind)}` : costLabel(kind);
      return `<button class="${kind === buildKind ? 'on' : ''}${afford ? '' : ' short'}" ` +
        `data-build="${kind}" title="${def.hint}">${def.name} <b>${price}</b></button>`;
    }).join('');
  }

  function render() {
    for (const btn of bar.querySelectorAll('button[data-tool]')) {
      const t = TOOLS.find((x) => x.id === btn.dataset.tool);
      btn.classList.toggle('on', !t?.action && btn.dataset.tool === tool);
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

  // Opening a panel drops back to the harmless tool and closes the sub-picker.
  // A panel only covers part of the screen, so leaving Build armed behind it
  // means a tap on the visible strip of map quietly puts down a fence.
  // Deliberately does not fire onToolChange: that announces the new tool, and
  // a hint toast every time the shop opens is noise. Callers that need to tidy
  // up on a panel opening listen for 'panel:open' themselves.
  on('panel:open', () => {
    if (tool === 'auto') return;
    tool = 'auto';
    render();
  });

  render();

  return {
    getTool: () => tool,
    getCropType: () => cropType,
    getBuildKind: () => buildKind,
    setTool: (t) => { tool = t; render(); },
  };
}
