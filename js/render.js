// render.js — ties the topbar and the workspace kinds together (the Bureau
// counts as one now too). This is deliberately the *only* module that
// imports from identity-ui.js, discovery-ui.js, and research-ui.js all at
// once — everyone else reaches these through `state.render` (populated by
// app.js right after this file loads) specifically so this integration
// point doesn't have to live in three different places.

import * as p2p from './p2p.js';
import * as db from './db.js';
import { state, NS_CONFIG } from './state.js';
import { renderTopbar, createIdentityFlow } from './identity-ui.js';
import { renderClassicWorkspace, bindClassicEvents } from './discovery-ui.js';
import { renderResearchWorkspace, bindResearchEvents } from './research-ui.js';
import { renderNearWorkspace, bindNearEvents } from './near-ui.js';
import { renderAgentWorkspace } from './agent-ui.js';
import { renderMessagesWorkspace, bindMessagesEvents } from './messages-ui.js';
import { renderPricingWorkspace } from './pricing-ui.js';
import { renderDesktop, bindDesktopEvents } from './desktop-ui.js';

export async function renderWorkspace() {
  const ws = document.getElementById('workspace');

  // No namespace picked, or explicitly on the Bureau (the home screen) —
  // see desktop-ui.js. A namespace with nothing active in it left over
  // from a retired identity falls back here too rather than a dead end.
  if (state.view !== 'workspace' || !state.activeNamespace) {
    state.view = 'desktop';
    ws.innerHTML = await renderDesktop();
    bindDesktopEvents();
    document.getElementById('peerCount').textContent = p2p.peerCountAcrossRooms();
    return;
  }

  const ns = state.activeNamespace;
  const id = state.identitiesByNs[ns]?.find((i) => i.identityId === state.activeIdentityId[ns]);

  if (NS_CONFIG[ns].kind === 'research') {
    ws.innerHTML = await renderResearchWorkspace();
    if (id) bindResearchEvents(id);
    else ws.querySelector('#createHere')?.addEventListener('click', () => createIdentityFlow(ns));
  } else if (NS_CONFIG[ns].kind === 'agent') {
    ws.innerHTML = await renderAgentWorkspace();
  } else if (NS_CONFIG[ns].kind === 'near') {
    ws.innerHTML = await renderNearWorkspace();
    bindNearEvents();
  } else if (NS_CONFIG[ns].kind === 'messages') {
    ws.innerHTML = await renderMessagesWorkspace();
    bindMessagesEvents();
  } else if (NS_CONFIG[ns].kind === 'info') {
    ws.innerHTML = await renderPricingWorkspace();
  } else {
    ws.innerHTML = await renderClassicWorkspace(ns);
    bindClassicEvents(ns);
  }

  document.getElementById('peerCount').textContent = p2p.peerCountAcrossRooms();
}

export async function refreshUsageStat() {
  const bytes = await db.estimateUsage();
  document.getElementById('usageStat').textContent = bytes ? `${(bytes / 1e6).toFixed(1)} MB` : '—';
}

export function renderAll() {
  renderTopbar();
  renderWorkspace();
  refreshUsageStat();
}
