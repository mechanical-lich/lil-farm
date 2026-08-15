// The "while you were away" card.
//
// This is the payoff of the whole offline-catch-up design: the farm keeps
// running with the tab closed, and coming back should say what happened rather
// than silently presenting a changed field. It's built from the event tally
// collected during the replay (see engine/events.js) plus a look at the farm as
// it now stands, for the things that are a *state* rather than an event — a
// hungry animal or a bed still waiting on water.

import { itemName } from '../sim/inventory.js';
import { isNeglected, isThirsty, isReady } from '../sim/animals.js';
import { isStalled } from '../sim/crops.js';
import { OBJ } from '../world/tiledefs.js';

/**
 * @returns {{headline: string, lines: string[], nudges: string[]}|null}
 *   null when nothing worth interrupting the player for happened.
 */
export function buildSummary(state, catchup) {
  if (!catchup || catchup.ticks < 60) return null;   // under a minute: not news

  const counts = catchup.tally?.counts || {};
  const items = catchup.tally?.items || {};

  const lines = [];

  const tasks = counts['task:done'] || 0;
  if (tasks > 0) lines.push(`${tasks} ${tasks === 1 ? 'job' : 'jobs'} finished`);

  // What actually came in, biggest hauls first.
  const gained = Object.entries(items)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${n} ${itemName(id).toLowerCase()}`);
  if (gained.length) lines.push(`Collected ${listOf(gained)}`);

  const ripened = counts['crop:ripe'] || 0;
  if (ripened > 0) lines.push(`${ripened} ${ripened === 1 ? 'crop' : 'crops'} ripened`);

  const spoiled = counts['crop:died'] || 0;
  if (spoiled > 0) lines.push(`${spoiled} ${spoiled === 1 ? 'crop' : 'crops'} spoiled unpicked`);

  const eggs = counts['animal:laid'] || 0;
  if (eggs > 0) lines.push(`${eggs} ${eggs === 1 ? 'egg was' : 'eggs were'} laid`);


  const weeds = counts['weed:grown'] || 0;
  if (weeds > 0) lines.push(`${weeds} ${weeds === 1 ? 'weed' : 'weeds'} sprang up`);

  // Things that are true *now* rather than events — the reason a farm can look
  // idle. Animals never die, so this is the only way neglect ever shows up.
  const nudges = [];
  const hungry = (state.animals || []).filter(isNeglected);
  if (hungry.length) {
    const thirsty = hungry.filter(isThirsty).length;
    const word = hungry.length === 1 ? 'animal is' : 'animals are';
    nudges.push(`${hungry.length} ${word} ${thirsty >= hungry.length - thirsty ? 'thirsty' : 'hungry'} and not producing`);
  }

  const waiting = Object.values(state.crops || {}).filter(isStalled).length;
  if (waiting) {
    nudges.push(`${waiting} ${waiting === 1 ? 'seed is' : 'seeds are'} still waiting to be watered`);
  }

  // Waiting to be collected. Counted from the farm as it stands rather than
  // from the events, because animals bank several units now — the number that
  // matters is how much is sitting there, not how many times a cow filled up.
  const banked = (state.animals || []).reduce((n, a) => n + (a.stock || 0), 0);
  if (banked) {
    const who = (state.animals || []).filter(isReady).length;
    nudges.push(`${banked} to collect from ${who} ${who === 1 ? 'animal' : 'animals'}`);
  }

  // Eggs sit on the ground until someone picks them up, so they're easy to
  // walk past without noticing.
  const lying = (state.grid?.objects || []).reduce((n, o) => n + (o === OBJ.EGG ? 1 : 0), 0);
  if (lying) nudges.push(`${lying} ${lying === 1 ? 'egg is' : 'eggs are'} waiting to be picked up`);

  if (!lines.length && !nudges.length) return null;

  return { headline: `You were away ${formatAway(catchup.ticks)}`, lines, nudges };
}

function listOf(parts) {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function formatAway(ticks) {
  const mins = Math.round(ticks / 60);
  if (mins < 60) return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `${Math.round(hours / 24)} days`;
}

/** Shows the card. Returns immediately; dismissal is the player's business. */
export function showSummary(summary) {
  if (!summary) return;

  const root = document.getElementById('summary');
  document.getElementById('summary-headline').textContent = summary.headline;

  const list = document.getElementById('summary-lines');
  list.innerHTML = [
    ...summary.lines.map((l) => `<li>${esc(l)}</li>`),
    ...summary.nudges.map((l) => `<li class="nudge">${esc(l)}</li>`),
  ].join('');

  root.classList.add('open');
  const close = () => root.classList.remove('open');
  document.getElementById('summary-close').addEventListener('click', close, { once: true });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
