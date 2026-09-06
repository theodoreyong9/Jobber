import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, matchTokens, explain, extractEarliestYear, MATCHING_ENGINE_VERSION } from '../js/matching.js';

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

test('tokenize folds accents instead of deleting the letter', () => {
  const t = tokenize('Développeur basé à Lausanne');
  assert.ok(t.includes('developpeur'));
  assert.ok(t.includes('lausanne'));
  assert.ok(!t.includes('d'));
});

test('tokenize drops French stopwords and elision fragments', () => {
  const t = tokenize('Le développeur est basé dans la ville de Lausanne pour un backend');
  assert.ok(!t.includes('le'));
  assert.ok(!t.includes('de'));
  assert.ok(!t.includes('la'));
  assert.ok(!t.includes('un'));
  assert.ok(!t.includes('pour'));
  assert.ok(t.includes('developpeur'));
  assert.ok(t.includes('lausanne'));
  assert.ok(t.includes('backend'));
});

test('tokenize drops generic listing boilerplate that carries no matching signal', () => {
  const t = tokenize('Détails de l\'emploi. Type de poste. Lieu: Lausanne. Description du poste: développeur backend.');
  assert.ok(!t.includes('details'));
  assert.ok(!t.includes('type'));
  assert.ok(!t.includes('poste'));
  assert.ok(!t.includes('lieu'));
  assert.ok(!t.includes('description'));
  assert.ok(t.includes('lausanne'));
  assert.ok(t.includes('developpeur'));
  assert.ok(t.includes('backend'));
});

test('tokenize drops pure numbers (percentages, ranges) as non-keywords', () => {
  const t = tokenize('Temps de travail : 90-100%');
  assert.ok(!t.includes('90'));
  assert.ok(!t.includes('100'));
});

test('tokenize ranks repeated terms above one-off mentions', () => {
  const t = tokenize('backend backend backend frontend kubernetes kubernetes docker');
  // backend (x3) should outrank kubernetes (x2), which outranks a single mention
  assert.equal(t[0], 'backend');
  assert.equal(t[1], 'kubernetes');
  assert.ok(t.indexOf('backend') < t.indexOf('frontend'));
  assert.ok(t.indexOf('kubernetes') < t.indexOf('docker'));
});

test('tokenize deduplicates', () => {
  const t = tokenize('backend backend backend');
  assert.deepEqual(t, ['backend']);
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

test('extractEarliestYear finds the oldest 4-digit year in text', () => {
  assert.equal(extractEarliestYear('Started in 2015, promoted 2019, now 2023'), 2015);
  assert.equal(extractEarliestYear('No dates here'), null);
  assert.equal(extractEarliestYear(''), null);
  assert.equal(extractEarliestYear('Founded 1998, still running in 2024'), 1998);
});
