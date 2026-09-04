// Top-of-screen readout: money, what the farmer is doing, and the bag.
//
// The bag used to carry the collections as extra tabs, which stopped making
// sense at four of them — see ui/journal.js, which they moved to. What is left
// here is the working list: what you are carrying right now, which is a
// different question from what you have ever found.

import { on, emit } from '../engine/events.js';
import { inventoryList } from '../sim/inventory.js';
import { isFlowerSeed } from '../sim/flowergenes.js';
import { taskLabel } from '../sim/tasks.js';

export function initHud(state) {
  const money = document.getElementById('hud-money');
  // The status chip is also the task-queue button (see taskpanel.js); the HUD
  // only owns the text inside it, never the element's own classes or state.
  const status = document.getElementById('hud-status-text');
  // The bag button carries no count. It had one while it lived in the HUD, up
  // beside the money, where a number is what that row is for — but the total
  // weight of everything you own is not a thing anybody acts on, and down in
  // the thumb row it was one more figure moving for no reason.
  const invBtn = document.getElementById('inv-toggle');
  const invPanel = document.getElementById('inv-panel');
  const invList = document.getElementById('inv-list');

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
  document.getElementById('inv-close').addEventListener('click', () => setInvOpen(false));

  function renderInventory() {
    // Flower seeds are collapsed into one line. A collector carries dozens of
    // colours, and thirty rows of them would bury the wood and the eggs — they
    // have a drawer of their own on the journal's Flowers tab, which is where
    // somebody looking for a particular colour is going to go anyway.
    const items = inventoryList(state);
    const packets = items.filter((i) => isFlowerSeed(i.id));
    const rest = items.filter((i) => !isFlowerSeed(i.id));
    const seeds = packets.reduce((n, i) => n + i.qty, 0);

    const rows = rest.map((i) => `<li><span>${i.name}</span><b>${i.qty}</b></li>`);
    if (seeds > 0) {
      const plural = packets.length === 1 ? 'colour' : 'colours';
      rows.push(`<li><span>Flower seeds<em>${packets.length} ${plural} — see the journal</em></span>`
        + `<b>${seeds}</b></li>`);
    }
    invList.innerHTML = rows.length
      ? rows.join('')
      : '<li class="empty">Nothing yet. Clear some land!</li>';
  }

  function renderStatus() {
    const task = state.tasks.find((t) => t.id === state.farmer.taskId);
    status.textContent = task ? `${taskLabel(task)}…` : 'Idle';
  }

  function render() {
    money.textContent = `$${state.money}`;
    renderStatus();
  }

  on('inventory:changed', () => { if (invOpen) renderInventory(); });
  on('money:changed', render);
  on('tasks:changed', render);
  on('task:done', render);
  render();

  return { render, renderStatus };
}
