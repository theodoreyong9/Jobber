import { STOPWORDS } from "./stopwords.js";

/**
 * Détection de langue "CPU only" : on tokenize le texte, et pour chaque
 * langue candidate on compte combien de tokens appartiennent à sa liste
 * de stopwords. La langue avec le plus haut score gagne.
 * Etape 7 : "CPU repère la langue du CV et de l'annonce."
 */
export function detectLanguage(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return "en";

  const scores = {};
  for (const lang of Object.keys(STOPWORDS)) {
    scores[lang] = 0;
  }
  for (const tok of tokens) {
    for (const [lang, set] of Object.entries(STOPWORDS)) {
      if (set.has(tok)) scores[lang]++;
    }
  }

  let best = "en";
  let bestScore = -1;
  for (const [lang, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = lang;
    }
  }
  return best;
}

export function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}
