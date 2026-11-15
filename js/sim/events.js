// What each seasonal event has turned up, for the journal's Events tab.
//
// The other journals each remember one kind of thing (mushrooms, fish, wild
// animals). This one is organised by *occasion* instead, because what an event
// hands out only makes sense next to the event: a unicorn is a birthday
// present, a grumpy jack-o'-lantern is October. Each event is a section, and
// each section is the set of things that occasion can give.
//
//   birthday   the mythical horses out of the balloons — see sim/balloons.js
//   halloween  the jack-o'-lantern faces popped, and the gourds grown from
//              their seed — see sim/lanterns.js
//   thanksgiving  the leaves picked up, and the turkeys met and won over —
//              see sim/thanksgiving.js. The turkeys are read straight off the
//              wildlife journal, which already records every wild thing met,
//              rather than counted a second time here.
//
// Recorded from farmer.js as the work lands, which keeps this file free of
// imports from the modules that do the work, so there is no cycle: this reads
// their constants, they never read this.
//
// A gourd counts as *grown* when it is harvested, not when its seed turns up —
// the collection is of gourds she has raised, which is what makes the
// "grew every gourd" award mean something.
//
// Hard rules, same as everything in sim/: no DOM, no Math.random(), no
// Date.now().

import { GOURDS, CROPS } from './crops.js';
import { MYTHICALS } from './balloons.js';
import { LANTERN_NAMES } from './lanterns.js';
import { LEAF_IDS, LEAF_KINDS } from './thanksgiving.js';
import { TURKEY_IDS, TURKEY_KINDS } from './wildkinds.js';

export function newEventRecord() {
  return {
    birthday: { mythicals: {} },
    halloween: { lanterns: {}, gourds: {} },
    thanksgiving: { leaves: {} },
    // Whether the one-off birthday backfill has run; see backfillBirthday. A
    // brand-new farm has nothing to backfill, so it starts done; a save from
    // before this record existed is loaded with it unset (see state.js).
    birthdayChecked: true,
  };
}

function record(state) {
  const fresh = newEventRecord();
  const rec = state.events || (state.events = fresh);
  rec.birthday = { ...fresh.birthday, ...rec.birthday };
  rec.halloween = { ...fresh.halloween, ...rec.halloween };
  rec.thanksgiving = { ...fresh.thanksgiving, ...rec.thanksgiving };
  return rec;
}

const add = (map, key, n = 1) => { map[key] = (map[key] || 0) + n; };

/** A mythical horse stepped out of a balloon. */
export function recordMythical(state, type) {
  add(record(state).birthday.mythicals, type);
}

/** A jack-o'-lantern was popped; `face` is its column on the sheet. */
export function recordLantern(state, face) {
  const name = LANTERN_NAMES[face];
  if (name) add(record(state).halloween.lanterns, name);
}

/** A gourd was harvested. Anything that isn't a gourd is ignored. */
export function recordHarvest(state, type, n = 1) {
  if (!CROPS[type]?.gourd || n <= 0) return;
  add(record(state).halloween.gourds, type, n);
}

/**
 * A leaf was picked up. Anything that isn't off one of the trees is ignored.
 * @returns {number} how many of that tree's she has now
 */
export function recordLeaf(state, kind) {
  if (!LEAF_KINDS[kind]) return 0;
  const leaves = record(state).thanksgiving.leaves;
  add(leaves, kind);
  return leaves[kind];
}

/**
 * Fills in the birthday section once, for farms that had their birthday week
 * before this journal existed.
 *
 * Read off the animals standing on the farm, since a mythical can never be sold
 * — every one she was given is still there. The balloons' own list of what was
 * handed out is consulted as well, and the larger of the two wins: neither can
 * over-count, so the larger is the truer.
 *
 * Runs exactly once per farm, flagged, so a mythical arriving later is counted
 * by recordMythical and never twice.
 *
 * @returns {boolean} whether it ran
 */
export function backfillBirthday(state) {
  const rec = record(state);
  if (rec.birthdayChecked) return false;
  rec.birthdayChecked = true;

  const given = state.party?.given || [];
  for (const type of MYTHICALS) {
    const standing = (state.animals || []).filter((a) => a.type === type).length;
    const handed = given.filter((t) => t === type).length;
    const n = Math.max(standing, handed);
    if (n > (rec.birthday.mythicals[type] || 0)) rec.birthday.mythicals[type] = n;
  }
  return true;
}

// --- reading it back -------------------------------------------------------

export function mythicalCount(state, type) { return record(state).birthday.mythicals[type] || 0; }
export function lanternCount(state, name) { return record(state).halloween.lanterns[name] || 0; }
export function gourdCount(state, type) { return record(state).halloween.gourds[type] || 0; }

export function leafCount(state, kind) { return record(state).thanksgiving.leaves[kind] || 0; }

/** Every leaf ever picked up, of any tree. */
export function leavesCollected(state) {
  return LEAF_IDS.reduce((n, id) => n + leafCount(state, id), 0);
}

/** How many of this breed of turkey have been met, and how many won over. */
export function turkeyRecord(state, id) {
  const entry = (state.wildJournal || {})[id] || {};
  return { met: entry.met || 0, befriended: entry.befriended || 0 };
}

/** True once a leaf off every tree has been picked up — `each` of every one. */
export function foundEveryLeaf(state, each = 1) {
  return LEAF_IDS.every((id) => leafCount(state, id) >= each);
}

/** True once a turkey of every breed has been won over. */
export function befriendedEveryTurkey(state) {
  return TURKEY_IDS.every((id) => turkeyRecord(state, id).befriended > 0);
}

/** True once every mythical horse has stepped out of a balloon at least once. */
export function foundEveryMythical(state) {
  return MYTHICALS.every((type) => mythicalCount(state, type) > 0);
}

/** True once every jack-o'-lantern face has been popped at least once. */
export function foundEveryFace(state) {
  return LANTERN_NAMES.every((name) => lanternCount(state, name) > 0);
}

/** True once every gourd has been grown at least once. */
export function grewEveryGourd(state) {
  return GOURDS.every((g) => gourdCount(state, g) > 0);
}

/**
 * The Events tab's contents, one entry per event in calendar order, each with
 * its shelves of things to find.
 */
export function eventRows(state) {
  return [
    {
      id: 'birthday',
      name: 'Birthday',
      icon: '🎈',
      shelves: [{
        id: 'mythicals',
        name: 'Mythical horses',
        items: MYTHICALS.map((type, col) => ({ id: type, col, count: mythicalCount(state, type) })),
      }],
    },
    {
      id: 'halloween',
      name: 'Halloween',
      icon: '🎃',
      shelves: [
        {
          id: 'lanterns',
          name: "Jack-o'-lanterns",
          items: LANTERN_NAMES.map((name, col) => ({ id: name, col, count: lanternCount(state, name) })),
        },
        {
          id: 'gourds',
          name: 'Gourds grown',
          items: GOURDS.map((type, row) => ({
            id: type, row, name: CROPS[type].name, count: gourdCount(state, type),
          })),
        },
      ],
    },
    {
      id: 'thanksgiving',
      name: 'Thanksgiving',
      icon: '🦃',
      shelves: [
        {
          id: 'leaves',
          name: 'Leaves collected',
          items: LEAF_IDS.map((id, col) => ({
            id, col, name: LEAF_KINDS[id].name, count: leafCount(state, id),
          })),
        },
        {
          // A breed shows once it has been met, like anything in the wildlife
          // journal; the heart is how many of them are friends.
          id: 'turkeys',
          name: 'Turkeys',
          items: TURKEY_IDS.map((id) => {
            const { met, befriended } = turkeyRecord(state, id);
            return { id, row: TURKEY_KINDS[id].row, name: TURKEY_KINDS[id].name, count: met, befriended };
          }),
        },
      ],
    },
  ];
}
