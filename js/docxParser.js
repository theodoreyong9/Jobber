// Lecture d'un .docx directement dans le navigateur, sans lib de conversion.
// Un .docx est une archive zip. Le texte "riche" vit dans word/document.xml.
// On lit ce XML nous-mêmes pour pouvoir ensuite ré-écrire *uniquement* le
// texte des sections choisies, en gardant intacts styles, images, mise en page.

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export async function loadDocx(file) {
  const zip = await window.JSZip.loadAsync(file);
  const documentXmlPath = "word/document.xml";
  const xmlText = await zip.file(documentXmlPath).async("string");
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, "application/xml");

  const paragraphs = extractParagraphs(xmlDoc);
  const maxFontSize = computeMaxFontSize(paragraphs);

  return { zip, xmlDoc, documentXmlPath, paragraphs, maxFontSize };
}

/**
 * Parcourt tous les <w:p> du document et construit une représentation
 * simplifiée : texte concaténé, taille de police max rencontrée dans le
 * paragraphe (en demi-points, cf. w:sz), si le paragraphe est "tout en gras",
 * nombre de mots, et si le paragraphe contient une image (w:drawing) auquel
 * cas on ne le touchera jamais.
 */
function extractParagraphs(xmlDoc) {
  const pNodes = Array.from(xmlDoc.getElementsByTagNameNS(W_NS, "p"));
  return pNodes.map((pNode, index) => {
    const runNodes = Array.from(pNode.getElementsByTagNameNS(W_NS, "r"));
    let text = "";
    let maxSz = 0;
    let allBold = runNodes.length > 0;
    let hasDrawing = pNode.getElementsByTagNameNS(W_NS, "drawing").length > 0
      || pNode.getElementsByTagName("pic:pic").length > 0;

    const runs = runNodes.map((rNode) => {
      const tNodes = Array.from(rNode.getElementsByTagNameNS(W_NS, "t"));
      const runText = tNodes.map((t) => t.textContent).join("");
      const rPr = rNode.getElementsByTagNameNS(W_NS, "rPr")[0];
      let sz = 0;
      let bold = false;
      if (rPr) {
        const szNode = rPr.getElementsByTagNameNS(W_NS, "sz")[0];
        if (szNode) sz = parseInt(szNode.getAttribute("w:val") || szNode.getAttributeNS(W_NS, "val") || "0", 10);
        const bNode = rPr.getElementsByTagNameNS(W_NS, "b")[0];
        if (bNode) {
          const val = bNode.getAttribute("w:val") ?? bNode.getAttributeNS(W_NS, "val");
          bold = val !== "0" && val !== "false";
        }
      }
      if (sz > maxSz) maxSz = sz;
      if (!bold) allBold = false;
      if (runText.trim().length === 0) {
        // run vide (espacement) : n'invalide pas le "tout en gras"
      }
      text += runText;
      return { node: rNode, text: runText, sz, bold };
    });

    const wordCount = (text.trim().match(/\S+/g) || []).length;

    return {
      index,
      node: pNode,
      runs,
      text: text.trim(),
      maxSz,
      allBold: allBold && runNodes.length > 0,
      wordCount,
      hasDrawing,
    };
  });
}

function computeMaxFontSize(paragraphs) {
  let max = 0;
  for (const p of paragraphs) {
    if (p.maxSz > max) max = p.maxSz;
  }
  return max;
}
