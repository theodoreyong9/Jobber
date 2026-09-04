import type { NumericFact, ParagraphFeatures, ResumeFact, ResumeKeyword, ResumeSection } from "../../types";

const NUMBER_RE = /\b\d+(?:[.,]\d+)?\s*%?\b/g;

const STOPWORDS_FR = new Set([
  "le", "la", "les", "de", "des", "du", "un", "une", "et", "en", "à", "au", "aux",
  "pour", "dans", "sur", "avec", "par", "ce", "ces", "sa", "son", "ses", "que", "qui",
]);
const STOPWORDS_EN = new Set([
  "the", "a", "an", "of", "and", "to", "in", "on", "for", "with", "by", "this",
  "these", "that", "which", "as", "at", "is", "are", "was", "were",
]);
const STOPWORDS = new Set([...STOPWORDS_FR, ...STOPWORDS_EN]);

/** Which paragraphs are candidates for rewriting, per the inclusion/exclusion rules. */
export function isRewriteCandidate(p: ParagraphFeatures, avgFontSize: number): boolean {
  if (p.isContactLike) return false;
  if (p.containsEmail || p.containsPhone || p.containsUrl) return false;
  if (p.wordCount < 3) return false;

  const strongSignal = p.containsDate || (p.maxFontSize ?? 0) > avgFontSize;
  const boldAlone = p.bold && !strongSignal;

  if (boldAlone && p.wordCount < 6) return false; // likely a short bold label only

  return true;
}

/** Every rewrite candidate paragraph becomes one atomic, source-of-truth fact. */
export function buildFacts(paragraphs: ParagraphFeatures[], sections: ResumeSection[]): ResumeFact[] {
  const sectionOf = new Map<string, string>();
  for (const s of sections) for (const pid of s.paragraphIds) sectionOf.set(pid, s.id);

  return paragraphs
    .filter((p) => p.text.trim().length > 0)
    .map((p) => ({
      id: `fact-${p.id}`,
      text: p.text.trim(),
      sourceParagraphIds: [p.id],
      sourceSectionId: sectionOf.get(p.id) ?? "unknown",
    }));
}

export function buildNumericFacts(paragraphs: ParagraphFeatures[]): NumericFact[] {
  const facts: NumericFact[] = [];
  for (const p of paragraphs) {
    const matches = p.text.match(NUMBER_RE);
    if (!matches) continue;
    for (const value of matches) {
      facts.push({ value, context: p.text.trim(), paragraphId: p.id });
    }
  }
  return facts;
}

/** Deterministic keyword extraction: tokenize, drop stopwords, count occurrences. */
export function extractKeywords(paragraphs: ParagraphFeatures[], sections: ResumeSection[]): ResumeKeyword[] {
  const sectionOf = new Map<string, string>();
  for (const s of sections) for (const pid of s.paragraphIds) sectionOf.set(pid, s.id);

  const counts = new Map<string, ResumeKeyword>();

  for (const p of paragraphs) {
    const tokens = tokenize(p.text);
    for (const tok of tokens) {
      const normalized = tok.toLowerCase();
      if (STOPWORDS.has(normalized) || normalized.length < 2) continue;

      const existing = counts.get(normalized);
      if (existing) {
        existing.occurrences += 1;
        if (!existing.paragraphIds.includes(p.id)) existing.paragraphIds.push(p.id);
      } else {
        counts.set(normalized, {
          id: `kw-${normalized}`,
          text: tok,
          normalized,
          sectionId: sectionOf.get(p.id) ?? "unknown",
          paragraphIds: [p.id],
          occurrences: 1,
        });
      }
    }

    // Also keep 2-3 word technical-looking n-grams (capitalized or with digits).
    for (const ngram of extractNgrams(p.text, 2, 3)) {
      const normalized = ngram.toLowerCase();
      if (!/[A-Z]/.test(ngram) && !/\d/.test(ngram)) continue;
      const existing = counts.get(normalized);
      if (existing) {
        existing.occurrences += 1;
      } else {
        counts.set(normalized, {
          id: `kw-${normalized.replace(/\s+/g, "-")}`,
          text: ngram,
          normalized,
          sectionId: sectionOf.get(p.id) ?? "unknown",
          paragraphIds: [p.id],
          occurrences: 1,
        });
      }
    }
  }

  return Array.from(counts.values()).sort((a, b) => b.occurrences - a.occurrences);
}

function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}+.#-]*/gu) ?? [];
}

function extractNgrams(text: string, min: number, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const grams: string[] = [];
  for (let n = min; n <= max; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      grams.push(words.slice(i, i + n).join(" "));
    }
  }
  return grams;
}
