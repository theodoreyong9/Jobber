// src/storage/identity.js
//
// Identité locale simple : un ID stable généré une fois, persisté, et
// RÉUTILISÉ comme identifiant réseau (selfId Trystero) d'une session à
// l'autre. Contrairement à une clé Nostr, ce n'est pas cryptographique —
// juste un identifiant technique visible, pour que l'utilisateur puisse
// reconnaître sa propre session après un rechargement de page.

import { STORES, get, put } from './idb.js';

const KEY = 'local-identity';

function randomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Charge l'identité locale, ou en crée une nouvelle si aucune n'existe encore. */
export async function loadOrCreateIdentity() {
  const existing = await get(STORES.IDENTITY, KEY).catch(() => null);
  if (existing) return existing.value;
  const identity = { id: randomId(), displayName: null, createdAt: Date.now() };
  await put(STORES.IDENTITY, { key: KEY, value: identity });
  return identity;
}

/** Met à jour le nom affiché, en conservant le même ID réseau. */
export async function setDisplayName(displayName) {
  const current = await loadOrCreateIdentity();
  const updated = { ...current, displayName: displayName || null };
  await put(STORES.IDENTITY, { key: KEY, value: updated });
  return updated;
}
