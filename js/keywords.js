import { STOPWORDS } from "./stopwords.js";
import { tokenize } from "./langDetect.js";

function stopwordSetFor(lang) {
  return STOPWORDS[lang] || STOPWORDS.en;
}

function isKeywordCandidate(token) {
  if (token.length < 3) return false;
  if (/^\d+$/.test(token)) return false; // les nombres purs sont gérés à part (conservation des chiffres)
  return true;
}

/**
 * Etape 9 : liste A = tous les mots-clés uniques des sections du CV.
 */
export function buildKeywordListA(sections, lang) {
  const stop = stopwordSetFor(lang);
  const set = new Set();
  for (const section of sections) {
    for (const tok of tokenize(section.text)) {
      if (!stop.has(tok) && isKeywordCandidate(tok)) set.add(tok);
    }
  }
  return Array.from(set);
}

/**
 * Découpage naïf en phrases (FR/EN) sur . ! ? ; ainsi que sauts de ligne et puces.
 */
function splitSentences(text) {
  return text
    .split(/(?<=[.!?;])\s+|\n+|•|·|-\s{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Etape 10 : pour une annonce donnée, liste B = tous les mots-clés
 * contenus dans des phrases de plus de 3 mots ("adapteurs").
 */
export function buildKeywordListB(adText, lang) {
  const stop = stopwordSetFor(lang);
  const sentences = splitSentences(adText).filter(
    (s) => (s.match(/\S+/g) || []).length > 3
  );
  const set = new Set();
  for (const sentence of sentences) {
    for (const tok of tokenize(sentence)) {
      if (!stop.has(tok) && isKeywordCandidate(tok)) set.add(tok);
    }
  }
  return { keywords: Array.from(set), adapterSentences: sentences };
}
