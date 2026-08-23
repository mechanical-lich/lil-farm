// The market panel: what the town wants, what it is sick of, and what that is
// doing to the price of everything you grow.
//
// It opens from the money chip. That chip already reads as "your money", so it
// is where a hand goes when the question is about earning, and it costs no room
// on a bottom row that is three buttons wide on a phone.
//
// The whole point of the panel is to make an invisible rule visible. Prices
// that move for reasons the player cannot see are not a mechanic, they are a
// bug they cannot report — so every row shows the two numbers the price is
// computed from, not just the result.

import { on, emit } from '../engine/events.js';
import { marketRows, GLUT_RATIO, PRICE_FLOOR, PRICE_CEILING } from '../sim/market.js';

export function initMarketPanel(state) {
  const panel = document.getElementById('market-panel');
  const list = document.getElementById('market-list');
  const note = document.getElementById('market-note');
  const toggle = document.getElementById('hud-money');

  let open = false;
  const setOpen = (v) => {
    if (open === v) return;
    open = v;
    panel.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    emit(open ? 'panel:open' : 'panel:close', 'market');
    if (open) render();
  };

  on('panel:open', (who) => { if (who !== 'market') setOpen(false); });
  // The sell list links through to here, since that is where a price that has
  // moved is actually noticed.
  on('market:show', () => setOpen(true));
  on('panel:dismiss', () => setOpen(false));
  toggle.addEventListener('click', () => setOpen(!open));
  document.getElementById('market-close').addEventListener('click', () => setOpen(false));

  // The way back out to the shop. The sell list links in here to explain its
  // prices; somebody who has read the explanation and decided to act on it
  // should not have to go the long way round to do it.
  document.getElementById('market-sell').addEventListener('click', () => {
    setOpen(false);
    emit('shop:sell');
  });

  // Prices only move when something is sold or when demand rolls, so there is
  // no reason to redraw on a timer.
  on('money:changed', () => { if (open) render(); });
  on('market:rolled', () => { if (open) render(); });

  function render() {
    const rows = marketRows(state);
    if (rows.length === 0) { list.innerHTML = ''; return; }

    // The headline names what the town most wants, which is not always what
    // pays best — a good can pay well simply because nobody grows it.
    const keenest = [...rows].sort((a, b) => b.appetite - a.appetite)[0];
    // And the second half has to say the right *kind* of bad news. Being
    // swimming in something and having gone off it are different complaints,
    // and the panel said "swimming in wool" about a wool nobody had brought.
    const fullest = [...rows].sort((a, b) => b.ratio - a.ratio)[0];
    const coolest = [...rows].sort((a, b) => a.appetite - b.appetite)[0];
    const second = fullest.ratio > 1.15
      ? `is well stocked with <b>${fullest.name.toLowerCase()}</b>`
      : `has little appetite for <b>${coolest.name.toLowerCase()}</b>`;
    note.innerHTML = `The town has a taste for <b>${keenest.name.toLowerCase()}</b>`
      + ` this week, and ${second}.`
      + `<span class="market-key">`
      + `<i class="wants"></i>wants`
      + `<i class="has"></i>has`
      + `<em>red is more than they need</em>`
      + `</span>`;

    list.innerHTML = rows.map(row).join('');
  }

  /**
   * One good: what the town wants, what it already has, and the price those
   * two produce between them.
   *
   * Two bars rather than one. A single bar was tried and said nothing — for
   * every good the player is not selling the stock is identical, so the bar
   * only repeated what the colour already showed. Wanting and having are the
   * two halves of the rule, and a good can be both wanted and glutted at once,
   * which is exactly when it is worth knowing.
   */
  function row(r) {
    const mood = r.multiplier > 1.08 ? 'short' : r.multiplier < 0.92 ? 'glut' : 'level';
    const change = Math.round((r.multiplier - 1) * 100);
    const label = change === 0 ? 'usual price' : `${change > 0 ? '+' : ''}${change}%`;
    const keen = r.appetite > 1.25 ? 'wanted' : r.appetite < 0.8 ? 'out of favour' : '';

    return `
      <li class="market ${mood}">
        <div class="market-top">
          <span>${r.name}${keen ? ` <em>${keen}</em>` : ''}</span>
          <b>$${r.price}<small>${label}</small></b>
        </div>
        <div class="market-bars" role="img" aria-label="${describe(r)}">
          <div class="market-bar wants"><i style="width:${scale(r.appetite)}%"></i><u></u></div>
          <div class="market-bar has">
            <i style="width:${scale(r.ratio)}%"></i>
            ${excess(r.ratio)}
            <u></u>
          </div>
        </div>
      </li>`;
  }

  /**
   * The part of the stock bar that overhangs the notch, drawn in red.
   *
   * Colouring the whole bar by how much stock there was needed a legend to
   * explain which end meant what, and a legend that needs explaining twice is
   * the wrong answer. Reddening only the overhang says it without a key: what
   * sits past normal is what the town does not need, and there it is.
   */
  function excess(ratio) {
    if (ratio <= 1) return '';
    const from = 50;
    const width = scale(ratio) - from;
    return `<s style="left:${from}%;width:${width.toFixed(1)}%"></s>`;
  }

  /**
   * Both bars are "multiples of normal", so they can share a scale and a notch
   * at the halfway mark. Above twice normal the scale compresses: the far end
   * is a curiosity, and squashing the ordinary range to make room for it would
   * cost the reading that actually matters.
   */
  function scale(multiple) {
    const m = Math.max(0, multiple);
    return m <= 1 ? m * 50 : 50 + (Math.min(m - 1, 2) / 2) * 50;
  }

  /** The bar in words, for anyone who cannot see it. */
  function describe(r) {
    const share = (n) => `${Math.round(n * 100)}%`;
    const times = (n) => `${n.toFixed(1)} times normal`;
    return `${r.name}: demand ${times(r.appetite)}, stock ${times(r.ratio)}`
      + `, selling at ${Math.round(r.multiplier * 100)}% of the usual price`;
  }

  return { render, isOpen: () => open };
}

/** Exported for the tests: the panel must never claim a price it cannot reach. */
export const PANEL_RANGE = { floor: PRICE_FLOOR, ceiling: PRICE_CEILING };
