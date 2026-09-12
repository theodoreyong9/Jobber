// state.js — the single shared state object, namespace configuration, and
// small pure helpers used everywhere. Every other UI module imports from
// here; this file imports only db.js (for persisting the active namespace).
//
// `state.render` and `state.handlers` are filled in once by app.js after
// every module has loaded (see the bottom of app.js). Other modules call
// through them (`state.render.workspace()`, `state.handlers.incomingMessage(...)`)
// instead of importing render.js / message-router.js directly — this is
// what keeps the module graph a plain tree instead of a circular mess:
// nobody needs to import "the thing that calls me back".

import * as db from './db.js';

export const NAMESPACES = ['employment', 'business', 'outdoor', 'dating', 'research', 'near', 'agent', 'messages', 'creator', 'wallet', 'tribute'];

// Purely a display grouping for the Bureau (desktop-ui.js) — every other
// consumer of NAMESPACES (app.js's boot loop, render.js, etc.) still just
// wants the flat list, so this doesn't replace it. Three clusters: the
// actual P2P matching namespaces, the cross-cutting tools that read what
// those already discovered, and the links out to the rest of this
// portfolio.
export const NAMESPACE_GROUPS = [
  { label: 'Match', namespaces: ['employment', 'business', 'outdoor', 'dating'] },
  { label: 'Insight', namespaces: ['research', 'near', 'agent', 'messages'] },
  { label: 'Ecosystem', namespaces: ['creator', 'wallet', 'tribute'] },
];

// "twoSided" namespaces match role A against role B (never A-A or B-B).
// "reciprocal" (dating) matches each identity's *search* against the
// other's *profile*, in both directions — a real match needs both sides
// to be interested, not just one.
export const NS_CONFIG = {
  employment: { label: 'Employment', color: '#F1552C', kind: 'twoSided', icon: '💼',
    roles: [{ key: 'candidate', label: 'Candidate' }, { key: 'recruiter', label: 'Recruiter' }],
    hint: 'Candidates are matched against recruiters, and recruiters against candidates — never against their own kind.' },
  business: { label: 'Business', color: '#59C9B8', kind: 'twoSided', icon: '🤝',
    roles: [{ key: 'offer', label: 'Offer' }, { key: 'client', label: 'Client' }],
    hint: 'Offers are matched with clients — never offer-to-offer — and a declared rate is checked against each client\'s budget range.' },
  outdoor: { label: 'Outdoor', color: '#4C9A6B', kind: 'twoSided', icon: '🏕️',
    roles: [{ key: 'organizer', label: 'Organizer' }, { key: 'participant', label: 'Participant' }],
    hint: 'Organizers post an out-of-home activity — any theme, freely chosen — with a contact method and a participant limit; participants are matched by shared interest, not a price range.' },
  dating: { label: 'Dating', color: '#D46FB3', kind: 'reciprocal', icon: '💗',
    hint: 'Your "looking for" is matched against their profile, and theirs against yours — a real match needs both directions to work.' },
  research: { label: 'Intelligence', color: '#7C9EF5', kind: 'research', icon: '🧠',
    hint: 'Agent-to-agent collaboration. Hypothesis and critique are symmetric roles.' },
  near: { label: 'Near', color: '#6FBF73', kind: 'near', icon: '📍',
    hint: 'Aggregates everyone you\'ve already discovered in other modes who\'s within your radius — opt-in location sharing, off by default, and it doesn\'t discover new people on its own.' },
  agent: { label: 'Agent', color: '#9B8AFB', kind: 'agent', icon: '🤖',
    hint: 'Cross-references what you offer and search for (across every namespace) against what everyone you\'ve already discovered offers and searches for — surfacing matches a single namespace\'s own matching would never see. Every finding says whether it needed AI-enriched keywords or was pure CPU.' },
  messages: { label: 'Messages', color: '#4DD0E1', kind: 'messages', icon: '💬',
    hint: 'Every conversation and pending request (chat, meeting, document, file) across every mode, in one place — no identity of its own, it just reads what your other identities already have.' },

  // "external" namespaces aren't part of Jobber's own matching at all —
  // the tile just opens another app in this same portfolio in a new tab.
  // No identity, no profile, nothing to render here; desktop-ui.js skips
  // setActiveNamespace entirely for this kind and opens `url` instead.
  creator: { label: 'Creator', color: '#F0A830', kind: 'external', icon: '🎨',
    url: 'https://yourmine-dapp.web.app',
    hint: 'Opens YourMine — publish JavaScript apps and interface themes, permissionlessly.' },
  wallet: { label: 'Wallet', color: '#5B6EE8', kind: 'external', icon: '👛',
    url: 'https://theodoreyong9.github.io/AIWA_chain/',
    hint: 'Opens AIWA — local, geographically-independent value accrual.' },
  tribute: { label: 'Tribute', color: '#B85C8A', kind: 'external', icon: '🌐',
    url: 'https://theodoreyong9.github.io/SGD/',
    hint: 'Opens SGD — collective participation through a shared semantic graph, no up/down vote.' },
};

export function roleLabel(ns, roleKey) {
  const role = NS_CONFIG[ns].roles?.find((r) => r.key === roleKey);
  return role ? role.label : null;
}

export function complementaryRole(ns, roleKey) {
  const roles = NS_CONFIG[ns].roles;
  if (!roles) return null;
  return roles.find((r) => r.key !== roleKey)?.key || null;
}

// Who's allowed to send the first "start conversation" request. Every
// current two-sided namespace follows the same pattern — the demand side
// (roles[1]: Recruiter, Client, Utilisateur, Buyer, Passenger) decides,
// the supply side (roles[0]) is discoverable but waits to be contacted —
// so this is one generic rule rather than a namespace-by-namespace
// special case. Reciprocal (Dating) and Research aren't gated at all:
// Dating already requires both sides to independently act (request +
// accept) before anything happens, and Research has its own separate
// join/accept model.
export function canInitiateChat(ns, roleKey) {
  const cfg = NS_CONFIG[ns];
  if (cfg.kind !== 'twoSided') return true;
  return roleKey === cfg.roles[1].key;
}

export function initials(name) {
  return (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

export function relativeTime(ts, now = Date.now()) {
  if (!ts) return 'never';
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

// A retired identity (active:false) stays in the list forever — it's kept
// as local history, never deleted. Picking "the" active one for a
// namespace must therefore never fall back to just "the first record":
// that silently resurrects a retired identity as if it were still current
// (this was a real, shipped bug — retiring your last identity in a
// namespace, then reloading, brought it right back).
export function pickActiveIdentityId(list) {
  return list.find((i) => i.active)?.identityId ?? null;
}

// Decides which namespace to land on at boot. "Nothing active anywhere"
// always wins over any remembered preference — a `lastActiveValue` from
// before your last identity there got retired/deleted is stale, and
// landing on "Employment — create an identity" when the whole app is
// empty is worse than the neutral welcome screen (this was a real shipped
// bug: creating then deleting your only identity left the stale
// preference in place, so the welcome screen never came back).
export function pickActiveNamespace({ lastActiveValue, identitiesByNs }) {
  const totalActive = NAMESPACES.reduce((n, ns) => n + (identitiesByNs[ns]?.filter((i) => i.active).length || 0), 0);
  if (totalActive === 0) return null;
  if (lastActiveValue && NAMESPACES.includes(lastActiveValue)) return lastActiveValue;
  return NAMESPACES.find((ns) => identitiesByNs[ns]?.some((i) => i.active)) || NAMESPACES[0];
}

export const PEER_TTL_MS = 10 * 60 * 1000; // spec §101 — stale discovery entries expire

// Collections below are split by what they're actually about, not
// uniformly "per namespace": `discovered`, `identityToPeer`, and
// `peerToIdentity` describe the wire itself (which remote peers exist,
// and their live peerId) — one shared physical P2P connection per
// namespace, true regardless of how many of *my* identities are live on
// it, so these stay namespace-scoped. `blocked` is a namespace-wide
// decision by design (blocking someone is "I don't want to hear from
// them", not "this one persona of mine doesn't"). Everything else here
// is genuinely about *my* side of a specific relationship with someone,
// so once more than one of my identities can be live in the same
// namespace at once, each needs its own bucket — see `ensureIdentityState`.
export const state = {
  // 'desktop' shows the Bureau (every identity you've created, across every
  // namespace, as one tile each) — that's what you land on. 'workspace'
  // shows the active namespace's actual topbar+workspace, entered by
  // tapping a tile. Kept separate from activeNamespace itself so switching
  // back to the Bureau doesn't forget which namespace/identity you were
  // last working in — see desktop-ui.js.
  view: 'desktop',
  activeNamespace: 'employment',
  activeIdentityId: {},   // namespace -> identityId — which one I'm *viewing*, independent of which are live
  identitiesByNs: {},     // namespace -> [identity]
  searchLive: {},         // namespace -> Set(identityId) — which of my identities are live right now
  discovered: {},          // namespace -> Map(peerId -> meta)
  pendingChats: {},         // namespace -> Map(myIdentityId -> Map(theirIdentityId -> {status}))
  openChatWith: {},         // namespace -> Map(myIdentityId -> theirIdentityId | null)
  chatLog: {},              // namespace -> Map(myIdentityId -> Map(theirIdentityId -> [{from,text,ts,kind}])) — hydrated from IndexedDB, see persistMessage/loadConversation
  pendingMeetings: {},      // namespace -> Map(myIdentityId -> Map(theirIdentityId -> {status, when, note}))
  pendingDocs: {},          // namespace -> Map(myIdentityId -> Map(theirIdentityId -> {status, doc, text?}))
  pendingAttachmentOffers: {}, // namespace -> Map(myIdentityId -> Map(offerId -> {status, name, size, type, theirIdentityId, file?}))
  blocked: {},              // namespace -> Set(identityId)
  identityToPeer: {},       // namespace -> Map(theirIdentityId -> current live peerId)
  peerToIdentity: {},       // namespace -> Map(peerId -> theirIdentityId)
  loadedConversations: {},  // namespace -> Map(myIdentityId -> Set(theirIdentityId)) already hydrated from IndexedDB
  researchProjects: [],
  activeProjectId: null,
  pendingJoinRequests: new Map(), // projectId -> [{identityId, displayName, skillMd, peerId}]
  outgoingJoinRequests: new Map(), // projectId -> 'pending' | 'accepted' | 'declined'
  outgoingJoinRequestIds: new Map(), // projectId -> messageId of the join request I sent, for correlationId checks
  discoverableProjects: new Map(), // projectId -> {problem, chain, filledCount, initiatorDisplayName, fromPeerId}

  // Near mode: a device-level fact layered onto whichever namespace
  // identities are actively broadcasting, not tied to any one identity.
  nearLocationEnabled: false,
  nearCoords: null, // { lat, lon } | null — real GPS coords once granted
  nearRadiusKm: 25,

  // Filled in by app.js once every module has loaded — see the note above.
  render: { all: null, workspace: null, topbar: null },
  handlers: { incomingMessage: null },
};

export function setActiveNamespace(ns) {
  state.activeNamespace = ns;
  db.put('cache', { key: 'lastActiveNamespace', value: ns });
}

// Every collection that's genuinely "my side of a relationship" (see the
// comment above `state`) is bucketed per identity — lazily initialized here
// rather than at every read site, the same way app.js already lazily
// initializes the namespace-level Maps on boot. Called once per identity on
// boot, and again whenever a new identity is created afterward.
export function ensureIdentityState(ns, identityId) {
  if (!state.pendingChats[ns].has(identityId)) state.pendingChats[ns].set(identityId, new Map());
  if (!state.openChatWith[ns].has(identityId)) state.openChatWith[ns].set(identityId, null);
  if (!state.chatLog[ns].has(identityId)) state.chatLog[ns].set(identityId, new Map());
  if (!state.pendingMeetings[ns].has(identityId)) state.pendingMeetings[ns].set(identityId, new Map());
  if (!state.pendingDocs[ns].has(identityId)) state.pendingDocs[ns].set(identityId, new Map());
  if (!state.pendingAttachmentOffers[ns].has(identityId)) state.pendingAttachmentOffers[ns].set(identityId, new Map());
  if (!state.loadedConversations[ns].has(identityId)) state.loadedConversations[ns].set(identityId, new Set());
}

// Every incoming P2P message that's about a specific relationship (as
// opposed to a `discovery` broadcast, which isn't addressed to anyone in
// particular) carries `targetIdentityId` — which of *my* identities the
// sender means. This resolves that to one of my actually-live identities,
// falling back to whichever one I'm currently viewing, then to whichever
// is live at all, for a message from a peer who predates this field or a
// dropped edge case — never a hard failure, just the most reasonable guess.
export function resolveLiveIdentity(ns, targetIdentityId) {
  const live = state.searchLive[ns];
  if (!(live instanceof Set)) return null; // research's searchLive is a plain bool — not this model at all
  if (targetIdentityId && live.has(targetIdentityId)) return targetIdentityId;
  if (state.activeIdentityId[ns] && live.has(state.activeIdentityId[ns])) return state.activeIdentityId[ns];
  return live.size ? live.values().next().value : null;
}

// Rotation replaces an identity's keypair but is meant to feel continuous,
// not like starting over — the same reasoning credibility.js's own
// handleRotation already applies to *observed* history. This carries the
// *acting* side's in-memory state (open chats, pending requests, unsent
// chat log) from the retired id to the fresh one instead of quietly
// dropping it.
//
// Deliberately does NOT touch searchLive: going live isn't just a data
// flag here, it's also a live p2p.js room registration keyed by identityId
// — the caller (identity-ui.js's rotateFlow) stops the old registration and
// starts a fresh one under the new id itself, since only it knows whether
// the identity being rotated was actually live in the first place.
export function migrateIdentityState(ns, oldIdentityId, newIdentityId) {
  ensureIdentityState(ns, newIdentityId);
  for (const store of [state.pendingChats, state.chatLog, state.pendingMeetings, state.pendingDocs, state.pendingAttachmentOffers, state.loadedConversations]) {
    if (store[ns].has(oldIdentityId)) store[ns].set(newIdentityId, store[ns].get(oldIdentityId));
    store[ns].delete(oldIdentityId);
  }
  const openWith = state.openChatWith[ns].get(oldIdentityId);
  state.openChatWith[ns].set(newIdentityId, openWith ?? null);
  state.openChatWith[ns].delete(oldIdentityId);
}
