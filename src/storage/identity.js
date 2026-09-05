// src/storage/identity.js
//
// Identité locale simple : un ID stable généré une fois par ONGLET, et un
// nom affiché. Stockée dans sessionStorage (pas IndexedDB) précisément
// parce que sessionStorage est propre à chaque onglet — IndexedDB et
// localStorage sont partagés par tout le navigateur sur ce domaine, ce qui
// ferait apparaître la même identité dans deux onglets ouverts en parallèle
// (ex. un onglet candidat + un onglet annonceur pour tester les deux côtés).
//
// Cette identité N'EST PAS l'identifiant réseau Trystero (qui reste
// éphémère, généré par Trystero à chaque connexion) : c'est un identifiant
// applicatif, transporté DANS le contenu des messages, qui permet de
// reconnaître "la même personne" d'une reconnexion à l'autre au niveau de
// l'application plutôt qu'au niveau du transport (voir p2p/discovery.js).

const KEY = 'jobmatch-local-identity';

function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Charge l'identité de cet onglet, ou en crée une nouvelle si aucune n'existe encore. */
export function loadOrCreateIdentity() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // sessionStorage indisponible (mode privé restrictif, etc.) : identité en mémoire seulement.
  }
  const identity = { id: randomId(), displayName: null, createdAt: Date.now() };
  persist(identity);
  return identity;
}

function persist(identity) {
  try { sessionStorage.setItem(KEY, JSON.stringify(identity)); } catch { /* ignore */ }
}

/** Met à jour le nom affiché, en conservant le même ID pour cet onglet. */
export function setDisplayName(displayName) {
  const current = loadOrCreateIdentity();
  const updated = { ...current, displayName: displayName || null };
  persist(updated);
  return updated;
}

/**
 * Restaure une identité à partir d'un ID noté précédemment (ex. affiché
 * dans un autre onglet, ou avant un "supprimer mes données locales"). Ne
 * vérifie ni ne garantit rien de cryptographique — c'est un identifiant
 * technique simple, pas une preuve d'identité : quiconque connaît l'ID
 * peut se l'attribuer. Le nom affiché est conservé tel quel s'il existe déjà.
 * @param {string} id
 */
export function restoreIdentity(id) {
  const trimmed = String(id || '').trim();
  if (!trimmed) throw new Error('ID vide.');
  const current = loadOrCreateIdentity();
  const restored = { ...current, id: trimmed };
  persist(restored);
  return restored;
}

/**
 * Génère un nouvel ID, abandonnant l'ancien (§ "tuer" un ID compromis). Le
 * nom affiché est conservé ; seul l'identifiant technique change. L'ancien
 * ID redevient un simple ID orphelin : il ne représente plus personne côté
 * réseau une fois la diffusion "identité retirée" envoyée (voir
 * p2p/protocol.js, createIdentityRetired, et app/main.js, invalidateIdentity).
 */
export function regenerateId() {
  const current = loadOrCreateIdentity();
  const rotated = { ...current, id: randomId() };
  persist(rotated);
  return rotated;
}

/** Efface complètement l'identité de cet onglet (utilisé par un reset total des données). */
export function clearIdentity() {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}
