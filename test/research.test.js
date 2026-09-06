import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, ARTIFACT_TYPES } from '../js/research.js';

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
