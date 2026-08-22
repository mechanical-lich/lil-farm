// localStorage persistence with schema versioning.
//
// This game's whole premise is a long-lived farm, so migrations exist from day
// one: a schema change must never destroy an existing save.

import {
  SAVE_KEY, SAVE_VERSION, AUTOSAVE_MIN_MS, AUTOSAVE_MAX_MS, ANIMAL_VARIANTS,
} from '../config.js';
import { expandSaveToCells } from '../world/expand.js';
import { newMarket } from '../sim/market.js';

/**
 * Migrations from version N to N+1, applied in order. Add an entry whenever the
 * shape of the save changes; never edit an existing one.
 * @type {Record<number, (data: any) => any>}
 */
const migrations = {
  // Land ownership arrived here, but the geometry changed again in 3 and the
  // grant is done there, over the whole of the player's old map. Nothing to do
  // but move the version along.
  1: (data) => { data.version = 2; return data; },

  // The 3x3 world. The old 40x40 map becomes the middle cell and the player
  // keeps all of it; eight new cells are generated around it. See world/expand.js.
  2: (data) => {
    expandSaveToCells(data);
    data.version = 3;
    return data;
  },

  // Milked and sheared animals bank several units instead of stopping at one.
  // A cow standing there ready was owed its milk; don't quietly pocket it.
  3: (data) => {
    for (const a of data.animals || []) {
      a.stock = a.ready ? 1 : 0;
      delete a.ready;
    }
    data.version = 4;
    return data;
  },

  // Animals come in colours now. Existing ones are spread across the columns
  // by id rather than all defaulting to the first, so an established farm gets
  // the variety a new one would instead of a herd of identical white cows.
  4: (data) => {
    for (const a of data.animals || []) {
      if (a.variant == null) a.variant = a.id % ANIMAL_VARIANTS;
    }
    data.version = 5;
    return data;
  },

  // Barns are sized by the player now, so a building carries its own footprint
  // instead of every one of them being whatever the recipe said. Existing barns
  // were all 3x2 and stay exactly that — the same ground, the same four animals
  // — but the record has to say so, because the recipe no longer speaks for it.
  //
  // Queued builds are stamped too. One caught mid-flight would otherwise finish
  // as a barn with no size at all.
  5: (data) => {
    for (const b of data.buildings || []) {
      if (!(b.w > 0)) { b.w = 3; b.h = 2; }
    }
    for (const t of data.tasks || []) {
      if (t.type === 'build' && t.buildKind === 'barn' && !(t.w > 0)) { t.w = 3; t.h = 2; }
    }
    data.version = 6;
    return data;
  },

  // Crops and produce are traded on a market now. An established farm opens on
  // a balanced one — every price exactly what it has always been — and moves
  // from there as it sells. Starting anywhere else would hand somebody a
  // fortune or a pay cut for a day's play they had already done.
  6: (data) => {
    if (!data.market) data.market = newMarket();
    data.version = 7;
    return data;
  },
};

export function loadSave() {
  let raw;
  try {
    raw = localStorage.getItem(SAVE_KEY);
  } catch (err) {
    console.warn('localStorage unavailable', err);
    return null;
  }
  if (!raw) return null;

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return giveUp(raw, 'save is corrupt', err);
  }

  // A migration rewrites a farm that may be months old, on a schema the code
  // that wrote it never saw. Keep the original first, untouched, so a bad
  // migration is recoverable rather than final.
  backupBeforeMigration(raw, data.version);

  const migrated = migrate(data);

  // Parsing is not the same as being a farm. A write cut short by a full disk
  // or a killed tab can leave something that parses perfectly and has nothing
  // in it — and that used to sail through to boot and die on state.farmer.x,
  // with no backup and no fresh start. The game was then dead until someone
  // cleared localStorage by hand, which is not a thing to ask of a player.
  if (!isPlayableFarm(migrated)) {
    return giveUp(raw, 'save is missing its farm');
  }
  return migrated;
}

/**
 * Keeps the unreadable save aside and starts fresh. The copy is what makes
 * this recoverable: it can be pasted back in from the settings panel once
 * whatever went wrong is fixed.
 */
function giveUp(raw, why, err) {
  console.error(`${why}; keeping a copy and starting fresh`, err || '');
  try { localStorage.setItem(SAVE_KEY + '.corrupt', raw); } catch { /* full disk */ }
  return null;
}

/** The bare minimum for deserialize() to produce something playable. */
export function isPlayableFarm(data) {
  return !!(data && data.map && data.farmer);
}

/** Where the copy of a save from before version N's migration is kept. */
export function backupKey(version) { return `${SAVE_KEY}.backup.v${version}`; }

/**
 * Copies the raw save aside before migrating it.
 *
 * Keyed by the version it came *from*, so migrating across several releases
 * leaves one backup per generation rather than each overwriting the last. It
 * never overwrites an existing backup: if a migration went wrong and the player
 * reloads, the second load must not replace the good copy with the bad one.
 *
 * A backup that can't be written is a warning, not a failure — refusing to load
 * someone's farm because there was no room for a safety copy would be a worse
 * outcome than the risk it guards against.
 */
export function backupBeforeMigration(raw, version) {
  if (typeof version !== 'number' || version >= SAVE_VERSION) return null;

  const key = backupKey(version);
  try {
    if (localStorage.getItem(key) !== null) return key;   // already have one
    localStorage.setItem(key, raw);
    console.info(`kept a backup of your v${version} farm at ${key}`);
    return key;
  } catch (err) {
    console.warn('could not back the save up before migrating', err);
    return null;
  }
}

/**
 * Pre-migration backups that are still around, newest schema first.
 * @returns {Array<{key: string, version: number, text: string}>}
 */
export function listBackups() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const match = key && key.match(new RegExp(`^${SAVE_KEY}\\.backup\\.v(\\d+)$`));
      if (!match) continue;
      out.push({ key, version: Number(match[1]), text: localStorage.getItem(key) });
    }
  } catch { /* storage unavailable; nothing to offer */ }
  return out.sort((a, b) => b.version - a.version);
}

export function migrate(data) {
  if (!data || typeof data.version !== 'number') return null;
  while (data.version < SAVE_VERSION) {
    const step = migrations[data.version];
    if (!step) {
      console.error(`no migration from save version ${data.version}; refusing to load`);
      return null;
    }
    data = step(data);
  }
  if (data.version > SAVE_VERSION) {
    console.error('save is from a newer version of the game; refusing to load');
    return null;
  }
  return data;
}

export function writeSave(serialized) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(serialized));
    return true;
  } catch (err) {
    // Quota exceeded or Safari private mode. Not fatal — play continues.
    console.error('could not write save', err);
    return false;
  }
}

export function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
}

/**
 * Checks a pasted save without applying it.
 *
 * Run before writing anything: an import replaces a farm that may be weeks old,
 * so a typo in the paste box must fail loudly rather than half-load. Migrations
 * run here too, which is what lets a save from an older build be imported.
 *
 * @returns {{ok: boolean, reason?: string, data?: object}}
 */
export function validateSave(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'nothing pasted' };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "that isn't a save file" };
  }

  const migrated = migrate(parsed);
  if (!migrated) {
    return { ok: false, reason: 'that save is from an incompatible version' };
  }
  // A structurally valid save always has a map and a farmer; without this a
  // stray JSON object would sail through migrate() and crash on load instead.
  // loadSave applies the same test — see isPlayableFarm.
  if (!isPlayableFarm(migrated)) {
    return { ok: false, reason: "that save is missing its farm" };
  }
  return { ok: true, data: migrated };
}

/** The current farm as text, for the player to copy somewhere safe. */
export function exportSave(serialized) {
  return JSON.stringify(serialized);
}

/**
 * Throttled autosave. Writes at most once per AUTOSAVE_MIN_MS, and at least
 * once per AUTOSAVE_MAX_MS while the state is dirty.
 */
export class Autosaver {
  constructor(serialize) {
    this.serialize = serialize;
    this.dirty = false;
    this.dirtySince = 0;
    this.lastWrite = 0;
    this.enabled = true;
  }

  /**
   * Stops all further writes. Needed when deliberately discarding a farm: the
   * page still fires visibilitychange/pagehide on its way out, and those
   * handlers would otherwise write the in-memory state straight back over the
   * save we just cleared.
   */
  disable() {
    this.enabled = false;
    this.dirty = false;
  }

  markDirty(now) {
    if (!this.enabled) return;
    if (!this.dirty) {
      this.dirty = true;
      this.dirtySince = now;
    }
  }

  maybeSave(now) {
    if (!this.enabled || !this.dirty) return false;
    const sinceWrite = now - this.lastWrite;
    const sinceDirty = now - this.dirtySince;
    if (sinceWrite < AUTOSAVE_MIN_MS) return false;
    if (sinceDirty < AUTOSAVE_MAX_MS && sinceWrite < AUTOSAVE_MAX_MS) return false;
    return this.saveNow(now);
  }

  /** Write on demand, used on visibilitychange/pagehide. */
  saveNow(now = Date.now()) {
    if (!this.enabled) return false;
    const ok = writeSave(this.serialize());
    this.lastWrite = now;
    this.dirty = false;
    return ok;
  }
}
