import { parseDocx, type ParsedDocx } from "../../docx/parser";
import { detectLanguage } from "../lang";
import type { ResumeSource } from "../../types";
import { detectSections } from "./sections";
import { buildFacts, buildNumericFacts, extractKeywords } from "./facts";

export async function buildResumeSource(
  arrayBuffer: ArrayBuffer,
  fileName: string
): Promise<{ resumeSource: ResumeSource; parsed: ParsedDocx }> {
  const parsed = await parseDocx(arrayBuffer);
  const { paragraphs } = parsed;

  const fullText = paragraphs.map((p) => p.text).join("\n");
  const language = detectLanguage(fullText);

  const sections = detectSections(paragraphs);
  const facts = buildFacts(paragraphs, sections);
  const numericFacts = buildNumericFacts(paragraphs);
  const keywords = extractKeywords(paragraphs, sections);

  const resumeSource: ResumeSource = {
    documentId: crypto.randomUUID(),
    fileName,
    language,
    paragraphs,
    sections,
    experiences: sections
      .filter((s) => s.kind === "experience")
      .map((s, i) => ({ id: `exp-${i}`, sectionId: s.id, paragraphIds: s.paragraphIds })),
    skills: [],
    education: sections
      .filter((s) => s.kind === "education")
      .map((s, i) => ({ id: `edu-${i}`, sectionId: s.id, paragraphIds: s.paragraphIds })),
    facts,
    numericFacts,
    keywords,
  };

  return { resumeSource, parsed };
}
