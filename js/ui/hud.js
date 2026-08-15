// Top-of-screen readout: money, what the farmer is doing, and inventory.

import { on, emit } from '../engine/events.js';
import { inventoryList } from '../sim/inventory.js';
import { taskLabel } from '../sim/tasks.js';

export function initHud(state) {
  const money = document.getElementById('hud-money');
  const status = document.getElementById('hud-status');
  const invBtn = document.getElementById('inv-toggle');
  const invPanel = document.getElementById('inv-panel');
  const invList = document.getElementById('inv-list');

  let invOpen = false;
  const setInvOpen = (v) => {
    invOpen = v;
    invPanel.classList.toggle('open', invOpen);
    if (invOpen) emit('panel:open', 'bag');
  };
  on('panel:open', (who) => { if (who !== 'bag' && invOpen) setInvOpen(false); });
  invBtn.addEventListener('click', () => { setInvOpen(!invOpen); renderInventory(); });
  document.getElementById('inv-close').addEventListener('click', () => setInvOpen(false));

  function renderInventory() {
    const items = inventoryList(state);
    invList.innerHTML = items.length
      ? items.map((i) => `<li><span>${i.name}</span><b>${i.qty}</b></li>`).join('')
      : '<li class="empty">Nothing yet. Clear some land!</li>';
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
  on('money:changed', render);
  on('tasks:changed', render);
  on('task:done', render);
  render();

  return { render, renderStatus };
}
