// ==== Éléments DOM ====
const fileInput = document.getElementById('cv-file');
const fileNameEl = document.getElementById('file-name');
const jobTextEl = document.getElementById('job-text');
const modelSelect = document.getElementById('model-select');
const runBtn = document.getElementById('run-btn');
const statusEl = document.getElementById('status');
const progressBar = document.getElementById('progress-bar');
const downloadArea = document.getElementById('download-area');
const logEl = document.getElementById('log');

let originalCvText = null;
let originalFileName = 'cv';
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

jobTextEl.addEventListener('input', updateRunButton);

function updateRunButton() {
  runBtn.disabled = !(originalCvText && jobTextEl.value.trim().length > 20);
}

// ==== 2. Chargement du moteur WebLLM (dans le cache du navigateur) ====
// Version figée (pas "latest") pour éviter les régressions du CDN, et
// remise à zéro complète du moteur en cas d'erreur runtime (le bug WebGPU/TVM
// "Object has already been disposed" laisse parfois le moteur dans un état
// corrompu qu'il faut jeter plutôt que réutiliser).
const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.83/+esm';

async function ensureEngine(modelId) {
  if (!('gpu' in navigator)) {
    throw new Error("WebGPU n'est pas disponible dans ce navigateur. Utilise une version récente de Chrome ou Edge.");
  }
  if (engine && currentModelId === modelId) return engine;

  if (engine) {
    try { await engine.unload(); } catch (_) { /* on ignore, on repart de zéro */ }
    engine = null;
  }

  setStatus('Chargement du modèle (1er lancement : téléchargement, plusieurs minutes)…');
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
function buildPrompt(cvText, jobText) {
  const system = `Tu es un expert en recrutement et rédaction de CV. Tu adaptes un CV existant à une offre d'emploi en réutilisant un maximum de mots-clés pertinents de l'offre, SANS jamais inventer d'expérience, de diplôme ou de compétence absente du CV original. Tu reformules et réorganises pour mettre en avant ce qui correspond à l'offre. Tu réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown, respectant exactement ce schéma :
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
  const user = `--- CV ORIGINAL ---\n${cvText}\n\n--- OFFRE D'EMPLOI ---\n${jobText}\n\nAdapte ce CV à cette offre. Intègre naturellement le vocabulaire et les mots-clés de l'offre dans le résumé, les compétences et les descriptions d'expérience, uniquement quand c'est honnête par rapport au CV original. Réponds uniquement avec le JSON demandé.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

function extractJson(text) {
  let t = text.trim();
  t = t.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Réponse du modèle non exploitable (pas de JSON trouvé).');
  return JSON.parse(t.slice(start, end + 1));
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
  const docx = await import('https://cdn.jsdelivr.net/npm/docx@9.5.1/build/index.mjs');
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
      temperature: 0.3,
      max_tokens: 2048,
    });
    const text = reply.choices[0].message.content;
    log(`Réponse reçue (${text.length} caractères).`);

    const data = extractJson(text);
    setStatus('Construction du fichier .docx…');
    const blob = await buildDocx(data);

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = originalFileName + '-adapte.docx';
    a.textContent = '⬇️ Télécharger le CV adapté (.docx)';
    a.className = 'download-link';
    downloadArea.appendChild(a);

    setStatus('Terminé ✅');
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
