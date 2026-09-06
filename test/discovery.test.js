import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelZero, hardFilter, softScore, runCascade } from '../js/discovery.js';

const V = '0.4';

function peer(overrides = {}) {
  return {
    namespace: 'job_candidate', v: V, category: 'Backend', languages: ['EN'],
    availableNow: true, distanceKm: 5, ...overrides,
  };
}

test('levelZero eliminates wrong namespace and protocol version', () => {
  const peers = [peer(), peer({ namespace: 'dating' }), peer({ v: '0.3' })];
  const out = levelZero(peers, 'job_candidate', V);
  assert.equal(out.length, 1);
});

test('hardFilter eliminates on required language', () => {
  const peers = [peer({ languages: ['EN'] }), peer({ languages: ['FR'] })];
  const out = hardFilter(peers, { requiredLanguages: ['EN'] });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].languages, ['EN']);
});

test('hardFilter eliminates on distance and availability', () => {
  const peers = [peer({ distanceKm: 2 }), peer({ distanceKm: 50 }), peer({ availableNow: false })];
  const out = hardFilter(peers, { maxDistanceKm: 10, requireAvailableNow: true });
  assert.equal(out.length, 1);
});

test('hardFilter eliminates on required role (two-sided namespaces)', () => {
  const peers = [peer({ role: 'recruiter' }), peer({ role: 'candidate' })];
  const out = hardFilter(peers, { requiredRole: 'recruiter' });
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'recruiter');
});

test('hardFilter with no constraints passes everyone through', () => {
  const peers = [peer(), peer(), peer()];
  assert.equal(hardFilter(peers, {}).length, 3);
});

test('hardFilter enforces a recruiter-declared seniority range against the candidate earliest year', () => {
  const peers = [peer({ earliestYear: 2015 }), peer({ earliestYear: 2022 }), peer({ earliestYear: null })];
  const out = hardFilter(peers, { seniorityRange: { min: 2010, max: 2018 } });
  // 2015 passes, 2022 fails, unknown (null) is never used to eliminate
  assert.equal(out.length, 2);
  assert.ok(out.some((p) => p.earliestYear === 2015));
  assert.ok(out.some((p) => p.earliestYear === null));
});

test('hardFilter enforces a candidate earliest year against a recruiter-declared range', () => {
  const peers = [peer({ seniorityMin: 2010, seniorityMax: 2018 }), peer({ seniorityMin: 2020, seniorityMax: 2023 })];
  const out = hardFilter(peers, { myEarliestYear: 2015 });
  assert.equal(out.length, 1);
  assert.equal(out[0].seniorityMin, 2010);
});

test('softScore rewards matching country and city', () => {
  const same = softScore(peer({ country: 'Switzerland', city: 'Lausanne' }), { country: 'Switzerland', city: 'Lausanne' });
  const different = softScore(peer({ country: 'France', city: 'Paris' }), { country: 'Switzerland', city: 'Lausanne' });
  assert.ok(same > different);
});

test('hardFilter enforces a client-declared budget range against a provider\'s declared rate', () => {
  const peers = [peer({ rate: 500 }), peer({ rate: 2000 }), peer({ rate: null })];
  const out = hardFilter(peers, { rateRange: { min: 300, max: 800 } });
  assert.equal(out.length, 2);
  assert.ok(out.some((p) => p.rate === 500));
  assert.ok(out.some((p) => p.rate === null)); // unknown never eliminates
});

test('hardFilter enforces a provider\'s declared rate against a client-declared budget range', () => {
  const peers = [peer({ budgetMin: 300, budgetMax: 800 }), peer({ budgetMin: 1000, budgetMax: 1500 })];
  const out = hardFilter(peers, { myRate: 500 });
  assert.equal(out.length, 1);
  assert.equal(out[0].budgetMin, 300);
});

test('softScore rewards category match and closeness, never eliminates', () => {
  const close = softScore(peer({ category: 'Backend', distanceKm: 1 }), { preferredCategory: 'Backend', maxDistanceKm: 10 });
  const far = softScore(peer({ category: 'Frontend', distanceKm: 9 }), { preferredCategory: 'Backend', maxDistanceKm: 10 });
  assert.ok(close > far);
});

test('runCascade narrows a large pool down through every stage', () => {
  const peers = [
    ...Array.from({ length: 5 }, () => peer({ languages: ['EN'], distanceKm: 3 })),
    ...Array.from({ length: 5 }, () => peer({ namespace: 'dating' })),
    ...Array.from({ length: 5 }, () => peer({ languages: ['FR'] })),
  ];
  const { pool, stages } = runCascade(peers, {
    myNamespace: 'job_candidate',
    protocolVersion: V,
    hardConstraints: { requiredLanguages: ['EN'] },
    softConstraints: { preferredCategory: 'Backend' },
  });
  assert.equal(stages[0].count, 15);
  assert.equal(pool.length, 5);
  assert.ok(stages.every((s, i) => i === 0 || s.count <= stages[i - 1].count));
});

test('runCascade respects budgets', () => {
  const peers = Array.from({ length: 50 }, () => peer());
  const { pool } = runCascade(peers, {
    myNamespace: 'job_candidate',
    protocolVersion: V,
    budgets: { maxDiscovered: 50, maxPreFiltered: 20, maxForMatching: 3 },
  });
  assert.equal(pool.length, 3);
});
