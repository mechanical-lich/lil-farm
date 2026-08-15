// The task queue panel: what's queued, what's being worked on, and the two
// controls the design doc calls for — cancel, and bump to the top.

import { on, emit } from '../engine/events.js';
import { cancelTask, prioritizeTask, taskLabel } from '../sim/tasks.js';

const MAX_ROWS = 40;   // the list is a queue, not a spreadsheet

export function initTaskPanel(state) {
  const root = document.getElementById('task-panel');
  const list = document.getElementById('task-list');
  const count = document.getElementById('task-count');
  // The queue opens from the status bar rather than its own button: the bar is
  // already what you look at to see what the farmer is doing, so it's where you
  // reach when you want to know what's next. It also gives the bottom row of
  // buttons back a slot's worth of width.
  const toggle = document.getElementById('hud-status');

  let open = false;
  const setOpen = (v) => {
    if (open === v) return;
    open = v;
    root.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    emit(open ? 'panel:open' : 'panel:close', 'tasks');
  };
  on('panel:open', (who) => { if (who !== 'tasks') setOpen(false); });
  on('panel:dismiss', () => setOpen(false));
  toggle.addEventListener('click', () => setOpen(!open));
  document.getElementById('task-close').addEventListener('click', () => setOpen(false));

  // One delegated listener beats re-binding handlers on every render.
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === 'cancel') cancelTask(state, id);
    else if (btn.dataset.act === 'top') prioritizeTask(state, id);
    render();
  });

  function render() {
    const tasks = state.tasks;
    count.textContent = tasks.length;
    toggle.classList.toggle('has-work', tasks.length > 0);

    if (tasks.length === 0) {
      list.innerHTML = '<li class="empty">Nothing queued. Tap the farm to add work.</li>';
      return;
    }

    const rows = tasks.slice(0, MAX_ROWS).map((t) => {
      const active = t.id === state.farmer.taskId;
      const pct = t.work ? Math.round(((t.progress || 0) / t.work) * 100) : 0;
      // A percentage alone doesn't say whether to wait or go do something else;
      // the seconds left is the number the player actually wants.
      const left = Math.max(0, (t.work || 0) - (t.progress || 0));
      const meta = active ? `${pct}% · ${formatSeconds(left)} left` : formatSeconds(t.work);
      return `
        <li class="${active ? 'active' : ''}">
          <span class="task-name">${escapeHtml(taskLabel(t))}</span>
          <span class="task-meta">${meta}</span>
          <button data-act="top" data-id="${t.id}" title="Do this next">↑</button>
          <button data-act="cancel" data-id="${t.id}" title="Cancel">✕</button>
        </li>`;
    });

    if (tasks.length > MAX_ROWS) {
      rows.push(`<li class="empty">+ ${tasks.length - MAX_ROWS} more…</li>`);
    }
    list.innerHTML = rows.join('');
  }

  on('tasks:changed', render);
  render();

  // Progress percentages change every tick; refresh only while the panel is
  // actually visible so a closed panel costs nothing.
  setInterval(() => { if (open) render(); }, 500);

  return { render, setOpen: (v) => setOpen(v) };
}

/** Ticks are seconds; anything long enough gets minutes so it stays readable. */
function formatSeconds(ticks) {
  if (ticks < 60) return `${ticks}s`;
  const mins = Math.floor(ticks / 60);
  const secs = ticks % 60;
  return secs ? `${mins}m ${secs}s` : `${mins}m`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
