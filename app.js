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

let originalCvText = null;
let originalFileName = 'cv';
let baseFileName = 'cv';
let iteration = 1;
let engine = null;
let currentModelId = null;

function log(msg) {
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

// ==== 1. Lecture du CV .docx (mammoth.js, 100% client) ====
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  originalFileName = file.name.replace(/\.docx$/i, '');
  baseFileName = originalFileName;
  iteration = 1;
  fileNameEl.textContent = file.name;
  setStatus('Lecture du CV…');
  try {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    originalCvText = result.value;
    log(`CV chargé : ${originalCvText.length} caractères extraits.`);
    setStatus("CV chargé. Colle l'annonce puis lance l'adaptation.");
    updateRunButton();
  } catch (err) {
    console.error(err);
    setStatus('Erreur de lecture du .docx : ' + err.message);
  }
});

const JOB_TEXT_WARN_THRESHOLD = 2000; // au-delà, on prévient : c'est probablement toute la page qui a été collée

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
  runBtn.disabled = !(originalCvText && jobTextEl.value.trim().length > 20);
}

// ==== 2. Chargement du moteur WebLLM (dans le cache du navigateur) ====
// Version figée (pas "latest") pour éviter les régressions du CDN, et
// remise à zéro complète du moteur en cas d'erreur runtime (le bug WebGPU/TVM
// "Object has already been disposed" laisse parfois le moteur dans un état
// corrompu qu'il faut jeter plutôt que réutiliser).
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

// ==== 3. Construction du prompt ====
// On plafonne la taille du texte envoyé au modèle : un prompt trop long
// se traduit par un seul très gros calcul GPU ("prefill") qui peut dépasser
// le délai que Windows accorde au driver avant de le tuer (device lost),
// même sur un GPU qui gère très bien des prompts courts.
const MAX_CV_CHARS = 3500;
const MAX_JOB_CHARS = 2500;

function capText(text, maxChars, label) {
  if (text.length <= maxChars) return text;
  log(`⚠️ ${label} tronqué de ${text.length} à ${maxChars} caractères pour éviter un calcul trop long.`);
  return text.slice(0, maxChars) + '\n[…texte tronqué…]';
}

function buildPrompt(cvText, jobText) {
  cvText = capText(cvText, MAX_CV_CHARS, 'Le CV');
  jobText = capText(jobText, MAX_JOB_CHARS, "Le texte de l'annonce");

  const system = `Tu es un expert en recrutement et rédaction de CV. Tu reçois un CV existant (SOURCE DE VÉRITÉ ABSOLUE) et une offre d'emploi. Ta tâche : reformuler et réorganiser le CV pour mettre en avant ce qui correspond à l'offre, en réutilisant son vocabulaire UNIQUEMENT quand cela correspond réellement à une expérience ou compétence déjà présente dans le CV.

RÈGLES ABSOLUES, à ne jamais enfreindre :
1. Le nom, l'email, le téléphone, le LinkedIn/l'adresse, les noms d'entreprises, les dates et les établissements de formation DOIVENT être recopiés EXACTEMENT tels qu'ils apparaissent dans le CV ORIGINAL. Ne les modifie jamais, ne les invente jamais, ne les déduis jamais de l'offre d'emploi.
2. L'offre d'emploi sert UNIQUEMENT à choisir l'angle de présentation et le vocabulaire. Elle n'est JAMAIS une source d'informations factuelles sur le candidat. N'en recopie aucun nom propre, aucune coordonnée, aucune donnée dans les champs nom/contact/expériences/formations.
3. Si une information n'existe pas dans le CV, mets null (champ simple) ou un tableau vide (liste). N'invente rien pour combler un vide.
4. Si le poste visé est éloigné du parcours du candidat, ne fabrique pas de fausse cohérence : mets en avant honnêtement les compétences transférables réellement présentes dans le CV (ex: relation client, autonomie, organisation), sans prétendre à une expérience du secteur visé qui n'existe pas.
5. Chaque élément de ta réponse (compétence, poste, description) doit être traçable à une phrase précise du CV original. Si tu ne peux pas le justifier par le texte du CV fourni, ne l'inclus pas.
6. Avant de répondre, vérifie mentalement : le nom que je m'apprête à écrire apparaît-il littéralement dans le CV original ? Chaque entreprise citée apparaît-elle dans le CV original ? Si non, corrige-toi avant de répondre.

Tu réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown, respectant exactement ce schéma :
{
  "nom": string,
  "titre_professionnel": string,
  "contact": { "email": string|null, "telephone": string|null, "adresse": string|null, "linkedin": string|null },
  "resume": string,
  "competences": string[],
  "experiences": [ { "poste": string, "entreprise": string, "dates": string, "lieu": string|null, "description": string[] } ],
  "formations": [ { "diplome": string, "etablissement": string, "dates": string } ],
  "langues": string[],
  "autres": string|null
}`;
  const user = `--- CV ORIGINAL (seule source de vérité pour les faits) ---\n${cvText}\n\n--- OFFRE D'EMPLOI (uniquement pour le vocabulaire et l'angle) ---\n${jobText}\n\nAdapte ce CV à cette offre en respectant strictement les règles ci-dessus. Réponds uniquement avec le JSON demandé.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

function serializeCvData(data) {
  const lines = [];
  if (data.nom) lines.push(data.nom);
  if (data.titre_professionnel) lines.push(data.titre_professionnel);
  const contact = data.contact || {};
  const contactLine = ['email', 'telephone', 'adresse', 'linkedin']
    .map((k) => contact[k]).filter(Boolean).join(' · ');
  if (contactLine) lines.push(contactLine);

  if (data.resume) { lines.push('', 'RÉSUMÉ', data.resume); }

  if (data.competences && data.competences.length) {
    lines.push('', 'COMPÉTENCES', data.competences.join(', '));
  }

  if (data.experiences && data.experiences.length) {
    lines.push('', 'EXPÉRIENCE PROFESSIONNELLE');
    data.experiences.forEach((exp) => {
      lines.push([exp.poste, exp.entreprise].filter(Boolean).join(' — '));
      const meta = [exp.dates, exp.lieu].filter(Boolean).join(' · ');
      if (meta) lines.push(meta);
      (exp.description || []).forEach((d) => lines.push('- ' + d));
    });
  }

  if (data.formations && data.formations.length) {
    lines.push('', 'FORMATION');
    data.formations.forEach((f) => {
      lines.push([f.diplome, f.etablissement, f.dates].filter(Boolean).join(' — '));
    });
  }

  if (data.langues && data.langues.length) {
    lines.push('', 'LANGUES', data.langues.join(', '));
  }

  if (data.autres) { lines.push('', 'AUTRES', data.autres); }

  return lines.join('\n');
}

function extractJson(text) {
  let t = text.trim();
  t = t.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Réponse du modèle non exploitable (pas de JSON trouvé).');
  return JSON.parse(t.slice(start, end + 1));
}

// Filet de sécurité anti-hallucination : le nom et les entreprises citées
// doivent apparaître littéralement dans le CV original. Un modèle petit/faible
// peut sinon "abandonner" et recopier des bouts de l'offre d'emploi à la place
// (ex: prendre "Nouveau Collègue" dans l'annonce pour le nom du candidat).
function normalize(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function checkForHallucination(data, cvText) {
  const cvNorm = normalize(cvText);
  const problems = [];

  if (data.nom && !cvNorm.includes(normalize(data.nom))) {
    problems.push(`le nom généré ("${data.nom}") n'apparaît pas dans le CV original`);
  }
  (data.experiences || []).forEach((exp) => {
    if (exp.entreprise && !cvNorm.includes(normalize(exp.entreprise))) {
      problems.push(`l'entreprise "${exp.entreprise}" n'apparaît pas dans le CV original`);
    }
  });

  if (problems.length) {
    log('⚠️ Alerte hallucination possible : ' + problems.join(' ; '));
    setStatus(
      "⚠️ Le résultat semble contenir des informations inventées (voir le journal technique). " +
      "Ne l'utilise pas tel quel : vérifie chaque champ, ou réessaie avec un modèle plus grand (8B)."
    );
    return true;
  }
  return false;
}

// ==== 4. Mise en page aléatoire ====
// À chaque génération, on tire une palette de couleur, une paire de polices
// et un alignement d'en-tête au sort, pour que chaque CV exporté ait un
// habillage visuel légèrement différent (tout en restant sobre et lisible).
const THEMES = [
  { accent: '2E5EAA', headingFont: 'Calibri',      bodyFont: 'Calibri',    align: 'left',   rule: true  },
  { accent: '1F7A5C', headingFont: 'Cambria',       bodyFont: 'Calibri',    align: 'center', rule: false },
  { accent: '8A3B2E', headingFont: 'Georgia',       bodyFont: 'Garamond',   align: 'left',   rule: true  },
  { accent: '5B3E8A', headingFont: 'Trebuchet MS',  bodyFont: 'Verdana',    align: 'center', rule: true  },
  { accent: '2E7A82', headingFont: 'Verdana',       bodyFont: 'Georgia',    align: 'left',   rule: false },
  { accent: '7A2E4B', headingFont: 'Garamond',      bodyFont: 'Cambria',    align: 'center', rule: true  },
];

function pickTheme() {
  return THEMES[Math.floor(Math.random() * THEMES.length)];
}

// ==== 5. Génération du nouveau .docx (librairie "docx", 100% client) ====
async function buildDocx(data) {
  const docx = await import('https://cdn.jsdelivr.net/npm/docx@9.7.1/dist/index.mjs');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } = docx;

  const theme = pickTheme();
  const align = theme.align === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT;

  const children = [];

  // Nom en grand, coloré, avec alignement et filet aléatoires
  children.push(new Paragraph({
    alignment: align,
    border: theme.rule ? {
      bottom: { color: theme.accent, space: 6, style: BorderStyle.SINGLE, size: 8 }
    } : undefined,
    children: [
      new TextRun({ text: data.nom || '', bold: true, size: 48, color: theme.accent, font: theme.headingFont })
    ]
  }));

  if (data.titre_professionnel) {
    children.push(new Paragraph({
      alignment: align,
      children: [new TextRun({ text: data.titre_professionnel, size: 26, font: theme.bodyFont, italics: true })]
    }));
  }

  const contactParts = [];
  if (data.contact) {
    ['email', 'telephone', 'adresse', 'linkedin'].forEach((k) => {
      if (data.contact[k]) contactParts.push(data.contact[k]);
    });
  }
  if (contactParts.length) {
    children.push(new Paragraph({
      alignment: align,
      children: [new TextRun({ text: contactParts.join(' · '), size: 20, font: theme.bodyFont })]
    }));
  }

  function heading(text) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text, bold: true, color: theme.accent, font: theme.headingFont })]
    });
  }
  function body(text, opts = {}) {
    return new Paragraph({
      bullet: opts.bullet ? { level: 0 } : undefined,
      children: [new TextRun({ text, font: theme.bodyFont, bold: opts.bold, italics: opts.italics })]
    });
  }

  if (data.resume) {
    children.push(heading('Résumé'));
    children.push(body(data.resume));
  }

  if (data.competences && data.competences.length) {
    children.push(heading('Compétences'));
    data.competences.forEach((c) => children.push(body(c, { bullet: true })));
  }

  if (data.experiences && data.experiences.length) {
    children.push(heading('Expérience professionnelle'));
    data.experiences.forEach((exp) => {
      const titleLine = [exp.poste, exp.entreprise].filter(Boolean).join(' — ');
      children.push(body(titleLine, { bold: true }));
      const meta = [exp.dates, exp.lieu].filter(Boolean).join(' · ');
      if (meta) children.push(body(meta, { italics: true }));
      (exp.description || []).forEach((d) => children.push(body(d, { bullet: true })));
    });
  }

  if (data.formations && data.formations.length) {
    children.push(heading('Formation'));
    data.formations.forEach((f) => {
      const line = [f.diplome, f.etablissement, f.dates].filter(Boolean).join(' — ');
      children.push(body(line));
    });
  }

  if (data.langues && data.langues.length) {
    children.push(heading('Langues'));
    children.push(body(data.langues.join(', ')));
  }

  if (data.autres) {
    children.push(heading('Autres'));
    children.push(body(data.autres));
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}

// ==== 6. Orchestration ====
runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  downloadArea.innerHTML = '';
  progressBar.style.width = '0%';
  log('--- Nouvelle adaptation ---');
  try {
    const modelId = modelSelect.value;
    await ensureEngine(modelId);

    setStatus('Génération du CV adapté (le modèle réfléchit)…');
    const messages = buildPrompt(originalCvText, jobTextEl.value.trim());
    const reply = await engine.chat.completions.create({
      messages,
      temperature: 0.1,
      max_tokens: 900,
    });
    const text = reply.choices[0].message.content;
    log(`Réponse reçue (${text.length} caractères).`);

    const data = extractJson(text);
    const hasHallucination = checkForHallucination(data, originalCvText);
    setStatus('Construction du fichier .docx…');
    const blob = await buildDocx(data);

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
    continueBtn.title = "Réutilise ce résultat comme nouveau point de départ pour une nouvelle passe d'adaptation.";
    continueBtn.addEventListener('click', () => {
      iteration += 1;
      originalCvText = serializeCvData(data);
      originalFileName = baseFileName + '-v' + iteration;
      fileNameEl.textContent = `CV en cours d'amélioration (version ${iteration}) — ${originalCvText.length} caractères`;
      log(`--- Reprise du CV généré comme nouveau point de départ (version ${iteration}) ---`);
      setStatus("Modifie l'annonce si besoin, puis relance « Adapter mon CV » pour continuer à l'affiner.");
      downloadArea.innerHTML = '';
      updateRunButton();
      jobTextEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    downloadArea.appendChild(continueBtn);

    if (!hasHallucination) {
      setStatus('Terminé ✅');
    }
  } catch (err) {
    console.error(err);
    const msg = err.message || '';
    const isGpuCrash = /device_removed|device was lost|requestdevice|disposed/i.test(msg);
    log('Erreur : ' + (err.stack || err.message));
    engine = null; // le moteur en mémoire n'est plus fiable, on force un rechargement complet la prochaine fois

    if (isGpuCrash) {
      setStatus(
        "Le pilote GPU a planté (DEVICE_REMOVED / device lost) — ce n'est pas récupérable dans l'onglet actuel. " +
        "Recharge complètement la page (F5), choisis le modèle « très léger », et si ça se reproduit : " +
        "mets à jour tes pilotes graphiques ou force le navigateur sur ton GPU dédié dans les paramètres " +
        "Windows (Paramètres système → Affichage → Graphismes)."
      );
    } else {
      setStatus('Erreur : ' + err.message);
    }
  } finally {
    runBtn.disabled = false;
    updateRunButton();
  }
});
