import type { ParagraphFeatures, ResumeSection, ResumeSectionKind } from "../../types";

const SECTION_TITLE_PATTERNS: [ResumeSectionKind, RegExp][] = [
  ["summary", /\b(profil|summary|about me|à propos|profile)\b/i],
  ["experience", /\b(exp[ée]rience|experience|work history|parcours professionnel)\b/i],
  ["education", /\b(formation|education|dipl[oô]mes|studies)\b/i],
  ["skills", /\b(comp[ée]tences|skills|expertise)\b/i],
  ["certifications", /\b(certifications?|certificats?)\b/i],
];

/**
 * Heuristic, deterministic section detection based on font size, bold and
 * short-line signals — no LLM involved. This purposefully stays simple for
 * V1; ambiguous cases fall back to "other" rather than guessing.
 */
export function detectSections(paragraphs: ParagraphFeatures[]): ResumeSection[] {
  const sections: ResumeSection[] = [];
  let current: ResumeSection | null = null;

  const avgFontSize =
    paragraphs.flatMap((p) => p.fontSizes).reduce((a, b) => a + b, 0) /
      Math.max(1, paragraphs.flatMap((p) => p.fontSizes).length) || 11;

  for (const p of paragraphs) {
    const looksLikeHeading =
      p.wordCount > 0 &&
      p.wordCount <= 5 &&
      ((p.maxFontSize ?? avgFontSize) > avgFontSize + 1 || p.bold);

    const kind = looksLikeHeading ? matchTitle(p.text) : null;

    if (kind) {
      current = { id: `section-${sections.length}`, kind, title: p.text.trim(), paragraphIds: [] };
      sections.push(current);
      continue;
    }

    if (p.isContactLike && sections.length === 0) {
      // Header block before any titled section.
      if (!current || current.kind !== "header") {
        current = { id: `section-${sections.length}`, kind: "header", paragraphIds: [] };
        sections.push(current);
      }
      current.paragraphIds.push(p.id);
      continue;
    }

    if (!current) {
      current = { id: `section-${sections.length}`, kind: "other", paragraphIds: [] };
      sections.push(current);
    }
    current.paragraphIds.push(p.id);
  }

  return sections;
}

function matchTitle(text: string): ResumeSectionKind | null {
  for (const [kind, re] of SECTION_TITLE_PATTERNS) {
    if (re.test(text)) return kind;
  }
  return null;
}
