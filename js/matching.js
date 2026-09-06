// matching.js — deterministic, explainable, versioned scoring.
// Runs entirely on-device against tokens extracted from source text (CPU
// pipeline). AI enrichment, when enabled, only adds extra tokens upstream —
// it never touches the scoring formula itself, so both sides stay comparable.

export const MATCHING_ENGINE_VERSION = '0.1.0';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'with',
  'is', 'are', 'be', 'as', 'at', 'by', 'from', 'that', 'this', 'it',
]);

const SYNONYMS = {
  js: 'javascript',
  node: 'nodejs',
  nodejs: 'nodejs',
  javascript: 'javascript',
  postgres: 'postgresql',
  postgresql: 'postgresql',
  k8s: 'kubernetes',
  ml: 'machinelearning',
  ai: 'artificialintelligence',
  fe: 'frontend',
  be: 'backend',
};

export function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !STOPWORDS.has(w))
    .map((w) => SYNONYMS[w] || w);
}

export function matchTokens(myTokens, theirTokens, requiredTokens = []) {
  const mySet = new Set(myTokens);
  const theirSet = new Set(theirTokens);
  const overlap = [...mySet].filter((t) => theirSet.has(t));
  const union = new Set([...mySet, ...theirSet]);
  const jaccard = union.size ? overlap.length / union.size : 0;

  const missingRequired = requiredTokens.filter((t) => !theirSet.has(t));

  let score = Math.round(jaccard * 100);
  score -= missingRequired.length * 15;
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    engineVersion: MATCHING_ENGINE_VERSION,
    matchedKeywords: overlap,
    missingRequired,
  };
}

export function explain(matchResult) {
  const pos = matchResult.matchedKeywords.slice(0, 6).map((k) => `Shared keyword: ${k}`);
  const neg = matchResult.missingRequired.map((k) => `Missing required: ${k}`);
  if (pos.length === 0 && neg.length === 0) pos.push('No strong signal yet — try adding more detail to your profile.');
  return { pos, neg };
}
