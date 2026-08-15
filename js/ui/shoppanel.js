// The shop panel: two tabs, buy and sell.
//
// Quantity buttons are deliberately coarse (1 / 5 / all) rather than a stepper —
// on a phone, tapping "+" nine times to buy ten seeds is miserable.

import { on, emit } from '../engine/events.js';
import {
  buyList, sellList, buy, sell, sellAll, ticksUntilRotation,
  animalList, canBuyAnimal,
} from '../sim/shop.js';
import { animalCapacity } from '../sim/build.js';
import { countItem } from '../sim/inventory.js';

export function initShopPanel(state, { onMessage, onPlaceAnimal } = {}) {
  const panel = document.getElementById('shop-panel');
  const list = document.getElementById('shop-list');
  const tabs = document.getElementById('shop-tabs');
  const note = document.getElementById('shop-note');
  const openBtn = document.getElementById('shop-toggle');

  let tab = 'buy';
  let open = false;

  const setOpen = (v) => {
    if (open === v) return;
    open = v;
    panel.classList.toggle('open', open);
    if (open) {
      // The panels are full-width sheets stacked at the same edge, so only one
      // may be up at a time or they hide each other.
      emit('panel:open', 'shop');
      render();
    } else {
      emit('panel:close', 'shop');
    }
  };
  on('panel:open', (who) => { if (who !== 'shop') setOpen(false); });
  on('panel:dismiss', () => setOpen(false));

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

    // Livestock doesn't complete here: the shop closes and hands off to the
    // placement flow so the player chooses where the animal lives. Nothing is
    // charged until they confirm a spot.
    if (act === 'animal') {
      const allowed = canBuyAnimal(state, id);
      if (!allowed.ok) { onMessage?.(allowed.reason, 'warn'); return; }
      setOpen(false);
      onPlaceAnimal?.(id);
      return;
    }

    let result;
    if (act === 'buy') result = buy(state, id, qty);
    else result = qty === null ? sellAll(state, id) : sell(state, id, qty);

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

    list.innerHTML = tab === 'buy' ? renderBuy()
      : tab === 'animals' ? renderAnimals()
        : renderSell();

    if (tab === 'buy') {
      note.textContent = `New seeds in ${formatDuration(ticksUntilRotation(state))} · $${state.money}`;
    } else if (tab === 'animals') {
      const cap = animalCapacity(state);
      note.textContent = cap === 0
        ? 'Build a barn to keep animals · $' + state.money
        : `Space for ${state.animals.length}/${cap} animals · $${state.money}`;
    } else {
      note.textContent = `$${state.money}`;
    }
  }

  function renderAnimals() {
    const rows = animalList(state).map((row) => `
      <li>
        <span class="shop-name">${esc(row.name)}
          <em>gives ${esc(row.produces)}${row.owned ? ` · have ${row.owned}` : ''}</em>
        </span>
        <span class="shop-price">$${row.price}</span>
        <button data-act="animal" data-id="${row.type}" ${row.affordable ? '' : 'disabled'}>Buy</button>
      </li>`);
    return rows.join('');
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
