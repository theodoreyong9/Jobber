import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickActiveIdentityId, roleLabel, complementaryRole, initials, relativeTime, NS_CONFIG } from '../js/state.js';

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
    if (cfg.kind === 'reciprocal' || cfg.kind === 'research') assert.equal(cfg.roles, undefined, `${ns} should have no fixed roles`);
  }
});
