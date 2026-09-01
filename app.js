// ==== Éléments DOM ====
const fileInput = document.getElementById('cv-file');
const fileNameEl = document.getElementById('file-name');
const jobTextEl = document.getElementById('job-text');
const jobCountEl = document.getElementById('job-count');
const modelSelect = document.getElementById('model-select');
const runBtn = document.getElementById('run-btn');
const statusEl = document.getElementById('status');
const progressBar = document.getElementById('progress-bar');
const downloadArea = document.getElementById('download-area');
const logEl = document.getElementById('log');

// État du document en cours d'édition, gardé EN MÉMOIRE et modifié en place :
// tout ce qu'on ne touche pas (styles, thème, en-têtes/pieds de page, images,
// tableaux, numérotation…) reste strictement intact, y compris à travers
// plusieurs itérations "continuer à améliorer".
let docState = null; // { zip, xmlDoc }
let originalFileName = 'cv';
let baseFileName = 'cv';
let iteration = 1;
let engine = null;
let currentModelId = null;

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function log(msg) {
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

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
    log(`CV chargé : ${runs.length} segments détectés, ${editable.length} identifiés comme du contenu modifiable (voir journal pour le détail).`);
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
// Plutôt que de demander à un LLM de deviner quels segments sont "du
// contenu" ou "du factuel", le code s'en charge lui-même avec des règles
// simples et fiables. Le modèle ne verra donc jamais un segment qu'on ne
// veut pas qu'il touche.
const MIN_EDITABLE_RUN_LENGTH = 25;

// Certaines sections entières doivent rester figées même pour du texte non
// gras qui, ailleurs, ressemblerait à du "contenu" (ex: la spécialisation
// d'un diplôme sous "EDUCATION" n'est pas en gras mais ne doit jamais être
// reformulée, contrairement à une description de mission sous "EXPERIENCE").
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

// ==== 4. Chargement du moteur WebLLM ====
// Version FIGÉE, volontairement : c'est la version utilisée lors des deux
// seules générations qui ont réellement abouti sur cette machine. On ne la
// change plus sans preuve concrète que c'est nécessaire.
const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.83/+esm';

async function ensureEngine(modelId) {
  if (!('gpu' in navigator)) {
    throw new Error("WebGPU n'est pas disponible dans ce navigateur. Utilise une version récente de Chrome ou Edge.");
  }
  if (engine && currentModelId === modelId) return engine;

  if (engine) {
    try { await engine.unload(); } catch (_) { /* on ignore */ }
    engine = null;
    currentModelId = null;
  }

  setStatus('Chargement du modèle…');
  const webllm = await import(WEBLLM_URL);
  engine = await webllm.CreateMLCEngine(modelId, {
    initProgressCallback: (p) => {
      const pct = Math.round((p.progress || 0) * 100);
      progressBar.style.width = pct + '%';
      setStatus(p.text || `Chargement… ${pct}%`);
    }
  });
  currentModelId = modelId;
  return engine;
}

function discardEngine() {
  engine = null;
  currentModelId = null;
}

// ==== 5. UN SEUL appel au modèle pour toute la passe ====
// Le code a déjà fait le tri (étape 3) : le modèle ne reçoit que les
// segments pré-filtrés comme modifiables, numérotés, et renvoie un tableau
// JSON des segments qu'il choisit de reformuler. C'est l'architecture qui a
// concrètement produit un CV sur cette machine — on ne la re-complexifie
// pas sans preuve que c'est nécessaire.
function buildEditPrompt(editableRuns, jobText) {
  const listing = editableRuns
    .map((r, i) => `[${i}] (${r.section}${r.role === 'headline' ? ", titre d'accroche" : ''}) ${r.text.trim()}`)
    .join('\n');

  const system = `Tu es un expert en recrutement et rédaction de CV. On te donne une liste NUMÉROTÉE d'extraits d'un CV — déjà triés pour ne contenir QUE du contenu rédigé modifiable (résumé, compétences, descriptions de missions, titre d'accroche). Aucun de ces extraits n'est une donnée factuelle (nom, date, entreprise, diplôme, coordonnées) : ce tri a déjà été fait, tu n'as pas à t'en soucier. On te donne aussi le texte d'une offre d'emploi.

Ta tâche : reformuler les extraits pertinents pour mettre en avant ce qui correspond à l'offre, en réutilisant son vocabulaire UNIQUEMENT quand cela correspond réellement à ce que dit l'extrait original.

RÈGLES ABSOLUES :
1. N'invente aucun fait, aucune expérience, aucune compétence absente de l'extrait original — c'est une reformulation, pas une invention.
2. Si le poste visé est éloigné du parcours, ne fabrique pas de fausse cohérence : reformule honnêtement avec ce qui existe réellement.
3. Ne renvoie QUE les extraits que tu modifies réellement. Si un extrait n'a rien à gagner à être changé, ne le renvoie pas.

Tu réponds UNIQUEMENT avec un tableau JSON valide, sans texte autour, sans balises markdown, de la forme :
[{"index": 2, "text": "nouveau texte de l'extrait 2"}, {"index": 5, "text": "nouveau texte de l'extrait 5"}]`;

  const user = `--- EXTRAITS DU CV (numérotés) ---\n${listing}\n\n--- OFFRE D'EMPLOI ---\n${jobText}\n\nRenvoie le tableau JSON des extraits à reformuler.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

function extractJsonArray(text) {
  let t = text.trim();
  t = t.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '');
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('Réponse du modèle non exploitable (pas de tableau JSON trouvé).');
  const arr = JSON.parse(t.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('Réponse du modèle non exploitable (pas un tableau).');
  return arr;
}

// ==== 6. Application des modifications dans le XML ====
// On ne touche QUE le texte (<w:t>) du run visé : sa mise en forme (rPr —
// police, couleur, gras, taille…) reste l'élément XML original intact.
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

function applyEdits(editableRuns, edits) {
  let applied = 0;
  edits.forEach(({ index, text }) => {
    const entry = editableRuns[index];
    if (!entry || typeof text !== 'string' || !text.trim()) return;
    setRunText(entry.node, text);
    applied++;
  });
  return applied;
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
  const modelId = modelSelect.value;

  try {
    await ensureEngine(modelId);

    const allRuns = classifyRuns(getTextRuns(docState.xmlDoc));
    const editable = allRuns.filter((r) => r.editable);
    log(`${editable.length} segment(s) pré-filtré(s) envoyé(s) au modèle en un seul appel.`);

    setStatus('Génération des reformulations (le modèle réfléchit)…');
    const messages = buildEditPrompt(editable, jobText);
    const reply = await engine.chat.completions.create({
      messages,
      temperature: 0.2,
      max_tokens: 1500,
    });
    const text = reply.choices[0].message.content;
    log(`Réponse reçue (${text.length} caractères).`);

    const edits = extractJsonArray(text);
    log(`Le modèle propose ${edits.length} segment(s) à reformuler.`);
    const applied = applyEdits(editable, edits);
    log(`${applied} segment(s) modifié(s).`);

    if (applied === 0) {
      setStatus("Le modèle n'a proposé aucune reformulation exploitable — essaie un modèle plus grand (3B/8B).");
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

    setStatus("Terminé ✅ — mise en page, polices, tableaux et images d'origine conservés tels quels.");
  } catch (err) {
    console.error(err);
    const msg = err.message || '';
    const isDeviceLost = /device_removed|device was lost|requestdevice/i.test(msg);
    log('Erreur : ' + (err.stack || err.message));
    discardEngine();

    if (isDeviceLost) {
      setStatus(
        "Le pilote GPU a planté (DEVICE_REMOVED / device lost). Recharge complètement la page (F5), " +
        "choisis le modèle « très léger », et si ça se reproduit : mets à jour tes pilotes graphiques."
      );
    } else {
      setStatus('Erreur : ' + err.message);
    }
  } finally {
    runBtn.disabled = false;
    updateRunButton();
  }
});
