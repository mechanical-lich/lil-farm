// The shop panel: buy, animals, land and sell.
//
// Quantity buttons are deliberately coarse (1 / 5 / all) rather than a stepper —
// on a phone, tapping "+" nine times to buy ten seeds is miserable.

import { on, emit } from '../engine/events.js';
import {
  buyList, sellList, sellGroups, groupValue, buy, sell, sellAll, ticksUntilRotation,
  animalList, canBuyAnimal, handRow, canHireHand,
} from '../sim/shop.js';
import { animalCapacity } from '../sim/build.js';
import {
  PLOT, nextLandPrice, ownedCount, totalPlots, buyablePlots, buyPlot, canBuyPlot,
  plotsAcross, plotsDown, plotIndex,
} from '../world/land.js';
import { countItem } from '../sim/inventory.js';
import { decorList } from '../sim/decor.js';

export function initShopPanel(state, {
  onMessage, onPlaceAnimal, onPlaceHand, onPlaceDecor, onLandBought,
} = {}) {
  const panel = document.getElementById('shop-panel');
  const list = document.getElementById('shop-list');
  const tabs = document.getElementById('shop-tabs');
  const note = document.getElementById('shop-note');
  const openBtn = document.getElementById('shop-toggle');

  let tab = 'buy';
  let open = false;
  // Where each list was left. Re-rendering replaces the markup wholesale, so
  // without this a player who scrolls to the bottom of a long list and buys
  // something is dumped back at the top of it.
  const scrolledTo = {};
  // Set when the *remembered* position should win — opening the panel, or
  // switching tabs. Every other render keeps wherever the list is now, because
  // the panel re-renders once a second and forcing a saved value on those
  // would yank the list out from under a finger mid-scroll.
  let restoreScroll = false;
  // Which land cell is armed for a second tap. A cell costs thousands, so it
  // doesn't go through on a stray thumb.
  let armedCell = null;

  const setOpen = (v) => {
    if (open === v) return;
    if (!v) scrolledTo[tab] = list.scrollTop;
    open = v;
    panel.classList.toggle('open', open);
    if (open) {
      // The panels are full-width sheets stacked at the same edge, so only one
      // may be up at a time or they hide each other.
      emit('panel:open', 'shop');
      restoreScroll = true;
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

  // Straight to the sell list, from wherever asked — the market panel offers
  // this once a player has finished reading why their prices moved.
  on('shop:sell', () => {
    tab = 'sell';
    setOpen(true);
    render();
  });

  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    scrolledTo[tab] = list.scrollTop;      // keep this one's place for later
    tab = btn.dataset.tab;
    restoreScroll = true;
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

    // The market explains where these prices came from. Opening it closes the
    // shop on its own, the way any two panels do.
    if (act === 'market') {
      emit('market:show');
      return;
    }

    // Hiring works exactly like buying an animal: the shop steps aside and the
    // player says where they should start.
    if (act === 'hand') {
      const allowed = canHireHand(state);
      if (!allowed.ok) { onMessage?.(allowed.reason, 'warn'); return; }
      setOpen(false);
      onPlaceHand?.();
      return;
    }

    // Decorations are sited like everything else you buy and put down — but
    // they're bought a handful at a time to arrange a corner of the farm, so
    // the shop comes back afterwards exactly as it was left rather than making
    // the player find the Decor tab again for every single bush.
    if (act === 'decor') {
      scrolledTo[tab] = list.scrollTop;
      setOpen(false);
      onPlaceDecor?.(id, () => setOpen(true));
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

    const here = list.scrollTop;
    list.innerHTML = tab === 'buy' ? renderBuy()
      : tab === 'animals' ? renderAnimals()
        : tab === 'decor' ? renderDecor()
          : tab === 'land' ? renderLand()
            : renderSell();
    list.scrollTop = restoreScroll ? (scrolledTo[tab] || 0) : here;
    restoreScroll = false;

    if (tab === 'buy') {
      note.textContent = `New seeds in ${formatDuration(ticksUntilRotation(state))} · $${state.money}`;
    } else if (tab === 'animals') {
      const cap = animalCapacity(state);
      note.textContent = cap === 0
        ? 'Build a barn to keep animals · $' + state.money
        : `Space for ${state.animals.length}/${cap} animals · $${state.money}`;
    } else if (tab === 'decor') {
      note.textContent = `Just for the look of the place · $${state.money}`;
    } else if (tab === 'land') {
      note.textContent = `You own ${ownedCount(state)} of ${totalPlots(state)} plots · $${state.money}`;
    } else {
      note.textContent = `$${state.money}`;
    }
  }

  function renderDecor() {
    return decorList(state).map((row) => `
      <li>
        <span class="shop-name">${esc(row.name)}<em>${esc(row.note)}</em></span>
        <span class="shop-price">$${row.price}</span>
        <button data-act="decor" data-id="${row.kind}" ${row.affordable ? '' : 'disabled'}>Place</button>
      </li>`).join('');
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
          <em>${row.produces ? `gives ${esc(row.produces)}` : 'just for the look of it'}${row.owned ? ` · have ${row.owned}` : ''}</em>
        </span>
        <span class="shop-price">$${row.price}</span>
        <button data-act="animal" data-id="${row.type}" ${row.affordable ? '' : 'disabled'}>Buy</button>
      </li>`);

    // Help, rather than livestock — but it walks around your farm and you
    // choose where it goes, so this is where it belongs.
    const hand = handRow(state);
    rows.push(`
      <li>
        <span class="shop-name">${esc(hand.name)}
          <em>${esc(hand.note)}${hand.owned ? ` · have ${hand.owned}/${hand.capacity}` : ''}</em>
        </span>
        <span class="shop-price">$${hand.price}</span>
        <button data-act="hand" ${hand.affordable ? '' : 'disabled'}>Hire</button>
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
    const groups = sellGroups(state);
    if (groups.length === 0) {
      return '<li class="empty">Nothing to sell yet. Go harvest something!</li>';
    }

    // A way through to the market from where the selling happens: prices that
    // move need somewhere to explain themselves, and the money chip that opens
    // the market panel is not somewhere anyone would think to look. At the
    // foot of the list rather than the head of it — the answer to "why these
    // prices" is only wanted after the prices have been read, and putting it
    // first made the player scroll past an explanation they had not asked for
    // every time they came to sell a crop.
    const link = `
      <li class="market-link">
        <button data-act="market">Why these prices? See the market</button>
      </li>`;

    return groups.map((group) => `
      <li class="sell-head">
        <span>${esc(group.name)}</span>
        <b>$${groupValue(group)}</b>
      </li>
      ${group.rows.map((row) => `
        <li>
          <span class="shop-name">${esc(row.name)}<em>have ${row.qty}</em></span>
          <span class="shop-price ${priceMood(row)}" title="${priceHint(row)}">$${row.price} ea</span>
          <button data-act="sell" data-id="${row.id}" data-qty="1">1</button>
          <button data-act="sell" data-id="${row.id}" data-qty="all">All</button>
        </li>`).join('')}`).join('') + link;
  }

  /**
   * Whether this is fetching more or less than it usually does.
   *
   * The market is where the price comes from, but the shop is where the player
   * decides — so the answer has to be legible at the moment of selling, not
   * only in the panel that explains it. A dead band around the middle keeps
   * every row from being tinted over a couple of percent.
   */
  function priceMood(row) {
    if (!(row.multiplier > 0)) return '';
    if (row.multiplier > 1.08) return 'high';
    if (row.multiplier < 0.92) return 'low';
    return '';
  }

  function priceHint(row) {
    if (!(row.multiplier > 0)) return '';
    const change = Math.round((row.multiplier - 1) * 100);
    if (change === 0) return 'the usual price';
    return `${Math.abs(change)}% ${change > 0 ? 'above' : 'below'} the usual price`;
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
