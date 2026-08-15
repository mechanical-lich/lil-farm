// The shop panel: buy, animals, land and sell.
//
// Quantity buttons are deliberately coarse (1 / 5 / all) rather than a stepper —
// on a phone, tapping "+" nine times to buy ten seeds is miserable.

import { on, emit } from '../engine/events.js';
import {
  buyList, sellList, buy, sell, sellAll, ticksUntilRotation,
  animalList, canBuyAnimal,
} from '../sim/shop.js';
import { animalCapacity } from '../sim/build.js';
import {
  PLOT, nextLandPrice, ownedCount, totalPlots, buyablePlots, buyPlot, canBuyPlot,
  plotsAcross, plotsDown, plotIndex,
} from '../world/land.js';
import { countItem } from '../sim/inventory.js';

export function initShopPanel(state, { onMessage, onPlaceAnimal, onLandBought } = {}) {
  const panel = document.getElementById('shop-panel');
  const list = document.getElementById('shop-list');
  const tabs = document.getElementById('shop-tabs');
  const note = document.getElementById('shop-note');
  const openBtn = document.getElementById('shop-toggle');

  let tab = 'buy';
  let open = false;
  // Which land cell is armed for a second tap. A cell costs thousands, so it
  // doesn't go through on a stray thumb.
  let armedCell = null;

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
      armedCell = null;
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
    // Land is picked from the little map below rather than by tapping the
    // world: a cell is a whole 40x40 farm, five screens wide, so a ghost laid
    // over the map would just wash the whole view green with no way to tell
    // which cell you had. Nine buttons say it in one glance.
    if (act === 'land') {
      const px = Number(btn.dataset.px);
      const py = Number(btn.dataset.py);
      const key = `${px},${py}`;

      if (armedCell !== key) {
        armedCell = key;
        render();
        return;
      }
      armedCell = null;

      const res = buyPlot(state, px, py);
      if (!res.ok) { onMessage?.(res.reason, 'warn'); render(); return; }
      onMessage?.(`Land bought for $${res.price}`);
      onLandBought?.(px, py);
      render();
      return;
    }

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
        : tab === 'land' ? renderLand()
          : renderSell();

    if (tab === 'buy') {
      note.textContent = `New seeds in ${formatDuration(ticksUntilRotation(state))} · $${state.money}`;
    } else if (tab === 'animals') {
      const cap = animalCapacity(state);
      note.textContent = cap === 0
        ? 'Build a barn to keep animals · $' + state.money
        : `Space for ${state.animals.length}/${cap} animals · $${state.money}`;
    } else if (tab === 'land') {
      note.textContent = `You own ${ownedCount(state)} of ${totalPlots(state)} plots · $${state.money}`;
    } else {
      note.textContent = `$${state.money}`;
    }
  }

  /**
   * The valley as a little map: your land in the middle, the cells you can buy
   * around it. Tap one to arm it, tap again to buy.
   */
  function renderLand() {
    const price = nextLandPrice(state);
    const buyable = new Set(buyablePlots(state).map((p) => `${p.px},${p.py}`));
    if (buyable.size === 0) {
      return '<li class="empty">You own the whole valley. Nothing left to buy!</li>';
    }

    const cells = [];
    for (let py = 0; py < plotsDown(state.grid.h); py++) {
      for (let px = 0; px < plotsAcross(state.grid.w); px++) {
        const key = `${px},${py}`;
        if (state.grid.owned.has(plotIndex(px, py, state.grid.w))) {
          cells.push('<span class="land-cell yours">Yours</span>');
        } else if (!buyable.has(key)) {
          cells.push('<span class="land-cell locked"></span>');
        } else {
          const armed = armedCell === key;
          const afford = canBuyPlot(state, px, py).ok;
          cells.push(`<button class="land-cell${armed ? ' armed' : ''}"
            data-act="land" data-px="${px}" data-py="${py}"
            ${afford ? '' : 'disabled'}>${armed ? 'Buy?' : `$${price}`}</button>`);
        }
      }
    }

    return `
      <li class="land-map"><div class="land-grid"
        style="grid-template-columns: repeat(${plotsAcross(state.grid.w)}, 1fr)">
        ${cells.join('')}
      </div></li>
      <li class="empty">Each cell is a whole ${PLOT}x${PLOT} farm, and costs more than the last.</li>`;
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
