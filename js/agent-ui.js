// agent-ui.js — renders what agent.js actually finds. Agent doesn't need
// its own identity to work (the cross-referencing runs on your other
// identities' profiles and whatever's already been discovered) — the
// identity slot in the topbar exists for later, when Agent might act on
// your behalf, not for viewing these results.

import { state, NAMESPACES, NS_CONFIG, roleLabel } from './state.js';
import { getProfile } from './profiles.js';
import { extractOfferSearch, findOpportunities } from './agent.js';

async function gatherMine() {
  const mine = [];
  for (const ns of NAMESPACES) {
    const cfg = NS_CONFIG[ns];
    if (cfg.kind !== 'twoSided' && cfg.kind !== 'reciprocal') continue;
    for (const id of state.identitiesByNs[ns] || []) {
      if (!id.active) continue;
      const profile = await getProfile(id.identityId);
      const classified = extractOfferSearch(ns, id.role, profile);
      if (classified.offerTokens.length || classified.searchTokens.length) {
        mine.push({ ns, identityId: id.identityId, displayName: id.displayName, ...classified });
      }
    }
  }
  return mine;
}

function gatherPeers() {
  const peers = [];
  for (const ns of NAMESPACES) {
    const cfg = NS_CONFIG[ns];
    if (cfg.kind !== 'twoSided' && cfg.kind !== 'reciprocal') continue;
    for (const p of (state.discovered[ns] || new Map()).values()) {
      const classified = extractOfferSearch(ns, p.role, p);
      if (classified.offerTokens.length || classified.searchTokens.length) {
        peers.push({ ns, sender: p.sender, role: p.role, ...classified });
      }
    }
  }
  return peers;
}

export async function renderAgentWorkspace() {
  const mine = await gatherMine();
  const peers = gatherPeers();
  const opportunities = findOpportunities(mine, peers);

  if (!mine.length) {
    return `
      <div class="empty-state" style="max-width:560px;margin:40px auto;text-align:left">
        <h2 class="section-title" style="margin-bottom:6px">Agent</h2>
        <p class="section-sub">${NS_CONFIG.agent.hint}</p>
        <p class="section-sub" style="margin-top:10px">You don't have a profile with anything offered or searched for yet in any two-sided or reciprocal namespace — Agent has nothing of yours to cross-reference against.</p>
      </div>`;
  }
  if (!peers.length) {
    return `
      <div class="empty-state" style="max-width:560px;margin:40px auto;text-align:left">
        <h2 class="section-title" style="margin-bottom:6px">Agent</h2>
        <p class="section-sub">${NS_CONFIG.agent.hint}</p>
        <p class="section-sub" style="margin-top:10px">Nobody's been discovered yet in any namespace — start "Search" somewhere first. Agent only cross-references what's already been found, it doesn't discover on its own.</p>
      </div>`;
  }

  const rows = opportunities.map((o) => {
    const mineLabel = `${NS_CONFIG[o.myNs].label}`;
    const theirLabel = `${NS_CONFIG[o.theirNs].label}${o.theirRole ? ' — ' + roleLabel(o.theirNs, o.theirRole) : ''}`;
    const directionText = o.direction === 'i-offer-they-search'
      ? `What you offer in <b>${mineLabel}</b> matches what they're searching for in <b>${theirLabel}</b>`
      : `What you're searching for in <b>${mineLabel}</b> matches what they offer in <b>${theirLabel}</b>`;
    return `
      <div class="card">
        <div class="top">
          <span class="avatar" style="background:${NS_CONFIG[o.theirNs].color}">🤖</span>
          <div class="info">
            <div class="name">${o.theirSender.slice(0, 10)}…</div>
            <div class="role">${directionText}</div>
            <div class="meta">
              <span class="chip">${o.matchedKeywords.slice(0, 6).join(', ') || 'no shared keywords listed'}</span>
              <span class="chip ${o.usedAi ? 'ai' : ''}">${o.usedAi ? '◆ needed AI enrichment' : '○ words only, no AI needed'}</span>
            </div>
          </div>
          <div class="score">
            <div class="pct">${o.score}%</div>
            <div class="bar"><i style="width:${o.score}%"></i></div>
          </div>
        </div>
      </div>`;
  }).join('');

  return `
    <h2 class="section-title">Agent</h2>
    <p class="section-sub">${NS_CONFIG.agent.hint}</p>
    <p class="section-sub" style="margin-top:4px">${opportunities.length} cross-namespace opportunit${opportunities.length === 1 ? 'y' : 'ies'} found among what you've already discovered.</p>
    <div class="results" style="margin-top:12px">${rows}</div>
  `;
}
