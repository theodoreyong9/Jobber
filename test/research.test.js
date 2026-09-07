import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, ARTIFACT_TYPES, CHAIN_MODES, MODE_ARTIFACT_TYPES, nextOpenSlot, myParticipant, isStalled, STALLED_THRESHOLD_MS, unionValidatedBy } from '../js/research.js';

function art(id, type, parents = []) {
  return { artifactId: id, type, parents, content: { text: id }, createdAt: 0, validatedBy: [] };
}

test('ARTIFACT_TYPES includes every type used by the spec', () => {
  for (const t of ['problem', 'hypothesis', 'critique', 'counter_hypothesis', 'evidence', 'experiment', 'result', 'synthesis']) {
    assert.ok(ARTIFACT_TYPES.includes(t));
  }
});

test('layoutGraph places a root artifact at depth 0', () => {
  const { columns } = layoutGraph([art('P', 'problem')]);
  assert.equal(columns.get(0).length, 1);
  assert.equal(columns.get(0)[0].artifact.artifactId, 'P');
});

test('layoutGraph increases depth by one per generation', () => {
  const artifacts = [
    art('P', 'problem'),
    art('H1', 'hypothesis', ['P']),
    art('C1', 'critique', ['H1']),
    art('H2', 'counter_hypothesis', ['C1']),
  ];
  const { columns } = layoutGraph(artifacts);
  assert.equal(columns.get(0)[0].artifact.artifactId, 'P');
  assert.equal(columns.get(1)[0].artifact.artifactId, 'H1');
  assert.equal(columns.get(2)[0].artifact.artifactId, 'C1');
  assert.equal(columns.get(3)[0].artifact.artifactId, 'H2');
});

test('layoutGraph takes the max depth across multiple parents', () => {
  const artifacts = [
    art('P', 'problem'),
    art('H1', 'hypothesis', ['P']),
    art('E1', 'evidence', ['P']),
    art('S1', 'synthesis', ['H1', 'E1']),
  ];
  const { columns } = layoutGraph(artifacts);
  assert.equal(columns.get(2)[0].artifact.artifactId, 'S1');
});

test('layoutGraph builds one edge per parent link', () => {
  const artifacts = [art('P', 'problem'), art('H1', 'hypothesis', ['P']), art('H2', 'hypothesis', ['P'])];
  const { edges } = layoutGraph(artifacts);
  assert.equal(edges.length, 2);
  assert.ok(edges.every((e) => e.from === 'P'));
});

/* ---- Chain / mode model (no ownership split — see research.js) ---- */

function project(chain, participants) {
  return { chain, participants };
}

test('CHAIN_MODES is exactly build and critic', () => {
  assert.deepEqual([...CHAIN_MODES].sort(), ['build', 'critic']);
});

test('MODE_ARTIFACT_TYPES only grants critique-family types to critic', () => {
  assert.ok(MODE_ARTIFACT_TYPES.critic.includes('critique'));
  assert.ok(!MODE_ARTIFACT_TYPES.critic.includes('hypothesis'));
  assert.ok(MODE_ARTIFACT_TYPES.build.includes('hypothesis'));
  assert.ok(!MODE_ARTIFACT_TYPES.build.includes('critique'));
});

test('every mode-granted artifact type is a real ARTIFACT_TYPES entry', () => {
  for (const types of Object.values(MODE_ARTIFACT_TYPES)) {
    for (const t of types) assert.ok(ARTIFACT_TYPES.includes(t), `${t} should be a declared artifact type`);
  }
});

test('nextOpenSlot returns the next chain position with its mode', () => {
  const p = project(['build', 'critic', 'build'], [{ identityId: 'A' }]);
  assert.deepEqual(nextOpenSlot(p), { chainIndex: 1, mode: 'critic' });
});

test('nextOpenSlot returns null once the chain is full', () => {
  const p = project(['build', 'critic'], [{ identityId: 'A' }, { identityId: 'B' }]);
  assert.equal(nextOpenSlot(p), null);
});

test('nextOpenSlot follows a longer chain in order (build, critic, critic)', () => {
  const p = project(['build', 'critic', 'critic'], [{ identityId: 'A' }, { identityId: 'B' }]);
  assert.deepEqual(nextOpenSlot(p), { chainIndex: 2, mode: 'critic' });
});

test('myParticipant finds a participant by identity, or null', () => {
  const p = project(['build'], [{ identityId: 'A', mode: 'build' }]);
  assert.equal(myParticipant(p, 'A').mode, 'build');
  assert.equal(myParticipant(p, 'nobody'), null);
});

/* ---- Activity / stalled detection ---- */

test('isStalled is false for a participant active within the threshold', () => {
  const now = 1_000_000_000;
  assert.equal(isStalled({ lastActiveAt: now - 1000 }, now), false);
});

test('isStalled is true once the threshold has passed', () => {
  const now = 1_000_000_000;
  assert.equal(isStalled({ lastActiveAt: now - STALLED_THRESHOLD_MS - 1 }, now), true);
});

test('isStalled is false when there is no activity timestamp at all', () => {
  assert.equal(isStalled({}), false);
  assert.equal(isStalled(null), false);
});

/* ---- Conflict handling: validatedBy is a grow-only set, merged by union ---- */

test('unionValidatedBy combines two independently-validated copies of the same artifact', () => {
  const existing = { validatedBy: ['A'] };
  const incoming = { validatedBy: ['B'] };
  assert.deepEqual(unionValidatedBy(existing, incoming).sort(), ['A', 'B']);
});

test('unionValidatedBy deduplicates when both sides validated the same way', () => {
  const existing = { validatedBy: ['A', 'B'] };
  const incoming = { validatedBy: ['B'] };
  assert.deepEqual(unionValidatedBy(existing, incoming).sort(), ['A', 'B']);
});

test('unionValidatedBy tolerates missing validatedBy on either side', () => {
  assert.deepEqual(unionValidatedBy(undefined, { validatedBy: ['A'] }), ['A']);
  assert.deepEqual(unionValidatedBy({ validatedBy: ['A'] }, undefined), ['A']);
  assert.deepEqual(unionValidatedBy(undefined, undefined), []);
});

test('unionValidatedBy never loses a validation regardless of merge order', () => {
  const a = { validatedBy: ['A'] };
  const b = { validatedBy: ['B'] };
  assert.deepEqual(unionValidatedBy(a, b).sort(), unionValidatedBy(b, a).sort());
});
