// ==== Éléments DOM ====
const fileInput = document.getElementById('cv-file');
const fileNameEl = document.getElementById('file-name');
const jobTextEl = document.getElementById('job-text');
const jobCountEl = document.getElementById('job-count');
const runBtn = document.getElementById('run-btn');
const stopBtn = document.getElementById('stop-btn');
const statusEl = document.getElementById('status');
const progressBar = document.getElementById('progress-bar');
const downloadArea = document.getElementById('download-area');
const logEl = document.getElementById('log');
const modelSelect = document.getElementById('model-select');
const loadModelBtn = document.getElementById('load-model-btn');
const modelLoadBar = document.getElementById('model-load-bar');
const engineStatusEl = document.getElementById('engine-status');

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

function dlog(msg) {
  const t = ((performance.now ? performance.now() : Date.now()) / 1000).toFixed(2);
  console.log('[WebLLM ' + t + 's]', msg);
}

// ==== WebLLM — moteur local (WebGPU), chargé une fois et réutilisé =========
// Contrairement à l'ancienne version (un appel réseau HF par segment), le
// moteur est initialisé UNE SEULE FOIS puis réutilisé pour tous les
// segments d'une passe. Réinitialiser le moteur à chaque segment serait le
// principal tueur de perf ici (rechargement du modèle = plusieurs
// centaines de Mo à chaque fois) — ce que l'ancien code ne faisait pas côté
// modèle (HF gardait le modèle chargé côté serveur), mais qu'il faut éviter
// explicitement nous-mêmes en local.
const WEBLLM_CDN = 'https://esm.run/@mlc-ai/web-llm';

// Modèles choisis pour de la réécriture de texte (pas du code) : instruct
// models généralistes. À adapter à la liste réellement disponible dans ta
// version de web-llm (prebuiltAppConfig.model_list) si ces IDs changent.
const MODELS = {
  small: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',   // ~880 Mo — mobile / peu de VRAM
  medium: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',  // ~2 Go   — desktop par défaut
  large: 'Qwen2.5-7B-Instruct-q4f16_1-MLC',     // ~5 Go   — desktop avec beaucoup de VRAM
};

let webllmModelId = null; // résolu par resolveModelChoice()
let webllmModelKey = null; // 'small' | 'medium' | 'large' — sert à estimer la fenêtre de contexte
let webllmWorker = null;
let webllmEngine = null;
let webllmReady = false;
let webllmLoading = false;
let wakeLock = null;
let stopSignalResolve = null;

function newStopSignal() {
  return new Promise((resolve) => { stopSignalResolve = resolve; });
}
function triggerStop() {
  if (stopSignalResolve) { stopSignalResolve(); stopSignalResolve = null; }
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) {
    console.warn('Wake lock indisponible :', e.message);
  }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
}

function isGpuContextLostError(e) {
  const msg = String(e && e.message || e || '');
  return /Instance reference no longer exists|device.*lost|GPUDevice|lost.*context|already.*disposed|object.*disposed/i.test(msg);
}

function resetWebllmState() {
  webllmReady = false;
  webllmEngine = null;
  try { webllmWorker?.terminate(); } catch {}
  webllmWorker = null;
}

// Le Worker dédié est essentiel : sans lui, l'inférence WebGPU bloque le
// thread principal et l'UI (barre de progression, bouton Stop) gèle
// pendant la génération. Ce n'est PAS un Service Worker.
function createWorker() {
  const code = `
    import * as webllm from '${WEBLLM_CDN}';
    const handler = new webllm.WebWorkerMLCEngineHandler();
    self.onmessage = (msg) => { handler.onmessage(msg); };
  `;
  const blob = new Blob([code], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url, { type: 'module' });
  worker.addEventListener('error', (e) => dlog('worker error: ' + e.message));
  return worker;
}

async function loadWebllmLib() {
  if (window.webllm) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.type = 'module';
    s.textContent = `
      import * as webllm from '${WEBLLM_CDN}';
      window.webllm = webllm;
      window.dispatchEvent(new Event('webllm-loaded'));
    `;
    document.head.appendChild(s);
    window.addEventListener('webllm-loaded', resolve, { once: true });
    setTimeout(() => reject(new Error('Chargement de la librairie WebLLM (CDN) trop long.')), 30000);
  });
}

function resolveModelKey() {
  const choice = modelSelect.value; // 'auto' | 'small' | 'medium' | 'large'
  if (choice !== 'auto') return choice;

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  const mem = navigator.deviceMemory; // plafonné à 8 par les navigateurs, indicatif seulement
  if (isMobile) return 'small';
  if (typeof mem === 'number' && mem >= 8) return 'large';
  return 'medium';
}

function resolveModelChoice() {
  return MODELS[resolveModelKey()] || MODELS.medium;
}

// Budget de tokens (entrée + sortie) qu'on s'autorise à utiliser dans un
// seul appel groupé, par modèle. Volontairement conservateur : c'est une
// estimation grossière (pas de vrai tokenizer côté app), pour rester loin
// de la fenêtre de contexte réelle du modèle plutôt que de la frôler.
const CONTEXT_BUDGET_TOKENS = { small: 1600, medium: 3000, large: 6000 };
function getContextBudget() {
  return CONTEXT_BUDGET_TOKENS[webllmModelKey] || 2000;
}

// Estimation grossière : ~4 caractères par token pour du texte latin.
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

async function checkWebGpuSupport() {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return { supported: false, reason: "WebGPU n'est pas disponible dans ce navigateur. Utilise une version récente de Chrome ou Edge (Safari/Firefox n'ont pas encore un support fiable)." };
  }
  return { supported: true };
}

async function createEngine() {
  dlog('CreateWebWorkerMLCEngine() pour ' + webllmModelId);
  const t0 = performance.now ? performance.now() : Date.now();
  if (!webllmWorker) webllmWorker = createWorker();
  const engine = await window.webllm.CreateWebWorkerMLCEngine(webllmWorker, webllmModelId, {
    initProgressCallback: (p) => {
      const pct = Math.round((p.progress || 0) * 100);
      modelLoadBar.style.width = pct + '%';
      engineStatusEl.textContent = (p.text || 'Chargement…') + ' (' + pct + '%)';
    },
  });
  dlog('Moteur prêt après ' + (((performance.now ? performance.now() : Date.now()) - t0) / 1000).toFixed(1) + 's');
  return engine;
}

// Initialise (ou réutilise) le moteur. Appelé explicitement au clic sur
// "Charger le modèle", ET en préchargement dès qu'un CV est déposé — pour
// que le téléchargement du modèle se fasse PENDANT que l'utilisateur colle
// l'offre d'emploi, au lieu d'attendre le clic sur "Adapter mon CV". C'est
// le principal gain perçu : le modèle est déjà chaud quand on lance la
// génération.
async function initWebLLM(_isRetry) {
  if (webllmReady && webllmEngine) return webllmEngine;
  if (webllmLoading && !_isRetry) {
    await new Promise((r) => {
      const iv = setInterval(() => { if (!webllmLoading) { clearInterval(iv); r(); } }, 300);
    });
    if (webllmReady) return webllmEngine;
  }

  const gpu = await checkWebGpuSupport();
  if (!gpu.supported) throw new Error(gpu.reason);

  webllmLoading = true;
  if (!_isRetry) { webllmModelKey = resolveModelKey(); webllmModelId = MODELS[webllmModelKey] || resolveModelChoice(); }
  modelSelect.disabled = true;
  engineStatusEl.textContent = 'Initialisation…';
  await acquireWakeLock();

  try {
    await loadWebllmLib();
    let engine;
    try {
      engine = await createEngine();
    } catch (e) {
      if (isGpuContextLostError(e) && !_isRetry) {
        console.warn('Contexte GPU perdu pendant le chargement, nouvelle tentative…');
        resetWebllmState();
        engineStatusEl.textContent = 'Contexte GPU perdu — nouvelle tentative…';
        webllmLoading = false;
        return await initWebLLM(true);
      }
      throw e;
    }
    webllmEngine = engine;
    webllmReady = true;
    engineStatusEl.textContent = '✅ Modèle chargé (' + webllmModelId + ') — prêt.';
    modelLoadBar.style.width = '100%';
    modelSelect.disabled = false;
    updateRunButton();
    return engine;
  } catch (e) {
    engineStatusEl.textContent = '❌ Échec du chargement : ' + e.message;
    modelSelect.disabled = false;
    throw e;
  } finally {
    webllmLoading = false;
    releaseWakeLock();
  }
}

// Termine le worker si la page est vraiment fermée — sinon il continue de
// tourner (et le GPU avec lui) après la fermeture visuelle de l'onglet.
window.addEventListener('pagehide', resetWebllmState);
window.addEventListener('beforeunload', resetWebllmState);

loadModelBtn.addEventListener('click', () => {
  initWebLLM().catch((e) => log('⚠️ ' + e.message));
});

modelSelect.addEventListener('change', () => {
  localStorage.setItem('cvAdapterModelChoice', modelSelect.value);
  // Un changement de modèle après coup nécessite de recharger le moteur.
  if (webllmReady) {
    resetWebllmState();
    engineStatusEl.textContent = 'Modèle changé — recharge-le avant de lancer une adaptation.';
    modelLoadBar.style.width = '0%';
    updateRunButton();
  }
});

const savedModelChoice = localStorage.getItem('cvAdapterModelChoice');
if (savedModelChoice) modelSelect.value = savedModelChoice;

// ==== Persistance du dernier CV chargé (IndexedDB, pour survivre au
// rechargement de la page — localStorage n'est pas adapté à du binaire) ====
const CV_DB_NAME = 'cv-adapter-db';
const CV_STORE_NAME = 'files';
const CV_STORE_KEY = 'last-cv';

function openCvDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CV_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(CV_STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveCvToDb(name, arrayBuffer) {
  try {
    const db = await openCvDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CV_STORE_NAME, 'readwrite');
      tx.objectStore(CV_STORE_NAME).put({ name, arrayBuffer }, CV_STORE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Sauvegarde locale du CV échouée (non bloquant) :', err);
  }
}

async function loadCvFromDb() {
  try {
    const db = await openCvDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CV_STORE_NAME, 'readonly');
      const req = tx.objectStore(CV_STORE_NAME).get(CV_STORE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('Lecture locale du CV échouée (non bloquant) :', err);
    return null;
  }
}

// ==== 1. Lecture du CV .docx (JSZip + DOM XML natif, 100% client) ====
async function loadCvFromArrayBuffer(arrayBuffer, displayName) {
  fileNameEl.textContent = displayName;
  setStatus('Lecture du CV…');
  downloadArea.innerHTML = '';
  try {
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
    setStatus("CV chargé. Choisis ton modèle ci-dessus si besoin, colle l'offre puis lance l'adaptation.");
    updateRunButton();
    return true;
  } catch (err) {
    console.error(err);
    docState = null;
    setStatus('Erreur de lecture du .docx : ' + err.message);
    return false;
  }
}

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  originalFileName = file.name.replace(/\.docx$/i, '');
  baseFileName = originalFileName;
  iteration = 1;
  const arrayBuffer = await file.arrayBuffer();
  const ok = await loadCvFromArrayBuffer(arrayBuffer, file.name);
  if (ok) saveCvToDb(file.name, arrayBuffer);
});

// Restauration automatique du dernier CV chargé, au chargement de la page.
(async () => {
  const saved = await loadCvFromDb();
  if (!saved) return;
  originalFileName = saved.name.replace(/\.docx$/i, '');
  baseFileName = originalFileName;
  iteration = 1;
  log(`CV précédemment chargé retrouvé (${saved.name}) — restauration…`);
  await loadCvFromArrayBuffer(saved.arrayBuffer, saved.name + ' (restauré)');
})();

jobTextEl.addEventListener('input', () => {
  updateRunButton();
  const n = jobTextEl.value.length;
  jobCountEl.textContent = `${n} caractère${n > 1 ? 's' : ''}`;
});

function updateRunButton() {
  runBtn.disabled = !docState || jobTextEl.value.trim().length === 0 || !webllmReady;
}

// ==== 2. Extraction des "runs" (segments) du document.xml ====
function getTextRuns(xmlDoc) {
  const rNodes = Array.from(xmlDoc.getElementsByTagNameNS(W_NS, 'r'));
  return rNodes.map((rNode) => {
    const tNodes = Array.from(rNode.getElementsByTagNameNS(W_NS, 't'));
    const text = tNodes.map((t) => t.textContent).join('');
    const rPr = rNode.getElementsByTagNameNS(W_NS, 'rPr')[0] || null;
    const bold = rPr ? isRunPropertyOn(rPr, 'b') : false;
    return { node: rNode, text, bold };
  }).filter((r) => r.text.trim().length > 0);
}

function isRunPropertyOn(rPr, tag) {
  const b = rPr.getElementsByTagNameNS(W_NS, tag)[0];
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

// ==== 4. Génération via WebLLM (local, WebGPU) ==============================
// Un seul moteur, initialisé une fois (voir initWebLLM), réutilisé pour
// tous les segments. Chaque appel est un system+user "frais" (pas
// d'historique cumulé) — ce qui reste correct pour un modèle local : ça
// garde chaque prompt court, donc le "prefill" (lecture du prompt avant de
// pouvoir générer le premier token) reste rapide à chaque segment.
// Les erreurs qui remontent d'un Worker (postMessage) ne sont pas toujours
// de vraies instances Error — certaines implémentations perdent .message
// en cours de route (structured clone d'un DOMException / erreur WebGPU
// custom), ce qui donnait "undefined" au lieu du vrai problème. On force
// systématiquement un message exploitable, et on logge l'objet brut en
// console pour pouvoir inspecter (F12) ce qu'il contenait vraiment.
function normalizeError(e, context) {
  console.error('[WebLLM] erreur brute (' + context + ') :', e);
  if (e instanceof Error && e.message) return e;
  let detail;
  try { detail = JSON.stringify(e); } catch { detail = null; }
  if (!detail || detail === '{}') detail = String(e);
  return new Error(context + ' — ' + detail + ' (détails complets dans la console F12)');
}

async function* withStopSignal(gen, stopSignal) {
  const it = gen[Symbol.asyncIterator] ? gen[Symbol.asyncIterator]() : gen;
  while (true) {
    let result;
    if (stopSignal) {
      result = await Promise.race([
        it.next(),
        stopSignal.then(() => { throw new Error('__STOPPED_BY_USER__'); }),
      ]);
    } else {
      result = await it.next();
    }
    if (result.done) return;
    yield result.value;
  }
}

async function generateText(messages, maxTokens, stopSignal) {
  const engine = await initWebLLM();
  dlog('chat.completions.create — ' + messages.length + ' messages, max_tokens=' + maxTokens);

  let stream;
  try {
    stream = await engine.chat.completions.create({
      messages,
      temperature: 0.3,
      max_tokens: maxTokens,
      stream: true,
    });
  } catch (e) {
    throw normalizeError(e, 'Échec à la création du flux de génération');
  }

  let out = '';
  try {
    for await (const chunk of withStopSignal(stream, stopSignal)) {
      const d = chunk.choices?.[0]?.delta?.content || '';
      out += d;
    }
  } catch (e) {
    if (e && e.message === '__STOPPED_BY_USER__') throw e;
    throw normalizeError(e, 'Échec pendant le streaming de la réponse');
  }
  dlog('segment terminé, ' + out.length + ' caractères générés');
  return out;
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

async function rewriteSegment(run, jobText, stopSignal, _isRetry) {
  const messages = buildSegmentPrompt(run, jobText);
  try {
    const text = await generateText(messages, 200, stopSignal);
    return text.trim().replace(/^["«]|["»]$/g, '');
  } catch (err) {
    if (err.message === '__STOPPED_BY_USER__') throw err;

    // "Object has already been disposed" / device lost : le contexte GPU a
    // pu être coupé entre le chargement du modèle et cet appel (onglet en
    // arrière-plan, veille…). Comme documenté dans le README (mlc-ai/web-llm
    // #486, #560) : on recrée un moteur neuf et on retente UNIQUEMENT ce
    // segment, une fois — pas toute la passe.
    if (isGpuContextLostError(err) && !_isRetry) {
      log('  ⚠️ Contexte GPU perdu sur ce segment — rechargement du moteur et nouvelle tentative…');
      resetWebllmState();
      updateRunButton();
      try {
        await initWebLLM();
      } catch (e2) {
        log('  ⚠️ Échec du rechargement du moteur : ' + e2.message);
        return null;
      }
      return rewriteSegment(run, jobText, stopSignal, true);
    }

    log(`  ⚠️ Échec sur ce segment : ${err.message}`);
    return null;
  }
}

// ==== 5bis. Reformulation groupée (un seul appel pour plusieurs segments) ==
// Au lieu d'un appel par segment, on envoie plusieurs extraits numérotés
// dans un seul prompt et on demande une réponse avec un marqueur simple
// (###N###) par extrait — plus robuste à parser qu'un JSON pour un petit
// modèle local quantifié. Le code garde la main sur le mapping (quel texte
// va dans quel run XML) via ce numéro, jamais via l'ordre "au jugé".
const BATCH_REWRITE_SYSTEM_PROMPT = `Tu es un expert en recrutement. On te donne une offre d'emploi et plusieurs extraits numérotés d'un CV. Pour CHAQUE extrait, reformule-le pour mettre en avant ce qui correspond à l'offre, en réutilisant son vocabulaire UNIQUEMENT si ça correspond vraiment à ce que dit l'extrait. N'invente aucun fait absent de l'extrait original — c'est une reformulation, pas une invention. Si rien à gagner à changer un extrait, renvoie-le tel quel.

Réponds en respectant EXACTEMENT ce format, un bloc par extrait, dans le même ordre, sans aucun texte avant, après, ni entre les blocs à part le marqueur :
###1###
texte reformulé de l'extrait 1
###2###
texte reformulé de l'extrait 2
(un bloc ###N### pour chaque extrait fourni, aucun extrait omis, aucun extrait ajouté)`;

function buildBatchPrompt(batch, jobText) {
  const body = batch.map((r, i) => `###${i + 1}### [section "${r.section}"]\n${r.text.trim()}`).join('\n\n');
  const user = `--- OFFRE D'EMPLOI ---\n${jobText}\n\n--- EXTRAITS DU CV ---\n${body}\n\nRéponds avec le format demandé ci-dessus, un bloc ###N### par extrait, dans l'ordre, rien d'autre.`;
  return [
    { role: 'system', content: BATCH_REWRITE_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

function parseBatchResponse(raw, expectedCount) {
  const parts = String(raw || '').split(/###\s*(\d+)\s*###/).slice(1);
  const map = {};
  for (let i = 0; i < parts.length; i += 2) {
    const num = parseInt(parts[i], 10);
    const text = (parts[i + 1] || '').trim().replace(/^["«]|["»]$/g, '');
    if (num >= 1 && text) map[num] = text;
  }
  const results = [];
  for (let i = 1; i <= expectedCount; i++) results.push(map[i] || null);
  return results;
}

// Découpe la liste d'extraits en lots qui tiennent dans le budget de
// contexte estimé du modèle choisi. Pour un CV normal avec un modèle
// medium/large, tout tient en général dans un seul lot.
function buildBatches(editable, jobText) {
  const budget = getContextBudget();
  const reserved = estimateTokens(jobText) + estimateTokens(BATCH_REWRITE_SYSTEM_PROMPT) + 200;
  const perBatchBudget = Math.max(budget - reserved, 400);

  const batches = [];
  let current = [];
  let currentTokens = 0;
  for (const run of editable) {
    // Un extrait consomme environ (texte en entrée) + (texte en sortie, ~même longueur).
    const segTokens = estimateTokens(run.text) * 2 + 20;
    if (current.length > 0 && currentTokens + segTokens > perBatchBudget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(run);
    currentTokens += segTokens;
  }
  if (current.length) batches.push(current);
  return batches;
}

// Reformule tous les segments modifiables. Essaie de grouper en un minimum
// d'appels LLM (idéalement un seul) ; tout ce qui manque ou échoue dans un
// lot repasse automatiquement en appel individuel (rewriteSegment), pour
// ne jamais perdre un segment à cause d'un souci de format de réponse.
async function rewriteAllSegments(editable, jobText, stopSignal, onProgress) {
  const results = new Array(editable.length).fill(null);
  const batches = buildBatches(editable, jobText);
  log(`Découpage en ${batches.length} appel(s) groupé(s) pour ${editable.length} segment(s) (au lieu d'un appel par segment).`);

  let offset = 0;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    setStatus(`Reformulation groupée ${b + 1}/${batches.length} (${batch.length} extrait(s))…`);
    try {
      const messages = buildBatchPrompt(batch, jobText);
      const maxTokens = Math.min(batch.reduce((n, r) => n + estimateTokens(r.text) * 2 + 20, 0), 3800);
      const raw = await generateText(messages, maxTokens, stopSignal);
      const parsed = parseBatchResponse(raw, batch.length);
      parsed.forEach((text, i) => { results[offset + i] = text; });
      const missing = parsed.filter((t) => !t).length;
      if (missing > 0) {
        log(`  ⚠️ Réponse groupée incomplète (${missing}/${batch.length} extrait(s) manquant(s)) — repli individuel pour ceux-là.`);
      } else {
        log(`  ✓ Lot ${b + 1}/${batches.length} : ${batch.length} extrait(s) reformulé(s) en un seul appel.`);
      }
    } catch (err) {
      if (err.message === '__STOPPED_BY_USER__') throw err;
      log(`  ⚠️ Échec de l'appel groupé (lot ${b + 1}/${batches.length}) : ${err.message} — repli individuel pour ce lot.`);
    }
    offset += batch.length;
    if (onProgress) onProgress(offset, editable.length);
  }

  // Filet de sécurité : tout ce qui n'a pas été rempli par un appel groupé
  // repasse en appel individuel classique (rewriteSegment), y compris son
  // propre retry sur perte de contexte GPU.
  for (let i = 0; i < editable.length; i++) {
    if (results[i]) continue;
    setStatus(`Reformulation individuelle ${i + 1}/${editable.length} (repli)…`);
    results[i] = await rewriteSegment(editable[i], jobText, stopSignal);
    if (onProgress) onProgress(i + 1, editable.length);
  }
  return results;
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
  stopBtn.hidden = false;
  downloadArea.innerHTML = '';
  progressBar.style.width = '0%';
  log('--- Nouvelle adaptation ---');

  const jobText = jobTextEl.value.trim();
  const stopSignal = newStopSignal();

  try {
    await initWebLLM(); // charge le modèle maintenant si ce n'est pas déjà fait

    const allRuns = classifyRuns(getTextRuns(docState.xmlDoc));
    const editable = allRuns.filter((r) => r.editable);
    log(`${editable.length} segment(s) à reformuler.`);

    let applied = 0;
    let failed = 0;

    const results = await rewriteAllSegments(editable, jobText, stopSignal, (done, total) => {
      progressBar.style.width = Math.round((done / total) * 100) + '%';
    });

    for (let i = 0; i < editable.length; i++) {
      const run = editable[i];
      const newText = results[i];
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
    if (err.message === '__STOPPED_BY_USER__' || err.message === 'Stopped by user.') {
      log('⏹ Arrêté par l’utilisateur.');
      setStatus('Arrêté.');
    } else {
      console.error(err);
      log('Erreur : ' + (err.stack || err.message));
      setStatus('Erreur : ' + err.message);
    }
  } finally {
    runBtn.disabled = false;
    stopBtn.hidden = true;
    updateRunButton();
  }
});

stopBtn.addEventListener('click', () => {
  triggerStop();
});
