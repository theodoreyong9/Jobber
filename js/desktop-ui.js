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

// Namespaces an identity actually gets created in. Near has no identity of
// its own (see near-ui.js), Agent cross-references your *other* identities
// instead of needing one of its own (see agent-ui.js), Messages likewise
// just reads what your other identities already have (see messages-ui.js),
// and "external" namespaces are just launchers — none of these belong in
// "which mode is this identity for".
const NO_IDENTITY_KINDS = ['near', 'agent', 'messages', 'external'];
const CREATABLE = NAMESPACES.filter((ns) => !NO_IDENTITY_KINDS.includes(NS_CONFIG[ns].kind));
const TOOL_NAMESPACES = NAMESPACES.filter((ns) => NO_IDENTITY_KINDS.includes(NS_CONFIG[ns].kind));

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
// a label is an amber tag) since they mean different things.
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
// aren't finished features yet.
const COOKING = ['creator', 'wallet', 'agent'];

export async function renderDesktop() {
  const identityTiles = [];
  for (const ns of CREATABLE) {
    const cfg = NS_CONFIG[ns];
    for (const id of (state.identitiesByNs[ns] || []).filter((i) => i.active)) {
      const isLive = id.identityId === state.activeIdentityId[ns] && !!state.searchLive[ns];
      identityTiles.push(tileHtml(ns, {
        label: id.displayName,
        sub: cfg.label + (isLive ? ' · live' : ''),
        dataAttrs: `data-act="open" data-ns="${ns}" data-id="${id.identityId}"`,
      }));
    }
  }
  const newTile = `
    <button type="button" class="desktop-tile desktop-tile-new" data-act="new">
      <span class="desktop-tile-glyph">+</span>
      <span class="desktop-tile-label">New identity</span>
    </button>`;

  const pendingCount = countPendingNotifications();

  // NAMESPACE_GROUPS is Match/Insight/Ecosystem order; the Bureau reads the
  // opposite way — the portfolio's other apps and the cross-cutting tools
  // first, your own identities last — hence the reverse().
  const toolSections = groupsOf(TOOL_NAMESPACES).reverse().map((g) => `
    <div class="desktop-section">
      <div class="desktop-section-label">${g.label}</div>
      <div class="desktop-grid">
        ${g.namespaces.map((ns) => tileHtml(ns, {
          label: NS_CONFIG[ns].label,
          dataAttrs: `data-act="tool" data-ns="${ns}"`,
          badge: ns === 'messages' ? pendingCount : (COOKING.includes(ns) ? 'cooking' : 0),
        })).join('')}
      </div>
    </div>`).join('');

  return `
    <div class="desktop">
      ${toolSections}
      <div class="desktop-section">
        <div class="desktop-section-label">Your identities</div>
        <div class="desktop-grid">${identityTiles.join('')}${newTile}</div>
      </div>
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
  ws.querySelector('[data-act="new"]')?.addEventListener('click', pickModeThenCreateIdentity);
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
