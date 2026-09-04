import type { MatchMap, ResumeSource, RewritePlan } from "../../types";
import { isRewriteCandidate } from "../resume/facts";

export function buildRewritePlans(resume: ResumeSource, matches: MatchMap[], targetLanguage: string): RewritePlan[] {
  const avgFontSize =
    resume.paragraphs.flatMap((p) => p.fontSizes).reduce((a, b) => a + b, 0) /
      Math.max(1, resume.paragraphs.flatMap((p) => p.fontSizes).length) || 11;

  const plans: RewritePlan[] = [];

  for (const match of matches) {
    const section = resume.sections.find((s) => s.id === match.sectionId);
    if (!section) continue;

    const candidateParagraphs = resume.paragraphs.filter(
      (p) => section.paragraphIds.includes(p.id) && isRewriteCandidate(p, avgFontSize)
    );
    if (candidateParagraphs.length === 0) continue;

    const paragraphIds = candidateParagraphs.map((p) => p.id);
    const originalText = candidateParagraphs.map((p) => p.text).join("\n");

    const sourceFacts = resume.facts.filter((f) =>
      f.sourceParagraphIds.some((pid) => paragraphIds.includes(pid))
    );
    const numericFacts = resume.numericFacts.filter((n) => paragraphIds.includes(n.paragraphId));

    plans.push({
      sectionId: section.id,
      paragraphIds,
      originalText,
      sourceFacts,
      numericFacts,
      adapters: match.matchedAdapters,
      targetLanguage,
      constraints: {
        preserveNumbers: true,
        preserveDates: true,
        preserveCompanies: true,
        preserveTechnologies: true,
        noNewFacts: true,
      },
    });
  }

  return plans;
}
