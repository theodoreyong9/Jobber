import type { LLMProvider, RewriteResult, TailoredResume, ValidationIssue } from "../../types";
import { buildResumeSource } from "../resume/buildResumeSource";
import { analyzeJobOffer, guessCompanyName } from "../jobs/analyzeJob";
import { matchSectionsToAdapters } from "../matching/match";
import { buildRewritePlans } from "../rewriting/buildRewritePlan";
import { SYSTEM_RULES, buildUserPrompt } from "../rewriting/prompt";
import { validatePlanOutput } from "../validation/validateOutput";
import { patchDocumentXml, serializeDocx } from "../../docx/patcher";
import { validateDocxBlob, listMediaFiles } from "../../docx/validator";

export interface PipelineJobInput {
  id: string;
  text: string;
  title?: string;
}

export interface PipelineCallbacks {
  onProgress?: (value: number, stage: string) => void;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
}

const MAX_RETRIES = 2;

export async function runPipeline(
  provider: LLMProvider,
  cvArrayBuffer: ArrayBuffer,
  cvFileName: string,
  jobs: PipelineJobInput[],
  callbacks: PipelineCallbacks = {}
): Promise<TailoredResume[]> {
  const { onProgress, onLog } = callbacks;
  const log = (level: "info" | "warn" | "error", msg: string) => onLog?.(level, msg);
  const progress = (v: number, stage: string) => onProgress?.(v, stage);

  progress(2, "Parsing CV");
  const { resumeSource, parsed } = await buildResumeSource(cvArrayBuffer, cvFileName);
  log("info", `DOCX parsed — ${resumeSource.sections.length} sections detected`);
  log("info", `${resumeSource.keywords.length} resume keywords detected`);

  const totalSteps = jobs.length;
  const results: TailoredResume[] = [];

  for (let jobIndex = 0; jobIndex < jobs.length; jobIndex++) {
    const job = jobs[jobIndex];
    const baseProgress = 10 + (jobIndex / totalSteps) * 85;
    progress(baseProgress, `Analyzing job offer ${jobIndex + 1}/${totalSteps}`);

    const company = guessCompanyName(job.text);
    const jobOffer = analyzeJobOffer(job.id, job.text, job.title, company);
    log("info", `Job offer ${jobIndex + 1} detected: ${jobOffer.language}`);
    log("info", `${jobOffer.adapters.length} job adapters detected`);

    const matches = matchSectionsToAdapters(resumeSource, jobOffer.adapters);
    const matchedAdapterCount = matches.reduce((n, m) => n + m.matchedAdapters.length, 0);
    log("info", `${matchedAdapterCount} relevant matches found`);

    const plans = buildRewritePlans(resumeSource, matches, jobOffer.language);

    const allResults: RewriteResult[] = [];
    const allIssues: ValidationIssue[] = [];
    const rejectedParagraphIds: string[] = [];

    for (const plan of plans) {
      log("info", `Rewriting section ${plan.sectionId}`);
      let accepted: RewriteResult[] = [];
      let lastIssues: ValidationIssue[] = [];

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const response = await provider.generate({
          system: SYSTEM_RULES,
          prompt: buildUserPrompt(plan),
          jsonMode: true,
          temperature: 0.2,
          maxTokens: 800,
        });

        const { results: r, issues } = validatePlanOutput(plan, response.text);
        accepted = r;
        lastIssues = issues;

        if (issues.length === 0 || r.length > 0) break;
        log("warn", `Invalid output for ${plan.sectionId}, retry ${attempt + 1}/${MAX_RETRIES}`);
      }

      allResults.push(...accepted);
      allIssues.push(...lastIssues);

      const rejectedIds = plan.paragraphIds.filter((pid) => !accepted.some((a) => a.paragraphId === pid));
      rejectedParagraphIds.push(...rejectedIds);

      if (accepted.length > 0) log("info", `Output validated for ${plan.sectionId}`);
      else log("warn", `Original text preserved for ${plan.sectionId} (validation failed)`);
    }

    progress(baseProgress + 60 / totalSteps, "Patching DOCX");

    // Re-parse a fresh copy of the DOCX for this job so jobs don't interfere.
    const { parsed: freshParsed } = await buildResumeSource(cvArrayBuffer, cvFileName);
    const paragraphIndexOf = (paragraphId: string) => {
      const idx = freshParsed.paragraphs.findIndex((p) => p.id === paragraphId);
      return idx;
    };

    patchDocumentXml(freshParsed.documentXml, allResults, paragraphIndexOf);
    const blob = await serializeDocx(freshParsed.zip, freshParsed.documentXml);

    const mediaFiles = listMediaFiles(parsed.zip);
    const docxValidation = await validateDocxBlob(blob, mediaFiles);
    if (!docxValidation.ok) {
      docxValidation.errors.forEach((e) => log("error", e));
    }
    log("info", "Completed");

    const fileName = buildOutputFileName(cvFileName, jobOffer.company);

    results.push({
      jobId: job.id,
      fileName,
      blob,
      validation: {
        ok: docxValidation.ok && allIssues.length === 0,
        issues: allIssues,
        acceptedResults: allResults,
        rejectedParagraphIds,
      },
    });

    progress(baseProgress + 85 / totalSteps, `Completed job ${jobIndex + 1}/${totalSteps}`);
  }

  progress(100, "Complete");
  return results;
}

function buildOutputFileName(cvFileName: string, company?: string): string {
  const base = cvFileName.replace(/\.docx$/i, "");
  const suffix = company ? ` - ${company}` : "";
  return `${base}${suffix}.docx`;
}
