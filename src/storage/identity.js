// src/storage/identity.js
//
// Identite locale, PAR MODE (namespace) : "job_candidate", "job_recruiter",
// "dating". Chaque mode a son propre ID, cumulable independamment des
// autres (activer plusieurs modes en meme temps ne force pas a partager
// la meme identite) — voir demande explicite : "cumuler tous les modes
// dans une interface, ainsi que les ids".
//
// Stockee dans sessionStorage (pas IndexedDB) : propre a chaque ONGLET,
// pour que deux onglets ouverts en parallele n'aient pas la meme identite.
//
// Ce n'est PAS l'identifiant de transport Trystero (ephemere) : c'est un
// identifiant applicatif, transporte DANS le contenu des messages, qui
// permet de reconnaitre "la meme personne" d'une reconnexion a l'autre.

const KEY_PREFIX = 'jobmatch-identity:';

function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function keyFor(namespace) {
  return `${KEY_PREFIX}${namespace}`;
}

/** Charge l'identite de ce namespace pour cet onglet, ou en cree une nouvelle. */
export function loadOrCreateIdentity(namespace) {
  const key = keyFor(namespace);
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch {
    // sessionStorage indisponible : identite en memoire seulement pour cette session.
  }
  const identity = { id: randomId(), displayName: null, createdAt: Date.now() };
  persist(namespace, identity);
  return identity;
}

function persist(namespace, identity) {
  try { sessionStorage.setItem(keyFor(namespace), JSON.stringify(identity)); } catch { /* ignore */ }
}

/** Met a jour le nom affiche pour un namespace, en conservant le meme ID. */
export function setDisplayName(namespace, displayName) {
  const current = loadOrCreateIdentity(namespace);
  const updated = { ...current, displayName: displayName || null };
  persist(namespace, updated);
  return updated;
}

/**
 * Restaure une identite a partir d'un ID note precedemment, pour un
 * namespace donne. Ne garantit rien de cryptographique.
 */
export function restoreIdentity(namespace, id) {
  const trimmed = String(id || '').trim();
  if (!trimmed) throw new Error('ID vide.');
  const current = loadOrCreateIdentity(namespace);
  const restored = { ...current, id: trimmed };
  persist(namespace, restored);
  return restored;
}

/** Genere un nouvel ID pour ce namespace (§ "tuer" un ID compromis), nom conserve. */
export function regenerateId(namespace) {
  const current = loadOrCreateIdentity(namespace);
  const rotated = { ...current, id: randomId() };
  persist(namespace, rotated);
  return rotated;
}

/** Efface l'identite d'un namespace precis. */
export function clearIdentity(namespace) {
  try { sessionStorage.removeItem(keyFor(namespace)); } catch { /* ignore */ }
}

/** Efface toutes les identites de tous les namespaces (reset complet). */
export function clearAllIdentities() {
  try {
    const toRemove = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(KEY_PREFIX)) toRemove.push(k);
    }
    toRemove.forEach((k) => sessionStorage.removeItem(k));
  } catch { /* ignore */ }
}
