import { CONTACT_HINTS } from "./stopwords.js";

// Motifs de dates bilingues FR/EN suffisamment larges : "2019 - 2021",
// "janvier 2020 – présent", "Jan 2020 - Present", "03/2019", "2020-now"...
const DATE_PATTERNS = [
  /\b(19|20)\d{2}\s*[-–—até]{1,4}\s*((19|20)\d{2}|présent|present|now|aujourd'hui|actuel)\b/i,
  /\b(19|20)\d{2}\b/, // année isolée
  /\b\d{1,2}\/\d{4}\b/, // mm/yyyy
  /\b(jan(vier)?|fév(rier)?|mars|avr(il)?|mai|juin|juil(let)?|août|sept(embre)?|oct(obre)?|nov(embre)?|déc(embre)?|january|february|march|april|may|june|july|august|september|october|november|december)\.?\s+(19|20)\d{2}\b/i,
];

function hasDatePattern(text) {
  return DATE_PATTERNS.some((re) => re.test(text));
}

function isContactInfo(text) {
  return CONTACT_HINTS.some((re) => re.test(text));
}

/**
 * Etape 8 : détermine si un paragraphe doit être considéré comme du
 * "contenu utile" du CV.
 *
 * Inclusion (au moins un critère) :
 *   - contient une date, OU
 *   - est écrit dans la plus grande police du document, OU
 *   - fait plus de 10 mots
 *
 * Exclusion (n'importe lequel disqualifie) :
 *   - ressemble à des coordonnées (email, tel, url...)
 *   - fait moins de 3 mots
 *   - est intégralement en gras, SAUF si sa police est la plus grande du document
 */
function isEligibleContent(p, maxFontSize) {
  if (p.hasDrawing) return false;
  if (p.text.length === 0) return false;

  const isMaxFont = maxFontSize > 0 && p.maxSz === maxFontSize;

  const included = hasDatePattern(p.text) || isMaxFont || p.wordCount > 10;
  if (!included) return false;

  if (isContactInfo(p.text)) return false;
  if (p.wordCount < 3) return false;
  if (p.allBold && !isMaxFont) return false;

  return true;
}

/**
 * Regroupe les paragraphes du CV en sections.
 * Les paragraphes écrits dans la plus grande police du document et
 * relativement courts (<= 8 mots) sont traités comme des titres de section
 * ("EXPERIENCE", "FORMATION", ...) et servent uniquement de repères
 * structurels : ils ne sont pas envoyés à réécrire.
 * Tout le contenu éligible qui suit un titre lui est rattaché, jusqu'au
 * titre suivant. Le contenu éligible trouvé avant le premier titre est
 * placé dans une section "Introduction".
 */
export function extractSections(paragraphs, maxFontSize) {
  const sections = [];
  let current = { title: "Introduction", paragraphs: [] };

  const isHeading = (p) =>
    maxFontSize > 0 && p.maxSz === maxFontSize && p.wordCount <= 8 && p.text.length > 0;

  for (const p of paragraphs) {
    if (isHeading(p)) {
      if (current.paragraphs.length > 0) sections.push(current);
      current = { title: p.text, paragraphs: [] };
      continue;
    }
    if (isEligibleContent(p, maxFontSize)) {
      current.paragraphs.push(p);
    }
  }
  if (current.paragraphs.length > 0) sections.push(current);

  // Ignore les sections vides et fusionne le texte de chaque section
  return sections
    .filter((s) => s.paragraphs.length > 0)
    .map((s, i) => ({
      id: `section-${i}`,
      title: s.title,
      paragraphs: s.paragraphs,
      text: s.paragraphs.map((p) => p.text).join(" "),
    }));
}
