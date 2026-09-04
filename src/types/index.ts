// ============================================================================
// JOBBER — Core data models
// ============================================================================

// ---- LLM abstraction -------------------------------------------------------

export type EngineKind = "webllm" | "local";

export interface ModelInfo {
  id: string;
  name: string;
  provider: EngineKind;
  size?: string;
  contextLength?: number;
  capabilities: {
    multilingual: boolean;
    json: boolean;
    rewriting: boolean;
  };
  recommendation?: "recommended" | "heavy" | "limited" | "unsupported";
  note?: string;
}

export interface LLMRequest {
  system: string;
  prompt: string;
  /** Ask the provider to constrain output to JSON when supported. */
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMResponse {
  text: string;
  raw?: unknown;
}

export interface LLMProvider {
  listModels(): Promise<ModelInfo[]>;
  load(modelId: string, onProgress?: (pct: number, text: string) => void): Promise<void>;
  generate(request: LLMRequest): Promise<LLMResponse>;
  destroy(): Promise<void>;
}

// ---- DOCX / Resume structure ------------------------------------------------

export interface ParagraphFeatures {
  id: string;
  text: string;
  sectionId?: string;

  wordCount: number;

  bold: boolean;
  italic: boolean;

  fontSizes: number[];
  maxFontSize?: number;

  styleId?: string;
  numberingId?: string;

  containsDate: boolean;
  containsEmail: boolean;
  containsPhone: boolean;
  containsUrl: boolean;

  isContactLike: boolean;

  /** Location used by the DOCX mapper/patcher to find this paragraph again. */
  xmlPath: {
    partName: string; // e.g. "word/document.xml"
    paragraphIndex: number;
  };
}

export type ResumeSectionKind =
  | "header"
  | "summary"
  | "experience"
  | "education"
  | "skills"
  | "certifications"
  | "other";

export interface ResumeSection {
  id: string;
  kind: ResumeSectionKind;
  title?: string;
  paragraphIds: string[];
}

export interface ResumeExperience {
  id: string;
  sectionId: string;
  paragraphIds: string[];
  title?: string;
  company?: string;
}

export interface ResumeSkill {
  id: string;
  text: string;
  sectionId: string;
}

export interface ResumeEducation {
  id: string;
  sectionId: string;
  paragraphIds: string[];
}

export interface ResumeFact {
  id: string;
  text: string;
  sourceParagraphIds: string[];
  sourceSectionId: string;
}

export interface NumericFact {
  value: string;
  context: string;
  paragraphId: string;
}

export interface ResumeKeyword {
  id: string;
  text: string;
  normalized: string;
  sectionId: string;
  paragraphIds: string[];
  occurrences: number;
}

export interface ResumeSource {
  documentId: string;
  fileName: string;
  language: string;
  paragraphs: ParagraphFeatures[];
  sections: ResumeSection[];
  experiences: ResumeExperience[];
  skills: ResumeSkill[];
  education: ResumeEducation[];
  facts: ResumeFact[];
  numericFacts: NumericFact[];
  keywords: ResumeKeyword[];
}

// ---- Job offer ---------------------------------------------------------------

export interface JobAdapter {
  id: string;
  text: string;
  normalized: string;
  sourceSentence: string;
  sourceParagraphId?: string;
}

export interface JobKeyword {
  id: string;
  text: string;
  normalized: string;
}

export interface JobOffer {
  id: string;
  title?: string;
  company?: string;
  rawText: string;
  language: string;
  keywords: JobKeyword[];
  adapters: JobAdapter[];
}

// ---- Matching / Rewrite plan ---------------------------------------------------

export interface MatchMap {
  sectionId: string;
  matchedAdapters: JobAdapter[];
}

export interface RewritePlan {
  sectionId: string;
  paragraphIds: string[];

  originalText: string;

  sourceFacts: ResumeFact[];
  numericFacts: NumericFact[];

  adapters: JobAdapter[]; // max 3

  targetLanguage: string;

  constraints: {
    preserveNumbers: boolean;
    preserveDates: boolean;
    preserveCompanies: boolean;
    preserveTechnologies: boolean;
    noNewFacts: boolean;
  };
}

export interface RewriteResult {
  paragraphId: string;
  text: string;
}

export interface ValidationIssue {
  paragraphId: string;
  code:
    | "number_changed"
    | "date_changed"
    | "company_changed"
    | "technology_added"
    | "length_exploded"
    | "unknown_paragraph"
    | "invalid_json";
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  acceptedResults: RewriteResult[];
  rejectedParagraphIds: string[];
}

export interface TailoredResume {
  jobId: string;
  fileName: string;
  blob: Blob;
  validation: ValidationResult;
}

// ---- Worker protocol -----------------------------------------------------

export type WorkerMessage =
  | { type: "progress"; value: number; stage: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "result"; result: TailoredResume[] }
  | { type: "error"; error: string };

export type WorkerCommand =
  | {
      type: "run";
      engine: EngineKind;
      modelId: string;
      cvArrayBuffer: ArrayBuffer;
      cvFileName: string;
      jobs: { id: string; text: string; title?: string }[];
    }
  | { type: "listModels"; engine: EngineKind };
