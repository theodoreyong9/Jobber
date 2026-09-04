// src/storage/cache.js
//
// Cache clé/valeur générique pour les préférences applicatives (modèle
// sélectionné, dernier rôle utilisé, seuils personnalisés...) — pas les
// poids du modèle WebLLM lui-même, qui sont gérés par le cache interne du
// navigateur / WebLLM (Cache API), hors de notre contrôle direct (§50, §78).

import { STORES, put, get, del, clearStore } from './idb.js';

export function setCacheValue(key, value) {
  return put(STORES.CACHE, { key, value, updatedAt: Date.now() });
}

export async function getCacheValue(key) {
  const record = await get(STORES.CACHE, key);
  return record ? record.value : null;
}

export function deleteCacheValue(key) {
  return del(STORES.CACHE, key);
}

export function clearCache() {
  return clearStore(STORES.CACHE);
}
