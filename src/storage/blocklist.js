// src/storage/blocklist.js
//
// Liste locale de pairs bloqués/ignorés (§75). Purement locale : bloquer un
// pair ne l'informe jamais et ne prévient aucun serveur — c'est une
// décision unilatérale de l'utilisateur, appliquée côté réception.

import { STORES, put, get, getAll, del, clearStore } from './idb.js';

// Réutilise le store CACHE avec un préfixe dédié pour éviter d'ajouter une
// migration de schéma IndexedDB pour une simple liste de clés.
const PREFIX = 'blocklist:';

export async function blockPeer(peerId, reason = null) {
  return put(STORES.CACHE, { key: PREFIX + peerId, value: { peerId, reason, blockedAt: Date.now() } });
}

export async function unblockPeer(peerId) {
  return del(STORES.CACHE, PREFIX + peerId);
}

export async function isBlocked(peerId) {
  const record = await get(STORES.CACHE, PREFIX + peerId);
  return Boolean(record);
}

export async function listBlockedPeers() {
  const all = await getAll(STORES.CACHE);
  return all
    .filter((r) => typeof r.key === 'string' && r.key.startsWith(PREFIX))
    .map((r) => r.value);
}

/** Débloque tout le monde (utilisé aussi par la suppression totale des données, §54). */
export async function clearBlocklist() {
  const blocked = await listBlockedPeers();
  await Promise.all(blocked.map((b) => unblockPeer(b.peerId)));
}
