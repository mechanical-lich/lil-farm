// localStorage persistence with schema versioning.
//
// This game's whole premise is a long-lived farm, so migrations exist from day
// one: a schema change must never destroy an existing save.

import { SAVE_KEY, SAVE_VERSION, AUTOSAVE_MIN_MS, AUTOSAVE_MAX_MS } from '../config.js';

/**
 * Migrations from version N to N+1, applied in order. Add an entry whenever the
 * shape of the save changes; never edit an existing one.
 * @type {Record<number, (data: any) => any>}
 */
const migrations = {
  // 1: (data) => { data.newField = default; data.version = 2; return data; },
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
    console.error('save is corrupt, keeping a backup and starting fresh', err);
    try { localStorage.setItem(SAVE_KEY + '.corrupt', raw); } catch { /* full disk */ }
    return null;
  }

  return migrate(data);
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
