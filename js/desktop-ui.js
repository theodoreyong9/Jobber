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

import { state, NAMESPACES, NS_CONFIG, NAMESPACE_GROUPS, setActiveNamespace } from './state.js';
import { createIdentityFlow } from './identity-ui.js';
import { openModal } from './ui-kit.js';
import { countPendingNotifications } from './messages-ui.js';
import * as credibility from './credibility.js';

// Namespaces an identity actually gets created in. Near has no identity of
// its own (see near-ui.js), Agent cross-references your *other* identities
// instead of needing one of its own (see agent-ui.js), Messages likewise
// just reads what your other identities already have (see messages-ui.js),
// "external" namespaces are just launchers, and "info" namespaces are a
// static page about Jobber itself — none of these belong in "which mode
// is this identity for".
const NO_IDENTITY_KINDS = ['near', 'agent', 'messages', 'external', 'info'];
const CREATABLE = NAMESPACES.filter((ns) => !NO_IDENTITY_KINDS.includes(NS_CONFIG[ns].kind));

function groupsOf(list) {
  return NAMESPACE_GROUPS
    .map((g) => ({ label: g.label, namespaces: g.namespaces.filter((ns) => list.includes(ns)) }))
    .filter((g) => g.namespaces.length);
}

export function goToDesktop() {
  state.view = 'desktop';
  state.render.all();
}

// One click on the brand mark always takes you home — the standard
// "click the logo" affordance, and the only way back once you've tapped
// into a workspace (there's no separate back button in the topbar).
document.querySelector('.brand-mini')?.addEventListener('click', goToDesktop);

// `badge` is either a notification count (number) or a status tag like
// "cooking" (string) — visually distinct (a number is a red count pill,
// a label is an amber tag) since they mean different things. Used by the
// "New identity" mode-picker modal only now — the Bureau itself renders
// its own bento tiles below.
function tileHtml(ns, { label, sub = '', dataAttrs, badge = 0 }) {
  const cfg = NS_CONFIG[ns];
  const isLabel = typeof badge === 'string';
  const badgeText = isLabel ? badge : (badge > 9 ? '9+' : badge);
  return `
    <button type="button" class="desktop-tile" style="--tile-color:${cfg.color}" ${dataAttrs}>
      ${badge ? `<span class="desktop-tile-badge${isLabel ? ' desktop-tile-badge-label' : ''}">${badgeText}</span>` : ''}
      <span class="desktop-tile-glyph">${cfg.icon}</span>
      <span class="desktop-tile-label">${label}</span>
      ${sub ? `<span class="desktop-tile-sub">${sub}</span>` : ''}
    </button>`;
}

// Still being built out — flagged on the Bureau so it's clear these
// aren't finished features yet. Pricing counts too: only one of its five
// tiers is real (see pricing-ui.js) — the rest of that page is "Soon".
const COOKING = ['creator', 'wallet', 'agent', 'pricing'];

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
const PENT_EDGE = 84; // px — length of one long edge; the one tunable size knob
const PENT_W = PENT_EDGE * SQRT3; // ≈145.5px
const PENT_H = PENT_EDGE * (SQRT3 + 1) / 2; // ≈114.8px
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
const PENT_PATCH = generatePentagonPatch(13).map((p) => ({
  cx: -p.cx, cy: -p.cy, rot: (p.rot + 180) % 360,
}));

// The 7 tools as two stacked rows instead of a hex flower — a regular
// hexagon can surround itself with 6 neighbors in a closed ring; this
// pentagon can't (see the tiling notes above), so there's no equivalent
// single-tile-in-the-middle shape for exactly 7. A 3-tile row (Ecosystem)
// directly above a 4-tile row (Insight) is the most compact arrangement
// that actually occurs in the real tiling with no gaps between them —
// verified the same way as the rest of this geometry, by checking every
// edge among these 7 either matches its neighbor here or continues
// cleanly into the wider tiling.
const TOOL_SLOTS = [
  { cx: -3.4641016, cy: 0, rot: 180 },            // Ecosystem, left
  { cx: 0, cy: 0, rot: 180 },                     // Ecosystem, center
  { cx: 3.4641016, cy: 0, rot: 180 },              // Ecosystem, right
  { cx: -2.4150635, cy: 0.6830127, rot: 90 },     // Insight, 1
  { cx: -1.0490381, cy: 0.6830127, rot: 270 },    // Insight, 2
  { cx: 1.0490381, cy: 0.6830127, rot: 90 },      // Insight, 3
  { cx: 2.4150635, cy: 0.6830127, rot: 270 },     // Insight, 4
];
const TOOL_ORDER = ['tribute', 'wallet', 'creator', 'pricing', 'messages', 'agent', 'near'];
// A light gap between the Ecosystem row and the Insight row below it
// (pure visual padding, same idea as the old hex layout's zone gaps) —
// applied to the Ecosystem row's y only, so it stays flush with itself
// and only pulls away from Insight. In "pentagon units" (÷PENT_EDGE),
// added directly to cy before scaling to px.
const ECOSYSTEM_GAP_UNITS = 0.35;
// Same idea below Insight, before the identity strip starts.
const MATCHES_GAP_UNITS = 0.35;

// Every pentagon in PENT_PATCH strictly below the tool rows (cy > 1,
// i.e. below Insight's own row at cy=0.683), within a band wide enough
// to read as one strip rather than the tools' own narrower width, ordered
// top-to-bottom then left-to-right — this is what identity slots are
// handed out from, in order, same role hexSlotOffset(index) used to play.
// Unlike the old hex formula this can't be a closed-form expression: the
// real Cairo tiling's rows alternate 3/2/4/2 tiles wide on a 6-row
// repeat, not a uniform grid, so slots are read off the real generated
// patch instead of computed — and, with PENT_PATCH's orientation now
// actually correct (see the note above its own definition), that
// alternation tiles with zero internal gaps, verified both by the same
// brute-force edge check and by eye against a real Cairo-tile photo.
// Cutting the tiling off at any finite width still
// necessarily leaves some edge tiles' true neighbors (in the fuller
// patch) just outside the band, so the strip's left/right edge reads as
// a naturally jagged Cairo edge rather than a clean rectangle — same idea
// as a hex flower's own silhouette never being a perfect hexagon — but
// that jaggedness is confined to the two outer edges now, not scattered
// through the interior.
const IDENTITY_BAND = 3.6;
const IDENTITY_SLOTS = PENT_PATCH
  .filter((p) => Math.abs(p.cx) <= IDENTITY_BAND && p.cy > 1)
  .sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
// IDENTITY_SLOTS' rows aren't a fixed size (2, 3, or 4 tiles, alternating
// — see above), so stopping the strip mid-row would leave one side of
// that row's own natural jagged edge missing its (harmless) counterpart
// on the other side, reading as a one-sided notch rather than the
// tiling's own symmetric edge. Precomputed once so renderDesktop can
// always round the strip's length up to the end of a whole row.
const IDENTITY_ROW_ENDS = (() => {
  const ends = [];
  let i = 0;
  while (i < IDENTITY_SLOTS.length) {
    let j = i + 1;
    while (j < IDENTITY_SLOTS.length && Math.abs(IDENTITY_SLOTS[j].cy - IDENTITY_SLOTS[i].cy) < 1e-6) j++;
    ends.push(j);
    i = j;
  }
  return ends;
})();
function roundUpToIdentityRow(n) {
  for (const end of IDENTITY_ROW_ENDS) if (end >= n) return end;
  return IDENTITY_SLOTS.length;
}
// Container width: wide enough for the widest thing actually placed in
// it (the identity band, ±IDENTITY_BAND, is wider than the 3-tile tool
// row) plus one full pentagon's width so a tile centered at the band's
// edge doesn't get half-clipped. On a narrow viewport this can exceed
// the screen — .bento-hive-scroll (style.css) turns that into a
// horizontal scroll shelf instead of clipping tiles outright.
const HIVE_WIDTH = Math.ceil(2 * IDENTITY_BAND * PENT_EDGE + PENT_W);

function pentSlotPx({ cx, cy, rot }, extraYUnits = 0) {
  // Direct mapping now that PENT_PATCH's own (cx,cy,rot) are already in
  // screen convention (the 180°-rotation baked in above) — no further
  // flip here. extraYUnits is a plain additional offset in the same
  // units, positive meaning further down the screen (see its two call
  // sites: negative to push the Ecosystem row up and away from Insight,
  // positive to push the identity strip down and away from Insight).
  return { x: cx * PENT_EDGE, y: (cy + extraYUnits) * PENT_EDGE, rot };
}
// Raw (pre-clearance) y of the Ecosystem/Insight tool rows — every tile
// in a row shares the same cy, so any one slot from it gives the row's y.
const ECOSYSTEM_ROW_Y = pentSlotPx(TOOL_SLOTS[1], -ECOSYSTEM_GAP_UNITS).y;
const INSIGHT_ROW_Y = pentSlotPx(TOOL_SLOTS[3], 0).y;
// How far below the container's top edge the tiling's own y=0 line sits.
// Sized so the highest thing drawn (the pushed-up Ecosystem row's top
// edge) clears the container, with LABEL_HEADROOM to spare for its own
// "Ecosystem" label above it. Baked directly into pentTransform's
// translate() below instead of split across a shared CSS `top:Xpx` the
// way the old hex flower did it (that value, FLOWER_HALF_H, quietly ran
// ~28px short of the tallest hex it actually needed to clear — folding
// the clearance into one JS constant instead of two independently-tuned
// numbers removes that whole class of drift).
const LABEL_HEADROOM = 22;
const TOP_CLEARANCE = Math.ceil(PENT_H / 2 - ECOSYSTEM_ROW_Y + LABEL_HEADROOM);

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
function pentFaceStyle(rot) {
  return `transform:rotate(${-rot}deg);`;
}

function wheelToolTile(ns, i, pendingCount) {
  const cfg = NS_CONFIG[ns];
  const badge = ns === 'messages' ? pendingCount : (COOKING.includes(ns) ? 'cooking' : 0);
  const isLabel = typeof badge === 'string';
  const badgeText = isLabel ? badge : (badge > 9 ? '9+' : badge);
  const isEcosystem = i < 3;
  const slotPx = pentSlotPx(TOOL_SLOTS[i], isEcosystem ? -ECOSYSTEM_GAP_UNITS : 0);
  return `
    <button type="button" class="bento-pent" style="--tile-color:${cfg.color}; ${pentTransform(slotPx)}" data-act="tool" data-ns="${ns}">
      <span class="bento-pent-face" style="${pentFaceStyle(slotPx.rot)}">
        ${badge ? `<span class="bento-pent-badge ${isLabel ? 'label' : 'count'}">${badgeText}</span>` : ''}
        <span class="bento-pent-bg-icon">${cfg.icon}</span>
        <span class="bento-pent-label">${cfg.label}</span>
      </span>
    </button>`;
}

function identitySlotPx(index) {
  return pentSlotPx(IDENTITY_SLOTS[index], MATCHES_GAP_UNITS);
}

function pentIdTile(ns, id, isLive, index) {
  const cfg = NS_CONFIG[ns];
  const slotPx = identitySlotPx(index);
  return `
    <button type="button" class="bento-pent bento-id-tile" style="--tile-color:${cfg.color}; ${pentTransform(slotPx)}" data-act="open" data-ns="${ns}" data-id="${id.identityId}">
      <span class="bento-pent-face" style="${pentFaceStyle(slotPx.rot)}">
        ${isLive ? '<span class="bento-id-dot" title="Live"></span>' : ''}
        <span class="bento-pent-bg-icon">${cfg.icon}</span>
        <span class="bento-id-name">${id.displayName}</span>
        <span class="bento-id-sub">${cfg.label}</span>
      </span>
    </button>`;
}

function pentNewButton(index) {
  const slotPx = identitySlotPx(index);
  return `
    <button type="button" class="bento-pent bento-id-empty bento-id-new" style="${pentTransform(slotPx)}" data-act="new" title="New identity">
      <span class="bento-pent-face" style="${pentFaceStyle(slotPx.rot)}">+</span>
    </button>`;
}

function pentFillerDiv(index) {
  return `<div class="bento-pent bento-id-empty" style="${pentTransform(identitySlotPx(index))}"></div>`;
}

// The tile that follows your identity slots once there's still a palier
// worth reaching — see credibility.js. Shown as "score/palier" rather
// than just the raw score, since the number alone means nothing without
// the target it's climbing toward.
function pentScoreTile(score, palier, index) {
  const pct = Math.min(100, Math.round((score / palier) * 100));
  const slotPx = identitySlotPx(index);
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
const MANIFESTO_LEAD = 'A world without accounts, where everyone owns their identity and connects directly with anyone, anywhere, for anything.';
const MANIFESTO_SUB = 'A world that doesn’t disappear when the network does.';
const manifestoHtml = `
  <div class="bureau-manifesto">
    <div class="bureau-manifesto-rule"></div>
    <p class="bureau-manifesto-lead">${MANIFESTO_LEAD}</p>
    <p class="bureau-manifesto-sub">${MANIFESTO_SUB}</p>
  </div>`;

export async function renderDesktop() {
  let index = 0;
  const cells = [];
  for (const ns of CREATABLE) {
    for (const id of (state.identitiesByNs[ns] || []).filter((i) => i.active)) {
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
  const plusSlots = Math.max(0, cap - realCount);
  for (let i = 0; i < plusSlots; i++) cells.push(pentNewButton(index++));
  if (palier != null) cells.push(pentScoreTile(score, palier, index++));

  // Pad empty slots so the strip never looks like a half-finished band,
  // and reads as "room for more" rather than sparse when there are few or
  // no identities yet — a floor of 12, rounded up to the end of whichever
  // Cairo row that floor lands in (see IDENTITY_ROW_ENDS above) so the
  // strip always stops at one of the tiling's own natural row edges
  // instead of an arbitrary cut partway through one.
  const targetSlots = roundUpToIdentityRow(Math.max(12, index));
  while (index < targetSlots) cells.push(pentFillerDiv(index++));

  // Absolutely-positioned children (every .bento-pent) don't contribute to
  // their container's height on their own, so it's computed explicitly
  // from the deepest identity slot actually used, plus the clearance
  // above y=0 (TOP_CLEARANCE) and this pentagon's own half-height below
  // it — see .bento-hive's box-sizing:content-box in style.css for why
  // this doesn't fight with its own padding-bottom (the modebar
  // clearance).
  let maxY = 0;
  for (let i = 0; i < index; i++) maxY = Math.max(maxY, identitySlotPx(i).y);
  const hiveHeight = Math.ceil(TOP_CLEARANCE + maxY + PENT_H / 2);

  const pendingCount = countPendingNotifications();
  const tools = TOOL_ORDER.map((ns, i) => wheelToolTile(ns, i, pendingCount)).join('');
  // All three labels live inside .bento-hive, positioned in the same raw
  // (pre-TOP_CLEARANCE) coordinate space as every pentagon above, via the
  // same helper — so they bob with the levitation animation exactly like
  // the tiles do, instead of sitting outside it as a static element that
  // would visibly detach on every float cycle. "Ecosystem" sits just
  // above the pushed-up top row; "Insights" in the gap that push opens
  // against the row below it; "Matchs" in the MATCHES_GAP_UNITS gap
  // before the identity strip starts.
  const labelTransform = (y) => `transform:translate(-50%,-50%) translate(0px,${Math.round(y + TOP_CLEARANCE)}px);`;
  const ecosystemLabel = `<span class="bento-section-label" style="${labelTransform(ECOSYSTEM_ROW_Y - PENT_H / 2 - 10)}">Ecosystem</span>`;
  const insightsLabel = `<span class="bento-section-label" style="${labelTransform((ECOSYSTEM_ROW_Y + INSIGHT_ROW_Y) / 2)}">Insights</span>`;
  const matchesLabel = `<span class="bento-section-label" style="${labelTransform((INSIGHT_ROW_Y + identitySlotPx(0).y) / 2)}">Matchs</span>`;

  return `
    <div class="bureau">
      <div class="bento-hive-scroll"><div class="bento-hive" style="height:${hiveHeight}px; width:${HIVE_WIDTH}px">${tools}${ecosystemLabel}${insightsLabel}${matchesLabel}${cells.join('')}</div></div>
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
      if (cfg.kind === 'external') { window.open(cfg.url, '_blank', 'noopener'); return; }
      // Near / Agent: no identity to pick, opens straight into its own workspace.
      setActiveNamespace(ns);
      state.view = 'workspace';
      state.render.all();
    });
  });
  ws.querySelectorAll('[data-act="new"]').forEach((btn) => btn.addEventListener('click', pickModeThenCreateIdentity));
}

function pickModeThenCreateIdentity() {
  const dlg = openModal('New identity — choose a mode', groupsOf(CREATABLE).map((g) => `
    <div class="mode-picker-group">
      <div class="mode-picker-group-label">${g.label}</div>
      <div class="desktop-grid">
        ${g.namespaces.map((ns) => tileHtml(ns, { label: NS_CONFIG[ns].label, dataAttrs: `data-ns="${ns}"` })).join('')}
      </div>
    </div>`).join(''), {
    noSubmit: true,
    onOpen: (d) => {
      d.querySelectorAll('.desktop-tile').forEach((btn) => {
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
