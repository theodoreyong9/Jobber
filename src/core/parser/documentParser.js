// src/core/parser/documentParser.js
//
// Étape CPU §17 : Document -> texte structuré. Aucun appel LLM ici.
// Le support DOCX repose sur mammoth.js (chargé via CDN, cf. index.html),
// volontairement isolé derrière une petite interface pour rester testable
// côté Node (avec un mock) et côté navigateur (avec le vrai mammoth).

/**
 * @typedef {Object} ParsedDocument
 * @property {string} id
 * @property {'cv'|'job'} kind
 * @property {string} rawText
 * @property {string[]} lines
 * @property {{ index: number, text: string }[]} paragraphs
 */

/**
 * Parse un fichier texte brut (.txt) ou du texte collé.
 * @param {string} text
 * @param {'cv'|'job'} kind
 * @param {string} id
 * @returns {ParsedDocument}
 */
export function parsePlainText(text, kind, id) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  const lines = normalized.split('\n').map((l) => l.trim()).filter(Boolean);
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((text, index) => ({ index, text }));

  return {
    id,
    kind,
    rawText: normalized,
    lines,
    paragraphs: paragraphs.length ? paragraphs : lines.map((text, index) => ({ index, text })),
  };
}

/**
 * Parse un fichier DOCX en utilisant mammoth (doit être injecté : dans le
 * navigateur `window.mammoth`, en test un mock compatible).
 * @param {ArrayBuffer} arrayBuffer
 * @param {'cv'|'job'} kind
 * @param {string} id
 * @param {{ extractRawText: (opts: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> }} mammothLib
 * @returns {Promise<ParsedDocument>}
 */
export async function parseDocx(arrayBuffer, kind, id, mammothLib) {
  if (!mammothLib) {
    throw new Error('mammoth.js non disponible : impossible de parser le DOCX.');
  }
  const result = await mammothLib.extractRawText({ arrayBuffer });
  return parsePlainText(result.value, kind, id);
}

/**
 * Point d'entrée générique utilisé par l'UI : décide de la stratégie selon
 * le type de fichier fourni.
 * @param {{ file?: File, text?: string, kind: 'cv'|'job', id: string, mammothLib?: any }} input
 */
export async function parseDocument({ file, text, kind, id, mammothLib }) {
  if (text != null) {
    return parsePlainText(text, kind, id);
  }
  if (!file) {
    throw new Error('parseDocument: fournir soit `file`, soit `text`.');
  }
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.docx')) {
    const buffer = await file.arrayBuffer();
    return parseDocx(buffer, kind, id, mammothLib);
  }
  if (name.endsWith('.txt') || file.type === 'text/plain') {
    const raw = await file.text();
    return parsePlainText(raw, kind, id);
  }
  throw new Error(`Format non supporté en V1 : ${name || file.type}. Utilisez .docx ou .txt.`);
}
