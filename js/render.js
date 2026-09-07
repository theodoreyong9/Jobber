// render.js — ties the rail, topbar, and the two workspace kinds together.
// This is deliberately the *only* module that imports from identity-ui.js,
// discovery-ui.js, and research-ui.js all at once — everyone else reaches
// these through `state.render` (populated by app.js right after this file
// loads) specifically so this integration point doesn't have to live in
// three different places.

import * as p2p from './p2p.js';
import * as db from './db.js';
import { state, NAMESPACES, NS_CONFIG, setActiveNamespace } from './state.js';
import { renderModeIcons, renderTopbar, createIdentityFlow } from './identity-ui.js';
import { renderClassicWorkspace, bindClassicEvents } from './discovery-ui.js';
import { renderResearchWorkspace, bindResearchEvents } from './research-ui.js';

function renderWelcomeScreen() {
  return `
    <div class="empty-state" style="max-width:560px;margin:40px auto;text-align:left">
      <h2 class="section-title" style="margin-bottom:6px">Welcome to Jobber</h2>
      <p class="section-sub">Pick where to start — everything stays local until you choose to connect and share.</p>
      <div class="research-actions" style="margin-top:14px">
        ${NAMESPACES.map((ns) => `<button class="btn primary welcome-pick" data-ns="${ns}">${NS_CONFIG[ns].label}</button>`).join('')}
      </div>
    </div>`;
}

export async function renderWorkspace() {
  const ns = state.activeNamespace;
  const ws = document.getElementById('workspace');

  if (!ns) {
    ws.innerHTML = renderWelcomeScreen();
    ws.querySelectorAll('.welcome-pick').forEach((btn) => {
      btn.addEventListener('click', () => { setActiveNamespace(btn.dataset.ns); state.render.all(); });
    });
    document.getElementById('peerCount').textContent = p2p.peerCountAcrossRooms();
    return;
  }

  const id = state.identitiesByNs[ns]?.find((i) => i.identityId === state.activeIdentityId[ns]);

  if (NS_CONFIG[ns].kind === 'research') {
    ws.innerHTML = await renderResearchWorkspace();
    if (id) bindResearchEvents(id);
    else ws.querySelector('#createHere')?.addEventListener('click', () => createIdentityFlow(ns));
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
  renderModeIcons();
  renderTopbar();
  renderWorkspace();
  refreshUsageStat();
}
