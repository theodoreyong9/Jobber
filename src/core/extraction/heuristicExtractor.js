// src/core/extraction/heuristicExtractor.js
//
// Extraction déterministe CPU (§17, §22). PAS de listes de villes/secteurs
// pour deviner une localisation ou un domaine : ça n'a jamais été une vraie
// comparaison, juste un dictionnaire figé qui prétend couvrir un monde
// ouvert. Ce que le CPU extrait ici, ce sont des MOTS-CLÉS bruts (section
// "Compétences", langues explicitement nommées) — comparés tels quels des
// deux côtés (candidat et annonce), sans catégorie intermédiaire.
//
// La ville et l'ancienneté minimale ne sont PAS devinées par mots-clés :
// elles sont des champs explicites saisis par l'utilisateur (voir
// buildProfile.js et l'UI). Seule l'ancienneté DU CANDIDAT est estimée ici,
// à partir de dates réellement présentes dans son CV (voir
// `extractEarliestYear`), pas d'un dictionnaire.

const SECTION_KEYWORDS = {
  skills: [/^compet/i, /^skills?$/i, /^technolog/i, /^stack/i],
  experience: [/^experience/i, /^exp[ée]rience/i, /^parcours/i],
  education: [/^formation/i, /^education/i, /^dipl[oô]me/i],
  languages: [/^langues?$/i, /^languages?$/i],
};

const LANGUAGE_HINTS = [
  'francais', 'french', 'anglais', 'english', 'espagnol', 'spanish',
  'allemand', 'german', 'italien', 'italian', 'portugais', 'portuguese',
  'mandarin', 'chinois', 'chinese', 'arabe', 'arabic', 'neerlandais', 'dutch',
];

let factCounter = 0;
function nextFactId() {
  factCounter += 1;
  return `fact_${Date.now()}_${factCounter}`;
}

/**
 * Découpe un document en sections approximatives à partir de titres connus.
 * @param {import('../parser/documentParser.js').ParsedDocument} doc
 */
function splitSections(doc) {
  /** @type {Record<string, string[]>} */
  const sections = { other: [] };
  let current = 'other';

  for (const line of doc.lines) {
    const stripped = line.replace(/[:：]\s*$/, '');
    const asciiStripped = stripped.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    let matchedKey = null;
    for (const [key, patterns] of Object.entries(SECTION_KEYWORDS)) {
      if (patterns.some((re) => re.test(asciiStripped))) {
        matchedKey = key;
        break;
      }
    }
    if (matchedKey) {
      current = matchedKey;
      sections[current] = sections[current] || [];
      continue;
    }
    sections[current] = sections[current] || [];
    sections[current].push(line);
  }
  return sections;
}

function splitListLine(line) {
  return line
    .split(/[,•;·|\/]| - /)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && s.length < 60);
}

/**
 * Cherche toutes les années à 4 chiffres plausibles (1950-aujourd'hui)
 * mentionnées dans le texte (typiquement des dates d'expérience : "2018 -
 * 2021 Data Analyst...") et renvoie la plus ancienne. Sert à ESTIMER
 * l'ancienneté du candidat à partir de dates réelles de son CV, plutôt que
 * d'un motif de phrase fragile ("5 ans d'expérience" absent la plupart du
 * temps). Renvoie null si aucune année plausible n'est trouvée.
 * @param {string} text
 */
function extractEarliestYear(text) {
  const currentYear = new Date().getFullYear();
  const matches = text.match(/\b(19[5-9]\d|20[0-4]\d)\b/g);
  if (!matches) return null;
  const years = matches.map(Number).filter((y) => y <= currentYear);
  if (years.length === 0) return null;
  return Math.min(...years);
}

/**
 * Extraction heuristique complète d'un document parsé.
 * @param {import('../parser/documentParser.js').ParsedDocument} doc
 * @returns {{ facts: import('../validation/schema.js').ExtractedFact[], sections: Record<string,string[]> }}
 */
export function extractFacts(doc) {
  const sections = splitSections(doc);
  const facts = [];

  const pushFact = (field, value, sourceLocation) => {
    facts.push({
      id: nextFactId(),
      field,
      value,
      sourceDocumentId: doc.id,
      sourceLocation,
    });
  };

  for (const line of sections.skills || []) {
    for (const token of splitListLine(line)) {
      pushFact('skill', token, `skills:"${line.slice(0, 40)}"`);
    }
  }

  for (const line of sections.experience || []) {
    if (line.length > 3) {
      pushFact('experience_line', line, `experience:"${line.slice(0, 40)}"`);
    }
  }

  for (const line of sections.education || []) {
    if (line.length > 3) {
      pushFact('education_line', line, `education:"${line.slice(0, 40)}"`);
    }
  }

  const fullTextLower = doc.rawText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const lang of LANGUAGE_HINTS) {
    if (fullTextLower.includes(lang)) {
      pushFact('language', lang, `fulltext:contains("${lang}")`);
    }
  }

  // Années d'expérience explicites ("5 ans d'expérience", "5+ years") —
  // signal préféré quand il est présent, plus direct qu'une estimation.
  const yearsMatch = doc.rawText.match(/(\d{1,2})\s*\+?\s*(ans|years?)\b/i);
  if (yearsMatch) {
    pushFact('years_of_experience', yearsMatch[1], `fulltext:"${yearsMatch[0]}"`);
  }

  // Repli : estimation à partir de la date la plus ancienne réellement
  // trouvée dans le texte (§ demande : calcul réel, pas une liste devinée).
  const earliestYear = extractEarliestYear(doc.rawText);
  if (earliestYear != null) {
    pushFact('earliest_year_mention', String(earliestYear), `fulltext:year(${earliestYear})`);
  }

  return { facts, sections };
}
