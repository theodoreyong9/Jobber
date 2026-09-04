import JSZip from "jszip";

export interface DocxValidationResult {
  ok: boolean;
  errors: string[];
}

const REQUIRED_PARTS = [
  "[Content_Types].xml",
  "_rels/.rels",
  "word/document.xml",
];

/**
 * Re-opens the generated blob to make sure the ZIP/XML/relationships are
 * intact and media files were not lost during patching.
 */
export async function validateDocxBlob(blob: Blob, expectedMediaFiles: string[]): Promise<DocxValidationResult> {
  const errors: string[] = [];

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(blob);
  } catch (e) {
    return { ok: false, errors: [`ZIP is not valid: ${(e as Error).message}`] };
  }

  for (const part of REQUIRED_PARTS) {
    if (!zip.file(part)) errors.push(`Missing required part: ${part}`);
  }

  const docXml = zip.file("word/document.xml");
  if (docXml) {
    try {
      const text = await docXml.async("string");
      const parsed = new DOMParser().parseFromString(text, "application/xml");
      if (parsed.getElementsByTagName("parsererror").length > 0) {
        errors.push("word/document.xml failed to re-parse as XML.");
      }
    } catch (e) {
      errors.push(`word/document.xml could not be read: ${(e as Error).message}`);
    }
  }

  for (const media of expectedMediaFiles) {
    if (!zip.file(media)) errors.push(`Media file lost during patch: ${media}`);
  }

  return { ok: errors.length === 0, errors };
}

export function listMediaFiles(zip: JSZip): string[] {
  return Object.keys(zip.files).filter((name) => name.startsWith("word/media/"));
}
