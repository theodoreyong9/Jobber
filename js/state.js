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

export const NAMESPACES = ['employment', 'business', 'independant', 'dating', 'research'];

// "twoSided" namespaces match role A against role B (never A-A or B-B).
// "reciprocal" (dating) matches each identity's *search* against the
// other's *profile*, in both directions — a real match needs both sides
// to be interested, not just one.
export const NS_CONFIG = {
  employment: { label: 'Employment', color: '#F1552C', kind: 'twoSided',
    roles: [{ key: 'candidate', label: 'Candidate' }, { key: 'recruiter', label: 'Recruiter' }],
    hint: 'Candidates are matched against recruiters, and recruiters against candidates — never against their own kind.' },
  business: { label: 'Business', color: '#59C9B8', kind: 'twoSided',
    roles: [{ key: 'offer', label: 'Offer' }, { key: 'client', label: 'Client' }],
    hint: 'Offers are matched with clients — never offer-to-offer — and a declared rate is checked against each client\'s budget range.' },
  independant: { label: 'Independant', color: '#E8B84B', kind: 'twoSided',
    roles: [{ key: 'provider', label: 'Service' }, { key: 'user', label: 'Utilisateur' }],
    hint: 'Service providers are matched with the users who need them, with a declared rate checked against each user\'s budget range.' },
  dating: { label: 'Dating', color: '#D46FB3', kind: 'reciprocal',
    hint: 'Your "looking for" is matched against their profile, and theirs against yours — a real match needs both directions to work.' },
  research: { label: 'Research', color: '#7C9EF5', kind: 'research',
    hint: 'Agent-to-agent collaboration. Hypothesis and critique are symmetric roles.' },
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

export const PEER_TTL_MS = 10 * 60 * 1000; // spec §101 — stale discovery entries expire

export const state = {
  activeNamespace: 'employment',
  activeIdentityId: {},   // namespace -> identityId
  identitiesByNs: {},     // namespace -> [identity]
  searchLive: {},         // namespace -> bool
  discovered: {},          // namespace -> Map(peerId -> meta)
  pendingChats: {},         // namespace -> Map(theirIdentityId -> {status})
  openChatWith: {},         // namespace -> theirIdentityId | null
  chatLog: {},              // namespace -> Map(theirIdentityId -> [{from,text,ts,kind}]) — hydrated from IndexedDB, see persistMessage/loadConversation
  pendingMeetings: {},      // namespace -> Map(theirIdentityId -> {status, when, note})
  pendingDocs: {},          // namespace -> Map(theirIdentityId -> {status, doc, text?})
  pendingAttachmentOffers: {}, // namespace -> Map(offerId -> {status, name, size, type, theirIdentityId, file?})
  blocked: {},              // namespace -> Set(identityId)
  identityToPeer: {},       // namespace -> Map(theirIdentityId -> current live peerId)
  peerToIdentity: {},       // namespace -> Map(peerId -> theirIdentityId)
  loadedConversations: {},  // namespace -> Set(theirIdentityId) already hydrated from IndexedDB
  researchProjects: [],
  activeProjectId: null,
  pendingJoinRequests: new Map(), // projectId -> [{identityId, displayName, skillMd, peerId}]
  outgoingJoinRequests: new Map(), // projectId -> 'pending' | 'accepted' | 'declined'
  outgoingJoinRequestIds: new Map(), // projectId -> messageId of the join request I sent, for correlationId checks
  discoverableProjects: new Map(), // projectId -> {problem, chain, filledCount, initiatorDisplayName, fromPeerId}

  // Filled in by app.js once every module has loaded — see the note above.
  render: { all: null, workspace: null, topbar: null },
  handlers: { incomingMessage: null },
};

export function setActiveNamespace(ns) {
  state.activeNamespace = ns;
  db.put('cache', { key: 'lastActiveNamespace', value: ns });
}
