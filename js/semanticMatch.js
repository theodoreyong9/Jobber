// Association "sémantique" mot-à-mot, calculée entièrement côté CPU
// (aucun modèle) : on combine une racine grossière (stemming naïf FR/EN)
// et une similarité de bigrammes (coefficient de Dice) pour rapprocher
// des variantes morphologiques ("gérer" / "gestion", "manage" / "management").

function naiveStem(word) {
  return word
    .toLowerCase()
    .replace(/(tions?|sions?|ments?|ances?|ences?|ités?|ities|ing|ers?|eurs?|euses?|ives?|ité|able|ible)$/i, "")
    .replace(/(s|es)$/i, "")
    .slice(0, Math.max(4, word.length - 2));
}

function bigrams(word) {
  const w = `_${word.toLowerCase()}_`;
  const set = new Set();
  for (let i = 0; i < w.length - 1; i++) set.add(w.slice(i, i + 2));
  return set;
}

function diceCoefficient(a, b) {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 || bb.size === 0) return 0;
  let overlap = 0;
  for (const bg of ba) if (bb.has(bg)) overlap++;
  return (2 * overlap) / (ba.size + bb.size);
}

function similarity(a, b) {
  if (a === b) return 1;
  const stemA = naiveStem(a);
  const stemB = naiveStem(b);
  if (stemA.length >= 3 && stemA === stemB) return 0.9;
  if (a.includes(b) || b.includes(a)) return 0.75;
  return diceCoefficient(a, b);
}

const SIM_THRESHOLD = 0.5;

/**
 * Etape 11 : pour chaque mot-clé unitaire de la liste A, associe au
 * maximum 3 mots de la liste B jugés fortement liés sémantiquement.
 * Retourne une Map<motA, string[]> (mots B associés, triés par pertinence).
 */
export function associateKeywords(listA, listB) {
  const map = new Map();
  for (const a of listA) {
    const scored = listB
      .map((b) => ({ word: b, score: similarity(a, b) }))
      .filter((x) => x.score >= SIM_THRESHOLD)
      .sort((x, y) => y.score - x.score)
      .slice(0, 3)
      .map((x) => x.word);
    if (scored.length > 0) map.set(a, scored);
  }
  return map;
}
