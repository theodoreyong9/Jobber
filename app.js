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
let currentModelIdWanted = null; // le modèle demandé pour la passe en cours, utilisé par les réessais

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

// ==== 3. ORCHESTRATION : classification déterministe, sans aucun appel au
// modèle. C'est le cœur du changement : plutôt que de demander à un LLM de
// deviner quels segments sont "du contenu" ou "du factuel", le code s'en
// charge lui-même avec des règles simples et fiables. Le modèle ne verra
// donc jamais un segment qu'on ne veut pas qu'il touche — pas besoin de lui
// faire confiance là-dessus.
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

// ==== 4. Chargement du moteur WebLLM (chargé UNE FOIS, réutilisé pour
// tous les petits appels de la passe — exactement comme dans les projets
// où WebLLM tourne de façon fiable : un seul engine.chat.completions.create
// par appel, jamais de rechargement entre deux échanges tant qu'aucune
// erreur ne l'exige). ====
// Version FIGÉE, volontairement : on a la preuve concrète que la version
// 0.2.83 fonctionne sur cette machine (deux générations réussies avec elle
// plus tôt). La version non-pinnée (esm.run sans numéro = "dernière
// version") sert potentiellement un build différent d'un jour à l'autre
// sans prévenir — c'est le principal changement identifié entre "ça
// marchait" et "ça ne marche plus", donc on revient à ce qui est prouvé.
const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.83/+esm';

async function ensureEngine(modelId, forceReload = false) {
  if (!('gpu' in navigator)) {
    throw new Error("WebGPU n'est pas disponible dans ce navigateur. Utilise une version récente de Chrome ou Edge.");
  }
  if (engine && currentModelId === modelId && !forceReload) return engine;

  if (engine) {
    try { await engine.unload(); } catch (_) { /* on ignore */ }
    engine = null;
    currentModelId = null;
    // Laisse le temps au GPU de vraiment libérer la mémoire du moteur
    // précédent avant d'en recréer un — un rechargement immédiat après
    // unload() semble être ce qui déclenche le DEVICE_REMOVED observé.
    await new Promise((resolve) => setTimeout(resolve, 500));
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
  // Après une erreur runtime (disposed / device lost), le moteur en mémoire
  // n'est plus fiable : on le jette pour forcer un rechargement complet au
  // prochain appel, plutôt que de continuer à s'appuyer dessus.
  engine = null;
  currentModelId = null;
}

// ==== 5. Réécriture d'UN SEUL segment à la fois ====
// Volontairement minimaliste : un texte en entrée, un texte en sortie, pas
// de JSON, pas de structure à faire respecter. Chaque appel est court à
// générer (peu de tokens de sortie), donc rapide et bien plus fiable que
// l'ancienne version qui demandait une grosse génération JSON d'un coup.
const REWRITE_SYSTEM_PROMPT = `Tu es un expert en recrutement. On te donne un court extrait d'un CV et le texte d'une offre d'emploi. Reformule cet extrait pour mettre en avant ce qui correspond à l'offre, en réutilisant son vocabulaire UNIQUEMENT quand cela correspond réellement à ce que dit l'extrait original. N'invente aucun fait, aucune expérience, aucune compétence absente de l'extrait original — c'est une reformulation, pas une invention. Si l'extrait n'a vraiment rien à gagner à être changé, renvoie-le tel quel. Réponds UNIQUEMENT avec le texte reformulé, sans guillemets, sans préambule, sans balises, sans explication.`;

async function rewriteRun(run, jobText) {
  const messages = [
    { role: 'system', content: REWRITE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `--- OFFRE D'EMPLOI ---\n${jobText}\n\n--- EXTRAIT DU CV À REFORMULER (section "${run.section}", rôle: ${run.role === 'headline' ? "titre d'accroche" : 'contenu'}) ---\n${run.text.trim()}\n\nRéponds uniquement avec le texte reformulé.`
    }
  ];
  const reply = await engine.chat.completions.create({
    messages,
    temperature: 0.2,
    max_tokens: 260,
  });
  return reply.choices[0].message.content.trim().replace(/^["«]|["»]$/g, '');
}

async function rewriteRunWithRetry(run, jobText) {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await rewriteRun(run, jobText);
    } catch (err) {
      const msg = err.message || '';
      const isDeviceLost = /device_removed|device was lost|requestdevice/i.test(msg);
      log(`  ⚠️ Échec sur ce segment (tentative ${attempt}/${maxAttempts}) : ${msg}`);
      discardEngine();
      if (isDeviceLost) throw err; // un vrai crash GPU : inutile d'insister, on remonte l'erreur
      if (attempt < maxAttempts) {
        await ensureEngine(currentModelIdWanted, true); // recharge un moteur neuf avant de réessayer
        continue;
      }
      return null; // on abandonne CE segment précis, mais pas toute la passe
    }
  }
  return null;
}

// ==== 6. Application d'une réécriture dans le XML ====
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
  currentModelIdWanted = modelId;

  try {
    const allRuns = classifyRuns(getTextRuns(docState.xmlDoc));
    const editable = allRuns.filter((r) => r.editable);
    log(`${editable.length} segment(s) à reformuler, un par un.`);

    let applied = 0;
    let failed = 0;

    for (let i = 0; i < editable.length; i++) {
      const run = editable[i];
      // Un seul chargement du moteur pour toute la passe (pas un par
      // segment) : la mémoire GPU utilisée, c'est essentiellement le poids
      // du modèle lui-même, constant quelle que soit la taille du texte
      // généré. Recharger le modèle entier avant chaque segment multiplie
      // l'opération la plus lourde (charger ~2 Go en mémoire GPU) au lieu
      // de la faire une fois — ça a empiré les choses à l'usage, on
      // revient donc à la réutilisation, avec rechargement uniquement en
      // cas d'échec réel (voir rewriteRunWithRetry).
      await ensureEngine(modelId);
      setStatus(`Reformulation ${i + 1}/${editable.length} (${run.section})…`);
      const newText = await rewriteRunWithRetry(run, jobText);
      if (newText && newText.length > 0) {
        setRunText(run.node, newText);
        applied++;
        log(`  ✓ [${i + 1}/${editable.length}] "${run.text.trim().slice(0, 40)}…" → "${newText.slice(0, 40)}…"`);
      } else {
        failed++;
        log(`  ✗ [${i + 1}/${editable.length}] segment laissé inchangé après échec.`);
      }
      // Petite pause entre deux appels : laisse la file de commandes GPU
      // se vider un peu avant d'enchaîner sur la génération suivante.
      if (i < editable.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }

    log(`${applied} segment(s) modifié(s), ${failed} laissé(s) inchangé(s) après échec.`);

    if (applied === 0) {
      setStatus("Aucun segment n'a pu être reformulé — vérifie le journal technique pour comprendre pourquoi.");
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
      ? `Terminé avec ${failed} segment(s) non modifié(s) (voir journal) — mise en page d'origine conservée.`
      : "Terminé ✅ — mise en page, polices, tableaux et images d'origine conservés tels quels.";
    setStatus(msg);
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
