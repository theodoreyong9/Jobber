// extract.js — real text extraction from .docx and .pdf files, entirely
// client-side. This is what a candidate's CV keywords are actually mined
// from (see app.js's Employment profile editor).
//
// DOCX needs no CDN dependency at all: a .docx is a ZIP archive, and every
// modern browser can inflate ZIP's "deflate" streams natively via
// DecompressionStream. We read the ZIP central directory ourselves (a few
// dozen lines) and hand word/document.xml to DOMParser.
//
// PDF text layout is far more involved (content streams, font encodings,
// cross-reference tables) — that part is delegated to pdf.js, loaded lazily
// from jsdelivr's ESM endpoint, with its worker pinned to the exact version
// that was actually resolved so the two can never mismatch.


/* ---------------------------------------------------------------------- */
/* DOCX — pure browser APIs, no dependency                                 */
/* ---------------------------------------------------------------------- */

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Minimal ZIP reader: walks the End Of Central Directory, then the central
// directory records, to find one named entry and return its bytes.
async function readZipEntry(fileBuffer, entryName) {
  const view = new DataView(fileBuffer);
  const bytes = new Uint8Array(fileBuffer);

  // Find End Of Central Directory signature (0x06054b50), scanning from the end.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 65557; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Not a valid .docx (ZIP end-of-directory not found)');

  const entryCount = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(cdOffset, true) !== 0x02014b50) break; // central dir signature
    const compMethod = view.getUint16(cdOffset + 10, true);
    const compSize = view.getUint32(cdOffset + 20, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localHeaderOffset = view.getUint32(cdOffset + 42, true);
    const name = new TextDecoder().decode(bytes.slice(cdOffset + 46, cdOffset + 46 + nameLen));

    if (name === entryName) {
      const lv = new DataView(fileBuffer, localHeaderOffset);
      const lNameLen = lv.getUint16(26, true);
      const lExtraLen = lv.getUint16(28, true);
      const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
      const raw = bytes.slice(dataStart, dataStart + compSize);
      if (compMethod === 0) return raw; // stored, no compression
      if (compMethod === 8) return inflateRaw(raw); // deflate
      throw new Error(`Unsupported ZIP compression method ${compMethod}`);
    }
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`"${entryName}" not found inside the .docx`);
}

export async function extractDocxText(file) {
  const buffer = await file.arrayBuffer();
  const xmlBytes = await readZipEntry(buffer, 'word/document.xml');
  const xml = new TextDecoder('utf-8').decode(xmlBytes);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Could not parse word/document.xml');

  const paragraphs = [...doc.getElementsByTagName('w:p')];
  const text = paragraphs
    .map((p) => [...p.getElementsByTagName('w:t')].map((t) => t.textContent).join(''))
    .filter(Boolean)
    .join('\n');
  return text;
}

/* ---------------------------------------------------------------------- */
/* PDF — via pdf.js, lazily loaded                                         */
/* ---------------------------------------------------------------------- */
// I can't test this against a real browser from this environment, so it's
// deliberately defensive: two independent CDNs for the library itself, and
// both plausible worker filenames per resolved version, tried in order
// before giving up with a clear message pointing at .docx/.txt instead.

const PDFJS_LIB_CANDIDATES = [
  'https://esm.run/pdfjs-dist',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist/+esm',
];

let pdfjsPromise = null;

async function loadPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;

  pdfjsPromise = (async () => {
    let lib = null;
    let lastLibError = null;
    for (const url of PDFJS_LIB_CANDIDATES) {
      try {
        lib = await import(url);
        break;
      } catch (e) {
        lastLibError = e;
      }
    }
    if (!lib) throw new Error('Could not load the PDF library from any CDN: ' + (lastLibError?.message || 'unknown error'));

    // Pin the worker to the exact version that actually resolved, so main
    // thread and worker are never built from different releases.
    const workerCandidates = lib.version ? [
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${lib.version}/build/pdf.worker.min.mjs`,
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${lib.version}/build/pdf.worker.min.js`,
    ] : [
      'https://cdn.jsdelivr.net/npm/pdfjs-dist/build/pdf.worker.min.mjs',
    ];
    lib.GlobalWorkerOptions.workerSrc = workerCandidates[0];
    return { lib, workerCandidates };
  })();

  return pdfjsPromise;
}

export async function extractPdfText(file) {
  const { lib, workerCandidates } = await loadPdfjs();
  const buffer = await file.arrayBuffer();

  let lastError = null;
  for (const workerSrc of workerCandidates) {
    try {
      lib.GlobalWorkerOptions.workerSrc = workerSrc;
      const doc = await lib.getDocument({ data: buffer }).promise;
      let text = '';
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map((it) => it.str).join(' ') + '\n';
      }
      return text;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error('Could not extract text from this PDF: ' + (lastError?.message || 'unknown error'));
}

/* ---------------------------------------------------------------------- */

export async function extractText(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.docx') || file.type.includes('wordprocessingml')) return extractDocxText(file);
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return extractPdfText(file);
  if (name.endsWith('.txt') || file.type.startsWith('text/')) return file.text();
  throw new Error('Unsupported file type — use .docx, .pdf, or .txt');
}
