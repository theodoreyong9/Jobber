import type { JobAdapter, MatchMap, ResumeSection, ResumeSource } from "../../types";

const MAX_ADAPTERS_PER_SECTION = 3;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9\s+#.-]/g, "")
    .trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(normalize(text).split(/\s+/).filter(Boolean));
}

/** Simple token-overlap similarity (Jaccard), cheap and deterministic. */
function similarity(a: string, b: string): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const tok of setA) if (setB.has(tok)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * For each resume section, find the job adapters whose wording overlaps
 * with the section's own keywords/text — i.e. content Jobber is allowed
 * to *echo back*, never content it invents. Capped at 3 per section to
 * keep prompts small and avoid forcing unrelated keywords in.
 */
export function matchSectionsToAdapters(resume: ResumeSource, adapters: JobAdapter[]): MatchMap[] {
  const results: MatchMap[] = [];

  for (const section of resume.sections) {
    if (section.kind === "header") continue;

    const sectionText = resume.paragraphs
      .filter((p) => section.paragraphIds.includes(p.id))
      .map((p) => p.text)
      .join(" ");

    if (!sectionText.trim()) continue;

    const scored = adapters
      .map((adapter) => ({ adapter, score: similarity(sectionText, adapter.text) }))
      .filter((s) => s.score > 0.08) // require some genuine lexical overlap
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_ADAPTERS_PER_SECTION);

    if (scored.length > 0) {
      results.push({ sectionId: section.id, matchedAdapters: scored.map((s) => s.adapter) });
    }
  }

  return results;
}

export function sectionById(sections: ResumeSection[], id: string): ResumeSection | undefined {
  return sections.find((s) => s.id === id);
}
