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

  // Every branch below generates its HTML *before* touching the DOM —
  // deliberately, since some of those renders (renderDesktop's own
  // credibility read, in particular) do real async work. Mutating
  // ws.classList first and awaiting the content after used to leave the
  // *previous* workspace's content sitting there under the *new* layout
  // rules (padding on/off) for however long that await took — visible as
  // a brief, wrongly-sized flash of the old page before the real content
  // replaced it. Resolving the content first and batching every DOM
  // mutation together afterward means whatever's on screen is always
  // either fully the old page or fully the new one, never a mix.

  // No namespace picked, or explicitly on the Bureau (the home screen) —
  // see desktop-ui.js. A namespace with nothing active in it left over
  // from a retired identity falls back here too rather than a dead end.
  if (state.view !== 'workspace' || !state.activeNamespace) {
    state.view = 'desktop';
    const html = await renderDesktop();
    // The Bureau still scrolls the normal .workspace way (one whole page,
    // vertical only) — this class just turns off .workspace's usual
    // side/top padding so the tiles sit truly edge-to-edge, see
    // .workspace-bureau in style.css.
    ws.classList.add('workspace-bureau');
    ws.innerHTML = html;
    bindDesktopEvents();
    document.getElementById('peerCount').textContent = p2p.peerCountAcrossRooms();
    document.getElementById('bureauBackdrop')?.classList.add('visible');
    return;
  }
  document.getElementById('bureauBackdrop')?.classList.remove('visible');

  const ns = state.activeNamespace;
  const id = state.identitiesByNs[ns]?.find((i) => i.identityId === state.activeIdentityId[ns]);
  let html;
  let bind = () => {};

  if (NS_CONFIG[ns].kind === 'research') {
    html = await renderResearchWorkspace();
    bind = () => {
      if (id) bindResearchEvents(id);
      else ws.querySelector('#createHere')?.addEventListener('click', () => createIdentityFlow(ns));
    };
  } else if (NS_CONFIG[ns].kind === 'agent') {
    html = await renderAgentWorkspace();
  } else if (NS_CONFIG[ns].kind === 'near') {
    html = await renderNearWorkspace();
    bind = bindNearEvents;
  } else if (NS_CONFIG[ns].kind === 'messages') {
    html = await renderMessagesWorkspace();
    bind = bindMessagesEvents;
  } else if (NS_CONFIG[ns].kind === 'info') {
    html = await renderPricingWorkspace();
  } else {
    html = await renderClassicWorkspace(ns);
    bind = () => bindClassicEvents(ns);
  }

  ws.classList.remove('workspace-bureau');
  ws.innerHTML = html;
  bind();
  document.getElementById('peerCount').textContent = p2p.peerCountAcrossRooms();
}

export async function refreshUsageStat() {
  const bytes = await db.estimateUsage();
  document.getElementById('usageStat').textContent = bytes ? `${(bytes / 1e6).toFixed(1)} MB` : '—';
}

export async function renderAll() {
  // Workspace content first, topbar after — matching the order every
  // other paired call site in the app already uses (discovery-ui.js,
  // identity-ui.js, profiles.js). renderTopbar's own DOM mutation
  // (showing/hiding the bar) is synchronous and immediate, so calling it
  // before renderWorkspace's content has actually finished resolving —
  // as this used to do — reflows the *old* page into the topbar's freed
  // or claimed space before the new one is in place. Awaiting
  // renderWorkspace first means the topbar only ever changes once the
  // content it's about to reveal or cover is already correct.
  await renderWorkspace();
  renderTopbar();
  refreshUsageStat();
}
