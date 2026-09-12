import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickActiveIdentityId, roleLabel, complementaryRole, initials, relativeTime, NS_CONFIG, pickActiveNamespace, canInitiateChat, state, ensureIdentityState, migrateIdentityState } from '../js/state.js';

function resetNsState(ns) {
  state.pendingChats[ns] = new Map();
  state.openChatWith[ns] = new Map();
  state.chatLog[ns] = new Map();
  state.pendingMeetings[ns] = new Map();
  state.pendingDocs[ns] = new Map();
  state.pendingAttachmentOffers[ns] = new Map();
  state.loadedConversations[ns] = new Map();
  state.searchLive[ns] = new Set();
}

test('pickActiveIdentityId returns the active identity, never a retired one', () => {
  const list = [
    { identityId: 'OLD', active: false },
    { identityId: 'NEW', active: true },
  ];
  assert.equal(pickActiveIdentityId(list), 'NEW');
});

test('pickActiveIdentityId returns null when everything is retired — the actual shipped bug this guards against', () => {
  const list = [
    { identityId: 'OLD1', active: false },
    { identityId: 'OLD2', active: false },
  ];
  assert.equal(pickActiveIdentityId(list), null);
});

test('pickActiveIdentityId returns null for an empty list', () => {
  assert.equal(pickActiveIdentityId([]), null);
});

test('pickActiveIdentityId picks the first active one when there happen to be several', () => {
  const list = [
    { identityId: 'A', active: true },
    { identityId: 'B', active: true },
  ];
  assert.equal(pickActiveIdentityId(list), 'A');
});

test('roleLabel resolves a known role and returns null for an unknown one', () => {
  assert.equal(roleLabel('employment', 'candidate'), 'Candidate');
  assert.equal(roleLabel('employment', 'nonsense'), null);
});

test('complementaryRole returns the other side, and null for single-sided namespaces', () => {
  assert.equal(complementaryRole('employment', 'candidate'), 'recruiter');
  assert.equal(complementaryRole('employment', 'recruiter'), 'candidate');
  assert.equal(complementaryRole('dating', 'anything'), null);
});

test('initials handles single and multi-word names, and falls back gracefully', () => {
  assert.equal(initials('Alex Kade'), 'AK');
  assert.equal(initials('Madonna'), 'M');
  assert.equal(initials(''), '?');
  assert.equal(initials(undefined), '?');
});

test('relativeTime buckets correctly across the boundaries', () => {
  const now = 1_000_000_000;
  assert.equal(relativeTime(now - 1000, now), 'just now');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5m ago');
  assert.equal(relativeTime(now - 2 * 3_600_000, now), '2h ago');
  assert.equal(relativeTime(now - 3 * 86_400_000, now), '3d ago');
  assert.equal(relativeTime(0, now), 'never');
});

test('every namespace with roles has exactly two, and dating/research have none', () => {
  for (const [ns, cfg] of Object.entries(NS_CONFIG)) {
    if (cfg.kind === 'twoSided') assert.equal(cfg.roles.length, 2, `${ns} should have exactly 2 roles`);
    if (cfg.kind === 'reciprocal' || cfg.kind === 'research' || cfg.kind === 'agent' || cfg.kind === 'near') assert.equal(cfg.roles, undefined, `${ns} should have no fixed roles`);
  }
});

/* ---- pickActiveNamespace: which namespace to land on at boot ---- */

test('pickActiveNamespace shows the welcome screen on a genuine first-ever open (nothing anywhere)', () => {
  const result = pickActiveNamespace({
    lastActiveValue: undefined,
    identitiesByNs: { employment: [], business: [], dating: [], research: [] },
  });
  assert.equal(result, null);
});

test('pickActiveNamespace reproduces and fixes the real shipped bug: create an identity, delete it, reload', () => {
  // Employment was visited (so "lastActiveValue" is stale-cached as
  // 'employment'), but the identity that made it active has since been
  // retired — nothing is active anywhere. The stale preference must not win.
  const result = pickActiveNamespace({
    lastActiveValue: 'employment',
    identitiesByNs: {
      employment: [{ identityId: 'X', active: false }], // retired, not deleted from history
      business: [], dating: [], research: [],
    },
  });
  assert.equal(result, null);
});

test('pickActiveNamespace honors the remembered namespace once something is actually active', () => {
  const result = pickActiveNamespace({
    lastActiveValue: 'dating',
    identitiesByNs: {
      employment: [{ identityId: 'X', active: true }],
      business: [],
      dating: [{ identityId: 'Y', active: true }],
      research: [],
    },
  });
  assert.equal(result, 'dating');
});

test('pickActiveNamespace falls back to "wherever you have an active identity" with no remembered preference', () => {
  const result = pickActiveNamespace({
    lastActiveValue: undefined,
    identitiesByNs: {
      employment: [], business: [{ identityId: 'Z', active: true }],
      dating: [], research: [],
    },
  });
  assert.equal(result, 'business');
});

test('pickActiveNamespace ignores a remembered namespace that no longer exists', () => {
  const result = pickActiveNamespace({
    lastActiveValue: 'not_a_real_namespace',
    identitiesByNs: {
      employment: [{ identityId: 'X', active: true }],
      business: [], dating: [], research: [],
    },
  });
  assert.equal(result, 'employment');
});

/* ---- canInitiateChat: who's allowed to make first contact ---- */

test('canInitiateChat: only the demand-side role can start a conversation in two-sided namespaces', () => {
  assert.equal(canInitiateChat('employment', 'recruiter'), true);
  assert.equal(canInitiateChat('employment', 'candidate'), false);
  assert.equal(canInitiateChat('business', 'client'), true);
  assert.equal(canInitiateChat('business', 'offer'), false);
  assert.equal(canInitiateChat('outdoor', 'participant'), true);
  assert.equal(canInitiateChat('outdoor', 'organizer'), false);
});

test('canInitiateChat: reciprocal and research namespaces are never gated', () => {
  assert.equal(canInitiateChat('dating', 'anything'), true);
  assert.equal(canInitiateChat('research', 'anything'), true);
});

/* ---- ensureIdentityState / migrateIdentityState: multi-identity-live buckets ---- */

test('ensureIdentityState lazily creates every per-identity bucket, and is idempotent', () => {
  resetNsState('_test_ns_a');
  ensureIdentityState('_test_ns_a', 'ID1');
  state.pendingChats['_test_ns_a'].get('ID1').set('PEER1', { status: 'incoming' });
  ensureIdentityState('_test_ns_a', 'ID1'); // must not reset an existing bucket
  assert.equal(state.pendingChats['_test_ns_a'].get('ID1').get('PEER1').status, 'incoming');
  assert.equal(state.openChatWith['_test_ns_a'].get('ID1'), null);
  assert.ok(state.chatLog['_test_ns_a'].get('ID1') instanceof Map);
  assert.ok(state.pendingMeetings['_test_ns_a'].get('ID1') instanceof Map);
  assert.ok(state.pendingDocs['_test_ns_a'].get('ID1') instanceof Map);
  assert.ok(state.pendingAttachmentOffers['_test_ns_a'].get('ID1') instanceof Map);
  assert.ok(state.loadedConversations['_test_ns_a'].get('ID1') instanceof Set);
});

test('migrateIdentityState carries an identity\'s in-memory state to a new id on rotation, instead of resetting it', () => {
  resetNsState('_test_ns_b');
  ensureIdentityState('_test_ns_b', 'OLD');
  state.chatLog['_test_ns_b'].get('OLD').set('PEER1', [{ from: 'me', text: 'hi', ts: 1 }]);
  state.pendingMeetings['_test_ns_b'].get('OLD').set('PEER1', { status: 'accepted', when: 'tomorrow' });
  state.openChatWith['_test_ns_b'].set('OLD', 'PEER1');
  state.searchLive['_test_ns_b'].add('OLD');

  migrateIdentityState('_test_ns_b', 'OLD', 'NEW');

  assert.equal(state.chatLog['_test_ns_b'].has('OLD'), false);
  assert.equal(state.chatLog['_test_ns_b'].get('NEW').get('PEER1')[0].text, 'hi');
  assert.equal(state.pendingMeetings['_test_ns_b'].get('NEW').get('PEER1').status, 'accepted');
  assert.equal(state.openChatWith['_test_ns_b'].get('NEW'), 'PEER1');
  assert.equal(state.searchLive['_test_ns_b'].has('OLD'), false);
  assert.equal(state.searchLive['_test_ns_b'].has('NEW'), true);
});

test('migrateIdentityState is safe on an identity that was never live or ensured', () => {
  resetNsState('_test_ns_c');
  migrateIdentityState('_test_ns_c', 'NEVER_SEEN', 'NEW2');
  assert.ok(state.chatLog['_test_ns_c'].get('NEW2') instanceof Map);
  assert.equal(state.openChatWith['_test_ns_c'].get('NEW2'), null);
  assert.equal(state.searchLive['_test_ns_c'].has('NEW2'), false);
});
