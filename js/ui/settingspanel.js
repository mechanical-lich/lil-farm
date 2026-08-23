// Settings: backing the farm up, restoring it, and the debug switches that
// used to live only on `window.lilfarm` (unreachable on a phone).
//
// The save lives in localStorage, which the browser is entitled to clear. This
// panel is the only way to get a copy of a farm out and back in again, so the
// import path is deliberately careful: validate, confirm, then replace.

import { getPref, setPref } from '../engine/prefs.js';
import { on, emit } from '../engine/events.js';
import { TESTING, START_INVENTORY } from '../config.js';
import { exportSave, validateSave, writeSave, clearSave, listBackups } from '../engine/save.js';
import { addItem } from '../sim/inventory.js';

/**
 * @param {object} deps
 * @param {() => object} deps.serialize   current farm, as a plain object
 * @param {object} deps.autosaver         disabled before any destructive reload
 * @param {(msg: string, kind?: string) => void} deps.onMessage
 */
export function initSettingsPanel(state, { serialize, autosaver, onMessage } = {}) {
  const panel = document.getElementById('settings-panel');
  const exportBox = document.getElementById('settings-export');
  const importBox = document.getElementById('settings-import');
  const note = document.getElementById('settings-note');
  const backups = document.getElementById('settings-backups');

  let open = false;
  const setOpen = (v) => {
    if (open === v) return;
    open = v;
    panel.classList.toggle('open', open);
    if (open) {
      emit('panel:open', 'settings');
      render();
    } else {
      emit('panel:close', 'settings');
      resetConfirms();
    }
  };
  on('panel:open', (who) => { if (who !== 'settings') setOpen(false); });
  on('panel:dismiss', () => setOpen(false));

  document.getElementById('settings-toggle').addEventListener('click', () => setOpen(!open));
  document.getElementById('settings-close').addEventListener('click', () => setOpen(false));

  function render() {
    exportBox.value = exportSave(serialize());
    note.textContent = TESTING
      ? '⚠ Testing start is ON — new farms begin with everything'
      : `Save is ${Math.round(exportBox.value.length / 1024)} KB`;
    renderBackups();
  }

  /**
   * The copies taken automatically before a version migration. They're the one
   * thing here the player didn't ask for and might badly need, so they get a
   * one-tap route into the restore box rather than living only in storage
   * where nothing but a desktop console could reach them.
   */
  function renderBackups() {
    const found = listBackups();
    if (found.length === 0) { backups.innerHTML = ''; return; }

    backups.innerHTML = `<p class="hint">Kept automatically before the game updated:</p>${
      found.map((b) => `<button data-backup="${b.version}">Use the backup from before v${
        b.version + 1} (${Math.round(b.text.length / 1024)} KB)</button>`).join('')}`;
  }

  backups.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-backup]');
    if (!btn) return;
    const wanted = Number(btn.dataset.backup);
    const backup = listBackups().find((b) => b.version === wanted);
    if (!backup) { onMessage?.('That backup is gone', 'warn'); return; }

    // Dropped into the paste box rather than restored outright, so it goes
    // through the same validate-and-confirm path as anything else.
    importBox.value = backup.text;
    importBox.scrollIntoView({ block: 'nearest' });
    onMessage?.('Backup loaded below — check it, then Load this farm');
  });

  // --- backup ----------------------------------------------------------

  document.getElementById('settings-copy').addEventListener('click', async () => {
    exportBox.value = exportSave(serialize());
    try {
      // Needs a user gesture and a secure context; both hold here.
      await navigator.clipboard.writeText(exportBox.value);
      onMessage?.('Farm copied — paste it somewhere safe');
    } catch {
      // iOS can refuse the clipboard; selecting the text is the fallback.
      exportBox.focus();
      exportBox.select();
      onMessage?.('Copy blocked — the text is selected, copy it by hand', 'warn');
    }
  });

  // --- restore ---------------------------------------------------------

  const importBtn = document.getElementById('settings-import-go');
  confirmable(importBtn, 'Load this farm', 'Really replace your farm?', () => {
    const check = validateSave(importBox.value);
    if (!check.ok) {
      onMessage?.(`Import failed: ${check.reason}`, 'warn');
      return false;                       // keep the panel open to try again
    }

    // Same trap as wiping: the page fires pagehide on its way out, and a live
    // autosaver would write the *old* farm straight back over the imported one.
    autosaver?.disable();
    if (!writeSave(check.data)) {
      onMessage?.('Import failed: could not write the save', 'warn');
      return false;
    }
    location.reload();
    return true;
  });

  // --- debug -----------------------------------------------------------

  // --- display ----------------------------------------------------------
  //
  // Kept in preferences rather than in the save: how the bar looks belongs to
  // the phone and the person holding it, not to the farm. See engine/prefs.js.
  const labelsBtn = document.getElementById('settings-toollabels');
  const showLabels = () => {
    const on = getPref('toolLabels');
    labelsBtn.textContent = on ? 'Tool labels: on' : 'Tool labels: icons only';
    labelsBtn.classList.toggle('on', on);
  };
  labelsBtn.addEventListener('click', () => {
    const next = !getPref('toolLabels');
    setPref('toolLabels', next);
    showLabels();
    emit('prefs:changed', 'toolLabels');
    onMessage?.(next ? 'Tool labels on' : 'Tools show icons only');
  });
  showLabels();

  document.getElementById('settings-give').addEventListener('click', () => {
    for (const [id, qty] of Object.entries(START_INVENTORY)) addItem(state, id, qty);
    state.money += 1000;
    emit('money:changed', { delta: 1000 });
    onMessage?.('Supplies topped up');
  });

  const resetBtn = document.getElementById('settings-reset');
  confirmable(resetBtn, 'Start a new farm', 'Really delete this farm?', () => {
    autosaver?.disable();
    clearSave();
    location.reload();
    return true;
  });

  /**
   * Two-tap confirmation for anything that destroys a farm. A second tap beats
   * a browser confirm() dialog here: it stays inside the game's own styling and
   * can't be dismissed by an accidental swipe.
   */
  function confirmable(btn, idle, armed, run) {
    let armedUntil = 0;
    btn.textContent = idle;
    btn.addEventListener('click', () => {
      if (Date.now() > armedUntil) {
        armedUntil = Date.now() + 4000;
        btn.textContent = armed;
        btn.classList.add('armed');
        setTimeout(() => {
          if (Date.now() > armedUntil) return;
          armedUntil = 0;
          btn.textContent = idle;
          btn.classList.remove('armed');
        }, 4000);
        return;
      }
      armedUntil = 0;
      btn.textContent = idle;
      btn.classList.remove('armed');
      run();
    });
    btn._resetConfirm = () => {
      armedUntil = 0;
      btn.textContent = idle;
      btn.classList.remove('armed');
    };
  }

  function resetConfirms() {
    for (const b of [importBtn, resetBtn]) b._resetConfirm?.();
  }

  on('inventory:changed', () => { if (open) render(); });
  return { setOpen, render };
}
