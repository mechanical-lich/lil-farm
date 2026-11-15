// Draws the wild animals that weren't drawn by hand.
//
//   node tools/make-wild-kinds.mjs
//
// The first twenty-one animals on assets/animals/wildlife.png and the first
// eighteen on assets/animals/exotic.png were drawn by the artist in Aseprite.
// Everything below those rows was drawn here, as text, and this file is its
// source — the same arrangement as tools/make-flower-kinds.mjs, where the
// hand-drawn flowers come first and the generated ones follow. Change a grid
// and rerun; a shape edit is then a diff of characters rather than an opaque
// change to a PNG.
//
// Several of these start from one of the artist's own silhouettes recoloured
// and touched up — a coyote from the fox, a leopard from the tiger, a red
// panda from the raccoon — which is how the hand-drawn sheet already works:
// the black bear is the grizzly in another coat, the eagle is the hawk.
//
// Grids are the *inside* only. The heavy dark outline every sprite on these
// sheets wears is grown by the rule in tools/outline.mjs, which reproduces
// the artist's thirty-nine animals pixel for pixel — with one convention on
// top: nothing is drawn below an animal's lowest pixel, so a thing standing
// on the ground has no line under its feet (the boar, the rabbit, the frog).
// A bird on a perch does have one (the crow), so PERCHED lists the kinds that
// want the line back.
//
// The one thing the rule means for drawing: any gap narrower than about four
// pixels fills in with outline, which is why legs are two pixels apart and
// read as legs.
//
// Legend — the sheet's own palette, nothing new but the flamingo's pinks
//   o       outline, where a design wants a dark pixel inside itself (an eye)
//   W w m   white, light grey, mid grey
//   d k     dark grey (the artist's black: the black bear, the cat) and darker
//   r b t p dark brown, brown, tan, pale tan
//   T       the warmer tan the boar's tusk and the rat's belly wear
//   g G     green and bright green
//   y Y     orange and yellow
//   P R     pink and red
//   .       nothing
//
// Each kind is written to the row js/sim/wildkinds.js says it lives on, so
// the table decides placement and this file decides the pixels. The
// hand-drawn rows are never touched. Safe to rerun: the second run writes
// exactly the bytes the first one did.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';
import { isOutline } from './outline.mjs';
import { WILD_KINDS, WILDLIFE_SHEETS } from '../js/sim/wildkinds.js';

const T = 16;

/** How many rows of each sheet the artist drew. Everything after is ours. */
export const HAND_DRAWN = { wildlife: 21, exotic: 18 };

export const PALETTE = {
  o: [63, 38, 49],
  W: [255, 255, 255], w: [192, 203, 220], m: [139, 155, 180],
  d: [82, 96, 124], k: [38, 43, 68],
  r: [118, 59, 54], b: [189, 108, 74], t: [225, 154, 101], p: [247, 194, 130],
  T: [234, 165, 108],
  g: [37, 149, 106], G: [67, 225, 179],
  y: [254, 174, 52], Y: [254, 231, 97],
  P: [246, 117, 122], R: [228, 59, 68],
};

/** Kinds that sit on something rather than stand on the ground. */
export const PERCHED = new Set(['toucan', 'parrot']);

export const DESIGNS = {
  // --- from round here ----------------------------------------------------

  // Tail up, white stripe from brow to tip. Drawn in the artist's black.
  skunk: [
    '................',
    '..WW............',
    '.WWWd...........',
    '.WWddd..........',
    '.dWWdd..........',
    '.ddWWdd.........',
    '..ddWWdd........',
    '...ddWWddddd....',
    '....ddddWWWWWdd.',
    '.....dddddddWWd.',
    '.....ddddddddod.',
    '.....ddddddddddd',
    '.....ddddddddd..',
    '.....dd..dd.dd..',
    '................',
    '................',
  ],
  // Quills swept back along the body, tips standing up off the back.
  porcupine: [
    '................',
    '................',
    '..p..p..p..p....',
    '..rprrprrprrp...',
    '..rrprrprrprrr..',
    '.rrrrprrprrptt..',
    '.rrrrrprrprtttt.',
    '.rrrrrrprrpttott',
    '.rrrrrrrprrttttk',
    '.rrrrrrrrprrttt.',
    '..rrrrrrrrrrtt..',
    '..bb..bb..bb.bb.',
    '................',
    '................',
    '................',
    '................',
  ],
  // Half the porcupine's size, pale face, nose to the ground.
  hedgehog: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '......rbrbrb....',
    '.....rbrbrbrbr..',
    '....brbrbrbrbrp.',
    '...rbrbrbrbrbppp',
    '...brbrbrbrbppop',
    '...rbrbrbrbrpppk',
    '...brbrbrbrbrpp.',
    '....pp..pp..pp..',
    '................',
    '................',
    '................',
  ],
  // Flat tail, two teeth. Lives on the pond.
  beaver: [
    '................',
    '................',
    '................',
    '................',
    '.........bbbb...',
    '........bbbbbb..',
    '.......bbbbobb..',
    '.......bbbbbbbb.',
    '......bbbbbbbbb.',
    '......bbbbbbbWW.',
    '......bbbbbbbbb.',
    '.rkrkbbbbbbbbb..',
    'krkrkrbbbbbbb...',
    '.rkrkrbbbbbb....',
    '..rkr.bb..bb....',
    '................',
  ],
  // Long and low, nose up, lying along the bank.
  otter: [
    '................',
    '................',
    '................',
    '...........rrr..',
    '..........rrrrr.',
    '..........rorpp.',
    '..........rrppk.',
    '.........rrrppp.',
    '........rrrrbr..',
    '.......rrrrbb...',
    '.....rrrrrbbr...',
    '...rrrrrrbbrr...',
    '..rrrrrrrbrr....',
    '.rrrrrrrrr......',
    '..rrrr..........',
    '................',
  ],
  // Grey coat, white pointed face, pink nose, and a bare tail trailing.
  opossum: [
    '................',
    '................',
    '................',
    '................',
    '.........dwWW...',
    '.......mmmWWWW..',
    '......mmmmWoWWW.',
    '.....mmmmmmWWWP.',
    '....mmmmmmmWWW..',
    '...mmmmmmmmmm...',
    '..mmmmmmmmmmm...',
    '.p.mmmmmmmmmm...',
    '.p.mmmmmmmmm....',
    '..pp.mm..mm.....',
    '................',
    '................',
  ],
  // The wolf, in a coyote's tan.
  coyote: [
    '................',
    '....oooo..oooo..',
    '...oooooooooooo.',
    '...ooppooooppoo.',
    '...oopbttttbpoo.',
    '...ootppttpptoo.',
    '..ooobotbbtobooo',
    '..ootpopttpoptoo',
    '.oooppppttppppoo',
    'oooobbbpoopbbboo',
    'oopoobtboobtbooo',
    'oopobttpbbptooo.',
    'ootttttpppptooo.',
    'oottppttppttoo..',
    'oottobttoottoo..',
    'ooooooppooppoo..',
  ],
  // The tiger without its stripes: one coat, tawny all over.
  cougar: [
    '................',
    '......ooo..ooo..',
    '.....oooooooooo.',
    '.....ootooootoo.',
    '....ooottptpoooo',
    '....oobtktbtkboo',
    '....oottkttttkoo',
    '..oooobttdddttoo',
    '.ooooobbppdppooo',
    'ooobtttttpppboo.',
    'oobbttttttbbpoo.',
    'oobtttttttttpoo.',
    'oobbtppptttpboo.',
    'oottttrootttboo.',
    'oottroooorttbooo',
    'oottttdoootttdoo',
  ],
  // Neck up, beak out, and a grey wing folded along the back.
  goose: [
    '................',
    '................',
    '...........WW...',
    '..........WWWW..',
    '..........WoWWyy',
    '..........WWWW..',
    '..........WWW...',
    '..........WW....',
    '.....WWWWWWW....',
    '...WWWWWWWWW....',
    '..WWWwwwwWWW....',
    '.WWWWwwwwWWW....',
    '..WWWWWWWWW.....',
    '...WWWWWWW......',
    '....yy..yy......',
    '................',
  ],
  // The frog in brown, with warts. Lives on the pond too.
  toad: [
    '................',
    '................',
    '................',
    '..........oooo..',
    '.....oooooooooo.',
    '...oooooooobbooo',
    '..oooobbbrbobboo',
    '.ooobbrbbbbbbboo',
    '.oobbbbbrbbbTToo',
    '.oobbbbbbbbToooo',
    '.oorrbbTTbToooo.',
    '.oobbbbrbroooo..',
    '.oobrbbobrroo...',
    '.oobbroobbroo...',
    '................',
    '................',
  ],

  // The squirrel's little cousin: the same sit, a thinner tail, and the
  // dark-light-dark stripe down its back.
  chipmunk: [
    '................',
    '................',
    '................',
    '....pp..........',
    '....bb..b..b....',
    '....bb..bbbb....',
    '....bbb.bobb....',
    '.....bb.bbbk....',
    '.....bbkbbpp....',
    '....bbkWkbpp....',
    '....bbkWkbbp....',
    '....bbkWkbbp....',
    '.....bbkbbpp....',
    '......bb..bb....',
    '................',
    '................',
  ],
  // A garter snake, coiled, head up, tongue out.
  snake: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '...........ggg..',
    '..........ggogg.',
    '..........gggggR',
    '...........ggg..',
    '.....ggg...gg...',
    '....ggYgg..gg...',
    '...ggYggYggggg..',
    '...gYggggYgggg..',
    '..ggggggggggg...',
    '..gggggggggg....',
    '................',
  ],

  // --- from far away ------------------------------------------------------

  // The grizzly's pose, in black and white.
  panda: [
    '....oooo..oooo..',
    '...oooooooooooo.',
    '...ooddooooddoo.',
    '...ooddWWWWddooo',
    '..oooWWWWWWWWWoo',
    '..ooWWdoWWodWWoo',
    '.oooWWddWWWddWoo',
    'oooWWWWWWkkWWWoo',
    'ooWWWWWWWkkWWWoo',
    'oodddddddddddooo',
    'ooddddWWWWWWdooo',
    'ooddddWWWWWWdoo.',
    'ooddddWWWWWWdoo.',
    'ooddddWWWWWWdoo.',
    'ooodddWWWWWddoo.',
    '.ooddooWWWWddoo.',
  ],
  // Upright on its tail, paws tucked, pouch pale.
  kangaroo: [
    '................',
    '........tt.tt...',
    '........ttttt...',
    '.......ttttott..',
    '.......tttttttk.',
    '........tttt....',
    '........ttt.....',
    '.......ttttt....',
    '......ttpppt.t..',
    '.....tttppptt...',
    '....ttttpppt....',
    '...tttttppptt...',
    '..tttttttttt....',
    '.ttt.tttttttt...',
    '.tt..tttttttt...',
    'ttt...ttttttttt.',
  ],
  // Round ears, big black nose, sat facing you.
  koala: [
    '................',
    '................',
    '................',
    '..mmm......mmm..',
    '.mwwmmmmmmmmwwm.',
    '.mwwmmmmmmmmwwm.',
    '.mmmmmomkkmommm.',
    '..mmmmmmkkmmmm..',
    '...mmmmmkkmmm...',
    '...mmmwwwwwwm...',
    '..mmmwwwwwwwmm..',
    '..mmmwwwwwwwmm..',
    '..mmmwwwwwwwmm..',
    '..mmmmwwwwwmmm..',
    '..mm.mmmmmm.mm..',
    '................',
  ],
  // Black back, white front, orange beak and feet. Lives on the pond.
  penguin: [
    '................',
    '................',
    '.....dddddd.....',
    '....dddddddd....',
    '...dddWodWoddd..',
    '...dddWWWWWddd..',
    '...ddddWyyWddd..',
    '...dddWWWWWWdd..',
    '..dddWWWWWWWddd.',
    '.dddddWWWWWWWdd.',
    '.ddddWWWWWWWWdd.',
    '..ddddWWWWWWdd..',
    '...dddWWWWWWdd..',
    '...dddWWWWWddd..',
    '....dddddddd....',
    '....yyy..yyy....',
  ],
  // Pink, on one leg, beak down. Lives on the pond.
  flamingo: [
    '................',
    '..........PPP...',
    '.........PPPPP..',
    '.........PoPPPP.',
    '.........PPPPkk.',
    '.........PP...k.',
    '.........PP.....',
    '.........PP.....',
    '....PPPPPPP.....',
    '..PPPPPPPPP.....',
    '.PPPPRRPPPP.....',
    '.PPPPPPPPP......',
    '..PPPPPPP.......',
    '......P.........',
    '......P.........',
    '.....PPP........',
  ],
  // Up on its hind legs keeping watch, dark round the eyes.
  meerkat: [
    '................',
    '................',
    '......tttt......',
    '.....ttttttt....',
    '.....tdotodt....',
    '.....tttkttt....',
    '......tttttt....',
    '.......tttt.....',
    '......tttttt....',
    '......tppppt....',
    '......tppppt....',
    '......tppppt....',
    '......tppppt....',
    '...t..tppppt....',
    '...t..tttttt....',
    '....tttt..tt....',
  ],
  // Pale face, dark eye mask, long arms, claws. In no hurry.
  sloth: [
    '................',
    '................',
    '.....bbbbbb.....',
    '....bppppppb....',
    '...bpdoppodpb...',
    '...bppppkppppb..',
    '....bppppppb....',
    '.....bbbbbb.....',
    '....bbbbbbbb....',
    '...bbbbbbbbbb...',
    '..bbbbbbbbbbbb..',
    '..bbbbbbbbbbbb..',
    '..bbb.bbbb.bbb..',
    '..bbb.bbbb.bbb..',
    '..bkk.bbbb.kkb..',
    '................',
  ],
  // The tiger again, spotted instead of striped.
  leopard: [
    '................',
    '......ooo..ooo..',
    '.....oooooooooo.',
    '.....ooyooooyoo.',
    '....oooyWyyyWooo',
    '....oobykyyykboo',
    '....ooyykyyykyoo',
    '..oooobyydddyyoo',
    '.ooooobbWWdWWooo',
    'ooobyybkyWWWboo.',
    'oobykyybybbbWoo.',
    'oobyyykyyykyWoo.',
    'oobbyWWWyykWboo.',
    'ooykyrooyyybboo.',
    'ooyyroooryybbooo',
    'ooyyydoooyyydboo',
  ],
  // The raccoon in rust, white-faced, with a ringed tail.
  redpanda: [
    '................',
    '................',
    '......ooo..ooo..',
    '.....oooooooooo.',
    '.....oobooooboo.',
    '.....oobWbbWboo.',
    '..ooooobbbbbboo.',
    '.ooooooWbobobWoo',
    'oooboorWWkWWrboo',
    'oorroobbWWWbbooo',
    'oobboobbbbbbooo.',
    'oorrobbbbbbboo..',
    'oobbbbbbbbbboo..',
    'ooorbbrrrrrroo..',
    '.ooorrorrorroo..',
    '................',
  ],
  // Mostly beak. Perched, so it keeps its line underneath.
  toucan: [
    '................',
    '................',
    '.....ddddd......',
    '....ddddddd.....',
    '...dddWWWWW.....',
    '...ddWWoWWyyyyy.',
    '...ddWWWWyyyyyyR',
    '...dddWWWyyyyyR.',
    '...ddddWWWyyyy..',
    '..dddddWWWW.....',
    '..ddddddWWW.....',
    '..dddddddd......',
    '...dddddd.......',
    '..d..ddd........',
    '.d...yy.yy......',
    '................',
  ],
  // A macaw: red, a yellow and green wing, a long tail. Perched too.
  parrot: [
    '................',
    '......RRRR......',
    '.....RRRRRR.....',
    '.....RRWoWww....',
    '.....RRRWWwk....',
    '......RRRRR.....',
    '.....RRRRRRR....',
    '....RRRRRRRR....',
    '....RRRRYYRR....',
    '....RRRYYggR....',
    '....RRRYgggR....',
    '....RRRRgggg....',
    '.....RRRRggg....',
    '....R.RRR.gg....',
    '...RR.yy.yy.....',
    '...R............',
  ],
  // A boxy head on a barrel. Lives on the pond.
  capybara: [
    '................',
    '................',
    '.....tttt.......',
    '....tttttttb.b..',
    '...tttttttbbbbb.',
    '..ttttttttbbobb.',
    '..ttttttttbbbbk.',
    '.tttttttttbbbbb.',
    '.ttttttttttbbb..',
    '.ttttttttttt....',
    '.ttttttttttt....',
    '..tttttttttt....',
    '..bb.bb.bb.bb...',
    '................',
    '................',
    '................',
  ],
};

/** One 16x16 sprite, outline included, from a grid of insides. */
export function build(rows, { perched = false } = {}) {
  if (rows.length !== T || rows.some((r) => r.length !== T)) {
    throw new Error(`a design is ${T}x${T}: got ${rows.map((r) => r.length).join(',')}`);
  }
  const grid = rows.map((r) => [...r]);
  for (const row of grid) {
    for (const c of row) {
      if (c !== '.' && !PALETTE[c]) throw new Error(`no colour for "${c}"`);
    }
  }
  const inside = (x, y) => y >= 0 && y < T && x >= 0 && x < T
    && grid[y][x] !== '.' && grid[y][x] !== 'o';
  let floor = -1;
  for (let y = 0; y < T; y++) if (grid[y].some((c) => c !== '.' && c !== 'o')) floor = y;

  const rgba = Buffer.alloc(T * T * 4);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      let c = grid[y][x];
      if (c === '.' || c === 'o') {
        if (!isOutline(inside, x, y)) continue;
        if (y > floor && !perched) continue;
        c = 'o';
      }
      const [r, g, b] = PALETTE[c];
      const i = (y * T + x) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/**
 * One sheet with every generated kind written into its row, below the
 * hand-drawn ones.
 * @param {'wildlife'|'exotic'} sheet
 * @param {{width: number, height: number, rgba: Uint8Array}} src  the sheet as it is
 */
export function drawSheet(sheet, src) {
  const hand = HAND_DRAWN[sheet];
  if (src.width !== T) throw new Error(`${sheet}.png should be one column of ${T}px`);
  if (src.height < hand * T) throw new Error(`${sheet}.png has fewer than its ${hand} hand-drawn rows`);
  const kinds = Object.entries(WILD_KINDS).filter(([, k]) => k.sheet === sheet);
  const height = (Math.max(...kinds.map(([, k]) => k.row)) + 1) * T;
  const rgba = Buffer.alloc(T * height * 4);
  Buffer.from(src.rgba).copy(rgba, 0, 0, hand * T * T * 4);
  for (const [id, k] of kinds) {
    if (k.row < hand) continue;
    const rows = DESIGNS[id];
    if (!rows) throw new Error(`${id} lives on row ${k.row} of ${sheet}.png but nothing draws it`);
    build(rows, { perched: PERCHED.has(id) }).copy(rgba, k.row * T * T * 4);
  }
  for (const id of Object.keys(DESIGNS)) {
    const k = WILD_KINDS[id];
    if (!k) throw new Error(`${id} is drawn but is not a wild kind`);
    if (k.sheet === sheet && k.row < hand) throw new Error(`${id} is drawn here but sits on a hand-drawn row`);
  }
  return { width: T, height, rgba };
}

// --- run it --------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [sheet, rel] of Object.entries(WILDLIFE_SHEETS)) {
    const path = fileURLToPath(new URL(`../${rel}`, import.meta.url));
    const src = decodePng(path);
    const out = drawSheet(sheet, src);
    writeFileSync(path, encodePng(out.width, out.height, out.rgba));
    const drawn = Object.keys(DESIGNS).filter((id) => WILD_KINDS[id].sheet === sheet);
    console.log(`${sheet}.png: ${src.height / T} -> ${out.height / T} kinds (drawn here: ${drawn.join(', ')})`);
  }
}
