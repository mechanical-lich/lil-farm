// Short-lived messages ("+3 wood", "can't reach that"). Deliberately tiny: on a
// phone there is no room for a log, so toasts stack and expire.

const LIFETIME_MS = 2200;
const MAX_VISIBLE = 3;

let host = null;

export function initToasts() {
  host = document.getElementById('toasts');
}

export function toast(message, kind = 'info') {
  if (!host) return;

  while (host.children.length >= MAX_VISIBLE) host.removeChild(host.firstChild);

  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  host.appendChild(el);

  // Let the element paint before transitioning, so the entry animation runs.
  requestAnimationFrame(() => el.classList.add('in'));

  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 250);
  }, LIFETIME_MS);
}
