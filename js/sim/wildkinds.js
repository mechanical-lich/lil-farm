// Wild animals: who might wander onto the farm, and how hard each is to win
// over.
//
// Pure data, deliberately. sim/animals.js reads this table to make every one of
// these a real animal kind — so a befriended fox eats, drinks and is drawn by
// exactly the code that feeds and draws a horse — and sim/wildlife.js reads it
// to decide what turns up. Keeping the table in a file that imports nothing is
// what lets both of those depend on it without depending on each other.
//
// Two sheets, one column each, one animal per row: assets/animals/wildlife.png
// for what you would meet outdoors at home, assets/animals/exotic.png for what
// you would have to travel for. `row` is the row on the sheet.
//
// **`id` is permanent; `name` is not.** The id is the key in the save — in the
// journal and on every animal standing on a farm — so correcting a sprite's
// name means changing `name` and leaving `id` alone. The names here are the
// artist's own list, in sheet order; a sheet edited later must keep `row` in
// step, which the tests check against the image's height.
//
// `tame` is how many times it must be fussed over before it trusts you. Small
// and common things come round quickly; big predators and anything from abroad
// take a good deal longer. `weight` is a spawn weight — how often it is the one
// that turns up — and is the only rarity there is.
//
// `intimidating` is the chance, from 0 to 1, that it scares one of your own
// animals each time it comes close to it — see intimidate in sim/wildlife.js.
// Predators near the top, prey at zero, big herbivores in between because
// something the size of a rhino is alarming whatever it eats. Only while it's
// wild: once it trusts you it is one of yours and frightens nobody.
//
// `swims` puts an animal on the water like a duck, which suits the frog, the
// turtle, the alligator and the hippo better than the alternative of an
// alligator that walks round the pond.

export const WILDLIFE_SHEETS = { wildlife: 'assets/animals/wildlife.png', exotic: 'assets/animals/exotic.png' };

export const WILD_KINDS = {
  // --- wildlife.png ------------------------------------------------------
  wolf: { name: 'Wolf', sheet: 'wildlife', row: 0, tame: 6, weight: 4, intimidating: 0.8 },
  cat: { name: 'Cat', sheet: 'wildlife', row: 1, tame: 4, weight: 7, intimidating: 0.3 },
  owl: { name: 'Owl', sheet: 'wildlife', row: 2, tame: 4, weight: 6, intimidating: 0.2 },
  hawk: { name: 'Hawk', sheet: 'wildlife', row: 3, tame: 4, weight: 6, intimidating: 0.4 },
  eagle: { name: 'Eagle', sheet: 'wildlife', row: 4, tame: 6, weight: 3, intimidating: 0.5 },
  crow: { name: 'Crow', sheet: 'wildlife', row: 5, tame: 2, weight: 10, intimidating: 0.1 },
  bat: { name: 'Bat', sheet: 'wildlife', row: 6, tame: 3, weight: 7, intimidating: 0.15 },
  lizard: { name: 'Lizard', sheet: 'wildlife', row: 7, tame: 3, weight: 8, intimidating: 0.05 },
  frog: { name: 'Frog', sheet: 'wildlife', row: 8, tame: 2, weight: 10, intimidating: 0, swims: true },
  turtle: { name: 'Turtle', sheet: 'wildlife', row: 9, tame: 3, weight: 7, intimidating: 0, swims: true },
  boar: { name: 'Boar', sheet: 'wildlife', row: 10, tame: 5, weight: 4, intimidating: 0.5 },
  deer: { name: 'Deer', sheet: 'wildlife', row: 11, tame: 4, weight: 8, intimidating: 0 },
  moose: { name: 'Moose', sheet: 'wildlife', row: 12, tame: 6, weight: 3, intimidating: 0.3 },
  grizzly: { name: 'Grizzly Bear', sheet: 'wildlife', row: 13, tame: 8, weight: 2, intimidating: 0.9 },
  blackbear: { name: 'Black Bear', sheet: 'wildlife', row: 14, tame: 7, weight: 2, intimidating: 0.8 },
  fox: { name: 'Fox', sheet: 'wildlife', row: 15, tame: 4, weight: 7, intimidating: 0.5 },
  squirrel: { name: 'Squirrel', sheet: 'wildlife', row: 16, tame: 3, weight: 10, intimidating: 0 },
  weasel: { name: 'Weasel', sheet: 'wildlife', row: 17, tame: 3, weight: 6, intimidating: 0.3 },
  rabbit: { name: 'Rabbit', sheet: 'wildlife', row: 18, tame: 3, weight: 10, intimidating: 0 },
  raccoon: { name: 'Raccoon', sheet: 'wildlife', row: 19, tame: 4, weight: 7, intimidating: 0.2 },
  rat: { name: 'Rat', sheet: 'wildlife', row: 20, tame: 2, weight: 9, intimidating: 0.1 },

  // --- exotic.png -------------------------------------------------------
  cobra: { name: 'Cobra', sheet: 'exotic', row: 0, tame: 8, weight: 3, intimidating: 0.7 },
  hyena: { name: 'Hyena', sheet: 'exotic', row: 1, tame: 10, weight: 2, intimidating: 0.8 },
  camel: { name: 'Camel', sheet: 'exotic', row: 2, tame: 9, weight: 2, intimidating: 0.1 },
  scorpion: { name: 'Scorpion', sheet: 'exotic', row: 3, tame: 10, weight: 2, intimidating: 0.4 },
  alligator: { name: 'Alligator', sheet: 'exotic', row: 4, tame: 14, weight: 1, intimidating: 0.9, swims: true },
  emu: { name: 'Emu', sheet: 'exotic', row: 5, tame: 8, weight: 3, intimidating: 0.2 },
  zebra: { name: 'Zebra', sheet: 'exotic', row: 6, tame: 10, weight: 2, intimidating: 0.1 },
  lion: { name: 'Lion', sheet: 'exotic', row: 7, tame: 14, weight: 1, intimidating: 1.0 },
  tiger: { name: 'Tiger', sheet: 'exotic', row: 8, tame: 15, weight: 1, intimidating: 1.0 },
  elephant: { name: 'Elephant', sheet: 'exotic', row: 9, tame: 12, weight: 1, intimidating: 0.4 },
  giraffe: { name: 'Giraffe', sheet: 'exotic', row: 10, tame: 11, weight: 1, intimidating: 0.1 },
  polarbear: { name: 'Polar Bear', sheet: 'exotic', row: 11, tame: 15, weight: 1, intimidating: 0.9 },
  gorilla: { name: 'Gorilla', sheet: 'exotic', row: 12, tame: 13, weight: 1, intimidating: 0.6 },
  chimpanzee: { name: 'Chimpanzee', sheet: 'exotic', row: 13, tame: 10, weight: 2, intimidating: 0.3 },
  monkey: { name: 'Monkey', sheet: 'exotic', row: 14, tame: 8, weight: 3, intimidating: 0.1 },
  rhino: { name: 'Rhino', sheet: 'exotic', row: 15, tame: 13, weight: 1, intimidating: 0.5 },
  hippo: { name: 'Hippo', sheet: 'exotic', row: 16, tame: 13, weight: 1, intimidating: 0.6, swims: true },
  honeybadger: { name: 'Honey Badger', sheet: 'exotic', row: 17, tame: 12, weight: 2, intimidating: 0.7 },
};

export const WILD_IDS = Object.keys(WILD_KINDS);
