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
async function ensureEngine(modelId) {
  if (!('gpu' in navigator)) {
    throw new Error("WebGPU n'est pas disponible dans ce navigateur. Utilise une version récente de Chrome ou Edge.");
  }
  if (engine && currentModelId === modelId) return engine;

  setStatus('Chargement du modèle (1er lancement : téléchargement, plusieurs minutes)…');
  const webllm = await import('https://esm.sh/@mlc-ai/web-llm?bundle&target=es2022');
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

// ==== 4. Génération du nouveau .docx (librairie "docx", 100% client) ====
async function buildDocx(data) {
  const docx = await import('https://esm.sh/docx@9.5.1?bundle&target=es2022');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;

  const children = [];

  children.push(new Paragraph({ text: data.nom || '', heading: HeadingLevel.TITLE }));
  if (data.titre_professionnel) {
    children.push(new Paragraph({ text: data.titre_professionnel, heading: HeadingLevel.HEADING_2 }));
  }

  const contactParts = [];
  if (data.contact) {
    ['email', 'telephone', 'adresse', 'linkedin'].forEach((k) => {
      if (data.contact[k]) contactParts.push(data.contact[k]);
    });
  }
  if (contactParts.length) {
    children.push(new Paragraph({ text: contactParts.join(' · ') }));
  }

  if (data.resume) {
    children.push(new Paragraph({ text: 'Résumé', heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ text: data.resume }));
  }

  if (data.competences && data.competences.length) {
    children.push(new Paragraph({ text: 'Compétences', heading: HeadingLevel.HEADING_1 }));
    data.competences.forEach((c) => children.push(new Paragraph({ text: c, bullet: { level: 0 } })));
  }

  if (data.experiences && data.experiences.length) {
    children.push(new Paragraph({ text: 'Expérience professionnelle', heading: HeadingLevel.HEADING_1 }));
    data.experiences.forEach((exp) => {
      const titleLine = [exp.poste, exp.entreprise].filter(Boolean).join(' — ');
      children.push(new Paragraph({ children: [new TextRun({ text: titleLine, bold: true })] }));
      const meta = [exp.dates, exp.lieu].filter(Boolean).join(' · ');
      if (meta) children.push(new Paragraph({ children: [new TextRun({ text: meta, italics: true })] }));
      (exp.description || []).forEach((d) => children.push(new Paragraph({ text: d, bullet: { level: 0 } })));
    });
  }

  if (data.formations && data.formations.length) {
    children.push(new Paragraph({ text: 'Formation', heading: HeadingLevel.HEADING_1 }));
    data.formations.forEach((f) => {
      const line = [f.diplome, f.etablissement, f.dates].filter(Boolean).join(' — ');
      children.push(new Paragraph({ text: line }));
    });
  }

  if (data.langues && data.langues.length) {
    children.push(new Paragraph({ text: 'Langues', heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ text: data.langues.join(', ') }));
  }

  if (data.autres) {
    children.push(new Paragraph({ text: 'Autres', heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ text: data.autres }));
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}

// ==== 5. Orchestration ====
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
    setStatus('Erreur : ' + err.message);
    log('Erreur : ' + (err.stack || err.message));
  } finally {
    runBtn.disabled = false;
    updateRunButton();
  }
});
