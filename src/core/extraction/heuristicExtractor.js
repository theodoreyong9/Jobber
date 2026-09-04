// src/core/extraction/heuristicExtractor.js
//
// Extraction déterministe CPU (§17, §22). Repère des sections connues par
// mots-clés et produit des ExtractedFact avec provenance. Cette étape ne
// remplace pas WebLLM : elle réduit ce qu'il reste à comprendre
// sémantiquement (§30, §49).

const SECTION_KEYWORDS = {
  skills: [/^compet/i, /^skills?$/i, /^technolog/i, /^stack/i],
  experience: [/^experience/i, /^exp[ée]rience/i, /^parcours/i],
  education: [/^formation/i, /^education/i, /^dipl[oô]me/i],
  languages: [/^langues?$/i, /^languages?$/i],
  domains: [/^domaine/i, /^secteur/i, /^industry/i],
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

  for (const line of sections.domains || []) {
    for (const token of splitListLine(line)) {
      pushFact('domain', token, `domains:"${line.slice(0, 40)}"`);
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

  // Détection grossière de séniorité par mots-clés — sera confirmée/affinée
  // par WebLLM en cas d'ambiguïté (§30).
  const seniorityHints = [
    ['intern', /stage|intern/i],
    ['junior', /junior/i],
    ['senior', /senior|confirm[ée]/i],
    ['lead', /\blead\b|tech ?lead/i],
    ['principal', /principal|staff engineer/i],
    ['executive', /directeur|director|vp|chief|c-level/i],
  ];
  for (const [level, re] of seniorityHints) {
    if (re.test(doc.rawText)) {
      pushFact('seniority_hint', level, 'fulltext:regex');
    }
  }

  // Années d'expérience explicites ("5 ans d'expérience", "5+ years")
  const yearsMatch = doc.rawText.match(/(\d{1,2})\s*\+?\s*(ans|years?)\b/i);
  if (yearsMatch) {
    pushFact('years_of_experience', yearsMatch[1], `fulltext:"${yearsMatch[0]}"`);
  }

  return { facts, sections };
}
