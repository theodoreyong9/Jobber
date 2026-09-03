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
// Disjoncteur : passe à true quand une perte de contexte GPU survient ET que
// la tentative de rechargement du moteur échoue elle-même. Dans ce cas, le
// device WebGPU est en général irrécupérable dans le même onglet (voir
// mlc-ai/web-llm#486 / #560) — inutile de retenter un rechargement complet
// du modèle (coûteux) sur chacun des segments restants : on l'affiche
// clairement une seule fois et on laisse le reste inchangé rapidement.
let webllmIrrecoverable = false;
// Verrou dédié à la durée totale d'une passe d'adaptation (clic sur
// "Adapter mon CV" jusqu'au bout, succès ou échec) — voir updateRunButton().
let adaptationInProgress = false;
// Garantit UN SEUL rechargement complet du moteur par passe d'adaptation,
// même si plusieurs segments échouent d'affilée à cause du même contexte
// GPU perdu. Avant ce garde-fou, chaque segment en échec déclenchait sa
// propre tentative de rechargement complet (nouveau Worker + nouveau device
// WebGPU), et ces rechargements en rafale épuisaient les devices WebGPU
// disponibles au lieu de simplement récupérer un seul contexte perdu.
let webllmRecoveryAttemptsThisPass = 0;
// Budget GLOBAL de rechargements de moteur pour TOUTE l'adaptation (voir
// rewriteAllSegments : ce budget n'est plus jamais remis à neuf en cours de
// route). Chaque rechargement consomme un "device" WebGPU auprès du
// navigateur ; en accorder trop finit par épuiser le pool disponible
// ("Unable to find a compatible GPU"), un état qui ne se résout ensuite
// qu'en rechargeant la page entière. 6 recharges complètes pour une seule
// adaptation est déjà généreux.
const MAX_ENGINE_RECOVERIES_PER_PASS = 6;
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

// Détecte une sortie "dégénérée" : le modèle recopie/hallucine le gabarit
// du prompt (ex. le marqueur "--- EXTRAIT DU CV ---") au lieu de vraiment
// reformuler le texte. Observé surtout juste après un rechargement forcé
// (modèle "pas encore chaud") ou sous stress GPU. Sans cette détection, ce
// texte parasite est accepté tel quel et finit littéralement dans le CV
// final — pire qu'un segment simplement laissé inchangé.
function isDegenerateOutput(text) {
  if (!text) return true;
  const t = text.toLowerCase();
  return (
    /extraits? du cv/.test(t) ||
    t.includes("offre d'emploi") ||
    t.includes('réponds uniquement avec le texte reformulé') ||
    t.includes('réponds avec le format demandé') ||
    /^---/.test(text.trim())
  );
}

function isGpuContextLostError(e) {
  const msg = String(e && e.message || e || '');
  return /Instance reference no longer exists|device.*lost|GPUDevice|lost.*context|already.*disposed|object.*disposed|compatible GPU|doesn't have a GPU|Unable to find a compatible|ModelNotLoadedError|not loaded before/i.test(msg);
}

// Petit utilitaire d'attente, utilisé comme "backoff" entre deux tentatives
// de rechargement du moteur : retenter instantanément juste après un
// device-lost retombe souvent sur le même souci (pilote GPU pas encore
// stabilisé) — laisser quelques centaines de ms/secondes au navigateur
// augmente nettement les chances qu'un rechargement tienne.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resetWebllmState() {
  webllmReady = false;
  const engine = webllmEngine;
  const worker = webllmWorker;
  webllmEngine = null;
  webllmWorker = null;
  // Libère proprement la mémoire GPU du modèle AVANT de couper le Worker.
  // Un simple worker.terminate() ne garantit pas que le driver WebGPU
  // récupère immédiatement les buffers du modèle (potentiellement plusieurs
  // centaines de Mo à quelques Go de VRAM) — la libération peut être
  // asynchrone/différée. Sans ce unload() explicite, des rechargements
  // répétés en succession rapide finissent par épuiser les devices WebGPU
  // disponibles ("Unable to find a compatible GPU"), ce qui est exactement
  // le symptôme observé après plusieurs tentatives de récupération.
  try { await engine?.unload(); } catch {}
  try { worker?.terminate(); } catch {}
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

let webllmGpuTierPromise = null;

// Estime une "capacité GPU" réelle à partir des limites WebGPU de
// l'adaptateur, plutôt que de la RAM système (navigator.deviceMemory —
// plafonnée à 8 par les navigateurs et SANS AUCUN rapport avec la VRAM
// réellement disponible pour le GPU). Un laptop avec 16 Go de RAM et une
// puce graphique intégrée/partagée peut très bien avoir moins de VRAM
// utilisable qu'un vieux desktop à 8 Go de RAM avec carte dédiée. Se
// tromper dans ce sens choisit un modèle trop gros ("large", ~5 Go) sur du
// matériel qui ne peut pas le tenir — ce qui est très probablement la cause
// des "device lost" / "already disposed" observés : la doc officielle
// WebLLM indique explicitement que ces erreurs sont "mostly due to OOM" et
// recommande de recharger avec un modèle plus petit.
async function detectGpuTier() {
  if (webllmGpuTierPromise) return webllmGpuTierPromise;
  webllmGpuTierPromise = (async () => {
    try {
      if (!navigator.gpu) return 'small';
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return 'small';
      const maxBuffer = adapter.limits?.maxBufferSize || 0;
      const maxStorage = adapter.limits?.maxStorageBufferBindingSize || 0;
      dlog(`GPU détecté — maxBufferSize=${(maxBuffer / 1e9).toFixed(2)} Go, maxStorageBufferBindingSize=${(maxStorage / 1e9).toFixed(2)} Go`);
      // Seuils volontairement conservateurs : mieux vaut un modèle plus
      // petit mais fiable qu'un modèle plus gros qui fait planter le GPU.
      if (maxBuffer >= 4e9 && maxStorage >= 2e9) return 'large';
      if (maxBuffer >= 1.8e9 && maxStorage >= 1e9) return 'medium';
      return 'small';
    } catch (e) {
      dlog('Échec de la détection des capacités GPU (' + (e && e.message) + ') — repli prudent sur "medium".');
      return 'medium';
    }
  })();
  return webllmGpuTierPromise;
}

async function resolveModelKey() {
  const choice = modelSelect.value; // 'auto' | 'small' | 'medium' | 'large'
  if (choice !== 'auto') return choice;

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  if (isMobile) return 'small';
  return detectGpuTier();
}

async function resolveModelChoice() {
  return MODELS[await resolveModelKey()] || MODELS.medium;
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
  if (!_isRetry) { webllmModelKey = await resolveModelKey(); webllmModelId = MODELS[webllmModelKey] || MODELS.medium; }
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
        await resetWebllmState();
        engineStatusEl.textContent = 'Contexte GPU perdu — nouvelle tentative…';
        webllmLoading = false;
        return await initWebLLM(true);
      }
      throw e;
    }
    webllmEngine = engine;
    webllmReady = true;
    // Un rechargement réussi (ex. clic manuel sur "Charger le modèle" après
    // un souci résolu) doit pouvoir sortir du mode "irrécupérable".
    webllmIrrecoverable = false;
    engineStatusEl.textContent = '✅ Modèle chargé (' + webllmModelId + ') — prêt.';
    modelLoadBar.style.width = '100%';
    modelSelect.disabled = false;
    updateRunButton();
    return engine;
  } catch (e) {
    // On passe systématiquement par normalizeError() : les erreurs qui
    // traversent la frontière du Worker WebLLM ne sont pas toujours de
    // vraies instances Error (parfois un objet ou une chaîne sans
    // `.message`). Sans ça, tout code appelant qui lit `.message` sur
    // l'erreur relancée ici récupère `undefined` au lieu du vrai motif.
    const normalized = normalizeError(e, 'Échec du chargement du moteur');
    engineStatusEl.textContent = '❌ Échec du chargement : ' + normalized.message;
    modelSelect.disabled = false;
    throw normalized;
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
    engineStatusEl.textContent = 'Modèle changé — libération du précédent…';
    modelLoadBar.style.width = '0%';
    resetWebllmState().then(() => {
      engineStatusEl.textContent = 'Modèle changé — recharge-le avant de lancer une adaptation.';
      updateRunButton();
    });
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
  // adaptationInProgress prime sur tout le reste : sans ce verrou dédié, le
  // bouton se réactivait dès qu'un rechargement interne du moteur GPU
  // réussissait (webllmReady redevient true), y compris EN PLEIN MILIEU
  // d'une passe d'adaptation — un ré-clic pendant ce court instant relance
  // une 2e passe en parallèle sur le même docState, ce qui corrompt tout.
  //
  // webllmReady n'est PLUS une condition ici : le clic sur "Adapter mon CV"
  // charge lui-même le modèle s'il ne l'est pas déjà (voir le handler,
  // await initWebLLM()) — obliger l'utilisateur à cliquer d'abord sur
  // "Charger le modèle" puis sur "Adapter mon CV" était une étape
  // superflue. Le bouton "Charger le modèle maintenant" reste disponible
  // pour qui veut pré-télécharger le modèle à l'avance, mais n'est plus
  // obligatoire.
  runBtn.disabled = adaptationInProgress || !docState || jobTextEl.value.trim().length === 0;
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
  if (webllmIrrecoverable) {
    throw new Error('Moteur GPU indisponible après un échec précédent — recharge la page pour réessayer.');
  }

  let engine;
  try {
    engine = await initWebLLM();
  } catch (e) {
    // initWebLLM() peut être appelé ici pour la toute première fois d'un
    // segment (moteur pas encore chargé) : si ça échoue, il faut que
    // l'erreur remontée ait un `.message` exploitable, sinon
    // isGpuContextLostError() plus haut dans la pile ne peut rien détecter.
    throw normalizeError(e, 'Échec du (re)chargement du moteur');
  }
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

const MODEL_TIER_ORDER = ['large', 'medium', 'small'];
function downgradeModelTier(fromKey) {
  const idx = MODEL_TIER_ORDER.indexOf(fromKey);
  if (idx === -1 || idx === MODEL_TIER_ORDER.length - 1) return null; // déjà le plus léger, ou inconnu
  return MODEL_TIER_ORDER[idx + 1];
}

// Tente de récupérer un moteur cassé (contexte GPU perdu) — jusqu'à
// MAX_ENGINE_RECOVERIES_PER_PASS fois par passe d'adaptation. Au-delà de ce
// plafond, les appels suivants dans la même passe abandonnent directement
// au lieu de relancer un rechargement complet à chaque segment, ce qui
// évite d'épuiser les devices WebGPU disponibles si le GPU est vraiment
// irrécupérable.
async function attemptEngineRecovery() {
  if (webllmRecoveryAttemptsThisPass >= MAX_ENGINE_RECOVERIES_PER_PASS) {
    log(`  ⚠️ Contexte GPU reperdu, mais le plafond de ${MAX_ENGINE_RECOVERIES_PER_PASS} rechargements pour toute l'adaptation est atteint — abandon pour les segments restants (recharge la page pour repartir à neuf).`);
    webllmIrrecoverable = true;
    return false;
  }
  webllmRecoveryAttemptsThisPass++;

  log(`  ⚠️ Contexte GPU perdu — rechargement du moteur (tentative ${webllmRecoveryAttemptsThisPass}/${MAX_ENGINE_RECOVERIES_PER_PASS} pour toute l'adaptation)…`);
  // Statut visible (pas seulement le journal technique replié) : sans ça,
  // l'utilisateur voit la ligne de statut rester figée pendant de longues
  // secondes de rechargement, sans indice que quelque chose se passe.
  setStatus(`🔄 Reconnexion au GPU (tentative ${webllmRecoveryAttemptsThisPass}/${MAX_ENGINE_RECOVERIES_PER_PASS})… le reste de l'adaptation continuera juste après.`);
  await resetWebllmState();
  updateRunButton();
  // Laisse le pilote GPU quelques instants pour vraiment libérer le device
  // avant de tenter d'en recréer un — retenter à chaud, immédiatement après
  // un device-lost, retombe souvent sur le même souci.
  await sleep(1200);
  try {
    const engine = await initWebLLM();
    // initWebLLM() peut "réussir" côté JS (CreateWebWorkerMLCEngine résout
    // sans erreur) alors que le device WebGPU sous-jacent est en réalité
    // instable au niveau du navigateur/pilote (processus GPU du navigateur
    // en crash-loop, courant après une première perte de contexte) et
    // replante dès la toute première vraie inférence. On le vérifie tout de
    // suite avec un appel minimal, plutôt que de laisser chaque segment
    // suivant redécouvrir individuellement la même panne (c'est exactement
    // ce qui produisait des échecs en boucle, quasi instantanés, sur
    // chaque segment).
    await engine.chat.completions.create({
      messages: [{ role: 'user', content: 'ok' }],
      max_tokens: 1,
      stream: false,
    });
    // Petit délai de stabilisation : sur certaines machines, le Worker
    // répond "prêt" et ce tout premier appel minimal réussit, mais un vrai
    // appel (prompt système + extrait de CV, quelques centaines de tokens)
    // lancé immédiatement après échoue encore avec "ModelNotLoadedError" —
    // signe que l'état interne du moteur n'est pas encore complètement
    // stabilisé juste après un rechargement. Cette pause réduit nettement
    // le risque de retomber dessus dès le tout prochain segment.
    await sleep(600);
    return true;
  } catch (e2) {
    const normalized = normalizeError(e2, 'Échec du rechargement du moteur');
    log('  ⚠️ Échec du rechargement du moteur (' + webllmModelKey + ') : ' + normalized.message);

    // La doc officielle WebLLM est explicite : un "device lost" est le plus
    // souvent un problème de VRAM insuffisante ("mostly due to OOM"), et la
    // recommandation des auteurs est de recharger avec un modèle plus
    // petit. On applique cette recommandation directement au lieu de
    // simplement abandonner : un dernier essai avec le palier de modèle en
    // dessous, avant de déclarer le moteur irrécupérable pour cette passe.
    const smaller = downgradeModelTier(webllmModelKey);
    if (smaller) {
      log(`  ℹ️ Nouvel essai avec un modèle plus léger (${smaller}, ${MODELS[smaller]}) — recommandation officielle de WebLLM après un device-lost.`);
      webllmModelKey = smaller;
      webllmModelId = MODELS[smaller];
      await resetWebllmState();
      updateRunButton();
      try {
        const engine2 = await initWebLLM(true); // true : réutilise webllmModelKey/webllmModelId qu'on vient de fixer
        await engine2.chat.completions.create({
          messages: [{ role: 'user', content: 'ok' }],
          max_tokens: 1,
          stream: false,
        });
        log(`  ✓ Moteur rechargé avec succès avec le modèle plus léger (${smaller}).`);
        return true;
      } catch (e3) {
        const normalized3 = normalizeError(e3, 'Échec du rechargement (modèle allégé)');
        log('  ⚠️ Échec même avec un modèle plus léger : ' + normalized3.message);
      }
    }

    log('  ℹ️ Le contexte GPU semble irrécupérable dans cet onglet (processus GPU du navigateur probablement instable) — les segments restants ne seront plus retentés. Recharge la page pour réinitialiser complètement le moteur.');
    webllmIrrecoverable = true;
    return false;
  }
}

// Nombre de tentatives internes à UN appel de rewriteSegment (indépendant
// des "reprises" globales de rewriteAllSegments, voir MAX_SWEEPS). Comme il
// n'y a pas de contrainte de temps/quota, on est volontairement généreux :
// mieux vaut quelques secondes de plus que perdre un segment pour de bon.
const MAX_SEGMENT_ATTEMPTS = 3;

async function rewriteSegment(run, jobText, stopSignal, _attempt) {
  const attempt = _attempt || 1;
  if (webllmIrrecoverable) {
    // Le moteur a déjà échoué à se relancer sur un segment précédent de
    // cette même passe : inutile de retenter un rechargement complet du
    // modèle (potentiellement plusieurs centaines de Mo) qui échouera à
    // nouveau — on le dit une fois clairement plutôt que de faire perdre du
    // temps à l'utilisateur sur chaque segment restant. Ce segment sera
    // retenté lors de la prochaine reprise globale (voir MAX_SWEEPS), avec
    // un budget de récupération neuf.
    log('  ⚠️ Moteur GPU indisponible (échec précédent) — segment laissé en attente pour la prochaine reprise.');
    return null;
  }

  const messages = buildSegmentPrompt(run, jobText);
  try {
    const text = await generateText(messages, 200, stopSignal);
    const cleaned = text.trim().replace(/^["«]|["»]$/g, '');
    if (isDegenerateOutput(cleaned)) {
      // Le modèle a recopié/halluciné le gabarit du prompt au lieu de
      // reformuler — accepter ce texte le mettrait littéralement dans le
      // CV final. On retente une génération fraîche (sans recharger le
      // moteur, ce n'est pas un souci GPU) avant d'abandonner ce segment.
      if (attempt < MAX_SEGMENT_ATTEMPTS) {
        log(`  ⚠️ Sortie invalide sur ce segment (le modèle a recopié le gabarit du prompt) — nouvelle génération (tentative ${attempt + 1}/${MAX_SEGMENT_ATTEMPTS}).`);
        await sleep(300);
        return rewriteSegment(run, jobText, stopSignal, attempt + 1);
      }
      log(`  ⚠️ Sortie invalide persistante sur ce segment après ${attempt} tentatives — laissé inchangé plutôt que d'injecter du texte parasite.`);
      return null;
    }
    return cleaned;
  } catch (err) {
    if (err.message === '__STOPPED_BY_USER__') throw err;

    // "Object has already been disposed" / device lost : le contexte GPU a
    // pu être coupé entre le chargement du modèle et cet appel (onglet en
    // arrière-plan, veille…). Comme documenté dans le README (mlc-ai/web-llm
    // #486, #560) : on tente une récupération (voir attemptEngineRecovery,
    // budgétée par passe) et on retente ce même segment, jusqu'à
    // MAX_SEGMENT_ATTEMPTS fois avant de le laisser à la reprise suivante.
    if (isGpuContextLostError(err)) {
      if (attempt < MAX_SEGMENT_ATTEMPTS) {
        const recovered = await attemptEngineRecovery();
        if (!recovered) return null; // budget de récupération épuisé pour toute l'adaptation — plus aucune reprise ne sera tentée
        await sleep(800); // laisse le device tout juste rechargé se stabiliser avant une vraie inférence
        return rewriteSegment(run, jobText, stopSignal, attempt + 1);
      }
      log(`  ⚠️ Échec persistant sur ce segment après ${attempt} tentatives : ${err.message} — laissé en attente pour la prochaine reprise.`);
      return null;
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
    // Un bloc qui recopie le gabarit du prompt (voir isDegenerateOutput)
    // est traité comme manquant plutôt qu'accepté tel quel — il repassera
    // par le filet de sécurité individuel (rewriteSegment), qui a sa
    // propre validation + nouvelle tentative.
    if (num >= 1 && text && !isDegenerateOutput(text)) map[num] = text;
  }
  const results = [];
  for (let i = 1; i <= expectedCount; i++) results.push(map[i] || null);
  return results;
}

// Découpe la liste d'extraits en lots qui tiennent dans le budget de
// contexte estimé du modèle choisi. Pour un CV normal avec un modèle
// medium/large, tout tient en général dans un seul lot.
//
// MAX_SEGMENTS_PER_BATCH plafonne aussi la taille d'un lot en NOMBRE
// d'extraits, indépendamment du budget de tokens : un appel groupé avec
// beaucoup de sortie à générer garde le GPU occupé en continu plus
// longtemps, ce qui augmente le risque de déclencher un TDR Windows
// (DXGI_ERROR_DEVICE_HUNG — le pilote graphique tue le device s'il reste
// occupé trop longtemps sans rendre la main à l'affichage). Des appels plus
// courts et plus nombreux sont plus lents mais bien plus fiables.
const MAX_SEGMENTS_PER_BATCH = 3;

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
    if (current.length > 0 && (currentTokens + segTokens > perBatchBudget || current.length >= MAX_SEGMENTS_PER_BATCH)) {
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
//
// Pas de contrainte de temps/quota ici : au lieu d'abandonner définitivement
// dès qu'un budget de récupération GPU (voir attemptEngineRecovery) est
// épuisé, on refait des "reprises" complètes sur les segments encore en
// échec, chacune avec un moteur et un budget de récupération neufs, jusqu'à
// ce que tout soit fait — ou jusqu'à MAX_SWEEPS reprises infructueuses
// (garde-fou pour ne jamais boucler littéralement à l'infini si le
// GPU/pilote est réellement mort en permanence sur cette machine).
const MAX_SWEEPS = 6;

async function rewriteAllSegments(editable, jobText, stopSignal, onProgress) {
  const results = new Array(editable.length).fill(null);
  const batches = buildBatches(editable, jobText);
  log(`Découpage en ${batches.length} appel(s) groupé(s) pour ${editable.length} segment(s) (au lieu d'un appel par segment).`);

  const reportProgress = () => {
    if (onProgress) onProgress(results.filter((t) => t).length, editable.length);
  };

  let offset = 0;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    setStatus(`Reformulation groupée ${b + 1}/${batches.length} (${batch.length} extrait(s))…`);
    try {
      const messages = buildBatchPrompt(batch, jobText);
      // Plafond dur volontairement réduit (900, au lieu de 3800) : plus la
      // sortie générée en un seul appel est longue, plus le GPU reste
      // occupé en continu — et donc plus le risque de TDR (voir
      // MAX_SEGMENTS_PER_BATCH ci-dessus) est élevé. Un plafond bas force
      // des appels plus courts et plus nombreux, moins rapides mais bien
      // plus fiables sur un GPU/pilote instable.
      const maxTokens = Math.min(batch.reduce((n, r) => n + estimateTokens(r.text) * 2 + 20, 0), 900);
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

      // webllmReady ne repasse JAMAIS à false tout seul quand un appel
      // plante en cours de route (voir resetWebllmState) — sans cet appel
      // explicite, tous les lots suivants retombent instantanément sur le
      // même moteur mort (c'est exactement ce qui produisait une rafale
      // d'échecs "ModelNotLoadedError" à quelques centaines de ms
      // d'intervalle, sans aucun rechargement entre eux).
      if (isGpuContextLostError(err)) {
        await attemptEngineRecovery();
      }
    }
    offset += batch.length;
    reportProgress();
    // Pause proactive entre deux appels (pas seulement après un plantage) :
    // laisse le pilote GPU "respirer" entre deux sollicitations soutenues,
    // ce qui réduit le risque cumulatif de TDR sur une longue série
    // d'appels consécutifs.
    if (b < batches.length - 1) await sleep(400);
  }

  // Filet de sécurité : tout ce qui n'a pas été rempli par un appel groupé
  // repasse en appel individuel classique (rewriteSegment), y compris son
  // propre retry sur perte de contexte GPU.
  for (let i = 0; i < editable.length; i++) {
    if (results[i]) continue;
    setStatus(`Reformulation individuelle ${i + 1}/${editable.length} (repli)…`);
    results[i] = await rewriteSegment(editable[i], jobText, stopSignal);
    reportProgress();
    await sleep(300); // pause proactive, même logique que pour les appels groupés
  }

  // ==== Reprises persistantes ====
  // Tant qu'il reste des segments en échec, on refait des passes complètes
  // dessus avec un moteur et un budget de récupération GPU neufs — au lieu
  // de considérer l'échec comme définitif. C'est exactement ce qui
  // manquait : un plantage GPU en cours de route ne doit coûter que du
  // temps, jamais un segment perdu pour de bon.
  let sweep = 0;
  while (sweep < MAX_SWEEPS) {
    const pendingIdx = [];
    for (let i = 0; i < editable.length; i++) if (!results[i]) pendingIdx.push(i);
    if (pendingIdx.length === 0) break;

    // Le budget de rechargement GPU (voir MAX_ENGINE_RECOVERIES_PER_PASS)
    // est volontairement GLOBAL pour toute l'adaptation, pas remis à neuf à
    // chaque reprise : chaque rechargement de moteur consomme un "device"
    // WebGPU, et en accorder un budget neuf à chaque reprise peut en
    // demander des dizaines au total sur une même page, ce qui épuise le
    // pool de devices du navigateur ("Unable to find a compatible GPU") —
    // un état qui ne se résout ensuite qu'en rechargeant la page entière.
    // Si le budget global est épuisé, inutile de faire tourner encore des
    // reprises à vide : on s'arrête net, tout de suite.
    if (webllmIrrecoverable) {
      log('↻ Budget de rechargement GPU épuisé pour cette adaptation — arrêt des reprises (recharge la page pour repartir à neuf).');
      break;
    }

    sweep++;
    log(`↻ Reprise ${sweep}/${MAX_SWEEPS} : ${pendingIdx.length} segment(s) encore en échec — nouvelle tentative.`);
    setStatus(`Reprise ${sweep}/${MAX_SWEEPS} — ${pendingIdx.length} segment(s) restant(s)…`);
    await sleep(1500 * sweep); // backoff croissant : laisse le pilote GPU respirer entre les reprises

    for (const i of pendingIdx) {
      if (webllmIrrecoverable) break; // le budget a pu s'épuiser en cours de reprise
      setStatus(`Reprise ${sweep}/${MAX_SWEEPS} — segment ${pendingIdx.indexOf(i) + 1}/${pendingIdx.length}…`);
      results[i] = await rewriteSegment(editable[i], jobText, stopSignal);
      reportProgress();
      await sleep(300); // même pause proactive que les autres boucles d'appels
    }
  }

  const stillFailed = results.filter((t) => !t).length;
  if (stillFailed > 0) {
    log(`⚠️ ${stillFailed} segment(s) restent inchangés malgré ${sweep} reprise(s) complète(s) — le GPU/pilote semble réellement irrécupérable sur cette machine pour cette session. Ces segments gardent leur texte d'origine dans le CV final.`);
  } else if (sweep > 0) {
    log(`✓ Tous les segments ont finalement été reformulés après ${sweep} reprise(s).`);
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
  let serialized = new XMLSerializer().serializeToString(docState.xmlDoc);
  // Certains moteurs (Firefox notamment) réintroduisent déjà une déclaration
  // XML en tête quand on sérialise un Document entier. On la retire pour ne
  // jamais en avoir deux, ce qui corromprait le document.xml (Word refuse
  // alors d'ouvrir le fichier ou propose une réparation).
  serialized = serialized.replace(/^\uFEFF?<\?xml[^>]*\?>\s*/i, '');
  const withDeclaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + serialized;
  docState.zip.file('word/document.xml', withDeclaration);
  return docState.zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

// ==== 8. Orchestration principale ====
runBtn.addEventListener('click', async () => {
  if (adaptationInProgress) return; // garde-fou : un double-clic ne doit jamais lancer 2 passes en parallèle
  adaptationInProgress = true;
  runBtn.disabled = true;
  stopBtn.hidden = false;
  downloadArea.innerHTML = '';
  progressBar.style.width = '0%';
  log('--- Nouvelle adaptation ---');

  // Chaque nouvelle passe repart avec son propre "droit" à plusieurs
  // tentatives de récupération GPU — sinon un souci définitivement réglé
  // (page rechargée, modèle re-choisi...) resterait bloqué par l'état d'une
  // passe précédente.
  webllmIrrecoverable = false;
  webllmRecoveryAttemptsThisPass = 0;

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
      // Indicateur d'avancement global, lisible sans ouvrir le journal
      // technique — remplace la ligne de statut précédente (qui pouvait
      // rester bloquée sur un message de rechargement pendant de longues
      // secondes) dès qu'un nouveau segment aboutit.
      setStatus(`Adaptation en cours… ${done}/${total} segment(s) adapté(s).`);
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
      // Même si rien n'a pu être reformulé (ex. GPU épuisé en cours de
      // route), on propose quand même le fichier : au pire il est identique
      // à l'original (inoffensif), au mieux l'utilisateur peut relancer
      // "Adapter mon CV" sur ce même document pour retenter. Ne rien
      // produire du tout est la pire expérience possible après une longue
      // attente.
      log('⚠️ Aucun segment reformulé — le .docx proposé ci-dessous est identique au CV original.');
      setStatus("Aucun segment n'a pu être reformulé (voir journal) — le CV original reste néanmoins disponible ci-dessous. Tu peux relancer « Adapter mon CV » pour retenter.");
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
    adaptationInProgress = false;
    runBtn.disabled = false;
    stopBtn.hidden = true;
    updateRunButton();
  }
});

stopBtn.addEventListener('click', () => {
  triggerStop();
});
