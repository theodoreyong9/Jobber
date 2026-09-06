// discovery-ui.js — Search Live, the matching cascade, and the results
// cards for every non-Research namespace. Imports profiles.js and
// conversations.js directly (safe, one-directional); reaches
// message-router.js and render.js only through `state.handlers` /
// `state.render` to avoid a circular import — see state.js's header.

import * as p2p from './p2p.js';
import * as discovery from './discovery.js';
import * as matching from './matching.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { state, NS_CONFIG, PEER_TTL_MS, roleLabel, complementaryRole } from './state.js';
import { openModal, toast } from './ui-kit.js';
import { createIdentityFlow } from './identity-ui.js';
import { getProfile, editProfileFlow, editEmploymentProfileFlow, editSupplyDemandProfileFlow, enrichProfileWithAI } from './profiles.js';
import {
  blockPeer, proposeMeetingFlow, respondMeeting, requestDocument, shareDocument, declineDocument,
  loadConversation, listConversations, persistMessage, requestChat, respondChat, sendChatMessage,
  renderChatPanel, proposeAttachment, respondAttachmentOffer,
} from './conversations.js';

export async function toggleSearchLive(ns) {
  state.searchLive[ns] = !state.searchLive[ns];
  const id = state.identitiesByNs[ns].find((i) => i.identityId === state.activeIdentityId[ns]);
  if (state.searchLive[ns]) {
    try {
      await p2p.joinNamespaceRoom(ns, {
        onPeerJoin: async (peerId) => {
          const profile = await getProfile(id.identityId);
          const cfg = NS_CONFIG[ns];
          const payload = {
            category: profile.category,
            tokens: [...profile.tokens, ...profile.aiTokens].slice(0, 30),
            languages: profile.languages,
            availableNow: profile.availableNow,
          };
          if (cfg.kind === 'twoSided') payload.role = id.role;
          if (cfg.kind === 'reciprocal') payload.searchTokens = profile.searchTokens.slice(0, 30);
          if (cfg.kind === 'twoSided') {
            payload.country = profile.country;
            payload.city = profile.city;
            const isSupply = id.role === cfg.roles[0].key; // candidate / offer / provider
            if (ns === 'employment') {
              if (isSupply) {
                payload.earliestYear = profile.earliestYear;
              } else {
                payload.seniorityMin = profile.seniorityMin;
                payload.seniorityMax = profile.seniorityMax;
                payload.postingText = profile.jobPostingText; // job ads are public, unlike CVs
              }
            } else if (ns === 'business' || ns === 'independant') {
              if (isSupply) {
                payload.rate = profile.rate;
              } else {
                payload.budgetMin = profile.budgetMin;
                payload.budgetMax = profile.budgetMax;
                payload.postingText = profile.sourceText; // the request/mission text is public
              }
            }
          }
          p2p.getRoom(ns).send('discovery', id.identityId, payload, peerId);
        },
        onPeerLeave: (peerId) => {
          const theirIdentityId = state.peerToIdentity[ns].get(peerId);
          if (theirIdentityId) state.identityToPeer[ns].delete(theirIdentityId);
          state.peerToIdentity[ns].delete(peerId);
          state.render.workspace();
          state.render.topbar();
        },
        onMessage: (msg, peerId) => state.handlers.incomingMessage(ns, msg, peerId),
        onBlob: (blob, peerId, metadata) => {
          const theirIdentityId = state.peerToIdentity[ns].get(peerId) || peerId;
          const entry = {
            from: 'them', kind: 'attachment', ts: Date.now(),
            name: metadata.name || 'file', size: blob.size, url: URL.createObjectURL(blob),
          };
          if (!state.chatLog[ns].has(theirIdentityId)) state.chatLog[ns].set(theirIdentityId, []);
          state.chatLog[ns].get(theirIdentityId).push(entry);
          state.loadedConversations[ns].add(theirIdentityId);
          persistMessage(ns, theirIdentityId, { ...entry, url: undefined, blob });
          toast(`Received attachment: ${metadata.name || 'file'}`);
          state.render.workspace();
        },
      });
    } catch (e) {
      toast('P2P networking unavailable: ' + e.message);
      state.searchLive[ns] = false;
    }
  } else {
    p2p.leaveNamespaceRoom(ns);
    state.discovered[ns].clear();
  }
  state.render.all();
}
state.handlers.toggleSearchLive = toggleSearchLive; // identity-ui.js's topbar calls this indirectly

export function scoreAgainstPeer(cfg, myTokens, myLookingForTokens, p) {
  if (cfg.kind === 'reciprocal') {
    const forward = matching.matchTokens(myLookingForTokens, p.tokens || []);   // does their profile fit what I want
    const backward = matching.matchTokens(p.searchTokens || [], myTokens);       // does my profile fit what they want
    return { score: Math.min(forward.score, backward.score), forward, backward };
  }
  return matching.matchTokens(myTokens, p.tokens || []);
}

export function explainMatch(cfg, match) {
  return cfg.kind === 'reciprocal'
    ? {
        pos: [
          `They fit what you're looking for: ${match.forward.score}%`,
          `You fit what they're looking for: ${match.backward.score}%`,
          ...matching.explain(match.forward).pos.slice(0, 3),
        ],
        neg: matching.explain(match.backward).neg,
      }
    : matching.explain(match);
}

// Real P2P discovery needs a second peer — one browser tab is one WebRTC
// identity, so two identities created in the *same* tab can never discover
// each other over the network. This computes the same match directly from
// local data so you can sanity-check matching without needing a second tab.
async function localTestMatches(ns, cfg, id, myTokens, myLookingForTokens) {
  if (cfg.kind === 'research') return [];
  const wantRole = cfg.kind === 'twoSided' ? complementaryRole(ns, id.role) : null;
  const candidates = state.identitiesByNs[ns].filter((other) =>
    other.identityId !== id.identityId && other.active &&
    (cfg.kind !== 'twoSided' || other.role === wantRole)
  );
  const out = [];
  for (const other of candidates) {
    const p2 = await getProfile(other.identityId);
    const peerLike = {
      sender: other.identityId, displayName: other.displayName, category: p2.category,
      tokens: [...p2.tokens, ...(p2.aiTokens || [])], searchTokens: p2.searchTokens,
      country: p2.country, city: p2.city, earliestYear: p2.earliestYear,
      seniorityMin: p2.seniorityMin, seniorityMax: p2.seniorityMax,
      languages: p2.languages, availableNow: p2.availableNow,
    };
    const match = scoreAgainstPeer(cfg, myTokens, myLookingForTokens, peerLike);
    out.push({ ...peerLike, match });
  }
  return out.sort((a, b) => b.match.score - a.match.score);
}

export async function renderClassicWorkspace(ns) {
  const cfg = NS_CONFIG[ns];
  const id = state.identitiesByNs[ns].find((i) => i.identityId === state.activeIdentityId[ns]);
  if (!id) return `<div class="empty-state"><p>Create an identity in ${cfg.label} to get started.</p><button class="btn primary" id="createHere">Create identity</button></div>`;

  const profile = await getProfile(id.identityId);
  const myTokens = [...profile.tokens, ...(state.aiOn[ns] ? profile.aiTokens : [])];
  const myLookingForTokens = profile.searchTokens || [];

  const now = Date.now();
  const peers = [...state.discovered[ns].values()]
    .filter((p) => now - (p.lastSeen || 0) < PEER_TTL_MS)
    .filter((p) => !state.blocked[ns].has(p.sender));

  const hardConstraints = { requiredLanguages: profile.languages };
  if (cfg.kind === 'twoSided') hardConstraints.requiredRole = complementaryRole(ns, id.role);
  const softConstraints = { preferredCategory: profile.category };
  const isSupplySide = cfg.kind === 'twoSided' && id.role === cfg.roles[0].key;
  if (ns === 'employment') {
    softConstraints.country = profile.country;
    softConstraints.city = profile.city;
    if (!isSupplySide && (profile.seniorityMin != null || profile.seniorityMax != null)) {
      hardConstraints.seniorityRange = { min: profile.seniorityMin, max: profile.seniorityMax };
    }
    if (isSupplySide && profile.earliestYear != null) {
      hardConstraints.myEarliestYear = profile.earliestYear;
    }
  } else if (ns === 'business' || ns === 'independant') {
    softConstraints.country = profile.country;
    softConstraints.city = profile.city;
    if (!isSupplySide && (profile.budgetMin != null || profile.budgetMax != null)) {
      hardConstraints.rateRange = { min: profile.budgetMin, max: profile.budgetMax };
    }
    if (isSupplySide && profile.rate != null) {
      hardConstraints.myRate = profile.rate;
    }
  }

  const cascade = discovery.runCascade(peers, {
    myNamespace: ns,
    protocolVersion: PROTOCOL_VERSION,
    hardConstraints,
    softConstraints,
  });

  const scored = cascade.pool
    .map((p) => ({ ...p, match: scoreAgainstPeer(cfg, myTokens, myLookingForTokens, p) }))
    .sort((a, b) => b.match.score - a.match.score);

  const localMatches = await localTestMatches(ns, cfg, id, myTokens, myLookingForTokens);

  const funnelHtml = cascade.stages.map((s, i) => `
      <div class="stage"><div class="n">${s.count}</div><div class="lbl">${s.label}</div></div>
      ${i < cascade.stages.length - 1 ? '<div class="arrow">→</div>' : ''}
    `).join('');

  const myRoleLabel = id.role ? roleLabel(ns, id.role) : null;
  const theirRoleLabel = cfg.kind === 'twoSided' ? roleLabel(ns, complementaryRole(ns, id.role)) : null;

  function metaChips(p) {
    if (ns === 'employment') {
      return `
        <span class="chip">${[p.city, p.country].filter(Boolean).join(', ') || 'no location declared'}</span>
        ${isSupplySide && p.postingText ? `<span class="chip">${p.seniorityMin ?? '…'}–${p.seniorityMax ?? '…'} yrs range</span>` : ''}
        ${!isSupplySide ? `<span class="chip">${p.earliestYear ? 'earliest year ' + p.earliestYear : 'no dates detected'}</span><span class="chip">${p.availableNow ? 'Available now' : 'Availability unknown'}</span>` : ''}
      `;
    }
    if (ns === 'business' || ns === 'independant') {
      return `
        <span class="chip">${[p.city, p.country].filter(Boolean).join(', ') || 'no location declared'}</span>
        ${isSupplySide && p.postingText ? `<span class="chip">budget ${p.budgetMin ?? '…'}–${p.budgetMax ?? '…'}</span>` : ''}
        ${!isSupplySide ? `<span class="chip">${p.rate != null ? 'rate ' + p.rate : 'no rate declared'}</span><span class="chip">${p.availableNow ? 'Available now' : 'Availability unknown'}</span>` : ''}
      `;
    }
    return `
      <span class="chip">${(p.languages || []).join(' / ') || 'no language declared'}</span>
      <span class="chip">${p.availableNow ? 'Available now' : 'Availability unknown'}</span>
    `;
  }

  function renderCard(p, { local = false } = {}) {
    const ex = explainMatch(cfg, p.match);
    const chat = local ? null : state.pendingChats[ns].get(p.sender);
    const meeting = local ? null : state.pendingMeetings[ns].get(p.sender);
    const doc = local ? null : state.pendingDocs[ns].get(p.sender);
    const meetingHtml = meeting ? `
        <div class="meeting-banner">
          ${meeting.status === 'incoming'
            ? `Proposed meeting: <b>${meeting.when}</b>${meeting.note ? ` — ${meeting.note}` : ''}
               <button class="btn small primary meeting-yes">Accept</button>
               <button class="btn small meeting-no">Decline</button>`
            : meeting.status === 'accepted'
              ? `Meeting confirmed: <b>${meeting.when}</b>`
              : `Meeting proposed, awaiting reply: <b>${meeting.when}</b>`}
        </div>` : '';
    const docHtml = doc ? `
        <div class="meeting-banner">
          ${doc.status === 'incoming'
            ? `They requested your ${doc.doc.replace('_', ' ')}.
               <button class="btn small primary doc-share" data-doc="${doc.doc}">Share</button>
               <button class="btn small doc-decline">Decline</button>`
            : doc.status === 'outgoing'
              ? `Requested their ${doc.doc.replace('_', ' ')}, awaiting reply…`
              : doc.status === 'shared'
                ? `You shared your ${doc.doc.replace('_', ' ')}.`
                : `Received their ${doc.doc.replace('_', ' ')}: <button class="btn small ghost view-doc">View</button>`}
        </div>` : '';
    const postingPreview = (isSupplySide && p.postingText)
      ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:11.5px;color:var(--low)">View ${ns === 'employment' ? 'posting' : 'request'} text</summary><div style="font-size:12px;color:var(--mid);white-space:pre-wrap;margin-top:6px">${p.postingText}</div></details>` : '';

    return `
        <div class="card" data-peer="${p.peerId || ''}" data-identity="${p.sender}">
          <div class="top">
            <span class="avatar">${(p.category || 'PR').slice(0, 2).toUpperCase()}</span>
            <div class="info">
              <div class="name">${local ? (p.displayName || 'Local test identity') : p.sender.slice(0, 10) + '…'}${theirRoleLabel ? ` <span class="role-badge">${theirRoleLabel}</span>` : ''}${local ? ' <span class="role-badge" style="color:var(--low);border-color:var(--border)">local test</span>' : ''}</div>
              <div class="role">${p.category || 'No category declared'}</div>
              <div class="meta">${metaChips(p)}</div>
            </div>
            <div class="score">
              <div class="pct">${p.match.score}%</div>
              <div class="bar"><i style="width:${p.match.score}%"></i></div>
            </div>
          </div>
          <div class="expl">${ex.pos.map((t) => `<div class="p">${t}</div>`).join('')}${ex.neg.map((t) => `<div class="m">${t}</div>`).join('')}</div>
          ${postingPreview}
          ${meetingHtml}
          ${docHtml}
          <div class="actions">
            <button class="btn ghost toggle-expl">Why this score</button>
            ${local ? '' : (chat && chat.status === 'incoming'
              ? `<button class="btn primary respond-yes">Accept chat</button><button class="btn respond-no">Decline</button>`
              : chat && chat.status === 'accepted'
                ? `<button class="btn primary open-chat">Open chat</button><button class="btn ghost propose-meeting">Propose meeting</button>`
                : chat && chat.status === 'outgoing'
                  ? `<button class="btn" disabled>Request sent…</button>`
                  : `<button class="btn primary request-chat">Start conversation</button>`)}
            ${!local && ns === 'employment' && id.role === 'recruiter' && !doc ? `<button class="btn ghost request-doc" data-doc="cover_letter">Request cover letter</button>` : ''}
            ${local ? '' : `<button class="btn ghost block-peer">Block</button>`}
          </div>
        </div>`;
  }

  const resultsHtml = scored.length === 0
    ? `<div class="empty-state">No ${theirRoleLabel ? theirRoleLabel.toLowerCase() + ' ' : ''}peers discovered yet on this namespace.<br>Open Jobber in another browser tab, device, or share this build with someone else — discovery is real WebRTC, it just needs a second peer.</div>`
    : scored.map((p) => renderCard(p)).join('');

  const localHtml = localMatches.length ? `
    <div class="k" style="margin:18px 0 8px">Local test matches</div>
    <p class="section-sub" style="margin-bottom:10px">Other ${theirRoleLabel || ''} identities you created in this browser — useful to sanity-check matching without a second device. These never go over the network.</p>
    <div class="results">${localMatches.map((p) => renderCard(p, { local: true })).join('')}</div>
  ` : '';

  const chatPeer = state.openChatWith[ns];
  if (chatPeer) await loadConversation(ns, chatPeer); // defensive — most entry points already hydrate before opening
  const chatHtml = chatPeer ? renderChatPanel(ns, id, chatPeer) : '';

  const conversations = await listConversations(ns);
  const conversationsHtml = conversations.length ? `
    <div class="panel">
      <div class="k">Conversations</div>
      ${conversations.map((c) => {
        const online = state.identityToPeer[ns].has(c.counterpart);
        const preview = c.kind === 'attachment' ? `📎 ${c.name}` : (c.text || '').slice(0, 60);
        return `
          <div class="agree-row">
            <span class="k2">
              <span class="online-dot ${online ? 'on' : ''}" style="margin-right:6px"></span>
              ${c.counterpart.slice(0, 10)}… — ${preview}
            </span>
            <button class="btn small ghost conv-open" data-identity="${c.counterpart}">Open</button>
          </div>`;
      }).join('')}
    </div>` : '';

  return `
    <h2 class="section-title">${cfg.label}${myRoleLabel ? ` — ${myRoleLabel}` : ''} — ${state.searchLive[ns] ? 'searching live' : 'search paused'}</h2>
    <p class="section-sub">${cfg.hint}</p>

    <div class="panel">
      <div class="k">Your profile${myRoleLabel ? ` (${myRoleLabel})` : ''}</div>
      <div>${profile.category ? `<b>${profile.category}</b>` : '<span style="color:var(--low)">No category set</span>'}</div>
      ${ns === 'employment' || ns === 'business' || ns === 'independant' ? `<div style="font-size:11.5px;color:var(--low);margin-top:2px">${[profile.city, profile.country].filter(Boolean).join(', ') || 'No location set'}${(ns === 'business' || ns === 'independant') ? (isSupplySide ? (profile.rate != null ? ` · rate ${profile.rate}` : '') : ((profile.budgetMin != null || profile.budgetMax != null) ? ` · budget ${profile.budgetMin ?? '…'}–${profile.budgetMax ?? '…'}` : '')) : ''}</div>` : ''}
      <div class="chiprow">
        ${profile.tokens.slice(0, 10).map((t) => `<span class="chip">${t}</span>`).join('')}
        ${(state.aiOn[ns] ? profile.aiTokens : []).slice(0, 10).map((t) => `<span class="chip ai">◆ ${t}</span>`).join('')}
        ${!profile.tokens.length && !profile.aiTokens.length ? '<span style="color:var(--low);font-size:11px">No keywords extracted yet</span>' : ''}
      </div>
      ${cfg.kind === 'reciprocal' ? `
        <div class="k" style="margin-top:10px">Looking for</div>
        <div class="chiprow">
          ${myLookingForTokens.slice(0, 10).map((t) => `<span class="chip" style="border-color:var(--agent);color:var(--agent)">${t}</span>`).join('')}
          ${!myLookingForTokens.length ? '<span style="color:var(--low);font-size:11px">Not set yet</span>' : ''}
        </div>` : ''}
      <div class="actions" style="margin-top:12px">
        <button class="btn" id="editProfile">Edit profile</button>
        <button class="btn" id="enrichAI">Enrich with local AI</button>
      </div>
    </div>

    ${chatHtml}
    ${!chatPeer ? conversationsHtml : ''}
    <div class="funnel">${funnelHtml}</div>
    <div class="results">${resultsHtml}</div>
    ${localHtml}
  `;
}

export function bindClassicEvents(ns) {
  const id = state.identitiesByNs[ns].find((i) => i.identityId === state.activeIdentityId[ns]);
  const ws = document.getElementById('workspace');

  ws.querySelector('#createHere')?.addEventListener('click', () => createIdentityFlow(ns));
  ws.querySelector('#editProfile')?.addEventListener('click', () => {
    if (ns === 'employment') editEmploymentProfileFlow(id);
    else if (ns === 'business' || ns === 'independant') editSupplyDemandProfileFlow(ns, id);
    else editProfileFlow(ns, id);
  });
  ws.querySelector('#enrichAI')?.addEventListener('click', () => enrichProfileWithAI(ns, id));

  ws.querySelectorAll('.toggle-expl').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.card');
      card.classList.toggle('open');
      btn.textContent = card.classList.contains('open') ? 'Hide explanation' : 'Why this score';
    });
  });
  ws.querySelectorAll('.request-chat').forEach((btn) => {
    btn.addEventListener('click', () => requestChat(ns, id, btn.closest('.card').dataset.identity));
  });
  ws.querySelectorAll('.respond-yes').forEach((btn) => {
    btn.addEventListener('click', () => respondChat(ns, id, btn.closest('.card').dataset.identity, true));
  });
  ws.querySelectorAll('.respond-no').forEach((btn) => {
    btn.addEventListener('click', () => respondChat(ns, id, btn.closest('.card').dataset.identity, false));
  });
  ws.querySelectorAll('.open-chat').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const theirIdentityId = btn.closest('.card').dataset.identity;
      await loadConversation(ns, theirIdentityId);
      state.openChatWith[ns] = theirIdentityId;
      state.render.workspace();
    });
  });
  ws.querySelectorAll('.propose-meeting').forEach((btn) => {
    btn.addEventListener('click', () => proposeMeetingFlow(ns, id, btn.closest('.card').dataset.identity));
  });
  ws.querySelectorAll('.meeting-yes').forEach((btn) => {
    btn.addEventListener('click', () => respondMeeting(ns, id, btn.closest('.card').dataset.identity, true));
  });
  ws.querySelectorAll('.meeting-no').forEach((btn) => {
    btn.addEventListener('click', () => respondMeeting(ns, id, btn.closest('.card').dataset.identity, false));
  });
  ws.querySelectorAll('.block-peer').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.card');
      blockPeer(ns, card.dataset.identity, card.querySelector('.name')?.textContent);
    });
  });
  ws.querySelectorAll('.request-doc').forEach((btn) => {
    btn.addEventListener('click', () => requestDocument(ns, id, btn.closest('.card').dataset.identity, btn.dataset.doc));
  });
  ws.querySelectorAll('.doc-share').forEach((btn) => {
    btn.addEventListener('click', () => shareDocument(ns, id, btn.closest('.card').dataset.identity, btn.dataset.doc));
  });
  ws.querySelectorAll('.doc-decline').forEach((btn) => {
    btn.addEventListener('click', () => declineDocument(ns, btn.closest('.card').dataset.identity));
  });
  ws.querySelectorAll('.view-doc').forEach((btn) => {
    btn.addEventListener('click', () => {
      const theirIdentityId = btn.closest('.card').dataset.identity;
      const doc = state.pendingDocs[ns].get(theirIdentityId);
      openModal(doc.doc.replace('_', ' '), `<div style="white-space:pre-wrap;font-size:13px;color:var(--hi)">${doc.text}</div>`, { submitLabel: 'Close' });
    });
  });
  ws.querySelectorAll('.conv-open').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await loadConversation(ns, btn.dataset.identity);
      state.openChatWith[ns] = btn.dataset.identity;
      state.render.workspace();
    });
  });
  ws.querySelector('#closeChat')?.addEventListener('click', () => { state.openChatWith[ns] = null; state.render.workspace(); });
  ws.querySelectorAll('.attach-accept').forEach((btn) => {
    btn.addEventListener('click', () => respondAttachmentOffer(ns, id, btn.dataset.offer, true));
  });
  ws.querySelectorAll('.attach-decline').forEach((btn) => {
    btn.addEventListener('click', () => respondAttachmentOffer(ns, id, btn.dataset.offer, false));
  });

  const sendBtn = ws.querySelector('#chatSend');
  if (sendBtn) {
    const input = ws.querySelector('#chatInput');
    const fire = () => { sendChatMessage(ns, id, state.openChatWith[ns], input.value); input.value = ''; };
    sendBtn.addEventListener('click', fire);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') fire(); });
    ws.querySelector('#chatFile')?.addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) proposeAttachment(ns, id, state.openChatWith[ns], f);
    });
    const log = ws.querySelector('#chatLog');
    if (log) log.scrollTop = log.scrollHeight;
  }
}
