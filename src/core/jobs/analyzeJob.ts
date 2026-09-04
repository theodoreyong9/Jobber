import type { JobAdapter, JobKeyword, JobOffer } from "../../types";
import { detectLanguage } from "../lang";

const SENTENCE_SPLIT_RE = /(?<=[.!?;\n])\s+/;

/**
 * Splits sentence into candidate "adapter" phrases: multi-word chunks
 * (3-6 words) that look like meaningful requirements rather than filler.
 */
function extractPhrases(sentence: string): string[] {
  const words = sentence.trim().split(/\s+/).filter(Boolean);
  const phrases: string[] = [];
  const sizes = [3, 4, 5, 6];

  for (const n of sizes) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(" ").replace(/[,:;]$/, "");
      if (phrase.length >= 12) phrases.push(phrase);
    }
  }
  return phrases;
}

export function analyzeJobOffer(id: string, rawText: string, title?: string, company?: string): JobOffer {
  const language = detectLanguage(rawText);
  const sentences = rawText.split(SENTENCE_SPLIT_RE).map((s) => s.trim()).filter(Boolean);

  const adapters: JobAdapter[] = [];
  const seen = new Set<string>();

  for (const sentence of sentences) {
    for (const phrase of extractPhrases(sentence)) {
      const normalized = phrase.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      adapters.push({
        id: `adapter-${adapters.length}`,
        text: phrase,
        normalized,
        sourceSentence: sentence,
      });
    }
  }

  const keywordMap = new Map<string, JobKeyword>();
  for (const word of rawText.match(/[\p{L}\p{N}][\p{L}\p{N}+.#-]*/gu) ?? []) {
    const normalized = word.toLowerCase();
    if (normalized.length < 2) continue;
    if (!keywordMap.has(normalized)) {
      keywordMap.set(normalized, { id: `jkw-${normalized}`, text: word, normalized });
    }
  }

  return {
    id,
    title,
    company,
    rawText,
    language,
    keywords: Array.from(keywordMap.values()),
    adapters,
  };
}

/** Best-effort extraction of a company name from free-text job postings. */
export function guessCompanyName(rawText: string): string | undefined {
  const match = rawText.match(/(?:chez|at|company:|entreprise\s*:?)\s*([A-Z][\w&.-]+(?:\s[A-Z][\w&.-]+){0,2})/);
  return match?.[1];
}
