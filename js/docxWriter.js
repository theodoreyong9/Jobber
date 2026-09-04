// Réinjecte le texte réécrit dans le document.xml original, sans toucher
// à quoi que ce soit d'autre (styles, images, sauts de page, en-têtes...).
//
// Point d'attention (étape 16) : Word refuse d'ouvrir / propose une
// réparation si le XML est mal formé (entités & < > non échappées,
// espaces significatifs perdus, etc). On évite ça en ne manipulant JAMAIS
// de chaînes XML à la main : on passe toujours par `textContent` du DOM,
// qui échappe automatiquement les caractères spéciaux, et on préserve les
// espaces avec xml:space="preserve".

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/**
 * Répartit le texte généré par le LLM sur les paragraphes originaux d'une
 * section : le prompt (voir main.js) demande une ligne par paragraphe
 * d'origine, séparées par des retours à la ligne.
 */
function distributeTextOverParagraphs(paragraphs, generatedText) {
  const lines = generatedText
    .split(/\r?\n+/)
    .map((l) => l.replace(/^[-•·\s]+/, "").trim())
    .filter(Boolean);

  if (lines.length === 0) return;

  if (lines.length >= paragraphs.length) {
    // Fusionne les lignes en trop dans le dernier paragraphe
    const head = lines.slice(0, paragraphs.length - 1);
    const tail = lines.slice(paragraphs.length - 1).join(" ");
    const finalLines = [...head, tail];
    paragraphs.forEach((p, i) => writeParagraphText(p, finalLines[i] ?? ""));
  } else {
    // Moins de lignes que de paragraphes : on remplit les premiers,
    // on vide les paragraphes restants (on garde leur formatage intact
    // mais sans texte, pour ne pas casser la mise en page).
    paragraphs.forEach((p, i) => writeParagraphText(p, lines[i] ?? ""));
  }
}

function writeParagraphText(paragraph, newText) {
  if (!paragraph.runs || paragraph.runs.length === 0) return;

  const templateRun = paragraph.runs[0];
  const tNodes = Array.from(templateRun.node.getElementsByTagNameNS(W_NS, "t"));
  let tNode = tNodes[0];
  if (!tNode) {
    tNode = templateRun.node.ownerDocument.createElementNS(W_NS, "w:t");
    templateRun.node.appendChild(tNode);
  }
  // textContent échappe automatiquement & < > lors de la sérialisation XML
  tNode.textContent = newText;
  tNode.setAttribute("xml:space", "preserve");
  // Supprime d'éventuels <w:t> superflus dans le même run
  for (let i = 1; i < tNodes.length; i++) tNodes[i].remove();

  // Vide le texte des autres runs du paragraphe (on garde leurs balises
  // de formatage/structure mais plus aucun texte en double)
  for (let i = 1; i < paragraph.runs.length; i++) {
    const otherTNodes = Array.from(paragraph.runs[i].node.getElementsByTagNameNS(W_NS, "t"));
    otherTNodes.forEach((t) => (t.textContent = ""));
  }
}

/**
 * Applique tous les résultats de réécriture (Map<sectionId, string>) au
 * document XML en mémoire, puis régénère un blob .docx complet.
 */
export async function applyRewriteAndBuild(parsedDocx, sections, rewriteMap) {
  for (const section of sections) {
    const newText = rewriteMap.get(section.id);
    if (newText) {
      distributeTextOverParagraphs(section.paragraphs, newText);
    }
  }

  const serializer = new XMLSerializer();
  const newXml = serializer.serializeToString(parsedDocx.xmlDoc);

  parsedDocx.zip.file(parsedDocx.documentXmlPath, newXml);

  const blob = await parsedDocx.zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
  });

  return blob;
}
