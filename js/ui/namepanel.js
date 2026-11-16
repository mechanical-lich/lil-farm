// The naming card: one text field, for calling an animal something.
//
// It is the only place in the game the player types, which sets most of what
// is unusual about it. The field is filled through .value and read back the
// same way — never through innerHTML — so a name is only ever text. The save
// button and the keyboard's own "done" both go through the form's submit, so
// there is one path out with a name and one without.
//
// Emptying the field and saving takes the name away again; that is said on the
// card, because otherwise there is no way to discover it.

import { NAME_MAX } from '../sim/animals.js';

/**
 * Opens the card for one animal.
 *
 * @param {object} opts
 * @param {string} opts.title    e.g. "Name your fox"
 * @param {string} [opts.current] the name it has now, if any
 * @param {(name: string) => void} opts.onSave called with the raw text, which
 *   may be empty; cleaning it is the simulation's business, not the card's
 * @param {() => void} [opts.onClose] called however the card goes away
 * @param {{label: string, note?: string, disabled?: boolean, onClick: () => void}} [opts.action]
 *   one more thing that can be done to this animal — sending it to the
 *   sanctuary, or fetching it home. Shown under the name, apart from the
 *   save row, and closes the card when pressed.
 */
export function openNamePanel({ title, current = '', onSave, onClose, action = null }) {
  const root = document.getElementById('namer');
  const form = document.getElementById('namer-form');
  const input = document.getElementById('namer-input');
  const cancel = document.getElementById('namer-cancel');
  if (!root || !form || !input) return;

  document.getElementById('namer-title').textContent = title;
  document.getElementById('namer-hint').textContent = current
    ? 'Clear the box to take the name away.'
    : `Up to ${NAME_MAX} letters.`;
  input.maxLength = NAME_MAX * 2;   // code units; the real limit is applied on save
  input.value = current;

  const act = document.getElementById('namer-action');
  const note = document.getElementById('namer-action-note');
  act.hidden = !action;
  note.hidden = !action?.note;
  if (action) {
    act.textContent = action.label;
    act.disabled = !!action.disabled;
    note.textContent = action.note || '';
  }
  const doAction = () => {
    close();
    action?.onClick();
  };

  const close = () => {
    root.classList.remove('open');
    form.removeEventListener('submit', submit);
    cancel.removeEventListener('click', close);
    act.removeEventListener('click', doAction);
    root.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', escape);
    input.blur();
    onClose?.();
  };
  const submit = (e) => {
    e.preventDefault();
    const text = input.value;
    close();
    onSave(text);
  };
  // A tap on the dimmed farm behind the card is "never mind", as it is for
  // every other panel.
  const outside = (e) => { if (e.target === root) close(); };
  const escape = (e) => { if (e.key === 'Escape') close(); };

  form.addEventListener('submit', submit);
  cancel.addEventListener('click', close);
  act.addEventListener('click', doAction);
  root.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', escape);

  root.classList.add('open');
  // Focused so a keyboard is ready on a desktop. On a phone this only raises
  // the keyboard when the card was opened by a tap, which is the case that
  // matters; opened any other way the player taps the box, which is fine.
  input.focus();
  input.select();
}

/** Is the card up? Other things that would open over it ask first. */
export function namePanelOpen() {
  return !!document.getElementById('namer')?.classList.contains('open');
}
