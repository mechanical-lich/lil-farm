// The journal: everything the farm has turned up, in one place.
//
// Mushrooms, flowers, fish and achievements were tabs of the bag, which was the
// right home when there was one of them and the wrong one by the time there
// were four. The bag is what you are carrying now — a working list that empties
// when you sell — and a journal is what you have found ever. Sharing a panel
// meant the bag opened five tabs wide and the collection was something you got
// to through the thing it isn't.
//
// The four tabs here do have something in common, which is why they are one
// panel rather than four buttons: every one is a grid of slots with the empty
// ones showing. That is the whole point of a collection — the gaps are the part
// that says there is more out there.
//
// The flowers tab is the exception that carries something you can act on: the
// seed drawer, with a Plant button per colour. It lives here rather than in the
// bag because a drawer of thirty colours would bury the wood and the eggs, and
// because somebody looking for a particular colour comes to the wheels first.

import { on, emit } from '../engine/events.js';
import { journalRows, journalFound, MUSHROOMS } from '../sim/mushrooms.js';
import { journalRows as flowerJournalRows, seedGroups } from '../sim/flowers.js';
import { journalRows as fishJournalRows, kindsCaught, FISH_IDS } from '../sim/fish.js';
import { makeGenome, hueName, isCross, petalHue } from '../sim/flowergenes.js';
import { flowerDataUrl } from '../render/flowerart.js';
import { rows as awardRows, earnedCount, ACHIEVEMENTS } from '../sim/achievements.js';
import { esc } from './esc.js';

export function initJournal(state, { onPlantFlower } = {}) {
  const btn = document.getElementById('journal-toggle');
  const panel = document.getElementById('journal-panel');
  const list = document.getElementById('journal-list');
  const tabs = document.getElementById('journal-tabs');
  const note = document.getElementById('journal-note');
  const title = document.getElementById('journal-title');

  let tab = 'mushrooms';
  let open = false;

  const setOpen = (v) => {
    if (open === v) return;
    open = v;
    panel.classList.toggle('open', open);
    emit(open ? 'panel:open' : 'panel:close', 'journal');
  };
  on('panel:open', (who) => { if (who !== 'journal') setOpen(false); });
  on('panel:dismiss', () => setOpen(false));

  btn.addEventListener('click', () => { setOpen(!open); render(); });
  document.getElementById('journal-close').addEventListener('click', () => setOpen(false));
  tabs.addEventListener('click', (e) => {
    const hit = e.target.closest('button[data-tab]');
    if (!hit) return;
    tab = hit.dataset.tab;
    render();
  });

  function render() {
    for (const b of tabs.querySelectorAll('button[data-tab]')) {
      b.classList.toggle('on', b.dataset.tab === tab);
    }
    title.textContent = tab === 'mushrooms' ? 'Mushroom journal'
      : tab === 'flowers' ? 'Flower journal'
        : tab === 'fish' ? 'Fish journal' : 'Achievements';

    if (tab === 'mushrooms') renderMushrooms();
    else if (tab === 'flowers') renderFlowers();
    else if (tab === 'fish') renderFish();
    else renderAwards();
  }

  /**
   * Every mushroom, found or not. Showing the empty slots is the point of a
   * collection — a grid of question marks is what tells you there's more out
   * there to look for.
   */
  function renderMushrooms() {
    note.textContent = `${journalFound(state)} of ${MUSHROOMS.length} kinds found`;

    const cells = journalRows(state).map((m) => (m.found
      ? `<figure class="shroom" title="${esc(m.name)} · $${m.sell}">
           <div class="shroom-art" style="background-position:-${m.sprite * 48}px 0"></div>
           <figcaption>${esc(m.name)}<b>${m.found}</b></figcaption>
         </figure>`
      : `<figure class="shroom unfound"><div class="shroom-art"></div>
           <figcaption>?</figcaption></figure>`)).join('');

    list.innerHTML = `<li class="journal"><div class="shroom-grid">${cells}</div></li>`;
  }

  /**
   * The fish. Same shape as the mushrooms — every species, caught or not,
   * because the empty slots are what say there is more in the pond.
   *
   * The sheet is a single column, so the sprite is selected by sliding the
   * background *down* rather than across.
   */
  function renderFish() {
    note.textContent = `${kindsCaught(state)} of ${FISH_IDS.length} kinds caught`;

    const cells = fishJournalRows(state).map((f) => (f.caught
      ? `<figure class="fish" title="${esc(f.name)} · $${f.sell}">
           <div class="fish-art" style="background-position:0 -${f.sprite * 48}px"></div>
           <figcaption>${esc(f.name)}<b>${f.caught}</b></figcaption>
         </figure>`
      : `<figure class="fish uncaught"><div class="fish-art"></div>
           <figcaption>?</figcaption></figure>`)).join('');

    list.innerHTML = `<li class="journal"><div class="fish-grid">${cells}</div></li>`;
  }

  /**
   * Which kinds have been picked, how much of each one's colour wheel has been
   * seen, and the seed packets in the drawer.
   *
   * Two halves because they answer different questions. The wheels are the
   * collection — how much of this is left to find — and the drawer is the
   * working stock: what can go back in the ground this afternoon, and where the
   * planting is started from.
   */
  function renderFlowers() {
    const rows = flowerJournalRows(state);
    const found = rows.filter((r) => r.picked > 0).length;
    note.textContent = `${found} of ${rows.length} flowers found`;

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
          <span class="shop-name">${esc(hueName(petalHue(seed.genome)))}${isCross(seed.genome) ? ' <i>cross</i>' : ''}<em>${seed.qty} seed${seed.qty === 1 ? '' : 's'}</em></span>
          <button data-plant="${seed.id}">Plant</button>
        </li>`).join('')}`).join('');

    list.innerHTML = `<li class="journal"><div class="bloom-grid">${kinds}</div></li>`
      + (groups || '<li class="empty">No seeds yet. Pick a flower to keep its colour.</li>');
  }

  /**
   * The achievements.
   *
   * Earned ones are spelled out; the rest are a row of blank medals with no
   * name and no clue what they want, which is the whole point — finding out
   * what the farm was watching for is the surprise. The names never reach the
   * DOM at all: see rows() in sim/achievements.js, which withholds them at the
   * source rather than trusting this to remember not to print them.
   */
  function renderAwards() {
    const all = awardRows(state);
    note.textContent = `${earnedCount(state)} of ${ACHIEVEMENTS.length} earned`;

    const won = all.filter((a) => a.earned).map((a) => `
      <li class="award">
        <span class="medal">🏆</span>
        <span class="shop-name">${esc(a.name)}<em>${esc(a.blurb)}</em></span>
      </li>`).join('');

    const locked = all.filter((a) => !a.earned)
      .map(() => '<span class="medal locked">?</span>').join('');

    list.innerHTML = (won || '<li class="empty">Nothing yet. Go and farm!</li>')
      + (locked ? `<li class="journal"><div class="medal-row">${locked}</div></li>` : '');
  }

  // One delegated listener rather than a handler per packet — the drawer is
  // rebuilt from scratch every time the panel is opened.
  list.addEventListener('click', (e) => {
    const hit = e.target.closest('button[data-plant]');
    if (!hit || !onPlantFlower) return;
    const id = hit.dataset.plant;
    setOpen(false);
    // Hands back a way to come straight back to the drawer, so planting a row
    // of the same colour is a few taps rather than a trip through the menus
    // for every single one.
    onPlantFlower(id, () => { setOpen(true); render(); });
  });

  // Only while it is open: a mushroom found with the panel shut is read off the
  // state next time it is opened anyway.
  const refresh = () => { if (open) render(); };
  on('inventory:changed', refresh);
  on('mushroom:found', refresh);
  on('flower:picked', refresh);
  on('achievement:earned', refresh);

  return { render };
}
