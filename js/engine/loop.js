// The fixed-timestep scheduler and the offline catch-up runner.
//
// The simulation advances in whole ticks of TICK_MS and never depends on frame
// timing. Rendering interpolates between ticks. This split is what makes "the
// farm keeps running while the tab is closed" work: catching up is just running
// the same tick function in a tight loop.

import { TICK_MS, MAX_CATCHUP_TICKS, CATCHUP_CHUNK } from '../config.js';
import * as events from './events.js';

export class GameLoop {
  /**
   * @param {() => void} tick   advances the simulation exactly one tick
   * @param {(alpha: number) => void} render  alpha is 0..1 progress toward the next tick
   */
  constructor(tick, render) {
    this.tick = tick;
    this.render = render;
    this.running = false;
    this.nextTickTime = 0;
    this.rafId = 0;
    // Guards against a pathological case: if the tab is throttled but alive,
    // don't try to run an unbounded number of ticks in one frame.
    this.maxTicksPerFrame = 600;
  }

  start(now = Date.now()) {
    this.running = true;
    this.nextTickTime = now + TICK_MS;
    const frame = () => {
      if (!this.running) return;
      this.pump(Date.now());
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  pump(now) {
    let ran = 0;
    while (now >= this.nextTickTime && ran < this.maxTicksPerFrame) {
      this.tick();
      this.nextTickTime += TICK_MS;
      ran++;
    }
    // If we blew the budget the clock is far behind; resync rather than
    // spending every future frame trying to catch up.
    if (now >= this.nextTickTime) this.nextTickTime = now + TICK_MS;

    const alpha = 1 - Math.max(0, this.nextTickTime - now) / TICK_MS;
    this.render(Math.min(1, Math.max(0, alpha)));
  }
}

/**
 * Replays the ticks that happened while the game was closed.
 *
 * Runs in chunks and yields to the browser between them so a long absence shows
 * progress instead of a frozen white screen. UI events are suspended for the
 * duration: firing thousands of "inventory changed" events would be pure waste.
 *
 * @param {number} elapsedMs  wall-clock time since the last completed tick
 * @param {() => void} tick
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{ticks: number, capped: boolean}>}
 */
export async function runCatchup(elapsedMs, tick, onProgress) {
  const wanted = Math.max(0, Math.floor(elapsedMs / TICK_MS));
  const total = Math.min(wanted, MAX_CATCHUP_TICKS);
  const capped = wanted > MAX_CATCHUP_TICKS;

  if (total === 0) return { ticks: 0, capped: false };

  events.suspend();
  try {
    let done = 0;
    while (done < total) {
      const chunk = Math.min(CATCHUP_CHUNK, total - done);
      for (let i = 0; i < chunk; i++) tick();
      done += chunk;
      if (onProgress) onProgress(done, total);
      if (done < total) await nextFrame();
    }
  } finally {
    events.resume();
  }

  return { ticks: total, capped };
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
