// HTML escaping for text that goes into a panel's innerHTML.
//
// The panels are built by string concatenation — they are small, they are
// rebuilt whole every time they open, and templating them any other way would
// be more machinery than the whole UI is worth. That makes this function the
// one thing standing between a name and the markup around it.
//
// Most of what passes through is ours (crop names, buildable names), but not
// all of it: a flower's colour name and a mushroom's are generated, and a save
// can be pasted in from anywhere. Escaping everything is cheaper than keeping
// track of which is which.

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
