import type { RewritePlan, RewriteResult, ValidationIssue } from "../../types";

const NUMBER_RE = /\b\d+(?:[.,]\d+)?\s*%?\b/g;
const MAX_LENGTH_RATIO = 1.8; // rewritten text can't balloon past this vs. original

interface RawLLMOutput {
  sectionId?: string;
  rewrites?: { paragraphId?: string; text?: string }[];
}

export function parseLLMJson(raw: string): RawLLMOutput | null {
  // Models sometimes wrap JSON in ```json fences despite instructions; strip defensively.
  const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export function validatePlanOutput(
  plan: RewritePlan,
  raw: string
): { results: RewriteResult[]; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const parsed = parseLLMJson(raw);

  if (!parsed || !Array.isArray(parsed.rewrites)) {
    return {
      results: [],
      issues: [{ paragraphId: plan.paragraphIds.join(","), code: "invalid_json", detail: "Output was not valid JSON." }],
    };
  }

  const originalByParagraph = new Map<string, string>();
  const originalLines = plan.originalText.split("\n");
  plan.paragraphIds.forEach((pid, i) => originalByParagraph.set(pid, originalLines[i] ?? plan.originalText));

  const accepted: RewriteResult[] = [];

  for (const rewrite of parsed.rewrites) {
    const paragraphId = rewrite.paragraphId;
    const text = rewrite.text;

    if (!paragraphId || typeof text !== "string") {
      issues.push({ paragraphId: paragraphId ?? "unknown", code: "invalid_json", detail: "Missing paragraphId or text." });
      continue;
    }

    if (!plan.paragraphIds.includes(paragraphId)) {
      issues.push({ paragraphId, code: "unknown_paragraph", detail: "paragraphId not part of this plan." });
      continue;
    }

    const original = originalByParagraph.get(paragraphId) ?? "";

    if (plan.constraints.preserveNumbers) {
      const origNumbers = (original.match(NUMBER_RE) ?? []).sort();
      const newNumbers = (text.match(NUMBER_RE) ?? []).sort();
      const numbersChanged =
        origNumbers.length > 0 &&
        JSON.stringify(origNumbers) !== JSON.stringify(newNumbers);
      if (numbersChanged) {
        issues.push({ paragraphId, code: "number_changed", detail: `Numbers changed: ${origNumbers.join(",")} -> ${newNumbers.join(",")}` });
        continue;
      }
    }

    if (original.length > 0 && text.length > original.length * MAX_LENGTH_RATIO) {
      issues.push({ paragraphId, code: "length_exploded", detail: `Rewrite is ${text.length} chars vs original ${original.length}.` });
      continue;
    }

    accepted.push({ paragraphId, text });
  }

  return { results: accepted, issues };
}
