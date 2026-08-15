// The shop panel: two tabs, buy and sell.
//
// Quantity buttons are deliberately coarse (1 / 5 / all) rather than a stepper —
// on a phone, tapping "+" nine times to buy ten seeds is miserable.

import { on, emit } from '../engine/events.js';
import {
  buyList, sellList, buy, sell, sellAll, ticksUntilRotation,
} from '../sim/shop.js';
import { countItem } from '../sim/inventory.js';

export function initShopPanel(state, { onMessage } = {}) {
  const panel = document.getElementById('shop-panel');
  const list = document.getElementById('shop-list');
  const tabs = document.getElementById('shop-tabs');
  const note = document.getElementById('shop-note');
  const openBtn = document.getElementById('shop-toggle');

  let tab = 'buy';
  let open = false;

  const setOpen = (v) => {
    open = v;
    panel.classList.toggle('open', open);
    if (open) {
      // The panels are full-width sheets stacked at the same edge, so only one
      // may be up at a time or they hide each other.
      emit('panel:open', 'shop');
      render();
    }
  };
  on('panel:open', (who) => { if (who !== 'shop' && open) setOpen(false); });

  openBtn.addEventListener('click', () => setOpen(!open));
  document.getElementById('shop-close').addEventListener('click', () => setOpen(false));

  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    tab = btn.dataset.tab;
    render();
  });

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;

    const { act, id } = btn.dataset;
    const qty = btn.dataset.qty === 'all' ? null : Number(btn.dataset.qty);

    const result = act === 'buy'
      ? buy(state, id, qty)
      : (qty === null ? sellAll(state, id) : sell(state, id, qty));

    if (!result.ok) {
      onMessage?.(result.reason, 'warn');
    } else if (act === 'buy') {
      onMessage?.(`Bought for $${result.spent}`);
    } else {
      onMessage?.(`Sold ${result.qty} for $${result.earned}`);
    }
    render();
  });

  function render() {
    if (!open) return;

    for (const btn of tabs.querySelectorAll('button[data-tab]')) {
      btn.classList.toggle('on', btn.dataset.tab === tab);
    }

    list.innerHTML = tab === 'buy' ? renderBuy() : renderSell();
    note.textContent = tab === 'buy'
      ? `New seeds in ${formatDuration(ticksUntilRotation(state))} · $${state.money}`
      : `$${state.money}`;
  }

  function renderBuy() {
    const rows = buyList(state).map((row) => {
      const afford1 = state.money >= row.price;
      const afford5 = state.money >= row.price * 5;
      const owned = countItem(state, row.id);
      return `
        <li>
          <span class="shop-name">${esc(row.name)}
            <em>${esc(row.note)}${owned ? ` · have ${owned}` : ''}</em>
          </span>
          <span class="shop-price">$${row.price}</span>
          <button data-act="buy" data-id="${row.id}" data-qty="1" ${afford1 ? '' : 'disabled'}>1</button>
          <button data-act="buy" data-id="${row.id}" data-qty="5" ${afford5 ? '' : 'disabled'}>5</button>
        </li>`;
    });
    return rows.join('');
  }

  function renderSell() {
    const rows = sellList(state);
    if (rows.length === 0) {
      return '<li class="empty">Nothing to sell yet. Go harvest something!</li>';
    }
    return rows.map((row) => `
      <li>
        <span class="shop-name">${esc(row.name)}<em>have ${row.qty}</em></span>
        <span class="shop-price">$${row.price} ea</span>
        <button data-act="sell" data-id="${row.id}" data-qty="1">1</button>
        <button data-act="sell" data-id="${row.id}" data-qty="all">All</button>
      </li>`).join('');
  }

  // Money and stock both change from outside the panel (harvests landing, the
  // rotation flipping), so keep it live while it's on screen.
  on('money:changed', render);
  on('inventory:changed', render);
  setInterval(() => { if (open) render(); }, 1000);

  return { setOpen, render };
}

function formatDuration(ticks) {
  const mins = Math.round(ticks / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
