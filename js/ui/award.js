// The achievement banner: the one thing in the game that stops to be looked at.
//
// This started as a toast, and a toast was wrong for it. Toasts are the game's
// receipt printer — "+3 wood", "queued: water", three at a time, gone in two
// seconds — and putting a thing you might earn twice in a month through the
// same slot said it was worth the same as a log. An achievement is rare enough
// to deserve furniture of its own.
//
// So: the middle of the screen, a plate with a sheen that sweeps across it once,
// a burst of sparks, and about three and a half seconds of holding still before
// it goes. Tapping puts it away early, because the second time you see one you
// will already know what it says.
//
// One at a time, always. Coming back from a week away can land several at once
// (see the catch-up report in main.js), and three of these on top of each other
// would be a pile-up rather than a moment — so they queue and take their turn.

const HOLD_MS = 3500;
const OUT_MS = 420;

/** How many sparks fly. Enough to read as a burst, few enough to stay cheap. */
const SPARKS = 14;

let host = null;
const queue = [];
let showing = false;

export function initAwards() {
  host = document.getElementById('award');
  if (host) host.addEventListener('click', dismiss);
}

/**
 * Shows one, or lines it up behind whatever is already on screen.
 * @param {{name: string, blurb: string}} award
 */
export function showAward(award) {
  if (!host || !award) return;
  queue.push(award);
  if (!showing) next();
}

/** Anything waiting is dropped — used when a farm is being thrown away. */
export function clearAwards() {
  queue.length = 0;
}

let timer = 0;

function next() {
  const award = queue.shift();
  if (!award) { showing = false; return; }
  showing = true;

  host.innerHTML = `
    <div class="award-card">
      <div class="award-rays"></div>
      <div class="award-sparks">${'<i></i>'.repeat(SPARKS)}</div>
      <div class="award-plate">
        <div class="award-medal">🏆</div>
        <div class="award-words">
          <div class="award-kicker">Achievement</div>
          <div class="award-name"></div>
          <div class="award-blurb"></div>
        </div>
        <div class="award-sheen"></div>
      </div>
    </div>`;

  // textContent rather than interpolation: the names are ours, but this is the
  // only place a name is ever printed, and it costs nothing to make it a place
  // where markup can't arrive.
  host.querySelector('.award-name').textContent = award.name;
  host.querySelector('.award-blurb').textContent = award.blurb;

  // Each spark is thrown at its own angle and distance. Set as custom
  // properties so the keyframes stay one rule rather than fourteen.
  const sparks = host.querySelectorAll('.award-sparks i');
  sparks.forEach((spark, i) => {
    const angle = (i / SPARKS) * 360 + (i % 3) * 7;
    spark.style.setProperty('--a', `${angle}deg`);
    spark.style.setProperty('--d', `${58 + (i % 4) * 16}px`);
    spark.style.setProperty('--t', `${(i % 5) * 26}ms`);
  });

  host.classList.add('on');
  // Let it paint at its starting size before the entrance runs, the same
  // reason the toasts do it.
  requestAnimationFrame(() => host.classList.add('in'));

  clearTimeout(timer);
  timer = setTimeout(dismiss, HOLD_MS);
}

function dismiss() {
  if (!showing) return;
  clearTimeout(timer);
  host.classList.remove('in');
  host.classList.add('out');
  setTimeout(() => {
    host.classList.remove('on', 'out');
    host.innerHTML = '';
    showing = false;
    next();
  }, OUT_MS);
}
