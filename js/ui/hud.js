// Top-of-screen readout: money, what the farmer is doing, and inventory.

import { on, emit } from '../engine/events.js';
import { inventoryList } from '../sim/inventory.js';
import { journalRows, journalFound, MUSHROOMS } from '../sim/mushrooms.js';
import { journalRows as flowerJournalRows, seedGroups } from '../sim/flowers.js';
import { makeGenome, hueName, isFlowerSeed, isCross } from '../sim/flowergenes.js';
import { flowerDataUrl } from '../render/flowerart.js';
import { taskLabel } from '../sim/tasks.js';

export function initHud(state, { onPlantFlower } = {}) {
  const money = document.getElementById('hud-money');
  // The status chip is also the task-queue button (see taskpanel.js); the HUD
  // only owns the text inside it, never the element's own classes or state.
  const status = document.getElementById('hud-status-text');
  const invBtn = document.getElementById('inv-toggle');
  const invPanel = document.getElementById('inv-panel');
  const invList = document.getElementById('inv-list');
  const invTabs = document.getElementById('inv-tabs');
  const invNote = document.getElementById('inv-note');
  const invTitle = document.getElementById('inv-title');

  // The bag panel carries the mushroom journal as a second tab rather than
  // earning its own button: the bottom row is already three wide on a phone,
  // and a collection of things you picked up belongs with the things you're
  // carrying.
  let invTab = 'bag';

  let invOpen = false;
  const setInvOpen = (v) => {
    if (invOpen === v) return;
    invOpen = v;
    invPanel.classList.toggle('open', invOpen);
    emit(invOpen ? 'panel:open' : 'panel:close', 'bag');
  };
  on('panel:open', (who) => { if (who !== 'bag') setInvOpen(false); });
  on('panel:dismiss', () => setInvOpen(false));
  invBtn.addEventListener('click', () => { setInvOpen(!invOpen); renderInventory(); });
  invTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    invTab = btn.dataset.tab;
    renderInventory();
  });
  document.getElementById('inv-close').addEventListener('click', () => setInvOpen(false));

  function renderInventory() {
    for (const btn of invTabs.querySelectorAll('button[data-tab]')) {
      btn.classList.toggle('on', btn.dataset.tab === invTab);
    }
    invTitle.textContent = invTab === 'bag' ? 'Bag'
      : invTab === 'journal' ? 'Mushroom journal' : 'Flower journal';

    if (invTab === 'journal') { renderJournal(); return; }
    if (invTab === 'flowers') { renderFlowers(); return; }

    invNote.textContent = '';
    // Flower seeds are collapsed into one line. A collector carries dozens of
    // colours, and thirty rows of them would bury the wood and the eggs — they
    // have a drawer of their own on the Flowers tab, which is where somebody
    // looking for a particular colour is going to go anyway.
    const items = inventoryList(state);
    const packets = items.filter((i) => isFlowerSeed(i.id));
    const rest = items.filter((i) => !isFlowerSeed(i.id));
    const seeds = packets.reduce((n, i) => n + i.qty, 0);

    const rows = rest.map((i) => `<li><span>${i.name}</span><b>${i.qty}</b></li>`);
    if (seeds > 0) {
      rows.push(`<li><span>Flower seeds<em>${packets.length} colours — see Flowers</em></span>`
        + `<b>${seeds}</b></li>`);
    }
    invList.innerHTML = rows.length
      ? rows.join('')
      : '<li class="empty">Nothing yet. Clear some land!</li>';
  }

  /**
   * Every mushroom, found or not. Showing the empty slots is the point of a
   * collection — a grid of question marks is what tells you there's more out
   * there to look for.
   */
  function renderJournal() {
    const found = journalFound(state);
    invNote.textContent = `${found} of ${MUSHROOMS.length} kinds found`;

    const cells = journalRows(state).map((m) => (m.found
      ? `<figure class="shroom" title="${esc(m.name)} · $${m.sell}">
           <div class="shroom-art" style="background-position:-${m.sprite * 48}px 0"></div>
           <figcaption>${esc(m.name)}<b>${m.found}</b></figcaption>
         </figure>`
      : `<figure class="shroom unfound"><div class="shroom-art"></div>
           <figcaption>?</figcaption></figure>`)).join('');

    invList.innerHTML = `<li class="journal"><div class="shroom-grid">${cells}</div></li>`;
  }

  /**
   * The flower journal: which kinds have been picked, how much of each one's
   * colour wheel has been seen, and the seed packets in the drawer.
   *
   * Two halves because they answer different questions. The wheels are the
   * collection — how much of this is left to find — and the drawer is the
   * working stock: what can go back in the ground this afternoon, and where the
   * planting is started from.
   */
  function renderFlowers() {
    const rows = flowerJournalRows(state);
    const found = rows.filter((r) => r.picked > 0).length;
    invNote.textContent = `${found} of ${rows.length} flowers found`;

    const kinds = rows.map((r) => (r.picked > 0
      ? `<figure class="bloom" title="${esc(r.name)} · ${r.hues.length} of ${r.wild} colours">
           <img alt="" src="${flowerDataUrl(r.kind, makeGenome(r.hues[0] * (360 / r.wild)))}">
           <figcaption>${esc(r.name)}<b>${r.hues.length}/${r.wild}</b></figcaption>
         </figure>`
      : `<figure class="bloom unfound"><span></span><figcaption>?</figcaption></figure>`)).join('');

    const groups = seedGroups(state).map((g) => `
      <li class="sell-head"><span>${esc(g.name)}</span><b>${g.seeds.length} kept</b></li>
      ${g.seeds.map((seed) => `
        <li class="seed">
          <img alt="" src="${flowerDataUrl(seed.kind, seed.genome)}">
          <span class="shop-name">${esc(hueName(seed.genome.hue))}${isCross(seed.genome) ? ' <i>cross</i>' : ''}<em>${seed.qty} seed${seed.qty === 1 ? '' : 's'}</em></span>
          <button data-plant="${seed.id}">Plant</button>
        </li>`).join('')}`).join('');

    invList.innerHTML = `<li class="journal"><div class="bloom-grid">${kinds}</div></li>`
      + (groups || '<li class="empty">No seeds yet. Pick a flower to keep its colour.</li>');
  }

  // One delegated listener rather than a handler per packet — the drawer is
  // rebuilt from scratch every time the panel is opened.
  invList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-plant]');
    if (!btn || !onPlantFlower) return;
    const id = btn.dataset.plant;
    setInvOpen(false);
    // Hands back a way to come straight back to the drawer, so planting a row
    // of the same colour is a few taps rather than a trip through the menus
    // for every single one.
    onPlantFlower(id, () => { setInvOpen(true); renderInventory(); });
  });

  function renderStatus() {
    const task = state.tasks.find((t) => t.id === state.farmer.taskId);
    status.textContent = task ? `${taskLabel(task)}…` : 'Idle';
  }

  function render() {
    money.textContent = `$${state.money}`;
    renderStatus();
    const total = Object.values(state.inventory).reduce((a, b) => a + b, 0);
    invBtn.textContent = `Bag ${total}`;
  }

  on('inventory:changed', () => { render(); if (invOpen) renderInventory(); });
  on('mushroom:found', () => { if (invOpen) renderInventory(); });
  on('flower:picked', () => { if (invOpen) renderInventory(); });
  on('money:changed', render);
  on('tasks:changed', render);
  on('task:done', render);
  render();

  return { render, renderStatus };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
