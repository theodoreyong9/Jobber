import JSZip from "jszip";
import type { ParagraphFeatures } from "../types";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export interface ParsedDocx {
  zip: JSZip;
  documentXml: Document;
  paragraphs: ParagraphFeatures[];
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /(\+?\d[\d\s.\-()]{7,}\d)/;
const URL_RE = /\bhttps?:\/\/|www\./i;
const DATE_RE =
  /\b(20\d{2}|19\d{2})\b|\b(0?[1-9]|1[0-2])\/(20\d{2}|19\d{2})\b|\b(jan(v)?|f[ée]v|mar(s)?|avr|mai|juin?|juil|ao[uû]t|sep(t)?|oct|nov|d[ée]c|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

export async function parseDocx(arrayBuffer: ArrayBuffer): Promise<ParsedDocx> {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const documentPart = zip.file("word/document.xml");
  if (!documentPart) throw new Error("Invalid DOCX: word/document.xml not found.");

  const xmlText = await documentPart.async("string");
  const documentXml = new DOMParser().parseFromString(xmlText, "application/xml");

  const paragraphNodes = Array.from(documentXml.getElementsByTagNameNS(W_NS, "p"));

  const paragraphs: ParagraphFeatures[] = paragraphNodes.map((p, index) =>
    extractParagraphFeatures(p, index)
  );

  return { zip, documentXml, paragraphs };
}

function extractParagraphFeatures(p: Element, index: number): ParagraphFeatures {
  const runs = Array.from(p.getElementsByTagNameNS(W_NS, "r"));
  const texts = Array.from(p.getElementsByTagNameNS(W_NS, "t")).map((t) => t.textContent ?? "");
  const text = texts.join("");

  let bold = false;
  let italic = false;
  const fontSizes: number[] = [];

  for (const run of runs) {
    const rPr = run.getElementsByTagNameNS(W_NS, "rPr")[0];
    if (!rPr) continue;
    if (rPr.getElementsByTagNameNS(W_NS, "b").length > 0) bold = true;
    if (rPr.getElementsByTagNameNS(W_NS, "i").length > 0) italic = true;
    const szEl = rPr.getElementsByTagNameNS(W_NS, "sz")[0];
    if (szEl) {
      const val = szEl.getAttributeNS(W_NS, "val");
      if (val) fontSizes.push(Number(val) / 2); // half-points -> points
    }
  }

  const pPr = p.getElementsByTagNameNS(W_NS, "pPr")[0];
  const pStyle = pPr?.getElementsByTagNameNS(W_NS, "pStyle")[0];
  const styleId = pStyle?.getAttributeNS(W_NS, "val") ?? undefined;
  const numPr = pPr?.getElementsByTagNameNS(W_NS, "numPr")[0];
  const numId = numPr?.getElementsByTagNameNS(W_NS, "numId")[0];
  const numberingId = numId?.getAttributeNS(W_NS, "val") ?? undefined;

  const wordCount = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;

  const containsEmail = EMAIL_RE.test(text);
  const containsPhone = PHONE_RE.test(text);
  const containsUrl = URL_RE.test(text);
  const containsDate = DATE_RE.test(text);

  const isContactLike = containsEmail || containsPhone || (containsUrl && wordCount < 6);

  return {
    id: `p-${index}`,
    text,
    wordCount,
    bold,
    italic,
    fontSizes,
    maxFontSize: fontSizes.length ? Math.max(...fontSizes) : undefined,
    styleId,
    numberingId,
    containsDate,
    containsEmail,
    containsPhone,
    containsUrl,
    isContactLike,
    xmlPath: { partName: "word/document.xml", paragraphIndex: index },
  };
}
