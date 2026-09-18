// discovery-ui.js — Search Live, the matching cascade, and the results
// cards for every non-Research namespace. Imports profiles.js and
// conversations.js directly (safe, one-directional); reaches
// message-router.js and render.js only through `state.handlers` /
// `state.render` to avoid a circular import — see state.js's header.

import * as p2p from './p2p.js';
import * as db from './db.js';
import * as discovery from './discovery.js';
import * as matching from './matching.js';
import * as credibility from './credibility.js';
import * as marks from './marks.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { state, NAMESPACES, NS_CONFIG, PEER_TTL_MS, roleLabel, complementaryRole, canInitiateChat, setActiveNamespace } from './state.js';
import { toast } from './ui-kit.js';
import { createIdentityFlow } from './identity-ui.js';
import { getProfile } from './profiles.js';
import {
  proposeMeetingFlow, respondMeeting, renderDocumentButtonsHtml, bindDocumentButtons,
  persistMessage, requestChat, respondChat,
} from './conversations.js';

// Shared by the onPeerJoin handshake below and rebroadcastDiscovery — one
// place that decides exactly what a namespace/role combination reveals.
async function buildDiscoveryPayload(ns, id, profile) {
  const cfg = NS_CONFIG[ns];
  const payload = {
    // Without this, a real remote peer's card had nothing but its
    // identityId to show (renderCard's own fallback is
    // `${p.sender.slice(0, 10)}…`) — displayName was never on the wire at
    // all, only ever present for same-browser localTestMatches (which
    // builds its peerLike straight from the local identity record). Every
    // discovery-carrying send (onPeerJoin's initial one and
    // rebroadcastDiscovery's periodic one) picks up a rename automatically
    // since both re-read the profile/identity fresh each time.
    displayName: id.displayName,
    category: profile.category,
    // Sent as two separate fields, not merged — losing the CPU/AI
    // distinction on the wire would make it impossible for a receiver (in
    // particular, Agent's cross-referencing) to know whether a match
    // needed AI enrichment or was pure-CPU all along.
    tokens: profile.tokens.slice(0, 30),
    aiTokens: profile.aiTokens.slice(0, 30),
    languages: profile.languages,
    availableNow: profile.availableNow,
    // Unconditional, unlike every other field below this point — either
    // side of any namespace can set one (see profiles.js's
    // secretCodeFieldHtml), and it overrides all of them once both sides
    // agree on the same value (see hardFilter/scoreAgainstPeer).
    secretCode: profile.secretCode,
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
    } else if (ns === 'business') {
      if (isSupply) {
        payload.rate = profile.rate;
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
    } else if (ns === 'info') {
      // Same direction as Outdoor: the supply side (Source) has the actual
      // content — the whole point is for Seekers to be able to read it.
      // No extra fields beyond that; matching is pure keyword overlap,
      // same baseline as Dating/generic, no hard-filterable range.
      if (isSupply) payload.postingText = profile.sourceText;
    } else if (ns === 'wallet' || ns === 'creator') {
      // Same direction as Info: the Address holder's description is the
      // whole point, meant to be read by Seekers. addressType/exactAddress
      // only travel from the Address side — a Seeker's own exactAddress
      // (if any) is a local filter on THEIR side (see renderClassicWorkspace's
      // requiredExactAddress), never broadcast.
      if (isSupply) {
        payload.postingText = profile.sourceText;
        payload.addressType = profile.addressType;
        payload.exactAddress = profile.exactAddress;
      }
    }
  }
  return payload;
}

// Re-sends discovery to everyone *already* connected — not just future
// joiners. Without this, enriching your profile with local AI (or any
// other profile edit) only reached peers who hadn't joined yet; anyone
// already in the room kept seeing your old keywords until they reconnected.
export async function rebroadcastDiscovery(ns, identityId) {
  const room = p2p.getRoom(ns);
  if (!room) return;
  const id = state.identitiesByNs[ns].find((i) => i.identityId === identityId);
  if (!id) return;
  const profile = await getProfile(id.identityId);
  const payload = await buildDiscoveryPayload(ns, id, profile);
  room.send('discovery', id.identityId, payload); // no target = broadcast to the whole room
}

// The credibility filter (renderClassicWorkspace) is a display-only
// convenience, not something worth a persisted preference — kept as
// plain in-memory state per namespace so it survives a re-render (e.g.
// a new peer arriving) but resets, like the "why these scores"
// explanation toggle already does, on reload.
const credFilterByNs = {};

// A blob's own metadata (offerId) is enough to find which of my live
// identities it belongs to — offer ids are random per-handshake and only
// ever pending on the one identity that received that particular offer.
function findLiveIdentityForOffer(ns, offerId) {
  for (const myIdentityId of state.searchLive[ns] || []) {
    if (state.pendingAttachmentOffers[ns].get(myIdentityId)?.has(offerId)) return myIdentityId;
  }
  return null;
}

// Same idea for a document's CV bytes, which arrive separately from the
// document_offer that describes them (see conversations.js's shareDocument)
// — matched by the original request's id, which the outgoing/received entry
// keeps regardless of which of those two states it's in when the blob lands.
function findPendingDocByRequestId(ns, requestId) {
  for (const myIdentityId of state.searchLive[ns] || []) {
    for (const [theirIdentityId, byDoc] of state.pendingDocs[ns].get(myIdentityId) || []) {
      for (const [docType, d] of byDoc) {
        if (d.requestId === requestId) return { myIdentityId, theirIdentityId, docType, byDoc };
      }
    }
  }
  return null;
}

// Connects or disconnects Search Live for one identity in a namespace
// (as opposed to toggling from whatever its current state happens to be)
// — this is what both the manual toggle and the auto-resume-on-boot path
// call. More than one identity in the same namespace can be live at
// once now (see state.js's searchLive) — they all share the one P2P room
// p2p.js maintains per namespace.
export async function setSearchLive(ns, identityId, desired) {
  const id = state.identitiesByNs[ns].find((i) => i.identityId === identityId);
  if (!id) return;
  db.put('cache', { key: `searchLive:${ns}:${identityId}`, value: desired }); // survives reload — see app.js's boot()
  if (desired) {
    try {
      await p2p.joinNamespaceRoom(ns, identityId, {
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
          if (metadata.doc === 'cv') {
            const found = findPendingDocByRequestId(ns, metadata.docRequestId);
            if (!found) return; // no live identity of mine is still waiting on this request
            found.byDoc.set(found.docType, { ...found.byDoc.get(found.docType), cvUrl: URL.createObjectURL(blob) });
            state.render.workspace();
            return;
          }
          if (metadata.forMessageId) {
            // Bytes catching up to a metadata record that arrived earlier
            // via conversation resync — attach to that exact record
            // (same messageId) rather than creating a duplicate entry.
            // The record itself already says which of my identities it's
            // mine under (persistMessage's `mine` field).
            db.get('messages', metadata.forMessageId).then((existing) => {
              if (!existing) return;
              existing.blob = blob;
              db.put('messages', existing).then(() => {
                const myIdentityId = existing.mine;
                if (!myIdentityId) return;
                state.loadedConversations[ns].get(myIdentityId)?.delete(theirIdentityId);
                if (state.openChatWith[ns].get(myIdentityId) === theirIdentityId) state.render.workspace();
              });
            });
            return;
          }
          const myIdentityId = findLiveIdentityForOffer(ns, metadata.offerId);
          if (!myIdentityId) return; // no live identity of mine has this offer pending
          const entry = {
            messageId: metadata.offerId, // shared with the sender's own copy — see message-router.js's attachment_accept
            from: 'them', kind: 'attachment', ts: Date.now(),
            name: metadata.name || 'file', size: blob.size, url: URL.createObjectURL(blob),
          };
          const log = state.chatLog[ns].get(myIdentityId);
          if (!log.has(theirIdentityId)) log.set(theirIdentityId, []);
          log.get(theirIdentityId).push(entry);
          state.loadedConversations[ns].get(myIdentityId).add(theirIdentityId);
          persistMessage(ns, myIdentityId, theirIdentityId, { ...entry, url: undefined, blob });
          toast(`Received attachment: ${metadata.name || 'file'}`);
          state.render.workspace();
        },
      });
      state.searchLive[ns].add(identityId);
    } catch (e) {
      toast('P2P networking unavailable: ' + e.message);
      state.searchLive[ns].delete(identityId);
    }
  } else {
    p2p.leaveIdentityFromRoom(ns, identityId);
    state.searchLive[ns].delete(identityId);
    // The discovered pool is shared by every identity live in this
    // namespace — only clear it once the *last* one stops, or stopping
    // one identity would blind every other identity still searching.
    if (state.searchLive[ns].size === 0) state.discovered[ns].clear();
  }
  state.render.all();
}

export async function toggleSearchLive(ns, identityId) {
  await setSearchLive(ns, identityId, !state.searchLive[ns]?.has(identityId));
}

// Confirmed by reading the pinned @trystero-p2p/core@0.25.4 source directly
// (its utils.mjs): the relay WebSocket's own reconnect logic backs off
// exponentially and, once that backoff period reaches ~60s, gives up and
// marks itself permanently closed — no further reconnect attempts, ever,
// for the rest of the page's lifetime. That's the actual mechanism behind
// "I have to reload the page before the other side sees me again": a relay
// connection quietly dies (very commonly from a mobile tab being
// backgrounded, or any sustained network blip) and Trystero itself never
// tries it again. The only thing that creates a fresh socket is a brand new
// room join — so this leaves every live identity's room and rejoins it,
// exactly what a page reload does for the P2P layer, without losing any
// other app state (identities/profiles/discovered peers are untouched).
// Bypasses setSearchLive's own `false` path deliberately: that path also
// clears state.discovered once the last identity in a namespace stops,
// which would wipe an already-healthy discovered-peers list just because
// this ran — not desired for an internal connectivity refresh.
export async function cycleLiveRooms() {
  for (const ns of NAMESPACES) {
    const live = state.searchLive[ns];
    if (!(live instanceof Set) || live.size === 0) continue;
    const ids = [...live];
    for (const identityId of ids) p2p.leaveIdentityFromRoom(ns, identityId);
    for (const identityId of ids) await setSearchLive(ns, identityId, true);
  }
}
state.handlers.toggleSearchLive = toggleSearchLive; // identity-ui.js's topbar calls this indirectly
state.handlers.rebroadcastDiscovery = rebroadcastDiscovery; // same reason — the enrich control lives in the topbar now

export function scoreAgainstPeer(cfg, myTokens, myLookingForTokens, p, mySecretCode = null) {
  // Overrides everything below, the same escape hatch as hardFilter's own
  // (see matching.secretCodesMatch) — a shared secret code means this
  // peer isn't just eligible, it's THE match, full score, regardless of
  // what matching.matchTokens would otherwise have said.
  if (matching.secretCodesMatch(mySecretCode, p.secretCode)) {
    return { score: 100, engineVersion: matching.MATCHING_ENGINE_VERSION, matchedKeywords: [], missingRequired: [], secretCodeMatch: true };
  }
  const peerTokens = [...(p.tokens || []), ...(p.aiTokens || [])]; // tokens/aiTokens travel separately on the wire now — see buildDiscoveryPayload
  if (cfg.kind === 'reciprocal') {
    const forward = matching.matchTokens(myLookingForTokens, peerTokens);   // does their profile fit what I want
    const backward = matching.matchTokens(p.searchTokens || [], myTokens);       // does my profile fit what they want
    return { score: Math.min(forward.score, backward.score), forward, backward };
  }
  return matching.matchTokens(myTokens, peerTokens);
}

export function explainMatch(cfg, match) {
  if (match.secretCodeMatch) return { pos: ['Secret code match — you agreed on this directly.'], neg: [] };
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

// WebRTC can't connect a browser tab to itself, so two identities created
// in the same browser (any tab) never discover each other over the real
// network — this computes the same match directly from local data instead.
// Merged straight into the same results list as real peers (see
// renderClassicWorkspace): no separate "local" treatment, no badge, same
// card, same actions — an identity is an identity.
async function localTestMatches(ns, cfg, id, myTokens, myLookingForTokens, mySecretCode) {
  if (cfg.kind === 'research') return [];
  const wantRole = cfg.kind === 'twoSided' ? complementaryRole(ns, id.role) : null;
  const candidates = state.identitiesByNs[ns].filter((other) =>
    other.identityId !== id.identityId && other.active
  );
  const out = [];
  for (const other of candidates) {
    const p2 = await getProfile(other.identityId);
    // A shared secret code bypasses the role filter too, same as the real
    // peer path's hardFilter — otherwise same-browser testing couldn't
    // even exercise the one case (two same-role identities) it's for.
    if (cfg.kind === 'twoSided' && other.role !== wantRole && !matching.secretCodesMatch(mySecretCode, p2.secretCode)) continue;
    const peerLike = {
      sender: other.identityId, displayName: other.displayName, category: p2.category,
      tokens: p2.tokens, aiTokens: p2.aiTokens, searchTokens: p2.searchTokens,
      country: p2.country, city: p2.city, earliestYear: p2.earliestYear,
      seniorityMin: p2.seniorityMin, seniorityMax: p2.seniorityMax,
      rate: p2.rate, budgetMin: p2.budgetMin, budgetMax: p2.budgetMax,
      postingText: p2.jobPostingText || p2.sourceText, photoDataUrl: p2.photoDataUrl,
      languages: p2.languages, availableNow: p2.availableNow,
      contactType: p2.contactType, contactValue: p2.contactValue, participantLimit: p2.participantLimit,
      addressType: p2.addressType, exactAddress: p2.exactAddress, secretCode: p2.secretCode,
    };
    const match = scoreAgainstPeer(cfg, myTokens, myLookingForTokens, peerLike, mySecretCode);
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
    .filter((p) => now - (p.lastSeen || 0) < PEER_TTL_MS);

  // Unconditional (every namespace, every role) and set before
  // requiredRole below — hardFilter checks it first and, when it matches,
  // bypasses requiredRole along with everything else.
  const hardConstraints = { requiredLanguages: profile.languages, mySecretCode: profile.secretCode };
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
  } else if (ns === 'business') {
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
  } else if (ns === 'wallet' || ns === 'creator') {
    // Mirrors Employment/Business's own asymmetric hard-filter-when-present
    // pattern, just for an exact string instead of a numeric range: a
    // Seeker who already knows the exact address they're after only wants
    // Address holders of that exact value; leaving it blank falls back to
    // the namespace's baseline keyword matching on sourceText.
    if (!isSupplySide && profile.exactAddress) {
      hardConstraints.requiredExactAddress = profile.exactAddress.trim().toLowerCase();
    }
  }

  const cascade = discovery.runCascade(peers, {
    myNamespace: ns,
    protocolVersion: PROTOCOL_VERSION,
    hardConstraints,
    softConstraints,
  });

  const scoredRemote = cascade.pool.map((p) => ({ ...p, match: scoreAgainstPeer(cfg, myTokens, myLookingForTokens, p, profile.secretCode) }));

  // Anyone matching from the same browser (a second identity you created
  // yourself, in this tab or another) is scored exactly the same way and
  // shown in the exact same list — WebRTC can't connect a tab to itself,
  // so there's no live peerId behind it, but that's invisible here: it's
  // still just a peer, discovered like any other. Trying to chat with one
  // hits the same "not currently connected" path a real peer who went
  // offline would.
  const scored = [...scoredRemote, ...await localTestMatches(ns, cfg, id, myTokens, myLookingForTokens, profile.secretCode)]
    .sort((a, b) => b.match.score - a.match.score);

  // Credibility is a completely separate question from Match (see
  // credibility.js) — computed once per card here rather than inline in
  // renderCard, since it needs an IndexedDB read and renderCard itself
  // stays a plain synchronous template function.
  const credibilityBySender = new Map();
  for (const p of scored) credibilityBySender.set(p.sender, await credibility.computeCredibility(ns, p.sender));

  const seenBySender = new Map();
  for (const p of scored) seenBySender.set(p.sender, await marks.isSeen(ns, p.sender));

  // A null credibility (never observed) can never satisfy a positive
  // threshold — "no opinion yet" isn't "at least 30", so it's excluded
  // the same way a real, low score below the threshold would be.
  const credMin = credFilterByNs[ns] || 0;
  const filteredScored = credMin ? scored.filter((p) => (credibilityBySender.get(p.sender)?.score ?? -1) >= credMin) : scored;

  // Skips the cascade's own first stage ("Discovered on network") — that
  // count is the same thing the modebar's own "N peers" stat already
  // shows, just rescoped to this namespace, so showing both read as a
  // duplicate. cascade.pool itself (the actual filtered/ranked results)
  // is untouched; this only trims what gets displayed.
  const funnelHtml = cascade.stages.slice(1).map((s) => `
      <div class="stage"><div class="n">${s.count}</div><div class="lbl">${s.label}</div></div>
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
    if (ns === 'business') {
      return `
        <span class="chip">${[p.city, p.country].filter(Boolean).join(', ') || 'no location declared'}</span>
        ${isSupplySide && p.postingText ? `<span class="chip">budget ${p.budgetMin ?? '…'}–${p.budgetMax ?? '…'}</span>` : ''}
        ${!isSupplySide ? `<span class="chip">${p.rate != null ? 'rate ' + p.rate : 'no rate declared'}</span><span class="chip">${p.availableNow ? 'Available now' : 'Availability unknown'}</span>` : ''}
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
    if (ns === 'wallet' || ns === 'creator') {
      // exactAddress only ever travels on an Address holder's own
      // broadcast (see buildDiscoveryPayload) — so it only ever shows up
      // here on peer cards a Seeker is looking at, never the reverse.
      return `
        ${p.addressType ? `<span class="chip">${p.addressType}</span>` : ''}
        ${!isSupplySide && p.exactAddress ? `<span class="chip mono">${p.exactAddress}</span>` : ''}
      `;
    }
    return `
      <span class="chip">${(p.languages || []).join(' / ') || 'no language declared'}</span>
      <span class="chip">${p.availableNow ? 'Available now' : 'Availability unknown'}</span>
    `;
  }

  function renderCard(p) {
    const ex = explainMatch(cfg, p.match);
    const cred = credibilityBySender.get(p.sender); // null = never observed at all, distinct from a real, low score
    const chat = state.pendingChats[ns].get(id.identityId).get(p.sender);
    const meeting = state.pendingMeetings[ns].get(id.identityId).get(p.sender);
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
    // Auto-fulfilled once requested — see conversations.js's shareDocument
    // and message-router.js's document_request handling. No Share/Decline
    // banner anymore: the accepted chat is already the consent, so this is
    // just a button whose state reflects the request/response in flight.
    const docsHtml = (chat && chat.status === 'accepted') ? renderDocumentButtonsHtml(ns, id.identityId, id.role, p.sender) : '';
    // Employment/Business are the odd ones out: postingText travels from
    // the DEMAND side there (a job ad/mission request, public unlike a
    // CV), so the supply-side viewer (candidate/offer) is who should see
    // the preview. Outdoor, Info, and AIWA/YourMine all go the other way
    // — postingText comes from the SUPPLY side (organizer/Source/Address
    // holder), meant for the demand-side viewer (participant/Seeker) to
    // actually read — see each of buildDiscoveryPayload's own branches.
    // Pre-existing bug this fixes: only Outdoor was ever excluded here,
    // so Info's own Seekers could never see Source's shared text despite
    // it being broadcast specifically for them (confirmed empirically —
    // the <details> never rendered — before AIWA/YourMine hit the same
    // pattern and made it worth tracking down).
    const previewFromSupplySide = ns === 'employment' || ns === 'business';
    const postingPreview = ((previewFromSupplySide ? isSupplySide : !isSupplySide) && p.postingText)
      ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:11.5px;color:var(--low)">View ${ns === 'employment' ? 'posting' : ns === 'outdoor' ? 'activity' : ns === 'info' ? 'shared' : (ns === 'wallet' || ns === 'creator') ? 'address' : 'request'} text</summary><div style="font-size:12px;color:var(--mid);white-space:pre-wrap;margin-top:6px">${p.postingText}</div></details>` : '';

    const seen = seenBySender.get(p.sender);
    return `
        <div class="card ${seen ? 'seen' : ''}" data-peer="${p.peerId || ''}" data-identity="${p.sender}">
          <div class="top">
            ${p.photoDataUrl ? `<img class="avatar-photo" src="${p.photoDataUrl}" alt="">` : `<span class="avatar">${(p.category || 'PR').slice(0, 2).toUpperCase()}</span>`}
            <div class="info">
              <div class="name">${p.displayName || `${p.sender.slice(0, 10)}…`}${theirRoleLabel ? ` <span class="role-badge">${theirRoleLabel}</span>` : ''}</div>
              <div class="role">${p.category || 'No category declared'}</div>
              <div class="meta">${metaChips(p)}</div>
            </div>
            <div class="score">
              <div class="pct">${p.match.score}%</div>
              <div class="bar"><i style="width:${p.match.score}%"></i></div>
              <div class="cred">
                <span class="cred-label">Credibility</span>
                ${cred ? `<b>${cred.score}</b>` : `<span class="cred-none">—</span>`}
              </div>
            </div>
            ${marks.seenTickHtml(ns, p.sender, seen)}
          </div>
          <div class="expl">
            <div class="k">Match</div>
            ${ex.pos.map((t) => `<div class="p">${t}</div>`).join('')}${ex.neg.map((t) => `<div class="m">${t}</div>`).join('')}
            <div class="k" style="margin-top:8px">Credibility — from your own local history with them, never a global score</div>
            ${cred
              ? cred.factors.map((f) => `<div class="${f.sign === '+' ? 'p' : 'm'}">${f.text}</div>`).join('')
              : `<div class="m">Never observed before — no opinion yet, not a low score</div>`}
          </div>
          ${postingPreview}
          ${meetingHtml}
          <div class="actions">
            <button class="btn ghost toggle-expl">Why these scores</button>
            ${chat && chat.status === 'incoming'
              ? `<button class="btn primary respond-yes">Accept chat</button><button class="btn respond-no">Decline</button>`
              : chat && chat.status === 'accepted'
                ? `<button class="btn primary open-chat">Open in Messages</button><button class="btn ghost propose-meeting">Propose meeting</button>`
                : chat && chat.status === 'outgoing'
                  ? `<button class="btn" disabled>Request sent…</button>`
                  : canInitiateChat(ns, id.role)
                    ? `<button class="btn primary request-chat">Start conversation</button>`
                    : `<span style="font-size:11.5px;color:var(--low);align-self:center">They can reach out to start a conversation</span>`}
            ${docsHtml}
          </div>
        </div>`;
  }

  const resultsHtml = scored.length === 0
    ? `<div class="empty-state">No ${theirRoleLabel ? theirRoleLabel.toLowerCase() + ' ' : ''}peers discovered yet on this namespace.<br>Create a complementary identity — in this browser or a real second device — and it'll show up here.</div>`
    : filteredScored.length === 0
      ? `<div class="empty-state">Nobody discovered here clears a credibility filter of ${credMin} — try lowering it.</div>`
      : filteredScored.map((p) => renderCard(p)).join('');

  const credFilterHtml = scored.length === 0 ? '' : `
    <div class="filterbar">
      <label for="credFilter">Credibility</label>
      <select id="credFilter" class="filter-select">
        <option value="0" ${credMin === 0 ? 'selected' : ''}>Any</option>
        <option value="30" ${credMin === 30 ? 'selected' : ''}>&gt; 30</option>
        <option value="40" ${credMin === 40 ? 'selected' : ''}>&gt; 40</option>
      </select>
    </div>`;

  return `
    <div class="funnel">${funnelHtml}</div>
    ${credFilterHtml}
    <div class="results">${resultsHtml}</div>
  `;
}

export function bindClassicEvents(ns) {
  const id = state.identitiesByNs[ns].find((i) => i.identityId === state.activeIdentityId[ns]);
  const ws = document.getElementById('workspace');
  marks.bindSeenToggles(ws);

  ws.querySelector('#createHere')?.addEventListener('click', () => createIdentityFlow(ns));

  ws.querySelector('#credFilter')?.addEventListener('change', (e) => {
    credFilterByNs[ns] = parseInt(e.target.value, 10) || 0;
    state.render.workspace();
  });

  ws.querySelectorAll('.toggle-expl').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.card');
      card.classList.toggle('open');
      btn.textContent = card.classList.contains('open') ? 'Hide explanation' : 'Why these scores';
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
  // The conversation itself lives only in Messages now (see messages-ui.js) —
  // this just hands off to it, focused on the right one, rather than
  // re-rendering the thread inline here too.
  ws.querySelectorAll('.open-chat').forEach((btn) => {
    btn.addEventListener('click', () => {
      const theirIdentityId = btn.closest('.card').dataset.identity;
      state.messagesOpenConversation = { ns, myId: id.identityId, theirId: theirIdentityId };
      setActiveNamespace('messages');
      state.view = 'workspace';
      state.render.all();
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
  bindDocumentButtons(ns, id.identityId);
}
