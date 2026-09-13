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

// 7 tools = 1 center hex + a ring of 6 around it, tiled edge-to-edge like
// real honeycomb cells (not floating in a sparse circle) — 6 is exactly
// how many regular hexagons fit flush around one, so this is the one
// tool count that tiles perfectly with no leftover gap or overlap.
// Messages is the center (it was already the bento grid's hero tile);
// the rest fill the ring in a fixed order. `pos` selects which of the
// six touching neighbor slots a tile sits in — see the matching
// .bento-hex.pos-N rules in style.css for the actual offsets. There's no
// room on a hex for the old sub-text (live counts, "opt-in radius" etc.)
// — icon, label, and badge only.
const TOOL_ORDER = ['messages', 'agent', 'creator', 'wallet', 'tribute', 'near', 'pricing'];

function wheelToolTile(ns, pos, pendingCount) {
  const cfg = NS_CONFIG[ns];
  const badge = ns === 'messages' ? pendingCount : (COOKING.includes(ns) ? 'cooking' : 0);
  const isLabel = typeof badge === 'string';
  const badgeText = isLabel ? badge : (badge > 9 ? '9+' : badge);
  return `
    <button type="button" class="bento-hex ${pos === 0 ? 'pos-center' : `pos-${pos - 1}`}" style="--tile-color:${cfg.color}" data-act="tool" data-ns="${ns}">
      ${badge ? `<span class="bento-hex-badge ${isLabel ? 'label' : 'count'}">${badgeText}</span>` : ''}
      <span class="bento-hex-bg-icon">${cfg.icon}</span>
      <span class="bento-hex-label">${cfg.label}</span>
    </button>`;
}

// Same flat-top hex geometry as the tools wheel (see style.css) — the
// identity section shares the exact same coordinate origin as the wheel
// (Messages' own center), not a fresh one starting below it, so it reads
// as one continuous honeycomb instead of two stacked grids with a seam
// between them. Slots fill in "bands" of 3 (left, right, then center —
// the same column pattern the wheel itself uses), extending downward for
// as many bands as needed; unlike the fixed 7-tile flower, this has to
// work for any count.
const HEX_H = 121.24;
const HEX_HALF_H = HEX_H / 2;
const HEX_COL_SPACING = 105;
// The flower's middle column runs 3 slots (-HEX_H, 0, +HEX_H) around
// Messages, so its own outermost edge sits 1.5 hex-heights from center —
// the identity strip's first band continues right after that same edge.
const FLOWER_HALF_H = 1.5 * HEX_H;

function hexSlotOffset(index) {
  const band = Math.floor(index / 3) + 1;
  const posInBand = index % 3;
  if (posInBand === 0) return { x: -HEX_COL_SPACING, y: HEX_HALF_H + band * HEX_H };
  if (posInBand === 1) return { x: HEX_COL_SPACING, y: HEX_HALF_H + band * HEX_H };
  return { x: 0, y: HEX_H + band * HEX_H };
}

function hexTransform(index) {
  const { x, y } = hexSlotOffset(index);
  return `transform:translate(-50%,-50%) translate(${x}px,${y}px);`;
}

function hexIdTile(ns, id, isLive, index) {
  const cfg = NS_CONFIG[ns];
  return `
    <button type="button" class="bento-hex bento-id-tile" style="--tile-color:${cfg.color}; ${hexTransform(index)}" data-act="open" data-ns="${ns}" data-id="${id.identityId}">
      ${isLive ? '<span class="bento-id-dot" title="Live"></span>' : ''}
      <span class="bento-hex-bg-icon">${cfg.icon}</span>
      <span class="bento-id-name">${id.displayName}</span>
      <span class="bento-id-sub">${cfg.label}</span>
    </button>`;
}

function hexNewButton(index) {
  return `<button type="button" class="bento-hex bento-id-empty bento-id-new" style="${hexTransform(index)}" data-act="new" title="New identity">+</button>`;
}

function hexFillerDiv(index) {
  return `<div class="bento-hex bento-id-empty" style="${hexTransform(index)}"></div>`;
}

// The tile that follows your identity slots once there's still a palier
// worth reaching — see credibility.js. Shown as "score/palier" rather
// than just the raw score, since the number alone means nothing without
// the target it's climbing toward.
function hexScoreTile(score, palier, index) {
  const pct = Math.min(100, Math.round((score / palier) * 100));
  return `
    <div class="bento-hex bento-id-score" style="${hexTransform(index)}" title="Global credibility — every real chat, meeting, or file exchange counts. Reach ${palier} to unlock ${credibility.IDENTITY_PALIER_STEP} more identity slots.">
      <span class="bento-score-frac">${score}<span class="bento-score-slash">/${palier}</span></span>
      <span class="bento-score-label">Credibility</span>
      <span class="bento-score-bar"><span class="bento-score-fill" style="width:${pct}%"></span></span>
    </div>`;
}

export async function renderDesktop() {
  let index = 0;
  const cells = [];
  for (const ns of CREATABLE) {
    for (const id of (state.identitiesByNs[ns] || []).filter((i) => i.active)) {
      // Every identity in a namespace can be live independently now — no
      // longer tied to whichever one happens to be the currently *viewed*
      // identity (state.activeIdentityId is a separate, UI-only concern).
      const isLive = !!state.searchLive[ns]?.has(id.identityId);
      cells.push(hexIdTile(ns, id, isLive, index++));
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
  for (let i = 0; i < plusSlots; i++) cells.push(hexNewButton(index++));
  if (palier != null) cells.push(hexScoreTile(score, palier, index++));

  // Pad empty slots so the strip never looks like a half-finished band,
  // and reads as "room for more" rather than sparse when there are few or
  // no identities yet — a floor of 12 (4 bands of 3), or just enough to
  // complete the current band once there are already more than that.
  const targetSlots = Math.max(12, Math.ceil(index / 3) * 3);
  while (index < targetSlots) cells.push(hexFillerDiv(index++));

  // Absolutely-positioned children (every .bento-hex) don't contribute to
  // their container's height on their own, so it's computed explicitly
  // from the deepest slot actually used, plus the flower's own half-height
  // above the shared center — see .bento-hive's box-sizing:content-box in
  // style.css for why this doesn't fight with its own padding-bottom (the
  // modebar clearance).
  let maxY = 0;
  for (let i = 0; i < index; i++) maxY = Math.max(maxY, hexSlotOffset(i).y);
  const hiveHeight = Math.ceil(FLOWER_HALF_H + maxY + HEX_HALF_H);

  const pendingCount = countPendingNotifications();
  const tools = TOOL_ORDER.map((ns, i) => wheelToolTile(ns, i, pendingCount)).join('');

  return `
    <div class="bureau">
      <div class="bento-hive" style="height:${hiveHeight}px">${tools}${cells.join('')}</div>
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
