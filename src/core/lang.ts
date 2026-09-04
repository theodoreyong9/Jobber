/**
 * Minimal stopword-frequency language detector. Good enough to route
 * CV/job text to fr/en/de/es without pulling in a heavy dependency.
 * Falls back to "en" when the signal is too weak.
 */
const MARKERS: Record<string, RegExp[]> = {
  fr: [/\ble(s)?\b/i, /\bde(s)?\b/i, /\bet\b/i, /\bexp[ée]rience\b/i, /\bcomp[ée]tences\b/i, /\bformation\b/i],
  en: [/\bthe\b/i, /\band\b/i, /\bexperience\b/i, /\bskills\b/i, /\beducation\b/i],
  de: [/\bund\b/i, /\bder\b/i, /\bdie\b/i, /\berfahrung\b/i, /\bkenntnisse\b/i],
  es: [/\by\b/i, /\bel\b|\bla\b/i, /\bexperiencia\b/i, /\bhabilidades\b/i, /\beducaci[oó]n\b/i],
};

export function detectLanguage(text: string): string {
  const scores: Record<string, number> = { fr: 0, en: 0, de: 0, es: 0 };

  for (const [lang, patterns] of Object.entries(MARKERS)) {
    for (const re of patterns) {
      const matches = text.match(new RegExp(re, "gi"));
      if (matches) scores[lang] += matches.length;
    }
  }

  const [best] = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return best && best[1] > 0 ? best[0] : "en";
}
