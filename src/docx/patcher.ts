import type JSZip from "jszip";
import type { RewriteResult } from "../types";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export interface PatchTarget {
  paragraphIndex: number;
  text: string;
}

/**
 * Applies validated rewrite results onto the original document.xml DOM.
 * Only the targeted paragraphs are touched. Every other node (images,
 * tables, headers, footers, styles, non-targeted paragraphs) is left
 * strictly untouched.
 *
 * Strategy for a targeted paragraph:
 *  - keep the paragraph's <w:pPr> (alignment, spacing, numbering...) intact
 *  - keep the *first* run's <w:rPr> (font, bold, color...) as the carrier
 *    of the new text
 *  - remove any additional runs that only existed to hold the old text
 * This trades fine-grained inline-style fidelity for guaranteed structural
 * validity, per the V1 priority order (layout > images > tables > styles >
 * targeted text).
 */
export function patchDocumentXml(documentXml: Document, results: RewriteResult[], paragraphIndexOf: (paragraphId: string) => number): void {
  const paragraphNodes = Array.from(documentXml.getElementsByTagNameNS(W_NS, "p"));

  for (const result of results) {
    const idx = paragraphIndexOf(result.paragraphId);
    const p = paragraphNodes[idx];
    if (!p) continue; // unknown paragraph — validator should have caught this already

    const runs = Array.from(p.getElementsByTagNameNS(W_NS, "r"));
    if (runs.length === 0) continue;

    const [firstRun, ...restRuns] = runs;

    // Remove all <w:t> from the first run, then re-add a single one.
    Array.from(firstRun.getElementsByTagNameNS(W_NS, "t")).forEach((t) => t.remove());
    const newT = documentXml.createElementNS(W_NS, "w:t");
    newT.setAttribute("xml:space", "preserve");
    newT.textContent = result.text;
    firstRun.appendChild(newT);

    // Drop remaining runs entirely (their text is now redundant).
    for (const run of restRuns) {
      run.remove();
    }
  }
}

export async function serializeDocx(zip: JSZip, documentXml: Document): Promise<Blob> {
  const serializer = new XMLSerializer();
  const xmlString = serializer.serializeToString(documentXml);
  zip.file("word/document.xml", xmlString);
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
