import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, matchTokens, explain, MATCHING_ENGINE_VERSION } from '../js/matching.js';

test('tokenize lowercases, strips punctuation, drops stopwords', () => {
  const t = tokenize('Backend Engineer, Node.js and the API!');
  assert.ok(!t.includes('and'));
  assert.ok(!t.includes('the'));
  assert.ok(t.includes('backend'));
  assert.ok(t.includes('engineer'));
});

test('tokenize normalizes known synonyms', () => {
  const t = tokenize('js node k8s postgres');
  assert.deepEqual(t.sort(), ['javascript', 'kubernetes', 'nodejs', 'postgresql'].sort());
});

test('tokenize handles empty/undefined input', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(undefined), []);
});

test('matchTokens gives a perfect overlap a high score', () => {
  const tokens = tokenize('backend engineer nodejs postgresql api design');
  const result = matchTokens(tokens, tokens);
  assert.equal(result.score, 100);
  assert.equal(result.engineVersion, MATCHING_ENGINE_VERSION);
});

test('matchTokens gives disjoint sets a zero score', () => {
  const result = matchTokens(tokenize('gardening'), tokenize('astrophysics'));
  assert.equal(result.score, 0);
});

test('matchTokens penalizes missing required tokens', () => {
  const mine = tokenize('backend engineer nodejs');
  const theirs = tokenize('backend engineer');
  const withRequirement = matchTokens(mine, theirs, ['kubernetes']);
  const withoutRequirement = matchTokens(mine, theirs, []);
  assert.ok(withRequirement.score < withoutRequirement.score);
  assert.deepEqual(withRequirement.missingRequired, ['kubernetes']);
});

test('matchTokens score is always within 0..100', () => {
  const result = matchTokens(['a'], [], ['b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.ok(result.score >= 0);
  assert.ok(result.score <= 100);
});

test('matchTokens is deterministic for the same inputs', () => {
  const a = matchTokens(['x', 'y'], ['y', 'z']);
  const b = matchTokens(['x', 'y'], ['y', 'z']);
  assert.deepEqual(a, b);
});

test('explain surfaces matched keywords as positives and missing ones as negatives', () => {
  const result = matchTokens(tokenize('backend nodejs'), tokenize('backend'), ['kubernetes']);
  const ex = explain(result);
  assert.ok(ex.pos.some((line) => line.includes('backend')));
  assert.ok(ex.neg.some((line) => line.includes('kubernetes')));
});
