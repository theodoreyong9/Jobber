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

// The 7 tools sit as hexagons around a wheel now instead of a hand-placed
// bento grid — a fixed order, evenly spaced by angle (360°/7), rather
// than a bespoke size/position per tool. There's no room left on a small
// hex for the old sub-text (live counts, "opt-in radius" etc.) — icon,
// label, and badge only.
const TOOL_ORDER = ['messages', 'pricing', 'creator', 'wallet', 'tribute', 'near', 'agent'];

function wheelToolTile(ns, index, total, pendingCount) {
  const cfg = NS_CONFIG[ns];
  const angle = (360 / total) * index;
  const badge = ns === 'messages' ? pendingCount : (COOKING.includes(ns) ? 'cooking' : 0);
  const isLabel = typeof badge === 'string';
  const badgeText = isLabel ? badge : (badge > 9 ? '9+' : badge);
  return `
    <button type="button" class="bento-hex" style="--tile-color:${cfg.color}; --angle:${angle}deg;" data-act="tool" data-ns="${ns}">
      ${badge ? `<span class="bento-hex-badge ${isLabel ? 'label' : 'count'}">${badgeText}</span>` : ''}
      <span class="bento-hex-icon">${cfg.icon}</span>
      <span class="bento-hex-label">${cfg.label}</span>
    </button>`;
}

function bentoIdTile(ns, id, isLive) {
  const cfg = NS_CONFIG[ns];
  return `
    <button type="button" class="bento-id-tile" style="--tile-color:${cfg.color}" data-act="open" data-ns="${ns}" data-id="${id.identityId}">
      <span class="bento-bg-icon" aria-hidden="true">${cfg.icon}</span>
      ${isLive ? '<span class="bento-id-dot" title="Live"></span>' : ''}
      <span class="bento-id-name">${id.displayName}</span>
      <span class="bento-id-sub">${cfg.label}</span>
    </button>`;
}

// The tile that follows your identity slots once there's still a palier
// worth reaching — see credibility.js. Shown as "score/palier" rather
// than just the raw score, since the number alone means nothing without
// the target it's climbing toward.
function bentoScoreTile(score, palier) {
  const pct = Math.min(100, Math.round((score / palier) * 100));
  return `
    <div class="bento-id-score" title="Global credibility — every real chat, meeting, or file exchange counts. Reach ${palier} to unlock ${credibility.IDENTITY_PALIER_STEP} more identity slots.">
      <span class="bento-score-frac">${score}<span class="bento-score-slash">/${palier}</span></span>
      <span class="bento-score-label">Credibility</span>
      <span class="bento-score-bar"><span class="bento-score-fill" style="width:${pct}%"></span></span>
    </div>`;
}

export async function renderDesktop() {
  const identityTiles = [];
  for (const ns of CREATABLE) {
    for (const id of (state.identitiesByNs[ns] || []).filter((i) => i.active)) {
      // Every identity in a namespace can be live independently now — no
      // longer tied to whichever one happens to be the currently *viewed*
      // identity (state.activeIdentityId is a separate, UI-only concern).
      const isLive = !!state.searchLive[ns]?.has(id.identityId);
      identityTiles.push(bentoIdTile(ns, id, isLive));
    }
  }

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
  const plusSlots = Math.max(0, cap - identityTiles.length);
  const newTiles = Array.from({ length: plusSlots }, () => '<button type="button" class="bento-id-empty bento-id-new" data-act="new" title="New identity">+</button>').join('');
  const scoreTile = palier != null ? bentoScoreTile(score, palier) : '';

  // Pad empty slots so the grid never looks like a half-finished row, and
  // reads as "room for more" rather than sparse when there are few or no
  // identities yet — a floor of 12 (3 rows), or just enough to complete
  // the current row once there are already more than that.
  const usedSlots = identityTiles.length + plusSlots + (scoreTile ? 1 : 0);
  const targetSlots = Math.max(12, Math.ceil(usedSlots / 4) * 4);
  const fillers = Array.from({ length: targetSlots - usedSlots }, () => '<div class="bento-id-empty"></div>').join('');

  const pendingCount = countPendingNotifications();
  const tools = TOOL_ORDER.map((ns, i) => wheelToolTile(ns, i, TOOL_ORDER.length, pendingCount)).join('');

  return `
    <div class="bureau">
      <div class="bento-wheel">
        <div class="bento-wheel-hub"><span class="bento-wheel-hub-dot"></span></div>
        ${tools}
      </div>
      <div class="bento-identities">${identityTiles.join('')}${newTiles}${scoreTile}${fillers}</div>
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
