// desktop-ui.js — the Bureau: the home screen the app always lands on.
// Every mode-identity you've created, across every namespace, shows up
// here as one tile — tap it to open its workspace, the same way you'd tap
// an app icon. Creating a new identity now starts here too: tap "+", pick
// which mode it's for (a real picker, not the old cramped mode-switcher
// dropdown), *then* name it — mode comes before the name, not before the
// decision to create anything at all.
//
// Reaches identity-ui.js directly (safe, one-directional: identity-ui.js
// has no dependency back on this file).

import { state, NAMESPACES, NS_CONFIG, setActiveNamespace } from './state.js';
import { createIdentityFlow } from './identity-ui.js';
import { openModal } from './ui-kit.js';
import { countPendingNotifications } from './messages-ui.js';
import * as credibility from './credibility.js';
import { openBackgroundPicker } from './background-ui.js';

// Namespaces an identity actually gets created in. Near has no identity of
// its own (see near-ui.js), Agent cross-references your *other* identities
// instead of needing one of its own (see agent-ui.js), Messages likewise
// just reads what your other identities already have (see messages-ui.js),
// "external" namespaces are just launchers, and "info" namespaces are a
// static page about Jobber itself — none of these belong in "which mode
// is this identity for".
const NO_IDENTITY_KINDS = ['near', 'agent', 'messages', 'external', 'info'];
const CREATABLE = NAMESPACES.filter((ns) => !NO_IDENTITY_KINDS.includes(NS_CONFIG[ns].kind));

export function goToDesktop() {
  state.view = 'desktop';
  state.render.all();
}

// One click on the brand mark always takes you home — the standard
// "click the logo" affordance, and the only way back once you've tapped
// into a workspace (there's no separate back button in the topbar).
document.querySelector('.brand-mini')?.addEventListener('click', goToDesktop);

// Left/Right arrows pan the Bureau horizontally — the one way to reach
// whatever runs past the viewport edge with no mouse: the rotated hive
// on a wide screen can end up wider than the window as more identities
// pad it out (rotation swaps its width for its — unbounded — height),
// and a narrow window can still outgrow the unrotated tiling below that
// breakpoint too. Registered once at module load, not inside
// bindDesktopEvents (called on every re-render) — document itself is
// never replaced, so re-registering there would stack a fresh listener,
// and every existing one, on every single render.
const PAN_STEP_PX = 160;
document.addEventListener('keydown', (e) => {
  if (state.view !== 'desktop') return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  // A form control elsewhere on the Bureau or in an open modal (the mode
  // picker's search, a rename field, ...) owns its own arrow-key meaning
  // — don't steal it.
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const workspace = document.getElementById('workspace');
  if (!workspace) return;
  workspace.scrollBy({ left: e.key === 'ArrowLeft' ? -PAN_STEP_PX : PAN_STEP_PX, behavior: 'smooth' });
  e.preventDefault();
});


// Still being built out — flagged on the Bureau so it's clear these
// aren't finished features yet. Pricing counts too: only one of its five
// tiers is real (see pricing-ui.js) — the rest of that page is "Soon".
// AIWA/YourMine got real address-matching (see NS_CONFIG.wallet/creator
// and editAddressProfileFlow), but the badge stays: matching against
// AIWA_chain/YourMine's actual on-chain/published addresses is still
// untested against those real apps, not just against Jobber's own
// simulated local-test matches. Research (Intelligence) has no tool
// wheel tile of its own (not in TOOL_ORDER) but is still creatable, so
// it only ever shows this badge on the mode picker and its own identity
// tiles (see COOKING's other two call sites below) -- appearing here
// doesn't put it on a wheel tile that doesn't exist.
const COOKING = ['agent', 'pricing', 'wallet', 'creator', 'research'];

// AIWA/YourMine's own TOP tool-wheel tile (wheelToolTile, below) is
// just an external link launcher — bindDesktopEvents opens cfg.url
// directly for it, nothing of Jobber's own runs there, and both sites
// are real, live products. "Cooking" there was mislabeling the
// external site itself as unfinished. What genuinely is still
// untested is JOBBER'S OWN address-matching against those chains
// (see the comment above COOKING) — which lives on the identity tiles
// and the mode picker (pentIdTile/pentPickerTile), where the badge
// correctly stays.
const TOOL_COOKING = COOKING.filter((ns) => ns !== 'wallet' && ns !== 'creator');

// --- Cairo pentagon tiling geometry -------------------------------------
// A regular hexagon tiles the plane on its own; a regular pentagon
// cannot (108°×3=324°, never closes to 360°). The Cairo pentagonal
// tiling is what real edge-to-edge, gap-free pentagon tiling actually
// looks like: an irregular (but fully determined) pentagon with angles
// 120°,120°,90°,120°,90° going around — the two right angles are
// non-adjacent — one short edge and four long edges (ratio √3-1 : 1).
//
// Two rules fully generate it (verified against this exact shape by
// brute-force edge-matching over a 300+ pentagon patch — every edge
// either matched exactly one neighbor or sat on the patch boundary,
// zero mismatches, zero overlapping centroids — before any of this went
// near CSS):
//  1) Four copies of the pentagon, rotated 0/90/180/270° about EITHER of
//     its two 90° corners, tile perfectly around that point.
//  2) The neighbor across the one short edge is the pentagon rotated
//     180° about that edge's midpoint.
// Together these cover all 5 edges (the 90°-corner rule covers the 4
// edges touching V3/V5; the short-edge rule covers the 5th).
const SQRT3 = Math.sqrt(3);
// px — length of one long edge; the one tunable size knob. Sized so the
// widest row (the band, ±ALL_BAND below) stays inside a normal portrait
// phone width with no horizontal scrolling — see HIVE_WIDTH below, which
// this directly determines.
const PENT_EDGE = 70;
const PENT_W = PENT_EDGE * SQRT3; // ≈121.2px
const PENT_H = PENT_EDGE * (SQRT3 + 1) / 2; // ≈95.6px
// V1..V5, centered on the pentagon's own bounding-box center — which is
// also where CSS rotate() pivots by default (transform-origin:50% 50%),
// so a plain `rotate(Ndeg)` reproduces exactly the rotations the tiling
// rule above is defined in terms of. Given in units of PENT_EDGE.
const PENT_LOCAL = [
  [-0.3660254, -0.6830127], // V1 — 120°, short-edge corner
  [0.3660254, -0.6830127],  // V2 — 120°, short-edge corner
  [0.8660254, 0.1830127],   // V3 — 90°
  [0, 0.6830127],           // V4 — 120°, apex
  [-0.8660254, 0.1830127],  // V5 — 90°
];
// clip-path polygon for orientation 0 — same 5 points as PENT_LOCAL,
// converted to percentages of the PENT_W×PENT_H box (every rotated
// orientation reuses this exact clip-path; only a CSS rotate() differs
// — see .bento-pent.rot-* in style.css).
const PENT_CLIP_PATH = 'polygon(28.8675% 0%, 71.1325% 0%, 100% 63.3975%, 50% 100%, 0% 63.3975%)';

function pentRotateVec([x, y], deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}
function pentWorldVerts(p) {
  return PENT_LOCAL.map((v) => {
    const [rx, ry] = pentRotateVec(v, p.rot);
    return [p.cx + rx, p.cy + ry];
  });
}
// Rotates the whole pentagon `p` by `delta` degrees about world point `pivot`.
function pentRotateAbout(p, pivot, delta) {
  const [rx, ry] = pentRotateVec([p.cx - pivot[0], p.cy - pivot[1]], delta);
  return { cx: pivot[0] + rx, cy: pivot[1] + ry, rot: (((p.rot + delta) % 360) + 360) % 360 };
}
// A pentagon has 5 edges, so it has exactly 5 real edge-sharing
// neighbors — not 7. Rotating by ±90° about a 90° corner (V3 or V5)
// gives the two neighbors that share THAT corner's two edges; rotating
// by 180° about the same corner only shares the single point V3/V5
// itself (a diagonal touch, not an edge) and must NOT be treated as a
// neighbor — including it doesn't corrupt the generated patch (BFS
// still reaches every real position some other way) but was silently
// misleading, and tracking down why turned out to matter: see the
// pentSlotPx/PENT_PATCH note below about the render-orientation bug
// that cost real debugging time before this was caught.
function pentNeighbors(p) {
  const wv = pentWorldVerts(p);
  const out = [];
  for (const idx of [2, 4]) { // V3, V5 — the two 90° corners
    for (const delta of [90, 270]) out.push(pentRotateAbout(p, wv[idx], delta));
  }
  const shortEdgeMid = [(wv[0][0] + wv[1][0]) / 2, (wv[0][1] + wv[1][1]) / 2]; // midpoint of V1-V2
  out.push(pentRotateAbout(p, shortEdgeMid, 180));
  return out;
}
function pentKey(p) {
  const r = (v) => Math.round(v * 1000) / 1000;
  return `${r(p.cx)},${r(p.cy)},${(((p.rot % 360) + 360) % 360)}`;
}
// BFS out from one seed pentagon far enough to cover the tools + a long
// identity strip below them. Pure math, cheap (a few hundred pentagons at
// most) — computed once and reused for the life of the module rather
// than redone on every render.
function generatePentagonPatch(rounds) {
  const start = { cx: 0, cy: 0, rot: 0 };
  const seen = new Map([[pentKey(start), start]]);
  let frontier = [start];
  for (let i = 0; i < rounds; i++) {
    const next = [];
    for (const p of frontier) {
      for (const nb of pentNeighbors(p)) {
        const k = pentKey(nb);
        if (!seen.has(k)) { seen.set(k, nb); next.push(nb); }
      }
    }
    frontier = next;
  }
  return [...seen.values()];
}
// generatePentagonPatch's own math (pentRotateVec etc.) uses standard
// math convention: +y is UP, and a positive angle turns counter-
// clockwise. CSS is the opposite on both counts (+y is DOWN, positive
// rotate() turns clockwise). Flipping only the y-coordinate to go from
// one to the other is a MIRROR REFLECTION, not a rotation — reflections
// reverse handedness, so a pentagon's neighbors (verified edge-to-edge
// in the math convention) stop actually lining up once each one's own
// rotation is fed unchanged into CSS. A full 180° rotation instead
// (negate BOTH x and y, and add 180° to every rot) reverses which
// direction reads as "down the screen" the same way a Y-flip does, but
// — being a genuine rigid rotation, not a reflection — it preserves
// every edge adjacency the generator already verified. (This was the
// actual bug behind an earlier version of this file rendering visible
// gaps throughout the identity strip: every pair of tiles individually
// satisfied the edge-matching check done on the *un-rendered* math, but
// the on-screen rotations didn't match what that check assumed — caught
// by rendering two supposedly-adjacent pentagons in isolation and
// finding they didn't actually touch.)
// 13 rounds only ever produced enough ALL_SLOTS (below, after the band
// filter) for about 20 identities past the 7 tools before slotPxAt ran
// off the end of the array and crashed the whole Bureau outright — a
// real, easily-reachable count (several namespaces' worth of active
// identities, not an extreme edge case). Bumped well past that; the
// growth itself needed no other change; pentNeighbors' adjacency rule is
// the same regardless of how far from the origin it's applied, so more
// rounds is just more of the same already-verified tiling, not new
// geometry to re-check.
const PENT_PATCH = generatePentagonPatch(28).map((p) => ({
  cx: -p.cx, cy: -p.cy, rot: (p.rot + 180) % 360,
}));

// The 7 tools used to be their own hand-picked "flower" (2 or 3 rows,
// separately verified) sitting above a separately-selected identity
// strip. That was the actual source of the visible gaps reported against
// this file, twice: a small cluster picked only by checking "no edge is
// claimed by more than 2 tiles" (no overlaps) can still have real notches
// open to the outside — that check can't tell a genuine hole from the
// cluster's own natural (and expected) outer boundary, and a 7-tile
// island rendered against bare background makes every one of those
// notches visible. Confirmed with an actual pixel-level flood-fill (fill
// every tile, then flood-fill background from the canvas border — any
// background pixel NOT reached is a real hole): the old hand-picked
// cluster had 0 *enclosed* holes but plenty of open notches, which is
// exactly what read as gaps.
// The fix: tools aren't a separate shape at all. ALL_SLOTS below is one
// continuous run of the real tiling — tools are just its first 7 tiles,
// identity slots are everything after — so there is no cluster boundary
// for a notch to open onto in the first place. Verified with the same
// flood-fill test at prefixes of 7/15/30/60 tiles (0 holes every time)
// and by eye against a real Cairo-tile photo.
// Halved from the original 3.6 — same tiling, same TOOL_COUNT split,
// just a narrower vertical band (roughly half as many tiles per row, so
// about half the container width) since the wider strip had more tiles
// across than wanted. Doesn't touch anything else: PENT_PATCH, the row
// grouping, the flood-fill-verified no-gap guarantee (a subset of the
// same continuous run is still gap-free, band width or not — only how
// far its own left/right edge can jag).
const ALL_BAND = 1.4;
const ALL_SLOTS = PENT_PATCH
  .filter((p) => Math.abs(p.cx) <= ALL_BAND && p.cy > -1)
  .sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
const TOOL_COUNT = 7;
// slotPxAt(TOOL_COUNT + i) reads ALL_SLOTS[TOOL_COUNT + i] directly — past
// its end that's undefined, and destructuring it crashes the whole
// Bureau. ALL_SLOTS is finite by construction (PENT_PATCH is a fixed
// flood-fill radius, not infinite), so however generous that radius is,
// there's always some identity count past which this would happen
// without a real ceiling here — renderDesktop clamps every cell-adding
// loop to this so it degrades (extra identities just don't get a tile)
// instead of crashing.
const MAX_IDENTITY_SLOTS = ALL_SLOTS.length - TOOL_COUNT;
const TOOL_ORDER = ['tribute', 'wallet', 'creator', 'pricing', 'messages', 'agent', 'near'];
// Tools split into two named groups (matching TOOL_ORDER's own order):
// Ecosystem is the first ECOSYSTEM_COUNT tools, Insights the rest up to
// TOOL_COUNT. Identity slots (index >= TOOL_COUNT) are "Matches".
const ECOSYSTEM_COUNT = 3;
// A light, deliberate gap at each of the two zone boundaries only — unlike
// the old per-cluster gaps that caused real bugs, this shifts each WHOLE
// zone by a uniform amount (never just some of a zone's tiles), so every
// zone stays internally gap-free (verified the same flood-fill way as the
// rest of this file) and only the two boundaries themselves open up, on
// purpose, with clean edges on both sides — just enough room for a label,
// not more.
// Sizing this off the WORST-CASE tile anywhere in the zone's *whole*
// width (a 90°/270°-rotated tile reaches PENT_W/2 from its own center,
// not PENT_H/2 — its footprint swaps width/height under that rotation,
// and PENT_W > PENT_H) is what an earlier version of this file did, and
// it's safe but wildly conservative: that worst-case tile can sit far off
// to the side of where the label actually renders (cx=0, a ~65-90px-wide
// strip — see LABEL_HALF_WIDTH below). A first attempt at fixing that
// checked the gap at cx=0 ONLY and found it exactly 0 at rest (proving
// the tiling touches edge-to-edge with zero gap and zero overlap right
// where the label sits) — true, but incomplete: a label isn't a single
// point, it's a flat rectangle, and the tiling's boundary right next to
// that point is a diagonal seam, not a flat one (a 90°/270°-rotated
// tile's inward-pointing vertex cuts back toward center as the seam
// continues) — so the two off-center tiles flanking the center tile
// reach further into the gap than the center tile alone does, right at
// the label's own left/right edges. Confirmed by rendering it: at 0.25
// units the label's own text visibly overlapped those flanking tiles'
// corners, not the center tile. zoneEdgeAcrossLabel below samples the
// real edge across the label's actual width instead of one point, so
// this constant is sized against what the label really touches.
const ECOSYSTEM_GAP_UNITS = 0.55;
const MATCHES_GAP_UNITS = 0.55;
function zoneShift(index) {
  if (index < ECOSYSTEM_COUNT) return -ECOSYSTEM_GAP_UNITS;
  if (index < TOOL_COUNT) return 0;
  return MATCHES_GAP_UNITS;
}

// Rows aren't a fixed size (the real Cairo tiling alternates 2/3/4 tiles
// wide on a repeat, not a uniform grid), so stopping the strip mid-row
// would leave one side of that row's own natural jagged edge missing its
// (harmless) counterpart on the other side, reading as a one-sided notch
// rather than the tiling's own symmetric boundary. Precomputed once, over
// the WHOLE list (tools included, since it's one continuous tiling with
// no seam) so renderDesktop can always round the strip's length up to the
// end of a whole row.
const ALL_ROW_ENDS = (() => {
  const ends = [];
  let i = 0;
  while (i < ALL_SLOTS.length) {
    let j = i + 1;
    while (j < ALL_SLOTS.length && Math.abs(ALL_SLOTS[j].cy - ALL_SLOTS[i].cy) < 1e-6) j++;
    ends.push(j);
    i = j;
  }
  return ends;
})();
function roundUpToRow(n) {
  for (const end of ALL_ROW_ENDS) if (end >= n) return end;
  return ALL_SLOTS.length;
}
function verticalHalfExtent(rot) {
  return (rot === 90 || rot === 270) ? PENT_W / 2 : PENT_H / 2;
}
// The real bottom/top edge of ALL_SLOTS[start..end), accounting for each
// tile's own rotation — not just its center's cy. This is the WORST CASE
// over the zone's whole width, which is what TOP_CLEARANCE below actually
// needs (no tile anywhere in the row may clip the container's top edge) —
// but see the note above ECOSYSTEM_GAP_UNITS for why it's the wrong tool
// for sizing a label's own gap, since the label only ever sits at cx=0.
function zoneBottomTop(start, end) {
  let bottom = -Infinity, top = Infinity;
  for (let i = start; i < end; i++) {
    const s = slotPxAt(i);
    const half = verticalHalfExtent(s.rot);
    bottom = Math.max(bottom, s.y + half);
    top = Math.min(top, s.y - half);
  }
  return { bottom, top };
}
// A pentagon's rendered vertices in the same px space as slotPxAt — the
// exact points CSS's own translate()+rotate() puts PENT_LOCAL's corners
// at, since PENT_LOCAL*PENT_EDGE is precisely the un-rotated box the
// clip-path is drawn from (see hole_detector.mjs, which draws these same
// vertices on a canvas and flood-fills it to verify no real gaps).
function pentWorldVertsPx(slotPx) {
  return PENT_LOCAL.map(([lx, ly]) => {
    const [rx, ry] = pentRotateVec([lx * PENT_EDGE, ly * PENT_EDGE], slotPx.rot);
    return [slotPx.x + rx, slotPx.y + ry];
  });
}
// Where a polygon's own boundary crosses the vertical line at `x`, if it
// does at all (a tile off to the side of x may not cross it — the Cairo
// tiling's own jag means that's normal, not a bug; see zoneEdgeNearCenter).
function yRangeAtX(verts, x) {
  const ys = [];
  for (let i = 0; i < verts.length; i++) {
    const [x1, y1] = verts[i];
    const [x2, y2] = verts[(i + 1) % verts.length];
    if ((x1 <= x && x <= x2) || (x2 <= x && x <= x1)) {
      ys.push(x1 === x2 ? y1 : y1 + ((x - x1) / (x2 - x1)) * (y2 - y1));
    }
  }
  return ys.length ? { top: Math.min(...ys), bottom: Math.max(...ys) } : null;
}
// Half the width a section label actually renders at (left:50%, so it's
// centered on cx=0) — ".bento-section-label"'s own 12.25px/600/uppercase/
// .06em-tracking text measures ~64-90px wide depending on the word; this
// covers the widest of them ("Ecosystem") with a few px to spare.
const LABEL_HALF_WIDTH = 35;
// The real bottom/top edge of ALL_SLOTS[start..end) across the label's
// actual width (cx in [-LABEL_HALF_WIDTH, LABEL_HALF_WIDTH]), not just its
// center point — see the comment above ECOSYSTEM_GAP_UNITS for why a
// single point misses the off-center tiles that actually crowd the
// label's edges. Worst case (max bottom / min top) over that strip, since
// the label itself is a flat rectangle that has to clear all of it at once.
function zoneEdgeAcrossLabel(start, end) {
  let bottom = -Infinity, top = Infinity;
  const SAMPLES = 14;
  for (let i = start; i < end; i++) {
    const verts = pentWorldVertsPx(slotPxAt(i));
    for (let k = 0; k <= SAMPLES; k++) {
      const x = -LABEL_HALF_WIDTH + (2 * LABEL_HALF_WIDTH * k) / SAMPLES;
      const r = yRangeAtX(verts, x);
      if (r) { bottom = Math.max(bottom, r.bottom); top = Math.min(top, r.top); }
    }
  }
  return { bottom, top };
}
// Same, but for a zone whose very first row might not itself reach the
// label's width (e.g. the identity strip's first row after the tools: a
// 2-wide row sitting entirely off to the sides, with the row *below* it
// filling in the middle — the tiling's own normal jag). Extends row by
// row, using the same row boundaries as roundUpToRow, until it finds real
// material under the label to measure against.
function zoneEdgeAcrossLabelFrom(start) {
  let end = roundUpToRow(start + 1);
  let edge = zoneEdgeAcrossLabel(start, end);
  while (edge.top === Infinity && end < ALL_SLOTS.length) {
    end = roundUpToRow(end + 1);
    edge = zoneEdgeAcrossLabel(start, end);
  }
  return edge;
}
// Container width: wide enough for the widest row actually placed in it,
// plus one full pentagon's width so a tile centered at the band's edge
// doesn't get half-clipped. On a narrow viewport this can exceed the
// screen — .bento-hive-scroll (style.css) turns that into a horizontal
// scroll shelf instead of clipping tiles outright.
const HIVE_WIDTH = Math.ceil(2 * ALL_BAND * PENT_EDGE + PENT_W);

function pentSlotPx({ cx, cy, rot }, extraY = 0) {
  // Direct mapping — PENT_PATCH's own (cx,cy,rot) are already in screen
  // convention (the 180°-rotation baked in above). extraY is a plain
  // additional offset in the same units, positive meaning further down
  // the screen — see zoneShift above.
  return { x: cx * PENT_EDGE, y: (cy + extraY) * PENT_EDGE, rot };
}
function slotPxAt(index) {
  return pentSlotPx(ALL_SLOTS[index], zoneShift(index));
}
// How far below the container's top edge the tiling's own y=0 line sits —
// sized so the highest thing drawn (ALL_SLOTS[0], the topmost row) clears
// the container, with LABEL_HEADROOM to spare for the "Ecosystem" label
// above it. Baked directly into pentTransform's translate() below.
const LABEL_HEADROOM = 16;
const TOP_CLEARANCE = Math.ceil(-zoneBottomTop(0, ECOSYSTEM_COUNT).top + LABEL_HEADROOM);

function pentTransform(slotPx) {
  return `transform:translate(-50%,-50%) translate(${slotPx.x}px,${slotPx.y + TOP_CLEARANCE}px) rotate(${slotPx.rot}deg);`;
}
// The tile's own rotate() (above) is what makes its clip-path trace the
// right edges for the tiling — but that same rotate() would also turn
// its icon/label/badge sideways or upside down, since they're painted
// inside that same rotated box. Wrapping them in a `.bento-pent-face`
// child and rotating THAT by the opposite amount cancels it back out:
// the two rotations compose to zero for the face's own content, while
// the outer element's box (and its clip-path, drawn from that box) is
// still visually rotated. Content stays upright regardless of which of
// the 4 tiling orientations a given tile lands in.
//
// Set as a --face-rot custom property rather than a `transform` directly,
// because style.css's own .bento-pent-face rule also adds --block-rot on
// top (0deg normally, -90deg past the wide-screen breakpoint where
// .bento-hive-rotate turns the whole hive 90° — see that file): a plain
// inline `transform` here would just overwrite that entirely, no way for
// a stylesheet rule to add to a specific inline transform value it
// doesn't know in advance. Custom properties compose in calc() instead.
function pentFaceStyle(rot) {
  return `--face-rot:${-rot}deg;`;
}

function wheelToolTile(ns, i, pendingCount) {
  const cfg = NS_CONFIG[ns];
  const badge = ns === 'messages' ? pendingCount : (TOOL_COOKING.includes(ns) ? 'cooking' : 0);
  const isLabel = typeof badge === 'string';
  const badgeText = isLabel ? badge : (badge > 9 ? '9+' : badge);
  const slotPx = slotPxAt(i);
  return `
    <button type="button" class="bento-pent" style="--tile-color:${cfg.color}; ${pentTransform(slotPx)}" data-act="tool" data-ns="${ns}">
      <span class="bento-pent-face" style="${pentFaceStyle(slotPx.rot)}">
        ${badge ? `<span class="bento-pent-badge ${isLabel ? 'label' : 'count'}">${badgeText}</span>` : ''}
        <span class="bento-pent-bg-icon">${cfg.icon}</span>
        <span class="bento-pent-label">${cfg.label}</span>
      </span>
    </button>`;
}

function pentIdTile(ns, id, isLive, index) {
  const cfg = NS_CONFIG[ns];
  const slotPx = slotPxAt(TOOL_COUNT + index);
  return `
    <button type="button" class="bento-pent bento-id-tile" style="--tile-color:${cfg.color}; ${pentTransform(slotPx)}" data-act="open" data-ns="${ns}" data-id="${id.identityId}">
      <span class="bento-pent-face" style="${pentFaceStyle(slotPx.rot)}">
        ${COOKING.includes(ns) ? '<span class="bento-pent-badge label">cooking</span>' : ''}
        ${isLive ? '<span class="bento-id-dot" title="Live"></span>' : ''}
        <span class="bento-pent-bg-icon">${cfg.icon}</span>
        <span class="bento-id-name">${id.displayName}</span>
        <span class="bento-id-sub">${cfg.label}</span>
      </span>
    </button>`;
}

function pentNewButton(index) {
  const slotPx = slotPxAt(TOOL_COUNT + index);
  return `
    <button type="button" class="bento-pent bento-id-empty bento-id-new" style="${pentTransform(slotPx)}" data-act="new" title="New identity">
      <span class="bento-pent-face" style="${pentFaceStyle(slotPx.rot)}">+</span>
    </button>`;
}

function pentFillerDiv(index) {
  return `<div class="bento-pent bento-id-empty" style="${pentTransform(slotPxAt(TOOL_COUNT + index))}"></div>`;
}

// The tile that follows your identity slots once there's still a palier
// worth reaching — see credibility.js. Shown as "score/palier" rather
// than just the raw score, since the number alone means nothing without
// the target it's climbing toward.
function pentScoreTile(score, palier, index) {
  const pct = Math.min(100, Math.round((score / palier) * 100));
  const slotPx = slotPxAt(TOOL_COUNT + index);
  return `
    <div class="bento-pent bento-id-score" style="${pentTransform(slotPx)}" title="Global credibility — every real chat, meeting, or file exchange counts. Reach ${palier} to unlock ${credibility.IDENTITY_PALIER_STEP} more identity slots.">
      <span class="bento-pent-face" style="${pentFaceStyle(slotPx.rot)}">
        <span class="bento-score-frac">${score}<span class="bento-score-slash">/${palier}</span></span>
        <span class="bento-score-label">Credibility</span>
        <span class="bento-score-bar"><span class="bento-score-fill" style="width:${pct}%"></span></span>
      </span>
    </div>`;
}

// The project's own vision statement, sitting below the identities —
// static, plain-flow content, deliberately outside .bento-hive so it
// doesn't inherit the levitation animation or the pentagon coordinate
// system (there's nothing to align it to; it's prose, not a tile).
const MANIFESTO_TITLE = 'An interplanetary operating architecture for digital human opportunities';
const MANIFESTO_LEAD = 'A world without accounts, where everyone owns their identity and connects directly with anyone, anywhere, for anything.';
const MANIFESTO_SUB = 'A world that doesn’t disappear when the network does.';
const manifestoHtml = `
  <div class="bureau-manifesto">
    <div class="bureau-manifesto-rule"></div>
    <p class="bureau-manifesto-title">${MANIFESTO_TITLE}</p>
    <p class="bureau-manifesto-lead">${MANIFESTO_LEAD}</p>
    <p class="bureau-manifesto-sub">${MANIFESTO_SUB}</p>
  </div>`;

export async function renderDesktop() {
  let index = 0;
  const cells = [];
  // Flattened first, then hard-capped at MAX_IDENTITY_SLOTS — real
  // identities are never hidden in ordinary use (see the comment below),
  // but a well past-normal count must still degrade to "the rest just
  // don't get a tile" rather than crash slotPxAt. Ordinary two-loop
  // iteration can't easily stop early across both loops at once; a flat
  // list can.
  const allIdentities = CREATABLE.flatMap((ns) =>
    (state.identitiesByNs[ns] || []).filter((i) => i.active).map((id) => ({ ns, id }))
  );
  for (const { ns, id } of allIdentities.slice(0, MAX_IDENTITY_SLOTS)) {
    // Every identity in a namespace can be live independently now — no
    // longer tied to whichever one happens to be the currently *viewed*
    // identity (state.activeIdentityId is a separate, UI-only concern).
    // Research's searchLive is a plain bool, not a Set (see state.js) —
    // guard against it the same way resolveLiveIdentity/near-ui.js do,
    // rather than calling .has() on a boolean.
    const live = state.searchLive[ns];
    const isLive = live instanceof Set && live.has(id.identityId);
    cells.push(pentIdTile(ns, id, isLive, index++));
  }
  const realCount = index;

  // Real identities never get hidden by the cap below — it only gates
  // *creating* more (see identity-ui.js's createIdentityFlow, the one
  // place that's actually enforced). Here it only decides how many more
  // "+" slots to offer: every one of them does the exact same thing
  // (pickModeThenCreateIdentity) — they're interchangeable, not tied to a
  // particular mode — so remaining capacity just becomes that many
  // identical "+" tiles instead of one.
  const { score } = await credibility.computeGlobalCredibility();
  const cap = credibility.identityCapFor(score);
  const palier = credibility.nextPalier(score);
  const plusSlots = Math.max(0, Math.min(cap - realCount, MAX_IDENTITY_SLOTS - index));
  for (let i = 0; i < plusSlots; i++) cells.push(pentNewButton(index++));
  if (palier != null && index < MAX_IDENTITY_SLOTS) cells.push(pentScoreTile(score, palier, index++));

  // Pad empty slots so the strip never looks like a half-finished band,
  // and reads as "room for more" rather than sparse when there are few or
  // no identities yet — a floor of 12, rounded up to the end of whichever
  // row of the WHOLE list (tools included, see ALL_ROW_ENDS) that floor
  // lands in, so the strip always stops at one of the tiling's own
  // natural row edges instead of an arbitrary cut partway through one.
  const targetSlots = Math.min(roundUpToRow(TOOL_COUNT + Math.max(12, index)) - TOOL_COUNT, MAX_IDENTITY_SLOTS);
  while (index < targetSlots) cells.push(pentFillerDiv(index++));

  // Absolutely-positioned children (every .bento-pent) don't contribute to
  // their container's height on their own, so it's computed explicitly
  // from the deepest identity slot actually used, plus the clearance
  // above y=0 (TOP_CLEARANCE) and this pentagon's own half-height below
  // it — see .bento-hive's box-sizing:content-box in style.css for why
  // this doesn't fight with its own padding-bottom (the modebar
  // clearance).
  let maxY = 0;
  for (let i = 0; i < index; i++) maxY = Math.max(maxY, slotPxAt(TOOL_COUNT + i).y);
  const hiveHeight = Math.ceil(TOP_CLEARANCE + maxY + PENT_H / 2);

  const pendingCount = countPendingNotifications();
  const tools = TOOL_ORDER.map((ns, i) => wheelToolTile(ns, i, pendingCount)).join('');
  // Labels sit inside .bento-hive, in the same raw (pre-TOP_CLEARANCE)
  // coordinate space as every pentagon above, via the same helper — so
  // they bob with the levitation animation exactly like the tiles do.
  // "Ecosystem" sits above the pushed-up first zone; "Insights" and
  // "Matches" each sit in the deliberate gap zoneShift opens at that
  // zone's boundary — the real gap between one zone's own bottom edge and
  // the next zone's own top edge, measured across the label's own width
  // (zoneEdgeAcrossLabel/zoneEdgeAcrossLabelFrom — see the comment above
  // ECOSYSTEM_GAP_UNITS for why a naive midpoint, a whole-row bounding
  // box, or even a single center point all get this wrong).
  const labelTransform = (y) => `transform:translate(-50%,-50%) translate(0px,${Math.round(y + TOP_CLEARANCE)}px);`;
  const ecoExtent = zoneEdgeAcrossLabel(0, ECOSYSTEM_COUNT);
  const insightsExtent = zoneEdgeAcrossLabel(ECOSYSTEM_COUNT, TOOL_COUNT);
  const matchesExtent = zoneEdgeAcrossLabelFrom(TOOL_COUNT);
  const ecosystemLabel = `<span class="bento-section-label" style="${labelTransform(ecoExtent.top - 10)}">Ecosystem</span>`;
  const insightsLabel = `<span class="bento-section-label" style="${labelTransform((ecoExtent.bottom + insightsExtent.top) / 2)}">Insights</span>`;
  const matchesLabel = `<span class="bento-section-label" style="${labelTransform((insightsExtent.bottom + matchesExtent.top) / 2)}">Matches</span>`;

  // .bento-hive-rotate exists purely to turn the whole tiling 90° as one
  // rigid block on wide screens (see its CSS) — width/height are handed
  // over as custom properties, not raw inline width/height, since they
  // only need to apply post-rotation (swapped) past that breakpoint;
  // below it the wrapper is just a transparent pass-through and these
  // never get read at all.
  return `
    <div class="bureau">
      <div class="bento-hive-rotate" style="--hive-w:${HIVE_WIDTH}px; --hive-h:${hiveHeight}px">
        <div class="bento-hive-scroll"><div class="bento-hive" style="height:${hiveHeight}px; width:${HIVE_WIDTH}px">${tools}${ecosystemLabel}${insightsLabel}${matchesLabel}${cells.join('')}</div></div>
      </div>
      ${manifestoHtml}
    </div>`;
}

export function bindDesktopEvents() {
  const ws = document.getElementById('workspace');
  ws.querySelectorAll('[data-act="open"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ns = btn.dataset.ns;
      setActiveNamespace(ns);
      state.activeIdentityId[ns] = btn.dataset.id;
      state.view = 'workspace';
      state.render.all();
    });
  });
  ws.querySelectorAll('[data-act="tool"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ns = btn.dataset.ns;
      const cfg = NS_CONFIG[ns];
      // AIWA/YourMine are real twoSided matching namespaces now (Address/
      // Seeker identities, created via "+" same as any other mode, and
      // reachable afterward through their own tile further down in the
      // Matches zone — pentIdTile's own "open" handler above doesn't go
      // through here at all) — but their TOP tool-wheel tile up here
      // still opens the actual app directly, same as an `external`
      // namespace's tile (Tribute). Two separate entry points, on
      // purpose: the wheel tile is the shortcut to the real AIWA/YourMine
      // site, "+" is the shortcut to matching on it.
      if (cfg.kind === 'external' || ns === 'wallet' || ns === 'creator') { window.open(cfg.url, '_blank', 'noopener'); return; }
      // Near / Agent: no identity to pick, opens straight into its own workspace.
      setActiveNamespace(ns);
      state.view = 'workspace';
      state.render.all();
    });
  });
  ws.querySelectorAll('[data-act="new"]').forEach((btn) => btn.addEventListener('click', pickModeThenCreateIdentity));
  bindBackgroundLongPress();
}

// Long-press anywhere on the Bureau that isn't an actual control (a tile,
// a link, a form field) opens the background picker — the same gesture a
// phone's own home screen uses to change its wallpaper. Without this, a
// long-press on mobile just triggered the browser's native text-selection
// callout over whatever was underneath the finger (background-ui.js's
// #bureauBackdrop itself is pointer-events:none, so the touch always
// lands on .bureau or one of its non-interactive children) — .bureau's
// own user-select:none (style.css) stops that callout from appearing at
// all, and this is what the gesture actually *does* instead.
// Pointer events (not touchstart/mousedown separately) cover touch, pen,
// and mouse in one listener; the move-tolerance check tells a genuine
// long-press apart from the start of a scroll swipe.
const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_TOLERANCE = 10;
function bindBackgroundLongPress() {
  const bureau = document.querySelector('.bureau');
  if (!bureau) return;
  let timer = null;
  let startX = 0;
  let startY = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const isRealControl = (target) => target.closest('button, a, input, textarea, select');
  bureau.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (isRealControl(e.target)) return;
    startX = e.clientX; startY = e.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      if (!document.querySelector('dialog.modal[open]')) openBackgroundPicker();
    }, LONG_PRESS_MS);
  });
  bureau.addEventListener('pointermove', (e) => {
    if (timer && (Math.abs(e.clientX - startX) > LONG_PRESS_MOVE_TOLERANCE || Math.abs(e.clientY - startY) > LONG_PRESS_MOVE_TOLERANCE)) cancel();
  });
  bureau.addEventListener('pointerup', cancel);
  bureau.addEventListener('pointercancel', cancel);
  bureau.addEventListener('contextmenu', (e) => { if (!isRealControl(e.target)) e.preventDefault(); });
}

// A small, standalone pentagon "honeycomb" for the New identity picker —
// reuses ALL_SLOTS[1..9) as-is (skipping only the very first slot)
// rather than inventing new coordinates: that 8-tile run is already part
// of the same flood-fill-verified, gap-free continuous tiling the whole
// Bureau uses (see ALL_SLOTS above), with row widths 2,1,2,1,2 — three
// "wide" (2-tile) rows bulging at the top, middle, and bottom, each
// pinched from the next by a single tile. This is the closest real,
// zero-gap analogue to "3 top / 2 middle / 3 bottom": checked directly
// against every one of a pentagon's 5 real edges, the longest run of
// mutually-adjacent same-row tiles this tiling ever produces is 2, never
// 3 — a literal row of 3 touching pentagons doesn't exist in it.
const PICKER_EDGE = 52;
const PICKER_W = PICKER_EDGE * SQRT3;
const PICKER_H = PICKER_EDGE * (SQRT3 + 1) / 2;
const PICKER_SLOTS = ALL_SLOTS.slice(1, 9);

function pentHalfExtents(rot, edge) {
  const w = edge * SQRT3, h = edge * (SQRT3 + 1) / 2;
  return (rot === 90 || rot === 270) ? { x: h / 2, y: w / 2 } : { x: w / 2, y: h / 2 };
}

// Lays PICKER_SLOTS out in local (0,0)-origin pixels, sized to exactly
// fit their own bounding box — this picker has no surrounding Bureau
// coordinate space to share, unlike pentSlotPx/TOP_CLEARANCE above.
function buildPickerLayout() {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const raw = PICKER_SLOTS.map((p) => {
    const x = p.cx * PICKER_EDGE, y = p.cy * PICKER_EDGE;
    const half = pentHalfExtents(p.rot, PICKER_EDGE);
    minX = Math.min(minX, x - half.x); maxX = Math.max(maxX, x + half.x);
    minY = Math.min(minY, y - half.y); maxY = Math.max(maxY, y + half.y);
    return { x, y, rot: p.rot };
  });
  return {
    width: Math.ceil(maxX - minX),
    height: Math.ceil(maxY - minY),
    items: raw.map((s) => ({ x: s.x - minX, y: s.y - minY, rot: s.rot })),
  };
}

function pentPickerTile(ns, item) {
  const cfg = NS_CONFIG[ns];
  return `
    <button type="button" class="mode-pent" data-ns="${ns}"
      style="--tile-color:${cfg.color}; width:${PICKER_W}px; height:${PICKER_H}px; left:${item.x}px; top:${item.y}px; transform:translate(-50%,-50%) rotate(${item.rot}deg);">
      <span class="mode-pent-face" style="transform:rotate(${-item.rot}deg);">
        ${COOKING.includes(ns) ? '<span class="bento-pent-badge label">cooking</span>' : ''}
        <span class="mode-pent-icon">${cfg.icon}</span>
        <span class="mode-pent-label">${cfg.label}</span>
      </span>
    </button>`;
}

function pentModePickerHtml(namespaces) {
  const { items, width, height } = buildPickerLayout();
  const n = Math.min(namespaces.length, items.length);
  const tiles = namespaces.slice(0, n).map((ns, i) => pentPickerTile(ns, items[i])).join('');
  return `<div class="mode-pent-grid" style="width:${width}px; height:${height}px;">${tiles}</div>`;
}

function pickModeThenCreateIdentity() {
  const dlg = openModal('New identity — choose a mode', pentModePickerHtml(CREATABLE), {
    noSubmit: true,
    onOpen: (d) => {
      d.querySelectorAll('.mode-pent').forEach((btn) => {
        btn.addEventListener('click', () => {
          const ns = btn.dataset.ns;
          d.close();
          createIdentityFlow(ns);
        });
      });
    },
  });
  return dlg;
}
