// src/storage/idb.js
//
// Wrapper IndexedDB minimal, sans dépendance externe. Une seule base avec
// plusieurs object stores (profils, cache modèle, chat). Toute donnée créée
// ici doit pouvoir être supprimée par l'utilisateur (§42, §50, §54).

const DB_NAME = 'jobmatch-p2p';
const DB_VERSION = 1;
export const STORES = Object.freeze({
  PROFILES: 'profiles',
  CACHE: 'cache',
  CHAT_THREADS: 'chat_threads',
  CHAT_MESSAGES: 'chat_messages',
  IDENTITY: 'identity',
});

/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.PROFILES)) db.createObjectStore(STORES.PROFILES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.CACHE)) db.createObjectStore(STORES.CACHE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORES.CHAT_THREADS)) db.createObjectStore(STORES.CHAT_THREADS, { keyPath: 'peerId' });
      if (!db.objectStoreNames.contains(STORES.CHAT_MESSAGES)) {
        const store = db.createObjectStore(STORES.CHAT_MESSAGES, { keyPath: 'id' });
        store.createIndex('byPeer', 'peerId');
      }
      if (!db.objectStoreNames.contains(STORES.IDENTITY)) db.createObjectStore(STORES.IDENTITY, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function put(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
  });
}

export async function get(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(storeName, indexName, query) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const source = indexName ? tx.objectStore(storeName).index(indexName) : tx.objectStore(storeName);
    const req = query !== undefined ? source.getAll(query) : source.getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function del(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearStore(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/** Supprime toutes les données locales de l'application (§54). */
export async function wipeAllLocalData() {
  await Promise.all(Object.values(STORES).map((s) => clearStore(s)));
}
