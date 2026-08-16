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
  /**
   * @param {() => void} tick
   * @param {(alpha: number) => void} render
   * @param {{onQuietCatchup?: () => void}} [hooks] called after a burst that
   *   was run with events suspended, so the caller can refresh whatever those
   *   events would have updated.
   */
  constructor(tick, render, { onQuietCatchup } = {}) {
    this.tick = tick;
    this.render = render;
    this.onQuietCatchup = onQuietCatchup;
    this.running = false;
    this.nextTickTime = 0;
    this.rafId = 0;
    // Guards against a pathological case: if the tab is throttled but alive,
    // don't try to run an unbounded number of ticks in one frame.
    this.maxTicksPerFrame = 600;
    // Past this many ticks in one go, the burst runs with events suspended.
    // A sleeping laptop can leave minutes of backlog, and dispatching it live
    // means a wall of simultaneous toasts for things that happened while
    // nobody was looking.
    this.quietBurst = 30;
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

  /** How far behind wall-clock the simulation is, in whole ticks. */
  backlog(now) {
    return Math.max(0, Math.floor((now - this.nextTickTime) / TICK_MS) + 1);
  }

  pump(now) {
    const quiet = this.backlog(now) > this.quietBurst;
    if (quiet) events.suspend();

    let ran = 0;
    while (now >= this.nextTickTime && ran < this.maxTicksPerFrame) {
      this.tick();
      this.nextTickTime += TICK_MS;
      ran++;
    }
    // If we blew the budget the clock is far behind; resync rather than
    // spending every future frame trying to catch up.
    if (now >= this.nextTickTime) this.nextTickTime = now + TICK_MS;

    if (quiet) {
      events.resume();
      this.onQuietCatchup?.();
    }

    const alpha = 1 - Math.max(0, this.nextTickTime - now) / TICK_MS;
    this.render(Math.min(1, Math.max(0, alpha)));
    return ran;
  }

  /**
   * Puts the tick clock back in step with the wall clock without running
   * anything. Used after an out-of-band catch-up has already advanced the
   * simulation, so pump doesn't then replay the same stretch of time.
   */
  resync(now = Date.now()) {
    this.nextTickTime = now + TICK_MS;
  }
}

/**
 * Replays the ticks that happened while the game was closed.
 *
 * Runs in chunks and yields to the browser between them so a long absence shows
 * progress instead of a frozen white screen. UI events are suspended for the
 * duration: firing thousands of "inventory changed" events would be pure waste.
 *
 * Events fired during the replay are tallied rather than dispatched, so the
 * caller can report what happened while the player was away.
 *
 * @param {number} elapsedMs  wall-clock time since the last completed tick
 * @param {() => void} tick
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{ticks: number, capped: boolean, skipped: number,
 *   tally: object|null}>} `skipped` is the ticks beyond the cap that were
 *   deliberately not replayed; the caller must discard that time from the
 *   farm's clock or it comes back as a fresh backlog on the next load.
 */
export async function runCatchup(elapsedMs, tick, onProgress) {
  const wanted = Math.max(0, Math.floor(elapsedMs / TICK_MS));
  const total = Math.min(wanted, MAX_CATCHUP_TICKS);
  const capped = wanted > MAX_CATCHUP_TICKS;
  const skipped = wanted - total;

  if (total === 0) return { ticks: 0, capped: false, skipped, tally: null };

  events.suspend();
  events.startTally();
  try {
    let done = 0;
    while (done < total) {
      const chunk = Math.min(CATCHUP_CHUNK, total - done);
      for (let i = 0; i < chunk; i++) tick();
      done += chunk;
      if (onProgress) onProgress(done, total);
      if (done < total) await nextFrame();
    }
    return { ticks: total, capped, skipped, tally: events.stopTally() };
  } finally {
    // stopTally in the happy path above; this catches an early failure so a
    // crash mid-replay can't leave the tally collecting forever.
    events.stopTally();
    events.resume();
  }
}

/**
 * Discards time the cap refused to replay.
 *
 * Without this the cap doesn't actually cap: `lastTickTime` only advances by
 * the ticks that ran, so a month away replays seven days, then seven more on
 * the next load, and so on until the backlog drains. The player sits through
 * four catch-ups to arrive where one should have put them.
 */
export function discardSkipped(state, catchup) {
  if (!catchup?.skipped) return 0;
  state.lastTickTime += catchup.skipped * TICK_MS;
  return catchup.skipped;
}

/**
 * Yields to the browser between chunks.
 *
 * Deliberately a timer rather than requestAnimationFrame: rAF never fires in a
 * hidden tab, so a PWA restored in the background would sit at "Catching up…"
 * forever, waiting for a frame that only arrives if someone looks at it. A
 * timer is throttled there but still runs to completion — and it works in Node,
 * which is what makes the chunked path testable at all.
 */
function nextFrame() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
