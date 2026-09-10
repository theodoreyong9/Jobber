// discovery-ui.js — Search Live, the matching cascade, and the results
// cards for every non-Research namespace. Imports profiles.js and
// conversations.js directly (safe, one-directional); reaches
// message-router.js and render.js only through `state.handlers` /
// `state.render` to avoid a circular import — see state.js's header.

import * as p2p from './p2p.js';
import * as db from './db.js';
import * as discovery from './discovery.js';
import * as matching from './matching.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { state, NS_CONFIG, PEER_TTL_MS, roleLabel, complementaryRole, canInitiateChat } from './state.js';
import { openModal, toast } from './ui-kit.js';
import { createIdentityFlow } from './identity-ui.js';
import { getProfile } from './profiles.js';
import {
  blockPeer, proposeMeetingFlow, respondMeeting, requestDocument, shareDocument, declineDocument,
  loadConversation, listConversations, persistMessage, requestChat, respondChat, sendChatMessage,
  renderChatPanel, proposeAttachment, respondAttachmentOffer,
} from './conversations.js';

// Shared by the onPeerJoin handshake below and rebroadcastDiscovery — one
// place that decides exactly what a namespace/role combination reveals.
async function buildDiscoveryPayload(ns, id, profile) {
  const cfg = NS_CONFIG[ns];
  const payload = {
    category: profile.category,
    // Sent as two separate fields, not merged — losing the CPU/AI
    // distinction on the wire would make it impossible for a receiver (in
    // particular, Agent's cross-referencing) to know whether a match
    // needed AI enrichment or was pure-CPU all along.
    tokens: profile.tokens.slice(0, 30),
    aiTokens: profile.aiTokens.slice(0, 30),
    languages: profile.languages,
    availableNow: profile.availableNow,
  };
  // Near mode's opt-in location is a device-level fact, not owned by any
  // one namespace's profile — it piggybacks on whichever discovery
  // broadcast is already going out, rather than Near making its own.
  if (state.nearLocationEnabled && state.nearCoords) {
    payload.lat = state.nearCoords.lat;
    payload.lon = state.nearCoords.lon;
  }
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
    } else if (ns === 'business' || ns === 'independant' || ns === 'annonce' || ns === 'drive') {
      if (isSupply) {
        payload.rate = profile.rate;
        if (ns === 'annonce' && profile.photoDataUrl) payload.photoDataUrl = profile.photoDataUrl; // already resized to a small thumbnail
      } else {
        payload.budgetMin = profile.budgetMin;
        payload.budgetMax = profile.budgetMax;
        payload.postingText = profile.sourceText; // the request/mission text is public
      }
    } else if (ns === 'outdoor') {
      if (isSupply) {
        // Unlike Employment/Business, it's the supply side (the organizer)
        // whose text participants actually want to read — so postingText
        // travels the opposite direction here. Contact info is shown
        // directly, not gated behind a request/consent flow the way a CV
        // or cover letter is: the whole point of posting is to be reachable.
        payload.postingText = profile.sourceText;
        payload.contactType = profile.contactType;
        payload.contactValue = profile.contactValue;
        payload.participantLimit = profile.participantLimit;
      }
    }
  }
  return payload;
}

// Re-sends discovery to everyone *already* connected — not just future
// joiners. Without this, enriching your profile with local AI (or any
// other profile edit) only reached peers who hadn't joined yet; anyone
// already in the room kept seeing your old keywords until they reconnected.
export async function rebroadcastDiscovery(ns) {
  const room = p2p.getRoom(ns);
  if (!room) return;
  const id = state.identitiesByNs[ns].find((i) => i.identityId === state.activeIdentityId[ns]);
  if (!id) return;
  const profile = await getProfile(id.identityId);
  const payload = await buildDiscoveryPayload(ns, id, profile);
  room.send('discovery', id.identityId, payload); // no target = broadcast to the whole room
}

// Connects or disconnects Search Live for a namespace outright (as opposed
// to toggling from whatever the current state happens to be) — this is
// what both the manual toggle and the auto-resume-on-boot path call, so
// there's exactly one place that actually joins/leaves the P2P room.
export async function setSearchLive(ns, desired) {
  state.searchLive[ns] = desired;
  db.put('cache', { key: `searchLive:${ns}`, value: desired }); // survives reload — see app.js's boot()
  const id = state.identitiesByNs[ns].find((i) => i.identityId === state.activeIdentityId[ns]);
  if (desired) {
    if (!id) { state.searchLive[ns] = false; return; }
    try {
      await p2p.joinNamespaceRoom(ns, {
        onPeerJoin: async (peerId) => {
          const profile = await getProfile(id.identityId);
          const payload = await buildDiscoveryPayload(ns, id, profile);
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
          if (metadata.forMessageId) {
            // Bytes catching up to a metadata record that arrived earlier
            // via conversation resync — attach to that exact record
            // (same messageId) rather than creating a duplicate entry.
            db.get('messages', metadata.forMessageId).then((existing) => {
              if (!existing) return;
              existing.blob = blob;
              db.put('messages', existing).then(() => {
                state.loadedConversations[ns].delete(theirIdentityId);
                if (state.openChatWith[ns] === theirIdentityId) state.render.workspace();
              });
            });
            return;
          }
          const entry = {
            messageId: metadata.offerId, // shared with the sender's own copy — see message-router.js's attachment_accept
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

export async function toggleSearchLive(ns) {
  await setSearchLive(ns, !state.searchLive[ns]);
}
state.handlers.toggleSearchLive = toggleSearchLive; // identity-ui.js's topbar calls this indirectly
state.handlers.rebroadcastDiscovery = rebroadcastDiscovery; // same reason — the enrich control lives in the topbar now

export function scoreAgainstPeer(cfg, myTokens, myLookingForTokens, p) {
  const peerTokens = [...(p.tokens || []), ...(p.aiTokens || [])]; // tokens/aiTokens travel separately on the wire now — see buildDiscoveryPayload
  if (cfg.kind === 'reciprocal') {
    const forward = matching.matchTokens(myLookingForTokens, peerTokens);   // does their profile fit what I want
    const backward = matching.matchTokens(p.searchTokens || [], myTokens);       // does my profile fit what they want
    return { score: Math.min(forward.score, backward.score), forward, backward };
  }
  return matching.matchTokens(myTokens, peerTokens);
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
      tokens: p2.tokens, aiTokens: p2.aiTokens, searchTokens: p2.searchTokens,
      country: p2.country, city: p2.city, earliestYear: p2.earliestYear,
      seniorityMin: p2.seniorityMin, seniorityMax: p2.seniorityMax,
      rate: p2.rate, budgetMin: p2.budgetMin, budgetMax: p2.budgetMax,
      postingText: p2.jobPostingText || p2.sourceText, photoDataUrl: p2.photoDataUrl,
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
  const myTokens = [...profile.tokens, ...profile.aiTokens];
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
  } else if (ns === 'business' || ns === 'independant' || ns === 'annonce' || ns === 'drive') {
    softConstraints.country = profile.country;
    softConstraints.city = profile.city;
    if (!isSupplySide && (profile.budgetMin != null || profile.budgetMax != null)) {
      hardConstraints.rateRange = { min: profile.budgetMin, max: profile.budgetMax };
    }
    if (isSupplySide && profile.rate != null) {
      hardConstraints.myRate = profile.rate;
    }
  } else if (ns === 'outdoor') {
    // No numeric range to hard-filter on (no rate/budget equivalent) —
    // matching is pure keyword overlap between theme and interests, same
    // as every namespace's baseline. Location is still worth soft-ranking.
    softConstraints.country = profile.country;
    softConstraints.city = profile.city;
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

  const theirRoleLabel = cfg.kind === 'twoSided' ? roleLabel(ns, complementaryRole(ns, id.role)) : null;

  function metaChips(p) {
    if (ns === 'employment') {
      return `
        <span class="chip">${[p.city, p.country].filter(Boolean).join(', ') || 'no location declared'}</span>
        ${isSupplySide && p.postingText ? `<span class="chip">${p.seniorityMin ?? '…'}–${p.seniorityMax ?? '…'} yrs range</span>` : ''}
        ${!isSupplySide ? `<span class="chip">${p.earliestYear ? 'earliest year ' + p.earliestYear : 'no dates detected'}</span><span class="chip">${p.availableNow ? 'Available now' : 'Availability unknown'}</span>` : ''}
      `;
    }
    if (ns === 'business' || ns === 'independant' || ns === 'annonce' || ns === 'drive') {
      const priceWord = ns === 'annonce' ? 'price' : 'rate';
      return `
        <span class="chip">${[p.city, p.country].filter(Boolean).join(', ') || 'no location declared'}</span>
        ${isSupplySide && p.postingText ? `<span class="chip">budget ${p.budgetMin ?? '…'}–${p.budgetMax ?? '…'}</span>` : ''}
        ${!isSupplySide ? `<span class="chip">${p.rate != null ? priceWord + ' ' + p.rate : 'no ' + priceWord + ' declared'}</span><span class="chip">${p.availableNow ? (ns === 'annonce' ? 'Still available' : 'Available now') : 'Availability unknown'}</span>` : ''}
      `;
    }
    if (ns === 'outdoor') {
      const contactIcon = p.contactType === 'phone' ? '📞' : p.contactType === 'other' ? '✉️' : '📧';
      return `
        <span class="chip">${[p.city, p.country].filter(Boolean).join(', ') || 'no location declared'}</span>
        ${!isSupplySide && p.contactValue ? `<span class="chip">${contactIcon} ${p.contactValue}</span>` : ''}
        ${!isSupplySide && p.participantLimit != null ? `<span class="chip">Max ${p.participantLimit} participants</span>` : ''}
        <span class="chip">${p.availableNow ? (isSupplySide ? 'Available now' : 'Still open') : 'Availability unknown'}</span>
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
    // Outdoor is the one namespace where it's the supply side (organizer)
    // whose text is worth previewing, not the demand side — see
    // buildDiscoveryPayload's comment for why postingText travels the
    // opposite direction there.
    const previewFromSupplySide = ns !== 'outdoor';
    const postingPreview = ((previewFromSupplySide ? isSupplySide : !isSupplySide) && p.postingText)
      ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:11.5px;color:var(--low)">View ${ns === 'employment' ? 'posting' : ns === 'outdoor' ? 'activity' : 'request'} text</summary><div style="font-size:12px;color:var(--mid);white-space:pre-wrap;margin-top:6px">${p.postingText}</div></details>` : '';

    return `
        <div class="card" data-peer="${p.peerId || ''}" data-identity="${p.sender}">
          <div class="top">
            ${p.photoDataUrl ? `<img class="avatar-photo" src="${p.photoDataUrl}" alt="">` : `<span class="avatar">${(p.category || 'PR').slice(0, 2).toUpperCase()}</span>`}
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
                  : canInitiateChat(ns, id.role)
                    ? `<button class="btn primary request-chat">Start conversation</button>`
                    : `<span style="font-size:11.5px;color:var(--low);align-self:center">They can reach out to start a conversation</span>`)}
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
