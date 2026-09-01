// ==== Éléments DOM ====
const fileInput = document.getElementById('cv-file');
const fileNameEl = document.getElementById('file-name');
const jobTextEl = document.getElementById('job-text');
const jobCountEl = document.getElementById('job-count');
const runBtn = document.getElementById('run-btn');
const statusEl = document.getElementById('status');
const progressBar = document.getElementById('progress-bar');
const downloadArea = document.getElementById('download-area');
const logEl = document.getElementById('log');
const hfTokenInput = document.getElementById('hf-token');
const hfModelInput = document.getElementById('hf-model');

// État du document en cours d'édition, gardé EN MÉMOIRE et modifié en place :
// tout ce qu'on ne touche pas (styles, thème, en-têtes/pieds de page, images,
// tableaux, numérotation…) reste strictement intact, y compris à travers
// plusieurs itérations "continuer à améliorer".
let docState = null; // { zip, xmlDoc }
let originalFileName = 'cv';
let baseFileName = 'cv';
let iteration = 1;

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function log(msg) {
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

// ==== Token Hugging Face (persisté localement pour le confort) ====
const savedToken = localStorage.getItem('cvAdapterHfToken');
if (savedToken) hfTokenInput.value = savedToken;
hfTokenInput.addEventListener('input', () => {
  localStorage.setItem('cvAdapterHfToken', hfTokenInput.value.trim());
});

// ==== 1. Lecture du CV .docx (JSZip + DOM XML natif, 100% client) ====
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  originalFileName = file.name.replace(/\.docx$/i, '');
  baseFileName = originalFileName;
  iteration = 1;
  fileNameEl.textContent = file.name;
  setStatus('Lecture du CV…');
  downloadArea.innerHTML = '';
  try {
    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    const docXmlFile = zip.file('word/document.xml');
    if (!docXmlFile) throw new Error("Ce fichier ne ressemble pas à un .docx valide (word/document.xml introuvable).");
    const xmlText = await docXmlFile.async('text');
    const xmlDoc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (xmlDoc.getElementsByTagName('parsererror').length) {
      throw new Error('Le XML du document est illisible.');
    }
    docState = { zip, xmlDoc };

    const runs = classifyRuns(getTextRuns(docState.xmlDoc));
    const editable = runs.filter((r) => r.editable);
    log(`CV chargé : ${runs.length} segments détectés, ${editable.length} identifiés comme du contenu modifiable.`);
    editable.forEach((r) => log(`  → [${r.role}] "${r.text.trim().slice(0, 60)}${r.text.trim().length > 60 ? '…' : ''}"`));
    setStatus("CV chargé. Colle l'annonce puis lance l'adaptation.");
    updateRunButton();
  } catch (err) {
    console.error(err);
    docState = null;
    setStatus('Erreur de lecture du .docx : ' + err.message);
  }
});

jobTextEl.addEventListener('input', () => {
  updateRunButton();
  const n = jobTextEl.value.length;
  jobCountEl.textContent = `${n} caractère${n > 1 ? 's' : ''}`;
});

function updateRunButton() {
  runBtn.disabled = !(docState && jobTextEl.value.trim().length > 20);
}

// ==== 2. Extraction des segments de texte ("runs") depuis le XML ====
function getTextRuns(xmlDoc) {
  const pNodes = Array.from(xmlDoc.getElementsByTagName('w:p'));
  const runs = [];
  pNodes.forEach((pNode, paragraphIndex) => {
    const rNodes = Array.from(pNode.getElementsByTagName('w:r'));
    rNodes.forEach((rNode) => {
      const tNodes = Array.from(rNode.getElementsByTagName('w:t'));
      let text = '';
      for (const t of tNodes) text += t.textContent;
      if (!text.trim()) return;
      runs.push({ node: rNode, text, bold: isBoldRun(rNode), paragraphIndex });
    });
  });
  return runs;
}

function isBoldRun(rNode) {
  const rPr = rNode.getElementsByTagName('w:rPr')[0];
  if (!rPr) return false;
  const b = rPr.getElementsByTagName('w:b')[0];
  if (!b) return false;
  const val = b.getAttribute('w:val');
  return val !== '0' && val !== 'false';
}

// ==== 3. Classification déterministe, sans aucun appel au modèle ====
// Le code décide seul quels segments sont du contenu modifiable — le
// modèle ne voit donc jamais un nom, une date, un employeur, un diplôme
// ou des coordonnées.
const MIN_EDITABLE_RUN_LENGTH = 25;
const FROZEN_SECTION_PATTERN = /\b(education|formation|dipl[oô]me|langue|language|divers|autre)/i;

function classifyRuns(runs) {
  const firstBoldIndex = runs.findIndex((r) => r.bold);
  let currentSection = 'Profil / en-tête';
  let currentSectionFrozen = false;

  return runs.map((r, i) => {
    const trimmed = r.text.trim();

    if (r.bold && trimmed.length < 30 && trimmed === trimmed.toUpperCase() && /[A-ZÀ-Ü]/.test(trimmed)) {
      currentSection = trimmed;
      currentSectionFrozen = FROZEN_SECTION_PATTERN.test(trimmed);
      return { ...r, editable: false, role: 'section', section: currentSection };
    }
    if (i === firstBoldIndex) {
      return { ...r, editable: true, role: 'headline', section: currentSection };
    }
    if (r.bold) {
      return { ...r, editable: false, role: 'frozen-bold', section: currentSection };
    }
    if (currentSectionFrozen) {
      return { ...r, editable: false, role: 'frozen-section', section: currentSection };
    }
    if (trimmed.length < MIN_EDITABLE_RUN_LENGTH) {
      return { ...r, editable: false, role: 'frozen-short', section: currentSection };
    }
    if (looksLikeContactInfo(trimmed)) {
      return { ...r, editable: false, role: 'frozen-contact', section: currentSection };
    }
    return { ...r, editable: true, role: 'content', section: currentSection };
  });
}

function looksLikeContactInfo(text) {
  const emailRe = /[^\s@]+@[^\s@]+\.[^\s@]+/;
  const phoneRe = /(\+?\d[\d\s().-]{7,}\d)/;
  const urlRe = /(linkedin\.com|github\.com|https?:\/\/|www\.)/i;
  return emailRe.test(text) || phoneRe.test(text) || urlRe.test(text);
}

// ==== 4. Génération via Hugging Face (API compatible OpenAI) ====
async function generateText(messages, maxTokens) {
  const token = hfTokenInput.value.trim();
  if (!token) throw new Error("Renseigne un token Hugging Face dans le champ prévu.");
  const model = hfModelInput.value.trim();
  if (!model) throw new Error('Renseigne un identifiant de modèle Hugging Face.');

  const response = await fetch('https://router.huggingface.co/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Hugging Face a répondu ${response.status} : ${errText.slice(0, 300)}`);
  }
  const data = await response.json();
  return data.choices[0].message.content;
}

// ==== 5. Reformulation d'un segment ====
const REWRITE_SYSTEM_PROMPT = `Tu es un expert en recrutement. On te donne un court extrait d'un CV et le texte d'une offre d'emploi. Reformule cet extrait pour mettre en avant ce qui correspond à l'offre, en réutilisant son vocabulaire UNIQUEMENT si ça correspond vraiment à ce que dit l'extrait. N'invente aucun fait absent de l'extrait original — c'est une reformulation, pas une invention. Si rien à gagner à changer, renvoie l'extrait tel quel. Réponds UNIQUEMENT avec le texte reformulé, sans guillemets ni préambule.`;

function buildSegmentPrompt(run, jobText) {
  const user = `--- OFFRE D'EMPLOI ---\n${jobText}\n\n--- EXTRAIT DU CV (section "${run.section}") ---\n${run.text.trim()}\n\nRéponds uniquement avec le texte reformulé.`;
  return [
    { role: 'system', content: REWRITE_SYSTEM_PROMPT },
    { role: 'user', content: user }
  ];
}

async function rewriteSegment(run, jobText) {
  const messages = buildSegmentPrompt(run, jobText);
  try {
    const text = await generateText(messages, 200);
    return text.trim().replace(/^["«]|["»]$/g, '');
  } catch (err) {
    log(`  ⚠️ Échec sur ce segment : ${err.message}`);
    return null;
  }
}

// ==== 6. Application d'une réécriture dans le XML ====
function setRunText(rNode, newText) {
  const tNodes = Array.from(rNode.getElementsByTagName('w:t'));
  if (tNodes.length === 0) {
    const t = docState.xmlDoc.createElementNS(W_NS, 'w:t');
    t.setAttribute('xml:space', 'preserve');
    t.textContent = newText;
    rNode.appendChild(t);
    return;
  }
  tNodes[0].setAttribute('xml:space', 'preserve');
  tNodes[0].textContent = newText;
  for (let i = 1; i < tNodes.length; i++) tNodes[i].textContent = '';
}

// ==== 7. Génération du fichier .docx modifié ====
async function packageDocx() {
  const serialized = new XMLSerializer().serializeToString(docState.xmlDoc);
  const withDeclaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + serialized;
  docState.zip.file('word/document.xml', withDeclaration);
  return docState.zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

// ==== 8. Orchestration principale ====
runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  downloadArea.innerHTML = '';
  progressBar.style.width = '0%';
  log('--- Nouvelle adaptation ---');

  const jobText = jobTextEl.value.trim();

  try {
    const allRuns = classifyRuns(getTextRuns(docState.xmlDoc));
    const editable = allRuns.filter((r) => r.editable);
    log(`${editable.length} segment(s) à reformuler.`);

    let applied = 0;
    let failed = 0;

    for (let i = 0; i < editable.length; i++) {
      const run = editable[i];
      const pct = Math.round((i / editable.length) * 100);
      progressBar.style.width = pct + '%';
      setStatus(`Reformulation ${i + 1}/${editable.length} (${run.section})…`);
      const newText = await rewriteSegment(run, jobText);
      if (newText && newText.length > 0) {
        setRunText(run.node, newText);
        applied++;
        log(`  ✓ [${i + 1}/${editable.length}] "${run.text.trim().slice(0, 40)}…" → "${newText.slice(0, 40)}…"`);
      } else {
        failed++;
        log(`  ✗ [${i + 1}/${editable.length}] laissé inchangé.`);
      }
    }
    progressBar.style.width = '100%';

    log(`${applied} segment(s) modifié(s), ${failed} laissé(s) inchangé(s).`);

    if (applied === 0) {
      setStatus("Aucun segment n'a pu être reformulé — vérifie le journal technique.");
      return;
    }

    setStatus("Assemblage du fichier .docx (mise en page, styles et images d'origine conservés)…");
    const blob = await packageDocx();

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = originalFileName + '-adapte.docx';
    a.textContent = '⬇️ Télécharger le CV adapté (.docx)';
    a.className = 'download-link';
    downloadArea.appendChild(a);

    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.textContent = '🔁 Continuer à améliorer ce CV';
    continueBtn.className = 'secondary-btn';
    continueBtn.addEventListener('click', () => {
      iteration += 1;
      originalFileName = baseFileName + '-v' + iteration;
      log(`--- Nouvelle passe sur le document déjà modifié (version ${iteration}) ---`);
      setStatus("Modifie l'annonce si besoin, puis relance « Adapter mon CV » pour continuer à l'affiner.");
      downloadArea.innerHTML = '';
      jobTextEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    downloadArea.appendChild(continueBtn);

    const msg = failed > 0
      ? `Terminé avec ${failed} segment(s) non modifié(s) (voir journal).`
      : "Terminé ✅ — mise en page, polices, tableaux et images d'origine conservés tels quels.";
    setStatus(msg);
  } catch (err) {
    console.error(err);
    log('Erreur : ' + (err.stack || err.message));
    setStatus('Erreur : ' + err.message);
  } finally {
    runBtn.disabled = false;
    updateRunButton();
  }
});
