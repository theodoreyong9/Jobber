// matching.js — deterministic, explainable, versioned scoring.
// Runs entirely on-device against tokens extracted from source text (CPU
// pipeline). AI enrichment, when enabled, only adds extra tokens upstream —
// it never touches the scoring formula itself, so both sides stay comparable.

export const MATCHING_ENGINE_VERSION = '0.3.0';

// English + French stopwords. Real listings mix both, and single-letter
// fragments left over from elisions (l', d', j', qu') are noise, not signal.
const STOPWORDS = new Set([
  // English
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'with',
  'is', 'are', 'be', 'as', 'at', 'by', 'from', 'that', 'this', 'it',
  // French
  'le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'ou', 'a',
  'au', 'aux', 'ce', 'cet', 'cette', 'ces', 'dans', 'pour', 'par', 'sur',
  'avec', 'est', 'sont', 'qui', 'que', 'qu', 'se', 'sa', 'son', 'ses',
  'l', 'd', 'n', 'j', 't', 's', 'c', 'm', 'nous', 'vous', 'leur', 'leurs',
  'votre', 'notre', 'plus', 'tout', 'tous', 'toute', 'toutes', 'ne', 'pas',
]);

// Words that are near-universal in job/business/service listing *chrome* —
// section headers and template filler — rather than content. A naive
// stopword filter leaves these in, and since they appear in almost every
// listing they carry ~0 discriminative signal for matching (same problem
// TF-IDF solves with a real corpus; this is the same idea with a hand-built
// list since we don't have one).
const BOILERPLATE = new Set([
  'details', 'type', 'description', 'about', 'overview', 'summary',
  'role', 'position', 'job', 'company', 'location', 'schedule', 'hours',
  'date', 'duration', 'requirements', 'responsibilities', 'duties',
  'poste', 'societe', 'entreprise', 'apercu', 'resume', 'exigences',
  'responsabilites', 'taches', 'lieu', 'horaire', 'duree', 'contrat',
  'temps', 'travail', 'offre', 'annonce', 'recherche', 'recherchons',
  'cherche', 'cherchons', 'mission', 'profil', 'competences', 'experience',
  // Generic CV/resume filler — high frequency, near-zero discriminative
  // signal (the ATS-style problem: "responsible for" tells you nothing
  // about what someone actually knows, only that they wrote a CV).
  'skills', 'years', 'year', 'including', 'strong', 'excellent', 'good',
  'proficient', 'knowledge', 'ability', 'able', 'working', 'work', 'team',
  'teams', 'including', 'various', 'multiple', 'new', 'also', 'well',
  'including', 'responsible', 'managed', 'using', 'used', 'use', 'made',
  'annees', 'connaissance', 'connaissances', 'capacite', 'excellente',
  'excellent', 'bonne', 'bon', 'equipe', 'equipes', 'divers', 'diverses',
  'nouveau', 'nouvelle', 'egalement', 'utilisant', 'utilise', 'realise',
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

// A CV or listing can easily contain 200+ distinct non-stopword words —
// most of it is one-off filler, not signal. Capping to the most frequent/
// significant terms (like a real ATS keyword extractor would) matters for
// two separate reasons: it's what gets *displayed*, but it's also what
// Jaccard matching actually runs against — an uncapped list dilutes the
// score with noise and makes two genuinely similar profiles look less
// alike than they are, just because one has a longer document.
export const MAX_KEYWORDS = 60;

// Returns unique tokens ranked by frequency (repeated terms are usually the
// point of a document) then length (longer words tend to be more specific/
// technical than short generic ones) — not document order. This is what
// both matching and the displayed "keywords" chips are built from, so a
// word mentioned once in passing doesn't outrank one repeated five times.
export function tokenize(text) {
  const raw = (text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // é→e, à→a — fold, don't delete
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length >= 2) // drops leftover single letters from elisions
    .filter((w) => !/^\d+$/.test(w)) // pure numbers ("90", "100") aren't keywords
    .filter((w) => !STOPWORDS.has(w))
    .filter((w) => !BOILERPLATE.has(w))
    .map((w) => SYNONYMS[w] || w);

  const freq = new Map();
  for (const w of raw) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.keys()]
    .sort((a, b) => (freq.get(b) - freq.get(a)) || (b.length - a.length))
    .slice(0, MAX_KEYWORDS);
}

// The recruiter's seniority range (spec: "année d'ancienneté min/max") is
// checked against the earliest year mentioned anywhere in the candidate's
// CV text — a simple, transparent proxy for "how long ago did they start".
export function extractEarliestYear(text) {
  const matches = [...(text || '').matchAll(/\b(19|20)\d{2}\b/g)].map((m) => parseInt(m[0], 10));
  return matches.length ? Math.min(...matches) : null;
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
