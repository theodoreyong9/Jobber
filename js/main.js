import { loadDocx } from "./docxParser.js";
import { extractSections } from "./sectionExtractor.js";
import { detectLanguage } from "./langDetect.js";
import { buildKeywordListA, buildKeywordListB } from "./keywords.js";
import { associateKeywords } from "./semanticMatch.js";
import { LLMClient } from "./llmClient.js";
import { applyRewriteAndBuild } from "./docxWriter.js";
import { setProgress, log, resetProgress } from "./progress.js";

const LANG_NAMES = {
  fr: "français", en: "anglais", es: "espagnol",
  de: "allemand", it: "italien", pt: "portugais",
};

const cvInput = document.getElementById("cv-input");
const cvDropzone = document.getElementById("cv-dropzone");
const cvFilename = document.getElementById("cv-filename");
const adsList = document.getElementById("ads-list");
const addAdBtn = document.getElementById("add-ad");
const modelSelect = document.getElementById("model-select");
const goBtn = document.getElementById("go-btn");
const resultsCard = document.getElementById("card-results");
const resultsList = document.getElementById("results-list");

let cvFile = null;

cvInput.addEventListener("change", () => {
  const file = cvInput.files?.[0];
  if (!file) return;
  cvFile = file;
  cvFilename.textContent = file.name;
  cvDropzone.classList.add("filled");
  updateGoState();
});

addAdBtn.addEventListener("click", () => {
  const ta = document.createElement("textarea");
  ta.className = "ad-textarea";
  ta.placeholder = "Colle ici le texte d'une autre annonce…";
  ta.addEventListener("input", updateGoState);
  adsList.appendChild(ta);
});

adsList.querySelector(".ad-textarea").addEventListener("input", updateGoState);

function updateGoState() {
  const hasAd = Array.from(document.querySelectorAll(".ad-textarea")).some(
    (ta) => ta.value.trim().length > 0
  );
  goBtn.disabled = !(cvFile && hasAd);
}

goBtn.addEventListener("click", runPipeline);

async function runPipeline() {
  goBtn.disabled = true;
  resultsCard.hidden = true;
  resultsList.innerHTML = "";
  resetProgress();

  const ads = Array.from(document.querySelectorAll(".ad-textarea"))
    .map((ta) => ta.value.trim())
    .filter(Boolean);

  const llm = new LLMClient();

  try {
    // --- 1. Parse + langue + sections du CV -------------------------------
    log("Lecture du fichier .docx…");
    let parsed = await loadDocx(cvFile);
    const sections = extractSections(parsed.paragraphs, parsed.maxFontSize);
    log(`${sections.length} section(s) détectée(s) dans le CV : ${sections.map((s) => s.title).join(", ")}`);

    const cvText = sections.map((s) => s.text).join(" ");
    const cvLang = detectLanguage(cvText);
    log(`Langue du CV détectée : ${LANG_NAMES[cvLang] || cvLang}`);
    setProgress(8);

    // --- 2. Liste A --------------------------------------------------------
    const listA = buildKeywordListA(sections, cvLang);
    log(`Liste A (mots-clés du CV) : ${listA.length} mots.`);
    setProgress(15);

    // --- 3. Chargement du modèle WebLLM (dans un Web Worker) ---------------
    const model = modelSelect.value;
    log(`Chargement du modèle "${model}" dans un Web Worker…`);
    llm.start((report) => {
      // Ce détail va uniquement dans le journal technique, jamais dans
      // la barre de progression générale (voir étape 17).
      log(`[modèle] ${report.text ?? JSON.stringify(report)}`);
      if (typeof report.progress === "number") {
        setProgress(15 + report.progress * 15); // 15 -> 30%
      }
    });
    await llm.loadModel(model);
    log("Modèle chargé.");
    setProgress(30);

    // --- 4. Boucle sur chaque annonce --------------------------------------
    const progressPerAd = 60 / ads.length;

    for (let adIndex = 0; adIndex < ads.length; adIndex++) {
      const adText = ads[adIndex];
      const adLang = detectLanguage(adText);
      log(`Annonce ${adIndex + 1}/${ads.length} — langue détectée : ${LANG_NAMES[adLang] || adLang}`);

      // Liste B (étape 10)
      const { keywords: listB } = buildKeywordListB(adText, adLang);
      log(`Liste B (annonce ${adIndex + 1}) : ${listB.length} mots issus de phrases > 3 mots.`);

      // Association A -> B (étape 11)
      const assoc = associateKeywords(listA, listB);
      log(`${assoc.size} mot(s)-clé(s) du CV associés à des mots de l'annonce.`);

      // Reparse un CV "vierge" pour cette annonce, pour ne jamais mélanger
      // les réécritures de deux annonces différentes dans le même XML.
      const freshParsed = await loadDocx(cvFile);
      const freshSections = extractSections(freshParsed.paragraphs, freshParsed.maxFontSize);

      // --- 5. Génération section par section (étapes 12-13) ---------------
      const rewriteMap = new Map();
      const progressPerSection = progressPerAd / Math.max(freshSections.length, 1);
      let base = 30 + adIndex * progressPerAd;

      const systemPrompt = buildSystemPrompt(adLang);

      for (const section of freshSections) {
        const sectionWords = collectSectionWords(section, assoc);
        const originalLines = section.paragraphs.map((p) => p.text);

        const prompt = buildSectionPrompt(section.title, originalLines, sectionWords);
        log(`Réécriture de la section "${section.title}"…`);
        const rewritten = await llm.generate(systemPrompt, prompt);
        rewriteMap.set(section.id, rewritten);

        base += progressPerSection;
        setProgress(base);
      }

      // --- 6. Reconstruction du .docx (étapes 14-15) -----------------------
      log(`Reconstruction du document Word pour l'annonce ${adIndex + 1}…`);
      const blob = await applyRewriteAndBuild(freshParsed, freshSections, rewriteMap);
      addResultLink(blob, adIndex + 1, cvFile.name);
    }

    setProgress(95);

    // --- 7. Nettoyage : détruit WebLLM + le Web Worker (étape 18) ---------
    log("Destruction de l'instance WebLLM et du Web Worker…");
    await llm.terminate();
    log("Terminé.");
    setProgress(100);
    resultsCard.hidden = false;
  } catch (err) {
    console.error(err);
    log(`ERREUR : ${err.message || err}`);
    await llm.terminate().catch(() => {});
  } finally {
    updateGoState();
  }
}

function collectSectionWords(section, assocMap) {
  const words = new Set();
  const sectionTokens = new Set(section.text.toLowerCase().match(/\p{L}+/gu) || []);
  for (const [keyword, targets] of assocMap.entries()) {
    if (sectionTokens.has(keyword)) {
      targets.forEach((t) => words.add(t));
    }
  }
  return Array.from(words);
}

function buildSystemPrompt(targetLang) {
  const langName = LANG_NAMES[targetLang] || targetLang;
  return `Tu es un assistant qui réécrit des sections de CV. Règles strictes :
- Réponds uniquement dans la langue suivante : ${langName}.
- Garde exactement le même nombre de lignes que le texte original fourni (une ligne réécrite par ligne d'origine, séparées par des retours à la ligne).
- Conserve tous les chiffres et nombres présents dans le texte d'origine, avec ce qu'ils désignent (durées, pourcentages, montants, quantités), même en changeant de langue.
- N'invente aucune expérience, diplôme ou compétence qui ne serait pas déjà présente dans le texte d'origine : tu adaptes la formulation, tu n'ajoutes pas de faits.
- Ne mets aucun texte d'introduction, aucune explication, uniquement les lignes réécrites.`;
}

function buildSectionPrompt(sectionTitle, originalLines, targetWords) {
  const wordsPart = targetWords.length
    ? `Utilise, quand c'est pertinent et naturel, ces mots issus de l'offre d'emploi : ${targetWords.join(", ")}.`
    : "Aucun mot-clé spécifique à intégrer pour cette section.";

  return `Section : "${sectionTitle}"
Texte original (${originalLines.length} ligne(s)) :
${originalLines.map((l, i) => `${i + 1}. ${l}`).join("\n")}

${wordsPart}

Réécris chaque ligne, dans l'ordre, une ligne réécrite par ligne d'origine.`;
}

function addResultLink(blob, index, originalFilename) {
  const url = URL.createObjectURL(blob);
  const baseName = originalFilename.replace(/\.docx$/i, "");
  const filename = `${baseName}_adapte_${index}.docx`;

  const li = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = `Annonce ${index}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.textContent = `⬇ ${filename}`;
  li.appendChild(label);
  li.appendChild(a);
  resultsList.appendChild(li);
}
