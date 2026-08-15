// Top-of-screen readout: money, what the farmer is doing, and inventory.

import { on, emit } from '../engine/events.js';
import { inventoryList } from '../sim/inventory.js';
import { journalRows, journalFound, MUSHROOMS } from '../sim/mushrooms.js';
import { taskLabel } from '../sim/tasks.js';

export function initHud(state) {
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
    invTitle.textContent = invTab === 'bag' ? 'Bag' : 'Mushroom journal';

    if (invTab === 'journal') { renderJournal(); return; }

    invNote.textContent = '';
    const items = inventoryList(state);
    invList.innerHTML = items.length
      ? items.map((i) => `<li><span>${i.name}</span><b>${i.qty}</b></li>`).join('')
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
