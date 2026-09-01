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

// État du document en cours d'édition. On garde le zip et le DOM du
// document.xml EN MÉMOIRE et on les modifie en place à chaque passe :
// tout ce qu'on ne touche pas (styles, thème, en-têtes/pieds de page,
// images, tableaux, numérotation…) reste strictement intact d'un bout à
// l'autre, y compris à travers plusieurs itérations "continuer à améliorer".
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
// Un .docx est une archive zip contenant du XML. On ne fait AUCUNE
// reconstruction : on ouvre l'archive, on parse word/document.xml comme du
// XML, et plus tard on ne modifiera que le texte de certains segments,
// en laissant tout le reste (styles, polices, tableaux, images, en-têtes…)
// strictement inchangé.
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

    const textRuns = getTextRuns(docState.xmlDoc);
    log(`CV chargé : ${textRuns.length} segments de texte détectés dans le document.`);
    setStatus("CV chargé. Colle l'annonce puis lance l'adaptation.");
    updateRunButton();
  } catch (err) {
    console.error(err);
    docState = null;
    setStatus('Erreur de lecture du .docx : ' + err.message);
  }
});

const JOB_TEXT_WARN_THRESHOLD = 3000; // au-delà, on prévient : c'est probablement toute la page qui a été collée

jobTextEl.addEventListener('input', () => {
  updateRunButton();
  const n = jobTextEl.value.length;
  if (n > JOB_TEXT_WARN_THRESHOLD) {
    jobCountEl.textContent = `⚠️ ${n} caractères — c'est beaucoup pour un texte d'annonce, tu as probablement collé toute la page. Garde uniquement la description du poste.`;
    jobCountEl.style.color = '#e0a030';
  } else {
    jobCountEl.textContent = `${n} caractère${n > 1 ? 's' : ''}`;
    jobCountEl.style.color = '';
  }
});

function updateRunButton() {
  runBtn.disabled = !(docState && jobTextEl.value.trim().length > 20);
}

// ==== 2. Extraction des segments de texte ("runs") depuis le XML ====
// Un paragraphe Word peut contenir plusieurs "runs" (segments) avec des
// mises en forme différentes — typiquement un segment en gras pour
// "Poste — Entreprise — Dates" suivi d'un segment normal pour la
// description de la mission, DANS LE MÊME PARAGRAPHE. On édite donc au
// niveau du run, jamais du paragraphe entier, pour pouvoir figer l'un tout
// en reformulant l'autre.
function getTextRuns(xmlDoc) {
  const pNodes = Array.from(xmlDoc.getElementsByTagName('w:p'));
  const runs = [];
  pNodes.forEach((pNode, paragraphIndex) => {
    const rNodes = Array.from(pNode.getElementsByTagName('w:r'));
    rNodes.forEach((rNode) => {
      const tNodes = Array.from(rNode.getElementsByTagName('w:t'));
      let text = '';
      for (const t of tNodes) text += t.textContent;
      if (!text.trim()) return; // segment vide (ex: simple saut de ligne) : rien à proposer au modèle
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

// ==== 3. Chargement du moteur WebLLM (dans le cache du navigateur) ====
const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm';

async function ensureEngine(modelId) {
  if (!('gpu' in navigator)) {
    throw new Error("WebGPU n'est pas disponible dans ce navigateur. Utilise une version récente de Chrome ou Edge.");
  }

  // Bug connu de web-llm : réutiliser un moteur déjà chargé pour une nouvelle
  // génération corrompt parfois son état interne et déclenche
  // "Object/Module has already been disposed" (voir mlc-ai/web-llm#486 et #560).
  // On décharge donc systématiquement le moteur précédent et on repart d'un
  // moteur neuf à chaque clic, même pour le même modèle. Le modèle reste en
  // cache navigateur (IndexedDB) donc ça ne re-télécharge rien, juste
  // ré-initialise proprement sur le GPU.
  if (engine) {
    try { await engine.unload(); } catch (_) { /* on ignore, on repart de zéro */ }
    engine = null;
    currentModelId = null;
  }

  setStatus('Initialisation du moteur…');
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

// ==== 4. Construction du prompt ====
// On plafonne la taille du texte envoyé au modèle : un prompt trop long
// se traduit par un seul très gros calcul GPU ("prefill") qui peut dépasser
// le délai que le pilote/OS accorde avant de le tuer (device lost).
const MAX_CV_CHARS = 3500;
const MAX_JOB_CHARS = 3500;

function capText(text, maxChars, label) {
  if (text.length <= maxChars) return text;
  log(`⚠️ ${label} tronqué de ${text.length} à ${maxChars} caractères pour éviter un calcul trop long.`);
  return text.slice(0, maxChars) + '\n[…texte tronqué…]';
}

// Seuil sous lequel on refuse de toute façon de modifier un segment (voir
// applyEdits) : les segments courts sont presque toujours du factuel isolé
// (une date seule, un sigle…) qu'on ne veut jamais reformuler.
const MIN_EDITABLE_RUN_LENGTH = 15;

function buildRunsListing(runs) {
  const lines = [];
  let lastParagraph = null;
  const firstBoldIndex = runs.findIndex((r) => r.bold);
  runs.forEach((r, i) => {
    if (r.paragraphIndex !== lastParagraph) {
      lines.push(`--- paragraphe ${r.paragraphIndex} ---`);
      lastParagraph = r.paragraphIndex;
    }
    let tag = '';
    if (r.bold && i === firstBoldIndex) {
      tag = ' (gras — probablement le titre d\'accroche du CV, celui-ci EST modifiable)';
    } else if (r.bold) {
      tag = ' (gras)';
    }
    lines.push(`[${i}]${tag} ${r.text}`);
  });
  return lines.join('\n');
}

function buildEditPrompt(runs, jobText) {
  let listText = buildRunsListing(runs);
  listText = capText(listText, MAX_CV_CHARS, 'Le CV');
  jobText = capText(jobText, MAX_JOB_CHARS, "Le texte de l'annonce");

  const system = `Tu es un expert en recrutement et rédaction de CV. On te donne la liste NUMÉROTÉE des segments de texte ("runs") d'un CV existant, regroupés par paragraphe d'origine (repères "--- paragraphe N ---"). Un segment marqué "(gras)" est en gras dans le document original — c'est presque toujours le signe qu'il s'agit d'un titre, d'une date ou d'un nom d'entreprise, PAS de contenu à reformuler. On te donne aussi le texte d'une offre d'emploi.

Ta tâche : repérer les segments de CONTENU RÉDIGÉ (résumé/profil, descriptions de missions et réalisations, compétences) et les reformuler pour mettre en avant ce qui correspond à l'offre, en réutilisant son vocabulaire UNIQUEMENT quand cela correspond réellement à une expérience ou compétence déjà présente.

RÈGLES ABSOLUES, à ne jamais enfreindre :
1. NE TOUCHE JAMAIS : le nom du candidat, les dates, les noms d'entreprises et d'établissements, les diplômes, les coordonnées (email/téléphone/adresse/LinkedIn), les langues, les rubriques "autres/divers", les titres de section ("EXPÉRIENCE", "FORMATION"…), et l'intitulé de poste PROPRE À CHAQUE EXPÉRIENCE (ex: "Business Analyst — DRAY — May 2023 – Dec 2025"). Un segment marqué simplement "(gras)" est très probablement l'un de ces éléments factuels : ne le touche jamais.
2. Le seul segment en gras que tu PEUX reformuler est celui explicitement annoté "(gras — probablement le titre d'accroche du CV, celui-ci EST modifiable)". Tu peux aussi reformuler, même non gras : le résumé/profil, les compétences, et les descriptions de missions/réalisations sous chaque expérience.
3. Un même paragraphe original peut contenir plusieurs segments : par exemple un segment gras "Poste — Entreprise — Dates" suivi d'un segment normal "Description de la mission". Dans ce cas, laisse le premier intact et ne reformule que le second.
4. L'offre d'emploi sert UNIQUEMENT à choisir l'angle et le vocabulaire. Elle n'est JAMAIS une source de faits sur le candidat. N'invente rien, ne déduis aucune donnée factuelle de l'offre.
5. Chaque reformulation doit rester fidèle au sens du segment original — c'est une reformulation, pas une invention. Si le poste visé est éloigné du parcours, ne fabrique pas de fausse cohérence : reformule honnêtement avec ce qui existe réellement.
6. Ne renvoie QUE les segments que tu modifies réellement.

Tu réponds UNIQUEMENT avec un tableau JSON valide, sans texte autour, sans balises markdown, de la forme :
[{"index": 12, "text": "nouveau texte du segment 12"}, {"index": 15, "text": "nouveau texte du segment 15"}]`;

  const user = `--- SEGMENTS DU CV (numérotés, seule source de vérité) ---\n${listText}\n\n--- OFFRE D'EMPLOI (uniquement pour le vocabulaire et l'angle) ---\n${jobText}\n\nRenvoie le tableau JSON des segments de contenu à reformuler, en respectant strictement les règles ci-dessus.`;

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

// ==== 5. Application des modifications dans le XML ====
// On ne touche QUE le texte (<w:t>) du run visé : sa mise en forme (rPr —
// police, couleur, gras, taille…) n'est jamais recréée ni même effleurée,
// elle reste l'élément XML original tel quel. Seul son contenu textuel change.
function applyEdits(runs, edits) {
  let applied = 0;
  let skipped = 0;

  edits.forEach(({ index, text }) => {
    const entry = runs[index];
    if (!entry || typeof text !== 'string' || !text.trim()) return;

    if (entry.text.trim().length < MIN_EDITABLE_RUN_LENGTH) {
      skipped++;
      log(`⚠️ Modification du segment [${index}] ignorée (trop court pour être un vrai contenu à reformuler) : "${entry.text.trim()}"`);
      return;
    }

    setRunText(entry.node, text);
    applied++;
  });

  return { applied, skipped };
}

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
  for (let i = 1; i < tNodes.length; i++) {
    tNodes[i].textContent = '';
  }
}

// ==== 6. Génération du fichier .docx modifié ====
async function packageDocx() {
  const serialized = new XMLSerializer().serializeToString(docState.xmlDoc);
  const withDeclaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + serialized;
  docState.zip.file('word/document.xml', withDeclaration);
  return docState.zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

// ==== 7. Orchestration ====
runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  downloadArea.innerHTML = '';
  progressBar.style.width = '0%';
  log('--- Nouvelle adaptation ---');
  try {
    const modelId = modelSelect.value;
    await ensureEngine(modelId);

    const textRuns = getTextRuns(docState.xmlDoc);

    setStatus('Analyse du CV et génération des reformulations (le modèle réfléchit)…');
    const messages = buildEditPrompt(textRuns, jobTextEl.value.trim());
    const reply = await engine.chat.completions.create({
      messages,
      temperature: 0.1,
      max_tokens: 1200,
    });
    const text = reply.choices[0].message.content;
    log(`Réponse reçue (${text.length} caractères).`);

    const edits = extractJsonArray(text);
    log(`Le modèle propose ${edits.length} segment(s) à reformuler.`);
    const { applied, skipped } = applyEdits(textRuns, edits);
    log(`${applied} segment(s) modifié(s)${skipped ? `, ${skipped} ignoré(s) par sécurité` : ''}.`);

    if (applied === 0) {
      setStatus("Le modèle n'a proposé aucune reformulation exploitable — essaie un modèle plus grand (3B/8B), ou vérifie que l'annonce est bien pertinente par rapport au CV.");
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
    continueBtn.title = 'Relance une nouvelle passe de reformulation sur le document déjà modifié.';
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
    const isGpuCrash = /device_removed|device was lost|requestdevice|disposed/i.test(msg);
    log('Erreur : ' + (err.stack || err.message));
    engine = null; // le moteur en mémoire n'est plus fiable, on force un rechargement complet la prochaine fois

    if (isGpuCrash) {
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
